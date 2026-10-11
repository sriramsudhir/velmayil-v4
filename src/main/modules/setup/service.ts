import { z } from 'zod'
import type { App } from '../../core/app'
import { hashPassword } from '../../core/crypto'
import { ensureDefaultSettings } from '../../core/settings'
import { parseInput } from '../../core/validate'
import { AppError, type SessionInfo } from '@shared/ipc'
import { DEFAULT_ROLES } from '@shared/permissions'

export const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/
export const POS_CODE_RE = /^[A-Z0-9][A-Z0-9-]{0,15}$/

const trimmed = (max: number) => z.string().trim().max(max)

export const setupInputSchema = z.object({
  shop: z.object({
    shopName: trimmed(120).min(1, 'Shop name is required'),
    displayName: trimmed(60).optional(),
    legalName: trimmed(120).default(''),
    address: trimmed(300).default(''),
    city: trimmed(80).default(''),
    state: trimmed(80).default(''),
    pinCode: trimmed(10).default(''),
    phone: trimmed(20).default(''),
    email: trimmed(120).default(''),
    gstin: z
      .string()
      .trim()
      .toUpperCase()
      .default('')
      .refine((v) => v === '' || GSTIN_RE.test(v), 'GSTIN is not valid (15 characters, e.g. 33ABCDE1234F1Z5)')
  }),
  owner: z.object({
    username: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9._-]{3,32}$/, 'Username: 3-32 letters, digits, dot, dash or underscore'),
    name: trimmed(80).optional(),
    password: z.string().min(6, 'Password must be at least 6 characters').max(128)
  }),
  pos: z.object({
    code: z.string().trim().toUpperCase().regex(POS_CODE_RE, 'POS code: letters, digits and dashes (max 16)').default('POS-01'),
    name: trimmed(60).min(1, 'POS name is required').default('Counter 1')
  }),
  locationName: trimmed(60).min(1, 'Store location name is required').default('Main Store')
})
export type SetupInput = z.input<typeof setupInputSchema>

/** Minimal shape of the business-profile service (Agent 6) that setup relies on. */
interface ProfileSaver {
  save(input: Record<string, unknown>): unknown
}

const DISCOUNT_CAP_BP: Record<string, number> = { Cashier: 1000, Manager: 5000, Owner: 10000 }

export class SetupService {
  constructor(private app: App) {}

  isComplete(): boolean {
    const db = this.app.db
    return db.value<string>("SELECT value FROM settings WHERE key = 'setup.complete'") === '1' || !!db.value<number>('SELECT 1 FROM users LIMIT 1')
  }

  status(): { complete: boolean } {
    return { complete: this.isComplete() }
  }

  /** First-run provisioning. One transaction, exactly once. Signs the new owner in. */
  complete(rawInput: unknown): { session: SessionInfo } {
    const app = this.app
    const input = parseInput(setupInputSchema, rawInput)
    if (this.isComplete()) throw new AppError('CONFLICT', 'Setup has already been completed')
    if (!app.has('businessProfile')) throw new AppError('INTERNAL', 'Business profile service is not available')
    const profile = app.get<ProfileSaver>('businessProfile')
    const passwordHash = hashPassword(input.owner.password) // CPU heavy: outside the write transaction

    const before = app.session
    try {
      return app.db.transaction(() => {
        if (this.isComplete()) throw new AppError('CONFLICT', 'Setup has already been completed')
        const db = app.db

        for (const [name, perms] of Object.entries(DEFAULT_ROLES)) {
          db.run('INSERT INTO roles(name,permissions,max_discount_bp,is_system) VALUES (?,?,?,1)', name, JSON.stringify(perms), DISCOUNT_CAP_BP[name] ?? 0)
        }
        const ownerRoleId = db.value<number>("SELECT id FROM roles WHERE name = 'Owner'")!
        const ownerName = input.owner.name || input.owner.username
        const user = db.run('INSERT INTO users(uuid,username,name,role_id,password_hash) VALUES (?,?,?,?,?)', app.uuid(), input.owner.username, ownerName, ownerRoleId, passwordHash)
        const pos = db.run('INSERT INTO pos_terminals(uuid,code,name,is_local,updated_at) VALUES (?,?,?,1,?)', app.uuid(), input.pos.code, input.pos.name, Date.now())
        const loc = db.run('INSERT INTO locations(uuid,name,is_default,updated_at) VALUES (?,?,1,?)', app.uuid(), input.locationName, Date.now())

        ensureDefaultSettings(app)

        // The profile service enforces profile.edit on the session user, so act as the new owner while creating v1.
        app.session = { userId: user.lastId, username: input.owner.username, name: ownerName, role: 'Owner', permissions: ['*'], posId: pos.lastId, posCode: input.pos.code }
        profile.save({ ...input.shop, displayName: input.shop.displayName || input.shop.shopName })

        app.setSetting('setup.complete', '1')
        app.setSetting('setup.completed_at', String(Date.now()))
        app.enqueueSnapshot('locations', loc.lastId)
        app.audit({ entity: 'setup', entityId: 'first-run', action: 'setup.complete', new: { shop: input.shop.shopName, owner: input.owner.username, pos: input.pos.code, location: input.locationName } })
        return { session: app.session }
      })
    } catch (e) {
      app.session = before
      throw e
    }
  }
}

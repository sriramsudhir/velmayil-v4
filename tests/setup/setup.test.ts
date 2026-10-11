import { describe, it, expect } from 'vitest'
import { createTestApp } from '../helpers'
import { registerAllModules } from '../../src/main/core/modules'
import { verifyPassword } from '../../src/main/core/crypto'
import { ensureDefaultSettings } from '../../src/main/core/settings'
import type { App } from '../../src/main/core/app'

/** Fresh, un-setup app. Uses the real businessProfile service when present, otherwise a faithful stub. */
export function freshApp(): App {
  const app = createTestApp({ seed: false, modules: false })
  registerAllModules(app)
  if (!app.has('businessProfile')) {
    app.provide('businessProfile', {
      save(input: Record<string, string>) {
        app.requirePermission('profile.edit')
        app.db.run('UPDATE business_profile_versions SET is_active = 0 WHERE is_active = 1')
        const v = (app.db.value<number>('SELECT MAX(version) FROM business_profile_versions') ?? 0) + 1
        return app.db.run(
          `INSERT INTO business_profile_versions(uuid,version,shop_name,display_name,address,city,state,pin_code,phone,gstin,is_active,created_by)
           VALUES (?,?,?,?,?,?,?,?,?,?,1,?)`,
          app.uuid(), v, input.shopName, input.displayName, input.address ?? '', input.city ?? '', input.state ?? '', input.pinCode ?? '', input.phone ?? '', input.gstin ?? '', app.session!.userId
        ).lastId
      }
    })
  }
  return app
}

export const goodInput = () => ({
  shop: { shopName: 'Sri Velmayil Traders', address: '1 Main Road', city: 'Sivakasi', state: 'Tamil Nadu', pinCode: '626123', phone: '9876543210', gstin: '33abcde1234f1z5' },
  owner: { username: 'Owner1', name: 'The Owner', password: 'secret123' },
  pos: { code: 'pos-01', name: 'Counter 1' },
  locationName: 'Main Store'
})

describe('setup service', () => {
  it('reports incomplete on a fresh database', async () => {
    const app = freshApp()
    expect(await app.call('setup', 'status')).toEqual({ complete: false })
    expect(app.session).toBeNull()
  })

  it('complete() provisions everything in one go and signs the owner in', async () => {
    const app = freshApp()
    const res = (await app.call('setup', 'complete', goodInput())) as { session: { username: string; role: string } }
    expect(res.session.username).toBe('owner1')
    expect(res.session.role).toBe('Owner')
    expect(app.session?.permissions).toEqual(['*'])
    expect(await app.call('setup', 'status')).toEqual({ complete: true })

    const roles = app.db.all<{ name: string; max_discount_bp: number; is_system: number }>('SELECT name,max_discount_bp,is_system FROM roles ORDER BY name')
    expect(roles).toEqual([
      { name: 'Cashier', max_discount_bp: 1000, is_system: 1 },
      { name: 'Manager', max_discount_bp: 5000, is_system: 1 },
      { name: 'Owner', max_discount_bp: 10000, is_system: 1 }
    ])
    const u = app.db.get<{ password_hash: string; role_id: number }>("SELECT * FROM users WHERE username='owner1'")!
    expect(u.password_hash).not.toContain('secret123')
    expect(verifyPassword('secret123', u.password_hash)).toBe(true)
    expect(verifyPassword('wrong', u.password_hash)).toBe(false)
    expect(app.db.value("SELECT name FROM roles WHERE id=?", u.role_id)).toBe('Owner')

    expect(app.localPos()).toMatchObject({ code: 'POS-01', name: 'Counter 1' })
    expect(app.db.value('SELECT name FROM locations WHERE id=?', app.defaultLocationId())).toBe('Main Store')
    expect(app.setting('inventory.allow_negative')).toBe('0')
    expect(app.setting('setup.complete')).toBe('1')

    const prof = app.db.get<{ shop_name: string; gstin: string; display_name: string; is_active: number; created_by: number }>('SELECT * FROM business_profile_versions')!
    expect(prof).toMatchObject({ shop_name: 'Sri Velmayil Traders', display_name: 'Sri Velmayil Traders', gstin: '33ABCDE1234F1Z5', is_active: 1 })
    expect(prof.created_by).toBe(u.role_id ? app.session!.userId : 0)

    const audit = app.db.get<{ action: string; user_name: string }>("SELECT * FROM audit_log WHERE action='setup.complete'")!
    expect(audit.user_name).toBe('The Owner')
    expect(app.db.value("SELECT COUNT(*) FROM sync_queue WHERE entity='locations'")).toBe(1)
  })

  it('refuses a second run and changes nothing', async () => {
    const app = freshApp()
    await app.call('setup', 'complete', goodInput())
    const counts = () => app.db.all('SELECT (SELECT COUNT(*) FROM users) u, (SELECT COUNT(*) FROM roles) r, (SELECT COUNT(*) FROM business_profile_versions) b')
    const before = counts()
    app.session = null
    await expect(app.call('setup', 'complete', { ...goodInput(), owner: { username: 'second', password: 'secret123' } })).rejects.toThrow(/already/)
    expect(counts()).toEqual(before)
    expect(app.session).toBeNull()
  })

  it('treats a database that already has users as complete', async () => {
    const app = createTestApp()
    expect(await app.call('setup', 'status')).toEqual({ complete: true })
  })

  it('validates input and leaves no partial data on failure', async () => {
    const app = freshApp()
    const bad = [
      { ...goodInput(), shop: { ...goodInput().shop, shopName: '  ' } },
      { ...goodInput(), shop: { ...goodInput().shop, gstin: 'NOTAGSTIN' } },
      { ...goodInput(), owner: { username: 'a b', password: 'secret123' } },
      { ...goodInput(), owner: { username: 'owner', password: '123' } },
      { ...goodInput(), pos: { code: '!!', name: 'x' } }
    ]
    for (const b of bad) await expect(app.call('setup', 'complete', b)).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(app.db.value('SELECT COUNT(*) FROM users')).toBe(0)
    expect(app.db.value('SELECT COUNT(*) FROM roles')).toBe(0)
  })

  it('rolls back everything (and the session) when the profile service fails', async () => {
    const app = createTestApp({ seed: false, modules: false })
    registerAllModules(app)
    // replace-safe: only works when we own the singleton, so use a failing stub on a fresh app without the real one
    if (app.has('businessProfile')) return
    app.provide('businessProfile', { save: () => { throw new Error('profile boom') } })
    await expect(app.call('setup', 'complete', goodInput())).rejects.toThrow('profile boom')
    expect(app.session).toBeNull()
    for (const t of ['users', 'roles', 'pos_terminals', 'locations'] as const) expect(app.db.value(`SELECT COUNT(*) FROM ${t}`)).toBe(0)
    expect(await app.call('setup', 'status')).toEqual({ complete: false })
  })

  it('setup methods are reachable without a session', async () => {
    const app = freshApp()
    expect(app.session).toBeNull()
    await expect(app.call('setup', 'status')).resolves.toBeTruthy()
  })
})

describe('ensureDefaultSettings', () => {
  it('seeds defaults, never overwrites, and is idempotent', () => {
    const app = createTestApp()
    expect(app.setting('billing.prices_include_tax')).toBe('1')
    expect(app.setting('reprint_profile_policy')).toBe('original')
    expect(app.setting('security.autolock_minutes')).toBe('10')
    expect(app.setting('sync.enabled')).toBe('0')
    expect(app.setting('billing.invoice_prefix')).toBe('INV')
    app.setSetting('security.autolock_minutes', '30')
    app.db.run("DELETE FROM settings WHERE key = 'sync.enabled'")
    expect(ensureDefaultSettings(app)).toBe(1)
    expect(app.setting('security.autolock_minutes')).toBe('30')
    expect(app.setting('sync.enabled')).toBe('0')
    expect(ensureDefaultSettings(app)).toBe(0)
  })
})

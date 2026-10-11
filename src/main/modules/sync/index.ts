import { z } from 'zod'
import type { App } from '../../core/app'
import { AppError } from '@shared/ipc'
import { SyncService } from './service'

export const order = 90

export { SyncService } from './service'
export type { SyncRole } from './service'
export { SHARED_SETTINGS, LOCAL_SETTINGS } from './shared'
export type { SyncTransport, Change } from './protocol'

const parse = <T extends z.ZodType>(schema: T, args: unknown): z.infer<T> => {
  const r = schema.safeParse(args ?? {})
  if (!r.success) throw new AppError('VALIDATION', r.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; '))
  return r.data
}

export function register(app: App): void {
  const svc = app.provide('sync', new SyncService(app))
  // the Backup & Sync page is gated by backup.manage; sync.manage additionally allows configuration
  const canView = () => {
    if (!app.can('sync.manage')) app.requirePermission('backup.manage')
  }
  const canConfigure = () => app.requirePermission('sync.manage')

  app.expose('sync', {
    /** Tiny status for the top-bar pill: any signed-in user, no config/secrets, no queue counts when sync is off. */
    badge: () => {
      app.requireSession()
      return svc.badge()
    },
    getStatus: () => (canView(), svc.status()),
    getConfig: () => (canView(), svc.publicConfig()),
    saveConfig: (a) => (canConfigure(), svc.saveConfig(a)),
    /** `{ address?, pairingCode? }` tests what was typed before it is saved */
    testConnection: async (a) => (canConfigure(), svc.testConnection(a)),
    /** Admin system: the code the owner types once on the client (sync.manage only) */
    getPairingCode: () => (canConfigure(), { code: svc.pairingCode() }),
    /** Client system: look for Admin systems on the LAN */
    discover: async () => (canConfigure(), svc.discover()),
    syncNow: async () => (canView(), svc.syncNow({ force: true })),
    resyncAll: () => (canConfigure(), svc.resyncAll()),
    retryFailed: () => (canView(), { retried: svc.retryFailed() }),
    listConflicts: (a) => {
      canView()
      const x = parse(z.object({ includeAcknowledged: z.boolean().optional(), limit: z.number().int().min(1).max(1000).optional() }), a)
      return svc.listConflicts(x.includeAcknowledged, x.limit)
    },
    ackConflicts: (a) => {
      canView()
      return { acknowledged: svc.ackConflicts(parse(z.object({ ids: z.array(z.number().int()).optional() }), a).ids) }
    },
    listQueue: (a) => {
      canView()
      const x = parse(z.object({ status: z.enum(['pending', 'sent', 'failed', 'conflict']).optional(), limit: z.number().int().min(1).max(500).optional() }), a)
      return svc.listQueue(x.status, x.limit)
    },
    listDevices: () => (canView(), svc.listDevices())
  })

  svc.start()
  const origClose = app.close.bind(app)
  app.close = () => {
    svc.stop()
    origClose()
  }
}

import { z } from 'zod'
import type { App } from '../../core/app'
import { AppError } from '@shared/ipc'
import { BackupService } from './service'

export const order = 80

export { BackupService } from './service'

const parse = <T extends z.ZodType>(schema: T, args: unknown): z.infer<T> => {
  const r = schema.safeParse(args ?? {})
  if (!r.success) throw new AppError('VALIDATION', r.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; '))
  return r.data
}

/** Phrase the user must type in the restore wizard (also enforced server-side). */
export const RESTORE_CONFIRM = 'RESTORE'

export function register(app: App): void {
  const svc = app.provide('backup', new BackupService(app))
  const need = () => app.requirePermission('backup.manage')

  app.expose('backup', {
    status: () => {
      need()
      const s = svc.getSettings()
      return {
        settings: s,
        defaultFolder: svc.defaultFolder(),
        lastBackupAt: svc.lastSuccessAt() ?? null,
        due: svc.isDue(),
        lastError: app.setting('backup.last_error', '') || null,
        backups: svc.list(),
        untracked: svc.untracked().map((u) => ({ path: u.path, createdAt: u.manifest?.createdAt ?? null, sizeBytes: u.manifest?.sizeBytes ?? null }))
      }
    },
    list: () => (need(), svc.list()),
    create: async (a) => {
      need()
      const { note } = parse(z.object({ note: z.string().max(200).optional() }), a)
      const r = await svc.createAsync({ kind: 'manual', note })
      svc.applyRetention()
      return r
    },
    verify: (a) => {
      need()
      return svc.verify(parse(z.object({ id: z.number().int().optional(), path: z.string().optional() }), a))
    },
    restore: (a) => {
      need()
      const x = parse(z.object({ id: z.number().int().optional(), path: z.string().min(1).optional(), confirm: z.string() }), a)
      if (x.confirm !== RESTORE_CONFIRM) throw new AppError('VALIDATION', `Type ${RESTORE_CONFIRM} to confirm the restore`)
      return svc.restore({ id: x.id, path: x.path })
    },
    delete: (a) => {
      need()
      svc.delete(parse(z.object({ id: z.number().int() }), a).id)
      return { ok: true }
    },
    getSettings: () => (need(), svc.getSettings()),
    saveSettings: (a) => {
      need()
      const r = svc.saveSettings(a)
      svc.start()
      return r
    },
    runDue: async () => {
      need()
      return (await svc.runIfDueAsync()) ?? null
    }
  })

  // Scheduler: skipped under vitest so unit tests stay deterministic (tests call runIfDue() directly).
  if (!process.env.VITEST) svc.start()
  const origClose = app.close.bind(app)
  app.close = () => {
    svc.onClosing()
    origClose()
  }
}

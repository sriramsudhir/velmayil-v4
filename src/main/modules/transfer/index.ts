import { z } from 'zod'
import type { App } from '../../core/app'
import { AppError } from '@shared/ipc'
import { TRANSFER_EXT } from './container'
import { TransferService } from './service'

/** after backup (80): the import is built on BackupService.restore() */
export const order = 85

export { TransferService } from './service'

/** Word the owner must type before an import replaces this laptop's data (also enforced here, not only in the UI). */
export const IMPORT_CONFIRM = 'REPLACE'

const parse = <T extends z.ZodType>(schema: T, args: unknown): z.infer<T> => {
  const r = schema.safeParse(args ?? {})
  if (!r.success) throw new AppError('VALIDATION', r.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; '))
  return r.data
}

// Electron dialogs (absent under vitest: the caller then has to pass a path)
async function electronDialog(): Promise<any | null> {
  try {
    const mod: any = await import('electron')
    return mod?.dialog ?? mod?.default?.dialog ?? null
  } catch {
    return null
  }
}
const FILTERS = [{ name: 'Velmayil - everything', extensions: [TRANSFER_EXT.slice(1)] }]

export function register(app: App): void {
  const svc = app.provide('transfer', new TransferService(app))

  /**
   * Exporting hands out every user's password hash and importing replaces users and roles, so both need the right to
   * manage backups AND users (Owner by default).
   */
  const owner = () => {
    app.requirePermission('backup.manage')
    app.requirePermission('users.manage')
  }
  /**
   * The import side is also reachable from the first-time setup screen (no users exist yet, so nobody can sign in):
   * these methods are in core/app.ts PUBLIC and guard themselves. Once setup is done they are Owner-only like the rest.
   */
  const ownerOrFirstRun = () => {
    if (svc.setupComplete()) owner()
  }

  app.expose('transfer', {
    target: () => (ownerOrFirstRun(), svc.target()),

    /** Save dialog -> export. `path` (file or folder) skips the dialog. */
    export: async (a) => {
      owner()
      const x = parse(z.object({ path: z.string().max(1000).optional() }), a)
      let path = x.path
      if (!path) {
        const d = await electronDialog()
        if (d) {
          const r = await d.showSaveDialog({ title: 'Export everything', defaultPath: svc.suggestedName(), filters: FILTERS })
          if (r.canceled || !r.filePath) return { cancelled: true }
          path = r.filePath as string
        }
      }
      return svc.export({ path })
    },

    /** Open-file dialog. {path} | {cancelled:true} | {unavailable:true} (no UI: tests). */
    pickFile: async () => {
      ownerOrFirstRun()
      const d = await electronDialog()
      if (!d) return { unavailable: true }
      const r = await d.showOpenDialog({ title: 'Import everything', properties: ['openFile'], filters: FILTERS })
      return r.canceled || !r.filePaths[0] ? { cancelled: true } : { path: r.filePaths[0] as string }
    },

    inspect: (a) => {
      ownerOrFirstRun()
      return svc.inspect(parse(z.object({ path: z.string().min(1).max(1000) }), a).path)
    },

    import: (a) => {
      ownerOrFirstRun()
      const x = parse(
        z.object({ path: z.string().min(1).max(1000), confirm: z.string(), replaceSales: z.boolean().optional(), sameLaptop: z.boolean().optional() }),
        a
      )
      if (x.confirm !== IMPORT_CONFIRM) throw new AppError('VALIDATION', `Type ${IMPORT_CONFIRM} to confirm. The import replaces all data on this laptop.`)
      const sales = app.db.value<number>('SELECT COUNT(*) FROM sales') ?? 0
      if (sales > 0 && x.replaceSales !== true) {
        throw new AppError('VALIDATION', `This laptop already has ${sales} bill(s). They will be replaced by the other laptop's data. Tick the box to confirm that this is what you want.`, { sales })
      }
      return svc.import({ path: x.path, sameLaptop: x.sameLaptop })
    }
  })
}

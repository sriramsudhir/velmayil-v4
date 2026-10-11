import type { App } from './app'

interface ModuleDef { order?: number; register: (app: App) => void }
const mods = import.meta.glob('../modules/*/index.ts', { eager: true }) as Record<string, ModuleDef>

export interface ModuleFailure { module: string; error: Error }

/**
 * Auto-discovers src/main/modules/<name>/index.ts. Each exports `register(app)` and optional `order` (lower first).
 * Default: throws on the first module that fails to register. With `onError`, a failing module is reported and the
 * remaining modules still register (used by the Electron entry so one broken module shows a dialog, not a white screen).
 */
export function registerAllModules(app: App, opts: { onError?: (f: ModuleFailure) => void } = {}): string[] {
  const entries = Object.entries(mods)
    .map(([path, m]) => ({ name: path.split('/')[2], m }))
    .sort((a, b) => (a.m.order ?? 100) - (b.m.order ?? 100))
  const ok: string[] = []
  for (const { name, m } of entries) {
    try {
      m.register(app)
      ok.push(name)
    } catch (e) {
      const error = new Error(`Module "${name}" failed to register: ${(e as Error).message}`)
      if (!opts.onError) throw error
      opts.onError({ module: name, error })
    }
  }
  return ok
}

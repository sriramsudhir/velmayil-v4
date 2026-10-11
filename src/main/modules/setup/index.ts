import type { App } from '../../core/app'
import { ensureDefaultSettings } from '../../core/settings'
import { SetupService } from './service'

export const order = 5

export function register(app: App): void {
  const svc = app.provide('setup', new SetupService(app))
  ensureDefaultSettings(app)
  app.expose('setup', {
    status: () => svc.status(),
    complete: (args) => svc.complete(args)
  })
}

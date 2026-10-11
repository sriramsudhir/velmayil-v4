import type { App } from '../../core/app'
import { SettingsService } from './service'

export const order = 6

export function register(app: App): void {
  const svc = app.provide('settings', new SettingsService(app))
  app.expose('settings', {
    getAll: () => (app.requireSession(), svc.getAll()),
    set: (a) => svc.set(a),
    setMany: (a) => svc.setMany(a),
    listTerminals: () => svc.listTerminals(),
    addTerminal: (a) => svc.addTerminal(a),
    updateTerminal: (a) => svc.updateTerminal(a),
    listLocations: () => svc.listLocations(),
    addLocation: (a) => svc.addLocation(a),
    renameLocation: (a) => svc.renameLocation(a),
    setDefaultLocation: (a) => svc.setDefaultLocation(a),
    setLocationActive: (a) => svc.setLocationActive(a)
  })
  app.expose('db', {
    integrityCheck: () => svc.integrityCheck(),
    stats: () => svc.dbStats()
  })
}

import type { App } from '../../core/app'

export const order = 1

export function register(app: App): void {
  app.expose('app', {
    info: () => ({ name: 'Velmayil POS', version: process.env.npm_package_version ?? '1.0.11', userDataDir: app.userDataDir })
  })
}

import type { App } from '../../core/app'

export const order = 1

export function register(app: App): void {
  app.expose('app', {
    info: () => ({ name: 'Velmayil v3', version: process.env.npm_package_version ?? '1.0.12', userDataDir: app.userDataDir })
  })
}

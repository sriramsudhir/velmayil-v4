import type { App } from '../../core/app'

export const order = 1

export function register(app: App): void {
  app.expose('app', {
    info: () => ({ name: 'Velmayil v4', version: process.env.npm_package_version ?? '4.1.0', userDataDir: app.userDataDir })
  })
}

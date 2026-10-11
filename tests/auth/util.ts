import { createTestApp } from '../helpers'
import { register } from '../../src/main/modules/auth'
import { AuthService } from '../../src/main/modules/auth/service'
import { hashPassword } from '../../src/main/core/crypto'
import type { App } from '../../src/main/core/app'

export const ADMIN_PW = 'Admin#1234'

/** Test app with ONLY the auth module registered, admin has a real password, session = signed-in admin (Owner). */
export function makeAuthApp(): { app: App; svc: AuthService; clock: { t: number } } {
  const app = createTestApp({ modules: false })
  register(app)
  app.db.run("UPDATE users SET password_hash = ? WHERE username = 'admin'", hashPassword(ADMIN_PW))
  const svc = app.get<AuthService>('auth')
  const clock = { t: 1_800_000_000_000 }
  svc.clock = () => clock.t
  return { app, svc, clock }
}

export function roleId(app: App, name: string): number {
  return app.db.value<number>('SELECT id FROM roles WHERE name = ?', name)!
}

/** Create a user as the current (Owner) session. */
export async function addUser(app: App, username: string, role: string, password = 'Passw0rd!x', extra: Record<string, unknown> = {}) {
  return (await app.call('auth', 'createUser', { username, name: username, roleId: roleId(app, role), password, mustChangePassword: false, ...extra })) as { id: number }
}

export const auditCount = (app: App, action: string) => app.db.value<number>('SELECT COUNT(*) FROM audit_log WHERE action = ?', action)!

export async function expectCode(p: Promise<unknown>, code: string): Promise<{ details?: unknown; message: string }> {
  try {
    await p
  } catch (e) {
    const err = e as { code?: string; message: string; details?: unknown }
    if (err.code !== code) throw new Error(`expected ${code} but got ${err.code}: ${err.message}`)
    return err
  }
  throw new Error(`expected ${code} but call succeeded`)
}

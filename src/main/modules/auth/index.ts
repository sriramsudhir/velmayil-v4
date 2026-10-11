import type { App } from '../../core/app'
import { AuthService } from './service'
import { registerSettingDef } from '../../core/settings'
import { DEFAULT_PASSWORD_MIN } from './logic'

export const order = 10

export function register(app: App): void {
  // password policy (read by AuthService.policy); defined here so the owner can change it in Settings > Security
  registerSettingDef({ key: 'security.password_min_length', default: String(DEFAULT_PASSWORD_MIN), label: 'Minimum password length', group: 'Security', kind: 'int', min: 4, max: 64 })
  registerSettingDef({ key: 'security.password_require_digit', default: '0', label: 'Passwords must contain a digit', group: 'Security', kind: 'bool' })
  const svc = app.provide('auth', new AuthService(app))
  // Public: login / current / logout (whitelisted in core/app.ts). Everything else needs a session; each method checks its permission.
  app.expose('auth', {
    login: (a) => svc.login(a),
    current: () => svc.current(),
    logout: () => svc.logout(),
    touch: () => svc.touch(),
    lock: () => svc.lock(),
    changePassword: (a) => svc.changePassword(a),
    setPin: (a) => svc.setPin(a),
    clearPin: (a) => svc.clearPin(a),
    verifyApprover: (a) => svc.verifyApprover(a),
    requestApproval: (a) => svc.verifyApprover(a),
    listApprovals: (a) => svc.listApprovals(a),
    listUsers: () => svc.listUsers(),
    createUser: (a) => svc.createUser(a),
    updateUser: (a) => svc.updateUser(a),
    setUserActive: (a) => svc.setUserActive(a),
    resetPassword: (a) => svc.resetPassword(a),
    resetPin: (a) => svc.resetPin(a),
    listRoles: () => svc.listRoles(),
    permissionCatalog: () => svc.permissionCatalog(),
    saveRole: (a) => svc.saveRole(a),
    deleteRole: (a) => svc.deleteRole(a)
  })
  app.expose('audit', {
    search: (a) => svc.auditSearch(a),
    entities: () => svc.auditEntities(),
    actions: () => svc.auditActions()
  })
  // Server-side idle auto-lock (the renderer heartbeat is auth.touch).
  const timer = setInterval(() => {
    try { svc.checkIdle() } catch { /* never crash the main process from a timer */ }
  }, 10_000)
  timer.unref?.()
}

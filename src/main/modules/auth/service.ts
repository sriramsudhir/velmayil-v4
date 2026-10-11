/**
 * AUTH / USERS / APPROVALS / AUDIT-VIEWER service (Agent 7).
 *
 * ===================== APPROVAL CONTRACT (for POS / inventory / returns) =====================
 *  Main process (preferred):
 *      import { verifyApprover } from '../auth/service'
 *      const { approvalId, approvedBy } = verifyApprover(app, {
 *        username: 'manager1',            // approver's username
 *        password: '...'  |  pin: '1234', // exactly one credential
 *        action: 'pos.void',              // free-text action key, stored in approvals.action
 *        permission: 'pos.void',          // optional: approver may ALSO qualify by holding this specific permission
 *        entity: 'sale', entityId: 123,   // optional, stored for traceability
 *        reason: 'Customer changed mind', // optional but recommended
 *        detail: { discountBp: 2500 }     // optional JSON-able payload -> approvals.detail_json
 *      })
 *      // equivalent: app.get<AuthService>('auth').verifyApprover(input)
 *  Renderer: call('auth','verifyApprover', input)  (alias: 'requestApproval').  The <ApprovalDialog/> component does this.
 *  Returns { approvalId:number, approvedBy:{ id, username, name, role } }.
 *  Errors (AppError): UNAUTHENTICATED  bad username/password/PIN (counts toward the approver's 5-strike lockout)
 *                     FORBIDDEN        locked out (details.retryAfterMs) / account disabled / approver lacks
 *                                      'approvals.grant' (and the optional `permission`)
 *                     VALIDATION       malformed input
 *  Requires an active session (the requester); approvals.requested_by = requester. Each success writes an
 *  `approvals` row and an audit_log entry (entity 'approval', action 'grant'); each refusal is audited too.
 *  Re-check later with `checkApproval(app, approvalId, action, maxAgeMs=10min)` -> the row, or throws APPROVAL_REQUIRED.
 * ==============================================================================================
 *
 * Session security: sessions auto-lock after `security.autolock_minutes` (default 10, 0 = off) of no `auth.touch`
 * heartbeat. Locking stashes the session and sets app.session = null (so EVERY service call is rejected with
 * UNAUTHENTICATED until unlock); `auth.current()` still reports { ...session, locked: true } so the renderer overlays a
 * LockScreen without navigating away (POS cart survives). Unlock = `auth.login` with the same username + password/PIN.
 * PIN sign-in is only accepted while a session exists or is locked (unlock / switch cashier), never from a cold start.
 */
import { z } from 'zod'
import type { App } from '../../core/app'
import { AppError, type SessionInfo } from '@shared/ipc'
import { PERMISSIONS, hasPermission, type Permission } from '@shared/permissions'
import { hashPassword, verifyPassword } from '../../core/crypto'
import {
  DEFAULT_AUTOLOCK_MINUTES, DEFAULT_PASSWORD_MIN, LOCKOUT_MS, MAX_FAILED_ATTEMPTS,
  diffJson, isIdleExpired, validatePassword, validatePin
} from './logic'

// ---------- helpers ----------
function parse<T extends z.ZodType>(schema: T, args: unknown): z.infer<T> {
  const r = schema.safeParse(args ?? {})
  if (!r.success) throw new AppError('VALIDATION', r.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; '))
  return r.data
}

/** Tiny helper for tests and callers: throws FORBIDDEN/UNAUTHENTICATED unless the current session holds `perm`. */
export function assertCan(app: App, perm: Permission): SessionInfo {
  return app.requirePermission(perm)
}

export interface UserRow {
  id: number; uuid: string; username: string; name: string; role_id: number; password_hash: string; pin_hash: string | null
  active: number; failed_attempts: number; locked_until: number | null; must_change_password: number
  password_changed_at: number | null; last_login_at: number | null; created_at: number; updated_at: number
}
export interface ApproverInfo { id: number; username: string; name: string; role: string }
export interface VerifyApproverInput {
  username: string; password?: string; pin?: string; action: string; permission?: Permission
  entity?: string; entityId?: string | number; reason?: string; detail?: unknown
}
export interface CurrentSession extends SessionInfo { locked: boolean; mustChangePassword: boolean; autolockMinutes: number }

const str = (max = 200) => z.string().max(max)
const Credential = { password: str().optional(), pin: z.string().regex(/^\d{4,6}$/, 'PIN must be 4 to 6 digits').optional() }
const LoginSchema = z.object({ username: z.string().trim().min(1).max(80), ...Credential })
  .refine((v) => (v.password ? 1 : 0) + (v.pin ? 1 : 0) === 1, { message: 'Provide exactly one of password or PIN' })
const ApproverSchema = z.object({
  username: z.string().trim().min(1).max(80), ...Credential,
  action: z.string().trim().min(1).max(80),
  permission: z.string().refine((p) => p in PERMISSIONS, 'Unknown permission').optional(),
  entity: str(60).optional(), entityId: z.union([z.string().max(80), z.number()]).optional(),
  reason: str(500).optional(), detail: z.unknown().optional()
}).refine((v) => (v.password ? 1 : 0) + (v.pin ? 1 : 0) === 1, { message: 'Provide exactly one of password or PIN' })
const UsernameRule = z.string().trim().regex(/^[A-Za-z0-9._-]{3,40}$/, '3-40 chars: letters, digits, . _ -')
const IdSchema = z.object({ id: z.number().int().positive() })

export class AuthService {
  /** Injectable clock (tests set `svc.clock = () => t`). */
  clock: () => number = () => Date.now()
  private lastActivity: number | null = null
  private locked = false
  private stash: SessionInfo | null = null
  private dummyHash: string | null = null

  constructor(private app: App) {}

  // ---------- settings ----------
  autolockMinutes(): number {
    const n = parseInt(this.app.setting('security.autolock_minutes', String(DEFAULT_AUTOLOCK_MINUTES)), 10)
    return Number.isFinite(n) ? n : DEFAULT_AUTOLOCK_MINUTES
  }
  private policy() {
    const n = parseInt(this.app.setting('security.password_min_length', String(DEFAULT_PASSWORD_MIN)), 10)
    return { minLength: Number.isFinite(n) && n >= 4 ? n : DEFAULT_PASSWORD_MIN, requireDigit: this.app.setting('security.password_require_digit', '0') === '1' }
  }
  private checkPassword(pw: string, username: string): void {
    const err = validatePassword(pw, username, this.policy())
    if (err) throw new AppError('VALIDATION', err)
  }

  // ---------- credential verification (shared by login + approvals) ----------
  private userByName(username: string): UserRow | undefined {
    return this.app.db.get<UserRow>('SELECT * FROM users WHERE username = ?', username)
  }

  /** Verifies credentials with lockout accounting. Throws on any failure; returns the user on success. */
  private authenticate(c: { username: string; password?: string; pin?: string }, kind: 'login' | 'approval'): UserRow {
    const { app } = this
    const now = this.clock()
    const secret = c.password ?? c.pin ?? ''
    const user = this.userByName(c.username)
    if (!user) {
      this.dummyHash ??= hashPassword('timing-equaliser')
      verifyPassword(secret, this.dummyHash)
      app.audit({ entity: 'user', entityId: c.username, action: kind === 'login' ? 'login_failed' : 'approval_failed', note: `Unknown user "${c.username}"` })
      throw new AppError('UNAUTHENTICATED', 'Invalid username or credentials')
    }
    if (user.locked_until && user.locked_until > now) {
      const retryAfterMs = user.locked_until - now
      app.audit({ entity: 'user', entityId: user.id, action: kind === 'login' ? 'login_blocked' : 'approval_failed', note: `Account locked (${user.username})` })
      throw new AppError('FORBIDDEN', `Too many failed attempts. Try again in ${Math.ceil(retryAfterMs / 1000)}s`, { lockedUntil: user.locked_until, retryAfterMs })
    }
    if (user.locked_until && user.locked_until <= now) {
      app.db.run('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?', user.id)
      user.failed_attempts = 0
    }
    const stored = c.pin !== undefined ? user.pin_hash : user.password_hash
    let ok: boolean
    if (stored) ok = verifyPassword(secret, stored)
    else { this.dummyHash ??= hashPassword('timing-equaliser'); verifyPassword(secret, this.dummyHash); ok = false }
    if (!ok) {
      const attempts = user.failed_attempts + 1
      if (attempts >= MAX_FAILED_ATTEMPTS) {
        const lockedUntil = now + LOCKOUT_MS
        app.db.run('UPDATE users SET failed_attempts = 0, locked_until = ? WHERE id = ?', lockedUntil, user.id)
        app.audit({ entity: 'user', entityId: user.id, action: 'lockout', note: `${user.username} locked for ${LOCKOUT_MS / 60000} min after ${MAX_FAILED_ATTEMPTS} failed ${kind} attempts` })
        throw new AppError('FORBIDDEN', `Too many failed attempts. Account locked for ${LOCKOUT_MS / 60000} minutes`, { lockedUntil, retryAfterMs: LOCKOUT_MS })
      }
      app.db.run('UPDATE users SET failed_attempts = ? WHERE id = ?', attempts, user.id)
      app.audit({ entity: 'user', entityId: user.id, action: kind === 'login' ? 'login_failed' : 'approval_failed', note: `Bad ${c.pin !== undefined ? 'PIN' : 'password'} for ${user.username} (attempt ${attempts})` })
      throw new AppError('UNAUTHENTICATED', 'Invalid username or credentials', { attemptsLeft: MAX_FAILED_ATTEMPTS - attempts })
    }
    if (!user.active) {
      app.audit({ entity: 'user', entityId: user.id, action: kind === 'login' ? 'login_blocked' : 'approval_failed', note: `Disabled account ${user.username}` })
      throw new AppError('FORBIDDEN', 'This account is disabled. Contact the owner.')
    }
    if (user.failed_attempts || user.locked_until) app.db.run('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?', user.id)
    return user
  }

  private rolePerms(roleId: number): { name: string; permissions: string[]; maxDiscountBp: number } {
    const r = this.app.db.get<{ name: string; permissions: string; max_discount_bp: number }>('SELECT name, permissions, max_discount_bp FROM roles WHERE id = ?', roleId)
    if (!r) throw new AppError('NOT_FOUND', 'Role not found')
    return { name: r.name, permissions: JSON.parse(r.permissions) as string[], maxDiscountBp: r.max_discount_bp }
  }

  // ---------- session ----------
  login(args: unknown): CurrentSession {
    const input = parse(LoginSchema, args)
    const { app } = this
    const hasContext = this.locked || !!app.session
    if (input.pin !== undefined && !hasContext) throw new AppError('VALIDATION', 'PIN sign-in is only available to unlock or switch user. Sign in with your password first.')
    const user = this.authenticate(input, 'login')
    const role = this.rolePerms(user.role_id)
    const pos = app.localPos()
    const prev = this.locked ? this.stash : app.session
    const wasLocked = this.locked
    app.session = { userId: user.id, username: user.username, name: user.name, role: role.name, permissions: role.permissions, posId: pos.id, posCode: pos.code }
    this.locked = false
    this.stash = null
    this.lastActivity = this.clock()
    app.db.run('UPDATE users SET last_login_at = ? WHERE id = ?', this.lastActivity, user.id)
    const action = prev && prev.userId === user.id ? (wasLocked ? 'unlock' : 'login') : prev ? 'switch_user' : 'login'
    app.audit({ entity: 'user', entityId: user.id, action, note: prev && prev.userId !== user.id ? `Switched from ${prev.username} to ${user.username}` : user.username })
    // the dashboard is the first screen after sign-in: build its 30-day history in the background (sliced, never blocks)
    if (!process.env.VITEST && app.has('dashboard')) setTimeout(() => app.get<{ prewarm(): void }>('dashboard').prewarm(), 0)
    return this.current()!
  }

  current(): CurrentSession | null {
    const s = this.locked ? this.stash : this.app.session
    if (!s) return null
    const must = this.app.db.value<number>('SELECT must_change_password FROM users WHERE id = ?', s.userId) ?? 0
    return { ...s, locked: this.locked, mustChangePassword: must === 1, autolockMinutes: this.autolockMinutes() }
  }

  logout(): { ok: true } {
    const s = this.locked ? this.stash : this.app.session
    if (s) {
      if (this.locked) this.app.session = s // attribute the audit row to the user
      this.app.audit({ entity: 'user', entityId: s.userId, action: 'logout', note: s.username })
    }
    this.app.session = null
    this.stash = null
    this.locked = false
    this.lastActivity = null
    return { ok: true }
  }

  lock(reason = 'manual'): { locked: true } {
    const s = this.app.requireSession()
    this.app.audit({ entity: 'user', entityId: s.userId, action: 'lock', note: reason })
    this.stash = s
    this.app.session = null
    this.locked = true
    return { locked: true }
  }

  /** Called on a timer and by touch(). Locks the session when idle for longer than the configured minutes. */
  checkIdle(): boolean {
    if (this.locked || !this.app.session) return this.locked
    const now = this.clock()
    this.lastActivity ??= now
    if (isIdleExpired(this.lastActivity, now, this.autolockMinutes())) {
      this.lock('idle timeout')
      return true
    }
    return false
  }

  /** Renderer activity heartbeat. */
  touch(): { locked: boolean } {
    this.app.requireSession()
    if (this.checkIdle()) return { locked: true }
    this.lastActivity = this.clock()
    return { locked: false }
  }

  /** Re-read the signed-in user's role so permission edits apply immediately. */
  refreshSession(): void {
    const s = this.app.session
    if (!s) return
    const u = this.app.db.get<{ name: string; role_id: number }>('SELECT name, role_id FROM users WHERE id = ?', s.userId)
    if (!u) return
    const r = this.rolePerms(u.role_id)
    this.app.session = { ...s, name: u.name, role: r.name, permissions: r.permissions }
  }

  // ---------- own credentials ----------
  changePassword(args: unknown): { ok: true } {
    const s = this.app.requireSession()
    const a = parse(z.object({ current: str(), next: str() }), args)
    const user = this.app.db.get<UserRow>('SELECT * FROM users WHERE id = ?', s.userId)!
    if (!verifyPassword(a.current, user.password_hash)) {
      this.app.audit({ entity: 'user', entityId: user.id, action: 'password_change_failed', note: 'Wrong current password' })
      throw new AppError('UNAUTHENTICATED', 'Current password is incorrect')
    }
    this.checkPassword(a.next, user.username)
    if (verifyPassword(a.next, user.password_hash)) throw new AppError('VALIDATION', 'New password must differ from the current one')
    this.app.db.run('UPDATE users SET password_hash = ?, must_change_password = 0, password_changed_at = ?, updated_at = ? WHERE id = ?', hashPassword(a.next), this.clock(), this.clock(), user.id)
    this.app.audit({ entity: 'user', entityId: user.id, action: 'password_change', note: 'Own password changed' })
    return { ok: true }
  }

  setPin(args: unknown): { ok: true } {
    const s = this.app.requireSession()
    const a = parse(z.object({ password: str(), pin: z.string() }), args)
    const err = validatePin(a.pin)
    if (err) throw new AppError('VALIDATION', err)
    const user = this.app.db.get<UserRow>('SELECT * FROM users WHERE id = ?', s.userId)!
    if (!verifyPassword(a.password, user.password_hash)) throw new AppError('UNAUTHENTICATED', 'Password is incorrect')
    this.app.db.run('UPDATE users SET pin_hash = ?, updated_at = ? WHERE id = ?', hashPassword(a.pin), this.clock(), user.id)
    this.app.audit({ entity: 'user', entityId: user.id, action: user.pin_hash ? 'pin_change' : 'pin_set', note: user.username })
    return { ok: true }
  }

  clearPin(args: unknown): { ok: true } {
    const s = this.app.requireSession()
    const a = parse(z.object({ password: str() }), args)
    const user = this.app.db.get<UserRow>('SELECT * FROM users WHERE id = ?', s.userId)!
    if (!verifyPassword(a.password, user.password_hash)) throw new AppError('UNAUTHENTICATED', 'Password is incorrect')
    this.app.db.run('UPDATE users SET pin_hash = NULL, updated_at = ? WHERE id = ?', this.clock(), user.id)
    this.app.audit({ entity: 'user', entityId: user.id, action: 'pin_clear', note: user.username })
    return { ok: true }
  }

  // ---------- users ----------
  private isOwnerLevel(roleId: number): boolean {
    return this.rolePerms(roleId).permissions.includes('*')
  }
  private otherActiveOwners(excludeUserId: number): number {
    const rows = this.app.db.all<{ permissions: string }>(
      'SELECT r.permissions FROM users u JOIN roles r ON r.id = u.role_id WHERE u.active = 1 AND u.id <> ?', excludeUserId
    )
    return rows.filter((r) => (JSON.parse(r.permissions) as string[]).includes('*')).length
  }
  /** Prevent privilege escalation: the actor can only hand out permissions they hold themselves. */
  private assertCanGrant(perms: string[]): void {
    const s = this.app.requireSession()
    if (s.permissions.includes('*')) return
    const missing = perms.filter((p) => p === '*' || !s.permissions.includes(p))
    if (missing.length) throw new AppError('FORBIDDEN', `You cannot grant permissions you do not hold: ${missing.join(', ')}`)
  }
  private publicUser(id: number) {
    return this.listUsers().find((u) => u.id === id)!
  }

  listUsers() {
    this.app.requirePermission('users.view')
    return this.app.db.all<{
      id: number; username: string; name: string; role_id: number; role: string; active: number; has_pin: number
      locked_until: number | null; must_change_password: number; last_login_at: number | null; created_at: number
    }>(
      `SELECT u.id, u.username, u.name, u.role_id, r.name AS role, u.active, (u.pin_hash IS NOT NULL) AS has_pin,
              u.locked_until, u.must_change_password, u.last_login_at, u.created_at
         FROM users u JOIN roles r ON r.id = u.role_id ORDER BY u.active DESC, u.username COLLATE NOCASE`
    )
  }

  createUser(args: unknown) {
    this.app.requirePermission('users.manage')
    const a = parse(z.object({
      username: UsernameRule, name: z.string().trim().min(1).max(80), roleId: z.number().int(), password: str(),
      pin: z.string().optional(), mustChangePassword: z.boolean().default(true)
    }), args)
    const role = this.rolePerms(a.roleId)
    this.assertCanGrant(role.permissions)
    this.checkPassword(a.password, a.username)
    if (a.pin) { const e = validatePin(a.pin); if (e) throw new AppError('VALIDATION', e) }
    if (this.userByName(a.username)) throw new AppError('CONFLICT', 'Username already exists')
    const id = this.app.db.transaction(() => {
      const r = this.app.db.run(
        'INSERT INTO users(uuid,username,name,role_id,password_hash,pin_hash,must_change_password,password_changed_at) VALUES (?,?,?,?,?,?,?,?)',
        this.app.uuid(), a.username, a.name, a.roleId, hashPassword(a.password), a.pin ? hashPassword(a.pin) : null, a.mustChangePassword ? 1 : 0, this.clock()
      )
      this.app.audit({ entity: 'user', entityId: r.lastId, action: 'create', new: { username: a.username, name: a.name, role: role.name, pin: !!a.pin, mustChangePassword: a.mustChangePassword } })
      return r.lastId
    })
    return this.publicUser(id)
  }

  updateUser(args: unknown) {
    const s = this.app.requirePermission('users.manage')
    const a = parse(z.object({ id: z.number().int(), name: z.string().trim().min(1).max(80).optional(), roleId: z.number().int().optional() }), args)
    const u = this.app.db.get<UserRow>('SELECT * FROM users WHERE id = ?', a.id)
    if (!u) throw new AppError('NOT_FOUND', 'User not found')
    const oldRole = this.rolePerms(u.role_id)
    this.assertCanGrant(oldRole.permissions)
    const roleId = a.roleId ?? u.role_id
    if (roleId !== u.role_id) {
      if (u.id === s.userId) throw new AppError('FORBIDDEN', 'You cannot change your own role')
      const nr = this.rolePerms(roleId)
      this.assertCanGrant(nr.permissions)
      if (u.active && oldRole.permissions.includes('*') && !nr.permissions.includes('*') && this.otherActiveOwners(u.id) === 0)
        throw new AppError('CONFLICT', 'Cannot demote the last active Owner')
    }
    const name = a.name ?? u.name
    this.app.db.transaction(() => {
      this.app.db.run('UPDATE users SET name = ?, role_id = ?, updated_at = ? WHERE id = ?', name, roleId, this.clock(), u.id)
      this.app.audit({
        entity: 'user', entityId: u.id, action: 'update',
        old: { name: u.name, role: oldRole.name }, new: { name, role: this.rolePerms(roleId).name }
      })
    })
    this.refreshSession()
    return this.publicUser(u.id)
  }

  setUserActive(args: unknown) {
    const s = this.app.requirePermission('users.manage')
    const a = parse(z.object({ id: z.number().int(), active: z.boolean() }), args)
    const u = this.app.db.get<UserRow>('SELECT * FROM users WHERE id = ?', a.id)
    if (!u) throw new AppError('NOT_FOUND', 'User not found')
    this.assertCanGrant(this.rolePerms(u.role_id).permissions)
    if (!a.active) {
      if (u.id === s.userId) throw new AppError('FORBIDDEN', 'You cannot deactivate your own account')
      if (u.active && this.isOwnerLevel(u.role_id) && this.otherActiveOwners(u.id) === 0) throw new AppError('CONFLICT', 'Cannot deactivate the last active Owner')
    }
    this.app.db.transaction(() => {
      this.app.db.run('UPDATE users SET active = ?, updated_at = ? WHERE id = ?', a.active ? 1 : 0, this.clock(), u.id)
      this.app.audit({ entity: 'user', entityId: u.id, action: a.active ? 'activate' : 'deactivate', old: { active: !!u.active }, new: { active: a.active }, note: u.username })
    })
    return this.publicUser(u.id)
  }

  resetPassword(args: unknown): { ok: true } {
    this.app.requirePermission('users.manage')
    const a = parse(z.object({ id: z.number().int(), newPassword: str(), mustChange: z.boolean().default(true) }), args)
    const u = this.app.db.get<UserRow>('SELECT * FROM users WHERE id = ?', a.id)
    if (!u) throw new AppError('NOT_FOUND', 'User not found')
    this.assertCanGrant(this.rolePerms(u.role_id).permissions)
    this.checkPassword(a.newPassword, u.username)
    this.app.db.transaction(() => {
      this.app.db.run(
        'UPDATE users SET password_hash = ?, must_change_password = ?, password_changed_at = ?, failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = ?',
        hashPassword(a.newPassword), a.mustChange ? 1 : 0, this.clock(), this.clock(), u.id
      )
      this.app.audit({ entity: 'user', entityId: u.id, action: 'password_reset', note: `Password reset for ${u.username}${a.mustChange ? ' (must change at next login)' : ''}` })
    })
    return { ok: true }
  }

  resetPin(args: unknown): { ok: true } {
    this.app.requirePermission('users.manage')
    const a = parse(IdSchema, args)
    const u = this.app.db.get<UserRow>('SELECT * FROM users WHERE id = ?', a.id)
    if (!u) throw new AppError('NOT_FOUND', 'User not found')
    this.assertCanGrant(this.rolePerms(u.role_id).permissions)
    this.app.db.run('UPDATE users SET pin_hash = NULL, updated_at = ? WHERE id = ?', this.clock(), u.id)
    this.app.audit({ entity: 'user', entityId: u.id, action: 'pin_clear', note: `PIN removed for ${u.username} by admin` })
    return { ok: true }
  }

  // ---------- roles ----------
  permissionCatalog() {
    this.app.requirePermission('users.view')
    return Object.entries(PERMISSIONS).map(([key, label]) => ({ key, label, group: key.split('.')[0] }))
  }

  listRoles() {
    this.app.requirePermission('users.view')
    return this.app.db
      .all<{ id: number; name: string; permissions: string; max_discount_bp: number; is_system: number; users: number }>(
        'SELECT r.id, r.name, r.permissions, r.max_discount_bp, r.is_system, (SELECT COUNT(*) FROM users u WHERE u.role_id = r.id) AS users FROM roles r ORDER BY r.is_system DESC, r.name'
      )
      .map((r) => ({ id: r.id, name: r.name, permissions: JSON.parse(r.permissions) as string[], maxDiscountBp: r.max_discount_bp, isSystem: !!r.is_system, users: r.users }))
  }

  saveRole(args: unknown) {
    const s = this.app.requirePermission('users.manage')
    const a = parse(z.object({
      id: z.number().int().optional(), name: z.string().trim().min(2).max(40),
      permissions: z.array(z.string()).max(100), maxDiscountBp: z.number().int().min(0).max(10000)
    }), args)
    const perms = [...new Set(a.permissions)].sort()
    for (const p of perms) if (p !== '*' && !(p in PERMISSIONS)) throw new AppError('VALIDATION', `Unknown permission "${p}"`)
    if (perms.includes('*') && !s.permissions.includes('*')) throw new AppError('FORBIDDEN', 'Only an Owner can create an all-access role')
    const clash = this.app.db.get<{ id: number }>('SELECT id FROM roles WHERE name = ? COLLATE NOCASE', a.name)
    if (clash && clash.id !== a.id) throw new AppError('CONFLICT', 'A role with this name already exists')

    if (a.id === undefined) {
      this.assertCanGrant(perms)
      const id = this.app.db.transaction(() => {
        const r = this.app.db.run('INSERT INTO roles(name,permissions,max_discount_bp,is_system) VALUES (?,?,?,0)', a.name, JSON.stringify(perms), a.maxDiscountBp)
        this.app.audit({ entity: 'role', entityId: r.lastId, action: 'create', new: { name: a.name, permissions: perms, maxDiscountBp: a.maxDiscountBp } })
        return r.lastId
      })
      return this.listRoles().find((r) => r.id === id)!
    }

    const old = this.listRoles().find((r) => r.id === a.id)
    if (!old) throw new AppError('NOT_FOUND', 'Role not found')
    if (old.isSystem && old.name !== a.name) throw new AppError('FORBIDDEN', 'System roles cannot be renamed')
    if (old.name === 'Owner' && (perms.length !== 1 || perms[0] !== '*')) throw new AppError('FORBIDDEN', 'The Owner role always has full access')
    const added = perms.filter((p) => !old.permissions.includes(p))
    const removed = old.permissions.filter((p) => !perms.includes(p))
    this.assertCanGrant(added)
    if (old.permissions.includes('*') && !perms.includes('*')) {
      const owners = this.app.db.all<{ id: number; role_id: number; permissions: string }>(
        'SELECT u.id, u.role_id, r.permissions FROM users u JOIN roles r ON r.id = u.role_id WHERE u.active = 1'
      ).filter((u) => u.role_id !== old.id && (JSON.parse(u.permissions) as string[]).includes('*'))
      if (!owners.length) throw new AppError('CONFLICT', 'Cannot remove full access from the last active Owner role')
    }
    this.app.db.transaction(() => {
      this.app.db.run('UPDATE roles SET name = ?, permissions = ?, max_discount_bp = ? WHERE id = ?', a.name, JSON.stringify(perms), a.maxDiscountBp, a.id!)
      this.app.audit({
        entity: 'role', entityId: a.id, action: 'update',
        old: { name: old.name, permissions: old.permissions, maxDiscountBp: old.maxDiscountBp },
        new: { name: a.name, permissions: perms, maxDiscountBp: a.maxDiscountBp },
        note: `added: ${added.join(', ') || '-'}; removed: ${removed.join(', ') || '-'}`
      })
    })
    this.refreshSession()
    return this.listRoles().find((r) => r.id === a.id)!
  }

  deleteRole(args: unknown): { ok: true } {
    this.app.requirePermission('users.manage')
    const a = parse(IdSchema, args)
    const role = this.listRoles().find((r) => r.id === a.id)
    if (!role) throw new AppError('NOT_FOUND', 'Role not found')
    if (role.isSystem) throw new AppError('FORBIDDEN', 'System roles cannot be deleted')
    if (role.users > 0) throw new AppError('CONFLICT', `Role is assigned to ${role.users} user(s). Reassign them first.`)
    this.app.db.transaction(() => {
      this.app.db.run('DELETE FROM roles WHERE id = ?', role.id)
      this.app.audit({ entity: 'role', entityId: role.id, action: 'delete', old: { name: role.name, permissions: role.permissions, maxDiscountBp: role.maxDiscountBp } })
    })
    return { ok: true }
  }

  // ---------- approvals ----------
  verifyApprover(args: unknown): { approvalId: number; approvedBy: ApproverInfo } {
    const requester = this.app.requireSession()
    const a = parse(ApproverSchema, args) as VerifyApproverInput
    const approver = this.authenticate(a, 'approval')
    const role = this.rolePerms(approver.role_id)
    const qualifies = hasPermission(role.permissions, 'approvals.grant') || (!!a.permission && hasPermission(role.permissions, a.permission))
    if (!qualifies) {
      this.app.audit({ entity: 'approval', entityId: a.entityId ?? null, action: 'approval_denied', note: `${approver.username} (${role.name}) cannot approve "${a.action}"`, new: { action: a.action, approver: approver.username } })
      throw new AppError('FORBIDDEN', `${approver.name} is not allowed to approve this action`)
    }
    const approvalId = this.app.db.transaction(() => {
      const r = this.app.db.run(
        'INSERT INTO approvals(action,entity,entity_id,requested_by,approved_by,reason,detail_json,created_at) VALUES (?,?,?,?,?,?,?,?)',
        a.action, a.entity ?? null, a.entityId == null ? null : String(a.entityId), requester.userId, approver.id, a.reason ?? null,
        a.detail === undefined ? null : JSON.stringify(a.detail), this.clock()
      )
      this.app.audit({
        entity: 'approval', entityId: r.lastId, action: 'grant',
        new: { action: a.action, entity: a.entity ?? null, entityId: a.entityId ?? null, requestedBy: requester.username, approvedBy: approver.username, reason: a.reason ?? null, detail: a.detail ?? null },
        note: `${approver.username} approved "${a.action}" for ${requester.username}`
      })
      return r.lastId
    })
    return { approvalId, approvedBy: { id: approver.id, username: approver.username, name: approver.name, role: role.name } }
  }

  /** Confirms an approval id is genuine, for this action and recent. Throws APPROVAL_REQUIRED otherwise. */
  checkApproval(approvalId: number, action: string, maxAgeMs = 10 * 60_000) {
    const row = this.app.db.get<{ id: number; action: string; approved_by: number; created_at: number; detail_json: string | null }>(
      'SELECT id, action, approved_by, created_at, detail_json FROM approvals WHERE id = ?', approvalId
    )
    if (!row || row.action !== action || this.clock() - row.created_at > maxAgeMs) throw new AppError('APPROVAL_REQUIRED', `A valid manager approval is required for ${action}`)
    return row
  }

  listApprovals(args: unknown) {
    this.app.requirePermission('users.view')
    const a = parse(z.object({ limit: z.number().int().min(1).max(500).default(100) }), args)
    return this.app.db.all(
      `SELECT a.id, a.action, a.entity, a.entity_id, a.reason, a.detail_json, a.created_at,
              rq.username AS requested_by, ap.username AS approved_by
         FROM approvals a LEFT JOIN users rq ON rq.id = a.requested_by LEFT JOIN users ap ON ap.id = a.approved_by
        ORDER BY a.id DESC LIMIT ?`, a.limit
    )
  }

  // ---------- audit viewer (read-only; there is deliberately no UPDATE/DELETE on audit_log anywhere) ----------
  auditSearch(args: unknown) {
    this.app.requirePermission('audit.view')
    const a = parse(z.object({
      from: z.number().int().optional(), to: z.number().int().optional(), userId: z.number().int().optional(),
      entity: str(60).optional(), action: str(60).optional(), text: str(100).optional(),
      limit: z.number().int().min(1).max(500).default(50), offset: z.number().int().min(0).default(0)
    }), args)
    const where: string[] = []
    const p: (string | number)[] = []
    if (a.from !== undefined) { where.push('ts >= ?'); p.push(a.from) }
    if (a.to !== undefined) { where.push('ts <= ?'); p.push(a.to) }
    if (a.userId !== undefined) { where.push('user_id = ?'); p.push(a.userId) }
    if (a.entity) { where.push('entity = ?'); p.push(a.entity) }
    if (a.action) { where.push('action = ?'); p.push(a.action) }
    if (a.text) {
      const like = `%${a.text.replace(/[\\%_]/g, (c) => '\\' + c)}%`
      where.push(`(COALESCE(note,'') LIKE ? ESCAPE '\\' OR COALESCE(user_name,'') LIKE ? ESCAPE '\\' OR COALESCE(entity_id,'') LIKE ? ESCAPE '\\' OR entity LIKE ? ESCAPE '\\' OR action LIKE ? ESCAPE '\\')`)
      p.push(like, like, like, like, like)
    }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const total = this.app.db.value<number>(`SELECT COUNT(*) FROM audit_log ${w}`, ...p) ?? 0
    const rows = this.app.db
      .all<Record<string, unknown>>(`SELECT * FROM audit_log ${w} ORDER BY id DESC LIMIT ? OFFSET ?`, ...p, a.limit, a.offset)
      .map((r) => ({ ...r, changes: diffJson(r.old_json, r.new_json) }))
    return { rows, total, limit: a.limit, offset: a.offset }
  }
  auditEntities(): string[] {
    this.app.requirePermission('audit.view')
    return this.app.db.all<{ entity: string }>('SELECT DISTINCT entity FROM audit_log ORDER BY entity').map((r) => r.entity)
  }
  auditActions(): string[] {
    this.app.requirePermission('audit.view')
    return this.app.db.all<{ action: string }>('SELECT DISTINCT action FROM audit_log ORDER BY action').map((r) => r.action)
  }
}

/** Standalone entry point for other modules: verifyApprover(app, input). See contract at top of file. */
export function verifyApprover(app: App, input: VerifyApproverInput) {
  return app.get<AuthService>('auth').verifyApprover(input)
}
export function checkApproval(app: App, approvalId: number, action: string, maxAgeMs?: number) {
  return app.get<AuthService>('auth').checkApproval(approvalId, action, maxAgeMs)
}

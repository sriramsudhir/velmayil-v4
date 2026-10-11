import { describe, it, expect } from 'vitest'
import { makeAuthApp, addUser, auditCount, expectCode, ADMIN_PW } from './util'
import { isIdleExpired, validatePassword, validatePin, diffJson } from '../../src/main/modules/auth/logic'

describe('login / session', () => {
  it('logs in, sets session with role permissions and pos, audits', async () => {
    const { app } = makeAuthApp()
    await addUser(app, 'cash1', 'Cashier')
    app.session = null
    const s = (await app.call('auth', 'login', { username: 'CASH1', password: 'Passw0rd!x' })) as any
    expect(s.username).toBe('cash1')
    expect(s.role).toBe('Cashier')
    expect(s.permissions).toContain('pos.sell')
    expect(s.permissions).not.toContain('users.manage')
    expect(s.posCode).toBe('POS-01')
    expect((app as any).session?.userId).toBe(s.userId)
    expect(auditCount(app, 'login')).toBe(1)
    const row = app.db.get<any>("SELECT * FROM audit_log WHERE action='login'")
    expect(row.user_name).toBe('cash1')
  })

  it('rejects wrong password and unknown user identically, audits both', async () => {
    const { app } = makeAuthApp()
    app.session = null
    const e1 = await expectCode(app.call('auth', 'login', { username: 'admin', password: 'nope-nope' }), 'UNAUTHENTICATED')
    const e2 = await expectCode(app.call('auth', 'login', { username: 'ghost', password: 'nope-nope' }), 'UNAUTHENTICATED')
    expect(e1.message).toBe(e2.message)
    expect(app.session).toBeNull()
    expect(auditCount(app, 'login_failed')).toBe(2)
  })

  it('validates input shape', async () => {
    const { app } = makeAuthApp()
    app.session = null
    await expectCode(app.call('auth', 'login', {}), 'VALIDATION')
    await expectCode(app.call('auth', 'login', { username: 'admin' }), 'VALIDATION')
    await expectCode(app.call('auth', 'login', { username: 'admin', password: 'a', pin: '1234' }), 'VALIDATION')
  })

  it('locks after 5 failures for 5 minutes, then unlocks (injected clock)', async () => {
    const { app, clock } = makeAuthApp()
    app.session = null
    for (let i = 0; i < 4; i++) {
      const e = await expectCode(app.call('auth', 'login', { username: 'admin', password: 'wrong-pass' }), 'UNAUTHENTICATED')
      expect((e.details as any).attemptsLeft).toBe(4 - i)
    }
    const lock = await expectCode(app.call('auth', 'login', { username: 'admin', password: 'wrong-pass' }), 'FORBIDDEN')
    expect((lock.details as any).retryAfterMs).toBe(5 * 60_000)
    expect(auditCount(app, 'lockout')).toBe(1)
    // correct password is refused while locked
    await expectCode(app.call('auth', 'login', { username: 'admin', password: ADMIN_PW }), 'FORBIDDEN')
    clock.t += 4 * 60_000 + 59_000
    await expectCode(app.call('auth', 'login', { username: 'admin', password: ADMIN_PW }), 'FORBIDDEN')
    clock.t += 2_000
    const s = (await app.call('auth', 'login', { username: 'admin', password: ADMIN_PW })) as any
    expect(s.username).toBe('admin')
    const u = app.db.get<any>("SELECT failed_attempts, locked_until FROM users WHERE username='admin'")!
    expect(u.failed_attempts).toBe(0)
    expect(u.locked_until).toBeNull()
  })

  it('success resets the failure counter', async () => {
    const { app } = makeAuthApp()
    app.session = null
    for (let i = 0; i < 3; i++) await expectCode(app.call('auth', 'login', { username: 'admin', password: 'wrong-pass' }), 'UNAUTHENTICATED')
    await app.call('auth', 'login', { username: 'admin', password: ADMIN_PW })
    expect(app.db.value('SELECT failed_attempts FROM users WHERE username=?', 'admin')).toBe(0)
  })

  it('blocks inactive users even with the right password', async () => {
    const { app } = makeAuthApp()
    const u = await addUser(app, 'old', 'Cashier')
    await app.call('auth', 'setUserActive', { id: u.id, active: false })
    app.session = null
    await expectCode(app.call('auth', 'login', { username: 'old', password: 'Passw0rd!x' }), 'FORBIDDEN')
    expect(auditCount(app, 'login_blocked')).toBe(1)
  })

  it('current() / logout()', async () => {
    const { app } = makeAuthApp()
    app.session = null
    expect(await app.call('auth', 'current')).toBeNull()
    await app.call('auth', 'login', { username: 'admin', password: ADMIN_PW })
    expect(((await app.call('auth', 'current')) as any).username).toBe('admin')
    await app.call('auth', 'logout')
    expect(app.session).toBeNull()
    expect(await app.call('auth', 'current')).toBeNull()
    expect(auditCount(app, 'logout')).toBe(1)
  })
})

describe('idle auto-lock', () => {
  it('pure isIdleExpired with injected clock', () => {
    expect(isIdleExpired(0, 9 * 60_000, 10)).toBe(false)
    expect(isIdleExpired(0, 10 * 60_000, 10)).toBe(true)
    expect(isIdleExpired(0, 10 ** 12, 0)).toBe(false)
  })

  it('locks on idle, rejects calls while locked, keeps identity visible, unlocks with password or PIN', async () => {
    const { app, clock, svc } = makeAuthApp()
    app.setSetting('security.autolock_minutes', '2')
    await app.call('auth', 'setPin', { password: ADMIN_PW, pin: '4821' })
    app.session = null
    await app.call('auth', 'login', { username: 'admin', password: ADMIN_PW })
    clock.t += 90_000
    expect(await app.call('auth', 'touch')).toEqual({ locked: false })
    clock.t += 90_000 // 90s since last touch -> still fine
    expect(await app.call('auth', 'touch')).toEqual({ locked: false })
    clock.t += 121_000
    expect(svc.checkIdle()).toBe(true)
    expect(app.session).toBeNull()
    await expectCode(app.call('auth', 'listUsers'), 'UNAUTHENTICATED')
    await expectCode(app.call('auth', 'touch'), 'UNAUTHENTICATED')
    const cur = (await app.call('auth', 'current')) as any
    expect(cur.locked).toBe(true)
    expect(cur.username).toBe('admin')
    expect(auditCount(app, 'lock')).toBe(1)
    // wrong PIN, then right PIN unlocks
    await expectCode(app.call('auth', 'login', { username: 'admin', pin: '9999' }), 'UNAUTHENTICATED')
    await app.call('auth', 'login', { username: 'admin', pin: '4821' })
    expect((app as any).session?.username).toBe("admin")
    expect(auditCount(app, 'unlock')).toBe(1)
    expect(((await app.call('auth', 'current')) as any).locked).toBe(false)
  })

  it('touch() itself locks when the idle window passed before the timer ran', async () => {
    const { app, clock } = makeAuthApp()
    app.setSetting('security.autolock_minutes', '1')
    await app.call('auth', 'touch')
    clock.t += 61_000
    expect(await app.call('auth', 'touch')).toEqual({ locked: true })
    expect(app.session).toBeNull()
  })

  it('manual lock + switch cashier via PIN', async () => {
    const { app } = makeAuthApp()
    await addUser(app, 'cash2', 'Cashier', 'Passw0rd!x', { pin: '2468' })
    await app.call('auth', 'lock')
    const s = (await app.call('auth', 'login', { username: 'cash2', pin: '2468' })) as any
    expect(s.username).toBe('cash2')
    expect(auditCount(app, 'switch_user')).toBe(1)
  })

  it('PIN is refused from a cold start and counts toward lockout', async () => {
    const { app } = makeAuthApp()
    await addUser(app, 'cash3', 'Cashier', 'Passw0rd!x', { pin: '2468' })
    app.session = null
    await expectCode(app.call('auth', 'login', { username: 'cash3', pin: '2468' }), 'VALIDATION')
    await app.call('auth', 'login', { username: 'cash3', password: 'Passw0rd!x' })
    for (let i = 0; i < 4; i++) await expectCode(app.call('auth', 'login', { username: 'cash3', pin: '1357' }), 'UNAUTHENTICATED')
    await expectCode(app.call('auth', 'login', { username: 'cash3', pin: '1357' }), 'FORBIDDEN')
    await expectCode(app.call('auth', 'login', { username: 'cash3', pin: '2468' }), 'FORBIDDEN')
  })
})

describe('passwords & PIN', () => {
  it('policy helper', () => {
    const p = { minLength: 8, requireDigit: false }
    expect(validatePassword('short', 'bob', p)).toMatch(/at least 8/)
    expect(validatePassword('Bobbobbob', 'bobbobbob', p)).toMatch(/username/)
    expect(validatePassword('longenough', 'bob', p)).toBeNull()
    expect(validatePassword('longenough', 'bob', { ...p, requireDigit: true })).toMatch(/digit/)
    expect(validatePin('123')).not.toBeNull()
    expect(validatePin('1234')).not.toBeNull()
    expect(validatePin('4821')).toBeNull()
    expect(validatePin('12ab')).not.toBeNull()
  })

  it('change own password: wrong current rejected, policy enforced, new works, forced flag cleared', async () => {
    const { app } = makeAuthApp()
    const u = await addUser(app, 'cash4', 'Cashier', 'Passw0rd!x', { mustChangePassword: true })
    app.session = null
    const s = (await app.call('auth', 'login', { username: 'cash4', password: 'Passw0rd!x' })) as any
    expect(s.mustChangePassword).toBe(true)
    await expectCode(app.call('auth', 'changePassword', { current: 'bad', next: 'Another#Pass1' }), 'UNAUTHENTICATED')
    await expectCode(app.call('auth', 'changePassword', { current: 'Passw0rd!x', next: 'short' }), 'VALIDATION')
    await expectCode(app.call('auth', 'changePassword', { current: 'Passw0rd!x', next: 'cash4' }), 'VALIDATION')
    await expectCode(app.call('auth', 'changePassword', { current: 'Passw0rd!x', next: 'Passw0rd!x' }), 'VALIDATION')
    await app.call('auth', 'changePassword', { current: 'Passw0rd!x', next: 'Another#Pass1' })
    expect(((await app.call('auth', 'current')) as any).mustChangePassword).toBe(false)
    await app.call('auth', 'logout')
    await expectCode(app.call('auth', 'login', { username: 'cash4', password: 'Passw0rd!x' }), 'UNAUTHENTICATED')
    await app.call('auth', 'login', { username: 'cash4', password: 'Another#Pass1' })
    expect(auditCount(app, 'password_change')).toBe(1)
    expect(u.id).toBeGreaterThan(0)
  })

  it('configurable policy via settings', async () => {
    const { app } = makeAuthApp()
    app.setSetting('security.password_min_length', '12')
    await expect(addUser(app, 'pw1', 'Cashier', 'elevenchars')).rejects.toThrow(/at least 12/)
    app.setSetting('security.password_require_digit', '1')
    await expect(addUser(app, 'pw1', 'Cashier', 'twelve-chars-long')).rejects.toThrow(/digit/)
    await addUser(app, 'pw1', 'Cashier', 'twelve-chars-1')
  })

  it('set/clear PIN requires the password and is audited; hash is not the PIN', async () => {
    const { app } = makeAuthApp()
    await expectCode(app.call('auth', 'setPin', { password: 'wrong', pin: '4821' }), 'UNAUTHENTICATED')
    await expectCode(app.call('auth', 'setPin', { password: ADMIN_PW, pin: '1234' }), 'VALIDATION')
    await app.call('auth', 'setPin', { password: ADMIN_PW, pin: '4821' })
    const h = app.db.value<string>("SELECT pin_hash FROM users WHERE username='admin'")!
    expect(h).toContain(':')
    expect(h).not.toContain('4821')
    await app.call('auth', 'clearPin', { password: ADMIN_PW })
    expect(app.db.value("SELECT pin_hash FROM users WHERE username='admin'")).toBeNull()
    expect(auditCount(app, 'pin_set')).toBe(1)
    expect(auditCount(app, 'pin_clear')).toBe(1)
  })
})

describe('diffJson', () => {
  it('reports changed leaf paths', () => {
    expect(diffJson('{"a":1,"b":{"c":2}}', '{"a":1,"b":{"c":3},"d":4}')).toEqual([
      { path: 'b.c', old: 2, new: 3 },
      { path: 'd', old: undefined, new: 4 }
    ])
    expect(diffJson(null, null)).toEqual([])
  })
})

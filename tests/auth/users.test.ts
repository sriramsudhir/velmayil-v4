import { describe, it, expect } from 'vitest'
import { makeAuthApp, addUser, roleId, auditCount, expectCode, ADMIN_PW } from './util'
import { assertCan } from '../../src/main/modules/auth/service'

const adminId = (app: any) => app.db.value('SELECT id FROM users WHERE username=?', 'admin') as number

describe('users management', () => {
  it('creates, lists (no hashes), updates, deactivates, audits', async () => {
    const { app } = makeAuthApp()
    const u = await addUser(app, 'sam', 'Cashier')
    const list = (await app.call('auth', 'listUsers')) as any[]
    const sam = list.find((x) => x.username === 'sam')
    expect(sam.role).toBe('Cashier')
    expect(JSON.stringify(list)).not.toMatch(/password_hash|pin_hash|:[0-9a-f]{64}/)
    await app.call('auth', 'updateUser', { id: u.id, name: 'Sam K', roleId: roleId(app, 'Manager') })
    expect(app.db.value('SELECT name FROM users WHERE id=?', u.id)).toBe('Sam K')
    await app.call('auth', 'setUserActive', { id: u.id, active: false })
    expect(app.db.value('SELECT active FROM users WHERE id=?', u.id)).toBe(0)
    expect(auditCount(app, 'create')).toBeGreaterThanOrEqual(1)
    expect(auditCount(app, 'update')).toBe(1)
    expect(auditCount(app, 'deactivate')).toBe(1)
    const upd = app.db.get<any>("SELECT old_json,new_json FROM audit_log WHERE action='update' AND entity='user'")!
    expect(JSON.parse(upd.old_json).role).toBe('Cashier')
    expect(JSON.parse(upd.new_json).role).toBe('Manager')
    expect(app.db.value('SELECT COUNT(*) FROM audit_log WHERE new_json LIKE ?', '%Passw0rd%')).toBe(0)
  })

  it('rejects duplicate and invalid usernames, weak passwords', async () => {
    const { app } = makeAuthApp()
    await addUser(app, 'dup', 'Cashier')
    await expectCode(addUser(app, 'DUP', 'Cashier'), 'CONFLICT')
    await expectCode(addUser(app, 'a b', 'Cashier'), 'VALIDATION')
    await expectCode(addUser(app, 'weak', 'Cashier', 'short'), 'VALIDATION')
    await expectCode(addUser(app, 'samepass1', 'Cashier', 'samepass1'), 'VALIDATION')
  })

  it('protects the last active Owner (deactivate, demote) and self lock-out', async () => {
    const { app } = makeAuthApp()
    const id = adminId(app)
    await expectCode(app.call('auth', 'setUserActive', { id, active: false }), 'FORBIDDEN') // self
    await expectCode(app.call('auth', 'updateUser', { id, roleId: roleId(app, 'Manager') }), 'FORBIDDEN') // self role change
    // second owner makes things possible, then the remaining one is protected
    const o2 = await addUser(app, 'owner2', 'Owner')
    await app.call('auth', 'setUserActive', { id: o2.id, active: false }) // allowed: admin remains
    await app.call('auth', 'setUserActive', { id: o2.id, active: true })
    // owner2 deactivates admin (allowed: owner2 remains the active Owner)
    app.session = null
    await app.call('auth', 'login', { username: 'owner2', password: 'Passw0rd!x' })
    await app.call('auth', 'setUserActive', { id, active: false })
    // someone else with full access can no longer remove the last active Owner
    app.session = { ...app.session!, userId: id, username: 'admin', permissions: ['*'] }
    await expectCode(app.call('auth', 'setUserActive', { id: o2.id, active: false }), 'CONFLICT')
    await expectCode(app.call('auth', 'updateUser', { id: o2.id, roleId: roleId(app, 'Cashier') }), 'CONFLICT')
  })

  it('resetPassword: audited, clears lockout, forces change, old password dead', async () => {
    const { app } = makeAuthApp()
    const u = await addUser(app, 'locked1', 'Cashier')
    app.session = null
    for (let i = 0; i < 5; i++) await app.call('auth', 'login', { username: 'locked1', password: 'bad-bad-bad' }).catch(() => {})
    await app.call('auth', 'login', { username: 'admin', password: ADMIN_PW })
    await expectCode(app.call('auth', 'resetPassword', { id: u.id, newPassword: 'short' }), 'VALIDATION')
    await app.call('auth', 'resetPassword', { id: u.id, newPassword: 'Brand#New99' })
    expect(auditCount(app, 'password_reset')).toBe(1)
    app.session = null
    await expectCode(app.call('auth', 'login', { username: 'locked1', password: 'Passw0rd!x' }), 'UNAUTHENTICATED')
    const s = (await app.call('auth', 'login', { username: 'locked1', password: 'Brand#New99' })) as any
    expect(s.mustChangePassword).toBe(true)
  })
})

describe('permission enforcement (server side)', () => {
  it('cashier cannot manage users/roles/audit; manager can view but not manage', async () => {
    const { app } = makeAuthApp()
    const target = await addUser(app, 'victim', 'Cashier')
    await addUser(app, 'cashq', 'Cashier')
    await addUser(app, 'mgrq', 'Manager')
    app.session = null
    await app.call('auth', 'login', { username: 'cashq', password: 'Passw0rd!x' })
    for (const [m, a] of [
      ['createUser', { username: 'zzz', name: 'z', roleId: 1, password: 'Passw0rd!x' }], ['updateUser', { id: target.id, name: 'x' }],
      ['setUserActive', { id: target.id, active: false }], ['resetPassword', { id: target.id, newPassword: 'Hack#12345' }],
      ['resetPin', { id: target.id }], ['saveRole', { name: 'X1', permissions: [], maxDiscountBp: 0 }], ['deleteRole', { id: 1 }],
      ['listUsers', {}], ['listRoles', {}], ['permissionCatalog', {}], ['listApprovals', {}]
    ] as const) await expectCode(app.call('auth', m, a), 'FORBIDDEN')
    await expectCode(app.call('audit', 'search', {}), 'FORBIDDEN')
    await expectCode(app.call('audit', 'entities', {}), 'FORBIDDEN')
    expect(() => assertCan(app, 'users.manage')).toThrow(/Permission required/)
    expect(() => assertCan(app, 'pos.sell')).not.toThrow()

    await app.call('auth', 'login', { username: 'mgrq', password: 'Passw0rd!x' })
    expect(((await app.call('auth', 'listUsers')) as any[]).length).toBeGreaterThan(2)
    await expectCode(app.call('auth', 'setUserActive', { id: target.id, active: false }), 'FORBIDDEN')
    expect(((await app.call('audit', 'search', {})) as any).total).toBeGreaterThan(0)
  })

  it('a non-owner with users.manage cannot escalate privileges', async () => {
    const { app } = makeAuthApp()
    await app.call('auth', 'saveRole', { name: 'HR', permissions: ['users.view', 'users.manage'], maxDiscountBp: 0 })
    const hr = roleId(app, 'HR')
    await addUser(app, 'hr1', 'Cashier', 'Passw0rd!x', { roleId: hr })
    const owner = adminId(app)
    app.session = null
    await app.call('auth', 'login', { username: 'hr1', password: 'Passw0rd!x' })
    await expectCode(app.call('auth', 'createUser', { username: 'evil', name: 'E', roleId: roleId(app, 'Owner'), password: 'Passw0rd!x' }), 'FORBIDDEN')
    await expectCode(app.call('auth', 'createUser', { username: 'evil', name: 'E', roleId: roleId(app, 'Manager'), password: 'Passw0rd!x' }), 'FORBIDDEN')
    await expectCode(app.call('auth', 'resetPassword', { id: owner, newPassword: 'Hijack#1234' }), 'FORBIDDEN')
    await expectCode(app.call('auth', 'saveRole', { id: hr, name: 'HR', permissions: ['users.view', 'users.manage', 'backup.manage'], maxDiscountBp: 0 }), 'FORBIDDEN')
    await expectCode(app.call('auth', 'saveRole', { name: 'God', permissions: ['*'], maxDiscountBp: 0 }), 'FORBIDDEN')
  })
})

describe('roles', () => {
  it('CRUD with permission checkboxes, audited with old/new, applies to live session', async () => {
    const { app } = makeAuthApp()
    const cat = (await app.call('auth', 'permissionCatalog')) as any[]
    expect(cat.find((c) => c.key === 'pos.void')).toBeTruthy()
    const r = (await app.call('auth', 'saveRole', { name: 'Supervisor', permissions: ['pos.sell', 'pos.void'], maxDiscountBp: 2000 })) as any
    expect(r.isSystem).toBe(false)
    await expectCode(app.call('auth', 'saveRole', { name: 'supervisor', permissions: [], maxDiscountBp: 0 }), 'CONFLICT')
    await expectCode(app.call('auth', 'saveRole', { name: 'Bad', permissions: ['not.real'], maxDiscountBp: 0 }), 'VALIDATION')
    await expectCode(app.call('auth', 'saveRole', { name: 'Bad', permissions: [], maxDiscountBp: 10001 }), 'VALIDATION')
    await app.call('auth', 'saveRole', { id: r.id, name: 'Supervisor', permissions: ['pos.sell', 'pos.return'], maxDiscountBp: 1500 })
    const a = app.db.get<any>("SELECT * FROM audit_log WHERE entity='role' AND action='update'")!
    expect(JSON.parse(a.old_json).permissions).toEqual(['pos.sell', 'pos.void'])
    expect(JSON.parse(a.new_json).permissions).toEqual(['pos.return', 'pos.sell'])
    expect(a.note).toContain('added: pos.return')
    expect(a.note).toContain('removed: pos.void')
    const u = await addUser(app, 'sup1', 'Cashier', 'Passw0rd!x', { roleId: r.id })
    await expectCode(app.call('auth', 'deleteRole', { id: r.id }), 'CONFLICT') // in use
    app.db.run('UPDATE users SET role_id = ? WHERE id = ?', roleId(app, 'Cashier'), u.id)
    await app.call('auth', 'deleteRole', { id: r.id })
    expect(auditCount(app, 'delete')).toBe(1)
  })

  it('system roles: cannot delete/rename; Owner stays full access', async () => {
    const { app } = makeAuthApp()
    for (const n of ['Owner', 'Manager', 'Cashier']) await expectCode(app.call('auth', 'deleteRole', { id: roleId(app, n) }), 'FORBIDDEN')
    await expectCode(app.call('auth', 'saveRole', { id: roleId(app, 'Cashier'), name: 'Till', permissions: [], maxDiscountBp: 0 }), 'FORBIDDEN')
    await expectCode(app.call('auth', 'saveRole', { id: roleId(app, 'Owner'), name: 'Owner', permissions: ['pos.sell'], maxDiscountBp: 10000 }), 'FORBIDDEN')
    // editing Cashier permissions/discount is allowed
    await app.call('auth', 'saveRole', { id: roleId(app, 'Cashier'), name: 'Cashier', permissions: ['pos.sell'], maxDiscountBp: 500 })
    expect(app.db.value("SELECT max_discount_bp FROM roles WHERE name='Cashier'")).toBe(500)
  })

  it('permission edits take effect on the signed-in session immediately', async () => {
    const { app } = makeAuthApp()
    await app.call('auth', 'saveRole', { name: 'Edit1', permissions: ['users.view', 'users.manage'], maxDiscountBp: 0 })
    await addUser(app, 'editq', 'Cashier', 'Passw0rd!x', { roleId: roleId(app, 'Edit1') })
    app.session = null
    await app.call('auth', 'login', { username: 'editq', password: 'Passw0rd!x' })
    await app.call('auth', 'saveRole', { id: roleId(app, 'Edit1'), name: 'Edit1', permissions: ['users.view'], maxDiscountBp: 0 })
    expect(app.session!.permissions).toEqual(['users.view'])
    await expectCode(app.call('auth', 'saveRole', { name: 'N2', permissions: [], maxDiscountBp: 0 }), 'FORBIDDEN')
  })
})

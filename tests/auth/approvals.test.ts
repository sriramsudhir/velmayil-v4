import { describe, it, expect } from 'vitest'
import { makeAuthApp, addUser, auditCount, expectCode } from './util'
import { verifyApprover, checkApproval } from '../../src/main/modules/auth/service'

async function setup() {
  const ctx = makeAuthApp()
  await addUser(ctx.app, 'boss', 'Manager', 'Passw0rd!x', { pin: '2468' })
  await addUser(ctx.app, 'till', 'Cashier', 'Passw0rd!x', { pin: '1357' })
  ctx.app.session = null
  await ctx.app.call('auth', 'login', { username: 'till', password: 'Passw0rd!x' }) // requester
  return ctx
}

describe('approvals', () => {
  it('manager password approves; row + audit written; requester recorded', async () => {
    const { app } = await setup()
    const r = (await app.call('auth', 'verifyApprover', {
      username: 'boss', password: 'Passw0rd!x', action: 'pos.void', entity: 'sale', entityId: 42, reason: 'Wrong item', detail: { total: 5000 }
    })) as any
    expect(r.approvedBy.username).toBe('boss')
    expect(r.approvedBy.role).toBe('Manager')
    const row = app.db.get<any>('SELECT * FROM approvals WHERE id = ?', r.approvalId)!
    expect(row.action).toBe('pos.void')
    expect(row.entity_id).toBe('42')
    expect(row.reason).toBe('Wrong item')
    expect(JSON.parse(row.detail_json)).toEqual({ total: 5000 })
    expect(row.requested_by).toBe(app.session!.userId)
    expect(row.approved_by).toBe(r.approvedBy.id)
    expect(auditCount(app, 'grant')).toBe(1)
  })

  it('PIN works, standalone verifyApprover/checkApproval helpers work', async () => {
    const { app, clock } = await setup()
    const r = verifyApprover(app, { username: 'boss', pin: '2468', action: 'pos.discount' })
    expect(checkApproval(app, r.approvalId, 'pos.discount').id).toBe(r.approvalId)
    await expect(Promise.resolve().then(() => checkApproval(app, r.approvalId, 'pos.void'))).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' })
    clock.t += 11 * 60_000
    expect(() => checkApproval(app, r.approvalId, 'pos.discount')).toThrow(/approval is required/i)
  })

  it('cashier-as-approver is rejected (and audited) unless they hold the specific permission', async () => {
    const { app } = await setup()
    await expectCode(app.call('auth', 'verifyApprover', { username: 'till', password: 'Passw0rd!x', action: 'pos.void' }), 'FORBIDDEN')
    expect(auditCount(app, 'approval_denied')).toBe(1)
    expect(app.db.value('SELECT COUNT(*) FROM approvals')).toBe(0)
    // specific permission path: cashier holds pos.sell
    const ok = (await app.call('auth', 'verifyApprover', { username: 'till', pin: '1357', action: 'x', permission: 'pos.sell' })) as any
    expect(ok.approvalId).toBeGreaterThan(0)
  })

  it('wrong password counts toward the approver lockout, which then blocks valid approvals', async () => {
    const { app } = await setup()
    for (let i = 0; i < 4; i++) await expectCode(app.call('auth', 'verifyApprover', { username: 'boss', password: 'nope-nope', action: 'pos.void' }), 'UNAUTHENTICATED')
    await expectCode(app.call('auth', 'verifyApprover', { username: 'boss', password: 'nope-nope', action: 'pos.void' }), 'FORBIDDEN')
    await expectCode(app.call('auth', 'verifyApprover', { username: 'boss', password: 'Passw0rd!x', action: 'pos.void' }), 'FORBIDDEN')
    await expectCode(app.call('auth', 'verifyApprover', { username: 'boss', pin: '2468', action: 'pos.void' }), 'FORBIDDEN')
    expect(auditCount(app, 'approval_failed')).toBeGreaterThanOrEqual(4)
    expect(auditCount(app, 'lockout')).toBe(1)
  })

  it('needs a session, valid input, an active approver', async () => {
    const { app } = await setup()
    await expectCode(app.call('auth', 'verifyApprover', { username: 'boss', action: 'x' }), 'VALIDATION')
    await expectCode(app.call('auth', 'verifyApprover', { username: 'boss', password: 'a', pin: '2468', action: 'x' }), 'VALIDATION')
    await expectCode(app.call('auth', 'verifyApprover', { username: 'boss', password: 'Passw0rd!x', action: 'x', permission: 'nope' }), 'VALIDATION')
    await expectCode(app.call('auth', 'verifyApprover', { username: 'ghost', password: 'whatever1', action: 'x' }), 'UNAUTHENTICATED')
    app.db.run("UPDATE users SET active = 0 WHERE username='boss'")
    await expectCode(app.call('auth', 'verifyApprover', { username: 'boss', password: 'Passw0rd!x', action: 'x' }), 'FORBIDDEN')
    app.session = null
    await expectCode(app.call('auth', 'verifyApprover', { username: 'boss', password: 'Passw0rd!x', action: 'x' }), 'UNAUTHENTICATED')
  })
})

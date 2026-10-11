import { describe, it, expect, beforeEach } from 'vitest'
import { createTestApp, actAs } from '../helpers'
import { hashPassword } from '../../src/main/core/crypto'
import type { App } from '../../src/main/core/app'

let app: App
let variantId: number
const call = <T = any>(svc: string, method: string, args?: unknown) => app.call(svc, method, args) as Promise<T>
const addUser = (username: string, role: string, pw = 'Passw0rd!x') =>
  app.db.run('INSERT INTO users(uuid,username,name,role_id,password_hash) VALUES (?,?,?,(SELECT id FROM roles WHERE name=?),?)', app.uuid(), username, username, role, hashPassword(pw))

beforeEach(() => {
  app = createTestApp()
  const p = app.db.run('INSERT INTO products(uuid,name,tax_rate_bp,hsn,track_stock) VALUES (?,?,?,?,?)', app.uuid(), 'Rocket', 0, '3604', 0)
  variantId = app.db.run('INSERT INTO product_variants(uuid,product_id,sku,barcode,price,mrp,cost) VALUES (?,?,?,?,?,?,?)', app.uuid(), p.lastId, 'RKT', 'BC-RKT', 10000, 10000, 5000).lastId
})

describe('approvals: pos <-> auth.verifyApprover', () => {
  it('void by a user without approvals.grant -> APPROVAL_REQUIRED -> manager approves via auth -> void succeeds; approval is bound to that sale', async () => {
    const sale = await call('pos', 'completeSale', { lines: [{ variantId, qty: 1 }], payments: [{ method: 'cash', amount: 10000 }] })
    const other = await call('pos', 'completeSale', { lines: [{ variantId, qty: 1 }], payments: [{ method: 'cash', amount: 10000 }] })
    addUser('mgr', 'Manager')
    // a supervisor-type role: may void, but only with a manager's approval
    actAs(app, 'Cashier')
    app.session = { ...app.session!, permissions: ['pos.sell', 'pos.void', 'pos.reprint'] }
    await expect(call('pos', 'voidSale', { saleId: sale.saleId, reason: 'wrong item' })).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' })

    // exactly what <ApprovalDialog action="pos.void" entity="sale" entityId={id}> sends
    const ok = await call('auth', 'verifyApprover', { username: 'mgr', password: 'Passw0rd!x', action: 'pos.void', entity: 'sale', entityId: sale.saleId, reason: 'wrong item' })
    // an approval for sale A cannot void sale B
    await expect(call('pos', 'voidSale', { saleId: other.saleId, reason: 'wrong item', approval: { approvalId: ok.approvalId } })).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' })
    const r = await call('pos', 'voidSale', { saleId: sale.saleId, reason: 'wrong item', approval: { approvalId: ok.approvalId } })
    expect(r.ok).toBe(true)
    expect(app.db.value('SELECT status FROM sales WHERE id=?', sale.saleId)).toBe('void')
    expect(app.db.value('SELECT void_approved_by FROM sales WHERE id=?', sale.saleId)).toBe(app.db.value("SELECT id FROM users WHERE username='mgr'"))
  })

  it('cashier cannot act as approver', async () => {
    addUser('cash2', 'Cashier')
    actAs(app, 'Cashier')
    await expect(call('auth', 'verifyApprover', { username: 'cash2', password: 'Passw0rd!x', action: 'pos.void' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('discount above the cashier limit: approval from auth (no entity) is accepted once, not reusable', async () => {
    addUser('mgr', 'Manager')
    actAs(app, 'Cashier')
    const input = { lines: [{ variantId, qty: 1 }], billDiscount: { type: 'percent', value: 5000 }, payments: [{ method: 'cash', amount: 10000 }] }
    await expect(call('pos', 'completeSale', input)).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' })
    const ok = await call('auth', 'verifyApprover', { username: 'mgr', password: 'Passw0rd!x', action: 'pos.discount', entity: 'sale' })
    const r = await call('pos', 'completeSale', { ...input, approval: { approvalId: ok.approvalId } })
    expect(r.total).toBe(5000)
    await expect(call('pos', 'completeSale', { ...input, approval: { approvalId: ok.approvalId } })).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' })
    // a void approval is not a discount approval
    const v = await call('auth', 'verifyApprover', { username: 'mgr', password: 'Passw0rd!x', action: 'pos.void' })
    await expect(call('pos', 'completeSale', { ...input, approval: { approvalId: v.approvalId } })).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' })
  })
})

describe('settings secrets', () => {
  it('sync.key never appears in settings.getAll for non-owners (and is masked for the owner)', async () => {
    app.setSetting('sync.key', 'super-secret-key')
    const owner = await call('settings', 'getAll')
    expect(JSON.stringify(owner)).not.toContain('super-secret-key')
    actAs(app, 'Cashier')
    const cashier = await call('settings', 'getAll')
    expect(JSON.stringify(cashier)).not.toContain('super-secret-key')
    expect(cashier.values['sync.key']).toBeUndefined()
    // sync config for the renderer never carries it either
    actAs(app, 'Manager')
    expect(JSON.stringify(await call('sync', 'getConfig').catch(() => ({})))).not.toContain('super-secret-key')
  })

  it('users / roles / approvals are never queued for sync', async () => {
    addUser('mgr', 'Manager')
    await call('auth', 'createUser', { username: 'newguy', name: 'New', roleId: app.db.value<number>("SELECT id FROM roles WHERE name='Cashier'"), password: 'Passw0rd!x', mustChangePassword: false })
    expect(app.db.value("SELECT COUNT(*) FROM sync_queue WHERE entity IN ('users','roles','approvals')")).toBe(0)
  })
})

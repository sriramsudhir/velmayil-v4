import { describe, it, expect, beforeEach } from 'vitest'
import { createTestApp, actAs } from '../helpers'
import type { App } from '../../src/main/core/app'
import { hashPassword } from '../../src/main/core/crypto'
import { runMigrations } from '../../src/main/db/migrate'
import { migration as saleDelete } from '../../src/main/db/migrations/110_sale_delete'
import { DEFAULT_ROLES, PERMISSIONS, hasPermission } from '../../src/shared/permissions'
import type { DashboardSummary } from '../../src/shared/reports'
import { assertInvariant, availCodes, cashSale, statusOf, stockAt, trackedProduct } from '../units/helpers'

let app: App
let v18: number // Rs 118.00 inclusive, 18%
let v5: number // Rs 105.00 inclusive, 5%
let vNoTrack: number

const call = <T = any>(method: string, args?: unknown) => app.call('pos', method, args) as Promise<T>
const stock = (v: number) => app.db.value<number>('SELECT COALESCE(SUM(qty),0) FROM stock_levels WHERE variant_id = ?', v)!
const n = (sql: string, ...p: any[]) => app.db.value<number>(sql, ...p)!
const dashboard = () => app.call('dashboard', 'summary', {}) as Promise<DashboardSummary>
const todayReport = async () => ((await app.call('reports', 'run', { id: 'sales_summary', filters: { preset: 'today' } })) as any).totals as { bills: number; total: number; returns: number }

function product(name: string, price: number, taxBp: number, qty: number, track = 1): number {
  const p = app.db.run('INSERT INTO products(uuid,name,tax_rate_bp,hsn,track_stock) VALUES (?,?,?,?,?)', app.uuid(), name, taxBp, '3604', track)
  const v = app.db.run('INSERT INTO product_variants(uuid,product_id,sku,barcode,price,mrp,cost) VALUES (?,?,?,?,?,?,?)', app.uuid(), p.lastId, 'SKU-' + name, 'BC-' + name, price, price, Math.floor(price / 2))
  if (qty) app.moveStock({ variantId: v.lastId, delta: qty, type: 'opening' })
  return v.lastId
}

function addManager(): { username: string; password: string } {
  const role = app.db.value<number>("SELECT id FROM roles WHERE name='Manager'")!
  app.db.run('INSERT INTO users(uuid,username,name,role_id,password_hash) VALUES (?,?,?,?,?)', app.uuid(), 'boss', 'Boss', role, hashPassword('secret123'))
  return { username: 'boss', password: 'secret123' }
}

/** Nothing of the bill is left in any table that hangs off a sale. */
function expectGone(saleId: number): void {
  expect(n('SELECT COUNT(*) FROM sales WHERE id = ?', saleId)).toBe(0)
  expect(n('SELECT COUNT(*) FROM sale_items WHERE sale_id = ?', saleId)).toBe(0)
  expect(n('SELECT COUNT(*) FROM sale_payments WHERE sale_id = ?', saleId)).toBe(0)
  expect(n('SELECT COUNT(*) FROM sale_returns WHERE sale_id = ?', saleId)).toBe(0)
  expect(n('SELECT COUNT(*) FROM sale_return_items WHERE return_id NOT IN (SELECT id FROM sale_returns)')).toBe(0)
  expect(n('SELECT COUNT(*) FROM product_units WHERE sale_id = ?', saleId)).toBe(0)
  expect(app.db.all('PRAGMA foreign_key_check')).toEqual([])
}

beforeEach(() => {
  app = createTestApp()
  v18 = product('Rocket', 11800, 1800, 50)
  v5 = product('Sparkler', 10500, 500, 20)
  vNoTrack = product('Service', 5000, 0, 0, 0)
})

describe('deleteSale: a normal bill', () => {
  it('removes the invoice and everything on it, puts the stock back, and leaves an audit trail + tombstone', async () => {
    const keep = await call('completeSale', { lines: [{ variantId: v5, qty: 1 }], payments: [{ method: 'upi', amount: 10500 }] })
    const r = await call('completeSale', {
      lines: [{ variantId: v18, qty: 3 }, { variantId: v5, qty: 2 }, { variantId: vNoTrack, qty: 1 }],
      customer: { name: 'Ravi', phone: '9000000001' }, payments: [{ method: 'cash', amount: 40000 }, { method: 'credit', amount: 21400 }]
    })
    expect(r.total).toBe(3 * 11800 + 2 * 10500 + 5000)
    const uuid = app.db.value<string>('SELECT uuid FROM sales WHERE id = ?', r.saleId)!
    // print history of this bill and of another one
    app.db.run("INSERT INTO print_log(paper,printer,ok,action,doc_ref,html) VALUES ('80','P',0,'print',?,'<p>bill</p>')", r.invoiceNo)
    app.db.run("INSERT INTO print_log(paper,printer,ok,action,doc_ref) VALUES ('80','P',1,'print',?)", keep.invoiceNo)
    expect(stock(v18)).toBe(47)
    expect(stock(v5)).toBe(17)

    const before = await dashboard()
    expect(before.today).toMatchObject({ bills: 2, sales: r.total + 10500 })
    expect(before.recentSales.map((s) => s.invoiceNo)).toContain(r.invoiceNo)
    expect(await todayReport()).toMatchObject({ bills: 2, total: r.total + 10500 })
    const moves = n('SELECT COUNT(*) FROM stock_movements')

    const out = await call('deleteSale', { saleId: r.saleId, reason: 'billed twice' })
    expect(out).toEqual({ ok: true, saleId: r.saleId, invoiceNo: r.invoiceNo, total: r.total, stockRestored: 5 })

    expectGone(r.saleId)
    expect(n('SELECT COUNT(*) FROM print_log WHERE doc_ref = ?', r.invoiceNo)).toBe(0)
    expect(n('SELECT COUNT(*) FROM print_log WHERE doc_ref = ?', keep.invoiceNo)).toBe(1)
    // stock is back, through the ledger (two movements, nothing rewritten); the non-tracked line moves nothing
    expect(stock(v18)).toBe(50)
    expect(stock(v5)).toBe(19)
    expect(stock(vNoTrack)).toBe(0)
    expect(n('SELECT COUNT(*) FROM stock_movements')).toBe(moves + 2)
    expect(n("SELECT COALESCE(SUM(qty_delta),0) FROM stock_movements WHERE ref_type='sale' AND ref_id=?", String(r.saleId))).toBe(0)
    expect(await app.call('inventory', 'verifyLedger')).toMatchObject({ ok: true })

    // dashboard + reports no longer count the bill; the other bill is untouched
    const after = await dashboard()
    expect(after.today).toMatchObject({ bills: 1, sales: 10500 })
    expect(after.recentSales.map((s) => s.invoiceNo)).toEqual([keep.invoiceNo])
    expect(after.paymentMix.map((p) => p.method)).toEqual(['upi'])
    expect(await todayReport()).toMatchObject({ bills: 1, total: 10500 })
    expect((await call('listSales', {})).rows.map((x: any) => x.invoiceNo)).toEqual([keep.invoiceNo])
    await expect(call('getSale', { id: r.saleId })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    // the customer stays, without the credit bill
    expect(n("SELECT COUNT(*) FROM customers WHERE phone='9000000001'")).toBe(1)
    expect(n("SELECT COALESCE(SUM(amount),0) FROM sale_payments WHERE method='credit'")).toBe(0)

    // audit: a compact copy of the bill + reason + who
    const a = app.db.get<any>("SELECT * FROM audit_log WHERE entity='sale' AND action='delete' AND entity_id=?", String(r.saleId))!
    expect(a.note).toBe('billed twice')
    expect(a.user_name).toBe('Admin')
    const old = JSON.parse(a.old_json)
    expect(old).toMatchObject({ uuid, invoiceNo: r.invoiceNo, total: r.total, customerName: 'Ravi', status: 'completed' })
    expect(old.items.map((i: any) => [i.name, i.qty, i.lineTotal])).toEqual([['Rocket', 3, 35400], ['Sparkler', 2, 21000], ['Service', 1, 5000]])
    expect(old.payments.map((p: any) => [p.method, p.amount])).toEqual([['cash', 40000], ['credit', 21400]])
    expect(old.returns).toEqual([])
    expect(JSON.parse(a.new_json)).toMatchObject({ deleted: true, reason: 'billed twice', approvedBy: app.session!.userId, stockRestored: [{ variantId: v18, qty: 3 }, { variantId: v5, qty: 2 }] })
    // the creation entry of the bill is still in the (append-only) audit log
    expect(n("SELECT COUNT(*) FROM audit_log WHERE entity='sale' AND action='create' AND entity_id=?", String(r.saleId))).toBe(1)

    // tombstone + sync delete op
    expect(app.db.get<any>('SELECT * FROM deleted_sales WHERE uuid = ?', uuid)).toMatchObject({ invoice_no: r.invoiceNo, total: r.total, reason: 'billed twice', deleted_by: app.session!.userId, deleted_by_name: 'Admin' })
    const q = app.db.get<any>("SELECT * FROM sync_queue WHERE entity='sales' AND op='delete'")!
    expect(q.entity_uuid).toBe(uuid)
    expect(JSON.parse(q.payload_json)).toMatchObject({ table: 'sales', uuid, row: { invoice_no: r.invoiceNo, reason: 'billed twice' } })

    // deleting again is a clear NOT_FOUND, and the number is never issued again
    await expect(call('deleteSale', { saleId: r.saleId, reason: 'billed twice' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(call('deleteSale', { saleId: 987654, reason: 'billed twice' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    const next = await call('completeSale', { lines: [{ variantId: v5, qty: 1 }], payments: [{ method: 'cash', amount: 10500 }] })
    expect(next.invoiceNo).toMatch(/000003$/)
    expect(next.invoiceNo).not.toBe(r.invoiceNo)
  })

  it('needs a reason, and the database still refuses any other hard delete', async () => {
    const r = await call('completeSale', { lines: [{ variantId: v18, qty: 1 }], payments: [{ method: 'cash', amount: 11800 }] })
    await expect(call('deleteSale', { saleId: r.saleId })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call('deleteSale', { saleId: r.saleId, reason: '  ' })).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(n('SELECT COUNT(*) FROM sales')).toBe(1)
    expect(stock(v18)).toBe(49)
    // no tombstone => the integrity triggers of 002 are still in force
    expect(() => app.db.run('DELETE FROM sales WHERE id = ?', r.saleId)).toThrow(/cannot be deleted/)
    expect(() => app.db.run('DELETE FROM sale_items WHERE sale_id = ?', r.saleId)).toThrow(/cannot be deleted/)
    expect(() => app.db.run('DELETE FROM sale_payments WHERE sale_id = ?', r.saleId)).toThrow(/cannot be deleted/)
    const item = (await call('getSale', { id: r.saleId })).items[0]
    const ret = await call('createReturn', { saleId: r.saleId, items: [{ saleItemId: item.id, qty: 1 }], reason: 'x' })
    expect(() => app.db.run('DELETE FROM sale_return_items WHERE return_id = ?', ret.returnId)).toThrow(/cannot be deleted/)
    expect(() => app.db.run('DELETE FROM sale_returns WHERE id = ?', ret.returnId)).toThrow(/cannot be deleted/)
  })

  it('a failure in the middle rolls everything back (one transaction)', async () => {
    const r = await call('completeSale', { lines: [{ variantId: v18, qty: 2 }], payments: [{ method: 'cash', amount: 23600 }] })
    app.db.exec("CREATE TRIGGER t_boom BEFORE DELETE ON sale_payments BEGIN SELECT RAISE(ABORT, 'boom'); END")
    await expect(call('deleteSale', { saleId: r.saleId, reason: 'will fail' })).rejects.toThrow(/boom/)
    expect(n('SELECT COUNT(*) FROM sales')).toBe(1)
    expect(n('SELECT COUNT(*) FROM sale_items')).toBe(1)
    expect(n('SELECT COUNT(*) FROM deleted_sales')).toBe(0)
    expect(stock(v18)).toBe(48)
    expect(n("SELECT COUNT(*) FROM audit_log WHERE action='delete'")).toBe(0)
    expect(n("SELECT COUNT(*) FROM sync_queue WHERE op='delete'")).toBe(0)
  })
})

describe('deleteSale: returns and voids', () => {
  it('a bill with a partial return gives back only what is still out (restocked and written-off returns are not restored again)', async () => {
    const r = await call('completeSale', { lines: [{ variantId: v18, qty: 5 }, { variantId: v5, qty: 4 }], payments: [{ method: 'cash', amount: 101000 }] })
    const sale = await call('getSale', { id: r.saleId })
    const [a, b] = sale.items
    // 2 rockets come back to the shelf, 1 sparkler is damaged (not restocked)
    const ret = await call('createReturn', { saleId: r.saleId, items: [{ saleItemId: a.id, qty: 2, restock: true }, { saleItemId: b.id, qty: 1, restock: false }], reason: 'damaged' })
    app.db.run("INSERT INTO print_log(paper,printer,ok,action,doc_ref) VALUES ('80','P',1,'print',?)", ret.returnNo)
    expect(stock(v18)).toBe(50 - 5 + 2)
    expect(stock(v5)).toBe(20 - 4)
    expect((await dashboard()).today.returns).toBe(ret.total)

    const out = await call('deleteSale', { saleId: r.saleId, reason: 'wrong customer' })
    expect(out.stockRestored).toBe(3 + 3)
    expectGone(r.saleId)
    expect(n('SELECT COUNT(*) FROM sale_returns')).toBe(0)
    expect(n('SELECT COUNT(*) FROM sale_return_items')).toBe(0)
    expect(n('SELECT COUNT(*) FROM print_log')).toBe(0)
    // rockets: all 5 are back (2 by the return + 3 now). sparklers: 3 back, the damaged one stays written off
    expect(stock(v18)).toBe(50)
    expect(stock(v5)).toBe(19)
    expect(await app.call('inventory', 'verifyLedger')).toMatchObject({ ok: true })
    const d = await dashboard()
    expect(d.today).toMatchObject({ bills: 0, sales: 0, returns: 0 })
    expect(await todayReport()).toMatchObject({ bills: 0, total: 0, returns: 0 })
    const old = JSON.parse(app.db.value<string>("SELECT old_json FROM audit_log WHERE entity='sale' AND action='delete'")!)
    expect(old.returns).toHaveLength(1)
    expect(old.returns[0]).toMatchObject({ returnNo: ret.returnNo, total: ret.total, reason: 'damaged' })
    expect(old.returns[0].items.map((x: any) => [x.qty, x.restock])).toEqual([[2, 1], [1, 0]])
    expect(old.items.map((x: any) => x.returnedQty)).toEqual([2, 1])
  })

  it('a fully returned bill restores nothing more', async () => {
    const r = await call('completeSale', { lines: [{ variantId: v18, qty: 2 }], payments: [{ method: 'cash', amount: 23600 }] })
    const item = (await call('getSale', { id: r.saleId })).items[0]
    await call('createReturn', { saleId: r.saleId, items: [{ saleItemId: item.id, qty: 2 }], reason: 'all back' })
    expect(stock(v18)).toBe(50)
    const moves = n('SELECT COUNT(*) FROM stock_movements')
    expect((await call('deleteSale', { saleId: r.saleId, reason: 'clean up' })).stockRestored).toBe(0)
    expect(stock(v18)).toBe(50)
    expect(n('SELECT COUNT(*) FROM stock_movements')).toBe(moves)
    expectGone(r.saleId)
  })

  it('a void bill was restored when it was voided: deleting it does not restore the stock a second time', async () => {
    const r = await call('completeSale', { lines: [{ variantId: v18, qty: 4 }], payments: [{ method: 'cash', amount: 47200 }] })
    await call('voidSale', { saleId: r.saleId, reason: 'mistake' })
    expect(stock(v18)).toBe(50)
    const moves = n('SELECT COUNT(*) FROM stock_movements')
    const out = await call('deleteSale', { saleId: r.saleId, reason: 'remove the void bill' })
    expect(out.stockRestored).toBe(0)
    expect(stock(v18)).toBe(50)
    expect(n('SELECT COUNT(*) FROM stock_movements')).toBe(moves)
    expectGone(r.saleId)
    expect(await app.call('inventory', 'verifyLedger')).toMatchObject({ ok: true })
    expect(JSON.parse(app.db.value<string>("SELECT old_json FROM audit_log WHERE entity='sale' AND action='delete'")!)).toMatchObject({ status: 'void', voidReason: 'mistake' })
    expect((await dashboard()).recentSales).toEqual([])
  })
})

describe('deleteSale: unit-coded products', () => {
  it('sold units go back in stock (where they left) without their bill link, and can be sold again', async () => {
    const p = await trackedProduct(app, { qty: 5 })
    const loc2 = app.db.run('INSERT INTO locations(uuid,name) VALUES (?,?)', app.uuid(), 'Godown').lastId
    await app.call('inventory', 'transferCreate', { fromLocationId: app.defaultLocationId(), toLocationId: loc2, items: [{ variantId: p.variantId, qty: 1, unitCodes: ['SPK-0005'] }] })
    const r = await cashSale(app, [{ variantId: p.variantId, qty: 3, unitCodes: ['SPK-0001', 'SPK-0002', 'SPK-0005'] }, { variantId: v18, qty: 1 }])
    expect(stockAt(app, p.variantId)).toBe(2)
    expect(stockAt(app, p.variantId, loc2)).toBe(0)

    const out = await call('deleteSale', { saleId: r.saleId, reason: 'test bill' })
    expect(out.stockRestored).toBe(4)
    expectGone(r.saleId)
    for (const c of ['SPK-0001', 'SPK-0002', 'SPK-0005']) expect(statusOf(app, c)).toBe('in_stock')
    expect(n('SELECT COUNT(*) FROM product_units WHERE sale_id IS NOT NULL OR sale_item_id IS NOT NULL')).toBe(0)
    expect(stockAt(app, p.variantId)).toBe(4)
    expect(stockAt(app, p.variantId, loc2)).toBe(1)
    expect(stock(v18)).toBe(50)
    await assertInvariant(app)
    expect(availCodes(app, p.variantId)).toEqual(['SPK-0001', 'SPK-0002', 'SPK-0003', 'SPK-0004', 'SPK-0005'])
    expect(JSON.parse(app.db.value<string>("SELECT old_json FROM audit_log WHERE entity='sale' AND action='delete'")!).items[0].unitCodes).toEqual(['SPK-0001', 'SPK-0002', 'SPK-0005'])

    // sellable again, by scan and on a bill
    expect(await call('scan', { code: 'SPK-0001' })).toMatchObject({ unit: { code: 'SPK-0001', status: 'in_stock', saleId: null } })
    const again = await cashSale(app, [{ variantId: p.variantId, qty: 2, unitCodes: ['SPK-0001', 'SPK-0005'] }])
    expect(statusOf(app, 'SPK-0001')).toBe('sold')
    expect((await call('getSale', { id: again.saleId })).items[0].unitCodes).toEqual(['SPK-0001', 'SPK-0005'])
    await assertInvariant(app)
  })

  it('returned units keep their status (restocked: in stock, written off: void); only the units still sold are restored', async () => {
    const p = await trackedProduct(app, { qty: 4 })
    const r = await cashSale(app, [{ variantId: p.variantId, qty: 4, unitCodes: ['SPK-0001', 'SPK-0002', 'SPK-0003', 'SPK-0004'] }])
    const item = (await call('getSale', { id: r.saleId })).items[0]
    await call('createReturn', { saleId: r.saleId, reason: 'back', items: [{ saleItemId: item.id, qty: 1, unitCodes: ['SPK-0001'], restock: true }] })
    await call('createReturn', { saleId: r.saleId, reason: 'broken', items: [{ saleItemId: item.id, qty: 1, unitCodes: ['SPK-0002'], restock: false }] })
    expect(stockAt(app, p.variantId)).toBe(1)

    const out = await call('deleteSale', { saleId: r.saleId, reason: 'duplicate bill' })
    expect(out.stockRestored).toBe(2)
    expectGone(r.saleId)
    expect(['SPK-0001', 'SPK-0002', 'SPK-0003', 'SPK-0004'].map((c) => statusOf(app, c))).toEqual(['in_stock', 'void', 'in_stock', 'in_stock'])
    expect(stockAt(app, p.variantId)).toBe(3)
    await assertInvariant(app)
  })

  it('a void unit-coded bill is deleted without touching stock or unit status', async () => {
    const p = await trackedProduct(app, { qty: 3 })
    const r = await cashSale(app, [{ variantId: p.variantId, qty: 2, unitCodes: ['SPK-0001', 'SPK-0002'] }])
    await call('voidSale', { saleId: r.saleId, reason: 'customer left' })
    // SPK-0001 is sold again on another bill before the void bill is deleted
    const other = await cashSale(app, [{ variantId: p.variantId, qty: 1, unitCodes: ['SPK-0001'] }])
    const moves = n('SELECT COUNT(*) FROM stock_movements')
    expect((await call('deleteSale', { saleId: r.saleId, reason: 'remove void bill' })).stockRestored).toBe(0)
    expectGone(r.saleId)
    expect(n('SELECT COUNT(*) FROM stock_movements')).toBe(moves)
    expect(statusOf(app, 'SPK-0001')).toBe('sold')
    expect(app.db.value('SELECT sale_id FROM product_units WHERE code = ?', 'SPK-0001')).toBe(other.saleId)
    expect(statusOf(app, 'SPK-0002')).toBe('in_stock')
    expect(stockAt(app, p.variantId)).toBe(2)
    await assertInvariant(app)
  })

  it('getSale tells which unit codes of a line are already back (so the return dialog only offers the ones still out)', async () => {
    const p = await trackedProduct(app, { qty: 3 })
    const r = await cashSale(app, [{ variantId: p.variantId, qty: 3, unitCodes: ['SPK-0001', 'SPK-0002', 'SPK-0003'] }])
    const item = (await call('getSale', { id: r.saleId })).items[0]
    expect(item.returnedUnitCodes).toEqual([])
    await call('createReturn', { saleId: r.saleId, reason: 'back', items: [{ saleItemId: item.id, qty: 1, unitCodes: ['SPK-0002'], restock: false }] })
    const after = (await call('getSale', { id: r.saleId })).items[0]
    expect(after.unitCodes).toEqual(['SPK-0001', 'SPK-0002', 'SPK-0003'])
    expect(after.returnedUnitCodes).toEqual(['SPK-0002'])
    expect(after.returnableQty).toBe(after.unitCodes.length - after.returnedUnitCodes.length)
  })
})

describe('deleteSale: permission and approval', () => {
  it('Owner and Manager hold pos.delete by default; a Cashier is refused', async () => {
    expect(PERMISSIONS['pos.delete']).toBeTruthy()
    expect(hasPermission(DEFAULT_ROLES.Manager, 'pos.delete')).toBe(true)
    expect(hasPermission(DEFAULT_ROLES.Owner, 'pos.delete')).toBe(true)
    expect(hasPermission(DEFAULT_ROLES.Cashier, 'pos.delete')).toBe(false)
    const r = await call('completeSale', { lines: [{ variantId: v18, qty: 1 }], payments: [{ method: 'cash', amount: 11800 }] })
    actAs(app, 'Cashier')
    await expect(call('deleteSale', { saleId: r.saleId, reason: 'mistake' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(n('SELECT COUNT(*) FROM sales')).toBe(1)
    expect(stock(v18)).toBe(49)
    expect(n('SELECT COUNT(*) FROM deleted_sales')).toBe(0)
    // a manager deletes without a second person (holds approvals.grant), like a void
    actAs(app, 'Manager')
    await call('deleteSale', { saleId: r.saleId, reason: 'mistake' })
    expect(n('SELECT COUNT(*) FROM sales')).toBe(0)
    expect(JSON.parse(app.db.value<string>("SELECT new_json FROM audit_log WHERE entity='sale' AND action='delete'")!).approvedBy).toBe(app.session!.userId)
  })

  it('pos.delete without approvals.grant needs a manager approval (credentials or an approval id for this bill)', async () => {
    const r1 = await call('completeSale', { lines: [{ variantId: v18, qty: 1 }], payments: [{ method: 'cash', amount: 11800 }] })
    const r2 = await call('completeSale', { lines: [{ variantId: v18, qty: 1 }], payments: [{ method: 'cash', amount: 11800 }] })
    const mgr = addManager()
    const bossId = app.db.value<number>("SELECT id FROM users WHERE username='boss'")!
    actAs(app, 'Cashier')
    app.session = { ...app.session!, permissions: ['pos.sell', 'pos.delete'] }
    await expect(call('deleteSale', { saleId: r1.saleId, reason: 'mistake' })).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' })
    await expect(call('deleteSale', { saleId: r1.saleId, reason: 'mistake', approval: { approverUsername: mgr.username, approverPassword: 'wrong' } })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(n('SELECT COUNT(*) FROM sales')).toBe(2)

    await call('deleteSale', { saleId: r1.saleId, reason: 'mistake', approval: { approverUsername: mgr.username, approverPassword: mgr.password } })
    expect(n('SELECT COUNT(*) FROM sales')).toBe(1)
    expect(n("SELECT COUNT(*) FROM approvals WHERE action='pos.delete' AND entity_id=? AND approved_by=?", String(r1.saleId), bossId)).toBe(1)
    expect(JSON.parse(app.db.value<string>("SELECT new_json FROM audit_log WHERE entity='sale' AND action='delete'")!).approvedBy).toBe(bossId)

    // an approval row granted for another action, or bound to another bill, is refused
    const voidAppr = app.db.run("INSERT INTO approvals(action,entity,entity_id,requested_by,approved_by,reason) VALUES ('pos.void','sale',?,?,?,'x')", String(r2.saleId), app.session!.userId, bossId).lastId
    await expect(call('deleteSale', { saleId: r2.saleId, reason: 'mistake', approval: { approvalId: voidAppr } })).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' })
    const otherBill = app.db.run("INSERT INTO approvals(action,entity,entity_id,requested_by,approved_by,reason) VALUES ('pos.delete','sale','424242',?,?,'x')", app.session!.userId, bossId).lastId
    await expect(call('deleteSale', { saleId: r2.saleId, reason: 'mistake', approval: { approvalId: otherBill } })).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' })
    const ok = app.db.run("INSERT INTO approvals(action,entity,entity_id,requested_by,approved_by,reason) VALUES ('pos.delete','sale',?,?,?,'x')", String(r2.saleId), app.session!.userId, bossId).lastId
    await call('deleteSale', { saleId: r2.saleId, reason: 'mistake', approval: { approvalId: ok } })
    expect(n('SELECT COUNT(*) FROM sales')).toBe(0)
    expect(stock(v18)).toBe(50)
  })

  it('migration 110 gives pos.delete to existing roles that can void (and to nobody else)', () => {
    const db = app.db
    db.run("INSERT INTO roles(name,permissions) VALUES ('Old supervisor', ?)", JSON.stringify(['pos.sell', 'pos.void', 'pos.return']))
    db.run("INSERT INTO roles(name,permissions) VALUES ('Old till', ?)", JSON.stringify(['pos.sell']))
    db.run("INSERT INTO roles(name,permissions) VALUES ('Broken', 'not json')")
    saleDelete.up!(db)
    const perms = (name: string) => db.value<string>('SELECT permissions FROM roles WHERE name = ?', name)!
    expect(JSON.parse(perms('Old supervisor'))).toEqual(['pos.sell', 'pos.void', 'pos.delete', 'pos.return'])
    expect(JSON.parse(perms('Old till'))).toEqual(['pos.sell'])
    expect(JSON.parse(perms('Owner'))).toEqual(['*'])
    expect(JSON.parse(perms('Manager')).filter((p: string) => p === 'pos.delete')).toHaveLength(1)
    expect(perms('Broken')).toBe('not json')
    // running the migrations again changes nothing
    expect(runMigrations(db)).toEqual([])
  })
})

describe('deleteSale: cash shifts', () => {
  it('shift summary and close still work after a bill of the shift is deleted, and no longer count it', async () => {
    await call('openShift', { openingCash: 100000 })
    const a = await call('completeSale', { lines: [{ variantId: v18, qty: 1 }], payments: [{ method: 'cash', amount: 11800 }] })
    const b = await call('completeSale', { lines: [{ variantId: v5, qty: 2 }], payments: [{ method: 'cash', amount: 21000 }] })
    const item = (await call('getSale', { id: b.saleId })).items[0]
    const ret = await call('createReturn', { saleId: b.saleId, items: [{ saleItemId: item.id, qty: 1 }], reason: 'x' })
    expect(await call('shiftSummary', {})).toMatchObject({ salesCount: 2, salesTotal: 32800, cashRefunds: ret.refundCash, expectedCash: 100000 + 32800 - ret.refundCash })

    await call('deleteSale', { saleId: b.saleId, reason: 'test bill' })
    expect(await call('shiftSummary', {})).toMatchObject({ salesCount: 1, salesTotal: 11800, returnsCount: 0, cashRefunds: 0, expectedCash: 111800 })
    expect((await dashboard()).openShift).toMatchObject({ bills: 1, cashSales: 11800 })
    const closed = await call('closeShift', { closingCash: 111800 })
    expect(closed).toMatchObject({ expectedCash: 111800, variance: 0 })
    // deleting a bill of the closed shift later does not break its summary either
    await call('deleteSale', { saleId: a.saleId, reason: 'test bill' })
    expect(await call('shiftSummary', { shiftId: closed.shift.id })).toMatchObject({ salesCount: 0, salesTotal: 0, expectedCash: 100000 })
  })
})

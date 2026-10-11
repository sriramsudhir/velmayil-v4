import { describe, it, expect, beforeEach } from 'vitest'
import { createTestApp, actAs } from '../helpers'
import type { App } from '../../src/main/core/app'
import { hashPassword } from '../../src/main/core/crypto'

let app: App
let v18: number // Rs 118.00 inclusive, 18%
let v5: number // Rs 105.00 inclusive, 5%
let vNoTrack: number

const call = <T = any>(method: string, args?: unknown) => app.call('pos', method, args) as Promise<T>
const stock = (v: number) => app.db.value<number>('SELECT COALESCE(SUM(qty),0) FROM stock_levels WHERE variant_id = ?', v)!
const n = (sql: string, ...p: any[]) => app.db.value<number>(sql, ...p)!

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

beforeEach(() => {
  app = createTestApp()
  v18 = product('Rocket', 11800, 1800, 50)
  v5 = product('Sparkler', 10500, 500, 20)
  vNoTrack = product('Service', 5000, 0, 0, 0)
})

describe('completeSale', () => {
  it('runs the whole flow: totals, stock, ledger, audit, sync, snapshots, numbering, profile pin', async () => {
    const r = await call('completeSale', {
      lines: [{ variantId: v18, qty: 2 }, { variantId: v5, qty: 1 }, { variantId: vNoTrack, qty: 1 }],
      payments: [{ method: 'cash', amount: 50000 }]
    })
    // 2*11800 + 10500 + 5000 = 39100
    expect(r.total).toBe(39100)
    expect(r.change).toBe(50000 - 39100)
    expect(r.invoiceNo).toMatch(/^INV-\d{4}-000001$/)
    expect(stock(v18)).toBe(48)
    expect(stock(v5)).toBe(19)
    expect(stock(vNoTrack)).toBe(0)
    expect(n("SELECT COUNT(*) FROM stock_movements WHERE type='sale' AND ref_type='sale' AND ref_id=?", String(r.saleId))).toBe(2)

    const sale = app.db.get<any>('SELECT * FROM sales WHERE id = ?', r.saleId)!
    expect(sale.profile_version_id).toBe(app.db.value('SELECT id FROM business_profile_versions WHERE is_active=1'))
    expect(sale.subtotal).toBe(39100)
    expect(sale.tax).toBe(1800 * 2 + 500 + 0)
    expect(sale.paid).toBe(50000)
    expect(sale.change_given).toBe(10900)
    // payments stored net of change => equals total
    expect(n('SELECT SUM(amount) FROM sale_payments WHERE sale_id = ?', r.saleId)).toBe(39100)
    const items = app.db.all<any>('SELECT * FROM sale_items WHERE sale_id = ? ORDER BY id', r.saleId)
    expect(items[0]).toMatchObject({ name: 'Rocket', sku: 'SKU-Rocket', hsn: '3604', qty: 2, cost: 5900, tax_rate_bp: 1800 })
    expect(app.db.value("SELECT COUNT(*) FROM audit_log WHERE entity='sale' AND action='create' AND entity_id=?", String(r.saleId))).toBe(1)
    const q = app.db.all<any>("SELECT * FROM sync_queue WHERE entity='sales'")
    expect(q).toHaveLength(1)
    const snap = JSON.parse(q[0].payload_json)
    expect(snap.children.sale_items).toHaveLength(3)
    expect(snap.children.sale_payments).toHaveLength(1)
    expect(snap.uuid).toBe(sale.uuid)

    const second = await call('completeSale', { lines: [{ variantId: v5, qty: 1 }], payments: [{ method: 'upi', amount: 10500 }] })
    expect(second.invoiceNo).toMatch(/000002$/)
  })

  it('server ignores client totals and rounds to the rupee', async () => {
    const r = await call('completeSale', {
      lines: [{ variantId: v18, qty: 1, lineDiscount: { type: 'amount', value: 1 } }],
      payments: [{ method: 'cash', amount: 20000 }],
      total: 1 // junk field ignored
    })
    // 11800 - 1 = 11799 -> rounded 11800, round_off +1
    expect(r.total).toBe(11800)
    expect(app.db.value('SELECT round_off FROM sales WHERE id=?', r.saleId)).toBe(1)
  })

  it('is atomic: insufficient stock on the 2nd line persists nothing', async () => {
    const seqBefore = n('SELECT COUNT(*) FROM invoice_sequences')
    await expect(
      call('completeSale', {
        lines: [{ variantId: v18, qty: 5 }, { variantId: v5, qty: 999 }],
        customer: { name: 'Walk In', phone: '9000000001' },
        payments: [{ method: 'cash', amount: 99999999 }]
      })
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' })
    expect(n('SELECT COUNT(*) FROM sales')).toBe(0)
    expect(n('SELECT COUNT(*) FROM sale_items')).toBe(0)
    expect(n('SELECT COUNT(*) FROM sale_payments')).toBe(0)
    expect(n('SELECT COUNT(*) FROM customers')).toBe(0)
    expect(stock(v18)).toBe(50)
    expect(n("SELECT COUNT(*) FROM stock_movements WHERE type='sale'")).toBe(0)
    expect(n("SELECT COUNT(*) FROM sync_queue WHERE entity IN ('sales','customers')")).toBe(0)
    expect(n("SELECT COUNT(*) FROM audit_log WHERE entity='sale'")).toBe(0)
    expect(n('SELECT COUNT(*) FROM invoice_sequences')).toBe(seqBefore) // number not burned
  })

  it('is atomic: a failure after stock moved (audit throws) rolls everything back', async () => {
    const orig = app.audit.bind(app)
    app.audit = ((e: any) => {
      if (e.entity === 'sale' && e.action === 'create') throw new Error('disk full')
      return orig(e)
    }) as typeof app.audit
    await expect(call('completeSale', { lines: [{ variantId: v18, qty: 3 }], payments: [{ method: 'cash', amount: 50000 }] })).rejects.toThrow('disk full')
    app.audit = orig
    expect(n('SELECT COUNT(*) FROM sales')).toBe(0)
    expect(stock(v18)).toBe(50)
    expect(n("SELECT COUNT(*) FROM stock_movements WHERE type='sale'")).toBe(0)
  })

  it('is idempotent on requestId (double click / retry)', async () => {
    const input = { requestId: 'req-12345678', lines: [{ variantId: v18, qty: 1 }], payments: [{ method: 'cash', amount: 11800 }] }
    const a = await call('completeSale', input)
    const b = await call('completeSale', input)
    expect(b).toMatchObject({ saleId: a.saleId, invoiceNo: a.invoiceNo, duplicate: true })
    expect(a.duplicate).toBe(false)
    expect(n('SELECT COUNT(*) FROM sales')).toBe(1)
    expect(stock(v18)).toBe(49)
  })

  it('mixed payments, change only from cash, short payment rejected', async () => {
    const ok = await call('completeSale', {
      lines: [{ variantId: v18, qty: 1 }],
      payments: [{ method: 'upi', amount: 5000 }, { method: 'card', amount: 3000 }, { method: 'cash', amount: 5000 }]
    })
    expect(ok.change).toBe(1200)
    const pays = app.db.all<any>('SELECT method, amount FROM sale_payments WHERE sale_id=? ORDER BY id', ok.saleId)
    expect(pays).toEqual([{ method: 'upi', amount: 5000 }, { method: 'card', amount: 3000 }, { method: 'cash', amount: 3800 }])

    await expect(call('completeSale', { lines: [{ variantId: v18, qty: 1 }], payments: [{ method: 'cash', amount: 100 }] })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call('completeSale', { lines: [{ variantId: v18, qty: 1 }], payments: [{ method: 'upi', amount: 20000 }] })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call('completeSale', { lines: [{ variantId: v18, qty: 1 }], payments: [{ method: 'credit', amount: 11800 }] })).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(n('SELECT COUNT(*) FROM sales')).toBe(1)
  })

  it('credit sale with inline new customer reuses an existing phone', async () => {
    const a = await call('completeSale', { lines: [{ variantId: v5, qty: 1 }], customer: { name: 'Ravi', phone: '98765 43210' }, payments: [{ method: 'credit', amount: 10500 }] })
    const b = await call('completeSale', { lines: [{ variantId: v5, qty: 1 }], customer: { name: 'Ravi K', phone: '9876543210' }, payments: [{ method: 'credit', amount: 10500 }] })
    expect(n('SELECT COUNT(*) FROM customers')).toBe(1)
    const sa = await call('getSale', { id: a.saleId })
    const sb = await call('getSale', { invoiceNo: b.invoiceNo })
    expect(sa.customerId).toBe(sb.customerId)
    expect(sa.customerName).toBe('Ravi')
    const found = await call('findCustomerByPhone', { phone: '9876543210' })
    expect(found.name).toBe('Ravi')
    expect((await call('listCustomers', { search: 'Rav' })).total).toBe(1)
    expect(n("SELECT COUNT(*) FROM sync_queue WHERE entity='customers'")).toBe(1)
  })

  it('validates input', async () => {
    await expect(call('completeSale', { lines: [], payments: [] })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call('completeSale', { lines: [{ variantId: v18, qty: 0 }] })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call('completeSale', { lines: [{ variantId: 99999, qty: 1 }], payments: [] })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    app.db.run('UPDATE product_variants SET active = 0 WHERE id = ?', v18)
    await expect(call('completeSale', { lines: [{ variantId: v18, qty: 1 }], payments: [{ method: 'cash', amount: 99999 }] })).rejects.toMatchObject({ code: 'VALIDATION' })
  })

  it('terminal suffix keeps invoice numbers unique across terminals', async () => {
    app.db.run("UPDATE pos_terminals SET code='POS-02' WHERE is_local=1")
    const r = await call('completeSale', { lines: [{ variantId: v5, qty: 1 }], payments: [{ method: 'cash', amount: 10500 }] })
    expect(r.invoiceNo).toMatch(/^INV-02-\d{4}-000001$/)
  })

  it('scan and search', async () => {
    expect((await call('scan', { code: 'BC-Rocket' })).variantId).toBe(v18)
    await expect(call('scan', { code: 'nope' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect((await call('search', { text: 'spark' }))[0].variantId).toBe(v5)
    const priced = await call('cartPrice', { lines: [{ variantId: v18, qty: 100 }] })
    expect(priced.lines[0].stockWarning).toBe(true)
    expect(priced.totals.total).toBe(1180000)
  })

  it('allow-negative setting lets stock go below zero', async () => {
    app.setSetting('inventory.allow_negative', '1')
    await call('completeSale', { lines: [{ variantId: v5, qty: 25 }], payments: [{ method: 'cash', amount: 262500 }] })
    expect(stock(v5)).toBe(-5)
  })

  it('exclusive tax mode', async () => {
    app.setSetting('pos.prices_include_tax', '0')
    const r = await call('completeSale', { lines: [{ variantId: v18, qty: 1 }], payments: [{ method: 'cash', amount: 13924 }] })
    expect(r.total).toBe(13900) // 11800 + 2124 = 13924, rounded to the rupee
    expect(app.db.value('SELECT tax FROM sales WHERE id=?', r.saleId)).toBe(2124)
    expect(app.db.value('SELECT prices_include_tax FROM sales WHERE id=?', r.saleId)).toBe(0)
  })
})

describe('permissions and approvals', () => {
  it('requires pos.sell', async () => {
    app.session = { ...app.session!, permissions: ['pos.hold'] }
    await expect(call('completeSale', { lines: [{ variantId: v18, qty: 1 }], payments: [] })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(call('scan', { code: 'BC-Rocket' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('cashier: discount within limit ok, above limit needs approval, price override forbidden', async () => {
    actAs(app, 'Cashier')
    // 10% limit
    const ok = await call('completeSale', { lines: [{ variantId: v18, qty: 1, lineDiscount: { type: 'percent', value: 1000 } }], payments: [{ method: 'cash', amount: 11800 }] })
    expect(ok.total).toBe(10600)
    await expect(
      call('completeSale', { lines: [{ variantId: v18, qty: 1 }], billDiscount: { type: 'percent', value: 2000 }, payments: [{ method: 'cash', amount: 11800 }] })
    ).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' })
    await expect(
      call('completeSale', { lines: [{ variantId: v18, qty: 1, unitPriceOverride: 100 }], payments: [{ method: 'cash', amount: 11800 }] })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(n('SELECT COUNT(*) FROM sales')).toBe(1)
  })

  it('approval by manager credentials is validated and recorded; bad credentials rejected', async () => {
    const mgr = addManager()
    actAs(app, 'Cashier')
    const input = { lines: [{ variantId: v18, qty: 1 }], billDiscount: { type: 'percent', value: 2000 }, payments: [{ method: 'cash', amount: 11800 }] }
    await expect(call('completeSale', { ...input, approval: { approverUsername: mgr.username, approverPassword: 'wrong' } })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    // a cashier can't approve
    app.db.run("INSERT INTO users(uuid,username,name,role_id,password_hash) VALUES (?,?,?,(SELECT id FROM roles WHERE name='Cashier'),?)", app.uuid(), 'c2', 'C2', hashPassword('pw'))
    await expect(call('completeSale', { ...input, approval: { approverUsername: 'c2', approverPassword: 'pw' } })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(n('SELECT COUNT(*) FROM sales')).toBe(0)
    expect(n('SELECT COUNT(*) FROM approvals')).toBe(0)

    const r = await call('completeSale', { ...input, approval: { approverUsername: mgr.username, approverPassword: mgr.password } })
    expect(r.total).toBe(9400)
    const ap = app.db.get<any>('SELECT * FROM approvals')!
    expect(ap).toMatchObject({ action: 'pos.discount', entity: 'sale', entity_id: String(r.saleId) })
    expect(app.db.value('SELECT approved_by FROM sales WHERE id=?', r.saleId)).toBe(ap.approved_by)
  })

  it('manager (unlimited discount + price override) needs no approval and price override is audited', async () => {
    actAs(app, 'Manager')
    const r = await call('completeSale', { lines: [{ variantId: v18, qty: 1, unitPriceOverride: 9000, lineDiscount: { type: 'percent', value: 5000 } }], payments: [{ method: 'cash', amount: 4500 }] })
    expect(r.total).toBe(4500)
    expect(app.db.value('SELECT price_overridden FROM sale_items WHERE sale_id=?', r.saleId)).toBe(1)
    expect(n("SELECT COUNT(*) FROM audit_log WHERE action='price_override'")).toBe(1)
  })

  it('cashier without pos.discount cannot discount at all', async () => {
    actAs(app, 'Cashier')
    app.session = { ...app.session!, permissions: ['pos.sell'] }
    await expect(call('completeSale', { lines: [{ variantId: v18, qty: 1, lineDiscount: { type: 'amount', value: 1 } }], payments: [{ method: 'cash', amount: 11800 }] })).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})

describe('returns', () => {
  async function sell(qty = 3) {
    const r = await call('completeSale', { lines: [{ variantId: v18, qty }, { variantId: v5, qty: 1 }], payments: [{ method: 'cash', amount: 100000 }] })
    const sale = await call('getSale', { id: r.saleId })
    return { r, sale, a: sale.items[0], b: sale.items[1] }
  }

  it('partial returns respect sold-minus-returned, restock, reverse tax proportionally', async () => {
    const { r, a } = await sell(3)
    expect(stock(v18)).toBe(47)
    const ret = await call('createReturn', { saleId: r.saleId, items: [{ saleItemId: a.id, qty: 1 }], reason: 'damaged', refundMethod: 'cash' })
    expect(ret.returnNo).toMatch(/^RET-\d{4}-000001$/)
    expect(ret.total).toBe(11800)
    expect(stock(v18)).toBe(48)
    const row = app.db.get<any>('SELECT * FROM sale_returns WHERE id=?', ret.returnId)!
    expect(row).toMatchObject({ tax: 1800, subtotal: 10000, total: 11800, refund_cash: 11800 })
    expect(row.profile_version_id).toBe(app.db.value('SELECT profile_version_id FROM sales WHERE id=?', r.saleId))
    expect(n("SELECT COUNT(*) FROM stock_movements WHERE type='sale_return'")).toBe(1)
    expect(n("SELECT COUNT(*) FROM audit_log WHERE entity='sale_return'")).toBe(1)
    expect(n("SELECT COUNT(*) FROM sync_queue WHERE entity='sale_returns'")).toBe(1)

    await expect(call('createReturn', { saleId: r.saleId, items: [{ saleItemId: a.id, qty: 3 }], reason: 'x' })).rejects.toMatchObject({ code: 'VALIDATION' })
    const ret2 = await call('createReturn', { saleId: r.saleId, items: [{ saleItemId: a.id, qty: 2, restock: false }], reason: 'defective' })
    expect(ret2.returnNo).toMatch(/000002$/)
    expect(stock(v18)).toBe(48) // not restocked
    expect(app.db.value('SELECT restock FROM sale_return_items WHERE return_id=?', ret2.returnId)).toBe(0)
    await expect(call('createReturn', { saleId: r.saleId, items: [{ saleItemId: a.id, qty: 1 }], reason: 'x' })).rejects.toMatchObject({ code: 'VALIDATION' })
    const doc = await call('getSale', { id: r.saleId })
    expect(doc.items[0].returnableQty).toBe(0)
    expect(doc.returns).toHaveLength(2)
    // the line total was fully refunded to the paise
    expect(n('SELECT SUM(line_total) FROM sale_return_items WHERE sale_item_id=?', a.id)).toBe(a.lineTotal)
  })

  it('full return also refunds round-off so the customer gets back what was paid', async () => {
    const r = await call('completeSale', { lines: [{ variantId: v18, qty: 1, lineDiscount: { type: 'amount', value: 1 } }], payments: [{ method: 'cash', amount: 11800 }] })
    const sale = await call('getSale', { id: r.saleId })
    const ret = await call('createReturn', { saleId: r.saleId, items: [{ saleItemId: sale.items[0].id, qty: 1 }], reason: 'changed mind' })
    expect(ret.total).toBe(11800)
  })

  it('refund to original method splits cash share; idempotent requestId; guards', async () => {
    const r = await call('completeSale', {
      lines: [{ variantId: v18, qty: 1 }],
      payments: [{ method: 'cash', amount: 5900 }, { method: 'upi', amount: 5900 }]
    })
    const sale = await call('getSale', { id: r.saleId })
    const input = { requestId: 'ret-req-0001', saleId: r.saleId, items: [{ saleItemId: sale.items[0].id, qty: 1 }], reason: 'x', refundMethod: 'original' }
    const ret = await call('createReturn', input)
    expect(ret.refundCash).toBe(5900)
    const again = await call('createReturn', input)
    expect(again.duplicate).toBe(true)
    expect(n('SELECT COUNT(*) FROM sale_returns')).toBe(1)
    await expect(call('createReturn', { saleId: 9999, items: [{ saleItemId: 1, qty: 1 }], reason: 'x' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('rejects foreign lines, duplicate lines and cashiers; non-tracked items never move stock', async () => {
    const { r, a, b } = await sell(1)
    const other = await call('completeSale', { lines: [{ variantId: v5, qty: 1 }, { variantId: vNoTrack, qty: 1 }], payments: [{ method: 'cash', amount: 99999 }] })
    const o = await call('getSale', { id: other.saleId })
    await expect(call('createReturn', { saleId: r.saleId, items: [{ saleItemId: o.items[0].id, qty: 1 }], reason: 'x' })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call('createReturn', { saleId: r.saleId, items: [{ saleItemId: a.id, qty: 1 }, { saleItemId: a.id, qty: 1 }], reason: 'x' })).rejects.toMatchObject({ code: 'VALIDATION' })
    await call('createReturn', { saleId: other.saleId, items: [{ saleItemId: o.items[1].id, qty: 1 }], reason: 'x' })
    expect(n("SELECT COUNT(*) FROM stock_movements WHERE type='sale_return'")).toBe(0)
    void b
    actAs(app, 'Cashier')
    await expect(call('createReturn', { saleId: r.saleId, items: [{ saleItemId: a.id, qty: 1 }], reason: 'x' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})

describe('void', () => {
  it('restocks, audits, syncs, blocks double void and needs permission/approval', async () => {
    const r = await call('completeSale', { lines: [{ variantId: v18, qty: 4 }], payments: [{ method: 'cash', amount: 47200 }] })
    expect(stock(v18)).toBe(46)
    actAs(app, 'Cashier')
    await expect(call('voidSale', { saleId: r.saleId, reason: 'mistake' })).rejects.toMatchObject({ code: 'FORBIDDEN' })

    // user with pos.void but no approvals.grant must bring approval
    app.session = { ...app.session!, permissions: ['pos.void', 'pos.sell'] }
    await expect(call('voidSale', { saleId: r.saleId, reason: 'mistake' })).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' })
    const mgr = addManager()
    await call('voidSale', { saleId: r.saleId, reason: 'mistake', approval: { approverUsername: mgr.username, approverPassword: mgr.password } })
    expect(stock(v18)).toBe(50)
    expect(app.db.get<any>('SELECT status, void_reason FROM sales WHERE id=?', r.saleId)).toEqual({ status: 'void', void_reason: 'mistake' })
    expect(n("SELECT COUNT(*) FROM stock_movements WHERE type='void'")).toBe(1)
    expect(n("SELECT COUNT(*) FROM audit_log WHERE action='void' AND entity='sale'")).toBe(1)
    expect(n("SELECT COUNT(*) FROM sync_queue WHERE entity='sales'")).toBe(2)
    expect(n("SELECT COUNT(*) FROM approvals WHERE action='pos.void' AND entity_id=?", String(r.saleId))).toBe(1)
    await expect(call('voidSale', { saleId: r.saleId, reason: 'again', approval: { approverUsername: mgr.username, approverPassword: mgr.password } })).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(call('createReturn', { saleId: r.saleId, items: [{ saleItemId: 1, qty: 1 }], reason: 'x' })).rejects.toThrow()
  })

  it('manager voids without extra approval; reason is mandatory; sales with returns cannot be voided', async () => {
    const r = await call('completeSale', { lines: [{ variantId: v18, qty: 2 }], payments: [{ method: 'cash', amount: 23600 }] })
    await expect(call('voidSale', { saleId: r.saleId, reason: '' })).rejects.toMatchObject({ code: 'VALIDATION' })
    const sale = await call('getSale', { id: r.saleId })
    await call('createReturn', { saleId: r.saleId, items: [{ saleItemId: sale.items[0].id, qty: 1 }], reason: 'x' })
    await expect(call('voidSale', { saleId: r.saleId, reason: 'oops' })).rejects.toMatchObject({ code: 'CONFLICT' })
    const r2 = await call('completeSale', { lines: [{ variantId: v18, qty: 1 }], payments: [{ method: 'cash', amount: 11800 }] })
    await call('voidSale', { saleId: r2.saleId, reason: 'oops' })
    expect((await call('listSales', { status: 'void' })).total).toBe(1)
  })
})

describe('shifts', () => {
  it('computes expected cash (opening + cash sales - cash refunds) and variance', async () => {
    const sh = await call('openShift', { openingCash: 100000 })
    await expect(call('openShift', { openingCash: 1 })).rejects.toMatchObject({ code: 'CONFLICT' })
    const s1 = await call('completeSale', { lines: [{ variantId: v18, qty: 2 }], payments: [{ method: 'cash', amount: 30000 }] }) // 23600 cash
    await call('completeSale', { lines: [{ variantId: v5, qty: 1 }], payments: [{ method: 'upi', amount: 10500 }] }) // not cash
    const s3 = await call('completeSale', { lines: [{ variantId: v5, qty: 2 }], payments: [{ method: 'cash', amount: 21000 }] }) // 21000 cash, voided below
    await call('voidSale', { saleId: s3.saleId, reason: 'cancelled' })
    const sale = await call('getSale', { id: s1.saleId })
    await call('createReturn', { saleId: s1.saleId, items: [{ saleItemId: sale.items[0].id, qty: 1 }], reason: 'x' }) // -11800
    expect(app.db.value('SELECT shift_id FROM sales WHERE id=?', s1.saleId)).toBe(sh.id)

    const sum = await call('shiftSummary', {})
    expect(sum.cashSales).toBe(23600)
    expect(sum.cashRefunds).toBe(11800)
    expect(sum.expectedCash).toBe(100000 + 23600 - 11800)
    expect(sum.byMethod.find((m: any) => m.method === 'upi').amount).toBe(10500)
    expect(sum.salesCount).toBe(2)

    const closed = await call('closeShift', { closingCash: 111000, note: 'short 200' })
    expect(closed.expectedCash).toBe(111800)
    expect(closed.variance).toBe(-800)
    await expect(call('closeShift', { shiftId: sh.id, closingCash: 0 })).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(await call('getCurrentShift', {})).toBeNull()
    expect(n("SELECT COUNT(*) FROM audit_log WHERE entity='shift'")).toBe(2)
  })

  it('require_shift setting blocks billing without a shift', async () => {
    app.setSetting('pos.require_shift', '1')
    await expect(call('completeSale', { lines: [{ variantId: v5, qty: 1 }], payments: [{ method: 'cash', amount: 10500 }] })).rejects.toMatchObject({ code: 'CONFLICT' })
    await call('openShift', { openingCash: 0 })
    await call('completeSale', { lines: [{ variantId: v5, qty: 1 }], payments: [{ method: 'cash', amount: 10500 }] })
  })

  it('cashier needs pos.shift', async () => {
    actAs(app, 'Cashier')
    app.session = { ...app.session!, permissions: ['pos.sell'] }
    await expect(call('openShift', {})).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})

describe('hold / resume, lookup', () => {
  it('holds, lists, resumes (removing) and discards carts', async () => {
    const cart = { lines: [{ variantId: v18, qty: 2 }], customer: { name: 'A' } }
    const h = await call('holdCart', { label: 'table 4', cart })
    const h2 = await call('holdCart', { label: 'x', cart })
    const list = await call('listHeld')
    expect(list).toHaveLength(2)
    expect(list.find((x: any) => x.id === h.id)).toMatchObject({ label: 'table 4', lineCount: 1, customerName: 'A' })
    expect((await call('resumeHeld', { id: h.id })).cart).toEqual(cart)
    await expect(call('resumeHeld', { id: h.id })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await call('discardHeld', { id: h2.id })
    expect(await call('listHeld')).toHaveLength(0)
  })

  it('lists sales with filters and builds the full document', async () => {
    const a = await call('completeSale', { lines: [{ variantId: v18, qty: 1 }], customer: { name: 'Meena', phone: '9111111111' }, payments: [{ method: 'cash', amount: 11800 }] })
    await call('completeSale', { lines: [{ variantId: v5, qty: 1 }], payments: [{ method: 'cash', amount: 10500 }] })
    expect((await call('listSales', {})).total).toBe(2)
    expect((await call('listSales', { search: 'Meena' })).rows[0].invoiceNo).toBe(a.invoiceNo)
    expect((await call('listSales', { search: a.invoiceNo })).total).toBe(1)
    expect((await call('listSales', { from: Date.now() + 100000 })).total).toBe(0)
    const doc = await call('getSale', { invoiceNo: a.invoiceNo.toLowerCase() })
    expect(doc).toMatchObject({ invoiceNo: a.invoiceNo, customerName: 'Meena', cashierName: 'Admin', posName: 'Counter 1' })
    expect(doc.items).toHaveLength(1)
    expect(doc.payments).toHaveLength(1)
    await expect(call('getSale', { id: 12345 })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

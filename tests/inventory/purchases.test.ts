import { describe, expect, it } from 'vitest'
import { actAs } from '../helpers'
import { costOf, makeLocation, makeSupplier, makeVariant, newApp, qtyAt, rejects } from './fixtures'

describe('purchases', () => {
  it('receives stock, computes paise totals, updates cost (last-cost default), audits and syncs', async () => {
    const app = newApp()
    const sup = makeSupplier(app)
    const v = makeVariant(app, { qty: 10, cost: 1000, taxBp: 1800 })
    const w = makeVariant(app, { cost: 500, taxBp: 500 })
    const r: any = await app.call('purchases', 'create', {
      supplierId: sup, supplierInvoiceNo: 'INV-77', paid: 1000,
      items: [{ variantId: v, qty: 5, unitCost: 1200, taxRateBp: 1800 }, { variantId: w, qty: 3, unitCost: 333 }]
    })
    expect(r.number).toMatch(/^PUR-\d{4}-\d{6}$/)
    expect(r.subtotal).toBe(5 * 1200 + 3 * 333) // 6999
    expect(r.tax).toBe(1080 + 50) // 18% of 6000 + 5% of 999 (49.95 -> 50)
    expect(r.total).toBe(r.subtotal + r.tax)
    expect(qtyAt(app, v)).toBe(15)
    expect(qtyAt(app, w)).toBe(3)
    expect(costOf(app, v)).toBe(1200)
    expect(costOf(app, w)).toBe(333)
    const mv = app.db.get<any>("SELECT unit_cost, ref_type FROM stock_movements WHERE type='purchase' AND variant_id=?", v)
    expect(mv).toMatchObject({ unit_cost: 1200, ref_type: 'purchase' })
    expect(app.db.value<number>("SELECT COUNT(*) FROM audit_log WHERE action='cost_change'")).toBe(2)
    expect(app.db.value<number>("SELECT COUNT(*) FROM audit_log WHERE entity='purchase' AND action='create'")).toBe(1)
    const snap = JSON.parse(app.db.value<string>("SELECT payload_json FROM sync_queue WHERE entity='purchases'")!)
    expect(snap.children.purchase_items).toHaveLength(2)
    expect(snap.children.purchase_payments).toHaveLength(1)
    const g: any = await app.call('purchases', 'get', { id: r.id })
    expect(g.due).toBe(r.total - 1000)
    expect(g.items).toHaveLength(2)
  })

  it('weighted-average cost method', async () => {
    const app = newApp()
    app.setSetting('inventory.cost_method', 'weighted')
    const v = makeVariant(app, { qty: 10, cost: 1000 })
    await app.call('purchases', 'create', { items: [{ variantId: v, qty: 10, unitCost: 2000, taxRateBp: 0 }] })
    expect(costOf(app, v)).toBe(1500)
    await app.call('purchases', 'create', { items: [{ variantId: v, qty: 20, unitCost: 900, taxRateBp: 0 }] })
    expect(costOf(app, v)).toBe(Math.round((20 * 1500 + 20 * 900) / 40)) // 1200
    // no existing stock -> cost becomes the purchase cost
    const z = makeVariant(app, { cost: 100 })
    await app.call('purchases', 'create', { items: [{ variantId: z, qty: 4, unitCost: 700 }] })
    expect(costOf(app, z)).toBe(700)
  })

  it('is atomic: a failing line rolls back stock, cost, number and rows', async () => {
    const app = newApp()
    const v = makeVariant(app, { qty: 1, cost: 1000 })
    await rejects(
      app.call('purchases', 'create', { items: [{ variantId: v, qty: 5, unitCost: 2000 }, { variantId: 999999, qty: 1, unitCost: 1 }] }),
      'NOT_FOUND'
    )
    expect(qtyAt(app, v)).toBe(1)
    expect(costOf(app, v)).toBe(1000)
    expect(app.db.value<number>('SELECT COUNT(*) FROM purchases')).toBe(0)
    expect(app.db.value<number>('SELECT COUNT(*) FROM purchase_items')).toBe(0)
    expect(app.db.value<number>('SELECT COUNT(*) FROM invoice_sequences')).toBe(0)
    expect(app.db.value<number>("SELECT COUNT(*) FROM stock_movements WHERE type='purchase'")).toBe(0)
  })

  it('validates input: empty lines, overpayment, duplicate supplier invoice, inactive supplier', async () => {
    const app = newApp()
    const sup = makeSupplier(app)
    const v = makeVariant(app)
    await rejects(app.call('purchases', 'create', { items: [] }), 'VALIDATION')
    await rejects(app.call('purchases', 'create', { items: [{ variantId: v, qty: 0, unitCost: 1 }] }), 'VALIDATION')
    await rejects(app.call('purchases', 'create', { items: [{ variantId: v, qty: 1, unitCost: 100.5 }] }), 'VALIDATION')
    await rejects(app.call('purchases', 'create', { items: [{ variantId: v, qty: 1, unitCost: 100, taxRateBp: 0 }], paid: 101 }), 'VALIDATION')
    await app.call('purchases', 'create', { supplierId: sup, supplierInvoiceNo: 'A1', items: [{ variantId: v, qty: 1, unitCost: 100 }] })
    await rejects(app.call('purchases', 'create', { supplierId: sup, supplierInvoiceNo: 'A1', items: [{ variantId: v, qty: 1, unitCost: 100 }] }), 'CONFLICT')
    await app.call('purchases', 'supplierSetActive', { id: sup, active: false })
    await rejects(app.call('purchases', 'create', { supplierId: sup, items: [{ variantId: v, qty: 1, unitCost: 100 }] }), 'VALIDATION')
  })

  it('records later payments and caps them at the amount due', async () => {
    const app = newApp()
    const v = makeVariant(app)
    const r: any = await app.call('purchases', 'create', { items: [{ variantId: v, qty: 2, unitCost: 1000, taxRateBp: 0 }] })
    await app.call('purchases', 'recordPayment', { purchaseId: r.id, amount: 500 })
    await app.call('purchases', 'recordPayment', { purchaseId: r.id, amount: 1500 })
    await rejects(app.call('purchases', 'recordPayment', { purchaseId: r.id, amount: 1 }), 'VALIDATION')
    expect(((await app.call('purchases', 'get', { id: r.id })) as any).due).toBe(0)
  })

  it('cancel reverses stock when still available, otherwise errors and changes nothing', async () => {
    const app = newApp()
    const v = makeVariant(app, { qty: 0, cost: 100 })
    const p1: any = await app.call('purchases', 'create', { items: [{ variantId: v, qty: 10, unitCost: 100 }] })
    await app.call('purchases', 'cancel', { id: p1.id, reason: 'entered twice' })
    expect(qtyAt(app, v)).toBe(0)
    expect(((await app.call('purchases', 'get', { id: p1.id })) as any).status).toBe('cancelled')
    await rejects(app.call('purchases', 'cancel', { id: p1.id, reason: 'again' }), 'CONFLICT')
    await rejects(app.call('purchases', 'cancel', { id: p1.id, reason: '' }), 'VALIDATION')

    const p2: any = await app.call('purchases', 'create', { items: [{ variantId: v, qty: 10, unitCost: 100 }] })
    app.moveStock({ variantId: v, delta: -4, type: 'sale' }) // part of it was sold
    await rejects(app.call('purchases', 'cancel', { id: p2.id, reason: 'oops' }), 'INSUFFICIENT_STOCK')
    expect(qtyAt(app, v)).toBe(6)
    expect(((await app.call('purchases', 'get', { id: p2.id })) as any).status).toBe('received')
    expect(app.db.value<number>("SELECT COUNT(*) FROM audit_log WHERE entity='purchase' AND action='cancel'")).toBe(1)
  })

  it('goes to the chosen location', async () => {
    const app = newApp()
    const loc = makeLocation(app, 'Godown')
    const v = makeVariant(app)
    await app.call('purchases', 'create', { locationId: loc, items: [{ variantId: v, qty: 6, unitCost: 10 }] })
    expect(qtyAt(app, v, loc)).toBe(6)
    expect(qtyAt(app, v)).toBe(0)
  })

  it('denies users without purchases.edit / purchases.view', async () => {
    const app = newApp()
    const v = makeVariant(app)
    actAs(app, 'Cashier')
    await rejects(app.call('purchases', 'create', { items: [{ variantId: v, qty: 1, unitCost: 1 }] }), 'FORBIDDEN')
    await rejects(app.call('purchases', 'list', {}), 'FORBIDDEN')
    await rejects(app.call('purchases', 'supplierSave', { name: 'X' }), 'FORBIDDEN')
    actAs(app, 'Manager')
    await app.call('purchases', 'supplierSave', { name: 'X' })
  })
})

describe('suppliers, returns and payables', () => {
  it('supplier CRUD with deactivate instead of delete', async () => {
    const app = newApp()
    const s: any = await app.call('purchases', 'supplierSave', { name: 'Sivakasi Traders', phone: '999', gstin: '33abcde1234f1z5' })
    await rejects(app.call('purchases', 'supplierSave', { name: 'sivakasi traders' }), 'CONFLICT')
    await rejects(app.call('purchases', 'supplierSave', { name: 'Bad', gstin: '123' }), 'VALIDATION')
    await app.call('purchases', 'supplierSave', { id: s.id, name: 'Sivakasi Traders Ltd', phone: '888' })
    const g: any = await app.call('purchases', 'supplierGet', { id: s.id })
    expect(g).toMatchObject({ name: 'Sivakasi Traders Ltd', phone: '888', gstin: '', active: 1 })
    await app.call('purchases', 'supplierSetActive', { id: s.id, active: false })
    expect(((await app.call('purchases', 'supplierList', {})) as any).total).toBe(0)
    expect(((await app.call('purchases', 'supplierList', { includeInactive: true })) as any).total).toBe(1)
    expect(app.db.value<number>('SELECT COUNT(*) FROM suppliers')).toBe(1)
    expect(app.db.value<number>("SELECT COUNT(*) FROM sync_queue WHERE entity='suppliers'")).toBe(3)
    expect(app.db.value<number>("SELECT COUNT(*) FROM audit_log WHERE entity='supplier'")).toBe(3)
  })

  it('supplier return cannot exceed on-hand, moves stock, and reduces payables', async () => {
    const app = newApp()
    const sup = makeSupplier(app)
    const v = makeVariant(app, { qty: 0, cost: 100 })
    const p: any = await app.call('purchases', 'create', { supplierId: sup, paid: 500, items: [{ variantId: v, qty: 10, unitCost: 100, taxRateBp: 0 }] })
    expect(p.total).toBe(1000)
    await rejects(app.call('purchases', 'returnCreate', { supplierId: sup, items: [{ variantId: v, qty: 11 }] }), 'INSUFFICIENT_STOCK')
    expect(qtyAt(app, v)).toBe(10)
    const r: any = await app.call('purchases', 'returnCreate', { supplierId: sup, items: [{ variantId: v, qty: 3 }] })
    expect(r.number).toMatch(/^SRT-\d{4}-\d{6}$/)
    expect(r.total).toBe(300)
    expect(qtyAt(app, v)).toBe(7)
    expect(app.db.value<number>("SELECT COUNT(*) FROM stock_movements WHERE type='supplier_return'")).toBe(1)
    const snap = JSON.parse(app.db.value<string>("SELECT payload_json FROM sync_queue WHERE entity='supplier_returns'")!)
    expect(snap.children.supplier_return_items).toHaveLength(1)

    const pay: any = await app.call('purchases', 'payables', {})
    expect(pay.rows[0]).toMatchObject({ purchased: 1000, returned: 300, paid: 500, balance: 200 })
    expect(pay.totalPayable).toBe(200)
    expect(((await app.call('purchases', 'supplierGet', { id: sup })) as any).balance).toBe(200)
    expect(((await app.call('purchases', 'returnGet', { id: r.id })) as any).items).toHaveLength(1)
    // cancelled purchases drop out of payables
    await rejects(app.call('purchases', 'cancel', { id: p.id, reason: 'x' }), 'INSUFFICIENT_STOCK')
  })

  it('returning everything from a GST purchase clears the payable (the credit carries GST like the purchase did)', async () => {
    const app = newApp()
    const sup = makeSupplier(app)
    const v = makeVariant(app, { qty: 0, cost: 1000, taxBp: 500 }) // product says 5 %, the supplier billed 18 %
    const p: any = await app.call('purchases', 'create', { supplierId: sup, items: [{ variantId: v, qty: 10, unitCost: 1000, taxRateBp: 1800 }] })
    expect(p.total).toBe(11800)
    const r: any = await app.call('purchases', 'returnCreate', { supplierId: sup, items: [{ variantId: v, qty: 10 }] })
    expect(r).toMatchObject({ total: 11800, tax: 1800 }) // rate of the supplier's last purchase of this product, not the product default
    expect(((await app.call('purchases', 'payables', { supplierId: sup })) as any).rows[0]).toMatchObject({ purchased: 11800, returned: 11800, balance: 0 })
    // unit cost on the line stays ex-GST (stock ledger / valuation use it)
    expect(app.db.get<any>('SELECT qty, unit_cost FROM supplier_return_items WHERE return_id=?', r.id)).toEqual({ qty: 10, unit_cost: 1000 })
  })

  it('supplier return: explicit GST rate wins; without purchase history the product rate is used', async () => {
    const app = newApp()
    const sup = makeSupplier(app)
    const v = makeVariant(app, { qty: 10, cost: 200, taxBp: 1200 })
    const a: any = await app.call('purchases', 'returnCreate', { supplierId: sup, items: [{ variantId: v, qty: 1 }] })
    expect(a).toMatchObject({ total: 224, tax: 24 })
    const b: any = await app.call('purchases', 'returnCreate', { supplierId: sup, items: [{ variantId: v, qty: 2, unitCost: 150, taxRateBp: 0 }] })
    expect(b).toMatchObject({ total: 300, tax: 0 })
  })

  it('paying more than is due is refused with the amount in rupees (not raw paise)', async () => {
    const app = newApp()
    const sup = makeSupplier(app)
    const v = makeVariant(app, { cost: 100 })
    const p: any = await app.call('purchases', 'create', { supplierId: sup, paid: 50000, items: [{ variantId: v, qty: 1000, unitCost: 150, taxRateBp: 0 }] })
    expect(p.total).toBe(150000)
    const e: any = await app.call('purchases', 'recordPayment', { purchaseId: p.id, amount: 100001 }).catch((x) => x)
    expect(e.code).toBe('VALIDATION')
    expect(e.message).toBe('Payment exceeds the amount due (\u20b91,000.00)')
    expect(await app.call('purchases', 'recordPayment', { purchaseId: p.id, amount: 100000 })).toEqual({ paid: 150000, due: 0 })
  })
})

import { beforeAll, describe, expect, it } from 'vitest'
import type { App } from '../../src/main/core/app'
import type { ReportResult, ReportRow } from '../../src/shared/reports'
import { local } from './fixture'
import { buildMini, NOW, RANGE, reportsApp, run, type Mini } from './setup'

/**
 * Hand-computed scenario (tax-inclusive prices, paise). Range 2026-04-10..2026-04-11.
 *  completed: INV-1 23600 (tax 3600, cash 23600 net of 1400 change (tendered 25000)) | INV-2 32800 (tax 3752, disc 1000, upi 20000 + card 12800)
 *             INV-3 43600 (tax 5125, round-off +1, credit 20000 + cash 23600) | INV-4 11800 (tax 1800, cash)
 *  voided: INV-5 25600  | return RET-1 11800 (tax 1800, cash) against INV-1
 *  sales 111800, returns 11800, net 100000; taxable of sales 97522; cost of net 51000; profit 36522
 *  INV-0 (4000, 2026-02-01) is outside the range.
 */
let app: App
let m: Mini
beforeAll(() => {
  app = reportsApp()
  m = buildMini(app)
})
const row = (r: ReportResult, key: string, val: string | number): ReportRow => {
  const x = r.rows.find((q) => q[key] === val)
  if (!x) throw new Error(`row ${key}=${val} not found in ${r.id}: ${JSON.stringify(r.rows.map((q) => q[key]))}`)
  return x
}
const col = (r: ReportResult, key: string) => r.rows.map((x) => x[key])

describe('sales summary', () => {
  it('by day: excludes voided, nets returns, includes round-off', async () => {
    const r = await run(app, 'sales_summary', RANGE)
    expect(r.period).toMatchObject({ from: '2026-04-10', to: '2026-04-11' })
    expect(col(r, 'period')).toEqual(['2026-04-10', '2026-04-11'])
    expect(r.rows[0]).toMatchObject({ bills: 3, subtotal: 100999, discount: 1000, taxable: 87522, tax: 12477, round_off: 1, total: 100000, returns: 0, net_total: 100000, avg_bill: 33333 })
    expect(r.rows[1]).toMatchObject({ bills: 1, subtotal: 11800, discount: 0, taxable: 10000, tax: 1800, round_off: 0, total: 11800, returns_count: 1, returns: 11800, net_total: 0 })
    expect(r.totals).toMatchObject({ bills: 4, subtotal: 112799, discount: 1000, taxable: 97522, tax: 14277, round_off: 1, total: 111800, returns: 11800, net_total: 100000, avg_bill: 27950 })
  })
  it('by hour places returns in the hour they were processed', async () => {
    const r = await run(app, 'sales_summary', { ...RANGE, groupBy: 'hour' })
    expect(col(r, 'period')).toEqual(['09:00', '10:00', '12:00', '14:00'])
    expect(row(r, 'period', '10:00')).toMatchObject({ bills: 2, total: 56400 })
    expect(row(r, 'period', '12:00')).toMatchObject({ bills: 0, total: 0, returns: 11800, net_total: -11800 })
  })
  it('by month spans the whole range and respects filters', async () => {
    const r = await run(app, 'sales_summary', { from: '2026-02-01', to: '2026-04-30', groupBy: 'month' })
    expect(col(r, 'period')).toEqual(['2026-02', '2026-04'])
    expect(row(r, 'period', '2026-02').total).toBe(4000)
    const f = await run(app, 'sales_summary', { ...RANGE, posId: m.cat.pos2 })
    expect(f.totals).toMatchObject({ bills: 1, total: 43600, returns: 0 })
  })
})

describe('sales detail and filters', () => {
  it('lists invoices with payments and returned amounts', async () => {
    const r = await run(app, 'sales_detail', RANGE)
    expect(col(r, 'invoice')).toEqual(['INV-1', 'INV-2', 'INV-3', 'INV-4'])
    expect(row(r, 'invoice', 'INV-1')).toMatchObject({ total: 23600, returned: 11800, payments: 'cash 236.00', cashier: 'Anbu', pos: 'Counter 1', customer: 'Walk-in', _saleId: m.s.S1.id })
    expect(row(r, 'invoice', 'INV-2').payments).toBe('upi 200.00, card 128.00')
    expect(r.totals).toMatchObject({ total: 111800, returned: 11800, qty: 10 })
  })
  it.each([
    [{ userId: 0 }, ['INV-3']],
    [{ paymentMethod: 'upi' }, ['INV-2']],
    [{ paymentMethod: 'cash' }, ['INV-1', 'INV-3', 'INV-4']],
    [{ customerId: 0 }, ['INV-2', 'INV-3']],
    [{ posId: 0 }, ['INV-3']],
    [{ categoryId: 0 }, ['INV-2', 'INV-3']],
    [{ brandId: 0 }, ['INV-2', 'INV-3']],
    [{ productId: 0 }, ['INV-1', 'INV-4']]
  ])('filter %o', async (f, expected) => {
    const ids: Record<string, number> = {
      userId: m.cat.users.B, customerId: m.cat.customers.ravi, posId: m.cat.pos2, categoryId: m.cat.categories.Crackers,
      brandId: m.cat.brands.Cock, productId: m.cat.variants.V1.productId
    }
    const filters = Object.fromEntries(Object.entries(f).map(([k, v]) => [k, typeof v === 'number' ? ids[k] : v]))
    const r = await run(app, 'sales_detail', { ...RANGE, ...filters })
    expect(col(r, 'invoice')).toEqual(expected)
  })
})

describe('product / category / brand / profit', () => {
  it('item-wise with profit', async () => {
    const r = await run(app, 'item_sales', RANGE)
    expect(col(r, 'sku')).toEqual(['V4', 'V1', 'V3', 'V2', 'V5'])
    expect(row(r, 'sku', 'V1')).toMatchObject({ qty_sold: 3, qty_returned: 1, qty_net: 2, taxable: 20000, tax: 3600, total: 23600, cost: 12000, profit: 8000, margin: 4000 })
    expect(row(r, 'sku', 'V3')).toMatchObject({ qty_sold: 2, discount: 1000, taxable: 19048, tax: 952, total: 20000, cost: 12000, profit: 7048 })
    expect(row(r, 'sku', 'V4')).toMatchObject({ taxable: 30000, cost: 15000, profit: 15000, margin: 5000 })
    expect(r.totals).toMatchObject({ qty_net: 9, total: 99999, tax: 12477, taxable: 87522, cost: 51000, profit: 36522 })
  })
  it('category and brand wise (sum of lines is bill total minus round-off)', async () => {
    const c = await run(app, 'category_sales', RANGE)
    expect(col(c, 'category')).toEqual(['Crackers', 'Sparklers'])
    expect(row(c, 'category', 'Crackers')).toMatchObject({ total: 56399, share: 5640 })
    expect(row(c, 'category', 'Sparklers')).toMatchObject({ total: 43600, share: 4360 })
    const b = await run(app, 'brand_sales', RANGE)
    expect(row(b, 'brand', 'Standard').total).toBe(53599)
    expect(row(b, 'brand', 'Cock').total).toBe(46400)
    const only = await run(app, 'item_sales', { ...RANGE, categoryId: m.cat.categories.Sparklers })
    expect(col(only, 'sku')).toEqual(['V1', 'V3'])
  })
  it('profit by day and by product', async () => {
    const d = await run(app, 'profit', RANGE)
    expect(row(d, 'period', '2026-04-10')).toMatchObject({ taxable: 87522, cost: 51000, profit: 36522 })
    expect(row(d, 'period', '2026-04-11')).toMatchObject({ taxable: 0, cost: 0, profit: 0, margin: 0 })
    expect(d.totals).toMatchObject({ profit: 36522, margin: Math.round((36522 * 10000) / 87522) })
    const p = await run(app, 'profit', { ...RANGE, groupBy: 'product' })
    expect(p.totals).toMatchObject({ profit: 36522 })
  })
})

describe('payments, POS, cashier, shifts', () => {
  it('payment methods reconcile to sales minus returns', async () => {
    const r = await run(app, 'payment_methods', RANGE)
    expect(col(r, 'method')).toEqual(['cash', 'upi', 'card', 'credit'])
    expect(row(r, 'method', 'cash')).toMatchObject({ bills: 3, received: 59000, change: 1400, refunds_count: 1, refunds: 11800, net: 47200 })
    expect(row(r, 'method', 'upi')).toMatchObject({ received: 20000, net: 20000 })
    expect(row(r, 'method', 'card').net).toBe(12800)
    expect(row(r, 'method', 'credit').net).toBe(20000)
    const s = await run(app, 'sales_summary', RANGE)
    expect(r.totals!.net).toBe(100000)
    expect(r.totals!.net).toBe((s.totals!.total as number) - (s.totals!.returns as number))
  })
  it('POS-wise and cashier-wise', async () => {
    const p = await run(app, 'pos_wise', RANGE)
    expect(p.rows[0]).toMatchObject({ name: 'Counter 1 (POS-01)', bills: 3, total: 68200, returns: 11800, net_total: 56400, avg_bill: 22733 })
    expect(p.rows[1]).toMatchObject({ name: 'Counter 2 (POS-02)', bills: 1, total: 43600, net_total: 43600 })
    const c = await run(app, 'cashier_wise', RANGE)
    expect(col(c, 'name')).toEqual(['Anbu', 'Bala', 'Chitra'])
    expect(c.rows[0]).toMatchObject({ bills: 2, total: 56400, net_total: 56400 })
    expect(c.rows[2]).toMatchObject({ bills: 1, total: 11800, returns: 11800, net_total: 0 })
    expect(c.totals).toMatchObject({ total: 111800, net_total: 100000 })
  })
  it('shift cash reconciliation', async () => {
    const r = await run(app, 'shift_cash', RANGE)
    expect(r.rows).toHaveLength(3)
    expect(r.rows[0]).toMatchObject({ shift: `#${m.shifts.s1}`, cashier: 'Anbu', bills: 2, opening_cash: 50000, cash_sales: 23600, cash_refunds: 0, expected: 73600, counted: 73000, variance: -600 })
    expect(r.rows[1]).toMatchObject({ pos: 'Counter 2', cash_sales: 23600, expected: 33600, counted: 33600, variance: 0 })
    expect(r.rows[2]).toMatchObject({ shift: `#${m.shifts.s2}`, closed: null, bills: 1, cash_sales: 11800, cash_refunds: 11800, expected: 20000, counted: null, variance: null })
    expect(r.totals!.variance).toBe(-600)
  })
})

describe('discounts, returns, voids', () => {
  it('discount report shows who, overrides and approver', async () => {
    const r = await run(app, 'discounts', RANGE)
    expect(r.rows).toHaveLength(1)
    expect(r.rows[0]).toMatchObject({ invoice: 'INV-2', cashier: 'Anbu', customer: 'Ravi', subtotal: 33800, discount: 1000, discount_pct: 296, line_discount: 1000, overrides: 1, approved_by: 'Admin' })
  })
  it('returns report', async () => {
    const r = await run(app, 'returns', RANGE)
    expect(r.rows).toEqual([expect.objectContaining({ return_no: 'RET-1', invoice: 'INV-1', cashier: 'Chitra', reason: 'damaged', method: 'cash', subtotal: 10000, tax: 1800, total: 11800 })])
    expect(r.totals!.total).toBe(11800)
  })
  it('voided report lists only voided and they stay out of every other total', async () => {
    const r = await run(app, 'voided', RANGE)
    expect(r.rows).toEqual([expect.objectContaining({ invoice: 'INV-5', voided_by: 'Admin', reason: 'wrong item', total: 25600, cashier: 'Chitra' })])
    for (const id of ['sales_summary', 'sales_detail', 'item_sales', 'payment_methods']) {
      const x = await run(app, id, RANGE)
      expect(JSON.stringify(x.rows)).not.toContain('INV-5')
    }
    expect((await run(app, 'payment_methods', RANGE)).totals!.received).toBe(111800)
  })
})

describe('GST', () => {
  it('rate wise: sales minus returns, CGST+SGST = tax', async () => {
    const r = await run(app, 'gst_rate', RANGE)
    expect(col(r, 'rate')).toEqual([500, 1200, 1800, 2800])
    expect(row(r, 'rate', 500)).toMatchObject({ taxable: 19048, tax: 952, cgst: 476, sgst: 476, value: 20000 })
    expect(row(r, 'rate', 1200)).toMatchObject({ taxable: 30000, tax: 3600, cgst: 1800, sgst: 1800 })
    expect(row(r, 'rate', 1800)).toMatchObject({ taxable_sales: 38474, taxable_returns: 10000, taxable: 28474, tax: 5125, cgst: 2562, sgst: 2563, igst: 0, value: 33599 })
    expect(row(r, 'rate', 2800)).toMatchObject({ taxable: 10000, tax: 2800, cgst: 1400, sgst: 1400 })
    expect(r.totals).toMatchObject({ tax: 12477, taxable: 87522, value: 99999 })
    expect((r.totals!.cgst as number) + (r.totals!.sgst as number)).toBe(12477)
  })
  it('HSN wise (GSTR-1 table 12 layout)', async () => {
    const r = await run(app, 'gst_hsn', RANGE)
    expect(r.rows.map((x) => `${x.hsn}@${x.rate}`)).toEqual(['3604@1800', '3604@2800', '4820@500', '6109@1200', '9503@1800'])
    expect(r.rows[0]).toMatchObject({ descr: 'Sparkler Box', uqc: 'PCS', qty: 2, taxable: 20000, tax: 3600, value: 23600 })
    expect(r.rows[4]).toMatchObject({ qty: 1, taxable: 8474, tax: 1525, value: 9999 })
    expect(r.totals).toMatchObject({ tax: 12477, value: 99999 })
  })
  it('tax invoice register lists credit notes (negative) and cancelled invoices (excluded from totals)', async () => {
    const r = await run(app, 'tax_register', RANGE)
    expect(col(r, 'doc_no')).toEqual(['INV-1', 'INV-2', 'INV-3', 'INV-4', 'INV-5', 'RET-1'])
    expect(col(r, 'type')).toEqual(['Invoice', 'Invoice', 'Invoice', 'Invoice', 'Cancelled', 'Credit note'])
    expect(row(r, 'doc_no', 'INV-2')).toMatchObject({ taxable_5: 19048, taxable_28: 10000, taxable: 29048, cgst: 1876, sgst: 1876, total: 32800, gstin: '33AAAAA0000A1Z5' })
    expect(row(r, 'doc_no', 'INV-3')).toMatchObject({ taxable_12: 30000, taxable_18: 8474, cgst: 2562, sgst: 2563, round_off: 1, total: 43600 })
    expect(row(r, 'doc_no', 'RET-1')).toMatchObject({ taxable_18: -10000, cgst: -900, sgst: -900, total: -11800 })
    expect(r.totals).toMatchObject({ taxable: 87522, round_off: 1, total: 100000, cgst: 6238, sgst: 6239 })
  })
})

describe('purchases and stock', () => {
  it('purchase report excludes cancelled', async () => {
    const r = await run(app, 'purchases', { from: '2026-04-01', to: '2026-04-30' })
    expect(col(r, 'number')).toEqual(['PO-1', 'PO-2'])
    expect(r.totals).toMatchObject({ total: 150000, paid: 90000, due: 60000 })
    const s = await run(app, 'purchases', { from: '2026-04-01', to: '2026-04-30', supplierId: app.db.value<number>("SELECT id FROM suppliers WHERE name='Kumar & Sons'")! })
    expect(col(s, 'number')).toEqual(['PO-2'])
  })
  it('supplier payables', async () => {
    const r = await run(app, 'supplier_payables')
    expect(r.period).toBeNull()
    expect(col(r, 'supplier')).toEqual(['Sri Traders', 'Kumar & Sons'])
    expect(r.rows[0]).toMatchObject({ bills: 1, purchased: 100000, paid: 40000, returned: 5000, outstanding: 55000, oldest_due: local(2026, 4, 5, 11) })
    expect(r.totals!.outstanding).toBe(55000)
  })
  it('inventory valuation', async () => {
    const r = await run(app, 'stock_valuation')
    expect(r.rows).toHaveLength(7)
    expect(r.totals).toMatchObject({ qty: 140, cost_value: 731000, retail_value: 1420900 })
    expect(row(r, 'sku', 'V5')).toMatchObject({ qty: 100, cost: 5000, cost_value: 500000, retail_value: 999900 })
    expect((await run(app, 'stock_valuation', { inStockOnly: true })).rows).toHaveLength(6)
    expect((await run(app, 'stock_valuation', { categoryId: m.cat.categories.Sparklers })).totals).toMatchObject({ cost_value: 30000 + 48000 + 10000 })
  })
  it('low stock', async () => {
    const r = await run(app, 'low_stock')
    expect(r.rows.map((x) => [x.sku, x.shortfall])).toEqual([['V1', 5], ['V4', 3], ['V3', 2]])
  })
  it('stock ledger', async () => {
    const r = await run(app, 'stock_ledger', { ...RANGE, variantId: m.cat.variants.V1.id })
    expect(r.rows.map((x) => [x.qty_delta, x.balance, x.type])).toEqual([[-2, 8, 'sale'], [-1, 7, 'sale'], [1, 8, 'sale_return']])
    expect(r.totals!.qty_delta).toBe(-2)
    expect((await run(app, 'stock_ledger', { from: '2026-03-01', to: '2026-04-30', variantId: m.cat.variants.V1.id })).rows).toHaveLength(4)
    expect((await run(app, 'stock_ledger', { from: '2026-03-01', to: '2026-04-30', action: 'opening' })).rows).toHaveLength(1)
  })
  it('dead stock: never sold and long idle items only', async () => {
    const r = await run(app, 'dead_stock', { days: 30, now: NOW })
    expect(r.rows.map((x) => x.sku)).toEqual(['DEAD1', 'OLD1'])
    expect(row(r, 'sku', 'DEAD1')).toMatchObject({ last_sold: null, days_idle: null, cost_value: 3000 })
    expect(row(r, 'sku', 'OLD1')).toMatchObject({ last_sold: local(2026, 2, 1, 12), days_idle: 69, cost_value: 10000 })
    expect(r.totals!.cost_value).toBe(13000)
  })
})

describe('customers and audit', () => {
  it('customer report', async () => {
    const r = await run(app, 'customers', RANGE)
    expect(col(r, 'name')).toEqual(['Ravi', 'Walk-in customers'])
    expect(r.rows[0]).toMatchObject({ bills: 2, sales: 76400, returns: 0, net: 76400, avg_bill: 38200, credit: 20000 })
    expect(r.rows[1]).toMatchObject({ bills: 2, sales: 35400, returns: 11800, net: 23600 })
    expect((await run(app, 'customers', { ...RANGE, search: 'rav' })).rows).toHaveLength(1)
  })
  it('audit search is read-only and filterable', async () => {
    const r = await run(app, 'audit', RANGE)
    expect(col(r, 'action')).toEqual(['update', 'void', 'create'])
    expect((await run(app, 'audit', { ...RANGE, action: 'void' })).rows).toHaveLength(1)
    expect((await run(app, 'audit', { ...RANGE, userId: m.cat.users.admin })).rows).toHaveLength(2)
    expect((await run(app, 'audit', { ...RANGE, search: 'role' })).rows).toHaveLength(1)
    expect((await run(app, 'audit', { ...RANGE, entity: 'user' })).rows).toHaveLength(1)
  })
})

describe('cross-report reconciliation', () => {
  it('every sales-side report agrees on the same period', async () => {
    const sum = await run(app, 'sales_summary', RANGE)
    const det = await run(app, 'sales_detail', RANGE)
    const tax = await run(app, 'gst_rate', RANGE)
    const reg = await run(app, 'tax_register', RANGE)
    const cash = await run(app, 'cashier_wise', RANGE)
    const pos = await run(app, 'pos_wise', RANGE)
    const items = await run(app, 'item_sales', RANGE)
    const prof = await run(app, 'profit', RANGE)
    const T = sum.totals!
    expect(det.totals!.total).toBe(T.total)
    expect(cash.totals!.net_total).toBe(T.net_total)
    expect(pos.totals!.net_total).toBe(T.net_total)
    expect(tax.totals!.tax).toBe((T.tax as number) - 1800) // sales tax minus returned tax
    expect(reg.totals!.total).toBe(T.net_total)
    expect(reg.totals!.taxable).toBe(tax.totals!.taxable)
    expect(items.totals!.total).toBe((T.net_total as number) - (T.round_off as number))
    expect(prof.totals!.profit).toBe(items.totals!.profit)
  })
})

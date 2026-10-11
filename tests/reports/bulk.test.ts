import { beforeAll, describe, expect, it } from 'vitest'
import type { App } from '../../src/main/core/app'
import type { DashboardSummary } from '../../src/shared/reports'
import { generate, local, seedCatalog, type Catalog, type Oracle } from './fixture'
import { reportsApp, run } from './setup'

/** 30 days, 2 POS, 3 cashiers, mixed payments, GST 5/12/18/28, returns and voids; expectations come from an independent JS oracle. */
let app: App
let cat: Catalog
let orc: Oracle
const FROM = '2026-04-01'
const TO = '2026-04-30'
const NOW = local(2026, 4, 30, 15)

beforeAll(() => {
  app = reportsApp()
  cat = seedCatalog(app)
  orc = generate(app, cat, { endY: 2026, endM: 4, endD: 30, days: 30, perDay: 40, seed: 7 })
})

describe('30-day fixture vs oracle', () => {
  it('fixture is meaningful', () => {
    expect(orc.bills).toBeGreaterThan(1000)
    expect(orc.retCount).toBeGreaterThan(20)
    expect(orc.voidCount).toBeGreaterThan(5)
    expect(Object.keys(orc.byRate).sort()).toEqual(['1200', '1800', '2800', '500'])
    expect(Object.keys(orc.received).sort()).toEqual(['card', 'cash', 'credit', 'upi'])
  })

  it('sales summary totals and per-day rows', async () => {
    const r = await run(app, 'sales_summary', { from: FROM, to: TO })
    expect(r.totals).toMatchObject({
      bills: orc.bills, subtotal: orc.subtotal, discount: orc.discount, tax: orc.tax, round_off: orc.roundOff, total: orc.total,
      returns_count: orc.retCount, returns: orc.retTotal, net_total: orc.total - orc.retTotal
    })
    expect(r.rows).toHaveLength(30)
    for (const row of r.rows) {
      const o = orc.byDay[row.period as string]
      expect(row, String(row.period)).toMatchObject({ bills: o.bills, total: o.total, returns: o.ret })
    }
  })

  it('payment methods reconcile with net collections', async () => {
    const r = await run(app, 'payment_methods', { from: FROM, to: TO })
    for (const m of ['cash', 'upi', 'card', 'credit']) {
      const row = r.rows.find((x) => x.method === m)!
      const expected = (orc.received[m] ?? 0) - (orc.refunds[m] ?? 0)
      expect(row.net, m).toBe(expected)
    }
    expect(r.totals!.net).toBe(orc.total - orc.retTotal)
  })

  it('item, category, brand reports agree with the oracle and each other', async () => {
    const items = await run(app, 'item_sales', { from: FROM, to: TO })
    for (const [sku, o] of Object.entries(orc.byVariant)) {
      expect(items.rows.find((x) => x.sku === sku), sku).toMatchObject({ qty_net: o.qty, total: o.total, tax: o.tax, cost: o.cost })
    }
    const cats = await run(app, 'category_sales', { from: FROM, to: TO })
    const brands = await run(app, 'brand_sales', { from: FROM, to: TO })
    expect(cats.totals!.total).toBe(items.totals!.total)
    expect(brands.totals!.total).toBe(items.totals!.total)
    expect(items.totals!.total).toBe(orc.total - orc.retTotal - orc.roundOff)
    expect(items.totals!.profit).toBe(orc.profit)
  })

  it('GST: rate wise matches oracle, HSN wise and register agree', async () => {
    const rate = await run(app, 'gst_rate', { from: FROM, to: TO })
    for (const [bp, o] of Object.entries(orc.byRate)) {
      expect(rate.rows.find((x) => x.rate === Number(bp)), bp).toMatchObject({ taxable: o.taxable, tax: o.tax })
    }
    expect(rate.totals!.tax).toBe(orc.tax - orc.retTax)
    const hsn = await run(app, 'gst_hsn', { from: FROM, to: TO })
    expect(hsn.totals).toMatchObject({ taxable: rate.totals!.taxable, tax: rate.totals!.tax, value: rate.totals!.value })
    const reg = await run(app, 'tax_register', { from: FROM, to: TO })
    expect(reg.rows).toHaveLength(orc.bills + orc.voidCount + orc.retCount)
    expect(reg.totals).toMatchObject({ taxable: rate.totals!.taxable, round_off: orc.roundOff, total: orc.total - orc.retTotal })
    expect(rate.totals!.cgst as number + (rate.totals!.sgst as number)).toBe(rate.totals!.tax)
  })

  it('cashier and POS reports', async () => {
    const c = await run(app, 'cashier_wise', { from: FROM, to: TO })
    expect(c.rows).toHaveLength(3)
    for (const [uid, o] of Object.entries(orc.byUser)) {
      const name = app.db.value<string>('SELECT name FROM users WHERE id=?', Number(uid))
      expect(c.rows.find((x) => x.name === name), name).toMatchObject({ bills: o.bills, total: o.total })
    }
    const p = await run(app, 'pos_wise', { from: FROM, to: TO })
    expect(p.rows).toHaveLength(2)
    expect(p.totals!.total).toBe(orc.total)
    expect(p.totals!.net_total).toBe(orc.total - orc.retTotal)
  })

  it('voided and returns reports match; discounts only list discounted bills', async () => {
    const v = await run(app, 'voided', { from: FROM, to: TO })
    expect(v.rows).toHaveLength(orc.voidCount)
    expect(v.totals!.total).toBe(orc.voidTotal)
    const rt = await run(app, 'returns', { from: FROM, to: TO })
    expect(rt.rows).toHaveLength(orc.retCount)
    expect(rt.totals!.total).toBe(orc.retTotal)
    const d = await run(app, 'discounts', { from: FROM, to: TO })
    expect(d.totals!.discount).toBe(orc.discount)
  })

  it('sub-range: month split into two halves adds up', async () => {
    const a = await run(app, 'sales_summary', { from: '2026-04-01', to: '2026-04-15' })
    const b = await run(app, 'sales_summary', { from: '2026-04-16', to: '2026-04-30' })
    expect((a.totals!.total as number) + (b.totals!.total as number)).toBe(orc.total)
    expect((a.totals!.returns as number) + (b.totals!.returns as number)).toBe(orc.retTotal)
    expect((a.totals!.bills as number) + (b.totals!.bills as number)).toBe(orc.bills)
  })

  it('dashboard summary matches oracle', async () => {
    const s = (await app.call('dashboard', 'summary', { now: NOW })) as DashboardSummary
    const last = orc.byDay['2026-04-30'], prev = orc.byDay['2026-04-29']
    expect(s.restricted).toBe(false)
    expect(s.today).toMatchObject({ sales: last.total, bills: last.bills, returns: last.ret })
    expect(s.yesterday).toMatchObject({ sales: prev.total, bills: prev.bills })
    expect(s.yesterdaySoFar.sales).toBeLessThanOrEqual(prev.total)
    expect(s.today.grossProfit).not.toBeNull()
    expect(s.last30).toHaveLength(30)
    expect(s.last7).toHaveLength(7)
    expect(s.last30.reduce((a, d) => a + d.sales, 0)).toBe(orc.total)
    expect(s.last30[29]).toMatchObject({ date: '2026-04-30', sales: last.total })
    expect(s.topProducts).toHaveLength(5)
    const best = Object.entries(orc.byVariant).sort((a, b) => b[1].total - a[1].total)[0]
    expect(s.topProducts[0]).toMatchObject({ sku: best[0], revenue: best[1].total })
    expect(s.categoryShare.reduce((a, c) => a + c.sharePct, 0)).toBeCloseTo(100, 0)
    expect(s.paymentMix.reduce((a, c) => a + c.sharePct, 0)).toBeCloseTo(100, 0)
    expect(s.heatmap.reduce((a, c) => a + c.bills, 0)).toBe(orc.bills)
    expect(s.recentSales).toHaveLength(10)
    expect(s.lowStockCount).toBe(3) // V1(5<=10), V3(8<=10), V4(0<=3)
    expect(s.pendingSync).toBe(0)
    expect(s.openShift).toBeNull()
  })
})

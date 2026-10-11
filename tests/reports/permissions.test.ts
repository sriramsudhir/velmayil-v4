import { describe, expect, it } from 'vitest'
import type { App } from '../../src/main/core/app'
import type { DashboardSummary, ReportMeta, ReportResult } from '../../src/shared/reports'
import { actAs } from '../helpers'
import { local, makeInserter } from './fixture'
import { buildMini, NOW, RANGE, reportsApp, run } from './setup'

const withPerms = (app: App, permissions: string[]) => { app.session = { ...app.session!, permissions } }

describe('permission gating', () => {
  it('cashier cannot list or run any report', async () => {
    const app = reportsApp()
    buildMini(app)
    actAs(app, 'Cashier')
    await expect(app.call('reports', 'list')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(run(app, 'sales_summary', RANGE)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(app.call('reports', 'exportCsv', { id: 'sales_summary' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('requires a session', async () => {
    const app = reportsApp()
    app.session = null
    await expect(run(app, 'sales_summary')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' })
    await expect(app.call('dashboard', 'summary', {})).rejects.toMatchObject({ code: 'UNAUTHENTICATED' })
  })

  it('reports.view only: no cost/profit data anywhere, no profit/audit reports, no export', async () => {
    const app = reportsApp()
    const m = buildMini(app)
    void m
    withPerms(app, ['reports.view'])
    const list = (await app.call('reports', 'list')) as ReportMeta[]
    const ids = list.map((r) => r.id)
    expect(ids).toContain('item_sales')
    expect(ids).not.toContain('profit')
    expect(ids).not.toContain('audit')

    const items = await run(app, 'item_sales', RANGE)
    for (const k of ['cost', 'profit', 'margin']) {
      expect(items.columns.map((c) => c.key)).not.toContain(k)
      expect(items.rows.every((r) => !(k in r))).toBe(true)
      expect(items.totals).not.toHaveProperty(k)
    }
    for (const id of ['category_sales', 'brand_sales']) {
      const r = await run(app, id, RANGE)
      expect(r.columns.map((c) => c.key)).not.toContain('profit')
    }
    const val = await run(app, 'stock_valuation')
    expect(val.columns.map((c) => c.key)).not.toContain('cost_value')
    expect(JSON.stringify(val.rows)).not.toContain('cost')
    const led = await run(app, 'stock_ledger', { from: '2026-03-01', to: '2026-04-30' })
    expect(led.columns.map((c) => c.key)).not.toContain('unit_cost')
    const dead = await run(app, 'dead_stock', { days: 30, now: NOW })
    expect(dead.columns.map((c) => c.key)).not.toContain('cost_value')

    await expect(run(app, 'profit', RANGE)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(run(app, 'audit', RANGE)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(app.call('reports', 'exportXlsx', { id: 'item_sales', filters: RANGE })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(app.call('reports', 'exportCsv', { id: 'item_sales', filters: RANGE })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(app.call('reports', 'exportPdf', { id: 'item_sales', filters: RANGE })).rejects.toMatchObject({ code: 'FORBIDDEN' })

    const dash = (await app.call('dashboard', 'summary', { now: NOW })) as DashboardSummary
    expect(dash.today.grossProfit).toBeNull()
    expect(dash.yesterday.grossProfit).toBeNull()
  })

  it('manager has profit and export; audit needs audit.view', async () => {
    const app = reportsApp()
    buildMini(app)
    actAs(app, 'Manager')
    expect((await run(app, 'profit', RANGE)).totals).toMatchObject({ profit: 36522 })
    expect((await run(app, 'audit', RANGE)).rows.length).toBe(3)
    const x = (await app.call('reports', 'exportCsv', { id: 'sales_summary', filters: RANGE })) as { base64: string }
    expect(x.base64.length).toBeGreaterThan(10)
    withPerms(app, ['reports.view', 'reports.export'])
    await expect(run(app, 'audit', RANGE)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(((await app.call('reports', 'exportCsv', { id: 'sales_summary', filters: RANGE })) as { bytes: number }).bytes).toBeGreaterThan(10)
  })

  it('reports.view + reports.profit sees cost columns', async () => {
    const app = reportsApp()
    buildMini(app)
    withPerms(app, ['reports.view', 'reports.profit'])
    const r = await run(app, 'item_sales', RANGE)
    expect(r.columns.map((c) => c.key)).toEqual(expect.arrayContaining(['cost', 'profit', 'margin']))
    expect((await run(app, 'stock_valuation')).totals).toMatchObject({ cost_value: 731000 })
  })

  it('dashboard for a user without reports.view is limited to their own figures', async () => {
    const app = reportsApp()
    const m = buildMini(app)
    const { insertSale } = makeInserter(app)
    actAs(app, 'Cashier')
    const me = app.session!.userId
    insertSale({ no: 'MINE-1', ts: local(2026, 4, 11, 10), posId: app.localPos().id, userId: me, lines: [{ v: m.cat.variants.V1, qty: 1 }], pays: [{ method: 'cash', amount: 11800 }] })
    const d = (await app.call('dashboard', 'summary', { now: NOW })) as DashboardSummary
    expect(d.restricted).toBe(true)
    expect(d.today).toMatchObject({ sales: 11800, bills: 1, grossProfit: null })
    expect(d.last30).toEqual([])
    expect(d.topProducts).toEqual([])
    expect(d.recentSales).toEqual([])
    expect(d.openShift).toMatchObject({ id: m.shifts.s2, userName: 'Chitra', openingCash: 20000, cashSales: 11800, bills: 1 })
    expect(d.lowStockCount).toBe(3)
  })

  it('validates inputs', async () => {
    const app = reportsApp()
    await expect(run(app, 'nope')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(run(app, 'sales_summary', { from: '2026-02-30', to: '2026-03-01' })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(run(app, 'sales_summary', { from: '2026-04-05', to: '2026-04-01' })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(run(app, 'sales_summary', { from: 'yesterday' } as never)).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(run(app, 'sales_summary', { posId: -1 } as never)).rejects.toMatchObject({ code: 'VALIDATION' })
  })

  it('list/options reflect permissions and data', async () => {
    const app = reportsApp()
    buildMini(app)
    const o = (await app.call('reports', 'options')) as { pos: unknown[]; cashiers: unknown[]; paymentMethods: string[]; canProfit: boolean; canExport: boolean }
    expect(o.pos).toHaveLength(2)
    expect(o.paymentMethods).toEqual(expect.arrayContaining(['cash', 'upi', 'card', 'credit']))
    expect(o.canProfit && o.canExport).toBe(true)
    const all = (await app.call('reports', 'list')) as ReportMeta[]
    expect(all.length).toBeGreaterThanOrEqual(24)
    expect(new Set(all.map((r) => r.group))).toEqual(new Set(['Sales', 'Tax', 'Purchases', 'Inventory', 'People', 'Admin']))
  })
})

describe('date range handling (local day boundaries, inclusive)', () => {
  it('includes 00:00:00.000 of the first day and 23:59:59.999 of the last, excludes neighbours', async () => {
    const app = reportsApp()
    const m = buildMini(app)
    const { insertSale } = makeInserter(app)
    const pos = app.localPos().id
    const mk = (no: string, ts: number) => insertSale({ no, ts, posId: pos, userId: m.cat.users.A, lines: [{ v: m.cat.variants.V3, qty: 1 }], pays: [{ method: 'cash', amount: 10500 }] })
    mk('B-BEFORE', local(2026, 5, 9, 23, 59, 59, 999))
    mk('B-START', local(2026, 5, 10, 0, 0, 0, 0))
    mk('B-END', local(2026, 5, 11, 23, 59, 59, 999))
    mk('B-AFTER', local(2026, 5, 12, 0, 0, 0, 0))
    const r = await run(app, 'sales_detail', { from: '2026-05-10', to: '2026-05-11' })
    expect(r.rows.map((x) => x.invoice)).toEqual(['B-START', 'B-END'])
    expect(r.period).toMatchObject({ fromMs: local(2026, 5, 10), toMs: local(2026, 5, 12) - 1 })
    const one = await run(app, 'sales_detail', { from: '2026-05-11', to: '2026-05-11' })
    expect(one.rows.map((x) => x.invoice)).toEqual(['B-END'])
    const single = await run(app, 'sales_detail', { from: '2026-05-10' , now: local(2026, 5, 10, 12) })
    expect(single.rows.map((x) => x.invoice)).toEqual(['B-START'])
    const byDay = await run(app, 'sales_summary', { from: '2026-05-09', to: '2026-05-12' })
    expect(byDay.rows.map((x) => [x.period, x.bills])).toEqual([['2026-05-09', 1], ['2026-05-10', 1], ['2026-05-11', 1], ['2026-05-12', 1]])
  })

  it('presets resolve to the right local ranges', async () => {
    const app = reportsApp()
    const at = (preset: string, now: number) => run(app, 'sales_summary', { preset: preset as never, now }).then((r) => r.period!)
    const sat = local(2026, 4, 11, 15) // Saturday
    expect(await at('today', sat)).toMatchObject({ from: '2026-04-11', to: '2026-04-11', label: 'Today' })
    expect(await at('yesterday', sat)).toMatchObject({ from: '2026-04-10', to: '2026-04-10' })
    expect(await at('this_week', sat)).toMatchObject({ from: '2026-04-06', to: '2026-04-11' })
    expect(await at('this_week', local(2026, 4, 12, 9))).toMatchObject({ from: '2026-04-06', to: '2026-04-12' }) // Sunday belongs to the Mon-start week
    expect(await at('last_7', sat)).toMatchObject({ from: '2026-04-05', to: '2026-04-11' })
    expect(await at('last_30', sat)).toMatchObject({ from: '2026-03-13', to: '2026-04-11' })
    expect(await at('this_month', sat)).toMatchObject({ from: '2026-04-01', to: '2026-04-11' })
    expect(await at('last_month', sat)).toMatchObject({ from: '2026-03-01', to: '2026-03-31' })
    expect(await at('this_fy', sat)).toMatchObject({ from: '2026-04-01', to: '2026-04-11', label: 'FY 2026-27' })
    expect(await at('last_fy', sat)).toMatchObject({ from: '2025-04-01', to: '2026-03-31', label: 'FY 2025-26' })
    const feb = local(2026, 2, 10, 9)
    expect(await at('this_fy', feb)).toMatchObject({ from: '2025-04-01', to: '2026-02-10' })
    expect(await at('last_fy', feb)).toMatchObject({ from: '2024-04-01', to: '2025-03-31' })
    expect(await at('last_month', local(2026, 1, 15))).toMatchObject({ from: '2025-12-01', to: '2025-12-31' })
    expect(await run(app, 'sales_summary', { now: sat }).then((r) => r.period)).toMatchObject({ from: '2026-04-01', to: '2026-04-11' }) // default = this month
  })
})

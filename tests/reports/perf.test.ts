import { describe, expect, it } from 'vitest'
import type { DashboardSummary } from '../../src/shared/reports'
import { generate, local, seedCatalog } from './fixture'
import { reportsApp, run } from './setup'

describe('performance on ~50k sales', () => {
  it('dashboard.summary() < 50 ms; heavy reports stay interactive', async () => {
    const app = reportsApp()
    const cat = seedCatalog(app)
    const orc = generate(app, cat, { endY: 2026, endM: 4, endD: 30, days: 365, perDay: 137, seed: 99 })
    const n = app.db.value<number>('SELECT COUNT(*) FROM sales')!
    expect(n).toBeGreaterThanOrEqual(50000)
    const now = local(2026, 4, 30, 15)

    const timings: number[] = []
    let last!: DashboardSummary
    for (let i = 0; i < 10; i++) {
      const t0 = performance.now()
      last = (await app.call('dashboard', 'summary', { now })) as DashboardSummary
      timings.push(performance.now() - t0)
    }
    const warm = timings.slice(1).sort((a, b) => a - b)
    const median = warm[Math.floor(warm.length / 2)]
    console.log(`dashboard.summary on ${n} sales: first ${timings[0].toFixed(1)} ms, best warm ${warm[0].toFixed(1)} ms, median warm ${median.toFixed(1)} ms, max ${warm[warm.length - 1].toFixed(1)} ms`)
    expect(last.last30.reduce((a, d) => a + d.sales, 0)).toBeGreaterThan(0)
    // best-of-N warm runs: robust against a busy CI box; median is logged and loosely bounded
    expect(warm[0]).toBeLessThan(50)
    expect(median).toBeLessThan(100)
    expect(timings[0]).toBeLessThan(150)

    const t1 = performance.now()
    const month = await run(app, 'sales_summary', { from: '2026-04-01', to: '2026-04-30' })
    const t2 = performance.now()
    const items = await run(app, 'item_sales', { from: '2026-04-01', to: '2026-04-30' })
    const t3 = performance.now()
    const year = await run(app, 'gst_rate', { from: '2025-05-01', to: '2026-04-30' })
    const t4 = performance.now()
    console.log(`sales_summary(30d) ${(t2 - t1).toFixed(0)} ms, item_sales(30d) ${(t3 - t2).toFixed(0)} ms, gst_rate(365d) ${(t4 - t3).toFixed(0)} ms`)
    expect(month.totals!.bills as number).toBeGreaterThan(3000)
    expect(items.rows.length).toBe(5)
    expect(year.totals!.tax).toBe(orc.tax - orc.retTax)
    expect(t4 - t1).toBeLessThan(5000)
  }, 180000)
})

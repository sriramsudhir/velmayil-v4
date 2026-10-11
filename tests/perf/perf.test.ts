import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { App } from '../../src/main/core/app'
import type { DashboardSummary, ReportResult } from '../../src/shared/reports'
import { PERF_PASSWORD, PERF_USER, seedDatabase } from './seed'
import { BackupService } from '../../src/main/modules/backup/service'

/**
 * Regression guards for the "the app lags" fixes (see docs/PERF_REPORT.md). Everything here asserts on *how much work* is
 * done (query plans, number/shape of SQL statements, payload sizes, event-loop gaps) with generous wall-clock ceilings, so
 * it stays green on a slow or busy machine but goes red if someone re-introduces a scan, an unbounded payload or a
 * main-thread freeze.
 */
let app: App
let dir: string
const N_SALES = 6000

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'velmayil-perftest-'))
  app = await seedDatabase({ dir, products: 3000, sales: N_SALES, customers: 400, days: 60, keepOpen: true })
  await app.call('auth', 'login', { username: PERF_USER, password: PERF_PASSWORD })
}, 180_000)

afterAll(() => {
  try { app.close() } catch { /* already closed */ }
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch { /* Windows may still hold the WAL for a moment */ }
})

/** Record every SQL statement text that runs through app.db during `fn`. */
async function recordSql<T>(fn: () => Promise<T> | T): Promise<{ result: T; sql: string[] }> {
  const raw = app.db.raw as any
  const sql: string[] = []
  const prep = raw.prepare.bind(raw)
  raw.prepare = (s: string) => (sql.push(s), prep(s)) // every Db.all/get/value/run and direct raw statement goes through prepare()
  try {
    return { result: await fn(), sql }
  } finally {
    raw.prepare = prep
  }
}

const plan = (sql: string, ...p: (string | number)[]) =>
  app.db.all<{ detail: string }>('EXPLAIN QUERY PLAN ' + sql, ...p).map((r) => r.detail).join('\n')

describe('query plans use indexes (no table scans on the big tables)', () => {
  const now = Date.now()
  it('dashboard history fingerprint is index-only', () => {
    const p = plan(
      `SELECT (SELECT COUNT(*) FROM sales WHERE created_at >= ? AND created_at < ?) AS bills,
              (SELECT COUNT(*) FROM sales WHERE voided_at IS NOT NULL) AS voids,
              (SELECT COALESCE(MAX(voided_at),0) FROM sales WHERE voided_at IS NOT NULL) AS lastVoid,
              (SELECT COALESCE(MAX(id),0) FROM sale_returns) AS lastReturn`, now - 3e9, now
    )
    expect(p).not.toMatch(/SCAN sales(?! USING)/)
    expect(p).toMatch(/idx_sales_voided/)
  })
  it('sales range / items / payments aggregates search by the covering indexes', () => {
    const ok = `s.voided_at IS NULL AND s.status NOT IN ('void','voided','cancelled','held','draft')`
    expect(plan(`SELECT COUNT(*) FROM sales s WHERE ${ok} AND s.created_at >= ? AND s.created_at < ?`, now - 1e9, now)).toMatch(/idx_rpt_sales_cov|idx_sales_created/)
    const items = plan(`SELECT si.variant_id, SUM(si.qty) FROM sale_items si JOIN sales s ON s.id = si.sale_id WHERE ${ok} AND s.created_at >= ? AND s.created_at < ? GROUP BY si.variant_id`, now - 1e9, now)
    expect(items).toMatch(/idx_rpt_items_cov|idx_sale_items_sale/)
    expect(items).not.toMatch(/SCAN si\b(?! USING)/)
  })
  it('low-stock count walks only variants with a reorder level', () => {
    const p = plan(`SELECT COUNT(*) FROM product_variants v JOIN products p ON p.id = v.product_id
       WHERE v.reorder_level > 0 AND v.active = 1 AND p.active = 1 AND p.track_stock = 1
         AND COALESCE((SELECT SUM(sl.qty) FROM stock_levels sl WHERE sl.variant_id = v.id), 0) <= v.reorder_level`)
    expect(p).toMatch(/idx_variants_reorder/)
    expect(p).toMatch(/stock_levels.*(sqlite_autoindex|variant_id=\?)/s)
  })
  it('stock page ordering uses the NOCASE product-name index (early exit at LIMIT)', () => {
    const p = plan(`SELECT v.id FROM product_variants v JOIN products p ON p.id = v.product_id WHERE (p.name LIKE '%a%') ORDER BY p.name COLLATE NOCASE LIMIT 30`)
    expect(p).toMatch(/idx_products_name/)
  })
  it('a sales list page is read in id order without sorting', () => {
    expect(plan('SELECT id FROM sales ORDER BY id DESC LIMIT 50')).not.toMatch(/TEMP B-TREE/)
  })
  it('sync badge counts pending rows through the status index', () => {
    expect(plan("SELECT COUNT(*) FROM sync_queue WHERE status = 'pending'")).toMatch(/idx_sync_status/)
  })
})

describe('dashboard.summary', () => {
  it('is correct, and a warm call touches neither sale_items nor the 30-day sales aggregates', async () => {
    const cold = (await app.call('dashboard', 'summary', {})) as DashboardSummary
    expect(cold.last30).toHaveLength(30)
    expect(cold.topProducts.length).toBeGreaterThan(0)
    const { result: warm, sql } = await recordSql(() => app.call('dashboard', 'summary', {}) as Promise<DashboardSummary>)
    // identical figures from the cache
    expect(warm.last30).toEqual(cold.last30)
    expect(warm.topProducts).toEqual(cold.topProducts)
    expect(warm.paymentMix).toEqual(cold.paymentMix)
    expect(warm.heatmap).toEqual(cold.heatmap)
    // work done: only today's slice + counters, never the 30-day item/payment aggregation
    const heavy = sql.filter((s) => /GROUP BY si\.variant_id|GROUP BY sp\.method|GROUP BY k/.test(s))
    // (today's slice is queried live: at most one of each)
    expect(heavy.length).toBeLessThanOrEqual(3)
    const lines = sql.filter((s) => /WITH lines AS/.test(s))
    expect(lines.length).toBeLessThanOrEqual(2) // gross profit of today + yesterday-so-far, one day each
    expect(sql.length).toBeLessThan(60)
  })

  it('a sale made after the cache was built still shows up immediately (today is always live)', async () => {
    const before = (await app.call('dashboard', 'summary', {})) as DashboardSummary
    const u = app.db.get<{ id: number }>('SELECT id FROM users LIMIT 1')!
    const prof = app.db.value<number>('SELECT id FROM business_profile_versions WHERE is_active = 1')!
    const pos = app.db.value<number>('SELECT id FROM pos_terminals WHERE is_local = 1')!
    const sid = app.db.run(
      `INSERT INTO sales(uuid,invoice_no,pos_id,user_id,status,subtotal,tax,total,paid,profile_version_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      app.uuid(), 'INV-PERF-LIVE', pos, u.id, 'completed', 90000, 10000, 100000, 100000, prof, Date.now()
    ).lastId
    app.db.run('INSERT INTO sale_payments(sale_id,method,amount) VALUES (?,?,?)', sid, 'cash', 100000)
    const after = (await app.call('dashboard', 'summary', {})) as DashboardSummary
    expect(after.today.sales).toBe(before.today.sales + 100000)
    expect(after.today.bills).toBe(before.today.bills + 1)
    expect(after.recentSales[0].invoiceNo).toBe('INV-PERF-LIVE')
  })

  it('voiding an OLD sale invalidates the cached history', async () => {
    const before = (await app.call('dashboard', 'summary', {})) as DashboardSummary
    const old = app.db.get<{ id: number; total: number; created_at: number }>(
      `SELECT id, total, created_at FROM sales WHERE status = 'completed' AND created_at < ? ORDER BY id DESC LIMIT 1`, new Date(new Date().setHours(0, 0, 0, 0)).getTime() - 86_400_000
    )!
    app.db.run(`UPDATE sales SET status = 'void', voided_at = ? WHERE id = ?`, Date.now(), old.id)
    const after = (await app.call('dashboard', 'summary', {})) as DashboardSummary
    const sum = (d: DashboardSummary) => d.last30.reduce((a, x) => a + x.sales, 0)
    expect(sum(after)).toBe(sum(before) - old.total)
  })

  it('warm latency stays interactive (generous ceiling)', async () => {
    await app.call('dashboard', 'summary', {})
    const t: number[] = []
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now()
      await app.call('dashboard', 'summary', {})
      t.push(performance.now() - t0)
    }
    expect(Math.min(...t)).toBeLessThan(80)
  })

  it('the cold build is sliced: the event loop gets control back many times while it runs', async () => {
    // bump the stamp by voiding another old sale so the history must be rebuilt
    const old = app.db.get<{ id: number }>(`SELECT id FROM sales WHERE status = 'completed' AND created_at < ? ORDER BY id LIMIT 1`, Date.now() - 3 * 86_400_000)!
    app.db.run(`UPDATE sales SET status = 'void', voided_at = ? WHERE id = ?`, Date.now(), old.id)
    let ticks = 0
    const iv = setInterval(() => ticks++, 1)
    await app.call('dashboard', 'summary', {})
    clearInterval(iv)
    expect(ticks).toBeGreaterThan(3)
  })
})

describe('reports: cached, paged, bounded payloads', () => {
  const f = { preset: 'last_30' }
  it('running the same report twice executes its SQL once', async () => {
    await app.call('reports', 'run', { id: 'item_sales', filters: f }) // warm + populate
    const { sql } = await recordSql(() => app.call('reports', 'run', { id: 'item_sales', filters: f }))
    expect(sql.filter((s) => /WITH lines AS/.test(s))).toEqual([])
  })
  it('a write invalidates the cached report', async () => {
    const a = (await app.call('reports', 'run', { id: 'sales_summary', filters: f })) as ReportResult
    app.db.run("INSERT INTO settings(key,value) VALUES ('perf.touch','1') ON CONFLICT(key) DO UPDATE SET value = value || '1'")
    const { sql } = await recordSql(() => app.call('reports', 'run', { id: 'sales_summary', filters: f }))
    expect(sql.length).toBeGreaterThan(0)
    expect(a.rows.length).toBeGreaterThan(0)
  })
  it('runPage returns one page (sorted server-side), not the whole listing', async () => {
    const full = (await app.call('reports', 'run', { id: 'sales_detail', filters: f })) as ReportResult
    expect(full.rows.length).toBeGreaterThan(500)
    const page = (await app.call('reports', 'runPage', { id: 'sales_detail', filters: f, offset: 0, limit: 100, sort: { key: 'total', dir: -1 } })) as ReportResult & { totalRows: number }
    expect(page.rows).toHaveLength(100)
    expect(page.totalRows).toBe(full.rows.length)
    const totals = page.rows.map((r) => Number(r.total))
    expect([...totals].sort((x, y) => y - x)).toEqual(totals)
    expect(Math.max(...full.rows.map((r) => Number(r.total)))).toBe(totals[0])
    expect(JSON.stringify(page).length).toBeLessThan(JSON.stringify(full).length / 4)
    const page2 = (await app.call('reports', 'runPage', { id: 'sales_detail', filters: f, offset: 100, limit: 100, sort: { key: 'total', dir: -1 } })) as ReportResult
    expect(page2.rows[0]).not.toEqual(page.rows[0])
  })
})

describe('inventory: totals cached, lists bounded', () => {
  it('stock() page: totals are computed once per filter until something is written', async () => {
    await app.call('inventory', 'stock', { limit: 50 })
    const { result, sql } = await recordSql(() => app.call('inventory', 'stock', { limit: 50, offset: 50 }) as Promise<any>)
    expect(result.rows).toHaveLength(50)
    expect(sql.filter((s) => /COUNT\(\*\) total/.test(s))).toEqual([])
  })
  it('countGet pages its items (a full-catalogue count sheet has thousands of lines)', async () => {
    const c: any = await app.call('inventory', 'countCreate', {})
    const r: any = await app.call('inventory', 'countGet', { id: c.id })
    expect(r.items.length).toBeLessThanOrEqual(200)
    expect(r.total).toBeGreaterThan(1000)
    const r2: any = await app.call('inventory', 'countGet', { id: c.id, offset: 200, limit: 50 })
    expect(r2.items).toHaveLength(50)
  })
  it('verifyLedger caps the mismatches it returns', async () => {
    const r: any = await app.call('inventory', 'verifyLedger', {})
    expect(r.mismatches.length).toBeLessThanOrEqual(500)
    expect(r.checked).toBeGreaterThan(1000)
  })
  it('product search stops early for common words and stays correct', () => {
    const rows = app.lookup.search('rock', 30)
    expect(rows.length).toBe(30)
    expect(rows.every((r) => /rock/i.test(r.displayName) || /rock/i.test(r.sku))).toBe(true)
  })
})

describe('sync status badge', () => {
  it('is a single cheap call and does no queue counting when sync is off', async () => {
    const { result, sql } = await recordSql(() => app.call('sync', 'badge', {}) as Promise<any>)
    expect(result).toMatchObject({ enabled: false, pending: 0 })
    expect(sql.filter((s) => /sync_queue/.test(s))).toEqual([])
  })
})

describe('backup runs off the main thread', () => {
  it('createAsync keeps the event loop responsive on a large database and produces a verified, restorable backup', async () => {
    // pad the database so the snapshot takes long enough for a synchronous implementation to be obvious (~48 MB)
    app.db.exec('CREATE TABLE IF NOT EXISTS perf_pad(b BLOB)')
    app.db.transaction(() => { for (let i = 0; i < 48; i++) app.db.run('INSERT INTO perf_pad(b) VALUES (zeroblob(1048576))') })
    const svc = app.get<BackupService>('backup')
    let last = performance.now()
    let maxGap = 0
    const iv = setInterval(() => {
      const now = performance.now()
      maxGap = Math.max(maxGap, now - last)
      last = now
    }, 5)
    const t0 = performance.now()
    const r = await svc.createAsync({ kind: 'manual', folder: join(dir, 'bk') })
    const took = performance.now() - t0
    clearInterval(iv)
    expect(r.verified).toBe(true)
    expect(r.problems).toEqual([])
    expect(existsSync(r.path)).toBe(true)
    expect(statSync(r.path).size).toBe(r.manifest.sizeBytes)
    expect(r.manifest.tables.sales).toBe(app.db.value<number>('SELECT COUNT(*) FROM sales'))
    expect(svc.verify({ id: r.id }).ok).toBe(true)
    // the main thread only does the small bookkeeping insert: no gap anywhere near the backup duration
    expect(maxGap).toBeLessThan(Math.max(300, took / 2))
    app.db.exec('DROP TABLE perf_pad')
  }, 120_000)

  it('the scheduler path (runIfDueAsync) backs up when due and never when a backup is running', async () => {
    const svc = app.get<BackupService>('backup')
    app.setSetting('backup.folder', join(dir, 'bk2'))
    app.setSetting('backup.interval_hours', '1')
    const [a, b] = await Promise.all([svc.runIfDueAsync(Date.now() + 2 * 3600_000), svc.runIfDueAsync(Date.now() + 2 * 3600_000)])
    expect([a, b].filter(Boolean)).toHaveLength(1)
  }, 60_000)
})

import { z } from 'zod'
import type { App } from '../../core/app'
import type { Db } from '../../db/driver'
import type { DashboardSummary, DayStats } from '@shared/reports'
import { SALE_OK, SALE_VOID, avg, fmtDate, linesCte } from './engine'
import { StampCache } from './cache'
import { lowStockCountCached } from '../inventory/lowstock'

const n = (v: unknown): number => Number(v) || 0
const pct2 = (x: number, total: number): number => (total === 0 ? 0 : Math.round((x * 10000) / total) / 100)

interface Agg { variantId: number; categoryId: number | null; name: string; sku: string; qty: number; revenue: number }
/** Everything the dashboard derives from a span of whole local days. Windows are additive, so history + today can be merged. */
interface Win {
  heat: Map<string, { weekday: number; hour: number; bills: number; sales: number }>
  perDay: Map<string, { sales: number; bills: number; returns: number }>
  items: Map<string, Agg>
  pays: Map<string, number>
}
/** Per-variant and per-category revenue folded out of a Win's (variant, category) rows. */
interface Derived { byVariant: Map<number, Agg>; byCat: Map<number | null, number>; top: Agg[] }
/** How many leaders of the history are kept sorted: enough to merge any realistic number of today's movers into a top-10. */
const TOP_KEEP = 400
type DashCtx = ReturnType<DashboardService['ctx']>
interface History { win: Win; derived: Derived; yesterday: DayStats }

/**
 * Read-only dashboard data. summary() is a handful of indexed range queries (see migrations 400/401/800).
 *
 * The 30-day aggregates dominate the cost (items + payments + heat over ~16k bills = ~150 ms on a busy shop), but
 * everything before today only changes when an old sale is voided/imported. So the history part is computed once per day
 * and re-used while a cheap fingerprint (bill count in the window, void count/latest void, latest return id, return count,
 * number of permanently deleted bills) is unchanged;
 * only TODAY's slice is queried live and merged. Result: warm calls are a few ms, and a sale made a second ago still shows.
 */
export class DashboardService {
  private history = new StampCache<History>(8, 10 * 60_000)
  private inflight = new Map<string, Promise<History>>()

  constructor(private app: App) { }

  /** Cheap fingerprint of "has anything before today changed?" (index-only). */
  private historyStamp(db: Db, start30: number, todayStart: number): string {
    const r = db.get<Record<string, number>>(
      `SELECT (SELECT COUNT(*) FROM sales WHERE created_at >= ? AND created_at < ?) AS bills,
              (SELECT COUNT(*) FROM sales WHERE voided_at IS NOT NULL) AS voids,
              (SELECT COALESCE(MAX(voided_at),0) FROM sales WHERE voided_at IS NOT NULL) AS lastVoid,
              (SELECT COALESCE(MAX(id),0) FROM sale_returns) AS lastReturn,
              (SELECT COUNT(*) FROM sale_returns) AS returns,
              (SELECT COUNT(*) FROM deleted_sales) AS deleted`,
      start30, todayStart
    )!
    // `returns` + `deleted`: a permanently deleted bill (pos.deleteSale, or one removed by sync) takes its return notes with it
    return `${todayStart}|${r.bills}|${r.voids}|${r.lastVoid}|${r.lastReturn}|${r.returns}|${r.deleted}`
  }

  /** Aggregates for the whole local days in [from, to). */
  private window(db: Db, from: number, to: number): Win {
    const win: Win = { heat: new Map(), perDay: new Map(), items: new Map(), pays: new Map() }
    if (to <= from) return win
    // weekday x hour grid (few groups => cheap)
    for (const r of db.all<{ k: string; bills: number; total: number }>(
      `SELECT strftime('%w%H', s.created_at / 1000, 'unixepoch', 'localtime') AS k, COUNT(*) AS bills, SUM(s.total) AS total
       FROM sales s WHERE ${SALE_OK} AND s.created_at >= ? AND s.created_at < ? GROUP BY k`, from, to
    )) win.heat.set(r.k, { weekday: Number(r.k[0]), hour: Number(r.k.slice(1)), bills: n(r.bills), sales: n(r.total) })

    // per-day totals via index-range lookups on local day boundaries
    const dayStmt = db.raw.prepare(`SELECT COUNT(*) AS bills, COALESCE(SUM(s.total),0) AS total FROM sales s WHERE ${SALE_OK} AND s.created_at >= ? AND s.created_at < ?`)
    for (let lo = from; lo < to;) {
      const d = new Date(lo)
      const hi = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime()
      const r = dayStmt.get(lo, hi) as { bills: number; total: number }
      win.perDay.set(fmtDate(d), { sales: n(r.total), bills: n(r.bills), returns: 0 })
      lo = hi
    }
    for (const r of db.all<{ d: string; total: number }>(
      `SELECT strftime('%Y-%m-%d', r.created_at / 1000, 'unixepoch', 'localtime') AS d, SUM(r.total) AS total
       FROM sale_returns r JOIN sales s ON s.id = r.sale_id WHERE ${SALE_OK} AND r.created_at >= ? AND r.created_at < ? GROUP BY d`, from, to
    )) {
      const e = win.perDay.get(r.d) ?? { sales: 0, bills: 0, returns: 0 }
      e.returns = n(r.total)
      win.perDay.set(r.d, e)
    }

    // items: sold minus returned, per variant+category
    const fold = (sign: 1 | -1, rows: Record<string, unknown>[]) => {
      for (const r of rows) {
        const cid = r.cid == null ? null : n(r.cid)
        const k = `${r.vid}|${cid}`
        const a = win.items.get(k) ?? { variantId: n(r.vid), categoryId: cid, name: '', sku: '', qty: 0, revenue: 0 }
        a.qty += sign * n(r.qty); a.revenue += sign * n(r.rev)
        win.items.set(k, a)
      }
    }
    fold(1, db.all(
      `SELECT si.variant_id AS vid, si.category_id AS cid, SUM(si.qty) AS qty, SUM(si.line_total) AS rev
       FROM sale_items si JOIN sales s ON s.id = si.sale_id WHERE ${SALE_OK} AND s.created_at >= ? AND s.created_at < ? GROUP BY si.variant_id, si.category_id`,
      from, to
    ))
    fold(-1, db.all(
      `SELECT si.variant_id AS vid, si.category_id AS cid, SUM(ri.qty) AS qty, SUM(ri.line_total) AS rev
       FROM sale_return_items ri JOIN sale_returns r ON r.id = ri.return_id JOIN sale_items si ON si.id = ri.sale_item_id JOIN sales s ON s.id = r.sale_id
       WHERE ${SALE_OK} AND r.created_at >= ? AND r.created_at < ? GROUP BY si.variant_id, si.category_id`,
      from, to
    ))

    for (const r of db.all<{ method: string; amount: number }>(
      `SELECT sp.method AS method, SUM(sp.amount) AS amount FROM sale_payments sp JOIN sales s ON s.id = sp.sale_id
       WHERE ${SALE_OK} AND s.created_at >= ? AND s.created_at < ? GROUP BY sp.method`, from, to
    )) win.pays.set(r.method, n(r.amount))
    return win
  }

  ctx(opts: { now?: number }) {
    const app = this.app
    app.requireSession()
    const db = app.db
    const full = app.can('reports.view')
    const canProfit = full && app.can('reports.profit')
    const now = opts.now ?? Date.now()
    const t = new Date(now)
    const y = t.getFullYear(), m = t.getMonth(), d = t.getDate()
    const todayStart = new Date(y, m, d).getTime()
    const tomorrowStart = new Date(y, m, d + 1).getTime()
    const yStart = new Date(y, m, d - 1).getTime()
    const start30 = new Date(y, m, d - 29).getTime()
    const userId = full ? null : app.session!.userId

    const dayStats = (a: number, b: number): DayStats => {
      const uw = userId == null ? '' : ' AND s.user_id = ?'
      const up = userId == null ? [] : [userId]
      const s = db.get<{ bills: number; total: number }>(
        `SELECT COUNT(*) AS bills, COALESCE(SUM(s.total),0) AS total FROM sales s WHERE ${SALE_OK} AND s.created_at >= ? AND s.created_at < ?${uw}`,
        a, b, ...up
      )!
      const ret = n(db.value<number>(
        `SELECT COALESCE(SUM(r.total),0) FROM sale_returns r JOIN sales s ON s.id = r.sale_id WHERE ${SALE_OK} AND r.created_at >= ? AND r.created_at < ?${userId == null ? '' : ' AND r.user_id = ?'}`,
        a, b, ...up
      ))
      let gp: number | null = null
      if (canProfit) {
        gp = n(db.value<number>(`WITH ${linesCte(a, b - 1, {})} SELECT COALESCE(SUM(l.total - l.tax - l.cost),0) FROM lines l`))
      }
      return { sales: n(s.total), bills: n(s.bills), avgBill: avg(n(s.total), n(s.bills)), returns: ret, grossProfit: gp }
    }

    // history (before today) is cached per day; for restricted users it is just yesterday's own figures
    const hKey = `${full ? 'f' : 'u' + userId}|${canProfit ? 'p' : '-'}`
    const hStamp = full ? this.historyStamp(db, start30, todayStart) : `${todayStart}`
    return { app, db, full, now, y, m, d, todayStart, tomorrowStart, yStart, start30, dayStats, hKey, hStamp }
  }

  /**
   * Builds the cached part. A generator so the cold build (~150 ms of SQL for a busy shop) can be sliced into per-day steps
   * of a few ms each: summaryAsync() hands the event loop back between steps, so cashiers never feel the first dashboard load.
   */
  private *buildHistory(c: DashCtx): Generator<void, History> {
    const win: Win = { heat: new Map(), perDay: new Map(), items: new Map(), pays: new Map() }
    if (c.full) {
      for (let lo = c.start30; lo < c.todayStart;) {
        const nd = new Date(lo)
        const hi = new Date(nd.getFullYear(), nd.getMonth(), nd.getDate() + 1).getTime()
        this.addWin(win, this.window(c.db, lo, hi))
        lo = hi
        yield
      }
    }
    const derived = this.derive(c.db, win, true)
    win.items = new Map() // only the folded form is needed from here on (the raw rows are ~16k entries)
    yield
    return { win, derived, yesterday: c.dayStats(c.yStart, c.todayStart) }
  }

  private historyFor(c: DashCtx): History {
    const hit = this.history.get(c.hKey, c.hStamp)
    if (hit) return hit
    const gen = this.buildHistory(c)
    for (; ;) {
      const r = gen.next()
      if (r.done) return this.history.set(c.hKey, c.hStamp, r.value)
    }
  }

  summary(opts: { now?: number } = {}): DashboardSummary {
    const c = this.ctx(opts)
    return this.assemble(c, this.historyFor(c))
  }

  /** The cached history, building it (sliced, yielding to the event loop between steps) if missing. Concurrent callers share one build. */
  private historyAsync(c: DashCtx): Promise<History> {
    const hit = this.history.get(c.hKey, c.hStamp)
    if (hit) return Promise.resolve(hit)
    const k = `${c.hKey}|${c.hStamp}`
    let p = this.inflight.get(k)
    if (!p) {
      p = (async () => {
        const gen = this.buildHistory(c)
        for (; ;) {
          const r = gen.next()
          if (r.done) return this.history.set(c.hKey, c.hStamp, r.value)
          await new Promise<void>((res) => setImmediate(res))
        }
      })().finally(() => this.inflight.delete(k))
      this.inflight.set(k, p)
    }
    return p
  }

  /** Same result as summary(); a cold history build yields to the event loop between small steps. */
  async summaryAsync(opts: { now?: number } = {}): Promise<DashboardSummary> {
    const c = this.ctx(opts)
    const hist = await this.historyAsync(c)
    return this.assemble(this.ctx(opts), hist)
  }

  /** Warm the cache in the background (called right after sign-in) so the first dashboard paint is instant. Never throws. */
  prewarm(): void {
    try {
      void this.historyAsync(this.ctx({})).catch(() => undefined)
    } catch {
      /* not signed in */
    }
  }

  private assemble(c: DashCtx, hist: History): DashboardSummary {
    const { app, db, full, now, y, m, d, todayStart, tomorrowStart, yStart, dayStats } = c
    const today = dayStats(todayStart, tomorrowStart)
    const yesterday = hist.yesterday
    const yesterdaySoFar = dayStats(yStart, Math.min(todayStart, yStart + (now - todayStart) + 1))

    const out: DashboardSummary = {
      generatedAt: now, restricted: !full, today, yesterday, yesterdaySoFar,
      last7: [], last30: [], topProducts: [], categoryShare: [], paymentMix: [], heatmap: [],
      lowStockCount: 0, openShift: null, pendingSync: 0, recentSales: []
    }

    // ---- operational counters (everyone)
    out.lowStockCount = lowStockCountCached(db)
    // only meaningful when multi-POS / cloud sync is switched on; otherwise the queue is just a local journal
    out.pendingSync = app.setting('sync.enabled', '0') === '1' ? n(db.value<number>(`SELECT COUNT(*) FROM sync_queue WHERE status = 'pending'`)) : 0
    const shift = db.get<Record<string, unknown>>(
      `SELECT sh.id, sh.pos_id, sh.opened_at, sh.opening_cash, pt.name AS pos_name, u.name AS user_name
       FROM shifts sh LEFT JOIN pos_terminals pt ON pt.id = sh.pos_id LEFT JOIN users u ON u.id = sh.user_id
       WHERE sh.closed_at IS NULL AND sh.pos_id = (SELECT id FROM pos_terminals WHERE is_local = 1) ORDER BY sh.opened_at DESC LIMIT 1`
    )
    if (shift) {
      const cash = db.get<{ bills: number; cash_in: number }>(
        `SELECT COUNT(*) AS bills,
           COALESCE((SELECT SUM(sp.amount) FROM sale_payments sp JOIN sales s2 ON s2.id = sp.sale_id WHERE s2.shift_id = ? AND sp.method = 'cash' AND s2.status NOT IN ('cancelled','held','draft')),0)
           - COALESCE((SELECT SUM(sp.amount) FROM sale_payments sp JOIN sales s2 ON s2.id = sp.sale_id WHERE sp.method = 'cash' AND ${SALE_VOID.replace(/\bs\./g, 's2.')} AND COALESCE(s2.void_shift_id, s2.shift_id) = ?),0) AS cash_in
         FROM sales s WHERE s.shift_id = ? AND ${SALE_OK}`,
        n(shift.id), n(shift.id), n(shift.id)
      )!
      out.openShift = {
        id: n(shift.id), posId: n(shift.pos_id), posName: String(shift.pos_name ?? ''), userName: String(shift.user_name ?? ''),
        openedAt: n(shift.opened_at), openingCash: n(shift.opening_cash), cashSales: n(cash.cash_in), bills: n(cash.bills)
      }
    }
    if (!full) return out

    // ---- 30-day figures = cached history + today's live slice
    const tw = this.window(db, todayStart, tomorrowStart)
    const win = this.merge(hist.win, tw)
    out.heatmap = [...win.heat.values()].sort((a, b) => a.weekday - b.weekday || a.hour - b.hour)
    for (let i = 0; i < 30; i++) {
      const date = fmtDate(new Date(y, m, d - 29 + i))
      const e = win.perDay.get(date)
      out.last30.push({ date, sales: e?.sales ?? 0, bills: e?.bills ?? 0, returns: e?.returns ?? 0 })
    }
    out.last7 = out.last30.slice(-7)

    // top products / category share = cached history + today's (small) movements, without touching the 16k-entry history map
    const td = this.derive(db, tw, false)
    const byCat = new Map(hist.derived.byCat)
    for (const [cid, rev] of td.byCat) byCat.set(cid, (byCat.get(cid) ?? 0) + rev)
    const merged = new Map<number, Agg>()
    for (const [vid, a] of td.byVariant) {
      const h = hist.derived.byVariant.get(vid)
      merged.set(vid, { ...a, qty: a.qty + (h?.qty ?? 0), revenue: a.revenue + (h?.revenue ?? 0) })
    }
    // any untouched variant keeps its history value, so the overall top 10 is inside (10 + touched) history leaders
    for (const a of hist.derived.top.slice(0, 10 + td.byVariant.size)) if (!merged.has(a.variantId)) merged.set(a.variantId, a)
    out.topProducts = [...merged.values()].filter((a) => a.revenue > 0).sort((a, b) => b.revenue - a.revenue).slice(0, 10).map((a) => {
      const nm = db.get<{ name: string; sku: string }>('SELECT name, sku FROM sale_items WHERE variant_id = ? ORDER BY id DESC LIMIT 1', a.variantId)
      return { variantId: a.variantId, name: nm?.name ?? '', sku: nm?.sku ?? '', qty: a.qty, revenue: a.revenue }
    })
    const catRows = [...byCat.entries()].filter(([, rev]) => rev > 0).sort((a, b) => b[1] - a[1])
    const catTotal = catRows.reduce((s, [, rev]) => s + rev, 0)
    const catNames = new Map(db.all<{ id: number; name: string }>('SELECT id, name FROM categories').map((c) => [c.id, c.name] as [number, string]))
    out.categoryShare = catRows.map(([cid, rev]) => ({ categoryId: cid, name: cid == null ? 'Uncategorised' : catNames.get(cid) ?? 'Uncategorised', revenue: rev, sharePct: pct2(rev, catTotal) }))

    const pays = [...win.pays.entries()].map(([method, amount]) => ({ method, amount }))
    const payTotal = pays.reduce((a, p) => a + Math.max(p.amount, 0), 0)
    out.paymentMix = pays.filter((p) => p.amount > 0).sort((a, b) => b.amount - a.amount).map((p) => ({ ...p, sharePct: pct2(p.amount, payTotal) }))

    out.recentSales = db.all<Record<string, unknown>>(
      `SELECT s.id, s.invoice_no, s.created_at, c.name AS customer, u.name AS cashier, s.total, s.status
       FROM sales s LEFT JOIN customers c ON c.id = s.customer_id LEFT JOIN users u ON u.id = s.user_id ORDER BY s.created_at DESC, s.id DESC LIMIT 10`
    ).map((r) => ({ id: n(r.id), invoiceNo: String(r.invoice_no), createdAt: n(r.created_at), customerName: r.customer == null ? null : String(r.customer), cashierName: String(r.cashier ?? ''), total: n(r.total), status: String(r.status) }))
    return out
  }

  /**
   * Fold (variant, category) rows into per-variant and per-category revenue. Legacy rows without a category snapshot fall
   * back to the product's current category (looked up once per variant). `sortTop` also keeps the leaders sorted.
   */
  private derive(db: Db, win: Win, sortTop: boolean): Derived {
    const fallbackCat = new Map<number, number | null>()
    const byVariant = new Map<number, Agg>()
    const byCat = new Map<number | null, number>()
    for (const a of win.items.values()) {
      let cid = a.categoryId
      if (cid == null) {
        if (!fallbackCat.has(a.variantId)) {
          fallbackCat.set(a.variantId, db.value<number>('SELECT p.category_id FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.id = ?', a.variantId) ?? null)
        }
        cid = fallbackCat.get(a.variantId) ?? null
      }
      byCat.set(cid, (byCat.get(cid) ?? 0) + a.revenue)
      const v = byVariant.get(a.variantId)
      if (v) { v.qty += a.qty; v.revenue += a.revenue } else byVariant.set(a.variantId, { ...a })
    }
    const top = sortTop ? [...byVariant.values()].sort((x, y) => y.revenue - x.revenue).slice(0, TOP_KEEP) : []
    return { byVariant, byCat, top }
  }

  /** acc += w (mutating acc; used while building the history one day at a time). */
  private addWin(acc: Win, w: Win): void {
    for (const [k, v] of w.heat) {
      const e = acc.heat.get(k)
      if (e) { e.bills += v.bills; e.sales += v.sales } else acc.heat.set(k, { ...v })
    }
    for (const [k, v] of w.perDay) acc.perDay.set(k, v)
    for (const [k, v] of w.items) {
      const e = acc.items.get(k)
      if (e) { e.qty += v.qty; e.revenue += v.revenue } else acc.items.set(k, v)
    }
    for (const [k, v] of w.pays) acc.pays.set(k, (acc.pays.get(k) ?? 0) + v)
  }

  /** a + b without mutating the cached `a`. */
  private merge(a: Win, b: Win): Win {
    const heat = new Map<string, { weekday: number; hour: number; bills: number; sales: number }>()
    for (const [k, v] of a.heat) heat.set(k, { ...v })
    for (const [k, v] of b.heat) {
      const e = heat.get(k)
      if (e) { e.bills += v.bills; e.sales += v.sales } else heat.set(k, { ...v })
    }
    const perDay = new Map(a.perDay)
    for (const [k, v] of b.perDay) perDay.set(k, { ...v })
    const pays = new Map(a.pays)
    for (const [k, v] of b.pays) pays.set(k, (pays.get(k) ?? 0) + v)
    return { heat, perDay, items: new Map(), pays }
  }
}

export function exposeDashboard(app: App, svc: DashboardService): void {
  const args = z.object({ now: z.number().int().optional() })
  app.expose('dashboard', { summary: (a) => svc.summaryAsync(args.parse(a ?? {})) })
}

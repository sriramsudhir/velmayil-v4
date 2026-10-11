import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { z } from 'zod'
import type { App } from '../../core/app'
import { AppError } from '@shared/ipc'
import type { ReportExportResult, ReportFilters, ReportMeta, ReportOptions, ReportResult, ReportRow } from '@shared/reports'
import { fmtDate, resolveRange, shopHeader, type ReportDef } from './engine'
import { StampCache, dataStamp } from './cache'
import { salesReports } from './sales'
import { taxReports } from './tax'
import { stockReports } from './stock'
import { peopleReports } from './people'
import { displayRows, fallbackHtml, periodText, toCsv, toXlsx } from './export'

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const id = z.number().int().positive()
export const filtersSchema = z.object({
  preset: z.enum(['today', 'yesterday', 'this_week', 'last_7', 'last_30', 'this_month', 'last_month', 'this_fy', 'last_fy']).optional(),
  from: dateStr.optional(),
  to: dateStr.optional(),
  posId: id.optional(),
  userId: id.optional(),
  categoryId: id.optional(),
  brandId: id.optional(),
  paymentMethod: z.string().max(40).optional(),
  customerId: id.optional(),
  productId: id.optional(),
  variantId: id.optional(),
  supplierId: id.optional(),
  groupBy: z.string().max(20).optional(),
  days: z.number().int().min(1).max(3650).optional(),
  entity: z.string().max(60).optional(),
  action: z.string().max(60).optional(),
  search: z.string().max(100).optional(),
  inStockOnly: z.boolean().optional(),
  limit: z.number().int().min(1).max(200000).optional(),
  now: z.number().int().optional()
})

/** Treat null/'' from forms as "not set". */
const clean = (raw: unknown): ReportFilters => {
  const o: Record<string, unknown> = {}
  for (const [k, v] of Object.entries((raw ?? {}) as Record<string, unknown>)) if (v !== null && v !== '' && v !== undefined) o[k] = v
  const r = filtersSchema.safeParse(o)
  if (!r.success) throw new AppError('VALIDATION', `Invalid report filters: ${r.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`)
  return r.data
}

const runArgs = z.object({ id: z.string().min(1).max(60), filters: z.unknown().optional() })
const pageArgs = runArgs.extend({
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(2000).optional(),
  sort: z.object({ key: z.string().max(60), dir: z.union([z.literal(1), z.literal(-1)]) }).nullable().optional()
})
const exportArgs =runArgs.extend({ path: z.string().optional(), headerBlock: z.boolean().optional() })

const MIME = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv;charset=utf-8',
  pdf: 'application/pdf'
} as const

interface PrintingApi {
  renderReportHtml: (a: { title: string; subtitle?: string; columns: { key: string; header: string; align?: string }[]; rows: Record<string, unknown>[]; totals?: Record<string, unknown> }) => { html: string } | Promise<{ html: string }>
  exportPdf: (a: { html: string; path: string }) => { path: string } | Promise<{ path: string }>
}

interface CachedRun { result: ReportResult; sorted: Map<string, ReportRow[]> }

export class ReportsService {
  private cache = new StampCache<CachedRun>(8, 2 * 60_000)
  readonly defs: ReportDef[] = [...salesReports, ...taxReports, ...stockReports, ...peopleReports]
  private byId = new Map(this.defs.map((d) => [d.meta.id, d]))

  constructor(private app: App) {}

  private allowed(d: ReportDef): boolean {
    return this.app.can('reports.view') && (d.perms ?? []).every((p) => this.app.can(p))
  }

  list(): ReportMeta[] {
    this.app.requirePermission('reports.view')
    return this.defs.filter((d) => this.allowed(d)).map((d) => d.meta)
  }

  /**
   * Run a report. Throws FORBIDDEN if the user lacks reports.view (or the report's extra permission).
   * Results are cached until the next write (or 2 min): paging, sorting, re-opening and exporting the same report
   * never re-run its (hundreds of ms) SQL. Callers must treat the returned object as read-only.
   */
  run(reportId: string, rawFilters?: unknown): ReportResult {
    return this.runCached(reportId, rawFilters).result
  }

  private runCached(reportId: string, rawFilters?: unknown): CachedRun {
    this.app.requirePermission('reports.view')
    const def = this.byId.get(reportId)
    if (!def) throw new AppError('NOT_FOUND', `Unknown report "${reportId}"`)
    for (const p of def.perms ?? []) this.app.requirePermission(p)
    const f = clean(rawFilters)
    const canProfit = this.app.can('reports.profit')
    // the day is part of the key: presets like "today" resolve against the clock
    const key = `${reportId}|${canProfit ? 'p' : '-'}|${fmtDate(new Date(f.now ?? Date.now()))}|${JSON.stringify(f, Object.keys(f).sort())}`
    const stamp = dataStamp(this.app.db)
    const hit = this.cache.get(key, stamp)
    if (hit) return hit
    return this.cache.set(key, stamp, { result: this.build(def, f, canProfit), sorted: new Map() })
  }

  /**
   * One page of a report (rows sliced + optionally sorted on the server) so a 20 000-row listing never crosses IPC as one
   * multi-megabyte message. Everything but `rows` is identical to run(); `totalRows` is the full row count.
   */
  runPage(reportId: string, rawFilters: unknown, pg: { offset?: number; limit?: number; sort?: { key: string; dir: 1 | -1 } | null } = {}): ReportResult & { totalRows: number; offset: number } {
    const c = this.runCached(reportId, rawFilters)
    const r = c.result
    let rows = r.rows
    const s = pg.sort
    const colDef = s ? r.columns.find((x) => x.key === s.key) : undefined
    if (s && colDef) {
      const k = `${s.key}|${s.dir}`
      let sorted = c.sorted.get(k)
      if (!sorted) {
        const val = (row: ReportRow): number | string | null => {
          const v = row[colDef.key]
          return v == null || v === '' ? null : typeof v === 'number' ? v : v.toLowerCase()
        }
        sorted = [...r.rows].sort((a, b) => {
          const x = val(a), y = val(b)
          if (x == null && y == null) return 0
          if (x == null) return 1
          if (y == null) return -1
          return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'en-IN', { numeric: true })) * s.dir
        })
        c.sorted.set(k, sorted)
      }
      rows = sorted
    }
    const offset = Math.max(0, pg.offset ?? 0)
    const limit = Math.min(Math.max(1, pg.limit ?? 200), 2000)
    return { ...r, rows: rows.slice(offset, offset + limit), totalRows: rows.length, offset }
  }

  private build(def: ReportDef, f: ReportFilters, canProfit: boolean): ReportResult {
    const range = resolveRange(f)
    const built = def.build({ app: this.app, db: this.app.db, f, range, canProfit })
    return {
      id: def.meta.id,
      title: def.meta.title,
      subtitle: built.subtitle,
      period: def.meta.asOf ? null : range,
      columns: built.columns,
      rows: built.rows,
      totals: built.totals,
      generatedAt: f.now ?? Date.now(),
      truncated: built.truncated,
      notes: built.notes
    }
  }

  options(): ReportOptions {
    this.app.requirePermission('reports.view')
    const db = this.app.db
    const methods = new Set(['cash', 'upi', 'card', 'credit'])
    for (const r of db.all<{ method: string }>('SELECT DISTINCT method FROM sale_payments')) methods.add(r.method)
    return {
      pos: db.all('SELECT id, name FROM pos_terminals ORDER BY name'),
      cashiers: db.all('SELECT id, name FROM users ORDER BY name'),
      categories: db.all('SELECT id, name FROM categories ORDER BY name'),
      brands: db.all('SELECT id, name FROM brands ORDER BY name'),
      customers: db.all('SELECT id, name FROM customers WHERE active = 1 ORDER BY name LIMIT 2000'),
      suppliers: db.all('SELECT id, name FROM suppliers ORDER BY name'),
      paymentMethods: [...methods],
      canProfit: this.app.can('reports.profit'),
      canExport: this.app.can('reports.export')
    }
  }

  private finish(result: ReportResult, kind: 'xlsx' | 'csv' | 'pdf', data: Buffer, path?: string): ReportExportResult {
    const base = `${result.id}_${result.period ? `${result.period.from}_${result.period.to}` : new Date(result.generatedAt).toISOString().slice(0, 10)}`
    const filename = `${base}.${kind}`
    this.app.audit({ entity: 'report', entityId: result.id, action: 'export', note: `${kind.toUpperCase()} ${periodText(result)}` })
    if (path) {
      if (!isAbsolute(path)) throw new AppError('VALIDATION', 'Export path must be absolute')
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, data)
      return { filename, mime: MIME[kind], path, bytes: data.length }
    }
    return { filename, mime: MIME[kind], base64: data.toString('base64'), bytes: data.length }
  }

  private runForExport(reportId: string, filters: unknown): ReportResult {
    this.app.requirePermission('reports.export')
    return this.run(reportId, filters)
  }

  async exportXlsx(reportId: string, filters?: unknown, path?: string): Promise<ReportExportResult> {
    const r = this.runForExport(reportId, filters)
    return this.finish(r, 'xlsx', await toXlsx(r, shopHeader(this.app)), path)
  }

  exportCsv(reportId: string, filters?: unknown, path?: string, headerBlock = false): ReportExportResult {
    const r = this.runForExport(reportId, filters)
    return this.finish(r, 'csv', toCsv(r, shopHeader(this.app), headerBlock), path)
  }

  /** HTML for printing/PDF. Uses printing.renderReportHtml (shop header from the profile); falls back to a plain page. */
  async renderHtml(reportId: string, filters?: unknown): Promise<{ html: string }> {
    this.app.requirePermission('reports.view')
    const r = this.run(reportId, filters)
    return this.htmlFor(r)
  }

  private async htmlFor(r: ReportResult): Promise<{ html: string }> {
    const d = displayRows(r)
    if (this.app.has('printing')) {
      try {
        const printing = this.app.get<PrintingApi>('printing')
        if (typeof printing.renderReportHtml === 'function') {
          const out = await printing.renderReportHtml({
            title: r.title,
            subtitle: [periodText(r), r.subtitle].filter(Boolean).join(' | '),
            columns: r.columns.map((c) => ({ key: c.key, header: c.header, align: c.align ?? (c.type === 'text' ? 'left' : 'right') })),
            rows: d.rows,
            totals: d.totals
          })
          if (out?.html) return { html: out.html }
        }
      } catch {
        /* fall back */
      }
    }
    return { html: fallbackHtml(r, shopHeader(this.app)) }
  }

  async exportPdf(reportId: string, filters?: unknown, path?: string): Promise<ReportExportResult> {
    const r = this.runForExport(reportId, filters)
    if (!this.app.has('printing')) throw new AppError('PRINT_FAILED', 'Printing module is not available; cannot create PDF')
    const printing = this.app.get<PrintingApi>('printing')
    if (typeof printing.exportPdf !== 'function') throw new AppError('PRINT_FAILED', 'Printing module cannot export PDF')
    const { html } = await this.htmlFor(r)
    let target = path
    let tmp: string | undefined
    if (!target) {
      tmp = mkdtempSync(join(tmpdir(), 'velmayil-rpt-'))
      target = join(tmp, 'report.pdf')
    }
    try {
      const out = await printing.exportPdf({ html, path: target })
      const file = out?.path ?? target
      const data = readFileSync(file)
      if (path) return this.finish(r, 'pdf', data, file) // already written by printing; rewrite is harmless but skip when same path
      return this.finish(r, 'pdf', data)
    } finally {
      if (tmp) rmSync(tmp, { recursive: true, force: true })
    }
  }
}

export function exposeReports(app: App, svc: ReportsService): void {
  app.expose('reports', {
    list: () => svc.list(),
    options: () => svc.options(),
    run: (a) => { const x = runArgs.parse(a); return svc.run(x.id, x.filters) },
    runPage: (a) => { const x = pageArgs.parse(a); return svc.runPage(x.id, x.filters, x) },
    renderHtml: (a) => { const x = runArgs.parse(a); return svc.renderHtml(x.id, x.filters) },
    exportXlsx: (a) => { const x = exportArgs.parse(a); return svc.exportXlsx(x.id, x.filters, x.path) },
    exportCsv: (a) => { const x = exportArgs.parse(a); return svc.exportCsv(x.id, x.filters, x.path, x.headerBlock) },
    exportPdf: (a) => { const x = exportArgs.parse(a); return svc.exportPdf(x.id, x.filters, x.path) }
  })
}

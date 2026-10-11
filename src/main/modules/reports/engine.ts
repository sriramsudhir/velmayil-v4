import type { App } from '../../core/app'
import type { Db } from '../../db/driver'
import type { Permission } from '@shared/permissions'
import type {
  ReportColumn, ReportFilters, ReportMeta, ReportPreset, ReportResult, ReportRow
} from '@shared/reports'
import { AppError } from '@shared/ipc'

// ---------------------------------------------------------------- date handling (LOCAL time)
const pad = (n: number) => String(n).padStart(2, '0')
export const fmtDate = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
export const startOfDay = (ms: number): number => {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}
export function parseLocalDate(s: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) throw new AppError('VALIDATION', `Invalid date "${s}" (expected YYYY-MM-DD)`)
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  if (fmtDate(d) !== s) throw new AppError('VALIDATION', `Invalid date "${s}"`)
  return d
}

export interface Range { from: string; to: string; label: string; fromMs: number; toMs: number }

export function rangeFromDates(from: string, to: string, label?: string): Range {
  const a = parseLocalDate(from)
  const b = parseLocalDate(to)
  if (a.getTime() > b.getTime()) throw new AppError('VALIDATION', 'From date is after To date')
  const fromMs = a.getTime()
  const toMs = new Date(b.getFullYear(), b.getMonth(), b.getDate() + 1).getTime() - 1
  return { from, to, label: label ?? (from === to ? from : `${from} to ${to}`), fromMs, toMs }
}

export function presetRange(preset: ReportPreset, now: number): Range {
  const t = new Date(now)
  const y = t.getFullYear(), mo = t.getMonth(), d = t.getDate()
  const day = (yy: number, mm: number, dd: number) => fmtDate(new Date(yy, mm, dd))
  const today = day(y, mo, d)
  const fyStartYear = mo >= 3 ? y : y - 1
  switch (preset) {
    case 'today': return rangeFromDates(today, today, 'Today')
    case 'yesterday': { const s = day(y, mo, d - 1); return rangeFromDates(s, s, 'Yesterday') }
    case 'this_week': {
      const back = (t.getDay() + 6) % 7 // Monday start
      return rangeFromDates(day(y, mo, d - back), today, 'This week')
    }
    case 'last_7': return rangeFromDates(day(y, mo, d - 6), today, 'Last 7 days')
    case 'last_30': return rangeFromDates(day(y, mo, d - 29), today, 'Last 30 days')
    case 'this_month': return rangeFromDates(day(y, mo, 1), today, 'This month')
    case 'last_month': return rangeFromDates(day(y, mo - 1, 1), day(y, mo, 0), 'Last month')
    case 'this_fy': return rangeFromDates(day(fyStartYear, 3, 1), today, `FY ${fyStartYear}-${String((fyStartYear + 1) % 100).padStart(2, '0')}`)
    case 'last_fy': return rangeFromDates(day(fyStartYear - 1, 3, 1), day(fyStartYear, 2, 31), `FY ${fyStartYear - 1}-${String(fyStartYear % 100).padStart(2, '0')}`)
  }
}

export function resolveRange(f: ReportFilters): Range {
  const now = f.now ?? Date.now()
  if (f.from || f.to) {
    const today = fmtDate(new Date(now))
    const from = f.from ?? f.to!
    const to = f.to ?? (f.from! > today ? f.from! : today)
    return rangeFromDates(from, to)
  }
  return presetRange(f.preset ?? 'this_month', now)
}

// ---------------------------------------------------------------- context & definitions
export interface Ctx {
  app: App
  db: Db
  f: ReportFilters
  range: Range
  canProfit: boolean
}

export interface Built {
  columns: ReportColumn[]
  rows: ReportRow[]
  totals?: ReportRow
  subtitle?: string
  truncated?: boolean
  notes?: string[]
}

export interface ReportDef {
  meta: ReportMeta
  /** extra permissions on top of reports.view */
  perms?: Permission[]
  build: (ctx: Ctx) => Built
}

export const col = {
  text: (key: string, header: string, align?: ReportColumn['align']): ReportColumn => ({ key, header, type: 'text', align }),
  int: (key: string, header: string): ReportColumn => ({ key, header, type: 'int', align: 'right' }),
  money: (key: string, header: string): ReportColumn => ({ key, header, type: 'money', align: 'right' }),
  pct: (key: string, header: string): ReportColumn => ({ key, header, type: 'percent', align: 'right' }),
  date: (key: string, header: string, time = false): ReportColumn => ({ key, header, type: 'date', time })
}

/** Sum the named numeric keys over rows; `labelKey` gets "Total". */
export function totalsOf(rows: ReportRow[], keys: string[], labelKey?: string): ReportRow {
  const t: ReportRow = {}
  if (labelKey) t[labelKey] = 'Total'
  for (const k of keys) t[k] = rows.reduce((a, r) => a + (Number(r[k]) || 0), 0)
  return t
}

/** basis points ratio, rounded; null-safe */
export const bp = (num: number, den: number): number => (den === 0 ? 0 : Math.round((num * 10000) / den))
export const avg = (num: number, den: number): number => (den === 0 ? 0 : Math.round(num / den))

// ---------------------------------------------------------------- shared SQL
/** A sale counts toward sales/tax/profit unless voided or not a finished sale. */
export const SALE_OK = `s.voided_at IS NULL AND s.status NOT IN ('void','voided','cancelled','held','draft')`
export const SALE_VOID = `(s.voided_at IS NOT NULL OR s.status IN ('void','voided','cancelled'))`

type P = string | number
export interface Where { sql: string; params: P[] }

function itemPreds(f: ReportFilters): { preds: string[]; params: P[] } {
  const preds: string[] = []
  const params: P[] = []
  if (f.variantId != null) { preds.push('si.variant_id = ?'); params.push(f.variantId) }
  if (f.productId != null) { preds.push('si.variant_id IN (SELECT id FROM product_variants WHERE product_id = ?)'); params.push(f.productId) }
  if (f.categoryId != null) { preds.push('COALESCE(si.category_id,(SELECT p.category_id FROM product_variants v JOIN products p ON p.id=v.product_id WHERE v.id=si.variant_id)) = ?'); params.push(f.categoryId) }
  if (f.brandId != null) { preds.push('COALESCE(si.brand_id,(SELECT p.brand_id FROM product_variants v JOIN products p ON p.id=v.product_id WHERE v.id=si.variant_id)) = ?'); params.push(f.brandId) }
  return { preds, params }
}

/** Header-level filters on `sales s`. Item/payment filters become EXISTS (the whole bill is counted). */
export function saleWhere(f: ReportFilters): Where {
  const w: string[] = []
  const p: P[] = []
  if (f.posId != null) { w.push('s.pos_id = ?'); p.push(f.posId) }
  if (f.userId != null) { w.push('s.user_id = ?'); p.push(f.userId) }
  if (f.customerId != null) { w.push('s.customer_id = ?'); p.push(f.customerId) }
  if (f.paymentMethod) { w.push('EXISTS (SELECT 1 FROM sale_payments sp WHERE sp.sale_id = s.id AND sp.method = ?)'); p.push(f.paymentMethod) }
  const it = itemPreds(f)
  if (it.preds.length) { w.push(`EXISTS (SELECT 1 FROM sale_items si WHERE si.sale_id = s.id AND ${it.preds.join(' AND ')})`); p.push(...it.params) }
  return { sql: w.length ? ' AND ' + w.join(' AND ') : '', params: p }
}

/** Filters for `sale_returns r JOIN sales s` (pos/cashier = who processed the return; customer/payment/items = original sale). */
export function returnWhere(f: ReportFilters): Where {
  const w: string[] = []
  const p: P[] = []
  if (f.posId != null) { w.push('r.pos_id = ?'); p.push(f.posId) }
  if (f.userId != null) { w.push('r.user_id = ?'); p.push(f.userId) }
  if (f.customerId != null) { w.push('s.customer_id = ?'); p.push(f.customerId) }
  if (f.paymentMethod) { w.push('EXISTS (SELECT 1 FROM sale_payments sp WHERE sp.sale_id = s.id AND sp.method = ?)'); p.push(f.paymentMethod) }
  const it = itemPreds(f)
  if (it.preds.length) {
    w.push(`EXISTS (SELECT 1 FROM sale_return_items ri JOIN sale_items si ON si.id = ri.sale_item_id WHERE ri.return_id = r.id AND ${it.preds.join(' AND ')})`)
    p.push(...it.params)
  }
  return { sql: w.length ? ' AND ' + w.join(' AND ') : '', params: p }
}

/** Filters on the unified line set `l` (see linesCte). */
export function lineWhere(f: ReportFilters): Where {
  const w: string[] = []
  const p: P[] = []
  if (f.posId != null) { w.push('l.pos_id = ?'); p.push(f.posId) }
  if (f.userId != null) { w.push('l.user_id = ?'); p.push(f.userId) }
  if (f.customerId != null) { w.push('l.customer_id = ?'); p.push(f.customerId) }
  if (f.categoryId != null) { w.push('l.category_id = ?'); p.push(f.categoryId) }
  if (f.brandId != null) { w.push('l.brand_id = ?'); p.push(f.brandId) }
  if (f.productId != null) { w.push('l.product_id = ?'); p.push(f.productId) }
  if (f.variantId != null) { w.push('l.variant_id = ?'); p.push(f.variantId) }
  if (f.paymentMethod) { w.push('EXISTS (SELECT 1 FROM sale_payments sp WHERE sp.sale_id = l.sale_id AND sp.method = ?)'); p.push(f.paymentMethod) }
  return { sql: w.length ? ' AND ' + w.join(' AND ') : '', params: p }
}

/**
 * Unified sale + return line set. kind 'S' = sold line, 'R' = returned line (all quantities / money NEGATED so SUM() gives net).
 * Assumption (documented in ARCHITECTURE notes): sale_items.line_total is the final TAX-INCLUSIVE payable amount of the
 * line (after line discount); taxable value = line_total - tax_amount. Returns of voided sales are ignored.
 * Dates are inlined (validated integers) so SQLite can use the date indexes in both halves of the UNION.
 */
export interface LineNeeds { product?: boolean; unit?: boolean; category?: boolean; brand?: boolean }
/** Which optional product-derived columns of `lines` does this SQL text use? (so linesCte can skip the expensive joins) */
export function lineNeeds(...sql: string[]): LineNeeds {
  const t = sql.join(' ')
  return { product: /\bl\.product_id\b/.test(t), unit: /\bl\.unit\b/.test(t), category: /\bl\.category_id\b/.test(t), brand: /\bl\.brand_id\b/.test(t) }
}

export function linesCte(fromMs: number, toMs: number, needs: LineNeeds = { product: true, unit: true, category: true, brand: true }): string {
  const a = Math.trunc(fromMs), b = Math.trunc(toMs)
  // Joining variants+products for every line costs 3-5x the rest of the query on a big catalogue. product_id/unit need the
  // join; category/brand are snapshotted on the line and only fall back to the product (via a lazy subquery) when missing.
  const join = needs.product || needs.unit
  const fb = (col: string) => `(SELECT p2.${col} FROM product_variants v2 JOIN products p2 ON p2.id = v2.product_id WHERE v2.id = si.variant_id)`
  const cat = join ? 'COALESCE(si.category_id, p.category_id)' : needs.category ? `COALESCE(si.category_id, ${fb('category_id')})` : 'NULL'
  const brand = join ? 'COALESCE(si.brand_id, p.brand_id)' : needs.brand ? `COALESCE(si.brand_id, ${fb('brand_id')})` : 'NULL'
  const prod = join ? 'p.id' : 'NULL'
  const unit = join ? `COALESCE(p.unit,'pcs')` : `'pcs'`
  const joins = join ? 'LEFT JOIN product_variants v ON v.id = si.variant_id LEFT JOIN products p ON p.id = v.product_id' : ''
  return `lines AS (
  SELECT 'S' AS kind, s.id AS sale_id, s.id AS doc_id, s.invoice_no AS doc_no, s.created_at AS ts, s.pos_id AS pos_id, s.user_id AS user_id,
    s.customer_id AS customer_id, si.variant_id AS variant_id, si.name AS name, si.sku AS sku, si.hsn AS hsn,
    ${cat} AS category_id, ${brand} AS brand_id, ${prod} AS product_id,
    ${unit} AS unit, si.qty AS qty, si.qty * si.unit_price AS gross, si.discount AS discount, si.tax_rate_bp AS rate_bp,
    si.tax_amount AS tax, si.line_total AS total, si.qty * si.cost AS cost, si.price_overridden AS overridden
  FROM sale_items si JOIN sales s ON s.id = si.sale_id
  ${joins}
  WHERE ${SALE_OK} AND s.created_at BETWEEN ${a} AND ${b}
  UNION ALL
  SELECT 'R', s.id, r.id, r.return_no, r.created_at, r.pos_id, r.user_id, s.customer_id, ri.variant_id, si.name, si.sku, si.hsn,
    ${cat}, ${brand}, ${prod}, ${unit},
    -ri.qty, -ri.line_total, 0, si.tax_rate_bp, -ri.tax_amount, -ri.line_total, -(ri.qty * si.cost), 0
  FROM sale_return_items ri JOIN sale_returns r ON r.id = ri.return_id
  JOIN sale_items si ON si.id = ri.sale_item_id JOIN sales s ON s.id = r.sale_id
  ${joins}
  WHERE ${SALE_OK} AND r.created_at BETWEEN ${a} AND ${b}
)`
}

/** Local-time bucket expressions on an epoch-ms column. */
export const dayExpr = (c: string) => `strftime('%Y-%m-%d', ${c} / 1000, 'unixepoch', 'localtime')`
export const monthExpr = (c: string) => `strftime('%Y-%m', ${c} / 1000, 'unixepoch', 'localtime')`
export const hourExpr = (c: string) => `strftime('%H', ${c} / 1000, 'unixepoch', 'localtime')`

// ---------------------------------------------------------------- shop header
export interface ShopHeader { name: string; address: string; gstin: string }
export function shopHeader(app: App): ShopHeader {
  try {
    if (app.has('businessProfile')) {
      const p = app.get<{ getActive: () => { displayName?: string; shopName?: string; address?: string; city?: string; gstin?: string } }>('businessProfile').getActive()
      const name = p.displayName || p.shopName
      if (name) return { name, address: [p.address, p.city].filter(Boolean).join(', '), gstin: p.gstin ?? '' }
    }
  } catch {
    /* fall through to SQL */
  }
  const r = app.db.get<{ display_name: string; shop_name: string; address: string; city: string; gstin: string }>(
    'SELECT display_name, shop_name, address, city, gstin FROM business_profile_versions WHERE is_active = 1'
  )
  return { name: r?.display_name || r?.shop_name || '', address: [r?.address, r?.city].filter(Boolean).join(', '), gstin: r?.gstin ?? '' }
}

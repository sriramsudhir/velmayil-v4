/**
 * Reports + dashboard contracts (owned by the Reports agent).
 *
 * Conventions: money = integer paise, percent columns = integer basis points (2550 = 25.50 %), dates = epoch ms (UTC).
 * Day boundaries are LOCAL time; `from`/`to` are inclusive local calendar dates 'YYYY-MM-DD'.
 *
 * Renderer services:
 *   reports.list()                                   -> ReportMeta[]   (only reports the user may open)
 *   reports.run({ id, filters? })                    -> ReportResult
 *   reports.options()                                -> ReportOptions  (filter dropdown data)
 *   reports.exportXlsx|exportCsv|exportPdf({ id, filters?, path? })  -> ReportExportResult
 *   reports.renderHtml({ id, filters? })             -> { html } (via printing.renderReportHtml; for Print buttons)
 *   dashboard.summary({ now? })                      -> DashboardSummary
 */

export type ReportColumnType = 'text' | 'int' | 'money' | 'percent' | 'date'

export interface ReportColumn {
  key: string
  header: string
  align?: 'left' | 'right' | 'center'
  type: ReportColumnType
  /** type 'date' only: include time of day (epoch ms rendered as dd-MMM-yyyy HH:mm) */
  time?: boolean
}

/** Row values are numbers (int/money/percent/date), strings (text) or null. Keys starting with '_' are hidden drill-down refs (e.g. _saleId). */
export type ReportRow = Record<string, string | number | null>

export type ReportPreset =
  | 'today' | 'yesterday' | 'this_week' | 'last_7' | 'last_30' | 'this_month' | 'last_month' | 'this_fy' | 'last_fy'

export interface ReportFilters {
  preset?: ReportPreset
  /** inclusive local date YYYY-MM-DD */
  from?: string
  to?: string
  posId?: number
  /** cashier (sales.user_id) */
  userId?: number
  categoryId?: number
  brandId?: number
  paymentMethod?: string
  customerId?: number
  productId?: number
  variantId?: number
  supplierId?: number
  /** sales_summary / profit grouping: day|hour|month  or  day|product|category|brand */
  groupBy?: string
  /** dead_stock: no sales in the last N days (default 90) */
  days?: number
  /** audit: entity / action / free-text; stock_ledger: movement type */
  entity?: string
  action?: string
  search?: string
  /** stock reports: hide zero stock */
  inStockOnly?: boolean
  /** cap on rows for big listings (default 20000) */
  limit?: number
  /** test hook: epoch ms used as "now" for presets */
  now?: number
}

export interface ReportResult {
  id: string
  title: string
  subtitle?: string
  /** null for as-of (point in time) reports */
  period: { from: string; to: string; label: string; fromMs: number; toMs: number } | null
  columns: ReportColumn[]
  rows: ReportRow[]
  /** keyed by column key; same value types as rows */
  totals?: ReportRow
  generatedAt: number
  /** true when `limit` cut the listing */
  truncated?: boolean
  /** free-form notes, e.g. reconciliation info */
  notes?: string[]
}

export type ReportGroup = 'Sales' | 'Tax' | 'Purchases' | 'Inventory' | 'People' | 'Admin'
export interface ReportMeta {
  id: string
  title: string
  group: ReportGroup
  description: string
  /** which filters the report honours */
  filters: (keyof ReportFilters)[]
  needsProfit?: boolean
  /** report supports sorting/drill-down hints */
  asOf?: boolean
}

export interface ReportOptions {
  pos: { id: number; name: string }[]
  cashiers: { id: number; name: string }[]
  categories: { id: number; name: string }[]
  brands: { id: number; name: string }[]
  customers: { id: number; name: string }[]
  suppliers: { id: number; name: string }[]
  paymentMethods: string[]
  canProfit: boolean
  canExport: boolean
}

export interface ReportExportResult {
  filename: string
  mime: string
  /** set when a `path` was supplied and the file was written */
  path?: string
  /** set when no path was supplied (renderer triggers download) */
  base64?: string
  bytes: number
}

// ---------------- dashboard ----------------
/** sales = sum of completed bill totals (excl. voided, before returns); returns = refunds processed that day; avgBill = sales / bills */
export interface DayStats { sales: number; bills: number; avgBill: number; returns: number; grossProfit: number | null }
export interface DashboardSummary {
  generatedAt: number
  /** true when the user lacks reports.view: only own-today figures + operational counters are filled */
  restricted: boolean
  today: DayStats
  yesterday: DayStats
  /** same elapsed time-of-day yesterday, for fair "so far" comparison */
  yesterdaySoFar: DayStats
  /** sales (completed, excl. voided) and returns per local day, zero filled, oldest first */
  last7: { date: string; sales: number; bills: number; returns: number }[]
  last30: { date: string; sales: number; bills: number; returns: number }[]
  /** last 30 days by revenue */
  topProducts: { variantId: number; name: string; sku: string; qty: number; revenue: number }[]
  categoryShare: { categoryId: number | null; name: string; revenue: number; sharePct: number }[]
  /** last 30 days */
  paymentMix: { method: string; amount: number; sharePct: number }[]
  /** last 30 days: weekday 0=Sunday..6, hour 0..23 */
  heatmap: { weekday: number; hour: number; bills: number; sales: number }[]
  lowStockCount: number
  openShift: { id: number; posId: number; posName: string; userName: string; openedAt: number; openingCash: number; cashSales: number; bills: number } | null
  pendingSync: number
  recentSales: { id: number; invoiceNo: string; createdAt: number; customerName: string | null; cashierName: string; total: number; status: string }[]
}

import type { ReportColumn, ReportRow } from '@shared/reports'
import { SALE_OK, col, totalsOf, type Built, type Ctx, type ReportDef } from './engine'

const n = (v: unknown): number => Number(v) || 0
type P = string | number

/** Variants with summed stock; used by valuation / low stock / dead stock. */
function variantFilters(f: Ctx['f']): { sql: string; params: P[] } {
  const w: string[] = []
  const params: P[] = []
  if (f.categoryId != null) { w.push('p.category_id = ?'); params.push(f.categoryId) }
  if (f.brandId != null) { w.push('p.brand_id = ?'); params.push(f.brandId) }
  if (f.productId != null) { w.push('p.id = ?'); params.push(f.productId) }
  if (f.variantId != null) { w.push('v.id = ?'); params.push(f.variantId) }
  if (f.search) { w.push(`(p.name LIKE ? ESCAPE '\\' OR v.sku LIKE ? ESCAPE '\\' OR v.barcode LIKE ? ESCAPE '\\')`); const q = like(f.search); params.push(q, q, q) }
  return { sql: w.length ? ' AND ' + w.join(' AND ') : '', params }
}
/** LIKE pattern with % and _ taken literally (use with ESCAPE '\\'). */
const like = (s: string): string => `%${s.trim().replace(/[\\%_]/g, (c) => '\\' + c)}%`
const fullName = `p.name || CASE WHEN v.name <> '' THEN ' - ' || v.name ELSE '' END`
const STOCK_FROM = `product_variants v JOIN products p ON p.id = v.product_id
  LEFT JOIN categories cg ON cg.id = p.category_id LEFT JOIN brands bd ON bd.id = p.brand_id
  LEFT JOIN (SELECT variant_id, SUM(qty) AS qty FROM stock_levels GROUP BY variant_id) st ON st.variant_id = v.id`

function stockValuation({ db, f, canProfit }: Ctx): Built {
  const vf = variantFilters(f)
  const raw = db.all<Record<string, unknown>>(
    `SELECT v.id, v.sku, ${fullName} AS name, COALESCE(cg.name,'Uncategorised') AS category, COALESCE(bd.name,'') AS brand,
            COALESCE(st.qty,0) AS qty, v.cost, v.price, v.mrp
     FROM ${STOCK_FROM}
     WHERE p.track_stock = 1 AND (v.active = 1 OR COALESCE(st.qty,0) <> 0)${f.inStockOnly ? ' AND COALESCE(st.qty,0) > 0' : ''}${vf.sql}
     ORDER BY category, name`,
    ...vf.params
  )
  const rows: ReportRow[] = raw.map((r) => {
    const row: ReportRow = { sku: String(r.sku), name: String(r.name), category: String(r.category), brand: String(r.brand), qty: n(r.qty) }
    if (canProfit) { row.cost = n(r.cost); row.cost_value = n(r.qty) * n(r.cost) }
    row.price = n(r.price)
    row.retail_value = n(r.qty) * n(r.price)
    return row
  })
  const keys = ['qty', 'retail_value']
  if (canProfit) keys.push('cost_value')
  const columns: ReportColumn[] = [col.text('sku', 'SKU'), col.text('name', 'Product'), col.text('category', 'Category'), col.text('brand', 'Brand'), col.int('qty', 'Qty on hand')]
  if (canProfit) columns.push(col.money('cost', 'Unit cost'), col.money('cost_value', 'Value at cost'))
  columns.push(col.money('price', 'Selling price'), col.money('retail_value', 'Value at selling price'))
  return { columns, rows, totals: totalsOf(rows, keys, 'sku') }
}

function lowStock({ db, f }: Ctx): Built {
  const vf = variantFilters(f)
  const raw = db.all<Record<string, unknown>>(
    `SELECT v.sku, ${fullName} AS name, COALESCE(cg.name,'Uncategorised') AS category, COALESCE(st.qty,0) AS qty, v.reorder_level
     FROM ${STOCK_FROM}
     WHERE p.track_stock = 1 AND v.active = 1 AND p.active = 1 AND v.reorder_level > 0 AND COALESCE(st.qty,0) <= v.reorder_level${vf.sql}
     ORDER BY (v.reorder_level - COALESCE(st.qty,0)) DESC, name`,
    ...vf.params
  )
  const rows: ReportRow[] = raw.map((r) => ({
    sku: String(r.sku), name: String(r.name), category: String(r.category), qty: n(r.qty), reorder_level: n(r.reorder_level),
    shortfall: n(r.reorder_level) - n(r.qty)
  }))
  return {
    columns: [col.text('sku', 'SKU'), col.text('name', 'Product'), col.text('category', 'Category'), col.int('qty', 'Qty on hand'), col.int('reorder_level', 'Reorder level'), col.int('shortfall', 'Shortfall')],
    rows, totals: totalsOf(rows, ['shortfall'], 'sku')
  }
}

function stockLedger({ db, f, range, canProfit }: Ctx): Built {
  const vf = variantFilters(f)
  const limit = Math.min(f.limit ?? 20000, 200000)
  const w: string[] = []
  const params: P[] = []
  if (f.action) { w.push('m.type = ?'); params.push(f.action) }
  if (f.userId != null) { w.push('m.user_id = ?'); params.push(f.userId) }
  if (f.posId != null) { w.push('m.pos_id = ?'); params.push(f.posId) }
  const order = f.variantId != null || f.productId != null ? 'm.ts, m.id' : 'm.ts DESC, m.id DESC'
  const raw = db.all<Record<string, unknown>>(
    `SELECT m.ts, v.sku, ${fullName} AS name, m.type, m.qty_delta, m.balance_after, m.unit_cost, m.ref_type, m.ref_id, u.name AS user, l.name AS location, m.note
     FROM stock_movements m JOIN product_variants v ON v.id = m.variant_id JOIN products p ON p.id = v.product_id
     LEFT JOIN categories cg ON cg.id = p.category_id LEFT JOIN brands bd ON bd.id = p.brand_id
     LEFT JOIN users u ON u.id = m.user_id LEFT JOIN locations l ON l.id = m.location_id
     WHERE m.ts BETWEEN ? AND ?${vf.sql}${w.length ? ' AND ' + w.join(' AND ') : ''} ORDER BY ${order} LIMIT ${limit + 1}`,
    range.fromMs, range.toMs, ...vf.params, ...params
  )
  const truncated = raw.length > limit
  if (truncated) raw.pop()
  const rows: ReportRow[] = raw.map((r) => {
    const row: ReportRow = {
      date: n(r.ts), sku: String(r.sku), name: String(r.name), type: String(r.type), qty_delta: n(r.qty_delta), balance: n(r.balance_after)
    }
    if (canProfit) row.unit_cost = r.unit_cost == null ? null : n(r.unit_cost)
    row.ref = r.ref_type ? `${r.ref_type}:${r.ref_id ?? ''}` : ''
    row.user = String(r.user ?? ''); row.location = String(r.location ?? ''); row.note = String(r.note ?? '')
    return row
  })
  const columns: ReportColumn[] = [col.date('date', 'Date', true), col.text('sku', 'SKU'), col.text('name', 'Product'), col.text('type', 'Type'), col.int('qty_delta', 'Qty change'), col.int('balance', 'Balance')]
  if (canProfit) columns.push(col.money('unit_cost', 'Unit cost'))
  columns.push(col.text('ref', 'Reference'), col.text('user', 'User'), col.text('location', 'Location'), col.text('note', 'Note'))
  const inn = rows.filter((r) => n(r.qty_delta) > 0).reduce((a, r) => a + n(r.qty_delta), 0)
  const out = rows.filter((r) => n(r.qty_delta) < 0).reduce((a, r) => a + n(r.qty_delta), 0)
  return { columns, rows, totals: { date: 'Total', qty_delta: inn + out }, truncated, notes: [`Stock in ${inn}, stock out ${-out}`] }
}

function deadStock({ db, f, canProfit }: Ctx): Built {
  const days = Math.max(1, Math.trunc(f.days ?? 90))
  const now = f.now ?? Date.now()
  const cutoff = now - days * 86_400_000
  const vf = variantFilters(f)
  const raw = db.all<Record<string, unknown>>(
    `SELECT v.sku, ${fullName} AS name, COALESCE(cg.name,'Uncategorised') AS category, COALESCE(st.qty,0) AS qty, v.cost,
       (SELECT MAX(s.created_at) FROM sale_items si JOIN sales s ON s.id = si.sale_id WHERE si.variant_id = v.id AND ${SALE_OK}) AS last_sold
     FROM ${STOCK_FROM}
     WHERE p.track_stock = 1 AND v.active = 1 AND COALESCE(st.qty,0) > 0 AND v.created_at <= ?${vf.sql}
       AND NOT EXISTS (SELECT 1 FROM sale_items si JOIN sales s ON s.id = si.sale_id WHERE si.variant_id = v.id AND ${SALE_OK} AND s.created_at > ?)
     ORDER BY last_sold IS NOT NULL, last_sold, name`,
    cutoff, ...vf.params, cutoff
  )
  const rows: ReportRow[] = raw.map((r) => {
    const row: ReportRow = {
      sku: String(r.sku), name: String(r.name), category: String(r.category), qty: n(r.qty),
      last_sold: r.last_sold == null ? null : n(r.last_sold),
      days_idle: r.last_sold == null ? null : Math.floor((now - n(r.last_sold)) / 86_400_000)
    }
    if (canProfit) row.cost_value = n(r.qty) * n(r.cost)
    return row
  })
  const columns: ReportColumn[] = [col.text('sku', 'SKU'), col.text('name', 'Product'), col.text('category', 'Category'), col.int('qty', 'Qty on hand'), col.date('last_sold', 'Last sold'), col.int('days_idle', 'Days idle')]
  if (canProfit) columns.push(col.money('cost_value', 'Value at cost'))
  return { columns, rows, totals: totalsOf(rows, canProfit ? ['qty', 'cost_value'] : ['qty'], 'sku'), subtitle: `No sales in the last ${days} days` }
}

// ============================================================ purchases
function purchases({ db, f, range }: Ctx): Built {
  const w: string[] = []
  const params: P[] = []
  if (f.supplierId != null) { w.push('p.supplier_id = ?'); params.push(f.supplierId) }
  if (f.search) { w.push(`(p.number LIKE ? ESCAPE '\\' OR p.supplier_invoice_no LIKE ? ESCAPE '\\')`); params.push(like(f.search), like(f.search)) }
  const raw = db.all<Record<string, unknown>>(
    `SELECT p.id, p.number, p.created_at, COALESCE(su.name,'') AS supplier, p.supplier_invoice_no, p.status, p.subtotal, p.tax, p.total, p.paid
     FROM purchases p LEFT JOIN suppliers su ON su.id = p.supplier_id
     WHERE p.status NOT IN ('cancelled','void','voided') AND p.created_at BETWEEN ? AND ?${w.length ? ' AND ' + w.join(' AND ') : ''} ORDER BY p.created_at, p.id`,
    range.fromMs, range.toMs, ...params
  )
  const rows: ReportRow[] = raw.map((r) => ({
    number: String(r.number), date: n(r.created_at), supplier: String(r.supplier), supplier_invoice: String(r.supplier_invoice_no), status: String(r.status),
    subtotal: n(r.subtotal), tax: n(r.tax), total: n(r.total), paid: n(r.paid), due: n(r.total) - n(r.paid)
  }))
  return {
    columns: [
      col.text('number', 'Purchase no'), col.date('date', 'Date', true), col.text('supplier', 'Supplier'), col.text('supplier_invoice', 'Supplier invoice'), col.text('status', 'Status'),
      col.money('subtotal', 'Subtotal'), col.money('tax', 'Tax'), col.money('total', 'Total'), col.money('paid', 'Paid'), col.money('due', 'Due')
    ],
    rows, totals: totalsOf(rows, ['subtotal', 'tax', 'total', 'paid', 'due'], 'number')
  }
}

function supplierPayables({ db, f }: Ctx): Built {
  const w = f.supplierId != null ? ' AND su.id = ?' : ''
  const raw = db.all<Record<string, unknown>>(
    `SELECT su.id, su.name, su.phone,
       (SELECT COUNT(*) FROM purchases p WHERE p.supplier_id = su.id AND p.status NOT IN ('cancelled','void','voided')) AS bills,
       (SELECT COALESCE(SUM(total),0) FROM purchases p WHERE p.supplier_id = su.id AND p.status NOT IN ('cancelled','void','voided')) AS purchased,
       (SELECT COALESCE(SUM(paid),0) FROM purchases p WHERE p.supplier_id = su.id AND p.status NOT IN ('cancelled','void','voided')) AS paid,
       (SELECT COALESCE(SUM(total),0) FROM supplier_returns r WHERE r.supplier_id = su.id) AS returned,
       (SELECT MIN(created_at) FROM purchases p WHERE p.supplier_id = su.id AND p.total > p.paid AND p.status NOT IN ('cancelled','void','voided')) AS oldest_due
     FROM suppliers su WHERE 1=1${w} ORDER BY su.name`,
    ...(f.supplierId != null ? [f.supplierId] : [])
  )
  const rows: ReportRow[] = raw
    .map((r) => ({
      supplier: String(r.name), phone: String(r.phone ?? ''), bills: n(r.bills), purchased: n(r.purchased), paid: n(r.paid), returned: n(r.returned),
      outstanding: n(r.purchased) - n(r.paid) - n(r.returned), oldest_due: r.oldest_due == null ? null : n(r.oldest_due)
    } as ReportRow))
    .filter((r) => n(r.bills) > 0 || n(r.returned) > 0)
    .sort((a, b) => n(b.outstanding) - n(a.outstanding))
  return {
    columns: [
      col.text('supplier', 'Supplier'), col.text('phone', 'Phone'), col.int('bills', 'Purchases'), col.money('purchased', 'Purchased'), col.money('paid', 'Paid'),
      col.money('returned', 'Returned to supplier'), col.money('outstanding', 'Outstanding payable'), col.date('oldest_due', 'Oldest unpaid bill')
    ],
    rows, totals: totalsOf(rows, ['bills', 'purchased', 'paid', 'returned', 'outstanding'], 'supplier'),
    notes: ['All-time position. Outstanding = purchased - paid - supplier returns.']
  }
}

export const stockReports: ReportDef[] = [
  { meta: { id: 'stock_valuation', title: 'Inventory valuation', group: 'Inventory', description: 'Stock on hand with value at cost and selling price', filters: ['categoryId', 'brandId', 'productId', 'search', 'inStockOnly'], asOf: true }, build: stockValuation },
  { meta: { id: 'low_stock', title: 'Low stock', group: 'Inventory', description: 'Items at or below their reorder level', filters: ['categoryId', 'brandId', 'search'], asOf: true }, build: lowStock },
  { meta: { id: 'stock_ledger', title: 'Stock movement ledger', group: 'Inventory', description: 'Every stock movement with running balance', filters: ['preset', 'from', 'to', 'productId', 'variantId', 'categoryId', 'brandId', 'userId', 'posId', 'action', 'search'] }, build: stockLedger },
  { meta: { id: 'dead_stock', title: 'Dead stock', group: 'Inventory', description: 'Stock with no sales for N days', filters: ['days', 'categoryId', 'brandId', 'search'], asOf: true }, build: deadStock },
  { meta: { id: 'purchases', title: 'Purchase report', group: 'Purchases', description: 'Purchases by supplier with paid and due amounts', filters: ['preset', 'from', 'to', 'supplierId', 'search'] }, build: purchases },
  { meta: { id: 'supplier_payables', title: 'Supplier payables', group: 'Purchases', description: 'Amount owed to each supplier', filters: ['supplierId'], asOf: true }, build: supplierPayables }
]

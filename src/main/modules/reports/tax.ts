import type { ReportRow } from '@shared/reports'
import {
  SALE_OK, SALE_VOID, col, lineNeeds, lineWhere, linesCte, returnWhere, saleWhere, totalsOf, type Built, type Ctx, type ReportDef
} from './engine'

const n = (v: unknown): number => Number(v) || 0
/** Intra-state supply: tax splits equally into CGST and SGST (any odd paise goes to SGST). IGST is not tracked (no place-of-supply data). */
const split = (tax: number): { cgst: number; sgst: number } => {
  const cgst = Math.trunc(tax / 2)
  return { cgst, sgst: tax - cgst }
}

function gstGrouped(ctx: Ctx, byHsn: boolean): Built {
  const { db, f, range } = ctx
  const lw = lineWhere(f)
  const raw = db.all<Record<string, unknown>>(
    `WITH ${linesCte(range.fromMs, range.toMs, { ...lineNeeds(lw.sql), unit: byHsn })}
     SELECT ${byHsn ? 'l.hsn AS hsn, MIN(l.name) AS descr, MIN(l.unit) AS unit,' : ''} l.rate_bp AS rate_bp,
       SUM(l.qty) AS qty,
       SUM(CASE WHEN l.kind='S' THEN l.total - l.tax ELSE 0 END) AS taxable_sales,
       -SUM(CASE WHEN l.kind='R' THEN l.total - l.tax ELSE 0 END) AS taxable_returns,
       SUM(l.total - l.tax) AS taxable, SUM(l.tax) AS tax, SUM(l.total) AS value
     FROM lines l WHERE 1=1${lw.sql} GROUP BY ${byHsn ? 'l.hsn, ' : ''}l.rate_bp ORDER BY ${byHsn ? 'l.hsn, ' : ''}l.rate_bp`,
    ...lw.params
  )
  const rows: ReportRow[] = raw.map((r) => {
    const { cgst, sgst } = split(n(r.tax))
    const row: ReportRow = {}
    if (byHsn) { row.hsn = String(r.hsn ?? ''); row.descr = String(r.descr ?? ''); row.uqc = String(r.unit ?? 'pcs').toUpperCase() }
    row.rate = n(r.rate_bp)
    if (byHsn) row.qty = n(r.qty)
    row.taxable_sales = n(r.taxable_sales); row.taxable_returns = n(r.taxable_returns); row.taxable = n(r.taxable)
    row.cgst = cgst; row.sgst = sgst; row.igst = 0; row.tax = n(r.tax); row.value = n(r.value)
    return row
  })
  const first = byHsn ? 'hsn' : 'rate'
  const totals = totalsOf(rows, [...(byHsn ? ['qty'] : []), 'taxable_sales', 'taxable_returns', 'taxable', 'cgst', 'sgst', 'igst', 'tax', 'value'])
  if (first === 'hsn') totals.hsn = 'Total'
  const columns = [
    ...(byHsn ? [col.text('hsn', 'HSN/SAC'), col.text('descr', 'Description'), col.text('uqc', 'UQC')] : []),
    col.pct('rate', 'GST rate'),
    ...(byHsn ? [col.int('qty', 'Net qty')] : []),
    col.money('taxable_sales', 'Taxable (sales)'), col.money('taxable_returns', 'Taxable (returns)'), col.money('taxable', 'Net taxable value'),
    col.money('cgst', 'CGST'), col.money('sgst', 'SGST'), col.money('igst', 'IGST'), col.money('tax', 'Total tax'), col.money('value', 'Invoice value')
  ]
  return {
    columns, rows, totals,
    notes: ['Sales minus returns. Taxable value = line total - tax. CGST/SGST split equally; IGST is not applicable to intra-state retail.']
  }
}

// ============================================================ tax invoice register
const SLABS = [0, 500, 1200, 1800, 2800]
function register(ctx: Ctx): Built {
  const { db, f, range } = ctx
  const sw = saleWhere(f)
  const rw = returnWhere(f)

  interface Doc { row: ReportRow; excluded: boolean; ts: number; id: number }
  const docs = new Map<string, Doc>()
  const slabKey = (rate: number) => (SLABS.includes(rate) ? `taxable_${rate / 100}` : 'taxable_other')
  const blank = (): ReportRow => ({ taxable_0: 0, taxable_5: 0, taxable_12: 0, taxable_18: 0, taxable_28: 0, taxable_other: 0, taxable: 0, cgst: 0, sgst: 0 })

  // sale invoices (cancelled ones are listed for number continuity but excluded from totals)
  const heads = db.all<Record<string, unknown>>(
    `SELECT s.id, s.invoice_no, s.created_at, s.round_off, s.total, s.tax, ${SALE_VOID} AS is_void, COALESCE(c.name,'Walk-in') AS customer, COALESCE(c.gstin,'') AS gstin
     FROM sales s LEFT JOIN customers c ON c.id = s.customer_id
     WHERE s.status NOT IN ('held','draft') AND s.created_at BETWEEN ? AND ?${sw.sql} ORDER BY s.created_at, s.id`,
    range.fromMs, range.toMs, ...sw.params
  )
  for (const h of heads) {
    const void_ = n(h.is_void) === 1
    docs.set(`S${h.id}`, {
      id: n(h.id), ts: n(h.created_at), excluded: void_,
      row: {
        doc_no: String(h.invoice_no), type: void_ ? 'Cancelled' : 'Invoice', date: n(h.created_at), customer: String(h.customer), gstin: String(h.gstin),
        ...blank(), round_off: n(h.round_off), total: n(h.total), _saleId: n(h.id)
      }
    })
  }
  const items = db.all<Record<string, unknown>>(
    `SELECT si.sale_id, si.tax_rate_bp AS rate, SUM(si.line_total - si.tax_amount) AS taxable, SUM(si.tax_amount) AS tax
     FROM sale_items si JOIN sales s ON s.id = si.sale_id WHERE s.status NOT IN ('held','draft') AND s.created_at BETWEEN ? AND ?${sw.sql}
     GROUP BY si.sale_id, si.tax_rate_bp`,
    range.fromMs, range.toMs, ...sw.params
  )
  const taxBySale = new Map<string, number>()
  for (const it of items) {
    const d = docs.get(`S${it.sale_id}`)
    if (!d) continue
    d.row[slabKey(n(it.rate))] = n(d.row[slabKey(n(it.rate))]) + n(it.taxable)
    d.row.taxable = n(d.row.taxable) + n(it.taxable)
    taxBySale.set(`S${it.sale_id}`, (taxBySale.get(`S${it.sale_id}`) ?? 0) + n(it.tax))
  }

  // credit notes (sales returns), negative
  const rheads = db.all<Record<string, unknown>>(
    `SELECT r.id, r.return_no, r.created_at, r.total, s.id AS sale_id, COALESCE(c.name,'Walk-in') AS customer, COALESCE(c.gstin,'') AS gstin
     FROM sale_returns r JOIN sales s ON s.id = r.sale_id LEFT JOIN customers c ON c.id = s.customer_id
     WHERE ${SALE_OK} AND r.created_at BETWEEN ? AND ?${rw.sql}`,
    range.fromMs, range.toMs, ...rw.params
  )
  for (const h of rheads) {
    docs.set(`R${h.id}`, {
      id: n(h.id), ts: n(h.created_at), excluded: false,
      row: { doc_no: String(h.return_no), type: 'Credit note', date: n(h.created_at), customer: String(h.customer), gstin: String(h.gstin), ...blank(), round_off: 0, total: -n(h.total), _saleId: n(h.sale_id) }
    })
  }
  const ritems = db.all<Record<string, unknown>>(
    `SELECT ri.return_id, si.tax_rate_bp AS rate, SUM(ri.line_total - ri.tax_amount) AS taxable, SUM(ri.tax_amount) AS tax
     FROM sale_return_items ri JOIN sale_returns r ON r.id = ri.return_id JOIN sales s ON s.id = r.sale_id JOIN sale_items si ON si.id = ri.sale_item_id
     WHERE ${SALE_OK} AND r.created_at BETWEEN ? AND ?${rw.sql} GROUP BY ri.return_id, si.tax_rate_bp`,
    range.fromMs, range.toMs, ...rw.params
  )
  for (const it of ritems) {
    const d = docs.get(`R${it.return_id}`)
    if (!d) continue
    d.row[slabKey(n(it.rate))] = n(d.row[slabKey(n(it.rate))]) - n(it.taxable)
    d.row.taxable = n(d.row.taxable) - n(it.taxable)
    taxBySale.set(`R${it.return_id}`, (taxBySale.get(`R${it.return_id}`) ?? 0) - n(it.tax))
  }
  for (const [k, d] of docs) {
    const { cgst, sgst } = split(taxBySale.get(k) ?? 0)
    d.row.cgst = cgst
    d.row.sgst = sgst
    // a return that completes the bill also refunds its round-off: show it so taxable + tax + round-off = credit note value
    if (k.startsWith('R')) d.row.round_off = n(d.row.total) - n(d.row.taxable) - (taxBySale.get(k) ?? 0)
  }

  const all = [...docs.values()].sort((a, b) => a.ts - b.ts || a.row.doc_no!.toString().localeCompare(b.row.doc_no!.toString()))
  const rows = all.map((d) => d.row)
  const totals = totalsOf(all.filter((d) => !d.excluded).map((d) => d.row), ['taxable_0', 'taxable_5', 'taxable_12', 'taxable_18', 'taxable_28', 'taxable_other', 'taxable', 'cgst', 'sgst', 'round_off', 'total'], 'doc_no')
  return {
    columns: [
      col.text('doc_no', 'Document no'), col.text('type', 'Type'), col.date('date', 'Date', true), col.text('customer', 'Customer'), col.text('gstin', 'GSTIN'),
      col.money('taxable_0', 'Taxable 0%'), col.money('taxable_5', 'Taxable 5%'), col.money('taxable_12', 'Taxable 12%'), col.money('taxable_18', 'Taxable 18%'),
      col.money('taxable_28', 'Taxable 28%'), col.money('taxable_other', 'Taxable other'), col.money('taxable', 'Taxable value'),
      col.money('cgst', 'CGST'), col.money('sgst', 'SGST'), col.money('round_off', 'Round-off'), col.money('total', 'Invoice value')
    ],
    rows, totals,
    notes: ['Credit notes are negative. Cancelled invoices are listed for number continuity and excluded from totals.']
  }
}

const G = (id: string, title: string, description: string, filters: ReportDef['meta']['filters']): ReportDef['meta'] => ({ id, title, group: 'Tax', description, filters })
const F = ['preset', 'from', 'to', 'posId', 'userId', 'categoryId', 'brandId', 'paymentMethod', 'customerId', 'productId'] as ReportDef['meta']['filters']

export const taxReports: ReportDef[] = [
  { meta: G('gst_hsn', 'GST report - HSN wise', 'HSN-wise taxable value, CGST and SGST (sales minus returns), GSTR-1 table 12 layout', F), build: (c) => gstGrouped(c, true) },
  { meta: G('gst_rate', 'GST report - rate wise', 'Taxable value, CGST and SGST per GST slab (sales minus returns)', F), build: (c) => gstGrouped(c, false) },
  { meta: G('tax_register', 'Tax invoice register', 'Invoice and credit-note register with slab-wise taxable values', F), build: register }
]

import type { App } from '../../core/app'
import { AppError } from '@shared/ipc'
import type { BusinessProfile, InvoiceLine } from '@shared/types'
import type { BusinessProfileService } from '../businessProfile/service'
import type { InvoiceDocExt } from './context'

type Row = Record<string, any>

export interface BuildOpts {
  saleId?: number
  returnId?: number
  /** 'preview' = the shop block comes from the ACTIVE profile (what the owner is designing); otherwise policy-aware. */
  profileMode?: 'document' | 'preview'
  policy?: 'original' | 'current'
}

/** Build the InvoiceDoc for a stored sale / return. The profile is the version pinned on the document (policy-aware). */
/**
 * How a refund was paid out. A refund "to the original payment method" is printed as what actually happened:
 * the drawer part (refund_cash) as cash, the rest under the bill's main non-cash method.
 */
function refundPayments(db: App['db'], r: Row): { method: string; amount: number }[] {
  if (r.refund_method !== 'original') return [{ method: r.refund_method, amount: r.total }]
  const cash = Math.min(Math.max(Number(r.refund_cash) || 0, 0), r.total)
  const out: { method: string; amount: number }[] = []
  if (cash > 0) out.push({ method: 'cash', amount: cash })
  if (r.total - cash > 0) {
    const m = db.value<string>(`SELECT method FROM sale_payments WHERE sale_id = ? AND method <> 'cash' ORDER BY amount DESC, id LIMIT 1`, r.sale_id)
    out.push({ method: m ?? 'original payment method', amount: r.total - cash })
  }
  return out.length ? out : [{ method: 'cash', amount: r.total }]
}

export function buildInvoiceDoc(app: App, bp: BusinessProfileService, o: BuildOpts): InvoiceDocExt {
  const db = app.db
  const pick = (pinned: number | null | undefined): BusinessProfile => (o.profileMode === 'preview' ? bp.getActive() : bp.getForDocument(pinned, o.policy))

  if (o.returnId != null) {
    const r = db.get<Row>(
      `SELECT r.*, u.name AS user_name, p.name AS pos_name, s.invoice_no AS sale_invoice_no, s.profile_version_id AS sale_profile_version_id, s.customer_id,
              c.name AS customer_name, c.phone AS customer_phone
       FROM sale_returns r JOIN sales s ON s.id = r.sale_id LEFT JOIN users u ON u.id = r.user_id LEFT JOIN pos_terminals p ON p.id = r.pos_id
       LEFT JOIN customers c ON c.id = s.customer_id WHERE r.id = ?`,
      o.returnId
    )
    if (!r) throw new AppError('NOT_FOUND', `Return ${o.returnId} not found`)
    const items = db.all<Row>(
      `SELECT ri.*, si.name, si.sku, si.hsn, si.tax_rate_bp FROM sale_return_items ri JOIN sale_items si ON si.id = ri.sale_item_id WHERE ri.return_id = ? ORDER BY ri.id`,
      o.returnId
    )
    const lines: InvoiceLine[] = items.map((i) => ({
      name: i.name, sku: i.sku, hsn: i.hsn, qty: i.qty, unitPrice: i.unit_price, discount: 0, taxRateBp: i.tax_rate_bp, taxAmount: i.tax_amount, total: i.line_total
    }))
    return {
      invoiceNumber: r.return_no,
      createdAt: r.created_at,
      posName: r.pos_name ?? '',
      cashierName: r.user_name ?? '',
      customerName: r.customer_name ?? '',
      customerPhone: r.customer_phone ?? '',
      lines,
      subtotal: r.subtotal,
      discount: 0,
      tax: r.tax,
      roundOff: r.total - r.subtotal,
      total: r.total,
      payments: refundPayments(db, r),
      received: r.total,
      change: 0,
      isReturn: true,
      originalInvoiceNumber: r.sale_invoice_no,
      profile: pick(r.profile_version_id ?? r.sale_profile_version_id)
    }
  }

  if (o.saleId == null) throw new AppError('VALIDATION', 'saleId or returnId is required')
  const s = db.get<Row>(
    `SELECT s.*, u.name AS user_name, p.name AS pos_name, c.name AS customer_name, c.phone AS customer_phone
     FROM sales s LEFT JOIN users u ON u.id = s.user_id LEFT JOIN pos_terminals p ON p.id = s.pos_id LEFT JOIN customers c ON c.id = s.customer_id WHERE s.id = ?`,
    o.saleId
  )
  if (!s) throw new AppError('NOT_FOUND', `Sale ${o.saleId} not found`)
  const items = db.all<Row>('SELECT * FROM sale_items WHERE sale_id = ? ORDER BY id', o.saleId)
  const pays = db.all<Row>('SELECT * FROM sale_payments WHERE sale_id = ? ORDER BY id', o.saleId)
  const lines: InvoiceLine[] = items.map((i) => ({
    name: i.name, sku: i.sku, hsn: i.hsn, qty: i.qty, unitPrice: i.unit_price, discount: i.discount, taxRateBp: i.tax_rate_bp, taxAmount: i.tax_amount, total: i.line_total
  }))
  const paySum = pays.reduce((a, p) => a + p.amount, 0)
  return {
    invoiceNumber: s.invoice_no,
    createdAt: s.created_at,
    posName: s.pos_name ?? '',
    cashierName: s.user_name ?? '',
    customerName: s.customer_name ?? '',
    customerPhone: s.customer_phone ?? '',
    lines,
    subtotal: s.subtotal,
    discount: s.discount,
    tax: s.tax,
    roundOff: s.round_off,
    total: s.total,
    payments: pays.map((p) => ({ method: p.method, amount: p.amount, reference: p.reference ?? undefined })),
    received: Math.max(s.paid ?? 0, paySum),
    change: s.change_given ?? 0,
    pricesIncludeTax: !!s.prices_include_tax,
    profile: pick(s.profile_version_id)
  }
}

export function latestSaleId(app: App): number | null {
  return app.db.value<number>('SELECT id FROM sales ORDER BY id DESC LIMIT 1') ?? null
}

/** Clearly synthetic data, used ONLY when the caller explicitly asks for sample:true. The shop block still comes from the real profile. */
export function sampleInvoiceDoc(profile: BusinessProfile): InvoiceDocExt {
  const mk = (name: string, sku: string, qty: number, unit: number, bp: number, hsn: string): InvoiceLine => {
    const total = qty * unit
    const tax = Math.round((total * bp) / (10000 + bp))
    return { name, sku, hsn, qty, unitPrice: unit, discount: 0, taxRateBp: bp, taxAmount: tax, total }
  }
  const lines = [
    mk('Sample item with a rather long product name to test wrapping', 'SMP-001', 2, 12500, 1800, '3604'),
    mk('Sample item B', 'SMP-002', 1, 4950, 1800, '3604'),
    mk('Sample item C (5%)', 'SMP-003', 3, 3000, 500, '1905')
  ]
  const total = lines.reduce((a, l) => a + l.total, 0)
  const tax = lines.reduce((a, l) => a + l.taxAmount, 0)
  return {
    invoiceNumber: 'SAMPLE-0001',
    createdAt: Date.now(),
    posName: 'Counter 1',
    cashierName: 'Sample Cashier',
    customerName: 'Sample Customer',
    customerPhone: '90000 00000',
    lines,
    subtotal: total,
    discount: 0,
    tax,
    roundOff: 0,
    total,
    payments: [{ method: 'cash', amount: total + 500 }],
    received: total + 500,
    change: 500,
    pricesIncludeTax: true,
    profile
  }
}

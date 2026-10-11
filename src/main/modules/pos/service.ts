import { z } from 'zod'
import type { App } from '../../core/app'
import type { Db } from '../../db/driver'
import type { Snapshot } from '../../core/snapshot'
import { scannedUnitOf, type ScanVariant, type SellableVariant } from '../../core/lookup'
import { verifyPassword } from '../../core/crypto'
import { AppError } from '@shared/ipc'
import { hasPermission, type Permission } from '@shared/permissions'
import {
  calcBill, effectiveDiscountBp, returnShare, settlePayments, taxSummary,
  type BillTotals, type Discount
} from '@shared/billing'
import type { Page } from '@shared/types'
import { isAvailable, statusMessage, type UnitsService } from '../units/service'

// ---------------------------------------------------------------- schemas
const int = z.number().int()
const discountSchema = z
  .union([
    z.object({ type: z.literal('amount'), value: int.min(0) }),
    z.object({ type: z.literal('percent'), value: int.min(0).max(10000) })
  ])
  .nullish()

const lineSchema = z.object({
  variantId: int.positive(),
  qty: int.positive().max(1_000_000),
  /** absolute unit price in paise (same tax basis as catalog prices). Needs pos.price_override */
  unitPriceOverride: int.min(0).nullish(),
  lineDiscount: discountSchema,
  /** unit codes (PREFIX-NNNN) of the physical units sold on this line: REQUIRED for track_units products (length === qty) */
  unitCodes: z.array(z.string().trim().min(1).max(64)).max(10_000).optional()
})

const approvalSchema = z
  .object({
    /** an existing row of the `approvals` table (granted by a user with approvals.grant, <= 10 minutes old) */
    approvalId: int.positive().optional(),
    /** or credentials of an approver (password or PIN), validated here and recorded in `approvals` */
    approverUsername: z.string().optional(),
    approverPassword: z.string().optional(),
    approverPin: z.string().optional()
  })
  .nullish()

const paymentSchema = z.object({
  method: z.enum(['cash', 'upi', 'card', 'credit', 'other']),
  amount: int.positive(),
  reference: z.string().max(100).nullish()
})

const customerInline = z.object({
  name: z.string().trim().min(1).max(120),
  phone: z.string().trim().max(20).default(''),
  email: z.string().trim().max(120).default(''),
  gstin: z.string().trim().max(20).default(''),
  address: z.string().trim().max(300).default('')
})

const completeSchema = z.object({
  requestId: z.string().min(8).max(100).optional(),
  lines: z.array(lineSchema).min(1).max(500),
  billDiscount: discountSchema,
  customerId: int.positive().nullish(),
  customer: customerInline.nullish(),
  payments: z.array(paymentSchema).max(10).default([]),
  note: z.string().max(500).default(''),
  approval: approvalSchema
})
export type CompleteSaleInput = z.input<typeof completeSchema>

const cartPriceSchema = z.object({ lines: z.array(lineSchema).max(500), billDiscount: discountSchema })

const returnSchema = z.object({
  requestId: z.string().min(8).max(100).optional(),
  saleId: int.positive().optional(),
  invoiceNo: z.string().optional(),
  items: z.array(z.object({
    saleItemId: int.positive(), qty: int.positive(), restock: z.boolean().default(true),
    /** which physical units come back (required for lines that were sold with unit codes; length === qty) */
    unitCodes: z.array(z.string().trim().min(1).max(64)).max(10_000).optional()
  })).min(1),
  refundMethod: z.enum(['cash', 'original']).default('cash'),
  reason: z.string().trim().min(1).max(300)
})

const voidSchema = z.object({
  saleId: int.positive(),
  reason: z.string().trim().min(3).max(300),
  approval: approvalSchema
})

const deleteSchema = z.object({
  saleId: int.positive(),
  reason: z.string().trim().min(3).max(300),
  approval: approvalSchema
})

const listSchema = z.object({
  search: z.string().optional(),
  from: int.optional(),
  to: int.optional(),
  status: z.enum(['completed', 'void']).optional(),
  customerId: int.optional(),
  userId: int.optional(),
  limit: int.min(1).max(500).default(50),
  offset: int.min(0).default(0)
})

function parse<T extends z.ZodType>(schema: T, args: unknown): z.output<T> {
  const r = schema.safeParse(args ?? {})
  if (!r.success) {
    const first = r.error.issues[0]
    throw new AppError('VALIDATION', `${first.path.join('.') || 'input'}: ${first.message}`, r.error.issues)
  }
  return r.data
}

type Row = Record<string, unknown>
const camelKey = (k: string) => k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
export function camel<T = Row>(row: Row | undefined): T {
  if (!row) return row as unknown as T
  const out: Row = {}
  for (const [k, v] of Object.entries(row)) out[camelKey(k)] = v
  return out as T
}

// ---------------------------------------------------------------- deleted sales (tombstones)
/** One row of `deleted_sales`: the trace a permanently deleted invoice leaves behind (also what travels to other terminals). */
export interface SaleTombstone {
  uuid: string
  invoiceNo: string
  total: number
  deletedAt: number
  /** local users.id; null when the delete arrived by sync */
  deletedBy: number | null
  deletedByName: string
  reason: string
  /** pos_terminals.uuid of the terminal where the bill was deleted */
  originDevice: string
}

/** Sync payload of a sale delete (queued as entity 'sales', op 'delete'; applied by sync/apply/sales.ts). */
export function saleDeletePayload(t: SaleTombstone): Snapshot {
  return {
    table: 'sales', uuid: t.uuid, refs: {},
    row: { uuid: t.uuid, invoice_no: t.invoiceNo, total: t.total, deleted_at: t.deletedAt, deleted_by_name: t.deletedByName, reason: t.reason, origin_device: t.originDevice }
  }
}

export function saleTombstones(db: Db): SaleTombstone[] {
  return db.all<Row>('SELECT * FROM deleted_sales ORDER BY deleted_at, uuid').map((r) => ({
    uuid: r.uuid as string, invoiceNo: r.invoice_no as string, total: r.total as number, deletedAt: r.deleted_at as number,
    deletedBy: (r.deleted_by as number | null) ?? null, deletedByName: r.deleted_by_name as string, reason: r.reason as string, originDevice: r.origin_device as string
  }))
}

/**
 * Hard-delete one invoice and everything that hangs off it. Caller provides the transaction (and, on the terminal where the
 * owner deletes, has already put the stock back with app.moveStock). Used by pos.deleteSale and by inbound sync.
 *  - writes the tombstone FIRST: that is what lets the delete past the "no hard delete" triggers (migration 110) and what
 *    stops a later synced copy of the bill from coming back; the first tombstone of a uuid wins
 *  - unit codes lose their link to the bill (FK); a unit still marked sold is back on the shelf
 *  - stock_movements, audit_log and approvals are history and stay; invoice / return numbers are never reused
 * Returns the local sale id, or null when that bill is not in this database (the tombstone is still recorded).
 */
export function purgeSale(db: Db, t: SaleTombstone): number | null {
  db.run(
    'INSERT OR IGNORE INTO deleted_sales(uuid,invoice_no,total,deleted_at,deleted_by,deleted_by_name,reason,origin_device) VALUES (?,?,?,?,?,?,?,?)',
    t.uuid, t.invoiceNo, t.total, t.deletedAt, t.deletedBy, t.deletedByName, t.reason, t.originDevice
  )
  const sale = db.get<{ id: number; invoice_no: string }>('SELECT id, invoice_no FROM sales WHERE uuid = ?', t.uuid)
  if (!sale) return null
  const id = sale.id
  db.run(
    `UPDATE product_units SET status = CASE WHEN status = 'sold' THEN 'in_stock' ELSE status END, sale_id = NULL, sale_item_id = NULL, updated_at = MAX(updated_at, ?)
     WHERE sale_id = ? OR sale_item_id IN (SELECT id FROM sale_items WHERE sale_id = ?)`, t.deletedAt, id, id
  )
  // print history of the bill and of its return notes (failed jobs keep the whole receipt HTML for "retry")
  db.run(`DELETE FROM print_log WHERE doc_ref <> '' AND (doc_ref = ? OR doc_ref IN (SELECT return_no FROM sale_returns WHERE sale_id = ?))`, sale.invoice_no, id)
  db.run('DELETE FROM sale_return_items WHERE return_id IN (SELECT id FROM sale_returns WHERE sale_id = ?)', id)
  db.run('DELETE FROM sale_returns WHERE sale_id = ?', id)
  db.run('DELETE FROM sale_payments WHERE sale_id = ?', id)
  db.run('DELETE FROM sale_items WHERE sale_id = ?', id)
  db.run('DELETE FROM sales WHERE id = ?', id)
  return id
}

// ---------------------------------------------------------------- types
export interface PricedLine {
  variant: SellableVariant
  unitPrice: number
  overridden: boolean
}
export interface PricedCart {
  totals: BillTotals
  taxSummary: ReturnType<typeof taxSummary>
  lines: (PricedLine & { stockWarning: boolean })[]
}

export interface CompleteSaleResult {
  saleId: number
  invoiceNo: string
  total: number
  paid: number
  change: number
  /** true when this was a replay of an earlier request with the same requestId (nothing new was written) */
  duplicate: boolean
}

type Session = NonNullable<App['session']>

export class PosService {
  constructor(private app: App) {}

  // ---------------------------------------------------------------- helpers
  private get db() {
    return this.app.db
  }

  private settingBool(key: string, d: boolean): boolean {
    return this.app.setting(key, d ? '1' : '0') === '1'
  }

  pricesIncludeTax(): boolean {
    // Canonical key: billing.prices_include_tax (Settings page). Legacy pos.prices_include_tax is still honoured:
    // whichever of the two was written most recently wins (legacy wins a tie, as it is only ever set explicitly).
    const row = (k: string) => this.db.get<{ value: string; updated_at: number }>('SELECT value, updated_at FROM settings WHERE key = ?', k)
    const canon = row('billing.prices_include_tax')
    const legacy = row('pos.prices_include_tax')
    const pick = legacy && (!canon || legacy.updated_at >= canon.updated_at) ? legacy : canon
    return (pick?.value ?? '1') === '1'
  }

  private requireAny(...perms: Permission[]): Session {
    const s = this.app.requireSession()
    if (!perms.some((p) => hasPermission(s.permissions, p))) throw new AppError('FORBIDDEN', `Permission required: ${perms.join(' or ')}`)
    return s
  }

  /**
   * Document number. Primary terminal (code number 1, e.g. POS-01) uses series INV / RET (prefixes, digits and per-POS series come from billing.* settings) => INV-2026-000001.
   * Every other terminal embeds its code suffix so numbers never collide across terminals:
   * POS-02 => INV-02-2026-000001 (series "INV-02").
   */
  private docNumber(kind: 'invoice' | 'return'): string {
    const base = (this.app.setting(kind === 'invoice' ? 'billing.invoice_prefix' : 'billing.return_prefix', kind === 'invoice' ? 'INV' : 'RET') || (kind === 'invoice' ? 'INV' : 'RET')).toUpperCase()
    const w = Number(this.app.setting('billing.invoice_width', '6'))
    const width = Number.isInteger(w) && w >= 3 && w <= 10 ? w : 6
    const code = this.app.localPos().code
    const digits = code.match(/(\d+)\s*$/)?.[1]
    const primary = digits != null && Number(digits) === 1
    const suffix = (digits ?? code).replace(/[^A-Za-z0-9]/g, '').toUpperCase()
    // A shared series is only safe with a single terminal; with several terminals numbers must stay unique per terminal.
    const perPos = this.settingBool('billing.series_per_pos', true) || (this.db.value<number>('SELECT COUNT(*) FROM pos_terminals') ?? 1) > 1
    const series = primary || !perPos ? base : `${base}-${suffix}`
    return this.app.nextNumber(series, { prefix: series, width })
  }

  private activeProfileVersionId(): number {
    const id = this.db.value<number>('SELECT id FROM business_profile_versions WHERE is_active = 1')
    if (!id) throw new AppError('INTERNAL', 'No active business profile (complete first setup)')
    return id
  }

  private userPermissions(userId: number): string[] {
    const r = this.db.get<{ permissions: string }>('SELECT r.permissions FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ? AND u.active = 1', userId)
    if (!r) return []
    try {
      return JSON.parse(r.permissions) as string[]
    } catch {
      return []
    }
  }

  myMaxDiscountBp(): number {
    return this.maxDiscountBp(this.app.requireSession().userId)
  }

  private maxDiscountBp(userId: number): number {
    return this.db.value<number>('SELECT r.max_discount_bp FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?', userId) ?? 0
  }

  /**
   * Resolve a manager approval. Returns the approving user id, or throws APPROVAL_REQUIRED.
   *  - the signed-in user already holds approvals.grant  => self-approved (no row)
   *  - input.approvalId => existing approvals row (granted by an approvals.grant user, <= 10 min old, same action, unused)
   *  - input.approver* credentials => verified here; an `approvals` row is inserted (inside the caller's transaction)
   */
  private resolveApproval(
    a: z.infer<typeof approvalSchema>, action: string, entity: string, reason: string, detail: unknown, entityId?: string
  ): { by: number; rowId: number | null } {
    const s = this.app.requireSession()
    if (this.app.can('approvals.grant')) return { by: s.userId, rowId: null }
    const need = () => new AppError('APPROVAL_REQUIRED', `Manager approval required: ${reason}`, { action, reason })
    if (!a) throw need()
    if (a.approvalId) {
      const row = this.db.get<{ approved_by: number | null; action: string; created_at: number; entity_id: string | null }>(
        'SELECT approved_by, action, created_at, entity_id FROM approvals WHERE id = ?', a.approvalId
      )
      // auth.verifyApprover rows use the dialog's action key ('pos.void' / 'pos.discount'); the old short names stay accepted.
      // A row may be unbound (entity_id null) or pre-bound by the dialog to exactly this document; never one used for another.
      const legacy = action === 'pos.void' ? 'void_sale' : action === 'pos.discount' ? 'discount' : action
      const bound = row?.entity_id == null || (entityId != null && row.entity_id === entityId)
      if (!row || (row.action !== action && row.action !== legacy) || !row.approved_by || !bound || Date.now() - row.created_at > 10 * 60_000)
        throw new AppError('APPROVAL_REQUIRED', 'Approval is invalid, used or expired', { action })
      if (!hasPermission(this.userPermissions(row.approved_by), 'approvals.grant')) throw new AppError('FORBIDDEN', 'Approver lacks approvals.grant')
      return { by: row.approved_by, rowId: a.approvalId }
    }
    if (!a.approverUsername || !(a.approverPassword || a.approverPin)) throw need()
    const u = this.db.get<{ id: number; password_hash: string; pin_hash: string | null; active: number }>(
      'SELECT id, password_hash, pin_hash, active FROM users WHERE username = ?', a.approverUsername
    )
    const ok = !!u && u.active === 1 && ((a.approverPassword && verifyPassword(a.approverPassword, u.password_hash)) || (a.approverPin && !!u.pin_hash && verifyPassword(a.approverPin, u.pin_hash)))
    if (!ok) throw new AppError('FORBIDDEN', 'Invalid approver credentials')
    if (!hasPermission(this.userPermissions(u!.id), 'approvals.grant')) throw new AppError('FORBIDDEN', 'That user cannot grant approvals')
    const ins = this.db.run(
      'INSERT INTO approvals(action,entity,entity_id,requested_by,approved_by,reason,detail_json) VALUES (?,?,?,?,?,?,?)',
      action, entity, null, s.userId, u!.id, reason, JSON.stringify(detail ?? null)
    )
    return { by: u!.id, rowId: ins.lastId }
  }

  // ---------------------------------------------------------------- catalog access
  /**
   * Resolve a scan. For a unit code (PREFIX-NNNN) `unit` is the object {id,code,status,variantId,saleId} (`unitOfMeasure` keeps 'pcs');
   * for an ordinary barcode `unit` stays the measure string and `trackUnits` says whether the UI must ask for a unit code.
   */
  scan(code: string): ScanVariant {
    this.app.requirePermission('pos.sell')
    // exact first, then scanner-variant spellings (UPC-A <-> EAN-13, stripped zeros / check digit, GS1 wrappers, SKU case ...)
    const v: ScanVariant | undefined = this.app.lookup.byScan(String(code ?? ''))
    if (!v) throw new AppError('NOT_FOUND', `No product found for "${String(code ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim()}"`)
    // a scanned unit code that is already sold / void must never reach the bill
    const su = scannedUnitOf(v)
    if (su && !isAvailable(su.status))
      throw new AppError('CONFLICT', statusMessage(su.code, su.status), { code: 'UNIT_NOT_AVAILABLE', status: su.status, unitCode: su.code })
    if (!v.active) throw new AppError('VALIDATION', `${v.displayName} is inactive and cannot be sold`)
    return v
  }

  /** Unit-code service (null when the module is not registered, e.g. minimal test apps). */
  private get units(): UnitsService | null {
    return this.app.has('units') ? this.app.get<UnitsService>('units') : null
  }

  search(text: string, limit = 30): SellableVariant[] {
    this.app.requirePermission('pos.sell')
    if (!String(text ?? '').trim()) return []
    return this.app.lookup.search(String(text), Math.min(limit, 100))
  }

  // ---------------------------------------------------------------- pricing
  /** Resolve variants + permissions and price a cart with the shared billing math. */
  priceCart(input: z.output<typeof cartPriceSchema>): PricedCart {
    const resolved: PricedLine[] = input.lines.map((l) => {
      const variant = this.app.lookup.byId(l.variantId)
      if (!variant) throw new AppError('NOT_FOUND', `Product variant #${l.variantId} not found`)
      if (!variant.active) throw new AppError('VALIDATION', `${variant.displayName} is inactive and cannot be sold`)
      const overridden = l.unitPriceOverride != null && l.unitPriceOverride !== variant.price
      return { variant, unitPrice: overridden ? (l.unitPriceOverride as number) : variant.price, overridden }
    })
    const totals = calcBill(
      resolved.map((r, i) => ({
        qty: input.lines[i].qty,
        unitPrice: r.unitPrice,
        discount: (input.lines[i].lineDiscount ?? null) as Discount,
        taxRateBp: r.variant.taxRateBp
      })),
      {
        pricesIncludeTax: this.pricesIncludeTax(),
        billDiscount: (input.billDiscount ?? null) as Discount,
        roundToRupee: this.settingBool('pos.round_off', true)
      }
    )
    return {
      totals,
      taxSummary: taxSummary(totals.lines),
      lines: resolved.map((r, i) => ({ ...r, stockWarning: r.variant.trackStock && r.variant.stock < input.lines[i].qty }))
    }
  }

  cartPrice(args: unknown) {
    this.app.requirePermission('pos.sell')
    return this.priceCart(parse(cartPriceSchema, args))
  }

  // ---------------------------------------------------------------- customers
  private normPhone(p: string): string {
    return p.replace(/[^\d+]/g, '')
  }

  findCustomerByPhone(phone: string): Row | null {
    this.app.requirePermission('pos.sell')
    const p = this.normPhone(String(phone ?? ''))
    if (p.length < 3) return null
    return camel(this.db.get('SELECT * FROM customers WHERE phone = ? AND active = 1 ORDER BY id LIMIT 1', p)) ?? null
  }

  listCustomers(args: unknown): Page<Row> {
    this.app.requirePermission('pos.sell')
    const a = parse(z.object({ search: z.string().optional(), limit: int.min(1).max(500).default(50), offset: int.min(0).default(0) }), args)
    const q = `%${(a.search ?? '').trim().replace(/[\\%_]/g, (c) => '\\' + c)}%`
    const where = `active = 1 AND (name LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\')`
    return {
      rows: this.db.all<Row>(`SELECT * FROM customers WHERE ${where} ORDER BY name LIMIT ? OFFSET ?`, q, q, a.limit, a.offset).map((r) => camel(r)),
      total: this.db.value<number>(`SELECT COUNT(*) FROM customers WHERE ${where}`, q, q) ?? 0
    }
  }

  createCustomer(args: unknown): Row {
    this.app.requirePermission('pos.sell')
    const c = parse(customerInline, args)
    const phone = this.normPhone(c.phone)
    return this.db.transaction(() => {
      if (phone && this.db.get('SELECT id FROM customers WHERE phone = ? AND active = 1', phone))
        throw new AppError('CONFLICT', 'A customer with this phone number already exists')
      return camel(this.db.get('SELECT * FROM customers WHERE id = ?', this.insertCustomer({ ...c, phone })))
    })
  }

  /** Inserts + audits + queues a customer. Caller provides the transaction. */
  private insertCustomer(c: z.output<typeof customerInline>): number {
    const r = this.db.run('INSERT INTO customers(uuid,name,phone,email,gstin,address) VALUES (?,?,?,?,?,?)', this.app.uuid(), c.name, c.phone, c.email, c.gstin, c.address)
    this.app.audit({ entity: 'customer', entityId: r.lastId, action: 'create', new: { name: c.name, phone: c.phone } })
    this.app.enqueueSnapshot('customers', r.lastId)
    return r.lastId
  }

  // ---------------------------------------------------------------- shifts
  getCurrentShift(): Row | null {
    const s = this.app.requireSession()
    const sh =
      this.db.get('SELECT * FROM shifts WHERE pos_id = ? AND user_id = ? AND closed_at IS NULL ORDER BY id DESC LIMIT 1', s.posId, s.userId) ??
      this.db.get('SELECT * FROM shifts WHERE pos_id = ? AND closed_at IS NULL ORDER BY id DESC LIMIT 1', s.posId)
    return sh ? camel(sh) : null
  }

  private openShiftRow(): { id: number } | undefined {
    const s = this.app.requireSession()
    return (
      this.db.get<{ id: number }>('SELECT id FROM shifts WHERE pos_id = ? AND user_id = ? AND closed_at IS NULL ORDER BY id DESC LIMIT 1', s.posId, s.userId) ??
      this.db.get<{ id: number }>('SELECT id FROM shifts WHERE pos_id = ? AND closed_at IS NULL ORDER BY id DESC LIMIT 1', s.posId)
    )
  }

  openShift(args: unknown): Row {
    const s = this.app.requirePermission('pos.shift')
    const a = parse(z.object({ openingCash: int.min(0).default(0), note: z.string().max(300).default('') }), args)
    return this.db.transaction(() => {
      if (this.db.get('SELECT id FROM shifts WHERE pos_id = ? AND closed_at IS NULL', s.posId))
        throw new AppError('CONFLICT', 'A shift is already open on this terminal')
      const r = this.db.run('INSERT INTO shifts(uuid,pos_id,user_id,opening_cash,note) VALUES (?,?,?,?,?)', this.app.uuid(), s.posId, s.userId, a.openingCash, a.note)
      this.app.audit({ entity: 'shift', entityId: r.lastId, action: 'open', new: { openingCash: a.openingCash } })
      this.app.enqueueSnapshot('shifts', r.lastId)
      return camel(this.db.get('SELECT * FROM shifts WHERE id = ?', r.lastId))
    })
  }

  /** Cash/tender breakdown for a shift. expectedCash = opening + cash sales - cash refunds - cash of sales voided in this shift. */
  shiftSummary(args: unknown) {
    this.requireAny('pos.shift', 'pos.sell')
    const { shiftId } = parse(z.object({ shiftId: int.positive().optional() }), args)
    const id = shiftId ?? this.openShiftRow()?.id
    if (!id) throw new AppError('NOT_FOUND', 'No open shift')
    return this.computeShift(id)
  }

  private computeShift(id: number) {
    const sh = this.db.get<Row>('SELECT * FROM shifts WHERE id = ?', id)
    if (!sh) throw new AppError('NOT_FOUND', 'Shift not found')
    const byMethod = this.db.all<{ method: string; amount: number }>(
      `SELECT p.method, SUM(p.amount) AS amount FROM sale_payments p JOIN sales s ON s.id = p.sale_id
       WHERE s.shift_id = ? AND s.status = 'completed' GROUP BY p.method`, id
    )
    const cashIn = this.db.value<number>(`SELECT COALESCE(SUM(p.amount),0) FROM sale_payments p JOIN sales s ON s.id = p.sale_id WHERE s.shift_id = ? AND p.method = 'cash'`, id) ?? 0
    const cashVoided = this.db.value<number>(`SELECT COALESCE(SUM(p.amount),0) FROM sale_payments p JOIN sales s ON s.id = p.sale_id WHERE s.void_shift_id = ? AND p.method = 'cash'`, id) ?? 0
    const cashRefunds = this.db.value<number>('SELECT COALESCE(SUM(refund_cash),0) FROM sale_returns WHERE shift_id = ?', id) ?? 0
    const sales = this.db.get<{ n: number; total: number }>(`SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS total FROM sales WHERE shift_id = ? AND status = 'completed'`, id)!
    const returns = this.db.get<{ n: number; total: number }>('SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS total FROM sale_returns WHERE shift_id = ?', id)!
    const opening = sh.opening_cash as number
    const expectedCash = opening + cashIn - cashVoided - cashRefunds
    const closing = sh.closing_cash as number | null
    return {
      shift: camel(sh),
      openingCash: opening,
      cashSales: cashIn - cashVoided,
      cashRefunds,
      expectedCash,
      byMethod: byMethod.map((m) => ({ method: m.method, amount: m.amount })),
      salesCount: sales.n,
      salesTotal: sales.total,
      returnsCount: returns.n,
      returnsTotal: returns.total,
      closingCash: closing,
      variance: closing == null ? null : closing - expectedCash
    }
  }

  closeShift(args: unknown) {
    this.app.requirePermission('pos.shift')
    const a = parse(z.object({ shiftId: int.positive().optional(), closingCash: int.min(0), note: z.string().max(300).default('') }), args)
    return this.db.transaction(() => {
      const id = a.shiftId ?? this.openShiftRow()?.id
      if (!id) throw new AppError('NOT_FOUND', 'No open shift')
      const sh = this.db.get<Row>('SELECT * FROM shifts WHERE id = ?', id)
      if (!sh) throw new AppError('NOT_FOUND', 'Shift not found')
      if (sh.closed_at != null) throw new AppError('CONFLICT', 'Shift is already closed')
      const { expectedCash } = this.computeShift(id)
      this.db.run('UPDATE shifts SET closed_at = ?, closing_cash = ?, expected_cash = ?, note = ? WHERE id = ?', Date.now(), a.closingCash, expectedCash, a.note || (sh.note as string), id)
      this.app.audit({ entity: 'shift', entityId: id, action: 'close', new: { expectedCash, closingCash: a.closingCash, variance: a.closingCash - expectedCash }, note: a.note })
      this.app.enqueueSnapshot('shifts', id)
      return this.computeShift(id)
    })
  }

  // ---------------------------------------------------------------- hold / resume
  holdCart(args: unknown): { id: number } {
    const s = this.app.requirePermission('pos.hold')
    const a = parse(z.object({ label: z.string().max(100).default(''), cart: z.unknown() }), args)
    const json = JSON.stringify(a.cart ?? null)
    if (json.length > 1_000_000) throw new AppError('VALIDATION', 'Cart is too large to hold')
    const r = this.db.run('INSERT INTO held_carts(uuid,pos_id,user_id,label,cart_json) VALUES (?,?,?,?,?)', this.app.uuid(), s.posId, s.userId, a.label, json)
    this.app.audit({ entity: 'held_cart', entityId: r.lastId, action: 'hold', note: a.label })
    return { id: r.lastId }
  }

  listHeld() {
    const s = this.app.requirePermission('pos.hold')
    return this.db
      .all<Row>('SELECT id, label, created_at, user_id, cart_json FROM held_carts WHERE pos_id = ? ORDER BY id DESC', s.posId)
      .map((r) => {
        let cart: { lines?: unknown[]; customer?: { name?: string } | null } = {}
        try { cart = JSON.parse(r.cart_json as string) ?? {} } catch { /* ignore */ }
        return { id: r.id as number, label: r.label as string, createdAt: r.created_at as number, userId: r.user_id as number, lineCount: cart.lines?.length ?? 0, customerName: cart.customer?.name ?? '' }
      })
  }

  /** Returns the saved cart and removes it from the held list (a held cart is transient, not a business record). */
  resumeHeld(args: unknown): { id: number; label: string; cart: unknown } {
    const s = this.app.requirePermission('pos.hold')
    const { id } = parse(z.object({ id: int.positive() }), args)
    return this.db.transaction(() => {
      const r = this.db.get<Row>('SELECT * FROM held_carts WHERE id = ? AND pos_id = ?', id, s.posId)
      if (!r) throw new AppError('NOT_FOUND', 'Held bill not found')
      this.db.run('DELETE FROM held_carts WHERE id = ?', id)
      this.app.audit({ entity: 'held_cart', entityId: id, action: 'resume', note: r.label as string })
      return { id, label: r.label as string, cart: JSON.parse(r.cart_json as string) }
    })
  }

  discardHeld(args: unknown): { ok: true } {
    const s = this.app.requirePermission('pos.hold')
    const { id } = parse(z.object({ id: int.positive() }), args)
    const r = this.db.run('DELETE FROM held_carts WHERE id = ? AND pos_id = ?', id, s.posId)
    if (!r.changes) throw new AppError('NOT_FOUND', 'Held bill not found')
    this.app.audit({ entity: 'held_cart', entityId: id, action: 'discard' })
    return { ok: true }
  }

  // ---------------------------------------------------------------- complete sale
  completeSale(args: unknown): CompleteSaleResult {
    const s = this.app.requirePermission('pos.sell')
    const input = parse(completeSchema, args)

    const replay = this.replaySale(input.requestId)
    if (replay) return replay

    // permissions that depend on the content of the cart
    const hasDiscount = (input.lines.some((l) => l.lineDiscount && l.lineDiscount.value > 0)) || (!!input.billDiscount && input.billDiscount.value > 0)
    if (hasDiscount) this.app.requirePermission('pos.discount')

    return this.db.transaction(() => {
      const again = this.replaySale(input.requestId)
      if (again) return again

      const priced = this.priceCart({ lines: input.lines, billDiscount: input.billDiscount })
      const totals = priced.totals
      if (priced.lines.some((l) => l.overridden)) this.app.requirePermission('pos.price_override')

      // role discount limit -> manager approval
      let approvedBy: number | null = null
      let approval: { by: number; rowId: number | null } | null = null
      const discBp = effectiveDiscountBp(totals)
      if (discBp > this.maxDiscountBp(s.userId) && !this.app.can('pos.discount.unlimited')) {
        approval = this.resolveApproval(input.approval, 'pos.discount', 'sale', `Discount ${(discBp / 100).toFixed(2)}% exceeds your limit`, { discountBp: discBp, discount: totals.discount })
        approvedBy = approval.by
      }

      // payments (server decides what the change is)
      const pay = settlePayments(totals.total, input.payments)
      if (pay.balanceDue > 0)
        throw new AppError('VALIDATION', 'Payment is short of the bill total', { balanceDue: pay.balanceDue, total: totals.total })
      const cashTendered = input.payments.filter((p) => p.method === 'cash').reduce((a, p) => a + p.amount, 0)
      if (pay.tendered - totals.total > cashTendered)
        throw new AppError('VALIDATION', 'Overpayment is only allowed on cash (change is given in cash)')

      // customer
      let customerId = input.customerId ?? null
      if (customerId && !this.db.get('SELECT id FROM customers WHERE id = ? AND active = 1', customerId)) throw new AppError('NOT_FOUND', 'Customer not found')
      if (!customerId && input.customer) {
        const phone = this.normPhone(input.customer.phone)
        const existing = phone ? this.db.value<number>('SELECT id FROM customers WHERE phone = ? AND active = 1 ORDER BY id LIMIT 1', phone) : undefined
        customerId = existing ?? this.insertCustomer({ ...input.customer, phone })
      }
      if (input.payments.some((p) => p.method === 'credit') && !customerId)
        throw new AppError('VALIDATION', 'Choose a customer to sell on credit')

      // shift
      const shiftId = this.openShiftRow()?.id ?? null
      if (!shiftId && this.settingBool('pos.require_shift', false)) throw new AppError('CONFLICT', 'Open a cash shift before billing')

      const invoiceNo = this.docNumber('invoice')
      const now = Date.now()
      const sale = this.db.run(
        `INSERT INTO sales(uuid,invoice_no,pos_id,shift_id,user_id,customer_id,status,subtotal,discount,tax,round_off,total,paid,change_given,
                           prices_include_tax,profile_version_id,note,request_id,approved_by,created_at)
         VALUES (?,?,?,?,?,?,'completed',?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        this.app.uuid(), invoiceNo, s.posId, shiftId, s.userId, customerId,
        totals.subtotal, totals.discount, totals.tax, totals.roundOff, totals.total, pay.tendered, pay.change,
        totals.pricesIncludeTax ? 1 : 0, this.activeProfileVersionId(), input.note, input.requestId ?? null, approvedBy, now
      )
      const saleId = sale.lastId

      const allowNeg = this.settingBool('inventory.allow_negative', false)
      // unit-coded lines: every unit must be present, distinct and available BEFORE anything is written (errors name the code)
      const unitRows = this.units ? this.units.prepareSale(input.lines) : new Map()
      totals.lines.forEach((bl, i) => {
        const pl = priced.lines[i]
        const v = pl.variant
        const itemRow = this.db.run(
          `INSERT INTO sale_items(sale_id,variant_id,name,sku,barcode,hsn,category_id,brand_id,qty,unit_price,mrp,cost,discount,tax_rate_bp,tax_amount,line_total,price_overridden)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          saleId, v.variantId, v.displayName, v.sku, v.barcode, v.hsn, v.categoryId, v.brandId,
          bl.qty, bl.unitPrice, v.mrp, v.cost, bl.discount, bl.taxRateBp, bl.taxAmount, bl.lineTotal, pl.overridden ? 1 : 0
        )
        const soldUnits = unitRows.get(i)
        if (soldUnits)
          this.units!.sellUnits({ saleId, saleItemId: itemRow.lastId, units: soldUnits, unitCost: v.cost, invoiceNo, allowNegative: allowNeg })
        else if (v.trackStock)
          this.app.moveStock({ variantId: v.variantId, delta: -bl.qty, type: 'sale', refType: 'sale', refId: saleId, unitCost: v.cost, note: invoiceNo, allowNegative: allowNeg })
        if (pl.overridden)
          this.app.audit({ entity: 'sale', entityId: saleId, action: 'price_override', old: { variantId: v.variantId, price: v.price }, new: { price: bl.unitPrice }, note: `${v.displayName} (${invoiceNo})` })
      })

      // payments are stored net of change so SUM(sale_payments.amount) === sales.total; sales.paid keeps the tendered amount
      let changeLeft = pay.change
      for (const p of input.payments) {
        let amount = p.amount
        if (p.method === 'cash' && changeLeft > 0) {
          const take = Math.min(changeLeft, amount)
          amount -= take
          changeLeft -= take
        }
        if (amount > 0) this.db.run('INSERT INTO sale_payments(sale_id,method,amount,reference) VALUES (?,?,?,?)', saleId, p.method, amount, p.reference ?? null)
      }

      this.app.audit({
        entity: 'sale', entityId: saleId, action: 'create',
        new: { invoiceNo, total: totals.total, discount: totals.discount, items: totals.lines.length, approvedBy }, note: invoiceNo
      })
      this.app.enqueueSnapshot('sales', saleId, [{ table: 'sale_items', fk: 'sale_id' }, { table: 'sale_payments', fk: 'sale_id' }])
      if (approval?.rowId) this.db.run('UPDATE approvals SET entity_id = ? WHERE id = ? AND entity_id IS NULL', String(saleId), approval.rowId)

      return { saleId, invoiceNo, total: totals.total, paid: pay.tendered, change: pay.change, duplicate: false }
    })
  }

  private replaySale(requestId?: string): CompleteSaleResult | null {
    if (!requestId) return null
    const r = this.db.get<{ id: number; invoice_no: string; total: number; paid: number; change_given: number }>(
      'SELECT id, invoice_no, total, paid, change_given FROM sales WHERE request_id = ?', requestId
    )
    return r ? { saleId: r.id, invoiceNo: r.invoice_no, total: r.total, paid: r.paid, change: r.change_given, duplicate: true } : null
  }

  // ---------------------------------------------------------------- sale lookup
  getSale(args: unknown) {
    this.requireAny('pos.sell', 'pos.reprint', 'pos.return', 'pos.void', 'pos.delete', 'reports.view')
    const a = parse(z.object({ id: int.positive().optional(), invoiceNo: z.string().optional() }), typeof args === 'number' || typeof args === 'string' ? (typeof args === 'number' ? { id: args } : { invoiceNo: args }) : args)
    return this.loadSale(a.id, a.invoiceNo)
  }

  private loadSale(id?: number, invoiceNo?: string) {
    const sale = id
      ? this.db.get<Row>('SELECT * FROM sales WHERE id = ?', id)
      : invoiceNo
        ? this.db.get<Row>('SELECT * FROM sales WHERE invoice_no = ? COLLATE NOCASE', invoiceNo.trim())
        : undefined
    if (!sale) throw new AppError('NOT_FOUND', 'Sale not found')
    const sid = sale.id as number
    const items = this.db.all<Row>('SELECT * FROM sale_items WHERE sale_id = ? ORDER BY id', sid)
    const returnedByItem = new Map<number, { qty: number; amount: number }>()
    for (const r of this.db.all<{ sale_item_id: number; qty: number; amount: number }>(
      `SELECT ri.sale_item_id, SUM(ri.qty) AS qty, SUM(ri.line_total) AS amount FROM sale_return_items ri JOIN sale_returns r ON r.id = ri.return_id WHERE r.sale_id = ? GROUP BY ri.sale_item_id`, sid
    )) returnedByItem.set(r.sale_item_id, { qty: r.qty, amount: r.amount })
    const returns = this.db.all<Row>('SELECT * FROM sale_returns WHERE sale_id = ? ORDER BY id', sid).map((r) => ({
      ...camel(r),
      items: this.db.all<Row>('SELECT * FROM sale_return_items WHERE return_id = ? ORDER BY id', r.id as number).map((x) => camel(x))
    }))
    const customer = sale.customer_id ? this.db.get<Row>('SELECT * FROM customers WHERE id = ?', sale.customer_id as number) : undefined
    const cashier = this.db.get<{ name: string }>('SELECT name FROM users WHERE id = ?', sale.user_id as number)
    const pos = this.db.get<{ name: string; code: string }>('SELECT name, code FROM pos_terminals WHERE id = ?', sale.pos_id as number)
    const codesByItem = new Map<number, string[]>()
    const backByItem = new Map<number, string[]>()
    for (const u of this.db.all<{ sale_item_id: number; code: string; status: string }>('SELECT sale_item_id, code, status FROM product_units WHERE sale_id = ? ORDER BY id', sid)) {
      (codesByItem.get(u.sale_item_id) ?? codesByItem.set(u.sale_item_id, []).get(u.sale_item_id)!).push(u.code)
      if (u.status !== 'sold') (backByItem.get(u.sale_item_id) ?? backByItem.set(u.sale_item_id, []).get(u.sale_item_id)!).push(u.code)
    }
    const lines = items.map((i) => {
      const ret = returnedByItem.get(i.id as number)
      return {
        ...camel<Row>(i), returnedQty: ret?.qty ?? 0, returnedAmount: ret?.amount ?? 0, returnableQty: (i.qty as number) - (ret?.qty ?? 0),
        /** unit codes sold on this line (empty for non-tracked products) */
        unitCodes: codesByItem.get(i.id as number) ?? [],
        /** of those, the units that are no longer out with the customer (already returned, or the bill was voided) */
        returnedUnitCodes: backByItem.get(i.id as number) ?? []
      }
    })
    return {
      ...camel<Row>(sale),
      customer: customer ? camel(customer) : null,
      customerName: (customer?.name as string) ?? '',
      customerPhone: (customer?.phone as string) ?? '',
      cashierName: cashier?.name ?? '',
      posName: pos?.name ?? '',
      posCode: pos?.code ?? '',
      items: lines,
      payments: this.db.all<Row>('SELECT * FROM sale_payments WHERE sale_id = ? ORDER BY id', sid).map((p) => camel(p)),
      returns,
      returnedTotal: returns.reduce((a, r) => a + ((r as Row).total as number), 0)
    }
  }

  listSales(args: unknown): Page<Row> {
    this.requireAny('pos.sell', 'pos.reprint', 'pos.return', 'pos.void', 'pos.delete', 'reports.view')
    const a = parse(listSchema, args)
    const w: string[] = []
    const p: (string | number)[] = []
    if (a.from != null) { w.push('s.created_at >= ?'); p.push(a.from) }
    if (a.to != null) { w.push('s.created_at <= ?'); p.push(a.to) }
    if (a.status) { w.push('s.status = ?'); p.push(a.status) }
    if (a.customerId) { w.push('s.customer_id = ?'); p.push(a.customerId) }
    if (a.userId) { w.push('s.user_id = ?'); p.push(a.userId) }
    if (a.search?.trim()) {
      const q = `%${a.search.trim().replace(/[\\%_]/g, (c) => '\\' + c)}%`
      w.push(`(s.invoice_no LIKE ? ESCAPE '\\' OR c.name LIKE ? ESCAPE '\\' OR c.phone LIKE ? ESCAPE '\\')`)
      p.push(q, q, q)
    }
    const where = w.length ? `WHERE ${w.join(' AND ')}` : ''
    const from = 'FROM sales s LEFT JOIN customers c ON c.id = s.customer_id LEFT JOIN users u ON u.id = s.user_id'
    // page first, then compute item_count / returned_total for the page rows only
    const rows = this.db.all<Row>(
      `WITH page AS (
         SELECT s.id, s.uuid, s.invoice_no, s.created_at, s.status, s.total, s.paid, s.discount, s.tax, s.customer_id,
                COALESCE(c.name,'') AS customer_name, COALESCE(c.phone,'') AS customer_phone, COALESCE(u.name,'') AS cashier_name
         ${from} ${where} ORDER BY s.id DESC LIMIT ? OFFSET ?)
       SELECT page.*,
              (SELECT COUNT(*) FROM sale_items i WHERE i.sale_id = page.id) AS item_count,
              (SELECT COALESCE(SUM(total),0) FROM sale_returns r WHERE r.sale_id = page.id) AS returned_total
       FROM page ORDER BY page.id DESC`, ...p, a.limit, a.offset
    )
    const total = a.offset === 0 && rows.length < a.limit
      ? rows.length
      : this.db.value<number>(`SELECT COUNT(*) ${from} ${where}`, ...p) ?? 0
    return { rows: rows.map((r) => camel(r)), total }
  }

  // ---------------------------------------------------------------- void
  voidSale(args: unknown) {
    const s = this.app.requirePermission('pos.void')
    const a = parse(voidSchema, args)
    return this.db.transaction(() => {
      const sale = this.db.get<Row>('SELECT * FROM sales WHERE id = ?', a.saleId)
      if (!sale) throw new AppError('NOT_FOUND', 'Sale not found')
      if (sale.status === 'void') throw new AppError('CONFLICT', 'Sale is already void')
      if (this.db.get('SELECT id FROM sale_returns WHERE sale_id = ?', a.saleId)) throw new AppError('CONFLICT', 'A sale with returns cannot be voided')
      const approval = this.resolveApproval(a.approval, 'pos.void', 'sale', `Void ${sale.invoice_no as string}: ${a.reason}`, { saleId: a.saleId, reason: a.reason }, String(a.saleId))
      const allowNeg = true // restoring stock can never be blocked
      for (const it of this.db.all<{ id: number; variant_id: number; qty: number; cost: number }>('SELECT id, variant_id, qty, cost FROM sale_items WHERE sale_id = ?', a.saleId)) {
        const tracked = this.db.value<number>('SELECT p.track_stock FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.id = ?', it.variant_id)
        // units sold on this line go back in stock (at the location they left); anything not unit-coded restores as before
        const restoredUnits = this.units ? this.units.restoreSaleItem({ saleId: a.saleId, saleItemId: it.id, invoiceNo: sale.invoice_no as string, unitCost: it.cost }) : 0
        const rest = it.qty - restoredUnits
        if (tracked && rest > 0) this.app.moveStock({ variantId: it.variant_id, delta: rest, type: 'void', refType: 'sale', refId: a.saleId, unitCost: it.cost, note: `Void ${sale.invoice_no as string}`, allowNegative: allowNeg })
      }
      this.db.run(
        `UPDATE sales SET status = 'void', void_reason = ?, voided_by = ?, voided_at = ?, void_shift_id = ?, void_approved_by = ? WHERE id = ?`,
        a.reason, s.userId, Date.now(), this.openShiftRow()?.id ?? null, approval.by, a.saleId
      )
      if (approval.rowId) this.db.run('UPDATE approvals SET entity_id = ? WHERE id = ? AND (entity_id IS NULL OR entity_id = ?)', String(a.saleId), approval.rowId, String(a.saleId))
      this.app.audit({ entity: 'sale', entityId: a.saleId, action: 'void', old: { status: 'completed' }, new: { status: 'void', approvedBy: approval.by }, note: a.reason })
      this.app.enqueueSnapshot('sales', a.saleId, [{ table: 'sale_items', fk: 'sale_id' }, { table: 'sale_payments', fk: 'sale_id' }])
      return { ok: true as const, saleId: a.saleId, invoiceNo: sale.invoice_no as string }
    })
  }

  // ---------------------------------------------------------------- delete
  /**
   * PERMANENTLY delete a bill: the invoice, its lines, payments, return notes and print history are removed (voidSale only
   * marks the bill). Same approval rule as a void. Stock that is still out with the customer goes back on the shelf:
   * per line sold - already returned (a return either restocked the goods or wrote them off); a void bill was restored when
   * it was voided, so nothing moves. What remains is the audit entry (with a compact copy of the bill), the stock ledger and
   * a tombstone that keeps the bill from re-appearing through sync. The invoice number is never issued again.
   */
  deleteSale(args: unknown) {
    const s = this.app.requirePermission('pos.delete')
    const a = parse(deleteSchema, args)
    return this.db.transaction(() => {
      const sale = this.db.get<Row>('SELECT * FROM sales WHERE id = ?', a.saleId)
      if (!sale) throw new AppError('NOT_FOUND', 'Sale not found')
      const invoiceNo = sale.invoice_no as string
      const approval = this.resolveApproval(a.approval, 'pos.delete', 'sale', `Delete ${invoiceNo}: ${a.reason}`, { saleId: a.saleId, reason: a.reason }, String(a.saleId))
      const doc = this.loadSale(a.saleId)
      const now = Date.now()

      // stock that is still out comes back (never blocked, like a void)
      const restored: { variantId: number; qty: number }[] = []
      if (sale.status !== 'void') {
        for (const it of doc.items as unknown as { id: number; variantId: number; qty: number; cost: number; returnedQty: number }[]) {
          const out = it.qty - it.returnedQty
          if (out <= 0) continue
          const tracked = !!this.db.value<number>('SELECT p.track_stock FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.id = ?', it.variantId)
          // a unit-coded line is settled by its units: the ones still sold go back in stock where they left, returned ones were handled by the return
          const unitLine = !!this.units && this.units.saleItemUnitCount(it.id) > 0
          const units = unitLine ? this.units!.restoreSaleItem({ saleId: a.saleId, saleItemId: it.id, invoiceNo: `${invoiceNo} (deleted)`, unitCost: it.cost }) : 0
          const rest = unitLine || !tracked ? 0 : out
          if (rest > 0) this.app.moveStock({ variantId: it.variantId, delta: rest, type: 'void', refType: 'sale', refId: a.saleId, unitCost: it.cost, note: `Deleted ${invoiceNo}`, allowNegative: true })
          if (units + rest > 0) restored.push({ variantId: it.variantId, qty: units + rest })
        }
      }

      const local = this.db.get<{ uuid: string }>('SELECT uuid FROM pos_terminals WHERE is_local = 1')
      const tomb: SaleTombstone = {
        uuid: sale.uuid as string, invoiceNo, total: sale.total as number, deletedAt: now, deletedBy: s.userId, deletedByName: s.name,
        reason: a.reason, originDevice: local?.uuid ?? ''
      }
      purgeSale(this.db, tomb)
      if (approval.rowId) this.db.run('UPDATE approvals SET entity_id = ? WHERE id = ? AND (entity_id IS NULL OR entity_id = ?)', String(a.saleId), approval.rowId, String(a.saleId))

      const pick = (r: unknown, keys: string[]) => Object.fromEntries(keys.map((k) => [k, (r as Row)[k] ?? null]))
      this.app.audit({
        entity: 'sale', entityId: a.saleId, action: 'delete', note: a.reason,
        old: {
          ...pick(doc, ['uuid', 'invoiceNo', 'createdAt', 'status', 'customerId', 'customerName', 'customerPhone', 'cashierName', 'posCode', 'subtotal', 'discount', 'tax', 'roundOff', 'total', 'paid', 'changeGiven', 'note', 'voidReason', 'voidedAt']),
          items: doc.items.map((i) => pick(i, ['variantId', 'name', 'sku', 'qty', 'unitPrice', 'discount', 'taxAmount', 'lineTotal', 'returnedQty', 'unitCodes'])),
          payments: doc.payments.map((p) => pick(p, ['method', 'amount', 'reference'])),
          returns: doc.returns.map((r) => ({
            ...pick(r, ['returnNo', 'createdAt', 'total', 'tax', 'refundMethod', 'refundCash', 'reason']),
            items: (r.items as Row[]).map((x) => pick(x, ['variantId', 'qty', 'lineTotal', 'restock']))
          }))
        },
        new: { deleted: true, reason: a.reason, deletedBy: s.name, approvedBy: approval.by, deletedAt: now, stockRestored: restored }
      })
      // other terminals drop the bill too (and never accept a late copy of it)
      this.app.enqueueSync('sales', tomb.uuid, 'delete', saleDeletePayload(tomb))
      return { ok: true as const, saleId: a.saleId, invoiceNo, total: sale.total as number, stockRestored: restored.reduce((t, r) => t + r.qty, 0) }
    })
  }

  // ---------------------------------------------------------------- returns
  /**
   * Partial/full return against a sale. Each line is limited to sold - already returned. The refund for a line is the
   * proportional share of its line_total/tax (the final return of a line takes the remainder so no paise are lost).
   * A return that completes the whole sale also refunds the sale's round-off, so the customer gets back exactly what was paid.
   * sale_returns: total = refund, tax = tax reversed, subtotal = total - tax. refund_cash = part paid from the drawer.
   */
  createReturn(args: unknown) {
    const s = this.app.requirePermission('pos.return')
    const a = parse(returnSchema, args)
    if (!a.saleId && !a.invoiceNo) throw new AppError('VALIDATION', 'saleId or invoiceNo is required')

    if (a.requestId) {
      const dup = this.db.get<{ id: number; return_no: string; total: number; refund_cash: number }>('SELECT id, return_no, total, refund_cash FROM sale_returns WHERE request_id = ?', a.requestId)
      if (dup) return { returnId: dup.id, returnNo: dup.return_no, total: dup.total, refundCash: dup.refund_cash, duplicate: true }
    }

    return this.db.transaction(() => {
      const sale = a.saleId
        ? this.db.get<Row>('SELECT * FROM sales WHERE id = ?', a.saleId)
        : this.db.get<Row>('SELECT * FROM sales WHERE invoice_no = ? COLLATE NOCASE', a.invoiceNo!.trim())
      if (!sale) throw new AppError('NOT_FOUND', 'Sale not found')
      if (sale.status !== 'completed') throw new AppError('CONFLICT', 'Only completed sales can be returned')
      const saleId = sale.id as number

      const sold = this.db.all<Row>('SELECT * FROM sale_items WHERE sale_id = ?', saleId)
      const byId = new Map(sold.map((i) => [i.id as number, i]))
      const prior = new Map<number, { qty: number; amount: number; tax: number }>()
      for (const r of this.db.all<{ sale_item_id: number; qty: number; amount: number; tax: number }>(
        `SELECT ri.sale_item_id, SUM(ri.qty) AS qty, SUM(ri.line_total) AS amount, SUM(ri.tax_amount) AS tax
         FROM sale_return_items ri JOIN sale_returns r ON r.id = ri.return_id WHERE r.sale_id = ? GROUP BY ri.sale_item_id`, saleId
      )) prior.set(r.sale_item_id, r)

      const seen = new Set<number>()
      const rows: { item: Row; qty: number; restock: boolean; amount: number; tax: number; unitCodes?: string[] }[] = []
      for (const x of a.items) {
        if (seen.has(x.saleItemId)) throw new AppError('VALIDATION', 'Duplicate line in return')
        seen.add(x.saleItemId)
        const item = byId.get(x.saleItemId)
        if (!item) throw new AppError('VALIDATION', `Line #${x.saleItemId} does not belong to this sale`)
        const pr = prior.get(x.saleItemId) ?? { qty: 0, amount: 0, tax: 0 }
        const left = (item.qty as number) - pr.qty
        if (x.qty > left) throw new AppError('VALIDATION', `Cannot return ${x.qty} of ${item.name as string}: only ${left} left to return`, { saleItemId: x.saleItemId, returnable: left })
        rows.push({
          item, qty: x.qty, restock: x.restock, unitCodes: x.unitCodes,
          amount: returnShare(item.line_total as number, item.qty as number, x.qty, pr.qty, pr.amount),
          tax: returnShare(item.tax_amount as number, item.qty as number, x.qty, pr.qty, pr.tax)
        })
      }

      // does this return finish the whole sale? then also refund round-off
      const fullyReturned = sold.every((i) => {
        const pr = prior.get(i.id as number)?.qty ?? 0
        const now = rows.find((r) => r.item.id === i.id)?.qty ?? 0
        return pr + now >= (i.qty as number)
      })
      const roundOffAdj = fullyReturned ? (sale.round_off as number) : 0
      const tax = rows.reduce((t, r) => t + r.tax, 0)
      const total = rows.reduce((t, r) => t + r.amount, 0) + roundOffAdj

      // cash that leaves the drawer
      let refundCash = total
      if (a.refundMethod === 'original') {
        const pays = this.db.all<{ method: string; amount: number }>('SELECT method, SUM(amount) AS amount FROM sale_payments WHERE sale_id = ? GROUP BY method', saleId)
        const sum = pays.reduce((t, p) => t + p.amount, 0)
        const cash = pays.find((p) => p.method === 'cash')?.amount ?? 0
        refundCash = sum > 0 ? Math.floor((total * cash) / sum) : 0
      }

      const shiftId = this.openShiftRow()?.id ?? null
      const returnNo = this.docNumber('return')
      const rr = this.db.run(
        `INSERT INTO sale_returns(uuid,return_no,sale_id,pos_id,user_id,shift_id,subtotal,tax,total,refund_method,reason,profile_version_id,request_id,refund_cash)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        this.app.uuid(), returnNo, saleId, s.posId, s.userId, shiftId, total - tax, tax, total, a.refundMethod, a.reason, this.activeProfileVersionId(), a.requestId ?? null, refundCash
      )
      const returnId = rr.lastId
      for (const r of rows) {
        const vid = r.item.variant_id as number
        const tracked = !!this.db.value<number>('SELECT p.track_stock FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.id = ?', vid)
        const unitLine = !!this.units && this.units.saleItemUnitCount(r.item.id as number) > 0
        const doRestock = r.restock && tracked
        if (!unitLine && r.unitCodes?.length) throw new AppError('VALIDATION', `${r.item.name as string} was not sold with unit codes`, { code: 'UNIT_NOT_TRACKED', saleItemId: r.item.id })
        if (unitLine && !r.unitCodes?.length)
          throw new AppError('VALIDATION', `Scan the ${r.qty} unit code(s) of ${r.item.name as string} that are being returned`, { code: 'UNIT_CODES_REQUIRED', saleItemId: r.item.id, qty: r.qty })
        this.db.run(
          'INSERT INTO sale_return_items(return_id,sale_item_id,variant_id,qty,unit_price,tax_amount,line_total,restock) VALUES (?,?,?,?,?,?,?,?)',
          returnId, r.item.id as number, vid, r.qty, r.item.unit_price as number, r.tax, r.amount, doRestock ? 1 : 0
        )
        if (unitLine)
          this.units!.returnUnits({
            saleId, saleItemId: r.item.id as number, codes: r.unitCodes!, qty: r.qty, restock: r.restock, unitCost: r.item.cost as number,
            refId: returnId, note: `${returnNo} / ${sale.invoice_no as string}`
          })
        else if (doRestock)
          this.app.moveStock({ variantId: vid, delta: r.qty, type: 'sale_return', refType: 'sale_return', refId: returnId, unitCost: r.item.cost as number, note: `${returnNo} / ${sale.invoice_no as string}` })
      }
      this.app.audit({ entity: 'sale_return', entityId: returnId, action: 'create', new: { returnNo, saleId, invoiceNo: sale.invoice_no, total, refundMethod: a.refundMethod, refundCash }, note: a.reason })
      this.app.enqueueSnapshot('sale_returns', returnId, [{ table: 'sale_return_items', fk: 'return_id' }])
      return { returnId, returnNo, total, refundCash, duplicate: false }
    })
  }

  getReturn(args: unknown) {
    this.requireAny('pos.return', 'pos.reprint', 'reports.view')
    const { id } = parse(z.object({ id: int.positive() }), args)
    const r = this.db.get<Row>('SELECT * FROM sale_returns WHERE id = ?', id)
    if (!r) throw new AppError('NOT_FOUND', 'Return not found')
    return {
      ...camel<Row>(r),
      invoiceNo: this.db.value<string>('SELECT invoice_no FROM sales WHERE id = ?', r.sale_id as number),
      items: this.db.all<Row>('SELECT ri.*, si.name, si.sku FROM sale_return_items ri JOIN sale_items si ON si.id = ri.sale_item_id WHERE ri.return_id = ?', id).map((x) => camel(x))
    }
  }
}

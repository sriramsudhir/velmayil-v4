import { z } from 'zod'
import type { App } from '../../core/app'
import { AppError } from '@shared/ipc'
import { formatINR, pctOf } from '@shared/money'
import type { Page } from '@shared/types'
import { bp, id, likeTerm, page, paise, parse, qtyPos, text } from './util'
import type { UnitsService } from '../units/service'

const supplierInput = z.object({
  id: id.optional(),
  name: text(120).min(1, 'Name is required'),
  contactPerson: text(120).optional(),
  phone: text(30).optional(),
  email: text(120).optional(),
  gstin: text(20).regex(/^([0-9A-Za-z]{15})?$/, 'GSTIN must be 15 characters').optional(),
  address: text(300).optional()
})

const PAY_METHODS = ['cash', 'upi', 'card', 'bank', 'cheque', 'other'] as const

export class PurchasesService {
  constructor(private app: App) { }

  private get db() {
    return this.app.db
  }

  private get units(): UnitsService | null {
    return this.app.has('units') ? this.app.get<UnitsService>('units') : null
  }

  // ------------------------------------------------------------------ suppliers
  supplierList(args: unknown): Page<Record<string, unknown>> {
    this.app.requirePermission('purchases.view')
    const a = parse(z.object({ search: text(100).optional(), includeInactive: z.boolean().optional(), ...page }), args)
    const where: string[] = []
    const params: (string | number)[] = []
    if (!a.includeInactive) where.push('s.active = 1')
    if (a.search?.trim()) {
      const q = likeTerm(a.search)
      where.push("(s.name LIKE ? ESCAPE '\\' OR s.phone LIKE ? ESCAPE '\\' OR s.gstin LIKE ? ESCAPE '\\')")
      params.push(q, q, q)
    }
    const wh = where.length ? 'WHERE ' + where.join(' AND ') : ''
    const total = this.db.value<number>(`SELECT COUNT(*) FROM suppliers s ${wh}`, ...params) ?? 0
    const rows = this.db.all(
      `SELECT s.id, s.name, s.contact_person AS contactPerson, s.phone, s.email, s.gstin, s.address, s.active,
        ${this.balanceSql('s.id')} AS balance
       FROM suppliers s ${wh} ORDER BY s.name COLLATE NOCASE LIMIT ? OFFSET ?`,
      ...params, a.limit ?? 200, a.offset ?? 0
    )
    return { rows, total }
  }

  /** payable = purchased (not cancelled) - supplier returns - paid. */
  private balanceSql(col: string): string {
    return `(COALESCE((SELECT SUM(total - paid) FROM purchases WHERE supplier_id = ${col} AND status <> 'cancelled'),0)
            - COALESCE((SELECT SUM(total) FROM supplier_returns WHERE supplier_id = ${col}),0))`
  }

  supplierGet(args: unknown) {
    this.app.requirePermission('purchases.view')
    const a = parse(z.object({ id }), args)
    const s = this.db.get<Record<string, unknown>>(
      `SELECT s.id, s.name, s.contact_person AS contactPerson, s.phone, s.email, s.gstin, s.address, s.active FROM suppliers s WHERE s.id=?`,
      a.id
    )
    if (!s) throw new AppError('NOT_FOUND', 'Supplier not found')
    return { ...s, ...this.payablesFor(a.id) }
  }

  supplierSave(args: unknown) {
    this.app.requirePermission('purchases.edit')
    const a = parse(supplierInput, args)
    return this.db.transaction(() => {
      const dup = this.db.get<{ id: number }>('SELECT id FROM suppliers WHERE name = ? COLLATE NOCASE AND active = 1 AND id <> ?', a.name, a.id ?? 0)
      if (dup) throw new AppError('CONFLICT', `Supplier "${a.name}" already exists`)
      const fields = [a.name, a.contactPerson ?? '', a.phone ?? '', a.email ?? '', (a.gstin ?? '').toUpperCase(), a.address ?? '', Date.now()] as const
      if (a.id) {
        const old = this.db.get('SELECT name, contact_person, phone, email, gstin, address FROM suppliers WHERE id=?', a.id)
        if (!old) throw new AppError('NOT_FOUND', 'Supplier not found')
        this.db.run('UPDATE suppliers SET name=?, contact_person=?, phone=?, email=?, gstin=?, address=?, updated_at=? WHERE id=?', ...fields, a.id)
        this.app.audit({ entity: 'supplier', entityId: a.id, action: 'update', old, new: { name: a.name, phone: a.phone, gstin: a.gstin } })
        this.app.enqueueSnapshot('suppliers', a.id)
        return { id: a.id }
      }
      const r = this.db.run(
        'INSERT INTO suppliers(uuid,name,contact_person,phone,email,gstin,address,updated_at) VALUES (?,?,?,?,?,?,?,?)',
        this.app.uuid(), ...fields
      )
      this.app.audit({ entity: 'supplier', entityId: r.lastId, action: 'create', new: { name: a.name } })
      this.app.enqueueSnapshot('suppliers', r.lastId)
      return { id: r.lastId }
    })
  }

  /** Suppliers are deactivated, never deleted (history keeps pointing at them). */
  supplierSetActive(args: unknown) {
    this.app.requirePermission('purchases.edit')
    const a = parse(z.object({ id, active: z.boolean() }), args)
    return this.db.transaction(() => {
      const r = this.db.run('UPDATE suppliers SET active=?, updated_at=? WHERE id=?', a.active ? 1 : 0, Date.now(), a.id)
      if (!r.changes) throw new AppError('NOT_FOUND', 'Supplier not found')
      this.app.audit({ entity: 'supplier', entityId: a.id, action: a.active ? 'activate' : 'deactivate' })
      this.app.enqueueSnapshot('suppliers', a.id)
      return { ok: true }
    })
  }

  private payablesFor(supplierId: number) {
    const r = this.db.get<{ purchased: number; returned: number; paid: number }>(
      `SELECT
        COALESCE((SELECT SUM(total) FROM purchases WHERE supplier_id=? AND status<>'cancelled'),0) AS purchased,
        COALESCE((SELECT SUM(total) FROM supplier_returns WHERE supplier_id=?),0) AS returned,
        COALESCE((SELECT SUM(paid) FROM purchases WHERE supplier_id=? AND status<>'cancelled'),0) AS paid`,
      supplierId, supplierId, supplierId
    )!
    return { purchased: r.purchased, returned: r.returned, paid: r.paid, balance: r.purchased - r.returned - r.paid }
  }

  /** Payables per supplier: total purchased - supplier returns - paid. */
  payables(args?: unknown) {
    this.app.requirePermission('purchases.view')
    const a = parse(z.object({ supplierId: id.optional(), includeSettled: z.boolean().optional() }), args)
    const rows = this.db
      .all<{ supplierId: number; name: string; purchased: number; returned: number; paid: number }>(
        `SELECT s.id AS supplierId, s.name,
          COALESCE((SELECT SUM(total) FROM purchases WHERE supplier_id=s.id AND status<>'cancelled'),0) AS purchased,
          COALESCE((SELECT SUM(total) FROM supplier_returns WHERE supplier_id=s.id),0) AS returned,
          COALESCE((SELECT SUM(paid) FROM purchases WHERE supplier_id=s.id AND status<>'cancelled'),0) AS paid
         FROM suppliers s ${a.supplierId ? 'WHERE s.id = ?' : ''} ORDER BY s.name COLLATE NOCASE`,
        ...(a.supplierId ? [a.supplierId] : [])
      )
      .map((r) => ({ ...r, balance: r.purchased - r.returned - r.paid }))
      .filter((r) => a.includeSettled || a.supplierId || r.balance !== 0 || r.purchased !== 0)
    return { rows, totalPayable: rows.reduce((s, r) => s + r.balance, 0) }
  }

  // ------------------------------------------------------------------ purchases
  list(args: unknown): Page<Record<string, unknown>> {
    this.app.requirePermission('purchases.view')
    const a = parse(
      z.object({
        search: text(100).optional(), supplierId: id.optional(), status: z.enum(['received', 'cancelled']).optional(),
        unpaidOnly: z.boolean().optional(), from: z.number().int().optional(), to: z.number().int().optional(), ...page
      }),
      args
    )
    const where: string[] = []
    const params: (string | number)[] = []
    if (a.supplierId) (where.push('p.supplier_id = ?'), params.push(a.supplierId))
    if (a.status) (where.push('p.status = ?'), params.push(a.status))
    if (a.unpaidOnly) where.push("p.status <> 'cancelled' AND p.paid < p.total")
    if (a.from != null) (where.push('p.created_at >= ?'), params.push(a.from))
    if (a.to != null) (where.push('p.created_at <= ?'), params.push(a.to))
    if (a.search?.trim()) {
      const q = likeTerm(a.search)
      where.push("(p.number LIKE ? ESCAPE '\\' OR p.supplier_invoice_no LIKE ? ESCAPE '\\' OR s.name LIKE ? ESCAPE '\\')")
      params.push(q, q, q)
    }
    const from = `FROM purchases p LEFT JOIN suppliers s ON s.id=p.supplier_id JOIN locations l ON l.id=p.location_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`
    const total = this.db.value<number>(`SELECT COUNT(*) ${from}`, ...params) ?? 0
    const rows = this.db.all(
      `SELECT p.id, p.number, p.supplier_id AS supplierId, s.name AS supplierName, p.supplier_invoice_no AS supplierInvoiceNo, p.status,
        p.subtotal, p.tax, p.total, p.paid, p.total - p.paid AS due, p.created_at AS createdAt, l.name AS locationName
       ${from} ORDER BY p.id DESC LIMIT ? OFFSET ?`,
      ...params, a.limit ?? 100, a.offset ?? 0
    )
    return { rows, total }
  }

  get(args: unknown) {
    this.app.requirePermission('purchases.view')
    const a = parse(z.object({ id }), args)
    const p = this.db.get<Record<string, unknown>>(
      `SELECT p.id, p.number, p.supplier_id AS supplierId, s.name AS supplierName, p.supplier_invoice_no AS supplierInvoiceNo, p.status,
        p.subtotal, p.tax, p.total, p.paid, p.total - p.paid AS due, p.note, p.created_at AS createdAt, p.cancelled_at AS cancelledAt,
        p.cancel_reason AS cancelReason, p.location_id AS locationId, l.name AS locationName, u.name AS userName
       FROM purchases p LEFT JOIN suppliers s ON s.id=p.supplier_id JOIN locations l ON l.id=p.location_id LEFT JOIN users u ON u.id=p.user_id WHERE p.id=?`,
      a.id
    )
    if (!p) throw new AppError('NOT_FOUND', 'Purchase not found')
    const items = this.db.all(
      `SELECT i.id, i.variant_id AS variantId, i.qty, i.unit_cost AS unitCost, i.tax_rate_bp AS taxRateBp, i.tax_amount AS taxAmount, i.total,
        pr.name || CASE WHEN v.name<>'' THEN ' - '||v.name ELSE '' END AS displayName, v.sku
       FROM purchase_items i JOIN product_variants v ON v.id=i.variant_id JOIN products pr ON pr.id=v.product_id WHERE i.purchase_id=? ORDER BY i.id`,
      a.id
    )
    const payments = this.db.all('SELECT id, amount, method, note, created_at AS createdAt FROM purchase_payments WHERE purchase_id=? ORDER BY id', a.id)
    return { ...p, items, payments }
  }

  private childSpecs() {
    return [
      { table: 'purchase_items', fk: 'purchase_id' },
      { table: 'purchase_payments', fk: 'purchase_id' }
    ]
  }

  /**
   * Create a purchase / GRN. Receives stock, updates variant cost per setting `inventory.cost_method`
   * ('last' default | 'weighted'), records any initial payment. One transaction: any bad line rolls back everything.
   */
  create(args: unknown) {
    this.app.requirePermission('purchases.edit')
    const a = parse(
      z.object({
        supplierId: id.optional(),
        supplierInvoiceNo: text(60).optional(),
        locationId: id.optional(),
        note: text().optional(),
        paid: paise.optional(),
        paymentMethod: z.enum(PAY_METHODS).optional(),
        /** unit-coded products: false = receive the stock WITHOUT issuing unit codes (generate them later with units.generate) */
        generateUnits: z.boolean().optional(),
        items: z
          .array(z.object({ variantId: id, qty: qtyPos, unitCost: paise, taxRateBp: bp.optional() }))
          .min(1, 'Add at least one line')
          .max(1000)
      }),
      args
    )
    const loc = a.locationId ?? this.app.defaultLocationId()
    const method = this.app.setting('inventory.cost_method', 'last') === 'weighted' ? 'weighted' : 'last'
    return this.db.transaction(() => {
      if (!this.db.get('SELECT 1 FROM locations WHERE id=? AND active=1', loc)) throw new AppError('NOT_FOUND', 'Location not found')
      if (a.supplierId) {
        const s = this.db.get<{ active: number }>('SELECT active FROM suppliers WHERE id=?', a.supplierId)
        if (!s) throw new AppError('NOT_FOUND', 'Supplier not found')
        if (!s.active) throw new AppError('VALIDATION', 'Supplier is inactive')
        const inv = a.supplierInvoiceNo?.trim()
        if (inv && this.db.get("SELECT 1 FROM purchases WHERE supplier_id=? AND supplier_invoice_no=? AND status<>'cancelled'", a.supplierId, inv))
          throw new AppError('CONFLICT', `Invoice ${inv} was already entered for this supplier`)
      }
      // compute lines first so totals are known before anything is written
      const lines = a.items.map((it) => {
        const v = this.app.lookup.byId(it.variantId)
        if (!v) throw new AppError('NOT_FOUND', `Product variant ${it.variantId} not found`)
        const rate = it.taxRateBp ?? v.taxRateBp
        const base = it.qty * it.unitCost
        const tax = pctOf(base, rate)
        return { ...it, v, rate, tax, total: base + tax }
      })
      const subtotal = lines.reduce((s, l) => s + l.qty * l.unitCost, 0)
      const tax = lines.reduce((s, l) => s + l.tax, 0)
      const total = subtotal + tax
      const paid = a.paid ?? 0
      if (paid > total) throw new AppError('VALIDATION', 'Paid amount cannot exceed the purchase total')

      const number = this.app.nextNumber('PUR', { prefix: 'PUR' })
      const uuid = this.app.uuid()
      const p = this.db.run(
        `INSERT INTO purchases(uuid,number,supplier_id,supplier_invoice_no,location_id,status,subtotal,tax,total,paid,note,user_id)
         VALUES (?,?,?,?,?,'received',?,?,?,?,?,?)`,
        uuid, number, a.supplierId ?? null, a.supplierInvoiceNo?.trim() ?? '', loc, subtotal, tax, total, paid, a.note ?? '', this.app.session?.userId ?? null
      )
      const costChanges: { variantId: number; old: number; new: number }[] = []
      const issued = new Map<number, string[]>()
      for (const [lineIdx, l] of lines.entries()) {
        this.db.run(
          'INSERT INTO purchase_items(purchase_id,variant_id,qty,unit_cost,tax_rate_bp,tax_amount,total) VALUES (?,?,?,?,?,?,?)',
          p.lastId, l.variantId, l.qty, l.unitCost, l.rate, l.tax, l.total
        )
        if (!l.v.trackStock) continue
        // cost must be computed from the on-hand BEFORE this receipt
        const onHand = this.db.value<number>('SELECT COALESCE(SUM(qty),0) FROM stock_levels WHERE variant_id=?', l.variantId) ?? 0
        const cur = this.db.value<number>('SELECT cost FROM product_variants WHERE id=?', l.variantId) ?? 0
        const next =
          method === 'weighted' && onHand > 0 ? Math.round((onHand * cur + l.qty * l.unitCost) / (onHand + l.qty)) : l.unitCost
        this.app.moveStock({ variantId: l.variantId, delta: l.qty, type: 'purchase', locationId: loc, refType: 'purchase', refId: p.lastId, unitCost: l.unitCost, note: number })
        if (l.v.trackUnits && a.generateUnits !== false && this.units)
          issued.set(lineIdx, this.units.generateTx({ variantId: l.variantId, count: l.qty, purchaseId: p.lastId, locationId: loc, reason: `Purchase ${number}` }).codes)
        if (next !== cur) {
          this.db.run('UPDATE product_variants SET cost=?, updated_at=? WHERE id=?', next, Date.now(), l.variantId)
          this.app.audit({ entity: 'variant', entityId: l.variantId, action: 'cost_change', old: { cost: cur }, new: { cost: next }, note: `${number} (${method})` })
          this.app.enqueueSnapshot('product_variants', l.variantId)
          costChanges.push({ variantId: l.variantId, old: cur, new: next })
        }
      }
      if (paid > 0)
        this.db.run('INSERT INTO purchase_payments(uuid,purchase_id,amount,method,user_id) VALUES (?,?,?,?,?)', this.app.uuid(), p.lastId, paid, a.paymentMethod ?? 'cash', this.app.session?.userId ?? null)
      this.app.audit({ entity: 'purchase', entityId: p.lastId, action: 'create', new: { number, supplierId: a.supplierId ?? null, total, paid, lines: lines.length } })
      this.app.enqueueSnapshot('purchases', p.lastId, this.childSpecs())
      return {
        id: p.lastId, uuid, number, subtotal, tax, total, paid, costChanges,
        /** per input line: the unit codes issued for it (empty for non-tracked products / generateUnits:false) */
        items: lines.map((l, i) => ({ variantId: l.variantId, qty: l.qty, unitCodes: issued.get(i) ?? [] }))
      }
    })
  }

  recordPayment(args: unknown) {
    this.app.requirePermission('purchases.edit')
    const a = parse(z.object({ purchaseId: id, amount: paise.refine((n) => n > 0, 'Amount must be positive'), method: z.enum(PAY_METHODS).optional(), note: text().optional() }), args)
    return this.db.transaction(() => {
      const p = this.db.get<{ number: string; status: string; total: number; paid: number }>('SELECT number, status, total, paid FROM purchases WHERE id=?', a.purchaseId)
      if (!p) throw new AppError('NOT_FOUND', 'Purchase not found')
      if (p.status === 'cancelled') throw new AppError('CONFLICT', 'Purchase is cancelled')
      if (p.paid + a.amount > p.total) throw new AppError('VALIDATION', `Payment exceeds the amount due (${formatINR(p.total - p.paid)})`)
      this.db.run('INSERT INTO purchase_payments(uuid,purchase_id,amount,method,note,user_id) VALUES (?,?,?,?,?,?)', this.app.uuid(), a.purchaseId, a.amount, a.method ?? 'cash', a.note ?? '', this.app.session?.userId ?? null)
      this.db.run('UPDATE purchases SET paid = paid + ? WHERE id=?', a.amount, a.purchaseId)
      this.app.audit({ entity: 'purchase', entityId: a.purchaseId, action: 'payment', old: { paid: p.paid }, new: { paid: p.paid + a.amount }, note: p.number })
      this.app.enqueueSnapshot('purchases', a.purchaseId, this.childSpecs())
      return { paid: p.paid + a.amount, due: p.total - p.paid - a.amount }
    })
  }

  /** Cancel: reverses received stock. Fails (INSUFFICIENT_STOCK, nothing changed) if the goods are no longer on hand. */
  cancel(args: unknown) {
    this.app.requirePermission('purchases.edit')
    const a = parse(z.object({ id, reason: text(300).min(1, 'A reason is required') }), args)
    return this.db.transaction(() => {
      const p = this.db.get<{ id: number; number: string; status: string; location_id: number }>('SELECT id, number, status, location_id FROM purchases WHERE id=?', a.id)
      if (!p) throw new AppError('NOT_FOUND', 'Purchase not found')
      if (p.status === 'cancelled') throw new AppError('CONFLICT', 'Purchase is already cancelled')
      const items = this.db.all<{ variant_id: number; qty: number; unit_cost: number; track: number }>(
        `SELECT i.variant_id, i.qty, i.unit_cost, pr.track_stock AS track FROM purchase_items i
         JOIN product_variants v ON v.id=i.variant_id JOIN products pr ON pr.id=v.product_id WHERE i.purchase_id=?`,
        a.id
      )
      // unit-coded stock received on this purchase must still be on the shelf where it arrived; those units become void
      this.units?.voidPurchaseUnits(a.id, p.location_id, `Purchase ${p.number} cancelled`)
      for (const it of items) {
        if (!it.track) continue
        try {
          this.app.moveStock({ variantId: it.variant_id, delta: -it.qty, type: 'void', locationId: p.location_id, refType: 'purchase_cancel', refId: p.id, unitCost: it.unit_cost, note: `Cancel ${p.number}`, allowNegative: false })
        } catch (e) {
          if (e instanceof AppError && e.code === 'INSUFFICIENT_STOCK')
            throw new AppError('INSUFFICIENT_STOCK', `Cannot cancel ${p.number}: ${e.message}. Stock from this purchase has already been used.`, e.details)
          throw e
        }
      }
      this.db.run("UPDATE purchases SET status='cancelled', cancelled_at=?, cancel_reason=? WHERE id=?", Date.now(), a.reason, a.id)
      this.app.audit({ entity: 'purchase', entityId: a.id, action: 'cancel', new: { number: p.number }, note: a.reason })
      this.app.enqueueSnapshot('purchases', a.id, this.childSpecs())
      return { ok: true }
    })
  }

  // ------------------------------------------------------------------ supplier returns
  returnCreate(args: unknown) {
    this.app.requirePermission('purchases.edit')
    const a = parse(
      z.object({
        supplierId: id, locationId: id.optional(), note: text().optional(),
        items: z.array(z.object({ variantId: id, qty: qtyPos, unitCost: paise.optional(), taxRateBp: bp.optional(), unitCodes: z.array(text(64).min(1)).max(10_000).optional() })).min(1).max(500)
      }),
      args
    )
    const loc = a.locationId ?? this.app.defaultLocationId()
    return this.db.transaction(() => {
      if (!this.db.get('SELECT 1 FROM suppliers WHERE id=?', a.supplierId)) throw new AppError('NOT_FOUND', 'Supplier not found')
      if (!this.db.get('SELECT 1 FROM locations WHERE id=? AND active=1', loc)) throw new AppError('NOT_FOUND', 'Location not found')
      const lines = a.items.map((it) => {
        const v = this.app.lookup.byId(it.variantId)
        if (!v) throw new AppError('NOT_FOUND', `Product variant ${it.variantId} not found`)
        if (!v.trackStock) throw new AppError('VALIDATION', `${v.displayName} does not track stock`)
        // pieces without a label of their own (label printing switched tracking on) need no code: they complete the list
        const outCodes = v.trackUnits && this.units ? this.units.completeCodes(v.variantId, it.qty, it.unitCodes, loc) : it.unitCodes
        if (v.trackUnits && outCodes?.length !== it.qty)
          throw new AppError('VALIDATION', `${v.displayName}: scan the ${it.qty} unit code(s) being returned to the supplier`, { code: 'UNIT_CODES_REQUIRED', variantId: v.variantId, qty: it.qty })
        if (!v.trackUnits && it.unitCodes?.length) throw new AppError('VALIDATION', `${v.displayName} does not track unit codes`, { code: 'UNIT_NOT_TRACKED' })
        const unitCost = it.unitCost ?? v.cost
        // purchases are payable WITH GST (purchases.total = cost + tax), so the credit for goods sent back carries GST too;
        // otherwise a fully returned purchase would leave its tax as a payable forever
        const rate = it.taxRateBp ?? this.returnTaxRate(a.supplierId, it.variantId, v.taxRateBp)
        const base = it.qty * unitCost
        return { ...it, unitCodes: outCodes ?? it.unitCodes, v, unitCost, rate, tax: pctOf(base, rate), base }
      })
      const tax = lines.reduce((s, l) => s + l.tax, 0)
      const total = lines.reduce((s, l) => s + l.base, 0) + tax
      const number = this.app.nextNumber('SRT', { prefix: 'SRT' })
      const uuid = this.app.uuid()
      const r = this.db.run(
        'INSERT INTO supplier_returns(uuid,number,supplier_id,location_id,total,note,user_id) VALUES (?,?,?,?,?,?,?)',
        uuid, number, a.supplierId, loc, total, a.note ?? '', this.app.session?.userId ?? null
      )
      for (const l of lines) {
        this.db.run('INSERT INTO supplier_return_items(return_id,variant_id,qty,unit_cost) VALUES (?,?,?,?)', r.lastId, l.variantId, l.qty, l.unitCost)
        this.app.moveStock({ variantId: l.variantId, delta: -l.qty, type: 'supplier_return', locationId: loc, refType: 'supplier_return', refId: r.lastId, unitCost: l.unitCost, note: number, allowNegative: false })
        if (l.v.trackUnits && this.units) this.units.voidUnits(l.unitCodes!, { reason: `Supplier return ${number}`, variantId: l.variantId, locationId: loc })
      }
      this.app.audit({ entity: 'supplier_return', entityId: r.lastId, action: 'create', new: { number, supplierId: a.supplierId, total, lines: lines.length } })
      this.app.enqueueSnapshot('supplier_returns', r.lastId, [{ table: 'supplier_return_items', fk: 'return_id' }])
      /** total = goods value + tax (what the payable falls by) */
      return { id: r.lastId, uuid, number, total, tax }
    })
  }

  /** GST rate the supplier charged for this product on the latest (not cancelled) purchase; the product's own rate otherwise. */
  private returnTaxRate(supplierId: number, variantId: number, fallback: number): number {
    const r = this.db.get<{ rate: number }>(
      `SELECT i.tax_rate_bp AS rate FROM purchase_items i JOIN purchases p ON p.id = i.purchase_id
       WHERE p.supplier_id = ? AND i.variant_id = ? AND p.status <> 'cancelled' ORDER BY p.id DESC, i.id DESC LIMIT 1`,
      supplierId, variantId
    )
    return r?.rate ?? fallback
  }

  returnList(args: unknown): Page<Record<string, unknown>> {
    this.app.requirePermission('purchases.view')
    const a = parse(z.object({ supplierId: id.optional(), ...page }), args)
    const wh = a.supplierId ? 'WHERE r.supplier_id = ?' : ''
    const params = a.supplierId ? [a.supplierId] : []
    const total = this.db.value<number>(`SELECT COUNT(*) FROM supplier_returns r ${wh}`, ...params) ?? 0
    const rows = this.db.all(
      `SELECT r.id, r.number, r.supplier_id AS supplierId, s.name AS supplierName, r.total, r.note, r.created_at AS createdAt,
        (SELECT COALESCE(SUM(qty),0) FROM supplier_return_items i WHERE i.return_id=r.id) AS qty
       FROM supplier_returns r LEFT JOIN suppliers s ON s.id=r.supplier_id ${wh} ORDER BY r.id DESC LIMIT ? OFFSET ?`,
      ...params, a.limit ?? 100, a.offset ?? 0
    )
    return { rows, total }
  }

  returnGet(args: unknown) {
    this.app.requirePermission('purchases.view')
    const a = parse(z.object({ id }), args)
    const r = this.db.get<Record<string, unknown>>(
      `SELECT r.id, r.number, r.supplier_id AS supplierId, s.name AS supplierName, r.total, r.note, r.created_at AS createdAt
       FROM supplier_returns r LEFT JOIN suppliers s ON s.id=r.supplier_id WHERE r.id=?`,
      a.id
    )
    if (!r) throw new AppError('NOT_FOUND', 'Supplier return not found')
    const items = this.db.all(
      `SELECT i.variant_id AS variantId, i.qty, i.unit_cost AS unitCost, pr.name || CASE WHEN v.name<>'' THEN ' - '||v.name ELSE '' END AS displayName, v.sku
       FROM supplier_return_items i JOIN product_variants v ON v.id=i.variant_id JOIN products pr ON pr.id=v.product_id WHERE i.return_id=?`,
      a.id
    )
    return { ...r, items }
  }
}

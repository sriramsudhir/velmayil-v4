import { z } from 'zod'
import type { App } from '../../core/app'
import { AppError } from '@shared/ipc'
import type { Page } from '@shared/types'
import { ADJUST_REASONS, id, likeTerm, page, parse, text } from './util'
import { StampCache, dataStamp } from '../reports/cache'
import type { UnitsService } from '../units/service'
import { scannedUnitOf } from '../../core/lookup'


/** Rows returned by verifyLedger at most (the count of all mismatches is still reported). */
const MISMATCH_CAP = 500

export interface StockRow {
  variantId: number
  productId: number
  productName: string
  variantName: string
  displayName: string
  sku: string
  barcode: string | null
  unit: string
  categoryId: number | null
  categoryName: string | null
  reorderLevel: number
  taxRateBp: number
  qty: number
  /** null when the user lacks reports.profit */
  cost: number | null
  value: number | null
  price: number
  active: boolean
}

export interface LedgerRow {
  id: number
  ts: number
  type: string
  locationId: number
  locationName: string
  qtyDelta: number
  balanceAfter: number
  running: number
  refType: string | null
  refId: string | null
  unitCost: number | null
  note: string | null
  userName: string | null
}

const stockQuery = z.object({
  search: text(100).optional(),
  locationId: id.optional(),
  categoryId: id.optional(),
  status: z.enum(['all', 'low', 'out', 'in']).optional(),
  includeInactive: z.boolean().optional(),
  ...page
})

const BASE = (locSql: string) => `
SELECT v.id AS variantId, p.id AS productId, p.name AS productName, v.name AS variantName,
       p.name || CASE WHEN v.name <> '' THEN ' - ' || v.name ELSE '' END AS displayName,
       v.sku, v.barcode, p.unit, p.category_id AS categoryId, c.name AS categoryName,
       v.reorder_level AS reorderLevel, p.tax_rate_bp AS taxRateBp, v.cost, v.price, (v.active AND p.active) AS active,
       COALESCE((SELECT SUM(s.qty) FROM stock_levels s WHERE s.variant_id = v.id${locSql}), 0) AS qty
FROM product_variants v JOIN products p ON p.id = v.product_id LEFT JOIN categories c ON c.id = p.category_id
WHERE p.track_stock = 1`

/**
 * Same filters as BASE but only the columns the aggregates and filters need (no category join, no wide strings unless a text
 * search is active), so COUNT/SUM over a 20k-variant catalogue costs ~15 ms instead of ~60.
 */
const TOTALS_BASE = (locSql: string, withText: boolean) => `
SELECT v.cost AS cost, v.reorder_level AS reorderLevel, p.category_id AS categoryId, (v.active AND p.active) AS active,
       ${withText ? `p.name || CASE WHEN v.name <> '' THEN ' - ' || v.name ELSE '' END AS displayName, v.sku AS sku, v.barcode AS barcode,` : ''}
       COALESCE((SELECT SUM(s.qty) FROM stock_levels s WHERE s.variant_id = v.id${locSql}), 0) AS qty
FROM product_variants v JOIN products p ON p.id = v.product_id
WHERE p.track_stock = 1`

export class InventoryService {
  /** COUNT/SUM over the whole filtered stock list are the expensive part of stock(): cached until stock or the catalogue changes. */
  private totals = new StampCache<{ total: number; q: number; v: number }>(12, 5 * 60_000)

  private counts = new StampCache<{ low: number; out: number }>(4, 5 * 60_000)

  constructor(private app: App) {}

  private get db() {
    return this.app.db
  }
  private get units(): UnitsService | null {
    return this.app.has('units') ? this.app.get<UnitsService>('units') : null
  }
  private canCost(): boolean {
    return this.app.can('reports.profit')
  }

  // ------------------------------------------------------------------ queries
  locations() {
    this.app.requirePermission('inventory.view')
    return this.db.all<{ id: number; name: string; isDefault: number; active: number }>(
      'SELECT id, name, is_default AS isDefault, active FROM locations WHERE active = 1 ORDER BY is_default DESC, name'
    )
  }

  categories() {
    this.app.requirePermission('inventory.view')
    return this.db.all<{ id: number; name: string }>('SELECT id, name FROM categories WHERE active = 1 ORDER BY name')
  }

  /** Resolve a scanned code to a variant plus on-hand at a location. */
  lookup(args: unknown) {
    this.app.requirePermission('inventory.view')
    const a = parse(z.object({ code: text(100), locationId: id.optional() }), args)
    const v = this.app.lookup.byScan(a.code)
    if (!v) return null
    const loc = a.locationId ?? this.app.defaultLocationId()
    const qty = this.db.value<number>('SELECT qty FROM stock_levels WHERE variant_id=? AND location_id=?', v.variantId, loc) ?? 0
    /** unlabelledUnits: tracked products only, pieces at this location that never got a label of their own (handled by quantity) */
    return { ...v, cost: this.canCost() ? v.cost : null, qtyAtLocation: qty, unlabelledUnits: v.trackUnits && this.units ? this.units.unlabelledCount(v.variantId, loc) : 0 }
  }

  private stockFilter(a: z.infer<typeof stockQuery>) {
    const where: string[] = []
    const params: (string | number)[] = []
    if (a.locationId) params.push(a.locationId)
    if (a.categoryId) {
      where.push('categoryId = ?')
      params.push(a.categoryId)
    }
    if (!a.includeInactive) where.push('active = 1')
    if (a.search?.trim()) {
      const q = likeTerm(a.search)
      where.push("(displayName LIKE ? ESCAPE '\\' OR sku LIKE ? ESCAPE '\\' OR barcode LIKE ? ESCAPE '\\')")
      params.push(q, q, q)
    }
    if (a.status === 'low') where.push('reorderLevel > 0 AND qty <= reorderLevel')
    if (a.status === 'out') where.push('qty <= 0')
    if (a.status === 'in') where.push('qty > 0')
    const locSql = a.locationId ? ' AND s.location_id = ?' : ''
    const w = where.length ? 'WHERE ' + where.join(' AND ') : ''
    const sql = `SELECT * FROM (${BASE(locSql)}) ${w}`
    const totalsSql = `SELECT * FROM (${TOTALS_BASE(locSql, !!a.search?.trim())}) ${w}`
    return { sql, params, totalsSql }
  }

  /** Stock on hand per variant (all locations summed unless locationId is given). Paginated. */
  stock(args: unknown): Page<StockRow> & { totalQty: number; totalValue: number | null } {
    this.app.requirePermission('inventory.view')
    const a = parse(stockQuery, args)
    const f = this.stockFilter(a)
    const agg = this.totals.memo(`${f.totalsSql}|${JSON.stringify(f.params)}`, dataStamp(this.db), () => {
      const r = this.db.get<{ total: number; q: number; v: number }>(
        `SELECT COUNT(*) total, COALESCE(SUM(qty),0) q, COALESCE(SUM(qty*cost),0) v FROM (${f.totalsSql})`, ...f.params
      )
      return { total: Number(r?.total ?? 0), q: Number(r?.q ?? 0), v: Number(r?.v ?? 0) }
    })
    const total = agg.total
    const costOk = this.canCost()
    const rows = this.db
      .all<Record<string, unknown>>(`${f.sql} ORDER BY productName COLLATE NOCASE, variantName LIMIT ? OFFSET ?`, ...f.params, a.limit ?? 100, a.offset ?? 0)
      .map((r) => ({
        ...(r as unknown as StockRow),
        active: !!r.active,
        cost: costOk ? (r.cost as number) : null,
        value: costOk ? (r.qty as number) * (r.cost as number) : null
      }))
    return { rows, total, totalQty: agg.q, totalValue: costOk ? agg.v : null }
  }

  /** Stock valuation at cost (qty * variant cost). Requires reports.profit because it exposes cost. */
  valuation(args: unknown) {
    this.app.requirePermission('inventory.view')
    this.app.requirePermission('reports.profit')
    const a = parse(z.object({ locationId: id.optional(), categoryId: id.optional() }), args)
    // per-variant on-hand first (index order on the stock_levels PK), then one join per variant that actually has stock
    const params: (string | number)[] = []
    if (a.locationId) params.push(a.locationId)
    if (a.categoryId) params.push(a.categoryId)
    const byCategory = this.db.all<{ categoryId: number | null; categoryName: string; qty: number; value: number }>(
      `SELECT p.category_id AS categoryId, COALESCE(c.name,'Uncategorised') AS categoryName, SUM(t.qty) AS qty, SUM(t.qty*v.cost) AS value
       FROM (SELECT variant_id, SUM(qty) AS qty FROM stock_levels ${a.locationId ? 'WHERE location_id = ?' : ''} GROUP BY variant_id HAVING SUM(qty) > 0) t
       JOIN product_variants v ON v.id = t.variant_id JOIN products p ON p.id = v.product_id LEFT JOIN categories c ON c.id = p.category_id
       WHERE p.track_stock = 1 AND v.active = 1 AND p.active = 1 ${a.categoryId ? 'AND p.category_id = ?' : ''}
       GROUP BY p.category_id ORDER BY value DESC`,
      ...params
    )
    const byLocation = this.db.all<{ locationId: number; locationName: string; qty: number; value: number }>(
      `SELECT l.id AS locationId, l.name AS locationName, COALESCE(SUM(s.qty),0) AS qty, COALESCE(SUM(s.qty*v.cost),0) AS value
       FROM locations l LEFT JOIN stock_levels s ON s.location_id=l.id AND s.qty>0
       LEFT JOIN product_variants v ON v.id=s.variant_id
       WHERE l.active=1 GROUP BY l.id ORDER BY l.name`
    )
    return {
      totalQty: byCategory.reduce((s, r) => s + r.qty, 0),
      totalValue: byCategory.reduce((s, r) => s + r.value, 0),
      byCategory,
      byLocation
    }
  }

  /** Stock ledger for one variant with a running balance (computed over the unfiltered scope, then filtered). */
  ledger(args: unknown): Page<LedgerRow> & { variantName: string } {
    this.app.requirePermission('inventory.view')
    const a = parse(
      z.object({ variantId: id, locationId: id.optional(), type: text(30).optional(), from: z.number().int().optional(), to: z.number().int().optional(), ...page }),
      args
    )
    const params: (string | number)[] = [a.variantId]
    let scope = 'WHERE m.variant_id = ?'
    if (a.locationId) {
      scope += ' AND m.location_id = ?'
      params.push(a.locationId)
    }
    const outer: string[] = []
    const oparams: (string | number)[] = []
    if (a.type) (outer.push('type = ?'), oparams.push(a.type))
    if (a.from != null) (outer.push('ts >= ?'), oparams.push(a.from))
    if (a.to != null) (outer.push('ts <= ?'), oparams.push(a.to))
    const inner = `SELECT m.id, m.ts, m.type, m.location_id AS locationId, l.name AS locationName, m.qty_delta AS qtyDelta,
        m.balance_after AS balanceAfter, SUM(m.qty_delta) OVER (ORDER BY m.id) AS running,
        m.ref_type AS refType, m.ref_id AS refId, m.unit_cost AS unitCost, m.note, u.name AS userName
      FROM stock_movements m JOIN locations l ON l.id = m.location_id LEFT JOIN users u ON u.id = m.user_id ${scope}`
    const wh = outer.length ? 'WHERE ' + outer.join(' AND ') : ''
    const total = this.db.value<number>(`SELECT COUNT(*) FROM (${inner}) ${wh}`, ...params, ...oparams) ?? 0
    const costOk = this.canCost()
    const rows = this.db
      .all<LedgerRow>(`SELECT * FROM (${inner}) ${wh} ORDER BY id DESC LIMIT ? OFFSET ?`, ...params, ...oparams, a.limit ?? 200, a.offset ?? 0)
      .map((r) => ({ ...r, unitCost: costOk ? r.unitCost : null }))
    const v = this.app.lookup.byId(a.variantId)
    return { rows, total, variantName: v?.displayName ?? '' }
  }

  /**
   * Integrity check: stock_levels must equal SUM(stock_movements.qty_delta) per variant/location, and the last
   * balance_after must agree. Returns every mismatch.
   */
  verifyLedger() {
    this.app.requirePermission('inventory.view')
    // one grouped pass over the ledger (instead of three correlated lookups per key); only mismatches are materialised
    const bad = this.db.all<{ variantId: number; locationId: number; level: number; ledger: number; lastBalance: number | null }>(
      `WITH mv AS (SELECT variant_id, location_id, SUM(qty_delta) AS ledger, MAX(id) AS last_id FROM stock_movements GROUP BY variant_id, location_id),
       keys AS (SELECT variant_id, location_id FROM stock_levels UNION SELECT variant_id, location_id FROM mv),
       joined AS (
         SELECT k.variant_id AS variantId, k.location_id AS locationId, COALESCE(s.qty,0) AS level, COALESCE(mv.ledger,0) AS ledger,
                (SELECT balance_after FROM stock_movements WHERE id = mv.last_id) AS lastBalance
         FROM keys k LEFT JOIN stock_levels s ON s.variant_id = k.variant_id AND s.location_id = k.location_id
         LEFT JOIN mv ON mv.variant_id = k.variant_id AND mv.location_id = k.location_id)
       SELECT * FROM joined WHERE level <> ledger OR (lastBalance IS NOT NULL AND lastBalance <> ledger) ORDER BY variantId, locationId LIMIT ${MISMATCH_CAP + 1}`
    )
    const checked = this.db.value<number>(`SELECT COUNT(*) FROM (SELECT variant_id, location_id FROM stock_levels UNION SELECT variant_id, location_id FROM stock_movements)`) ?? 0
    const truncated = bad.length > MISMATCH_CAP
    if (truncated) bad.pop()
    const mismatches = bad.map((r) => ({ ...r, difference: r.level - r.ledger }))
    // unit-coded products: stock on hand must equal the number of in-stock units, per location
    const unitMismatches = this.db
      .all<{ variantId: number; locationId: number; level: number; units: number }>(
        `WITH tv AS (SELECT v.id AS variant_id FROM product_variants v JOIN products p ON p.id = v.product_id WHERE p.track_units = 1),
         keys AS (SELECT variant_id, location_id FROM stock_levels WHERE variant_id IN (SELECT variant_id FROM tv)
                  UNION SELECT variant_id, location_id FROM product_units WHERE status IN ('in_stock','returned') AND location_id IS NOT NULL AND variant_id IN (SELECT variant_id FROM tv))
         SELECT k.variant_id AS variantId, k.location_id AS locationId, COALESCE(s.qty,0) AS level,
                (SELECT COUNT(*) FROM product_units u WHERE u.variant_id = k.variant_id AND u.location_id = k.location_id AND u.status IN ('in_stock','returned')) AS units
         FROM keys k LEFT JOIN stock_levels s ON s.variant_id = k.variant_id AND s.location_id = k.location_id
         WHERE COALESCE(s.qty,0) <> (SELECT COUNT(*) FROM product_units u WHERE u.variant_id = k.variant_id AND u.location_id = k.location_id AND u.status IN ('in_stock','returned'))
         ORDER BY k.variant_id, k.location_id LIMIT ${MISMATCH_CAP}`
      )
      .map((r) => ({ ...r, difference: r.level - r.units }))
    return { ok: mismatches.length === 0 && unitMismatches.length === 0, checked, mismatches, truncated, unitMismatches }
  }

  // ------------------------------------------------------------------ low stock
  lowStock(args: unknown) {
    this.app.requirePermission('inventory.view')
    const a = parse(z.object({ locationId: id.optional(), categoryId: id.optional(), search: text(100).optional(), ...page }), args)
    const r = this.stock({ ...a, status: 'low', limit: a.limit ?? 200 })
    return {
      total: r.total,
      rows: r.rows.map((x) => ({ ...x, suggestedQty: Math.max(x.reorderLevel * 2 - x.qty, 1) }))
    }
  }

  lowStockCount(args?: unknown): { low: number; out: number } {
    this.app.requirePermission('inventory.view')
    const a = parse(z.object({ locationId: id.optional() }), args)
    const f = this.stockFilter({ locationId: a.locationId, status: 'all' })
    const key = `lowcount|${f.sql}|${JSON.stringify(f.params)}`
    const hit = this.counts.get(key, dataStamp(this.db))
    if (hit) return hit
    const r = this.db.get<{ low: number; out: number }>(
      `SELECT COALESCE(SUM(reorderLevel > 0 AND qty <= reorderLevel),0) AS low, COALESCE(SUM(qty <= 0),0) AS out FROM (${f.totalsSql})`,
      ...f.params
    )
    return this.counts.set(key, dataStamp(this.db), { low: Number(r?.low ?? 0), out: Number(r?.out ?? 0) })
  }

  // ------------------------------------------------------------------ adjustments
  adjust(args: unknown) {
    this.app.requirePermission('inventory.adjust')
    const a = parse(
      z.object({
        variantId: id,
        locationId: id.optional(),
        delta: z.number().int().refine((n) => n !== 0, 'delta must be non-zero').refine((n) => Math.abs(n) <= 10_000_000),
        reason: z.enum(ADJUST_REASONS),
        note: text(500).optional(),
        /** unit-coded products: decreases must name the units (length === |delta|) */
        unitCodes: z.array(text(64).min(1)).max(10_000).optional(),
        /** unit-coded products: false = increase stock WITHOUT issuing unit codes (backfill later) */
        generateUnits: z.boolean().optional()
      }),
      args
    )
    if (a.reason === 'found' && a.delta < 0) throw new AppError('VALIDATION', 'Reason "found" must increase stock')
    if (['damage', 'expiry', 'theft'].includes(a.reason) && a.delta > 0)
      throw new AppError('VALIDATION', `Reason "${a.reason}" must decrease stock`)
    const variant = this.app.lookup.byId(a.variantId)
    if (!variant) throw new AppError('NOT_FOUND', 'Product variant not found')
    if (!variant.trackStock) throw new AppError('VALIDATION', 'This product does not track stock')
    const loc = a.locationId ?? this.app.defaultLocationId()
    if (!this.db.get('SELECT 1 FROM locations WHERE id=? AND active=1', loc)) throw new AppError('NOT_FOUND', 'Location not found')

    const units = this.units
    const tracked = !!units && variant.trackUnits
    // pieces without a label of their own (label printing switched tracking on) need no code: they complete the list
    const outCodes = tracked && a.delta < 0 ? units!.completeCodes(a.variantId, -a.delta, a.unitCodes, loc) : null
    if (tracked && a.delta < 0 && !outCodes)
      throw new AppError('VALIDATION', `${variant.displayName}: scan the ${-a.delta} unit code(s) being removed from stock`, { code: 'UNIT_CODES_REQUIRED', variantId: a.variantId, qty: -a.delta })
    if (a.unitCodes?.length && (!tracked || a.delta > 0)) throw new AppError('VALIDATION', 'unitCodes only apply to a decrease of a unit-coded product', { code: 'UNIT_NOT_TRACKED' })

    return this.db.transaction(() => {
      const uuid = this.app.uuid()
      const row = this.db.run(
        'INSERT INTO stock_adjustments(uuid,variant_id,location_id,qty_delta,reason,note,user_id) VALUES (?,?,?,?,?,?,?)',
        uuid, a.variantId, loc, a.delta, a.reason, a.note ?? '', this.app.session?.userId ?? null
      )
      const balance = this.app.moveStock({
        variantId: a.variantId, delta: a.delta, type: 'adjustment', locationId: loc, refType: 'adjustment',
        refId: row.lastId, unitCost: variant.cost, note: `${a.reason}${a.note ? ': ' + a.note : ''}`, allowNegative: false
      })
      let unitCodes: string[] = []
      if (tracked && a.delta < 0) unitCodes = units!.voidUnits(outCodes!, { reason: `Adjustment: ${a.reason}`, variantId: a.variantId, locationId: loc }).map((u) => u.code)
      else if (tracked && a.generateUnits !== false) unitCodes = units!.generateTx({ variantId: a.variantId, count: a.delta, locationId: loc, reason: `Adjustment: ${a.reason}` }).codes
      this.app.audit({
        entity: 'stock', entityId: a.variantId, action: 'adjust',
        old: { qty: balance - a.delta }, new: { qty: balance, delta: a.delta, reason: a.reason, locationId: loc }, note: a.note
      })
      this.app.enqueueSnapshot('stock_adjustments', row.lastId)
      /** unitCodes: codes issued (increase) or written off (decrease) for unit-coded products */
      return { id: row.lastId, uuid, balance, unitCodes }
    })
  }

  adjustments(args: unknown): Page<Record<string, unknown>> {
    this.app.requirePermission('inventory.view')
    const a = parse(z.object({ variantId: id.optional(), reason: z.enum(ADJUST_REASONS).optional(), from: z.number().int().optional(), to: z.number().int().optional(), ...page }), args)
    const where: string[] = []
    const params: (string | number)[] = []
    if (a.variantId) (where.push('a.variant_id = ?'), params.push(a.variantId))
    if (a.reason) (where.push('a.reason = ?'), params.push(a.reason))
    if (a.from != null) (where.push('a.created_at >= ?'), params.push(a.from))
    if (a.to != null) (where.push('a.created_at <= ?'), params.push(a.to))
    const wh = where.length ? 'WHERE ' + where.join(' AND ') : ''
    const from = `FROM stock_adjustments a JOIN product_variants v ON v.id=a.variant_id JOIN products p ON p.id=v.product_id
      JOIN locations l ON l.id=a.location_id LEFT JOIN users u ON u.id=a.user_id ${wh}`
    const total = this.db.value<number>(`SELECT COUNT(*) ${from}`, ...params) ?? 0
    const rows = this.db.all(
      `SELECT a.id, a.created_at AS createdAt, a.qty_delta AS qtyDelta, a.reason, a.note, a.variant_id AS variantId,
        p.name || CASE WHEN v.name<>'' THEN ' - '||v.name ELSE '' END AS displayName, v.sku, l.name AS locationName, u.name AS userName
       ${from} ORDER BY a.id DESC LIMIT ? OFFSET ?`,
      ...params, a.limit ?? 100, a.offset ?? 0
    )
    return { rows, total }
  }

  // ------------------------------------------------------------------ stock counts
  countCreate(args: unknown) {
    this.app.requirePermission('inventory.adjust')
    const a = parse(z.object({ locationId: id.optional(), categoryId: id.optional(), note: text().optional() }), args)
    const loc = a.locationId ?? this.app.defaultLocationId()
    if (!this.db.get('SELECT 1 FROM locations WHERE id=? AND active=1', loc)) throw new AppError('NOT_FOUND', 'Location not found')
    return this.db.transaction(() => {
      const items = this.db.all<{ id: number; qty: number }>(
        `SELECT v.id, COALESCE(sl.qty,0) AS qty FROM product_variants v JOIN products p ON p.id=v.product_id
         LEFT JOIN stock_levels sl ON sl.variant_id=v.id AND sl.location_id=?
         WHERE p.track_stock=1 AND ((v.active=1 AND p.active=1) OR COALESCE(sl.qty,0)<>0) ${a.categoryId ? 'AND p.category_id = ?' : ''}`,
        ...(a.categoryId ? [loc, a.categoryId] : [loc])
      )
      if (!items.length) throw new AppError('VALIDATION', 'No products to count for this selection')
      const number = this.app.nextNumber('CNT', { prefix: 'CNT' })
      const uuid = this.app.uuid()
      const c = this.db.run(
        'INSERT INTO stock_counts(uuid,number,location_id,status,note,user_id,category_id) VALUES (?,?,?,?,?,?,?)',
        uuid, number, loc, 'open', a.note ?? '', this.app.session?.userId ?? null, a.categoryId ?? null
      )
      for (const it of items)
        this.db.run('INSERT INTO stock_count_items(count_id,variant_id,expected_qty,counted_qty) VALUES (?,?,?,NULL)', c.lastId, it.id, it.qty)
      this.app.audit({ entity: 'stock_count', entityId: c.lastId, action: 'create', new: { number, locationId: loc, items: items.length } })
      this.enqueueCount(c.lastId)
      return { id: c.lastId, number, items: items.length }
    })
  }

  private enqueueCount(countId: number) {
    this.app.enqueueSnapshot('stock_counts', countId, [{ table: 'stock_count_items', fk: 'count_id' }])
  }

  private openCount(countId: number) {
    const c = this.db.get<{ id: number; number: string; status: string; location_id: number }>('SELECT id, number, status, location_id FROM stock_counts WHERE id=?', countId)
    if (!c) throw new AppError('NOT_FOUND', 'Stock count not found')
    if (c.status !== 'open') throw new AppError('CONFLICT', `Stock count ${c.number} is ${c.status} and can no longer be changed`)
    return c
  }

  countList(args: unknown): Page<Record<string, unknown>> {
    this.app.requirePermission('inventory.view')
    const a = parse(z.object({ status: z.enum(['open', 'applied', 'cancelled']).optional(), ...page }), args)
    const wh = a.status ? 'WHERE c.status = ?' : ''
    const params = a.status ? [a.status] : []
    const total = this.db.value<number>(`SELECT COUNT(*) FROM stock_counts c ${wh}`, ...params) ?? 0
    const rows = this.db.all(
      `SELECT c.id, c.number, c.status, c.note, c.created_at AS createdAt, c.applied_at AS appliedAt, l.name AS locationName, c.location_id AS locationId,
        (SELECT COUNT(*) FROM stock_count_items i WHERE i.count_id=c.id) AS itemCount,
        (SELECT COUNT(*) FROM stock_count_items i WHERE i.count_id=c.id AND i.counted_qty IS NOT NULL) AS countedCount,
        (SELECT COUNT(*) FROM stock_count_items i WHERE i.count_id=c.id AND i.counted_qty IS NOT NULL AND i.counted_qty<>i.expected_qty) AS varianceCount
       FROM stock_counts c JOIN locations l ON l.id=c.location_id ${wh} ORDER BY c.id DESC LIMIT ? OFFSET ?`,
      ...params, a.limit ?? 100, a.offset ?? 0
    )
    return { rows, total }
  }

  countGet(args: unknown) {
    this.app.requirePermission('inventory.view')
    const a = parse(
      z.object({ id, filter: z.enum(['all', 'uncounted', 'counted', 'variance']).optional(), search: text(100).optional(), ...page }),
      args
    )
    const c = this.db.get<Record<string, unknown>>(
      `SELECT c.id, c.number, c.status, c.note, c.created_at AS createdAt, c.applied_at AS appliedAt, c.location_id AS locationId, l.name AS locationName, c.category_id AS categoryId
       FROM stock_counts c JOIN locations l ON l.id=c.location_id WHERE c.id=?`,
      a.id
    )
    if (!c) throw new AppError('NOT_FOUND', 'Stock count not found')
    const where = ['i.count_id = ?']
    const params: (string | number)[] = [a.id]
    if (a.filter === 'uncounted') where.push('i.counted_qty IS NULL')
    if (a.filter === 'counted') where.push('i.counted_qty IS NOT NULL')
    if (a.filter === 'variance') where.push('i.counted_qty IS NOT NULL AND i.counted_qty <> i.expected_qty')
    if (a.search?.trim()) {
      const q = likeTerm(a.search)
      where.push("(p.name LIKE ? ESCAPE '\\' OR v.name LIKE ? ESCAPE '\\' OR v.sku LIKE ? ESCAPE '\\' OR v.barcode LIKE ? ESCAPE '\\')")
      params.push(q, q, q, q)
    }
    const costOk = this.canCost()
    // size of the filtered sheet (drives the pager); the item list itself is paged: a full-catalogue count has 20k+ lines
    const total = this.db.value<number>(
      `SELECT COUNT(*) FROM stock_count_items i JOIN product_variants v ON v.id=i.variant_id JOIN products p ON p.id=v.product_id WHERE ${where.join(' AND ')}`,
      ...params
    ) ?? 0
    const items = this.db
      .all<Record<string, unknown>>(
        `SELECT i.variant_id AS variantId, i.expected_qty AS expectedQty, i.counted_qty AS countedQty,
          CASE WHEN i.counted_qty IS NULL THEN NULL ELSE i.counted_qty - i.expected_qty END AS variance,
          p.name || CASE WHEN v.name<>'' THEN ' - '||v.name ELSE '' END AS displayName, v.sku, v.barcode, v.cost
         FROM stock_count_items i JOIN product_variants v ON v.id=i.variant_id JOIN products p ON p.id=v.product_id
         WHERE ${where.join(' AND ')} ORDER BY p.name COLLATE NOCASE, v.name LIMIT ? OFFSET ?`,
        ...params, a.limit ?? 200, a.offset ?? 0
      )
      .map((r) => ({ ...r, cost: costOk ? r.cost : null }))
    const s = this.db.get<{ n: number; counted: number; variances: number; surplus: number; shortage: number; impact: number }>(
      `SELECT COUNT(*) n, COALESCE(SUM(counted_qty IS NOT NULL),0) counted,
        COALESCE(SUM(counted_qty IS NOT NULL AND counted_qty<>expected_qty),0) variances,
        COALESCE(SUM(CASE WHEN counted_qty>expected_qty THEN counted_qty-expected_qty ELSE 0 END),0) surplus,
        COALESCE(SUM(CASE WHEN counted_qty<expected_qty THEN expected_qty-counted_qty ELSE 0 END),0) shortage,
        COALESCE(SUM(CASE WHEN counted_qty IS NULL THEN 0 ELSE (counted_qty-expected_qty)*v.cost END),0) impact
       FROM stock_count_items i JOIN product_variants v ON v.id=i.variant_id WHERE i.count_id=?`,
      a.id
    )
    return {
      ...c,
      items,
      total,
      summary: {
        items: Number(s?.n ?? 0), counted: Number(s?.counted ?? 0), uncounted: Number(s?.n ?? 0) - Number(s?.counted ?? 0),
        varianceItems: Number(s?.variances ?? 0), surplusQty: Number(s?.surplus ?? 0), shortageQty: Number(s?.shortage ?? 0),
        valueImpact: costOk ? Number(s?.impact ?? 0) : null
      }
    }
  }

  /** Enter counted quantities (null clears an entry). */
  countSet(args: unknown) {
    this.app.requirePermission('inventory.adjust')
    const a = parse(
      z.object({ countId: id, entries: z.array(z.object({ variantId: id, countedQty: z.number().int().min(0).max(10_000_000).nullable() })).min(1).max(20_000) }),
      args
    )
    return this.db.transaction(() => {
      const cnt = this.openCount(a.countId)
      let updated = 0
      for (const e of a.entries) {
        if (this.units?.isTracked(e.variantId)) {
          // unit-coded products are counted by scanning each unit's label: only "none present" (0) or "clear" (null) can be typed.
          // Exception: pieces that never got a label of their own cannot be scanned, so a TOTAL may be typed that covers the
          // scanned units plus at most that many unlabelled pieces.
          if (e.countedQty != null && e.countedQty !== 0) {
            const plainMax = this.units.unlabelledCount(e.variantId, cnt.location_id)
            const scannedHere = this.units.countedScanned(a.countId, e.variantId, cnt.location_id)
            if (!plainMax)
              throw new AppError('VALIDATION', 'This product is counted by scanning its unit codes, not by typing a quantity', { code: 'UNIT_CODE_REQUIRED', variantId: e.variantId })
            if (e.countedQty < scannedHere || e.countedQty > scannedHere + plainMax)
              throw new AppError('VALIDATION', `${scannedHere} unit label(s) were scanned and ${plainMax} piece(s) have no label of their own: enter a total from ${scannedHere} to ${scannedHere + plainMax}, and scan the labelled pieces`, { code: 'UNIT_CODE_REQUIRED', variantId: e.variantId, scanned: scannedHere, unlabelled: plainMax })
          } else this.db.run('DELETE FROM stock_count_units WHERE count_id=? AND variant_id=?', a.countId, e.variantId)
        }
        const r = this.db.run('UPDATE stock_count_items SET counted_qty=? WHERE count_id=? AND variant_id=?', e.countedQty, a.countId, e.variantId)
        if (!r.changes) throw new AppError('NOT_FOUND', `Variant ${e.variantId} is not on this count sheet`)
        updated += r.changes
      }
      this.enqueueCount(a.countId)
      return { updated }
    })
  }

  /** Scan-to-count: resolves the barcode/SKU and adds `qty` (default 1) to the counted quantity, or sets it. */
  countScan(args: unknown) {
    this.app.requirePermission('inventory.adjust')
    const a = parse(z.object({ countId: id, code: text(100).min(1), qty: z.number().int().min(0).max(1_000_000).optional(), mode: z.enum(['add', 'set']).optional() }), args)
    return this.db.transaction(() => {
      const cnt = this.openCount(a.countId)
      const v = this.app.lookup.byScan(a.code)
      if (!v) throw new AppError('NOT_FOUND', `No product matches "${a.code}"`)
      const item = this.db.get<{ counted_qty: number | null; expected_qty: number }>('SELECT counted_qty, expected_qty FROM stock_count_items WHERE count_id=? AND variant_id=?', a.countId, v.variantId)
      if (!item) throw new AppError('NOT_FOUND', `${v.displayName} is not on this count sheet`)
      const su = scannedUnitOf(v)
      // pieces of a unit-coded product counted by quantity so far (only possible for pieces without a label of their own)
      const plainBefore = v.trackUnits && this.units ? this.units.countedPlain(a.countId, v.variantId, cnt.location_id) : 0
      if (v.trackUnits && !su) {
        // the shared product barcode still counts the pieces that never got a label of their own
        const plainMax = this.units?.unlabelledCount(v.variantId, cnt.location_id) ?? 0
        const q = a.qty ?? 1
        const plain = a.mode === 'set' ? q : plainBefore + q
        if (plain > plainMax)
          throw new AppError('VALIDATION', `${v.displayName} is counted by scanning each unit's code label`, { code: 'UNIT_CODE_REQUIRED', variantId: v.variantId, unlabelled: plainMax })
        const next = this.units!.countedScanned(a.countId, v.variantId, cnt.location_id) + plain
        this.db.run('UPDATE stock_count_items SET counted_qty=? WHERE count_id=? AND variant_id=?', next, a.countId, v.variantId)
        this.enqueueCount(a.countId)
        return { variantId: v.variantId, displayName: v.displayName, sku: v.sku, expectedQty: item.expected_qty, countedQty: next, variance: next - item.expected_qty }
      }
      if (su) {
        // active-list rule: a code already scanned in this count is NOT added again (duplicate warning), otherwise it is added
        const code = su.code
        const dup = !!this.db.get('SELECT 1 FROM stock_count_units WHERE count_id=? AND code=?', a.countId, code)
        if (!dup) this.db.run('INSERT INTO stock_count_units(count_id,code,variant_id) VALUES (?,?,?)', a.countId, code, v.variantId)
        const u = this.units!.rowByCode(code)!
        const expectedHere = (u.status === 'in_stock' || u.status === 'returned') && u.location_id === cnt.location_id
        const counted = this.units!.countedScanned(a.countId, v.variantId, cnt.location_id) + plainBefore
        this.db.run('UPDATE stock_count_items SET counted_qty=? WHERE count_id=? AND variant_id=?', counted, a.countId, v.variantId)
        this.enqueueCount(a.countId)
        return {
          variantId: v.variantId, displayName: v.displayName, sku: v.sku, expectedQty: item.expected_qty, countedQty: counted, variance: counted - item.expected_qty,
          unit: { code, status: u.status }, duplicate: dup, unexpected: !expectedHere
        }
      }
      const q = a.qty ?? 1
      const next = a.mode === 'set' ? q : (item.counted_qty ?? 0) + q
      this.db.run('UPDATE stock_count_items SET counted_qty=? WHERE count_id=? AND variant_id=?', next, a.countId, v.variantId)
      this.enqueueCount(a.countId)
      return { variantId: v.variantId, displayName: v.displayName, sku: v.sku, expectedQty: item.expected_qty, countedQty: next, variance: next - item.expected_qty }
    })
  }

  /**
   * Apply: for every counted line with a variance, post a 'count' movement of (counted - expected). Applying the
   * difference (not an absolute overwrite) keeps sales that happened while counting. One transaction; the count
   * becomes 'applied' and immutable. Uncounted lines are left untouched.
   */
  countApply(args: unknown) {
    this.app.requirePermission('inventory.adjust')
    const a = parse(z.object({ countId: id }), args)
    return this.db.transaction(() => {
      const c = this.openCount(a.countId)
      const diffs = this.db.all<{ variant_id: number; expected_qty: number; counted_qty: number; cost: number }>(
        `SELECT i.variant_id, i.expected_qty, i.counted_qty, v.cost FROM stock_count_items i JOIN product_variants v ON v.id=i.variant_id
         JOIN products p ON p.id=v.product_id
         WHERE i.count_id=? AND i.counted_qty IS NOT NULL AND i.counted_qty <> i.expected_qty AND p.track_units = 0`,
        a.countId
      )
      // unit-coded products: scanned unit codes vs the in-stock units; missing ones are voided (reason 'count') and leave stock
      const unitResult = this.units ? this.units.applyCount(a.countId, c.number) : { missing: [] as string[], unexpected: [] as string[], variants: 0 }
      for (const d of diffs)
        this.app.moveStock({
          variantId: d.variant_id, delta: d.counted_qty - d.expected_qty, type: 'count', locationId: c.location_id,
          refType: 'stock_count', refId: c.id, unitCost: d.cost, note: `Count ${c.number}`, allowNegative: false
        })
      const uncounted = this.db.value<number>('SELECT COUNT(*) FROM stock_count_items WHERE count_id=? AND counted_qty IS NULL', a.countId) ?? 0
      this.db.run("UPDATE stock_counts SET status='applied', applied_at=? WHERE id=?", Date.now(), a.countId)
      this.app.audit({ entity: 'stock_count', entityId: a.countId, action: 'apply', new: { number: c.number, adjusted: diffs.length + unitResult.variants, uncounted, missingUnits: unitResult.missing, unexpectedUnits: unitResult.unexpected } })
      this.enqueueCount(a.countId)
      // missingUnits / unexpectedUnits are only present when the sheet contains unit-coded products
      const hasUnitLines = !!this.db.get(
        'SELECT 1 FROM stock_count_items i JOIN product_variants v ON v.id=i.variant_id JOIN products p ON p.id=v.product_id WHERE i.count_id=? AND p.track_units=1 LIMIT 1', a.countId
      )
      return {
        adjusted: diffs.length + unitResult.variants, uncounted,
        ...(hasUnitLines ? { missingUnits: unitResult.missing, unexpectedUnits: unitResult.unexpected } : {})
      }
    })
  }

  countCancel(args: unknown) {
    this.app.requirePermission('inventory.adjust')
    const a = parse(z.object({ countId: id }), args)
    return this.db.transaction(() => {
      const c = this.openCount(a.countId)
      this.db.run("UPDATE stock_counts SET status='cancelled', cancelled_at=? WHERE id=?", Date.now(), a.countId)
      this.app.audit({ entity: 'stock_count', entityId: a.countId, action: 'cancel', new: { number: c.number } })
      this.enqueueCount(a.countId)
      return { ok: true }
    })
  }

  // ------------------------------------------------------------------ transfers
  transferCreate(args: unknown) {
    this.app.requirePermission('inventory.adjust')
    const a = parse(
      z.object({
        fromLocationId: id, toLocationId: id, note: text().optional(),
        items: z.array(z.object({ variantId: id, qty: z.number().int().positive().max(10_000_000), unitCodes: z.array(text(64).min(1)).max(10_000).optional() })).min(1).max(500)
      }),
      args
    )
    if (a.fromLocationId === a.toLocationId) throw new AppError('VALIDATION', 'Source and destination must differ')
    for (const l of [a.fromLocationId, a.toLocationId])
      if (!this.db.get('SELECT 1 FROM locations WHERE id=? AND active=1', l)) throw new AppError('NOT_FOUND', 'Location not found')
    return this.db.transaction(() => {
      const number = this.app.nextNumber('TRF', { prefix: 'TRF' })
      const uuid = this.app.uuid()
      const t = this.db.run(
        'INSERT INTO stock_transfers(uuid,number,from_location_id,to_location_id,status,note,user_id) VALUES (?,?,?,?,?,?,?)',
        uuid, number, a.fromLocationId, a.toLocationId, 'completed', a.note ?? '', this.app.session?.userId ?? null
      )
      for (const it of a.items) {
        const v = this.app.lookup.byId(it.variantId)
        if (!v) throw new AppError('NOT_FOUND', `Variant ${it.variantId} not found`)
        if (!v.trackStock) throw new AppError('VALIDATION', `${v.displayName} does not track stock`)
        const moveCodes = v.trackUnits && this.units ? this.units.completeCodes(it.variantId, it.qty, it.unitCodes, a.fromLocationId) : null
        if (v.trackUnits && this.units ? !moveCodes : v.trackUnits && it.unitCodes?.length !== it.qty)
          throw new AppError('VALIDATION', `${v.displayName}: scan the ${it.qty} unit code(s) being transferred`, { code: 'UNIT_CODES_REQUIRED', variantId: it.variantId, qty: it.qty })
        if (!v.trackUnits && it.unitCodes?.length) throw new AppError('VALIDATION', `${v.displayName} does not track unit codes`, { code: 'UNIT_NOT_TRACKED' })
        this.db.run('INSERT INTO stock_transfer_items(transfer_id,variant_id,qty) VALUES (?,?,?)', t.lastId, it.variantId, it.qty)
        if (v.trackUnits && this.units) this.units.moveUnits(moveCodes!, { variantId: it.variantId, fromLocationId: a.fromLocationId, toLocationId: a.toLocationId })
        this.app.moveStock({ variantId: it.variantId, delta: -it.qty, type: 'transfer_out', locationId: a.fromLocationId, refType: 'transfer', refId: t.lastId, unitCost: v.cost, note: number, allowNegative: false })
        this.app.moveStock({ variantId: it.variantId, delta: it.qty, type: 'transfer_in', locationId: a.toLocationId, refType: 'transfer', refId: t.lastId, unitCost: v.cost, note: number, allowNegative: false })
      }
      this.app.audit({ entity: 'stock_transfer', entityId: t.lastId, action: 'create', new: { number, from: a.fromLocationId, to: a.toLocationId, lines: a.items.length } })
      this.app.enqueueSnapshot('stock_transfers', t.lastId, [{ table: 'stock_transfer_items', fk: 'transfer_id' }])
      return { id: t.lastId, number, uuid }
    })
  }

  transferList(args: unknown): Page<Record<string, unknown>> {
    this.app.requirePermission('inventory.view')
    const a = parse(z.object({ ...page }), args)
    const total = this.db.value<number>('SELECT COUNT(*) FROM stock_transfers') ?? 0
    const rows = this.db.all(
      `SELECT t.id, t.number, t.status, t.note, t.created_at AS createdAt, f.name AS fromName, o.name AS toName,
        (SELECT COUNT(*) FROM stock_transfer_items i WHERE i.transfer_id=t.id) AS lines,
        (SELECT COALESCE(SUM(qty),0) FROM stock_transfer_items i WHERE i.transfer_id=t.id) AS qty
       FROM stock_transfers t JOIN locations f ON f.id=t.from_location_id JOIN locations o ON o.id=t.to_location_id
       ORDER BY t.id DESC LIMIT ? OFFSET ?`,
      a.limit ?? 100, a.offset ?? 0
    )
    return { rows, total }
  }

  transferGet(args: unknown) {
    this.app.requirePermission('inventory.view')
    const a = parse(z.object({ id }), args)
    const t = this.db.get<Record<string, unknown>>(
      `SELECT t.id, t.number, t.status, t.note, t.created_at AS createdAt, f.name AS fromName, o.name AS toName
       FROM stock_transfers t JOIN locations f ON f.id=t.from_location_id JOIN locations o ON o.id=t.to_location_id WHERE t.id=?`,
      a.id
    )
    if (!t) throw new AppError('NOT_FOUND', 'Transfer not found')
    const items = this.db.all(
      `SELECT i.variant_id AS variantId, i.qty, p.name || CASE WHEN v.name<>'' THEN ' - '||v.name ELSE '' END AS displayName, v.sku
       FROM stock_transfer_items i JOIN product_variants v ON v.id=i.variant_id JOIN products p ON p.id=v.product_id WHERE i.transfer_id=?`,
      a.id
    )
    return { ...t, items }
  }
}

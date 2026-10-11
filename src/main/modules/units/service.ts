import { z } from 'zod'
import type { App } from '../../core/app'
import type { SellableVariant, UnitStatus } from '../../core/lookup'
import { findUnit } from '../../core/lookup'
import { AppError } from '@shared/ipc'
import { hasPermission, type Permission } from '@shared/permissions'
import { MAX_LABEL_SEQ, duplicateMessage, formatUnitCode, isLabelPrefix, maxSeqFor, normalizeUnitCode, parseUnitCode } from '@shared/scanList'
import { enqueueProductSnapshot } from '../catalog/service'
import { id, likeTerm, page, parse, text } from '../inventory/util'

export interface UnitRow {
  id: number
  uuid: string
  variant_id: number
  prefix: string
  seq: number
  code: string
  status: UnitStatus
  sale_id: number | null
  sale_item_id: number | null
  purchase_id: number | null
  location_id: number | null
  void_reason: string | null
  /** when this unit's own label was (first) printed; null = it never got a label of its own */
  label_printed_at: number | null
  created_at: number
  updated_at: number
}

export interface GenerateResult {
  codes: string[]
  prefix: string
  firstSeq: number
  lastSeq: number
}

export interface LabelPlan {
  variantId: number
  displayName: string
  /** 'unique' = every label gets its own number; 'shared' = the product does not track stock, labels carry the product barcode */
  mode: 'unique' | 'shared'
  tracked: boolean
  prefix: string | null
  stock: number
  /** in-stock pieces at this location that never got a label of their own */
  unlabelled: number
  /** the numbers the next labels will carry (preview only; nothing is reserved) */
  previewCodes: string[]
  /** why new numbers cannot be issued here (e.g. this terminal is a sync client), else null */
  blocked: string | null
  /** the signed-in user may receive extra pieces into stock while printing */
  canReceive: boolean
}

export interface IssuedLabels {
  variantId: number
  prefix: string
  codes: string[]
  /** pieces that were received into stock because more labels were asked for than unlabelled stock existed */
  received: number
}

export const ADMIN_ONLY_MESSAGE =
  'New label numbers can only be issued on the admin system, so that two computers never give out the same number. Print these labels (and receive this stock) on the admin system.'

export interface StockMoveTemplate {
  type: string
  refType?: string
  refId?: string | number
  note?: string
  allowNegative?: boolean
}

/** Statuses that are physically on the shelf and may be sold. */
export const AVAILABLE: UnitStatus[] = ['in_stock', 'returned']
const AVAIL_SQL = `('in_stock','returned')`
export const isAvailable = (s: string): boolean => s === 'in_stock' || s === 'returned'

const PREFIX_RE = /^[A-Z0-9]{2,8}$/
const prefixSchema = z.string().trim().transform((s) => s.toUpperCase()).refine((s) => PREFIX_RE.test(s), 'Prefix must be 2-8 letters/digits (A-Z, 0-9)')

const range = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, i) => from + i)
/** GLOB patterns of the codes a prefix can issue (the current spelling first). A 4-digit prefix may also own older PREFIX-NNNN codes. */
const codePatterns = (prefix: string): string[] =>
  isLabelPrefix(prefix) ? [`${prefix}${'[0-9]'.repeat(6)}`, `${prefix}-${'[0-9]'.repeat(4)}`] : [`${prefix}-${'[0-9]'.repeat(4)}`]

export const statusMessage = (code: string, status: string): string =>
  status === 'sold' ? `Unit ${code} is already sold`
    : status === 'void' ? `Unit ${code} is void (damaged/lost) and cannot be used`
      : `Unit ${code} is ${status.replace('_', ' ')}`

const notAvailable = (code: string, status: string, extra: Record<string, unknown> = {}) =>
  new AppError('CONFLICT', statusMessage(code, status), { code: 'UNIT_NOT_AVAILABLE', status, unitCode: code, ...extra })

/**
 * Per-unit identification codes (PREFIX-NNNN). See ARCHITECTURE.md "Unit codes".
 * Public (exposed) methods check permissions + validate input; the `*Tx` / internal methods are for sibling services
 * (pos, inventory, catalog), which have already checked their own permission, and must run inside the caller's transaction.
 */
export class UnitsService {
  constructor(private app: App) {}

  private get db() {
    return this.app.db
  }

  private requireAny(...perms: Permission[]) {
    const s = this.app.requireSession()
    if (!perms.some((p) => hasPermission(s.permissions, p))) throw new AppError('FORBIDDEN', `Permission required: ${perms.join(' or ')}`)
    return s
  }

  // ------------------------------------------------------------------ small lookups
  isTracked(variantId: number): boolean {
    return !!this.db.value<number>('SELECT p.track_units FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.id = ?', variantId)
  }

  rowByCode(code: string): UnitRow | undefined {
    return this.db.get<UnitRow>('SELECT * FROM product_units WHERE code = ?', normalizeUnitCode(code))
  }

  private variantName(variantId: number): string {
    return this.db.value<string>(`SELECT p.name || CASE WHEN v.name<>'' THEN ' - '||v.name ELSE '' END FROM product_variants v JOIN products p ON p.id=v.product_id WHERE v.id=?`, variantId) ?? `#${variantId}`
  }

  private stockAt(variantId: number, locationId: number): number {
    return this.db.value<number>('SELECT qty FROM stock_levels WHERE variant_id = ? AND location_id = ?', variantId, locationId) ?? 0
  }

  availableAt(variantId: number, locationId: number): number {
    return this.db.value<number>(`SELECT COUNT(*) FROM product_units WHERE variant_id = ? AND location_id = ? AND status IN ${AVAIL_SQL}`, variantId, locationId) ?? 0
  }

  /** True when this terminal may issue new numbers (a LAN-sync client must not: the admin system owns the counters). */
  canIssue(): boolean {
    return this.app.setting('sync.role', 'standalone') !== 'client'
  }

  private assertCanIssue(): void {
    if (!this.canIssue()) throw new AppError('FORBIDDEN', ADMIN_ONLY_MESSAGE, { code: 'LABELS_ADMIN_ONLY' })
  }

  /**
   * In-stock units that never got a label of their own, for products whose unit tracking was switched on automatically by
   * label printing (products.unit_auto). Only these may still be sold / moved / counted by the product's shared barcode or by
   * quantity. Always empty for products where the owner ticked "track each unit" (strict: every unit is named by its code).
   */
  unlabelledRows(variantId: number, o: { locationId?: number; limit?: number; excludeIds?: Set<number> } = {}): UnitRow[] {
    const rows = this.db.all<UnitRow>(
      `SELECT u.* FROM product_units u JOIN product_variants v ON v.id = u.variant_id JOIN products p ON p.id = v.product_id
       WHERE u.variant_id = ? AND p.track_units = 1 AND p.unit_auto = 1 AND u.label_printed_at IS NULL AND u.status IN ${AVAIL_SQL}
         ${o.locationId != null ? 'AND u.location_id = ?' : ''}
       ORDER BY u.seq, u.id`,
      ...(o.locationId != null ? [variantId, o.locationId] : [variantId])
    )
    const free = o.excludeIds?.size ? rows.filter((r) => !o.excludeIds!.has(r.id)) : rows
    return o.limit != null ? free.slice(0, o.limit) : free
  }

  unlabelledCount(variantId: number, locationId?: number): number {
    return (
      this.db.value<number>(
        `SELECT COUNT(*) FROM product_units u JOIN product_variants v ON v.id = u.variant_id JOIN products p ON p.id = v.product_id
         WHERE u.variant_id = ? AND p.track_units = 1 AND p.unit_auto = 1 AND u.label_printed_at IS NULL AND u.status IN ${AVAIL_SQL}
           ${locationId != null ? 'AND u.location_id = ?' : ''}`,
        ...(locationId != null ? [variantId, locationId] : [variantId])
      ) ?? 0
    )
  }

  /**
   * Unit codes for `qty` pieces of a tracked variant: the codes that were scanned, completed with pieces that have no label of
   * their own (lowest number first). null when that is not possible (more codes than pieces, or not enough unlabelled pieces):
   * the caller then reports its own "scan the unit codes" error.
   */
  completeCodes(variantId: number, qty: number, codes: string[] | undefined, locationId?: number): string[] | null {
    const given = (codes ?? []).map(normalizeUnitCode)
    if (given.length === qty) return given
    if (given.length > qty) return null
    const named = new Set(given)
    const fill = this.unlabelledRows(variantId, { locationId }).filter((u) => !named.has(u.code)).slice(0, qty - given.length)
    return fill.length === qty - given.length ? [...given, ...fill.map((u) => u.code)] : null
  }

  /**
   * The next pieces of a tracked product that can still be sold, for "+" and a typed quantity on a bill line (the cashier does
   * not have to scan every label). `exclude` = codes already on the bill. Pieces that never got a label of their own come first:
   * taking one of those cannot disagree with a printed label on the shelf. `left` = pieces that would still be free afterwards.
   */
  nextAvailable(args: unknown): { codes: string[]; left: number } {
    this.requireAny('pos.sell')
    const a = parse(z.object({ variantId: id, exclude: z.array(z.string().trim().min(1).max(64)).max(10_000).optional(), count: z.number().int().min(1).max(1000).optional() }), args)
    const skip = new Set((a.exclude ?? []).map(normalizeUnitCode))
    const free = this.db
      .all<{ code: string }>(`SELECT code FROM product_units WHERE variant_id = ? AND status IN ${AVAIL_SQL} ORDER BY (label_printed_at IS NOT NULL), seq, id`, a.variantId)
      .filter((u) => !skip.has(u.code))
    const codes = free.slice(0, a.count ?? 1).map((u) => u.code)
    return { codes, left: free.length - codes.length }
  }

  private bump(ids: number[]): void {
    this.enqueueUnits(ids)
  }

  /** Fast sync snapshots for units (no PRAGMA introspection). Skipped entirely while sync is off. */
  private enqueueUnits(ids: number[]): void {
    if (!ids.length || !this.app.syncActive()) return
    const cache = new Map<string, { table: string; uuid: string } | null>()
    const ref = (table: string, rid: number | null) => {
      if (rid == null) return null
      const k = `${table}:${rid}`
      if (!cache.has(k)) {
        const uuid = this.db.value<string>(`SELECT uuid FROM ${table} WHERE id = ?`, rid)
        cache.set(k, uuid ? { table, uuid } : null)
      }
      return cache.get(k) ?? null
    }
    for (const uid of ids) {
      const r = this.db.get<UnitRow>('SELECT * FROM product_units WHERE id = ?', uid)
      if (!r) continue
      this.app.enqueueSync('product_units', r.uuid, 'upsert', {
        table: 'product_units', uuid: r.uuid, row: r,
        refs: {
          variant_id: ref('product_variants', r.variant_id), sale_id: ref('sales', r.sale_id), sale_item_id: null,
          purchase_id: ref('purchases', r.purchase_id), location_id: ref('locations', r.location_id)
        }
      })
    }
  }

  // ------------------------------------------------------------------ prefixes
  /** Barcodes / aliases / SKUs that look like PREFIX-NNNN (a unit code namespace clash). */
  private namespaceClash(prefix: string): string | undefined {
    for (const pat of codePatterns(prefix)) {
      const hit =
        this.db.value<string>('SELECT barcode FROM product_variants WHERE barcode GLOB ? LIMIT 1', pat) ??
        this.db.value<string>('SELECT barcode FROM variant_barcodes WHERE barcode GLOB ? LIMIT 1', pat) ??
        this.db.value<string>('SELECT sku FROM product_variants WHERE upper(sku) GLOB ? LIMIT 1', pat)
      if (hit) return hit
    }
    return undefined
  }

  /**
   * The next free 4-digit label prefix (2000, 2001 ... 9999, then 1000-1999): never used by a product, a unit or a counter, and
   * not the start of an existing 10-digit barcode / SKU. One per product, assigned automatically; nobody has to invent one.
   */
  nextLabelPrefix(): string {
    const used = new Set<string>([
      ...this.db.all<{ p: string }>('SELECT upper(unit_prefix) AS p FROM products WHERE unit_prefix IS NOT NULL').map((r) => r.p),
      ...this.db.all<{ p: string }>('SELECT prefix AS p FROM unit_sequences').map((r) => r.p),
      ...this.db.all<{ p: string }>('SELECT DISTINCT prefix AS p FROM product_units').map((r) => r.p)
    ])
    // the product barcode generator ("Barcode numbering") must never run into a label prefix: when it issues 10-digit numbers,
    // every 4-digit start it can produce is left to it
    const bp = this.app.setting('catalog.barcode_prefix', '200')
    const generated =
      this.app.setting('catalog.barcode_mode', 'sequence') === 'sequence' && /^\d+$/.test(bp) && bp.length + (Number(this.app.setting('catalog.barcode_width', '6')) || 6) === 10
        ? bp.slice(0, 4)
        : null
    for (const n of [...range(2000, 9999), ...range(1000, 1999)]) {
      const p = String(n)
      if (generated && p.startsWith(generated)) continue
      if (!used.has(p) && !this.namespaceClash(p)) return p
    }
    throw new AppError('CONFLICT', 'All 9,000 label prefixes (1000-9999) are in use. No new product can get label numbers.', { code: 'PREFIX_EXHAUSTED' })
  }

  private prefixTaken(prefix: string, exceptProductId = 0): boolean {
    return (
      !!this.db.get('SELECT 1 FROM products WHERE unit_prefix = ? COLLATE NOCASE AND id <> ?', prefix, exceptProductId) ||
      !!this.db.get(
        `SELECT 1 FROM product_units u JOIN product_variants v ON v.id = u.variant_id WHERE u.prefix = ? AND v.product_id <> ? LIMIT 1`, prefix, exceptProductId
      )
    )
  }

  private checkPrefixFree(prefix: string, productId: number): void {
    if (this.prefixTaken(prefix, productId)) throw new AppError('CONFLICT', `Prefix ${prefix} is already used by another product`, { code: 'PREFIX_TAKEN', prefix })
    const clash = this.namespaceClash(prefix)
    if (clash) throw new AppError('CONFLICT', `Prefix ${prefix} would collide with the existing barcode/SKU ${clash}`, { code: 'PREFIX_CLASH', prefix, existing: clash })
  }

  /** A unique, readable prefix for a product name (e.g. "Sparkler Box" -> SPR, then SPR2, SPR3 ... when taken). */
  suggestPrefixFor(name: string, exceptProductId = 0): string {
    const words = name.toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean)
    const w0 = words[0] ?? ''
    const cons = w0 ? w0[0] + w0.slice(1).replace(/[AEIOU]/g, '') : ''
    const initials = words.map((w) => w[0]).join('')
    const pad = (s: string) => (s.length >= 2 ? s : (s + 'XX').slice(0, 2))
    const bases = [cons.slice(0, 3), w0.slice(0, 3), initials.length >= 2 ? initials.slice(0, 4) : '', cons.slice(0, 4), w0.slice(0, 4), words.join('').slice(0, 5), 'ITM']
      .filter(Boolean)
      .map(pad)
    const ok = (p: string) => PREFIX_RE.test(p) && !this.prefixTaken(p, exceptProductId) && !this.namespaceClash(p) && !this.db.get('SELECT 1 FROM unit_sequences WHERE prefix = ?', p)
    for (const b of bases) if (ok(b)) return b
    const base = bases[0]
    for (let n = 2; n < 100_000; n++) {
      const p = base.slice(0, Math.max(2, 8 - String(n).length)) + n
      if (ok(p)) return p
    }
    throw new AppError('INTERNAL', 'Could not find a free unit prefix')
  }

  suggestPrefix(args: unknown): { prefix: string } {
    this.requireAny('catalog.view', 'catalog.edit')
    const a = parse(z.object({ name: text(200), productId: id.optional() }), args)
    // a product that already has its prefix keeps it: re-opening the form or renaming the product must never propose another one
    // (only once all 9999 codes of that prefix are used does it need a new prefix)
    const own = a.productId ? this.db.value<string | null>('SELECT unit_prefix FROM products WHERE id = ?', a.productId) : null
    if (own && (this.db.value<number>('SELECT last_seq FROM unit_sequences WHERE prefix = ?', own) ?? 0) < maxSeqFor(own)) return { prefix: own }
    return { prefix: this.suggestPrefixFor(a.name, a.productId ?? 0) }
  }

  // ------------------------------------------------------------------ generation
  /**
   * Issue `count` new unit codes for a tracked variant, gap-free and atomic (one transaction; a failure rolls back the
   * sequence too). Only stock that has no code yet can be coded (count <= remaining), so stock == in-stock units holds.
   * NO permission check: callers (receiving, adjustments, catalog backfill, generate()) check their own.
   */
  generateTx(o: { variantId: number; count: number; purchaseId?: number | null; locationId?: number; reason?: string; checkStock?: boolean }): GenerateResult {
    return this.db.transaction(() => {
      if (!Number.isInteger(o.count) || o.count < 1 || o.count > MAX_LABEL_SEQ) throw new AppError('VALIDATION', `Unit count must be 1..${MAX_LABEL_SEQ}`)
      // a LAN-sync client never issues numbers: the admin system owns the counters, so no number can be given out twice
      this.assertCanIssue()
      const v = this.db.get<{ product_id: number; track_units: number; unit_prefix: string | null; name: string }>(
        `SELECT p.id AS product_id, p.track_units, p.unit_prefix, p.name FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.id = ?`, o.variantId
      )
      if (!v) throw new AppError('NOT_FOUND', 'Product variant not found')
      if (!v.track_units || !v.unit_prefix) throw new AppError('VALIDATION', `${v.name} does not track unit codes`)
      const prefix = v.unit_prefix
      const MAX = maxSeqFor(prefix)
      const loc = o.locationId ?? this.app.defaultLocationId()
      if (o.checkStock !== false) {
        const remaining = Math.max(0, this.stockAt(o.variantId, loc) - this.availableAt(o.variantId, loc))
        if (o.count > remaining)
          throw new AppError('VALIDATION', `Only ${remaining} unit(s) of ${this.variantName(o.variantId)} have stock without a unit code (asked for ${o.count})`, { code: 'UNIT_COUNT_EXCEEDS_STOCK', remaining })
      }
      const seqRow = this.db.value<number>('SELECT last_seq FROM unit_sequences WHERE prefix = ?', prefix) ?? 0
      const maxSeq = this.db.value<number>('SELECT MAX(seq) FROM product_units WHERE prefix = ?', prefix) ?? 0
      const last = Math.max(seqRow, maxSeq)
      if (last + o.count > MAX)
        throw new AppError(
          'CONFLICT',
          `Unit codes for prefix ${prefix} are used up (last code ${formatUnitCode(prefix, Math.min(last, MAX) || 1)}, ${MAX - last} left, ${o.count} needed). Choose a new prefix for ${v.name} to continue.`,
          { code: 'UNIT_LIMIT_REACHED', prefix, lastSeq: last, remaining: MAX - last, requested: o.count }
        )
      const first = last + 1
      const lastSeq = last + o.count
      const clash = this.firstClash(prefix, first, lastSeq)
      if (clash) throw new AppError('CONFLICT', `${clash} is already used as a barcode/SKU; cannot issue it as a unit code`, { code: 'UNIT_CODE_CLASH', unitCode: clash })
      const now = Date.now()
      const codes: string[] = []
      const ids: number[] = []
      for (let seq = first; seq <= lastSeq; seq++) {
        const code = formatUnitCode(prefix, seq)
        const r = this.db.run(
          `INSERT INTO product_units(uuid,variant_id,prefix,seq,code,status,purchase_id,location_id,created_at,updated_at) VALUES (?,?,?,?,?,'in_stock',?,?,?,?)`,
          this.app.uuid(), o.variantId, prefix, seq, code, o.purchaseId ?? null, loc, now, now
        )
        codes.push(code)
        ids.push(r.lastId)
      }
      this.db.run(
        'INSERT INTO unit_sequences(prefix,last_seq) VALUES (?,?) ON CONFLICT(prefix) DO UPDATE SET last_seq = excluded.last_seq',
        prefix, lastSeq
      )
      this.app.audit({
        entity: 'unit', entityId: o.variantId, action: 'generate', note: o.reason,
        new: { prefix, from: codes[0], to: codes[codes.length - 1], count: o.count, purchaseId: o.purchaseId ?? null, locationId: loc }
      })
      this.bump(ids)
      return { codes, prefix, firstSeq: first, lastSeq }
    })
  }

  private firstClash(prefix: string, from: number, to: number): string | undefined {
    // only the spelling this prefix issues can clash with a number about to be issued
    const pat = codePatterns(prefix)[0]
    const rows = [
      ...this.db.all<{ c: string }>('SELECT barcode AS c FROM product_variants WHERE barcode GLOB ?', pat),
      ...this.db.all<{ c: string }>('SELECT barcode AS c FROM variant_barcodes WHERE barcode GLOB ?', pat),
      ...this.db.all<{ c: string }>('SELECT upper(sku) AS c FROM product_variants WHERE upper(sku) GLOB ?', pat)
    ]
    for (const r of rows) {
      const n = parseUnitCode(r.c)?.seq ?? -1
      if (n >= from && n <= to) return r.c
    }
    return undefined
  }

  /** Public generate(): codes for stock that has none yet (backfill / reconciliation). */
  generate(args: unknown): GenerateResult {
    this.app.requirePermission('inventory.adjust')
    const a = parse(z.object({ variantId: id, count: z.number().int().min(1).max(MAX_LABEL_SEQ), purchaseId: id.optional(), reason: text(300).optional(), locationId: id.optional() }), args)
    return this.db.transaction(() => {
      if (a.purchaseId && !this.db.get('SELECT 1 FROM purchases WHERE id = ?', a.purchaseId)) throw new AppError('NOT_FOUND', 'Purchase not found')
      return this.generateTx(a)
    })
  }

  // ------------------------------------------------------------------ tracking on/off
  /**
   * Turn unit tracking on/off for a product (also used by catalog.save). Enabling picks/validates the prefix and gives every
   * piece of existing stock a code (backfill) so stock == in-stock units from the first moment.
   * Disabling with units still in stock needs discardUnits:true (they are voided WITHOUT touching stock).
   */
  setTrackingTx(productId: number, o: { trackUnits: boolean; prefix?: string | null; backfill?: boolean; discardUnits?: boolean; auto?: boolean }): {
    productId: number; trackUnits: boolean; prefix: string | null; backfilled: { variantId: number; locationId: number; codes: string[] }[]
  } {
    return this.db.transaction(() => {
      const p = this.db.get<{ id: number; name: string; track_stock: number; track_units: number; unit_prefix: string | null }>('SELECT id, name, track_stock, track_units, unit_prefix FROM products WHERE id = ?', productId)
      if (!p) throw new AppError('NOT_FOUND', 'Product not found')
      const variants = this.db.all<{ id: number }>('SELECT id FROM product_variants WHERE product_id = ? ORDER BY id', productId)
      const now = Date.now()
      const backfilled: { variantId: number; locationId: number; codes: string[] }[] = []

      if (!o.trackUnits) {
        if (p.track_units) {
          const inStock = this.db.value<number>(
            `SELECT COUNT(*) FROM product_units u JOIN product_variants v ON v.id = u.variant_id WHERE v.product_id = ? AND u.status IN ${AVAIL_SQL}`, productId
          ) ?? 0
          if (inStock && !o.discardUnits)
            throw new AppError('CONFLICT', `${p.name} still has ${inStock} unit code(s) in stock. Sell or void them first, or turn tracking off with discardUnits.`, { code: 'UNITS_IN_STOCK', inStock })
          const ids = this.db.all<{ id: number }>(
            `SELECT u.id FROM product_units u JOIN product_variants v ON v.id = u.variant_id WHERE v.product_id = ? AND u.status IN ${AVAIL_SQL}`, productId
          ).map((r) => r.id)
          for (const uid of ids) this.db.run(`UPDATE product_units SET status='void', void_reason='unit tracking turned off', updated_at=? WHERE id=?`, now, uid)
          this.bump(ids)
          this.db.run('UPDATE products SET track_units = 0, updated_at = ? WHERE id = ?', now, productId)
          this.app.audit({ entity: 'product', entityId: productId, action: 'unit_tracking', old: { trackUnits: true, prefix: p.unit_prefix }, new: { trackUnits: false, discardedUnits: ids.length } })
          enqueueProductSnapshot(this.app, productId)
        }
        return { productId, trackUnits: false, prefix: p.unit_prefix, backfilled }
      }

      if (!p.track_stock) throw new AppError('VALIDATION', `${p.name} does not track stock, so it cannot track unit codes`)
      if (this.db.get('SELECT 1 FROM stock_levels s JOIN product_variants v ON v.id = s.variant_id WHERE v.product_id = ? AND s.qty < 0', productId))
        throw new AppError('VALIDATION', `${p.name} has negative stock. Correct the stock before turning on unit codes.`, { code: 'NEGATIVE_STOCK' })

      let prefix = p.unit_prefix
      let wanted: string | null = null
      if (o.prefix && o.prefix.trim()) {
        const pr = prefixSchema.safeParse(o.prefix)
        if (!pr.success) throw new AppError('VALIDATION', 'Unit prefix must be 2-8 letters/digits (A-Z, 0-9)', { code: 'PREFIX_INVALID' })
        wanted = pr.data
      }
      if (wanted && wanted !== prefix) {
        const usedUp = prefix ? (this.db.value<number>('SELECT last_seq FROM unit_sequences WHERE prefix = ?', prefix) ?? 0) >= maxSeqFor(prefix) : false
        const hasUnits = !!this.db.get('SELECT 1 FROM product_units u JOIN product_variants v ON v.id = u.variant_id WHERE v.product_id = ?', productId)
        if (prefix && hasUnits && !usedUp)
          throw new AppError('CONFLICT', `${p.name} already has unit codes with prefix ${prefix}; the prefix can only change after all ${maxSeqFor(prefix)} codes are used.`, { code: 'PREFIX_LOCKED', prefix })
        this.checkPrefixFree(wanted, productId)
        prefix = wanted
      } else if (!prefix) {
        prefix = this.suggestPrefixFor(p.name, productId)
        this.checkPrefixFree(prefix, productId)
      }

      const prefixChanged = prefix !== p.unit_prefix
      if (prefixChanged || !p.track_units) {
        // `auto` (label printing switched tracking on): pieces without a label of their own keep selling by the shared barcode
        if (o.auto && !p.track_units) this.db.run('UPDATE products SET track_units = 1, unit_auto = 1, unit_prefix = ?, updated_at = ? WHERE id = ?', prefix, now, productId)
        else this.db.run('UPDATE products SET track_units = 1, unit_prefix = ?, updated_at = ? WHERE id = ?', prefix, now, productId)
        this.app.audit({ entity: 'product', entityId: productId, action: 'unit_tracking', old: { trackUnits: !!p.track_units, prefix: p.unit_prefix }, new: { trackUnits: true, prefix, ...(o.auto ? { auto: true } : {}) } })
        enqueueProductSnapshot(this.app, productId)
      }

      // every piece of existing stock must carry a code
      const rows = this.db.all<{ variant_id: number; location_id: number; qty: number }>(
        `SELECT s.variant_id, s.location_id, s.qty FROM stock_levels s JOIN product_variants v ON v.id = s.variant_id WHERE v.product_id = ? AND s.qty > 0 ORDER BY s.variant_id, s.location_id`, productId
      )
      for (const r of rows) {
        const have = this.availableAt(r.variant_id, r.location_id)
        if (have > r.qty)
          throw new AppError('CONFLICT', `${this.variantName(r.variant_id)} has ${have} in-stock unit codes but only ${r.qty} in stock. Void the extra units first.`, { code: 'UNITS_EXCEED_STOCK', variantId: r.variant_id })
        const missing = r.qty - have
        if (missing > 0) {
          if (o.backfill === false) throw new AppError('VALIDATION', `${this.variantName(r.variant_id)} has ${missing} unit(s) in stock without a code (backfill required)`, { code: 'BACKFILL_REQUIRED', variantId: r.variant_id, missing })
          const g = this.generateTx({ variantId: r.variant_id, count: missing, locationId: r.location_id, reason: 'backfill existing stock' })
          backfilled.push({ variantId: r.variant_id, locationId: r.location_id, codes: g.codes })
        }
      }
      // units in a location without stock rows (tracking was off for a while) cannot exist as in-stock
      return { productId, trackUnits: true, prefix, backfilled }
    })
  }

  /** Exposed: catalog.edit. {productId, trackUnits, prefix?, backfill?, discardUnits?} */
  setTracking(args: unknown) {
    this.app.requirePermission('catalog.edit')
    const a = parse(
      z.object({ productId: id, trackUnits: z.boolean(), prefix: z.string().trim().max(8).nullish(), backfill: z.boolean().optional(), discardUnits: z.boolean().optional() }), args
    )
    return this.db.transaction(() => this.setTrackingTx(a.productId, { trackUnits: a.trackUnits, prefix: a.prefix, backfill: a.backfill, discardUnits: a.discardUnits }))
  }

  /** Give coded units to any uncoded stock of a tracked product (new variants with opening stock, etc.). No-op when not tracked. */
  backfillProduct(productId: number): void {
    if (!this.db.value<number>('SELECT track_units FROM products WHERE id = ?', productId)) return
    this.setTrackingTx(productId, { trackUnits: true })
  }

  // ------------------------------------------------------------------ label numbers
  private labelVariant(variantId: number) {
    const v = this.db.get<{ product_id: number; name: string; track_stock: number; track_units: number; unit_prefix: string | null }>(
      `SELECT p.id AS product_id, p.name, p.track_stock, p.track_units, p.unit_prefix FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.id = ?`, variantId
    )
    if (!v) throw new AppError('NOT_FOUND', 'Product variant not found')
    return v
  }

  private lastSeq(prefix: string): number {
    return Math.max(
      this.db.value<number>('SELECT last_seq FROM unit_sequences WHERE prefix = ?', prefix) ?? 0,
      this.db.value<number>('SELECT MAX(seq) FROM product_units WHERE prefix = ?', prefix) ?? 0
    )
  }

  /**
   * What "Print barcode label" will do for a variant, without changing anything: which numbers come next, how many in-stock
   * pieces still have no label of their own, and whether this terminal may issue numbers at all.
   */
  labelPlan(args: unknown): LabelPlan {
    this.requireAny('catalog.view', 'catalog.edit', 'inventory.view', 'inventory.adjust')
    const a = parse(z.object({ variantId: id, count: z.number().int().min(1).max(60).optional(), locationId: id.optional() }), args)
    const v = this.labelVariant(a.variantId)
    const loc = a.locationId ?? this.app.defaultLocationId()
    const stock = this.stockAt(a.variantId, loc)
    const base = { variantId: a.variantId, displayName: this.variantName(a.variantId), stock, canReceive: this.app.can('inventory.adjust') }
    if (!v.track_stock) return { ...base, mode: 'shared', tracked: false, prefix: null, unlabelled: 0, previewCodes: [], blocked: null }
    const want = a.count ?? 1
    const blocked = this.canIssue() ? null : ADMIN_ONLY_MESSAGE
    let prefix = v.unit_prefix
    const previewCodes: string[] = []
    let unlabelled: number
    let last = 0
    if (v.track_units && prefix) {
      const rows = this.db.all<{ code: string }>(
        `SELECT code FROM product_units WHERE variant_id = ? AND location_id = ? AND label_printed_at IS NULL AND status IN ${AVAIL_SQL} ORDER BY seq, id`, a.variantId, loc
      )
      unlabelled = rows.length
      previewCodes.push(...rows.slice(0, want).map((r) => r.code))
      last = this.lastSeq(prefix)
    } else {
      // tracking is switched on by the first print: every piece in stock gets a number then (variant by variant, location by location)
      unlabelled = Math.max(0, stock)
      try {
        prefix = prefix ?? this.nextLabelPrefix()
      } catch {
        prefix = null
      }
      if (prefix) {
        const sum = (where: string, ...p: number[]) =>
          this.db.value<number>(`SELECT COALESCE(SUM(s.qty),0) FROM stock_levels s JOIN product_variants x ON x.id = s.variant_id WHERE x.product_id = ? AND s.qty > 0 ${where}`, v.product_id, ...p) ?? 0
        const before = this.lastSeq(prefix) + sum('AND (s.variant_id < ? OR (s.variant_id = ? AND s.location_id < ?))', a.variantId, a.variantId, loc)
        for (let i = 1; i <= Math.min(want, unlabelled) && before + i <= maxSeqFor(prefix); i++) previewCodes.push(formatUnitCode(prefix, before + i))
        last = this.lastSeq(prefix) + sum('')
      }
    }
    if (prefix) for (let n = last + 1; previewCodes.length < want && n <= maxSeqFor(prefix); n++) previewCodes.push(formatUnitCode(prefix, n))
    return { ...base, mode: 'unique', tracked: !!v.track_units, prefix, unlabelled, previewCodes, blocked }
  }

  /**
   * "Print barcode label": hand out `count` label numbers per variant, each one exactly once, in ONE transaction.
   *  - A stock-tracked product that does not track units yet is switched to unit tracking with an automatic 4-digit prefix;
   *    every piece already in stock gets its number then (still "unlabelled").
   *  - The labels go to the in-stock pieces that never got a label of their own, lowest number first; they are marked printed
   *    BEFORE the printer runs, so a failed or repeated print can never hand the same number out again (use reprintLabels).
   *  - More labels than unlabelled pieces: refused with LABELS_EXCEED_STOCK (nothing changes) unless `receiveExtra` is set;
   *    then the extra pieces are received through the normal stock adjustment (reason "found", needs inventory.adjust), which
   *    issues the next numbers. Stock therefore always equals the number of in-stock units.
   *  - A LAN-sync client is refused (LABELS_ADMIN_ONLY): only the admin system issues numbers.
   */
  issueLabels(args: unknown): { items: IssuedLabels[]; total: number } {
    this.requireAny('catalog.edit', 'inventory.adjust', 'catalog.view')
    const a = parse(
      z.object({
        items: z.array(z.object({ variantId: id, count: z.number().int().min(1).max(2000) })).min(1).max(500),
        locationId: id.optional(), receiveExtra: z.boolean().optional()
      }),
      args
    )
    if (new Set(a.items.map((i) => i.variantId)).size !== a.items.length) throw new AppError('VALIDATION', 'Each product can appear only once in a label job')
    this.assertCanIssue()
    return this.db.transaction(() => {
      const loc = a.locationId ?? this.app.defaultLocationId()
      if (!this.db.get('SELECT 1 FROM locations WHERE id = ? AND active = 1', loc)) throw new AppError('NOT_FOUND', 'Location not found')
      const now = Date.now()
      const out: IssuedLabels[] = []
      const shortfalls: { variantId: number; name: string; requested: number; unlabelled: number; extra: number }[] = []
      for (const it of a.items) {
        let v = this.labelVariant(it.variantId)
        const name = this.variantName(it.variantId)
        if (!v.track_stock) throw new AppError('VALIDATION', `${name} does not track stock, so its labels carry the product barcode`, { code: 'NOT_STOCK_TRACKED', variantId: it.variantId })
        if (!v.track_units) {
          this.setTrackingTx(v.product_id, { trackUnits: true, prefix: v.unit_prefix ?? this.nextLabelPrefix(), auto: true })
          v = this.labelVariant(it.variantId)
        }
        const rows = this.db.all<UnitRow>(
          `SELECT * FROM product_units WHERE variant_id = ? AND location_id = ? AND label_printed_at IS NULL AND status IN ${AVAIL_SQL} ORDER BY seq, id LIMIT ?`,
          it.variantId, loc, it.count
        )
        const extra = it.count - rows.length
        let codes = rows.map((r) => r.code)
        const ids = rows.map((r) => r.id)
        if (extra > 0) {
          shortfalls.push({ variantId: it.variantId, name, requested: it.count, unlabelled: rows.length, extra })
          if (!a.receiveExtra) continue
          // the existing stock-in path: adjustment row + stock movement + audit + sync, and it issues the next numbers
          const adj = this.app.get<{ adjust(args: unknown): { unitCodes: string[] } }>('inventory').adjust({
            variantId: it.variantId, locationId: loc, delta: extra, reason: 'found', note: 'Received while printing barcode labels'
          })
          if (adj.unitCodes.length !== extra) throw new AppError('INTERNAL', 'Receiving the extra pieces did not issue their label numbers')
          codes = [...codes, ...adj.unitCodes]
          for (const c of adj.unitCodes) ids.push(this.rowByCode(c)!.id)
        }
        // updated_at moves strictly forward so the "printed" snapshot always wins over the unit's creation snapshot on other terminals
        for (const uid of ids) this.db.run('UPDATE product_units SET label_printed_at = ?, updated_at = MAX(updated_at + 1, ?) WHERE id = ? AND label_printed_at IS NULL', now, now, uid)
        this.bump(ids)
        this.app.audit({ entity: 'unit', entityId: it.variantId, action: 'labels_issued', new: { from: codes[0], to: codes[codes.length - 1], count: codes.length, received: Math.max(0, extra), locationId: loc } })
        out.push({ variantId: it.variantId, prefix: v.unit_prefix!, codes, received: Math.max(0, extra) })
      }
      if (shortfalls.length && !a.receiveExtra) {
        const f = shortfalls[0]
        throw new AppError(
          'CONFLICT',
          shortfalls.length === 1
            ? `${f.name} has ${f.unlabelled} piece(s) in stock without a label, but ${f.requested} labels were asked for. Print ${f.unlabelled}, or receive ${f.extra} more into stock.`
            : `${shortfalls.length} products have fewer pieces in stock without a label than the labels asked for.`,
          { code: 'LABELS_EXCEED_STOCK', shortfalls, variantId: f.variantId, requested: f.requested, unlabelled: f.unlabelled, extra: f.extra }
        )
      }
      return { items: out, total: out.reduce((n, i) => n + i.codes.length, 0) }
    })
  }

  /**
   * Print labels for numbers that ALREADY exist (a damaged / lost label, or codes issued by receiving). Never creates a number.
   * Units that had no label yet are marked printed, so the shared product barcode stops counting for them. Void units are refused.
   */
  reprintLabels(args: unknown): { codes: string[]; units: { code: string; variantId: number; status: UnitStatus }[] } {
    this.requireAny('catalog.edit', 'inventory.adjust', 'catalog.view', 'printing.view')
    const a = parse(z.object({ codes: z.array(text(64).min(1)).min(1).max(5000) }), args)
    return this.db.transaction(() => {
      const seen = new Set<string>()
      const rows: UnitRow[] = []
      for (const raw of a.codes) {
        const code = normalizeUnitCode(raw)
        if (seen.has(code)) continue
        seen.add(code)
        const u = this.rowByCode(code)
        if (!u) throw new AppError('NOT_FOUND', `Label number ${code} does not exist. A reprint never creates a new number.`, { code: 'UNIT_NOT_FOUND', unitCode: code })
        if (u.status === 'void') throw notAvailable(code, u.status)
        rows.push(u)
      }
      const now = Date.now()
      const fresh = rows.filter((u) => u.label_printed_at == null)
      for (const u of fresh) this.db.run('UPDATE product_units SET label_printed_at = ?, updated_at = MAX(updated_at + 1, ?) WHERE id = ?', now, now, u.id)
      this.bump(fresh.map((u) => u.id))
      this.app.audit({ entity: 'unit', entityId: rows[0].variant_id, action: 'labels_reprinted', new: { codes: rows.map((r) => r.code).slice(0, 200), count: rows.length } })
      return { codes: rows.map((r) => r.code), units: rows.map((r) => ({ code: r.code, variantId: r.variant_id, status: r.status })) }
    })
  }

  // ------------------------------------------------------------------ reads
  /** Resolve a unit code. null when unknown. Needs any of pos.sell / inventory.view / catalog.view. */
  resolve(args: unknown): { unit: { id: number; code: string; status: UnitStatus; variantId: number; saleId: number | null }; variant: SellableVariant } | null {
    this.requireAny('pos.sell', 'inventory.view', 'catalog.view')
    const a = parse(z.object({ code: text(64) }), args)
    const unit = findUnit(this.db, a.code)
    if (!unit) return null
    const variant = this.app.lookup.byId(unit.variantId)
    if (!variant) return null
    return { unit, variant }
  }

  list(args: unknown) {
    this.requireAny('inventory.view', 'catalog.view', 'pos.sell')
    const a = parse(
      z.object({ variantId: id.optional(), productId: id.optional(), status: z.enum(['in_stock', 'sold', 'returned', 'void']).optional(), search: text(64).optional(), locationId: id.optional(), ...page }), args
    )
    const w: string[] = []
    const p: (string | number)[] = []
    if (a.variantId) (w.push('u.variant_id = ?'), p.push(a.variantId))
    if (a.productId) (w.push('v.product_id = ?'), p.push(a.productId))
    if (a.status) (w.push('u.status = ?'), p.push(a.status))
    if (a.locationId) (w.push('u.location_id = ?'), p.push(a.locationId))
    if (a.search?.trim()) (w.push("u.code LIKE ? ESCAPE '\\'"), p.push(likeTerm(a.search.trim().toUpperCase())))
    const from = `FROM product_units u JOIN product_variants v ON v.id = u.variant_id JOIN products pr ON pr.id = v.product_id LEFT JOIN sales s ON s.id = u.sale_id ${w.length ? 'WHERE ' + w.join(' AND ') : ''}`
    const total = this.db.value<number>(`SELECT COUNT(*) ${from}`, ...p) ?? 0
    const rows = this.db.all(
      `SELECT u.id, u.uuid, u.code, u.seq, u.prefix, u.status, u.variant_id AS variantId, u.sale_id AS saleId, u.sale_item_id AS saleItemId,
              u.purchase_id AS purchaseId, u.location_id AS locationId, u.void_reason AS voidReason, u.label_printed_at AS labelPrintedAt, u.created_at AS createdAt, u.updated_at AS updatedAt,
              pr.name || CASE WHEN v.name<>'' THEN ' - '||v.name ELSE '' END AS displayName, s.invoice_no AS invoiceNo
       ${from} ORDER BY u.id DESC LIMIT ? OFFSET ?`,
      ...p, a.limit ?? 100, a.offset ?? 0
    )
    return { rows, total }
  }

  counts(args: unknown): { in_stock: number; sold: number; returned: number; void: number } {
    this.requireAny('inventory.view', 'catalog.view', 'pos.sell')
    const a = parse(z.object({ variantId: id }), args)
    const out = { in_stock: 0, sold: 0, returned: 0, void: 0 }
    for (const r of this.db.all<{ status: keyof typeof out; n: number }>('SELECT status, COUNT(*) AS n FROM product_units WHERE variant_id = ? GROUP BY status', a.variantId)) out[r.status] = r.n
    return out
  }

  // ------------------------------------------------------------------ taking units out of stock
  /**
   * Validate that every code is a distinct, available unit (of `variantId` / at `locationId` when given) and return the rows.
   * Errors name the offending code.
   */
  takeAvailable(codes: string[], o: { variantId?: number; locationId?: number; listName?: string } = {}): UnitRow[] {
    const seen = new Set<string>()
    const rows: UnitRow[] = []
    for (const raw of codes) {
      const code = normalizeUnitCode(raw)
      if (seen.has(code)) throw new AppError('VALIDATION', duplicateMessage(code, o.listName ?? 'this list'), { code: 'UNIT_DUPLICATE', unitCode: code })
      seen.add(code)
      const u = this.rowByCode(code)
      if (!u) throw new AppError('NOT_FOUND', `Unit ${code} not found`, { code: 'UNIT_NOT_FOUND', unitCode: code })
      if (o.variantId != null && u.variant_id !== o.variantId)
        throw new AppError('VALIDATION', `Unit ${code} belongs to ${this.variantName(u.variant_id)}, not ${this.variantName(o.variantId)}`, { code: 'UNIT_WRONG_PRODUCT', unitCode: code })
      if (!isAvailable(u.status)) throw notAvailable(code, u.status)
      if (o.locationId != null && u.location_id !== o.locationId)
        throw new AppError('CONFLICT', `Unit ${code} is not at that location`, { code: 'UNIT_WRONG_LOCATION', unitCode: code, locationId: u.location_id })
      rows.push(u)
    }
    return rows
  }

  /** moveStock for a set of units, grouped by (variant, location). delta sign: -1 per unit leaving, +1 per unit entering. */
  private moveGrouped(rows: { variant_id: number; location_id: number | null }[], sign: 1 | -1, t: StockMoveTemplate, unitCost?: number): void {
    const groups = new Map<string, { variantId: number; loc: number; n: number }>()
    for (const r of rows) {
      const loc = r.location_id ?? this.app.defaultLocationId()
      const k = `${r.variant_id}:${loc}`
      const g = groups.get(k) ?? { variantId: r.variant_id, loc, n: 0 }
      g.n++
      groups.set(k, g)
    }
    for (const g of groups.values())
      this.app.moveStock({ variantId: g.variantId, delta: sign * g.n, type: t.type, locationId: g.loc, refType: t.refType, refId: t.refId, unitCost, note: t.note, allowNegative: t.allowNegative })
  }

  /** Mark available units void (damage/loss/count/supplier return...). With `move`, also reduces stock (grouped per variant+location). */
  voidUnits(codes: string[], o: { reason: string; variantId?: number; locationId?: number; move?: StockMoveTemplate; unitCost?: number }): UnitRow[] {
    return this.db.transaction(() => {
      const rows = this.takeAvailable(codes, { variantId: o.variantId, locationId: o.locationId })
      const now = Date.now()
      for (const u of rows) this.db.run(`UPDATE product_units SET status='void', void_reason=?, updated_at=? WHERE id=?`, o.reason, now, u.id)
      if (o.move) this.moveGrouped(rows, -1, o.move, o.unitCost)
      this.app.audit({ entity: 'unit', entityId: rows[0]?.variant_id, action: 'void', new: { codes: rows.map((r) => r.code), reason: o.reason } })
      this.bump(rows.map((r) => r.id))
      return rows
    })
  }

  /** Exposed: write off units (damage/loss). Reduces stock inside the same transaction. */
  markVoid(args: unknown): { voided: number; codes: string[] } {
    this.app.requirePermission('inventory.adjust')
    const a = parse(z.object({ codes: z.array(text(64).min(1)).min(1).max(5000), reason: text(300).min(3, 'A reason is required') }), args)
    return this.db.transaction(() => {
      const rows = this.voidUnits(a.codes, { reason: a.reason, move: { type: 'adjustment', refType: 'unit_void', note: `Unit write-off: ${a.reason}`, allowNegative: false } })
      return { voided: rows.length, codes: rows.map((r) => r.code) }
    })
  }

  /** Move available units between locations (stock transfer). Stock movements are done by the caller. */
  moveUnits(codes: string[], o: { variantId: number; fromLocationId: number; toLocationId: number }): UnitRow[] {
    return this.db.transaction(() => {
      const rows = this.takeAvailable(codes, { variantId: o.variantId, locationId: o.fromLocationId, listName: 'this transfer' })
      const now = Date.now()
      for (const u of rows) this.db.run('UPDATE product_units SET location_id=?, updated_at=? WHERE id=?', o.toLocationId, now, u.id)
      this.bump(rows.map((r) => r.id))
      return rows
    })
  }

  // ------------------------------------------------------------------ selling
  /**
   * Validate the unit codes of a bill. Tracked variants REQUIRE unitCodes (no duplicates inside the bill, every unit available);
   * non-tracked variants must not carry any. qty may exceed the codes only by pieces that never got a label of their own
   * (shared-barcode stock of a product whose tracking was switched on by label printing). Returns the rows per line index.
   */
  prepareSale(lines: { variantId: number; qty: number; unitCodes?: string[] }[]): Map<number, UnitRow[]> {
    const seen = new Set<string>()
    const out = new Map<number, UnitRow[]>()
    const short: { i: number; missing: number; given: number }[] = []
    // pass 1: every scanned code must be distinct and available
    lines.forEach((l, i) => {
      const raw = l.unitCodes ?? []
      const tracked = this.isTracked(l.variantId)
      if (!tracked) {
        if (raw.length) throw new AppError('VALIDATION', `${this.variantName(l.variantId)} does not track unit codes`, { code: 'UNIT_NOT_TRACKED', variantId: l.variantId })
        return
      }
      const name = this.variantName(l.variantId)
      if (raw.length > l.qty) throw new AppError('VALIDATION', `${name}: quantity ${l.qty} but ${raw.length} unit code(s) scanned`, { code: 'UNIT_QTY_MISMATCH', variantId: l.variantId })
      const rows: UnitRow[] = []
      for (const c of raw) {
        const k = normalizeUnitCode(c)
        if (seen.has(k)) throw new AppError('VALIDATION', duplicateMessage(k, 'this bill'), { code: 'UNIT_DUPLICATE', unitCode: k })
        seen.add(k)
        rows.push(...this.takeAvailable([k], { variantId: l.variantId }))
      }
      out.set(i, rows)
      if (raw.length < l.qty) short.push({ i, missing: l.qty - raw.length, given: raw.length })
    })
    // pass 2: pieces billed by the shared product barcode (no code scanned) take stock that never got a label of its own.
    // Only products whose tracking was switched on by label printing have such stock; for all others the codes are required.
    const taken = new Set<number>([...out.values()].flat().map((u) => u.id))
    for (const sh of short) {
      const l = lines[sh.i]
      const name = this.variantName(l.variantId)
      const fill = this.unlabelledRows(l.variantId, { limit: sh.missing, excludeIds: taken })
      if (fill.length < sh.missing) {
        const left = this.unlabelledRows(l.variantId, { excludeIds: taken }).length
        if (sh.given) throw new AppError('VALIDATION', `${name}: quantity ${l.qty} but ${sh.given} unit code(s) scanned`, { code: 'UNIT_QTY_MISMATCH', variantId: l.variantId, unlabelled: left })
        throw new AppError(
          'VALIDATION',
          left > 0
            ? `${name}: only ${left} piece(s) without a label of their own are left in stock (asked for ${l.qty}). Scan the label of every other piece.`
            : `${name} needs ${l.qty} unit code(s): scan each unit's label`,
          { code: 'UNIT_CODES_REQUIRED', variantId: l.variantId, qty: l.qty, unlabelled: left }
        )
      }
      for (const u of fill) taken.add(u.id)
      out.get(sh.i)!.push(...fill)
    }
    return out
  }

  /** Mark the units sold and take them out of stock (per location) in the caller's transaction. */
  sellUnits(o: { saleId: number; saleItemId: number; units: UnitRow[]; unitCost: number; invoiceNo: string; allowNegative: boolean }): void {
    const now = Date.now()
    for (const u of o.units) {
      const r = this.db.run(
        `UPDATE product_units SET status='sold', sale_id=?, sale_item_id=?, void_reason=NULL, updated_at=? WHERE id=? AND status IN ${AVAIL_SQL}`,
        o.saleId, o.saleItemId, now, u.id
      )
      if (!r.changes) throw notAvailable(u.code, this.rowByCode(u.code)?.status ?? 'void')
    }
    this.moveGrouped(o.units, -1, { type: 'sale', refType: 'sale', refId: o.saleId, note: o.invoiceNo, allowNegative: o.allowNegative }, o.unitCost)
    this.app.audit({ entity: 'unit', entityId: o.units[0]?.variant_id, action: 'sold', new: { codes: o.units.map((u) => u.code), saleId: o.saleId }, note: o.invoiceNo })
    this.bump(o.units.map((u) => u.id))
  }

  /** Voiding a sale: its sold units go back on the shelf (and their stock back) at the location they left. Returns units restored. */
  restoreSaleItem(o: { saleId: number; saleItemId: number; invoiceNo: string; unitCost: number }): number {
    const rows = this.db.all<UnitRow>(`SELECT * FROM product_units WHERE sale_id = ? AND sale_item_id = ? AND status = 'sold' ORDER BY id`, o.saleId, o.saleItemId)
    if (!rows.length) return 0
    const now = Date.now()
    for (const u of rows) this.db.run(`UPDATE product_units SET status='in_stock', updated_at=? WHERE id=?`, now, u.id)
    this.moveGrouped(rows, 1, { type: 'void', refType: 'sale', refId: o.saleId, note: `Void ${o.invoiceNo}`, allowNegative: true }, o.unitCost)
    this.app.audit({ entity: 'unit', entityId: rows[0].variant_id, action: 'restore', new: { codes: rows.map((r) => r.code), saleId: o.saleId } })
    this.bump(rows.map((r) => r.id))
    return rows.length
  }

  /** Does this sale line have units linked to it (i.e. it was sold with unit codes)? */
  saleItemUnitCount(saleItemId: number): number {
    return this.db.value<number>('SELECT COUNT(*) FROM product_units WHERE sale_item_id = ?', saleItemId) ?? 0
  }

  /** Customer return of specific sold units: restock -> back in stock (+stock), otherwise void. Idempotency is the caller's (requestId). */
  returnUnits(o: { saleId: number; saleItemId: number; codes: string[]; qty: number; restock: boolean; unitCost: number; refId: number; note: string }): void {
    if (o.codes.length !== o.qty)
      throw new AppError('VALIDATION', `Return of ${o.qty} unit(s) needs ${o.qty} unit code(s) (got ${o.codes.length})`, { code: 'UNIT_QTY_MISMATCH', saleItemId: o.saleItemId })
    const seen = new Set<string>()
    const rows: UnitRow[] = []
    for (const raw of o.codes) {
      const code = normalizeUnitCode(raw)
      if (seen.has(code)) throw new AppError('VALIDATION', duplicateMessage(code, 'this return'), { code: 'UNIT_DUPLICATE', unitCode: code })
      seen.add(code)
      const u = this.rowByCode(code)
      if (!u) throw new AppError('NOT_FOUND', `Unit ${code} not found`, { code: 'UNIT_NOT_FOUND', unitCode: code })
      if (u.sale_item_id !== o.saleItemId || u.sale_id !== o.saleId)
        throw new AppError('VALIDATION', `Unit ${code} was not sold on this bill line`, { code: 'UNIT_NOT_ON_SALE', unitCode: code })
      if (u.status !== 'sold') throw new AppError('CONFLICT', `Unit ${code} is ${u.status.replace('_', ' ')}, not sold, so it cannot be returned`, { code: 'UNIT_NOT_AVAILABLE', status: u.status, unitCode: code })
      rows.push(u)
    }
    const now = Date.now()
    for (const u of rows) {
      if (o.restock) this.db.run(`UPDATE product_units SET status='in_stock', updated_at=? WHERE id=?`, now, u.id)
      else this.db.run(`UPDATE product_units SET status='void', void_reason='returned, not restocked', updated_at=? WHERE id=?`, now, u.id)
    }
    if (o.restock) this.moveGrouped(rows, 1, { type: 'sale_return', refType: 'sale_return', refId: o.refId, note: o.note, allowNegative: true }, o.unitCost)
    this.app.audit({ entity: 'unit', entityId: rows[0].variant_id, action: o.restock ? 'return_restock' : 'return_void', new: { codes: rows.map((r) => r.code), saleId: o.saleId } })
    this.bump(rows.map((r) => r.id))
  }

  /** Cancelling a purchase: the units it created must all still be on the shelf where they arrived; they become void. */
  voidPurchaseUnits(purchaseId: number, locationId: number, reason: string): number {
    const rows = this.db.all<UnitRow>('SELECT * FROM product_units WHERE purchase_id = ? ORDER BY id', purchaseId)
    for (const u of rows) {
      if (u.status === 'void') continue
      if (!isAvailable(u.status)) throw notAvailable(u.code, u.status, { purchaseId })
      if (u.location_id !== locationId) throw new AppError('CONFLICT', `Unit ${u.code} from this purchase has been moved to another location`, { code: 'UNIT_WRONG_LOCATION', unitCode: u.code })
    }
    const live = rows.filter((u) => u.status !== 'void')
    const now = Date.now()
    for (const u of live) this.db.run(`UPDATE product_units SET status='void', void_reason=?, updated_at=? WHERE id=?`, reason, now, u.id)
    if (live.length) this.app.audit({ entity: 'unit', entityId: live[0].variant_id, action: 'void', new: { codes: live.map((r) => r.code), reason, purchaseId } })
    this.bump(live.map((r) => r.id))
    return live.length
  }

  // ------------------------------------------------------------------ stock counts
  /**
   * Compare scanned unit codes with the expected in-stock units of a count sheet.
   *  scanned: codes scanned; missing: expected in-stock units not scanned (only for tracked variants that were counted);
   *  unexpected: scanned units that are not in stock at the count location (sold/void/elsewhere).
   */
  countReportFor(countId: number): { scanned: string[]; missing: string[]; unexpected: { code: string; status: string; locationId: number | null }[]; locationId: number } {
    const c = this.db.get<{ id: number; location_id: number }>('SELECT id, location_id FROM stock_counts WHERE id = ?', countId)
    if (!c) throw new AppError('NOT_FOUND', 'Stock count not found')
    const scannedRows = this.db.all<{ code: string; variant_id: number }>('SELECT code, variant_id FROM stock_count_units WHERE count_id = ? ORDER BY scanned_at, rowid', countId)
    const scanned = new Set(scannedRows.map((r) => r.code))
    const unexpected: { code: string; status: string; locationId: number | null }[] = []
    for (const s of scannedRows) {
      const u = this.rowByCode(s.code)
      if (!u || !isAvailable(u.status) || u.location_id !== c.location_id) unexpected.push({ code: s.code, status: u?.status ?? 'unknown', locationId: u?.location_id ?? null })
    }
    const expected = this.db.all<{ code: string; variant_id: number }>(
      `SELECT u.code, u.variant_id FROM product_units u
       WHERE u.status IN ${AVAIL_SQL} AND u.location_id = ?
         AND u.variant_id IN (SELECT i.variant_id FROM stock_count_items i JOIN product_variants v ON v.id = i.variant_id JOIN products p ON p.id = v.product_id
                              WHERE i.count_id = ? AND p.track_units = 1 AND i.counted_qty IS NOT NULL)
       ORDER BY u.id`,
      c.location_id, countId
    )
    // pieces without a label of their own cannot be scanned: they were counted by quantity (counted_qty beyond the scanned units)
    const present = new Set<string>()
    for (const variantId of new Set(expected.map((e) => e.variant_id))) {
      const plain = this.countedPlain(countId, variantId, c.location_id)
      if (plain > 0) for (const u of this.unlabelledRows(variantId, { locationId: c.location_id }).filter((x) => !scanned.has(x.code)).slice(0, plain)) present.add(u.code)
    }
    const missing = expected.map((r) => r.code).filter((code) => !scanned.has(code) && !present.has(code))
    return { scanned: [...scanned], missing, unexpected, locationId: c.location_id }
  }

  /** Units of a variant scanned on a count sheet that really are in stock at the count location. */
  countedScanned(countId: number, variantId: number, locationId: number): number {
    return (
      this.db.value<number>(
        `SELECT COUNT(*) FROM stock_count_units s JOIN product_units u ON u.code = s.code WHERE s.count_id=? AND s.variant_id=? AND u.status IN ${AVAIL_SQL} AND u.location_id=?`,
        countId, variantId, locationId
      ) ?? 0
    )
  }

  /** Pieces of a tracked variant counted by quantity (not by scanning a unit label) on a count sheet. */
  countedPlain(countId: number, variantId: number, locationId: number): number {
    const counted = this.db.value<number | null>('SELECT counted_qty FROM stock_count_items WHERE count_id=? AND variant_id=?', countId, variantId) ?? 0
    return Math.max(0, counted - this.countedScanned(countId, variantId, locationId))
  }

  countReport(args: unknown) {
    this.requireAny('inventory.view', 'inventory.adjust')
    const a = parse(z.object({ countId: id }), args)
    return this.countReportFor(a.countId)
  }

  /** Apply a count: missing units are voided with reason 'count' and their stock removed. Returns the codes. */
  applyCount(countId: number, number: string): { missing: string[]; unexpected: string[]; variants: number } {
    const rep = this.countReportFor(countId)
    if (rep.missing.length) {
      this.voidUnits(rep.missing, { reason: 'count', locationId: rep.locationId, move: { type: 'count', refType: 'stock_count', refId: countId, note: `Count ${number}`, allowNegative: false } })
    }
    const variants = new Set(rep.missing.map((c) => this.rowByCode(c)!.variant_id)).size
    return { missing: rep.missing, unexpected: rep.unexpected.map((u) => u.code), variants }
  }
}

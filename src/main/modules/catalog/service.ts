import type { App } from '../../core/app'
import type { ChildSpec } from '../../core/snapshot'
import { AppError } from '@shared/ipc'
import { z } from 'zod'
import { parseUnitCode } from '@shared/scanList'
import {
  BARCODE_NUMBERING_DEFAULT, EAN13_SEQ_WIDTH, checkNumbering, formatInternalBarcode, maxSequenceNumber, parseInternalBarcode,
  validateBarcode, type BarcodeCheck, type BarcodeNumbering, type NumberingCheck
} from './barcode'
import type { UnitsService } from '../units/service'
import {
  IdsInput, ListQueryInput, NamedInput, ProductInput, parse,
  type ListQueryT, type ProductInputT, type VariantInputT
} from './schemas'

export const PRODUCT_CHILDREN: ChildSpec[] = [
  { table: 'product_variants', fk: 'product_id', children: [{ table: 'variant_barcodes', fk: 'variant_id' }] }
]
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024

/**
 * Queue a sync snapshot of a product + variants + alias barcodes. Produces exactly what
 * `app.enqueueSnapshot('products', id, PRODUCT_CHILDREN)` would (a test asserts this) but without the PRAGMA
 * introspection, which dominated bulk-import time.
 */
export function enqueueProductSnapshot(app: App, productId: number, op: 'upsert' | 'delete' = 'upsert'): void {
  const db = app.db
  const p = db.get<Record<string, any>>('SELECT * FROM products WHERE id = ?', productId)
  if (!p) throw new Error(`enqueueProductSnapshot: products#${productId} not found`)
  const uuidOf = (table: string, id: number | null) => (id == null ? null : db.value<string>(`SELECT uuid FROM ${table} WHERE id = ?`, id) ?? null)
  const ref = (table: string, id: number | null) => {
    const uuid = uuidOf(table, id)
    return uuid ? { table, uuid } : null
  }
  const variants = db.all<Record<string, any>>('SELECT * FROM product_variants WHERE product_id = ? ORDER BY id', productId)
  const aliases = db.all<Record<string, any>>(
    'SELECT vb.* FROM variant_barcodes vb JOIN product_variants v ON v.id = vb.variant_id WHERE v.product_id = ? ORDER BY vb.rowid', productId
  )
  const productRef = { table: 'products', uuid: p.uuid as string }
  const snap = {
    table: 'products', uuid: p.uuid as string, row: p,
    refs: { category_id: ref('categories', p.category_id), brand_id: ref('brands', p.brand_id), image_id: null },
    children: {
      product_variants: variants.map((v) => ({
        table: 'product_variants', uuid: v.uuid as string, row: v, refs: { product_id: productRef },
        children: {
          variant_barcodes: aliases.filter((a) => a.variant_id === v.id).map((a) => ({
            table: 'variant_barcodes', uuid: '', row: a, refs: { variant_id: { table: 'product_variants', uuid: v.uuid as string } }
          }))
        }
      }))
    }
  }
  app.enqueueSync('products', snap.uuid, op, snap)
}

type P = string | number | null

export interface VariantRow {
  id: number
  uuid: string
  productId: number
  name: string
  sku: string
  barcode: string | null
  aliases: string[]
  mrp: number
  price: number
  cost: number
  reorderLevel: number
  active: boolean
  stock: number
}
export interface ProductDetail {
  id: number
  uuid: string
  name: string
  description: string
  categoryId: number | null
  category: string | null
  brandId: number | null
  brand: string | null
  hsn: string
  taxRateBp: number
  unit: string
  trackStock: boolean
  trackUnits: boolean
  unitPrefix: string | null
  active: boolean
  imageId: number | null
  imageDataUri: string | null
  createdAt: number
  updatedAt: number
  variants: VariantRow[]
}
export interface ProductListRow {
  id: number
  uuid: string
  name: string
  active: boolean
  categoryId: number | null
  category: string | null
  brandId: number | null
  brand: string | null
  hsn: string
  taxRateBp: number
  unit: string
  trackStock: boolean
  trackUnits: boolean
  unitPrefix: string | null
  hasImage: boolean
  variantCount: number
  sku: string
  barcode: string | null
  mrp: number
  price: number
  cost: number
  minPrice: number
  maxPrice: number
  stock: number
  lowStock: boolean
  updatedAt: number
}

const like = (s: string) => `%${s.replace(/[\\%_]/g, (c) => '\\' + c)}%`
const bool = (v: unknown) => !!v

export class CatalogService {
  constructor(private app: App) {}
  private get db() {
    return this.app.db
  }

  // ======================================================================== reads
  list(raw: unknown = {}): { rows: ProductListRow[]; total: number } {
    this.app.requirePermission('catalog.view')
    const q = parse(ListQueryInput, raw)
    const { where, params } = this.buildWhere(q)
    const order = { name: 'p.name COLLATE NOCASE', updated: 'p.updated_at', created: 'p.created_at', id: 'p.id' }[q.sort]
    const prods = this.db.all<Record<string, any>>(
      `SELECT p.*, c.name AS category_name, b.name AS brand_name FROM products p
       LEFT JOIN categories c ON c.id = p.category_id LEFT JOIN brands b ON b.id = p.brand_id
       WHERE ${where} ORDER BY ${order} ${q.dir === 'desc' ? 'DESC' : 'ASC'}, p.id LIMIT ? OFFSET ?`,
      ...params, q.limit, q.offset
    )
    // first page that is not full: the page is the whole result, so the (search-heavy) COUNT is skipped
    const total = q.offset === 0 && prods.length < q.limit
      ? prods.length
      : this.db.value<number>(`SELECT COUNT(*) FROM products p WHERE ${where}`, ...params) ?? 0
    const variants = this.variantsFor(prods.map((r) => r.id))
    const rows = prods.map((p) => {
      const vs = variants.get(p.id) ?? []
      const first = vs[0]
      const prices = vs.map((v) => v.price)
      return {
        id: p.id, uuid: p.uuid, name: p.name, active: bool(p.active),
        categoryId: p.category_id, category: p.category_name, brandId: p.brand_id, brand: p.brand_name,
        hsn: p.hsn, taxRateBp: p.tax_rate_bp, unit: p.unit, trackStock: bool(p.track_stock), trackUnits: bool(p.track_units), unitPrefix: p.unit_prefix ?? null, hasImage: p.image_id != null,
        variantCount: vs.length, sku: first?.sku ?? '', barcode: first?.barcode ?? null,
        mrp: first?.mrp ?? 0, price: first?.price ?? 0, cost: first?.cost ?? 0,
        minPrice: prices.length ? Math.min(...prices) : 0, maxPrice: prices.length ? Math.max(...prices) : 0,
        stock: vs.reduce((s, v) => s + v.stock, 0),
        lowStock: bool(p.track_stock) && vs.some((v) => v.reorderLevel > 0 && v.stock <= v.reorderLevel),
        updatedAt: p.updated_at
      } satisfies ProductListRow
    })
    return { rows, total }
  }

  private buildWhere(q: ListQueryT): { where: string; params: P[] } {
    const w: string[] = ['1=1']
    const params: P[] = []
    if (q.search) {
      const s = like(q.search)
      w.push(`(p.name LIKE ? ESCAPE '\\' OR p.id IN (
        SELECT product_id FROM product_variants WHERE sku LIKE ? ESCAPE '\\' OR barcode LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\'
        UNION SELECT v.product_id FROM variant_barcodes vb JOIN product_variants v ON v.id = vb.variant_id WHERE vb.barcode LIKE ? ESCAPE '\\'))`)
      params.push(s, s, s, s, s)
    }
    if (q.categoryId) {
      w.push(`p.category_id IN (WITH RECURSIVE t(id) AS (SELECT ? UNION ALL SELECT c.id FROM categories c JOIN t ON c.parent_id = t.id) SELECT id FROM t)`)
      params.push(q.categoryId)
    }
    if (q.brandId) (w.push('p.brand_id = ?'), params.push(q.brandId))
    if (q.active !== undefined) (w.push('p.active = ?'), params.push(q.active ? 1 : 0))
    if (q.noBarcode) w.push(`EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = p.id AND (v.barcode IS NULL OR v.barcode = ''))`)
    if (q.lowStock)
      w.push(`p.track_stock = 1 AND EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = p.id AND v.reorder_level > 0
        AND COALESCE((SELECT SUM(qty) FROM stock_levels s WHERE s.variant_id = v.id), 0) <= v.reorder_level)`)
    return { where: w.join(' AND '), params }
  }

  private variantsFor(productIds: number[]): Map<number, VariantRow[]> {
    const out = new Map<number, VariantRow[]>()
    if (!productIds.length) return out
    const ph = productIds.map(() => '?').join(',')
    const rows = this.db.all<Record<string, any>>(
      `SELECT v.*, COALESCE((SELECT SUM(qty) FROM stock_levels s WHERE s.variant_id = v.id), 0) AS stock
       FROM product_variants v WHERE v.product_id IN (${ph}) ORDER BY v.id`,
      ...productIds
    )
    const aliasRows = this.db.all<{ variant_id: number; barcode: string }>(
      `SELECT vb.variant_id, vb.barcode FROM variant_barcodes vb JOIN product_variants v ON v.id = vb.variant_id
       WHERE v.product_id IN (${ph}) ORDER BY vb.rowid`,
      ...productIds
    )
    const aliases = new Map<number, string[]>()
    for (const a of aliasRows) (aliases.get(a.variant_id) ?? aliases.set(a.variant_id, []).get(a.variant_id)!).push(a.barcode)
    for (const r of rows) {
      const v: VariantRow = {
        id: r.id, uuid: r.uuid, productId: r.product_id, name: r.name, sku: r.sku, barcode: r.barcode,
        aliases: aliases.get(r.id) ?? [], mrp: r.mrp, price: r.price, cost: r.cost, reorderLevel: r.reorder_level,
        active: bool(r.active), stock: r.stock
      }
      ;(out.get(r.product_id) ?? out.set(r.product_id, []).get(r.product_id)!).push(v)
    }
    return out
  }

  get(raw: unknown): ProductDetail {
    this.app.requirePermission('catalog.view')
    const id = (raw as { id?: number })?.id
    if (!id) throw new AppError('VALIDATION', 'Product id is required')
    return this.getDetail(id)
  }

  private getDetail(id: number): ProductDetail {
    const p = this.db.get<Record<string, any>>(
      `SELECT p.*, c.name AS category_name, b.name AS brand_name FROM products p
       LEFT JOIN categories c ON c.id = p.category_id LEFT JOIN brands b ON b.id = p.brand_id WHERE p.id = ?`,
      id
    )
    if (!p) throw new AppError('NOT_FOUND', 'Product not found')
    return {
      id: p.id, uuid: p.uuid, name: p.name, description: p.description, categoryId: p.category_id, category: p.category_name,
      brandId: p.brand_id, brand: p.brand_name, hsn: p.hsn, taxRateBp: p.tax_rate_bp, unit: p.unit,
      trackStock: bool(p.track_stock), trackUnits: bool(p.track_units), unitPrefix: p.unit_prefix ?? null, active: bool(p.active), imageId: p.image_id, imageDataUri: this.imageDataUri(p.image_id),
      createdAt: p.created_at, updatedAt: p.updated_at, variants: this.variantsFor([id]).get(id) ?? []
    }
  }

  /** Resolve a scanned code (barcode / alias / SKU) to its product id + variant id, or null. */
  findByCode(raw: unknown): { productId: number; variantId: number } | null {
    this.app.requirePermission('catalog.view')
    const code = String((raw as { code?: string })?.code ?? '')
    const v = this.app.lookup.byScan(code)
    return v ? { productId: v.productId, variantId: v.variantId } : null
  }

  // ======================================================================== images
  imageDataUri(imageId: number | null): string | null {
    if (imageId == null) return null
    const r = this.db.get<{ mime: string; bytes: Uint8Array }>('SELECT mime, bytes FROM product_images WHERE id = ?', imageId)
    return r ? `data:${r.mime};base64,${Buffer.from(r.bytes).toString('base64')}` : null
  }
  getImage(raw: unknown): { dataUri: string | null } {
    this.app.requirePermission('catalog.view')
    return { dataUri: this.imageDataUri((raw as { id?: number })?.id ?? null) }
  }

  private storeImage(img: { mime: string; base64: string }): number {
    const bytes = Buffer.from(img.base64, 'base64')
    if (!bytes.length) throw new AppError('VALIDATION', 'Image is empty')
    if (bytes.length > MAX_IMAGE_BYTES) throw new AppError('VALIDATION', `Image is too large (max ${MAX_IMAGE_BYTES / 1024 / 1024} MB)`)
    return this.db.run('INSERT INTO product_images(mime, bytes) VALUES (?,?)', img.mime, bytes).lastId
  }
  private dropImageIfOrphan(imageId: number | null | undefined): void {
    if (imageId == null) return
    if (!this.db.value('SELECT 1 FROM products WHERE image_id = ?', imageId))
      this.db.run('DELETE FROM product_images WHERE id = ?', imageId)
  }

  // ======================================================================== barcodes / SKU
  checkBarcode(code: string): BarcodeCheck {
    const r = validateBarcode(code)
    if (!r.valid && r.format && r.format !== 'CODE128' && this.app.setting('catalog.barcode_strict', '1') !== '1')
      return { valid: true, code: r.code, format: 'CODE128' } // lenient mode: accept non-standard numeric codes
    return r
  }

  validateBarcodeFor(raw: unknown): BarcodeCheck & { owner?: string } {
    this.app.requirePermission('catalog.view')
    const { code, variantId } = (raw ?? {}) as { code?: string; variantId?: number }
    const r = this.checkBarcode(String(code ?? ''))
    if (!r.valid) return r
    const owner = this.barcodeOwner(r.code, variantId)
    if (owner) return { ...r, valid: false, error: owner.via === 'sku' ? `Barcode ${r.code} is already the SKU of ${owner.name}` : `Barcode ${r.code} is already used by ${owner.name}`, owner: owner.name }
    const clash = this.unitNamespaceClash(r.code)
    return clash ? { ...r, valid: false, error: clash } : r
  }

  /**
   * Who already answers to `code`: a primary barcode, an alias barcode, or (last) another item's SKU. A scan resolves barcode ->
   * alias -> SKU, so a barcode equal to somebody else's SKU would hide that item from the SKU lookup; `via` tells which it is.
   */
  barcodeOwner(code: string, exceptVariantId?: number): { variantId: number; name: string; via: 'barcode' | 'alias' | 'sku' } | undefined {
    const name = `p.name || CASE WHEN v.name <> '' THEN ' - ' || v.name ELSE '' END`
    const ex = exceptVariantId ?? 0
    type Row = { variantId: number; name: string }
    const hit = (r: Row | undefined, via: 'barcode' | 'alias' | 'sku') => (r ? { ...r, via } : undefined)
    return (
      hit(this.db.get<Row>(
        `SELECT v.id AS variantId, ${name} AS name FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.barcode = ? AND v.id <> ?`,
        code, ex
      ), 'barcode') ??
      hit(this.db.get<Row>(
        `SELECT v.id AS variantId, ${name} AS name FROM variant_barcodes vb JOIN product_variants v ON v.id = vb.variant_id
         JOIN products p ON p.id = v.product_id WHERE vb.barcode = ? AND v.id <> ?`,
        code, ex
      ), 'alias') ??
      hit(this.db.get<Row>(
        `SELECT v.id AS variantId, ${name} AS name FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.sku = ? COLLATE NOCASE AND v.id <> ?`,
        code, ex
      ), 'sku')
    )
  }

  /** "Barcode X is already used by NAME" (says so when NAME uses it as its SKU). */
  private ownerText(code: string, o: { name: string; via: 'barcode' | 'alias' | 'sku' }): string {
    return o.via === 'sku' ? `Barcode ${code} is already the SKU of "${o.name}"` : `Barcode ${code} is already used by "${o.name}"`
  }

  skuOwner(sku: string, exceptVariantId?: number): { variantId: number; name: string } | undefined {
    return this.db.get<{ variantId: number; name: string }>(
      `SELECT v.id AS variantId, p.name || CASE WHEN v.name <> '' THEN ' - ' || v.name ELSE '' END AS name
       FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.sku = ? COLLATE NOCASE AND v.id <> ?`,
      sku, exceptVariantId ?? 0
    )
  }

  /** Another item whose barcode / alias barcode is this SKU (the barcode would win every lookup of the SKU). */
  skuShadowedBy(sku: string, exceptVariantId?: number): { variantId: number; name: string } | undefined {
    for (const c of new Set([sku, sku.toUpperCase(), sku.toLowerCase()])) {
      const o = this.barcodeOwner(c, exceptVariantId)
      if (o && o.via !== 'sku') return o
    }
    return undefined
  }

  private assertSkuFree(sku: string, exceptVariantId?: number): void {
    const o = this.skuOwner(sku, exceptVariantId)
    if (o) throw new AppError('CONFLICT', `SKU ${sku} is already used by "${o.name}"`, { sku, variantId: o.variantId })
    const b = this.skuShadowedBy(sku, exceptVariantId)
    if (b) throw new AppError('CONFLICT', `SKU ${sku} is already the barcode of "${b.name}"`, { sku, variantId: b.variantId, code: 'SKU_IS_BARCODE' })
    const clash = this.unitNamespaceClash(sku, 'SKU')
    if (clash) throw new AppError('CONFLICT', clash, { code: 'UNIT_NAMESPACE', sku })
  }

  /**
   * A barcode / alias / SKU shaped like a unit code (PREFIX-NNNN) of a product that tracks units would later stop that product's
   * numbering at NNNN (UNIT_CODE_CLASH) and makes a scan ambiguous. Returns the message when the prefix belongs to a product.
   */
  unitNamespaceClash(code: string, what: 'Barcode' | 'SKU' = 'Barcode'): string | undefined {
    const u = parseUnitCode(code)
    if (!u) return undefined
    const owner =
      this.db.value<string>('SELECT name FROM products WHERE unit_prefix = ? COLLATE NOCASE', u.prefix) ??
      (this.db.value('SELECT 1 FROM unit_sequences WHERE prefix = ?', u.prefix) ? 'another product' : undefined)
    return owner
      ? `${what} ${code} looks like a unit code of ${owner} (prefix ${u.prefix}). Unit codes are reserved for single pieces; use a different ${what.toLowerCase()}.`
      : undefined
  }

  nextSku(): string {
    const prefix = this.app.setting('catalog.sku_prefix', 'SKU').trim() || 'SKU'
    let n = Number(this.app.setting('catalog.sku_seq', '0')) || 0
    for (;;) {
      n++
      const sku = `${prefix}-${String(n).padStart(6, '0')}`
      if (!this.skuOwner(sku) && !this.skuShadowedBy(sku)) {
        this.app.setSetting('catalog.sku_seq', String(n))
        return sku
      }
    }
  }

  // ---------------------------------------------------------------- internal barcode numbering (see barcode.ts)
  private storedNumbering(): NumberingCheck {
    const d = BARCODE_NUMBERING_DEFAULT
    return checkNumbering({
      mode: this.app.setting('catalog.barcode_mode', d.mode),
      prefix: this.app.setting('catalog.barcode_prefix', d.prefix),
      width: this.app.setting('catalog.barcode_width', String(d.width))
    })
  }

  /** The stored numbering settings, validated. A broken combination (edited outside saveSettings) fails with a clear message. */
  barcodeNumbering(): BarcodeNumbering {
    const r = this.storedNumbering()
    if (!r.ok) throw new AppError('VALIDATION', `Barcode numbering is not set up correctly: ${r.error} Fix it under Products > Barcode numbering.`, { code: 'BARCODE_SETTINGS_INVALID', field: r.field })
    return r.cfg
  }

  /**
   * Highest running number already on a product for this prefix/width (sequence mode), so numbering continues after codes that
   * arrived by import / package / sync or were typed by hand, and never goes backwards. Codes of a fixed length sort like their
   * numbers, so this is one index seek per table. EAN-13 mode keeps to its counter (the 200-299 range also holds other shops'
   * in-store codes, which must not push the counter to the end).
   */
  private highestIssued(cfg: BarcodeNumbering): number {
    if (cfg.mode !== 'sequence') return 0
    const lo = cfg.prefix + '0'.repeat(cfg.width)
    const hi = cfg.prefix + '9'.repeat(cfg.width)
    const pat = cfg.prefix + '[0-9]'.repeat(cfg.width)
    let max = 0
    for (const table of ['product_variants', 'variant_barcodes']) {
      const top = this.db.value<string>(
        `SELECT barcode FROM ${table} WHERE barcode >= ? AND barcode <= ? AND length(barcode) = ? AND barcode GLOB ? ORDER BY barcode DESC LIMIT 1`,
        lo, hi, lo.length, pat
      )
      if (top) max = Math.max(max, Number(top.slice(cfg.prefix.length)))
    }
    return max
  }

  /**
   * The next free number after the counter: skips numbers already used as a barcode, alias or SKU (and `exclude`: codes handed
   * out to the form but not saved yet). Does NOT consume it. Fails instead of growing past the suffix width.
   * `after` = continue a batch after the number this call returned last (skips re-reading the counter and the highest code).
   */
  private findNextBarcode(cfg: BarcodeNumbering, exclude?: Set<string>, after?: number): { n: number; code: string } {
    let n = after ?? Math.max(0, Number(this.app.setting('catalog.barcode_seq', '0')) || 0, this.highestIssued(cfg))
    for (;;) {
      n++
      const code = formatInternalBarcode(cfg, n)
      if (code == null) {
        const last = formatInternalBarcode(cfg, maxSequenceNumber(cfg))
        throw new AppError(
          'CONFLICT',
          cfg.mode === 'sequence'
            ? `Barcode numbers for prefix ${cfg.prefix} are used up (the last one is ${last}). Choose more digits or a new prefix under Products > Barcode numbering; barcodes already on products stay as they are.`
            : `Internal EAN-13 numbers for prefix ${cfg.prefix} are used up (the last one is ${last}). Choose another prefix (200-299) under Products > Barcode numbering.`,
          { code: 'BARCODE_SEQ_EXHAUSTED', prefix: cfg.prefix, width: cfg.mode === 'sequence' ? cfg.width : EAN13_SEQ_WIDTH, last }
        )
      }
      if (exclude?.has(code)) continue
      if (!this.barcodeOwner(code)) return { n, code }
    }
  }

  /**
   * Next unused internal barcode: `<prefix><running number>` (default) or an internal EAN-13, see barcode.ts. CONSUMES the number,
   * so call it only inside the transaction that stores the code on a variant (a rollback gives the number back: no gaps).
   */
  nextBarcode(): string {
    const { n, code } = this.findNextBarcode(this.barcodeNumbering())
    this.app.setSetting('catalog.barcode_seq', String(n))
    return code
  }

  /** The barcode nextBarcode() would hand out, without consuming it. */
  peekBarcode(exclude: string[] = []): string {
    return this.findNextBarcode(this.barcodeNumbering(), exclude.length ? new Set(exclude.map((c) => c.trim().toUpperCase())) : undefined).code
  }

  /**
   * A barcode that was typed / previewed (not issued by nextBarcode) is being stored. When it is exactly the number the generator
   * would issue next (the product form's "Generate" preview), consume that number now, so it is never issued again even if this
   * product is deleted later. Call BEFORE the row is written.
   */
  claimBarcode(code: string): void {
    const r = this.storedNumbering()
    if (!r.ok || parseInternalBarcode(r.cfg, code) == null) return
    try {
      const next = this.findNextBarcode(r.cfg)
      if (next.code === code) this.app.setSetting('catalog.barcode_seq', String(next.n))
    } catch {
      /* numbering used up: nothing to claim */
    }
  }

  /**
   * "Generate" for a variant that is not saved yet: shows the next barcode WITHOUT consuming it, so clicking again (or closing
   * the form) burns no number. The number is consumed when the product is saved with it (claimBarcode); uniqueness is enforced at
   * save, so two products can never end up with the same code. `exclude` = codes already shown on other unsaved variants.
   */
  generateBarcode(raw: unknown = {}): { barcode: string } {
    this.app.requirePermission('catalog.edit')
    const { exclude } = parse(z.object({ exclude: z.array(z.string().max(64)).max(500).optional() }), raw)
    return { barcode: this.peekBarcode(exclude ?? []) }
  }

  /**
   * Generate a fresh, unique barcode and SAVE it on one variant. A variant that already has a barcode is never changed
   * silently: without `replace: true` this throws CONFLICT (details.code = 'BARCODE_EXISTS') because printed labels use it.
   * When replaced, the old code is kept as an alias so labels already printed keep scanning.
   */
  assignBarcode(a: { variantId: number; replace?: boolean }): { barcode: string; variantId: number; productId: number; replaced: boolean; previous: string | null } {
    this.app.requirePermission('catalog.edit')
    return this.db.transaction(() => {
      const v = this.db.get<{ id: number; product_id: number; barcode: string | null }>('SELECT id, product_id, barcode FROM product_variants WHERE id = ?', a.variantId)
      if (!v) throw new AppError('NOT_FOUND', 'Product variant not found')
      const previous = v.barcode && v.barcode.trim() ? v.barcode : null
      if (previous && a.replace !== true)
        throw new AppError('CONFLICT', `This item already has barcode ${previous}. Replacing it makes labels already printed with the old number obsolete.`, { code: 'BARCODE_EXISTS', barcode: previous })
      const code = this.nextBarcode()
      const now = Date.now()
      this.db.run('UPDATE product_variants SET barcode = ?, updated_at = ? WHERE id = ?', code, now, v.id)
      if (previous && !this.db.value('SELECT 1 FROM variant_barcodes WHERE barcode = ?', previous)) this.db.run('INSERT INTO variant_barcodes(barcode, variant_id) VALUES (?,?)', previous, v.id)
      this.db.run('UPDATE products SET updated_at = ? WHERE id = ?', now, v.product_id)
      this.app.audit({ entity: 'variant', entityId: v.id, action: previous ? 'barcode_replaced' : 'barcode_generated', old: previous ? { barcode: previous } : undefined, new: { barcode: code } })
      enqueueProductSnapshot(this.app, v.product_id)
      return { barcode: code, variantId: v.id, productId: v.product_id, replaced: !!previous, previous }
    })
  }

  /** Assign a fresh barcode to every active variant (of an active product) without one. Returns how many were assigned. */
  generateMissingBarcodes(raw: unknown = {}): { assigned: number; remaining: number } {
    this.app.requirePermission('catalog.edit')
    const limit = Math.max(1, Math.min(Number((raw as { limit?: number })?.limit ?? 5000) || 5000, 20000))
    const missing = `FROM product_variants v JOIN products p ON p.id = v.product_id WHERE (v.barcode IS NULL OR v.barcode = '') AND v.active = 1 AND p.active = 1`
    return this.db.transaction(() => {
      const rows = this.db.all<{ id: number; product_id: number }>(`SELECT v.id, v.product_id ${missing} ORDER BY v.id LIMIT ?`, limit)
      const touched = new Set<number>()
      const now = Date.now()
      const cfg = rows.length ? this.barcodeNumbering() : undefined
      let last: number | undefined
      for (const r of rows) {
        const { n, code } = this.findNextBarcode(cfg!, undefined, last)
        last = n
        this.db.run('UPDATE product_variants SET barcode = ?, updated_at = ? WHERE id = ?', code, now, r.id)
        this.db.run('UPDATE products SET updated_at = ? WHERE id = ?', now, r.product_id)
        touched.add(r.product_id)
        this.app.audit({ entity: 'variant', entityId: r.id, action: 'barcode_generated', new: { barcode: code } })
      }
      if (last !== undefined) this.app.setSetting('catalog.barcode_seq', String(last))
      for (const pid of touched) enqueueProductSnapshot(this.app, pid)
      // same filter as the selection above, so "remaining" reaches 0 once everything that can get a barcode has one
      const remaining = this.db.value<number>(`SELECT COUNT(*) ${missing}`) ?? 0
      return { assigned: rows.length, remaining }
    })
  }

  /**
   * What a numbering configuration produces: validation message, an example and the real next barcode. Used by the numbering
   * dialog for its live preview (nothing is saved). Missing fields fall back to the stored values.
   */
  previewBarcodeNumbering(raw: unknown = {}): {
    valid: boolean; error?: string; field?: string; mode: string; prefix: string; width: number
    /** first / second code of the series (VM000001, VM000002), the one that would be issued next and the last possible one */
    example: string; exampleNext: string; next: string; last: string; remaining: number
  } {
    this.app.requirePermission('catalog.view')
    const a = parse(z.object({ mode: z.string().max(20).optional(), prefix: z.string().max(40).optional(), width: z.union([z.number(), z.string().max(10)]).optional() }), raw)
    const d = BARCODE_NUMBERING_DEFAULT
    const mode = a.mode ?? this.app.setting('catalog.barcode_mode', d.mode)
    const prefix = a.prefix ?? this.app.setting('catalog.barcode_prefix', d.prefix)
    const width = a.width ?? this.app.setting('catalog.barcode_width', String(d.width))
    const r = checkNumbering({ mode, prefix, width })
    if (!r.ok)
      return { valid: false, error: r.error, field: r.field, mode: String(mode), prefix: String(prefix).trim().toUpperCase(), width: Number(width) || d.width, example: '', exampleNext: '', next: '', last: '', remaining: 0 }
    const cfg = r.cfg
    const max = maxSequenceNumber(cfg)
    const base = { mode: cfg.mode, prefix: cfg.prefix, width: cfg.width, example: formatInternalBarcode(cfg, 1) ?? '', exampleNext: formatInternalBarcode(cfg, 2) ?? '', last: formatInternalBarcode(cfg, max) ?? '' }
    try {
      const next = this.findNextBarcode(cfg)
      return { valid: true, ...base, next: next.code, remaining: max - next.n + 1 }
    } catch (e) {
      return { valid: false, error: e instanceof AppError ? e.message : String(e), field: 'width', ...base, next: '', remaining: 0 }
    }
  }

  getSettings(): Record<string, string> {
    this.app.requirePermission('catalog.view')
    const d = BARCODE_NUMBERING_DEFAULT
    let nextBarcode = ''
    let barcodeError = ''
    try {
      nextBarcode = this.peekBarcode()
    } catch (e) {
      barcodeError = e instanceof Error ? e.message : String(e)
    }
    return {
      skuPrefix: this.app.setting('catalog.sku_prefix', 'SKU'),
      barcodeMode: this.app.setting('catalog.barcode_mode', d.mode),
      barcodePrefix: this.app.setting('catalog.barcode_prefix', d.prefix),
      barcodeWidth: this.app.setting('catalog.barcode_width', String(d.width)),
      barcodeSeq: this.app.setting('catalog.barcode_seq', '0'),
      nextBarcode,
      barcodeError,
      strictBarcodes: this.app.setting('catalog.barcode_strict', '1'),
      defaultTaxBp: this.app.setting('catalog.default_tax_bp', '1800')
    }
  }
  saveSettings(raw: unknown): Record<string, string> {
    this.app.requirePermission('catalog.edit')
    const s = (raw ?? {}) as Record<string, unknown>
    return this.db.transaction(() => {
      if (s.skuPrefix !== undefined) {
        const v = String(s.skuPrefix).trim()
        if (!/^[A-Za-z0-9_-]{1,12}$/.test(v)) throw new AppError('VALIDATION', 'SKU prefix must be 1-12 letters/digits')
        this.app.setSetting('catalog.sku_prefix', v)
      }
      // numbering: mode + prefix + width are checked TOGETHER (what is not sent keeps its stored value). Changing them only affects
      // barcodes generated from now on; codes already on products are never touched and the running number simply continues.
      if (s.barcodeMode !== undefined || s.barcodePrefix !== undefined || s.barcodeWidth !== undefined) {
        const d = BARCODE_NUMBERING_DEFAULT
        const r = checkNumbering({
          mode: s.barcodeMode ?? this.app.setting('catalog.barcode_mode', d.mode),
          prefix: s.barcodePrefix ?? this.app.setting('catalog.barcode_prefix', d.prefix),
          width: s.barcodeWidth ?? this.app.setting('catalog.barcode_width', String(d.width))
        })
        if (!r.ok) throw new AppError('VALIDATION', r.error, { code: 'BARCODE_SETTINGS_INVALID', field: r.field })
        this.app.setSetting('catalog.barcode_mode', r.cfg.mode)
        this.app.setSetting('catalog.barcode_prefix', r.cfg.prefix)
        this.app.setSetting('catalog.barcode_width', String(r.cfg.width))
      }
      if (s.strictBarcodes !== undefined) this.app.setSetting('catalog.barcode_strict', s.strictBarcodes ? '1' : '0')
      if (s.defaultTaxBp !== undefined) {
        const v = Number(s.defaultTaxBp)
        if (!Number.isInteger(v) || v < 0 || v > 10000) throw new AppError('VALIDATION', 'Default GST must be 0-100%')
        this.app.setSetting('catalog.default_tax_bp', String(v))
      }
      this.app.audit({ entity: 'catalog_settings', action: 'update', new: s })
      return this.getSettings()
    })
  }

  // ======================================================================== product write
  /** Create or update a product with its variants. Permission: catalog.edit. */
  save(raw: unknown): ProductDetail {
    this.app.requirePermission('catalog.edit')
    const input = parse(ProductInput, raw)
    const id = this.db.transaction(() => this.saveTx(input).productId)
    return this.getDetail(id)
  }

  /**
   * Transactional core of save(); NO permission check (callers - save, import, package - check). Must run inside a
   * transaction (it opens one itself, nested-safe).
   */
  saveTx(input: ProductInputT, opts: { note?: string; deferSync?: Set<number>; quietCreate?: boolean } = {}): { productId: number; variantIds: number[]; created: boolean } {
    return this.db.transaction(() => {
      this.checkRefs(input)
      this.checkVariantNames(input)
      const now = Date.now()
      let productId = input.id
      const created = !productId
      let oldImage: number | null = null
      const variantIds: number[] = []

      if (!productId) {
        const imageId = input.image ? this.storeImage(input.image) : null
        productId = this.db.run(
          `INSERT INTO products(uuid,name,description,category_id,brand_id,hsn,tax_rate_bp,unit,image_id,track_stock,active,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          this.app.uuid(), input.name, input.description, input.categoryId ?? null, input.brandId ?? null, input.hsn,
          input.taxRateBp, input.unit, imageId, input.trackStock ? 1 : 0, input.active ? 1 : 0, now, now
        ).lastId
        for (const v of input.variants) variantIds.push(this.createVariant(productId, v, input, now))
        if (!opts.quietCreate)
        this.app.audit({
          entity: 'product', entityId: productId, action: 'create', note: opts.note,
          new: {
            name: input.name, taxRateBp: input.taxRateBp, hsn: input.hsn,
            variants: input.variants.map((v) => ({ name: v.name, mrp: v.mrp, price: v.price, cost: v.cost }))
          }
        })
      } else {
        const old = this.db.get<Record<string, any>>('SELECT * FROM products WHERE id = ?', productId)
        if (!old) throw new AppError('NOT_FOUND', 'Product not found')
        const next = {
          name: input.name, description: input.description, category_id: input.categoryId ?? null, brand_id: input.brandId ?? null,
          hsn: input.hsn, tax_rate_bp: input.taxRateBp, unit: input.unit, track_stock: input.trackStock ? 1 : 0, active: input.active ? 1 : 0
        }
        if (old.track_units && !next.track_stock && input.trackUnits !== false)
          throw new AppError('VALIDATION', 'A product with unit codes must track stock. Turn unit codes off first.', { code: 'UNITS_NEED_STOCK_TRACKING' })
        const changes: Record<string, { old: unknown; new: unknown }> = {}
        for (const [k, nv] of Object.entries(next)) if (old[k] !== nv) changes[k] = { old: old[k], new: nv }
        let imageId: number | null = old.image_id
        if (input.removeImage) imageId = null
        if (input.image) imageId = this.storeImage(input.image)
        if (imageId !== old.image_id) {
          changes.image_id = { old: old.image_id, new: imageId }
          oldImage = old.image_id
        }
        if (Object.keys(changes).length) {
          this.db.run(
            `UPDATE products SET name=?,description=?,category_id=?,brand_id=?,hsn=?,tax_rate_bp=?,unit=?,track_stock=?,active=?,image_id=?,updated_at=? WHERE id=?`,
            next.name, next.description, next.category_id, next.brand_id, next.hsn, next.tax_rate_bp, next.unit, next.track_stock,
            next.active, imageId, now, productId
          )
          if (changes.tax_rate_bp || changes.hsn)
            this.app.audit({
              entity: 'product', entityId: productId, action: 'tax_change', note: opts.note,
              old: { taxRateBp: old.tax_rate_bp, hsn: old.hsn }, new: { taxRateBp: next.tax_rate_bp, hsn: next.hsn }
            })
          const { tax_rate_bp: _t, hsn: _h, image_id: _i, ...rest } = changes
          if (Object.keys(rest).length || _i)
            this.app.audit({
              entity: 'product', entityId: productId, action: 'update', note: opts.note,
              old: Object.fromEntries(Object.entries(changes).map(([k, c]) => [k, c.old])),
              new: Object.fromEntries(Object.entries(changes).map(([k, c]) => [k, c.new]))
            })
          this.dropImageIfOrphan(oldImage)
        }
        let variantChanged = false
        for (const v of input.variants) {
          if (v.id) {
            variantChanged = this.updateVariant(productId, v, now, opts.note) || variantChanged
            variantIds.push(v.id)
          } else {
            variantIds.push(this.createVariant(productId, v, input, now))
            variantChanged = true
          }
        }
        if (variantChanged && !Object.keys(changes).length) this.db.run('UPDATE products SET updated_at = ? WHERE id = ?', now, productId)
      }
      // unit codes: apply the requested tracking change, or give opening stock of new variants of a tracked product its codes
      const units = this.app.has('units') ? this.app.get<UnitsService>('units') : null
      if (units) {
        const cur = this.db.get<{ track_units: number }>('SELECT track_units FROM products WHERE id = ?', productId)
        if (input.trackUnits !== undefined || input.unitPrefix) {
          const want = input.trackUnits ?? !!cur?.track_units
          if (want || cur?.track_units) units.setTrackingTx(productId, { trackUnits: want, prefix: input.unitPrefix, discardUnits: input.discardUnits })
        } else if (cur?.track_units) units.backfillProduct(productId)
      }
      if (opts.deferSync) opts.deferSync.add(productId)
      else enqueueProductSnapshot(this.app, productId)
      return { productId, variantIds, created }
    })
  }

  private checkRefs(input: ProductInputT): void {
    if (input.categoryId && !this.db.value('SELECT 1 FROM categories WHERE id = ?', input.categoryId))
      throw new AppError('VALIDATION', 'Selected category does not exist')
    if (input.brandId && !this.db.value('SELECT 1 FROM brands WHERE id = ?', input.brandId))
      throw new AppError('VALIDATION', 'Selected brand does not exist')
  }

  private checkVariantNames(input: ProductInputT): void {
    const seen = new Set<string>()
    for (const v of input.variants) {
      const k = v.name.toLowerCase()
      if (seen.has(k)) throw new AppError('CONFLICT', `Duplicate variant name "${v.name || '(default)'}" in this product`)
      seen.add(k)
    }
    if (input.id) {
      const existing = this.db.all<{ id: number; name: string }>('SELECT id, name FROM product_variants WHERE product_id = ?', input.id)
      for (const v of input.variants) {
        const clash = existing.find((e) => e.name.toLowerCase() === v.name.toLowerCase() && e.id !== v.id)
        if (clash) throw new AppError('CONFLICT', `Variant "${v.name || '(default)'}" already exists on this product`)
      }
    }
  }

  private normBarcode(code: string): string {
    const c = this.checkBarcode(code)
    if (!c.valid) throw new AppError('VALIDATION', c.error ?? 'Invalid barcode')
    return c.code
  }

  private assertBarcodeFree(code: string, variantId?: number): void {
    const o = this.barcodeOwner(code, variantId)
    if (o) throw new AppError('CONFLICT', this.ownerText(code, o), { barcode: code, variantId: o.variantId })
    const clash = this.unitNamespaceClash(code)
    if (clash) throw new AppError('CONFLICT', clash, { code: 'UNIT_NAMESPACE', barcode: code })
  }

  private normAliases(aliases: string[], primary: string | null, variantId?: number): string[] {
    const out: string[] = []
    for (const a of aliases) {
      if (!a.trim()) continue
      const code = this.normBarcode(a)
      if (code === primary || out.includes(code)) continue
      this.assertBarcodeFree(code, variantId)
      out.push(code)
    }
    return out
  }

  private createVariant(productId: number, v: VariantInputT, product: ProductInputT, now: number): number {
    let sku = (v.sku ?? '').trim()
    if (sku) this.assertSkuFree(sku)
    else sku = this.nextSku()
    let barcode: string | null = v.barcode ? this.normBarcode(v.barcode) : null
    if (barcode) {
      this.assertBarcodeFree(barcode)
      this.claimBarcode(barcode)
    } else if (v.autoBarcode) barcode = this.nextBarcode()
    const aliases = this.normAliases(v.aliases ?? [], barcode)
    const id = this.db.run(
      `INSERT INTO product_variants(uuid,product_id,name,sku,barcode,mrp,price,cost,reorder_level,active,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      this.app.uuid(), productId, v.name, sku, barcode, v.mrp, v.price, v.cost, v.reorderLevel, v.active ? 1 : 0, now, now
    ).lastId
    for (const a of aliases) this.db.run('INSERT INTO variant_barcodes(barcode, variant_id) VALUES (?,?)', a, id)
    if (v.openingStock && product.trackStock)
      this.app.moveStock({ variantId: id, delta: v.openingStock, type: 'opening', refType: 'product', refId: productId, unitCost: v.cost, note: 'Opening stock' })
    return id
  }

  /** Returns true when anything changed. */
  private updateVariant(productId: number, v: VariantInputT, now: number, note?: string): boolean {
    const old = this.db.get<Record<string, any>>('SELECT * FROM product_variants WHERE id = ? AND product_id = ?', v.id!, productId)
    if (!old) throw new AppError('NOT_FOUND', `Variant ${v.id} does not belong to this product`)
    let sku = old.sku as string
    if (v.sku && v.sku !== old.sku) {
      this.assertSkuFree(v.sku, old.id)
      sku = v.sku
    }
    let barcode: string | null = old.barcode
    if (v.barcode !== undefined) {
      barcode = v.barcode ? this.normBarcode(v.barcode) : null
      if (barcode && barcode !== old.barcode) {
        this.assertBarcodeFree(barcode, old.id)
        this.claimBarcode(barcode)
      }
    }
    if (!barcode && v.autoBarcode) barcode = this.nextBarcode()
    const next = { name: v.name, sku, barcode, mrp: v.mrp, price: v.price, cost: v.cost, reorder_level: v.reorderLevel, active: v.active ? 1 : 0 }
    const changes: string[] = Object.entries(next).filter(([k, nv]) => old[k] !== nv).map(([k]) => k)
    let changed = changes.length > 0
    if (changed) {
      this.db.run(
        'UPDATE product_variants SET name=?,sku=?,barcode=?,mrp=?,price=?,cost=?,reorder_level=?,active=?,updated_at=? WHERE id=?',
        next.name, next.sku, next.barcode, next.mrp, next.price, next.cost, next.reorder_level, next.active, now, old.id
      )
      if (['mrp', 'price', 'cost'].some((k) => changes.includes(k)))
        this.app.audit({
          entity: 'variant', entityId: old.id, action: 'price_change', note: note ?? `${old.sku}`,
          old: { mrp: old.mrp, price: old.price, cost: old.cost }, new: { mrp: next.mrp, price: next.price, cost: next.cost }
        })
      const other = changes.filter((k) => !['mrp', 'price', 'cost'].includes(k))
      if (other.length)
        this.app.audit({
          entity: 'variant', entityId: old.id, action: 'update', note,
          old: Object.fromEntries(other.map((k) => [k, old[k]])), new: Object.fromEntries(other.map((k) => [k, (next as any)[k]]))
        })
    }
    // an alias promoted to the primary barcode must not stay behind as an alias of itself
    if (barcode && barcode !== old.barcode && v.aliases === undefined && this.db.run('DELETE FROM variant_barcodes WHERE barcode = ? AND variant_id = ?', barcode, old.id).changes) changed = true
    if (v.aliases !== undefined) {
      const want = this.normAliases(v.aliases, barcode, old.id)
      const have = this.db.all<{ barcode: string }>('SELECT barcode FROM variant_barcodes WHERE variant_id = ?', old.id).map((r) => r.barcode)
      const del = have.filter((h) => !want.includes(h))
      const add = want.filter((w) => !have.includes(w))
      for (const d of del) this.db.run('DELETE FROM variant_barcodes WHERE barcode = ?', d)
      for (const a of add) this.db.run('INSERT INTO variant_barcodes(barcode, variant_id) VALUES (?,?)', a, old.id)
      if (del.length || add.length) {
        this.db.run('UPDATE product_variants SET updated_at = ? WHERE id = ?', now, old.id)
        this.app.audit({ entity: 'variant', entityId: old.id, action: 'aliases_change', old: have, new: want })
        changed = true
      }
    }
    return changed
  }

  // ---------------------------------------------------------------- history / delete / activate
  private hasHistory(variantIds: number[]): boolean {
    if (!variantIds.length) return false
    const ph = variantIds.map(() => '?').join(',')
    const q = (t: string) => `SELECT 1 FROM ${t} WHERE variant_id IN (${ph}) LIMIT 1`
    for (const t of ['product_units', 'sale_items', 'stock_movements', 'purchase_items', 'supplier_return_items', 'stock_count_items', 'stock_transfer_items', 'sale_return_items'])
      if (this.db.value(q(t), ...variantIds)) return true
    return !!this.db.value(`SELECT 1 FROM stock_levels WHERE variant_id IN (${ph}) AND qty <> 0 LIMIT 1`, ...variantIds)
  }

  /** Delete a product when it has no history, otherwise deactivate it. Permission: catalog.delete. */
  remove(raw: unknown): { deleted: boolean; deactivated: boolean; reason?: string } {
    this.app.requirePermission('catalog.delete')
    const id = (raw as { id?: number })?.id
    if (!id) throw new AppError('VALIDATION', 'Product id is required')
    return this.db.transaction(() => {
      const p = this.db.get<{ id: number; name: string; image_id: number | null; active: number }>('SELECT * FROM products WHERE id = ?', id)
      if (!p) throw new AppError('NOT_FOUND', 'Product not found')
      const vids = this.db.all<{ id: number }>('SELECT id FROM product_variants WHERE product_id = ?', id).map((r) => r.id)
      if (this.hasHistory(vids)) {
        if (p.active) this.setActiveTx([id], false)
        return { deleted: false, deactivated: true, reason: 'Product has sales or stock history, so it was deactivated instead of deleted' }
      }
      enqueueProductSnapshot(this.app, id, 'delete')
      for (const vid of vids) this.db.run('DELETE FROM variant_barcodes WHERE variant_id = ?', vid)
      this.db.run('DELETE FROM product_variants WHERE product_id = ?', id)
      this.db.run('DELETE FROM products WHERE id = ?', id)
      this.dropImageIfOrphan(p.image_id)
      this.app.audit({ entity: 'product', entityId: id, action: 'delete', old: { name: p.name } })
      return { deleted: true, deactivated: false }
    })
  }

  /** Remove a variant (hard delete when unused, otherwise deactivate). A product always keeps >= 1 variant. */
  removeVariant(raw: unknown): { deleted: boolean; deactivated: boolean } {
    this.app.requirePermission('catalog.delete')
    const id = (raw as { id?: number })?.id
    const v = id ? this.db.get<{ id: number; product_id: number; sku: string }>('SELECT id, product_id, sku FROM product_variants WHERE id = ?', id) : undefined
    if (!v) throw new AppError('NOT_FOUND', 'Variant not found')
    return this.db.transaction(() => {
      const count = this.db.value<number>('SELECT COUNT(*) FROM product_variants WHERE product_id = ?', v.product_id) ?? 0
      const activeCount = this.db.value<number>('SELECT COUNT(*) FROM product_variants WHERE product_id = ? AND active = 1', v.product_id) ?? 0
      if (count <= 1) throw new AppError('VALIDATION', 'A product must keep at least one variant')
      const now = Date.now()
      if (this.hasHistory([v.id])) {
        if (activeCount <= 1 && this.db.value('SELECT active FROM product_variants WHERE id = ?', v.id)) {
          throw new AppError('VALIDATION', 'This is the only active variant; deactivate the product instead')
        }
        this.db.run('UPDATE product_variants SET active = 0, updated_at = ? WHERE id = ?', now, v.id)
        this.db.run('UPDATE products SET updated_at = ? WHERE id = ?', now, v.product_id)
        this.app.audit({ entity: 'variant', entityId: v.id, action: 'deactivate', old: { sku: v.sku } })
        enqueueProductSnapshot(this.app, v.product_id)
        return { deleted: false, deactivated: true }
      }
      this.db.run('DELETE FROM variant_barcodes WHERE variant_id = ?', v.id)
      this.db.run('DELETE FROM product_variants WHERE id = ?', v.id)
      this.db.run('UPDATE products SET updated_at = ? WHERE id = ?', now, v.product_id)
      this.app.audit({ entity: 'variant', entityId: v.id, action: 'delete', old: { sku: v.sku } })
      enqueueProductSnapshot(this.app, v.product_id)
      return { deleted: true, deactivated: false }
    })
  }

  private setActiveTx(ids: number[], active: boolean): number {
    const now = Date.now()
    let n = 0
    for (const id of ids) {
      const r = this.db.run('UPDATE products SET active = ?, updated_at = ? WHERE id = ? AND active <> ?', active ? 1 : 0, now, id, active ? 1 : 0)
      if (!r.changes) continue
      n++
      this.app.audit({ entity: 'product', entityId: id, action: active ? 'activate' : 'deactivate', old: { active: !active }, new: { active } })
      enqueueProductSnapshot(this.app, id)
    }
    return n
  }

  /** Bulk activate/deactivate. Deactivating needs catalog.delete, activating catalog.edit. */
  setActive(raw: unknown): { changed: number } {
    const { active } = (raw ?? {}) as { active?: boolean }
    if (typeof active !== 'boolean') throw new AppError('VALIDATION', '"active" must be true or false')
    this.app.requirePermission(active ? 'catalog.edit' : 'catalog.delete')
    const { ids } = parse(IdsInput, raw)
    return { changed: this.db.transaction(() => this.setActiveTx(ids, active)) }
  }

  assignCategory(raw: unknown): { changed: number } {
    this.app.requirePermission('catalog.edit')
    const { ids } = parse(IdsInput, raw)
    const categoryId = (raw as { categoryId?: number | null }).categoryId ?? null
    if (categoryId && !this.db.value('SELECT 1 FROM categories WHERE id = ?', categoryId)) throw new AppError('NOT_FOUND', 'Category not found')
    return this.db.transaction(() => {
      const now = Date.now()
      let n = 0
      for (const id of ids) {
        const old = this.db.value<number | null>('SELECT category_id FROM products WHERE id = ?', id)
        if (old === undefined || old === categoryId) continue
        this.db.run('UPDATE products SET category_id = ?, updated_at = ? WHERE id = ?', categoryId, now, id)
        this.app.audit({ entity: 'product', entityId: id, action: 'update', old: { category_id: old }, new: { category_id: categoryId } })
        enqueueProductSnapshot(this.app, id)
        n++
      }
      return { changed: n }
    })
  }

  /** Audit trail of MRP / price / cost changes for a variant (newest first). */
  priceHistory(raw: unknown): { ts: number; user: string | null; old: unknown; new: unknown; note: string | null }[] {
    this.app.requirePermission('catalog.view')
    const variantId = (raw as { variantId?: number })?.variantId
    if (!variantId) throw new AppError('VALIDATION', 'variantId is required')
    return this.db
      .all<Record<string, any>>(
        `SELECT ts, user_name, old_json, new_json, note FROM audit_log WHERE entity='variant' AND entity_id=? AND action='price_change' ORDER BY id DESC`,
        String(variantId)
      )
      .map((r) => ({ ts: r.ts, user: r.user_name, old: JSON.parse(r.old_json ?? 'null'), new: JSON.parse(r.new_json ?? 'null'), note: r.note }))
  }

  // ======================================================================== categories / brands
  listCategories(): { id: number; uuid: string; name: string; parentId: number | null; active: boolean; path: string; productCount: number }[] {
    this.app.requirePermission('catalog.view')
    const rows = this.db.all<Record<string, any>>(
      `SELECT c.*, (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id) AS cnt FROM categories c ORDER BY c.name COLLATE NOCASE`
    )
    const byId = new Map(rows.map((r) => [r.id, r]))
    const path = (r: Record<string, any>): string => {
      const parts = [r.name]
      const seen = new Set([r.id])
      for (let p = r.parent_id ? byId.get(r.parent_id) : undefined; p && !seen.has(p.id); p = p.parent_id ? byId.get(p.parent_id) : undefined) {
        parts.unshift(p.name)
        seen.add(p.id)
      }
      return parts.join(' > ')
    }
    return rows
      .map((r) => ({ id: r.id, uuid: r.uuid, name: r.name, parentId: r.parent_id, active: bool(r.active), path: path(r), productCount: r.cnt }))
      .sort((a, b) => a.path.localeCompare(b.path))
  }

  saveCategory(raw: unknown): { id: number } {
    this.app.requirePermission('catalog.edit')
    const input = parse(NamedInput, raw)
    return this.db.transaction(() => {
      const now = Date.now()
      const dup = this.db.get<{ id: number }>('SELECT id FROM categories WHERE name = ? COLLATE NOCASE AND id <> ?', input.name, input.id ?? 0)
      if (dup) throw new AppError('CONFLICT', `A category named "${input.name}" already exists`)
      if (input.parentId && !this.db.value('SELECT 1 FROM categories WHERE id = ?', input.parentId)) throw new AppError('VALIDATION', 'Parent category not found')
      if (input.id) {
        const old = this.db.get<Record<string, any>>('SELECT * FROM categories WHERE id = ?', input.id)
        if (!old) throw new AppError('NOT_FOUND', 'Category not found')
        // cycle check: parent must not be self or a descendant
        for (let p = input.parentId ?? null, hops = 0; p; hops++) {
          if (p === input.id || hops > 100) throw new AppError('VALIDATION', 'A category cannot be moved under itself')
          p = this.db.value<number | null>('SELECT parent_id FROM categories WHERE id = ?', p) ?? null
        }
        this.db.run('UPDATE categories SET name=?, parent_id=?, active=?, updated_at=? WHERE id=?', input.name, input.parentId ?? null, input.active ? 1 : 0, now, input.id)
        this.app.audit({
          entity: 'category', entityId: input.id, action: 'update',
          old: { name: old.name, parent_id: old.parent_id, active: !!old.active }, new: { name: input.name, parent_id: input.parentId ?? null, active: input.active }
        })
        this.app.enqueueSnapshot('categories', input.id)
        return { id: input.id }
      }
      const id = this.insertCategory(input.name, input.parentId ?? null, input.active)
      return { id }
    })
  }

  private insertCategory(name: string, parentId: number | null, active = true): number {
    const id = this.db.run('INSERT INTO categories(uuid,name,parent_id,active,updated_at) VALUES (?,?,?,?,?)', this.app.uuid(), name, parentId, active ? 1 : 0, Date.now()).lastId
    this.app.audit({ entity: 'category', entityId: id, action: 'create', new: { name, parentId } })
    this.app.enqueueSnapshot('categories', id)
    return id
  }

  /** "Fireworks > Sparklers" -> id of the leaf, creating missing nodes. Names are globally unique, so an existing name is reused. */
  ensureCategoryPath(path: string): number | null {
    const parts = path.split('>').map((s) => s.trim()).filter(Boolean)
    let parent: number | null = null
    for (const name of parts) {
      const hit: { id: number } | undefined = this.db.get<{ id: number }>('SELECT id FROM categories WHERE name = ? COLLATE NOCASE', name)
      parent = hit ? hit.id : this.insertCategory(name.slice(0, 100), parent)
    }
    return parent
  }

  deleteCategory(raw: unknown): { deleted: boolean; deactivated: boolean } {
    this.app.requirePermission('catalog.delete')
    const id = (raw as { id?: number })?.id
    return this.db.transaction(() => {
      const c = id ? this.db.get<Record<string, any>>('SELECT * FROM categories WHERE id = ?', id) : undefined
      if (!c) throw new AppError('NOT_FOUND', 'Category not found')
      const used = this.db.value('SELECT 1 FROM products WHERE category_id = ?', c.id) || this.db.value('SELECT 1 FROM categories WHERE parent_id = ?', c.id)
      if (used) {
        this.db.run('UPDATE categories SET active = 0, updated_at = ? WHERE id = ?', Date.now(), c.id)
        this.app.audit({ entity: 'category', entityId: c.id, action: 'deactivate', old: { name: c.name } })
        this.app.enqueueSnapshot('categories', c.id)
        return { deleted: false, deactivated: true }
      }
      this.app.enqueueSnapshot('categories', c.id, [], 'delete')
      this.db.run('DELETE FROM categories WHERE id = ?', c.id)
      this.app.audit({ entity: 'category', entityId: c.id, action: 'delete', old: { name: c.name } })
      return { deleted: true, deactivated: false }
    })
  }

  listBrands(): { id: number; uuid: string; name: string; active: boolean; productCount: number }[] {
    this.app.requirePermission('catalog.view')
    return this.db
      .all<Record<string, any>>(`SELECT b.*, (SELECT COUNT(*) FROM products p WHERE p.brand_id = b.id) AS cnt FROM brands b ORDER BY b.name COLLATE NOCASE`)
      .map((r) => ({ id: r.id, uuid: r.uuid, name: r.name, active: bool(r.active), productCount: r.cnt }))
  }

  saveBrand(raw: unknown): { id: number } {
    this.app.requirePermission('catalog.edit')
    const input = parse(NamedInput, raw)
    return this.db.transaction(() => {
      const dup = this.db.get('SELECT id FROM brands WHERE name = ? COLLATE NOCASE AND id <> ?', input.name, input.id ?? 0)
      if (dup) throw new AppError('CONFLICT', `A brand named "${input.name}" already exists`)
      if (input.id) {
        const old = this.db.get<Record<string, any>>('SELECT * FROM brands WHERE id = ?', input.id)
        if (!old) throw new AppError('NOT_FOUND', 'Brand not found')
        this.db.run('UPDATE brands SET name=?, active=?, updated_at=? WHERE id=?', input.name, input.active ? 1 : 0, Date.now(), input.id)
        this.app.audit({ entity: 'brand', entityId: input.id, action: 'update', old: { name: old.name, active: !!old.active }, new: { name: input.name, active: input.active } })
        this.app.enqueueSnapshot('brands', input.id)
        return { id: input.id }
      }
      return { id: this.insertBrand(input.name, input.active) }
    })
  }

  private insertBrand(name: string, active = true): number {
    const id = this.db.run('INSERT INTO brands(uuid,name,active,updated_at) VALUES (?,?,?,?)', this.app.uuid(), name, active ? 1 : 0, Date.now()).lastId
    this.app.audit({ entity: 'brand', entityId: id, action: 'create', new: { name } })
    this.app.enqueueSnapshot('brands', id)
    return id
  }

  ensureBrand(name: string): number | null {
    const n = name.trim()
    if (!n) return null
    return this.db.value<number>('SELECT id FROM brands WHERE name = ? COLLATE NOCASE', n) ?? this.insertBrand(n.slice(0, 100))
  }

  deleteBrand(raw: unknown): { deleted: boolean; deactivated: boolean } {
    this.app.requirePermission('catalog.delete')
    const id = (raw as { id?: number })?.id
    return this.db.transaction(() => {
      const b = id ? this.db.get<Record<string, any>>('SELECT * FROM brands WHERE id = ?', id) : undefined
      if (!b) throw new AppError('NOT_FOUND', 'Brand not found')
      if (this.db.value('SELECT 1 FROM products WHERE brand_id = ?', b.id)) {
        this.db.run('UPDATE brands SET active = 0, updated_at = ? WHERE id = ?', Date.now(), b.id)
        this.app.audit({ entity: 'brand', entityId: b.id, action: 'deactivate', old: { name: b.name } })
        this.app.enqueueSnapshot('brands', b.id)
        return { deleted: false, deactivated: true }
      }
      this.app.enqueueSnapshot('brands', b.id, [], 'delete')
      this.db.run('DELETE FROM brands WHERE id = ?', b.id)
      this.app.audit({ entity: 'brand', entityId: b.id, action: 'delete', old: { name: b.name } })
      return { deleted: true, deactivated: false }
    })
  }
}

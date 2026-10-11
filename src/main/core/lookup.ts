import type { Db } from '../db/driver'
import { scanCandidates } from '../modules/pos/codes'
import { AppError } from '../../shared/ipc'
import { stripScanFraming } from '../../shared/scanCode'
import { UNIT_CODE_RE, normalizeUnitCode } from '../../shared/scanList'

export type UnitStatus = 'in_stock' | 'sold' | 'returned' | 'void'
/** A scanned unit code (PREFIX-NNNN) resolved to its row. */
export interface ScannedUnit {
  id: number
  code: string
  status: UnitStatus
  variantId: number
  saleId: number | null
}

export interface SellableVariant {
  variantId: number
  productId: number
  uuid: string
  productName: string
  variantName: string
  displayName: string
  sku: string
  barcode: string | null
  hsn: string
  taxRateBp: number
  mrp: number
  price: number
  cost: number
  unit: string
  trackStock: boolean
  categoryId: number | null
  brandId: number | null
  active: boolean
  stock: number
  /** product has per-unit codes: the sale line needs `unitCodes` (scan the unit label) */
  trackUnits: boolean
}

/**
 * What a scan resolves to. `unit` is the unit of measure ('pcs') for an ordinary barcode, but an OBJECT {code,status,...} when the
 * scanned text was a unit code (PREFIX-NNNN); `unitOfMeasure` always carries the measure string.
 */
export type ScanVariant = Omit<SellableVariant, 'unit'> & { unit: string | ScannedUnit; unitOfMeasure: string }

/** The scanned unit of a scan result, or null when an ordinary product barcode was scanned. */
export const scannedUnitOf = (v: Pick<ScanVariant, 'unit'>): ScannedUnit | null => (typeof v.unit === 'object' ? v.unit : null)

const SELECT = `
SELECT v.id AS variantId, p.id AS productId, v.uuid, p.name AS productName, v.name AS variantName,
       p.name || CASE WHEN v.name <> '' THEN ' - ' || v.name ELSE '' END AS displayName,
       v.sku, v.barcode, p.hsn, p.tax_rate_bp AS taxRateBp, v.mrp, v.price, v.cost, p.unit,
       p.track_stock AS trackStock, p.track_units AS trackUnits, p.category_id AS categoryId, p.brand_id AS brandId,
       (v.active AND p.active) AS active,
       COALESCE((SELECT SUM(qty) FROM stock_levels s WHERE s.variant_id = v.id), 0) AS stock
FROM product_variants v JOIN products p ON p.id = v.product_id`

const shape = (r: Record<string, unknown>): SellableVariant => ({
  ...(r as unknown as SellableVariant),
  trackStock: !!r.trackStock,
  trackUnits: !!r.trackUnits,
  active: !!r.active
})

/** Resolve a scanned/typed code to a sellable variant: barcode, alias barcode, then exact SKU. Shared by POS, inventory, labels. */
export function findVariantByCode(db: Db, code: string): SellableVariant | undefined {
  const c = code.trim()
  if (!c) return undefined
  const r =
    db.get<Record<string, unknown>>(`${SELECT} WHERE v.barcode = ?`, c) ??
    db.get<Record<string, unknown>>(`${SELECT} WHERE v.id = (SELECT variant_id FROM variant_barcodes WHERE barcode = ?)`, c) ??
    db.get<Record<string, unknown>>(`${SELECT} WHERE v.sku = ? COLLATE NOCASE`, c)
  return r ? shape(r) : undefined
}

/**
 * Resolve what a barcode reader delivered: the exact text first, then every spelling a reader / its symbology options may have
 * produced instead (UPC-A <-> EAN-13, stripped check digit, added leading zeros, GS1 wrappers, ]E0 prefixes, Code 39 stars, case).
 * Use this for anything fed by a scanner (POS, stock count, purchases, pickers); byCode stays exact for validation / duplicate checks.
 *
 * The exact text always wins. The other spellings are tried in tiers (same symbol written differently, then repair guesses, see
 * pos/codes.ts); when the spellings of one tier lead to two DIFFERENT items the scan is refused with CONFLICT
 * (details.code 'SCAN_AMBIGUOUS', details.matches) instead of silently billing whichever came first.
 */
export function findVariantByScan(db: Db, code: string): ScanVariant | undefined {
  const resolve = (c: string): ScanVariant | undefined => {
    const unit = findUnit(db, c)
    if (unit) {
      const uv = getVariant(db, unit.variantId)
      if (uv) return { ...uv, unit, unitOfMeasure: uv.unit }
    }
    const v = findVariantByCode(db, c)
    return v ? { ...v, unitOfMeasure: v.unit } : undefined
  }
  const candidates = scanCandidates(String(code ?? ''))
  for (const tier of [0, 1, 2]) {
    const hits: { via: string; v: ScanVariant }[] = []
    for (const c of candidates) {
      if (c.tier !== tier) continue
      const v = resolve(c.code)
      if (!v) continue
      if (tier === 0) return v
      if (!hits.some((h) => h.v.variantId === v.variantId)) hits.push({ via: c.code, v })
    }
    if (hits.length === 1) return hits[0].v
    if (hits.length > 1)
      throw new AppError(
        'CONFLICT',
        `"${candidates[0].code}" could be ${hits.map((h) => `${h.v.displayName} (${h.via})`).join(' or ')}. Scan again, or choose the item by name.`,
        { code: 'SCAN_AMBIGUOUS', scanned: candidates[0].code, matches: hits.map((h) => ({ variantId: h.v.variantId, name: h.v.displayName, code: h.via })) }
      )
  }
  return undefined
}

/** Exact unit-code lookup (case/space-insensitive). Undefined for anything that is not a known PREFIX-NNNN code. */
export function findUnit(db: Db, code: string): ScannedUnit | undefined {
  const c = normalizeUnitCode(String(code ?? ''))
  if (!UNIT_CODE_RE.test(c)) return undefined
  return db.get<ScannedUnit>('SELECT id, code, status, variant_id AS variantId, sale_id AS saleId FROM product_units WHERE code = ?', c)
}

export function getVariant(db: Db, variantId: number): SellableVariant | undefined {
  const r = db.get<Record<string, unknown>>(`${SELECT} WHERE v.id = ?`, variantId)
  return r ? shape(r) : undefined
}

/** Free-text product search for pickers (name / sku / barcode). Active items only. */
export function searchVariants(db: Db, text: string, limit = 30): SellableVariant[] {
  // a scan typed into a search box can carry reader decorations (]E0 prefix, Code 39 stars, CR/LF): search for the bare code
  const t = stripScanFraming(text).trim() || text.trim()
  // every word must match somewhere (name, variant, SKU, barcode), in any order and not necessarily next to each other:
  // "Sparkler 15cm" finds "Sparkler Box 15cm". % and _ are escaped, so "100%" searches for the text and not for a wildcard.
  const terms = t.split(/\s+/).filter(Boolean).slice(0, 8)
  if (!terms.length) terms.push('') // empty box: the first page, as before
  const like = (s: string) => `%${s.replace(/[\\%_]/g, (c) => '\\' + c)}%`
  // Ordering by the NOCASE name index lets SQLite walk products in name order and stop at `limit` matches (1-2 ms for a word like
  // "rock" on 20k products, instead of scanning and sorting everything: 12-15 ms). Code-like terms (a digit, no space: SKU /
  // barcode fragments) match few rows, so there the early exit never fires and the plain scan is cheaper.
  const codeLike = /\d/.test(t) && !/\s/.test(t)
  // an alias barcode typed / scanned into a picker finds its item too (code-like terms only: keeps the name search on its index)
  const alias = codeLike ? ` OR v.id IN (SELECT variant_id FROM variant_barcodes WHERE barcode LIKE ? ESCAPE '\\')` : ''
  const one = `(p.name LIKE ? ESCAPE '\\' OR v.name LIKE ? ESCAPE '\\' OR v.sku LIKE ? ESCAPE '\\' OR v.barcode LIKE ? ESCAPE '\\'${alias})`
  const params: string[] = []
  for (const term of terms) params.push(...Array<string>(codeLike ? 5 : 4).fill(like(term)))
  return db
    .all<Record<string, unknown>>(
      `${SELECT} WHERE (v.active AND p.active) AND ${terms.map(() => one).join(' AND ')} ORDER BY p.name${codeLike ? '' : ' COLLATE NOCASE'} LIMIT ?`,
      ...params, limit
    )
    .map(shape)
}

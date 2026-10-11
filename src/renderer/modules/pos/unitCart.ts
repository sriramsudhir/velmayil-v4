import { createScanList, normalizeUnitCode, parseUnitCode, type ScanList } from '@shared/scanList'
import type { CartLine, SavedCart, Variant } from './types'

/** Pure helpers for per-unit tracked lines on the bill (label numbers like 2000000190, older PREFIX-NNNN codes). The bill itself is the "active list". */

export const TRACKED_HINT = 'This product is tracked per unit - scan the unit code on the item'
export const notAvailableMessage = (code: string, status?: string): string =>
  `${normalizeUnitCode(code)} is already ${status === 'void' ? 'void' : 'sold'}`

export interface UnitInfo { code: string; status: string }
// NOTE: Variant.unit is the unit of measure (string); a scanned unit arrives as an object under the same key (contract: unit:{code,status}).
export type ScanResponse = Omit<Variant, 'unit'> & { unit?: UnitInfo | string | null; trackUnits?: boolean; unlabelledUnits?: number }
export const unitInfoOf = (r: Pick<ScanResponse, 'unit'>): UnitInfo | null => (r.unit && typeof r.unit === 'object' ? r.unit : null)

/** All unit codes currently on the bill. */
export const allUnitCodes = (lines: CartLine[]): string[] => lines.flatMap((l) => l.unitCodes ?? [])

/** Rebuild the scan list from the bill (after resume, remove, ...). */
export const listFromLines = (lines: CartLine[]): ScanList => createScanList(allUnitCodes(lines))

export const lineWithCode = (lines: CartLine[], code: string): CartLine | undefined => {
  const k = normalizeUnitCode(code)
  return lines.find((l) => l.unitCodes?.includes(k))
}

/** Cheap local pre-check before any server call: a code in unit format that is already on the bill is a duplicate. */
export const isLocalDuplicate = (list: ScanList, code: string): boolean => !!parseUnitCode(code) && list.has(code)

export interface AddUnitOutcome { lines: CartLine[]; result: 'added' | 'duplicate'; lineKey: string | null }

/** Apply the shared rule: not listed -> add (new tracked line or one more unit on the variant's line); listed -> no change. */
export function addUnit(lines: CartLine[], list: ScanList, v: Pick<Variant, 'variantId' | 'displayName' | 'sku' | 'price' | 'taxRateBp' | 'trackStock' | 'stock'>, code: string, newKey: () => string): AddUnitOutcome {
  const k = normalizeUnitCode(code)
  const result = list.tryAdd(k)
  if (result === 'duplicate') return { lines, result, lineKey: lineWithCode(lines, k)?.key ?? null }
  const i = lines.findIndex((l) => l.tracked && l.variantId === v.variantId && l.overridePrice == null && !l.discount)
  if (i >= 0) {
    const next = lines.map((l, j) => (j === i ? { ...l, unitCodes: [...(l.unitCodes ?? []), k], qty: (l.unitCodes?.length ?? 0) + 1, stock: v.stock } : l))
    return { lines: next, result, lineKey: lines[i].key }
  }
  const key = newKey()
  const line: CartLine = {
    key, variantId: v.variantId, name: v.displayName, sku: v.sku, qty: 1, price: v.price, overridePrice: null, discount: null,
    taxRateBp: v.taxRateBp, trackStock: v.trackStock, stock: v.stock, tracked: true, unitCodes: [k]
  }
  return { lines: [...lines, line], result, lineKey: key }
}

/** Remove one unit code from its line (the line goes when its last code goes). The code can be scanned again. */
export function removeUnit(lines: CartLine[], list: ScanList, key: string, code: string): CartLine[] {
  const k = normalizeUnitCode(code)
  list.remove(k)
  return lines.flatMap((l) => {
    if (l.key !== key) return [l]
    const codes = (l.unitCodes ?? []).filter((c) => c !== k)
    return codes.length ? [{ ...l, unitCodes: codes, qty: codes.length }] : []
  })
}

/** Remove a whole line; its unit codes are released from the list. */
export function removeLine(lines: CartLine[], list: ScanList, key: string): CartLine[] {
  const gone = lines.find((l) => l.key === key)
  for (const c of gone?.unitCodes ?? []) list.remove(c)
  return lines.filter((l) => l.key !== key)
}

/** completeSale line payload; tracked lines send their unit codes (qty === unitCodes.length). */
export function saleLinePayload(l: CartLine) {
  return {
    variantId: l.variantId,
    qty: l.tracked ? (l.unitCodes?.length ?? 0) : l.qty,
    unitPriceOverride: l.overridePrice ?? undefined,
    lineDiscount: l.discount,
    ...(l.tracked ? { unitCodes: l.unitCodes ?? [] } : {})
  }
}

/** Held bills persist `unitCodes`; make a resumed cart consistent (tracked -> qty follows the codes). */
export function normalizeResumed(lines: CartLine[]): CartLine[] {
  return lines.map((l) => (l.tracked || l.unitCodes?.length ? { ...l, tracked: true, unitCodes: (l.unitCodes ?? []).map(normalizeUnitCode), qty: l.unitCodes?.length ?? l.qty } : l))
}

/** Largest quantity one bill line may hold (same cap as the server). */
export const MAX_LINE_QTY = 1_000_000

/**
 * Quantity typed into a bill line: a whole number from 1 to MAX_LINE_QTY ("1,000" and spaces are accepted).
 * null while the text is not a usable quantity yet (empty, 0, decimals, letters): the line then keeps its old quantity.
 */
export function parseQtyText(text: string): number | null {
  const t = text.replace(/[,\s]/g, '')
  if (!/^\d{1,12}$/.test(t)) return null
  const n = Number(t)
  return n >= 1 ? Math.min(MAX_LINE_QTY, n) : null
}

/**
 * The bill in progress, kept in memory while the cashier looks at another screen (sales history, stock, ...) so coming
 * back to Billing does not lose it. One draft per signed-in user; a finished sale clears it.
 */
let draft: (SavedCart & { userId: number }) | null = null
export function saveDraft(userId: number, cart: SavedCart): void {
  draft = cart.lines.length ? { ...cart, userId } : null
}
export function loadDraft(userId: number): SavedCart | null {
  if (!draft || draft.userId !== userId) return null
  return { lines: draft.lines, billDiscount: draft.billDiscount, customer: draft.customer, note: draft.note }
}
export function clearDraft(): void {
  draft = null
}

/** What a scan response means for the bill. */
export type ScanKind = 'unit' | 'tracked-product' | 'plain'
export const classifyScan = (r: Pick<ScanResponse, 'unit' | 'trackUnits'>): ScanKind => (unitInfoOf(r) ? 'unit' : r.trackUnits ? 'tracked-product' : 'plain')

/**
 * Old labels printed with the shared product barcode: a tracked product may still be billed by that barcode (or picked by name)
 * while it has in-stock pieces that never got a label of their own (`unlabelledUnits` from pos.scan / pos.search), and only for as
 * many pieces as are not on the bill yet. Once every piece has its own label the answer is no: scan the label (TRACKED_HINT).
 * The server applies the same rule when the sale is saved.
 */
export function legacyScanAllowed(lines: CartLine[], v: { variantId: number; trackUnits?: boolean; unlabelledUnits?: number }, qty = 1): boolean {
  if (!v.trackUnits) return true
  const onBill = lines.reduce((n, l) => (l.variantId === v.variantId && !l.tracked ? n + l.qty : n), 0)
  return onBill + qty <= (v.unlabelledUnits ?? 0)
}

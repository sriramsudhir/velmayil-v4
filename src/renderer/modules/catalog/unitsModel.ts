import { MAX_UNIT_SEQ, formatUnitCode, normalizeUnitCode, parseUnitCode } from '@shared/scanList'

/** Pure helpers for "track each unit with a unique code" (PREFIX-NNNN). No UI, no IPC. */

export type UnitStatus = 'in_stock' | 'sold' | 'returned' | 'void'
export const UNIT_STATUSES: UnitStatus[] = ['in_stock', 'sold', 'returned', 'void']
export const UNIT_STATUS_LABEL: Record<UnitStatus, string> = { in_stock: 'In stock', sold: 'Sold', returned: 'Returned', void: 'Void' }
export const UNIT_STATUS_TONE: Record<UnitStatus, 'good' | 'neutral' | 'warn' | 'bad'> = { in_stock: 'good', sold: 'neutral', returned: 'warn', void: 'bad' }

export interface UnitRow { code: string; status: UnitStatus; variantId: number; saleId: number | null; printedAt?: number | null; variantName?: string; sku?: string }

/** Prefix as typed: upper-case A-Z / 0-9 only, at most 8 characters. */
export const sanitizePrefix = (raw: string): string => raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8)

/** Inline error for a prefix field, or null when it is acceptable (uniqueness is checked by the server on save). */
export function prefixError(prefix: string): string | null {
  const p = prefix.trim()
  if (!p) return 'Enter a prefix (2-8 letters or digits), for example SPK'
  if (!/^[A-Z0-9]+$/.test(p)) return 'Use capital letters and digits only'
  if (p.length < 2) return 'Prefix needs at least 2 characters'
  if (p.length > 8) return 'Prefix can be at most 8 characters'
  return null
}

export interface UnitCapacity {
  /** Next code that will be issued, or null when the 9999 limit is reached. */
  nextCode: string | null
  remaining: number
  full: boolean
}

/** `used` = how many codes (any status) the product already consumed. Numbers are never reused, so voided codes count. */
export function unitCapacity(prefix: string, used: number): UnitCapacity {
  const u = Math.max(0, Math.floor(used))
  const remaining = Math.max(0, MAX_UNIT_SEQ - u)
  return { nextCode: remaining > 0 && prefix ? formatUnitCode(prefix, u + 1) : null, remaining, full: remaining === 0 }
}

export function capacityText(prefix: string, used: number): string {
  if (!prefix) return 'Codes look like PREFIX-0001 (a four-digit number added to your prefix).'
  const c = unitCapacity(prefix, used)
  if (c.full) return `All ${MAX_UNIT_SEQ.toLocaleString('en-IN')} codes for ${prefix} are used. Use a new prefix for new stock.`
  return `Next code: ${c.nextCode} · ${c.remaining.toLocaleString('en-IN')} of ${MAX_UNIT_SEQ.toLocaleString('en-IN')} codes left`
}

export function generateRangeText(prefix: string, firstSeq: number, lastSeq: number): string {
  if (lastSeq < firstSeq) return ''
  return firstSeq === lastSeq ? formatUnitCode(prefix, firstSeq) : `${formatUnitCode(prefix, firstSeq)} to ${formatUnitCode(prefix, lastSeq)}`
}

/** Validate the "how many" box of the generate dialog. */
export function validateGenerateCount(raw: string, used: number): { ok: true; count: number } | { ok: false; message: string } {
  const t = raw.trim()
  if (!/^\d+$/.test(t)) return { ok: false, message: 'Enter a whole number of units' }
  const n = Number(t)
  if (n < 1) return { ok: false, message: 'Enter at least 1' }
  const left = Math.max(0, MAX_UNIT_SEQ - used)
  if (left === 0) return { ok: false, message: `The ${MAX_UNIT_SEQ} code limit for this prefix is reached. Use a new prefix.` }
  if (n > left) return { ok: false, message: `Only ${left} code${left === 1 ? '' : 's'} left for this prefix (limit ${MAX_UNIT_SEQ}). Reduce the number.` }
  return { ok: true, count: n }
}

export type PrintSelection = { mode: 'all' } | { mode: 'unprinted' } | { mode: 'range'; from: number; to: number } | { mode: 'in_stock' }

/** Which unit codes a "Print unit labels" choice covers. Void units are never printed. */
export function selectUnitsForPrint(units: UnitRow[], sel: PrintSelection): string[] {
  const live = units.filter((u) => u.status !== 'void')
  let out: UnitRow[]
  switch (sel.mode) {
    case 'all': out = live; break
    case 'in_stock': out = live.filter((u) => u.status === 'in_stock'); break
    case 'unprinted': out = live.filter((u) => !u.printedAt); break
    case 'range': {
      const lo = Math.min(sel.from, sel.to), hi = Math.max(sel.from, sel.to)
      out = live.filter((u) => { const p = parseUnitCode(u.code); return !!p && p.seq >= lo && p.seq <= hi })
      break
    }
  }
  return out.map((u) => normalizeUnitCode(u.code))
}

/** Friendly message for a units backend error. */
export function unitErrorMessage(e: unknown): string {
  const err = e as { code?: string; message?: string; details?: { code?: string } }
  const code = err?.details?.code ?? err?.code
  if (code === 'UNIT_LIMIT_REACHED') return `The ${MAX_UNIT_SEQ} unit limit for this prefix is reached. A prefix holds at most ${MAX_UNIT_SEQ} codes (0001-${MAX_UNIT_SEQ}); give the product a new prefix to continue.`
  if (code === 'PREFIX_REQUIRED') return 'Set a prefix for this product first (Edit product > Track each unit).'
  return err?.message || 'Something went wrong'
}

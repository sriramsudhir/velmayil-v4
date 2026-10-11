/**
 * "Active list" rule for scanned unit codes (shared by POS bill, stock count, goods receiving, transfers):
 *   - code not in the list  -> add it
 *   - code already listed   -> do NOT add; tell the user it is a duplicate entry
 * Codes are compared normalised (trimmed, upper-cased) so 'spk-0001 ' equals 'SPK-0001'.
 */
export const normalizeUnitCode = (code: string): string => code.trim().toUpperCase()

export type ScanListResult = 'added' | 'duplicate'

export interface ScanList {
  has(code: string): boolean
  /** Adds the code unless already present. Pure outcome, no UI. */
  tryAdd(code: string): ScanListResult
  remove(code: string): void
  clear(): void
  codes(): string[]
  readonly size: number
}

export function createScanList(initial: string[] = []): ScanList {
  const set = new Set<string>(initial.map(normalizeUnitCode))
  return {
    has: (c) => set.has(normalizeUnitCode(c)),
    tryAdd(c) {
      const k = normalizeUnitCode(c)
      if (set.has(k)) return 'duplicate'
      set.add(k)
      return 'added'
    },
    remove: (c) => void set.delete(normalizeUnitCode(c)),
    clear: () => set.clear(),
    codes: () => [...set],
    get size() {
      return set.size
    }
  }
}

export const duplicateMessage = (code: string, listName = 'the list'): string =>
  `Duplicate entry: ${normalizeUnitCode(code)} is already in ${listName}. Not added again.`

/**
 * Unit code (label number) formats. Both resolve at every scan point:
 *  - label number (current): 10 digits = a 4-digit product prefix (1000-9999, never a leading 0) + a 6-digit running suffix
 *    (000001-999999), no dash: 2000000190, 2000000191 ...
 *  - legacy: PREFIX-NNNN (prefix 2-8 chars A-Z0-9, four-digit suffix 0001-9999). Codes already issued stay valid.
 * The format follows the PREFIX: a 4-digit numeric prefix issues label numbers, any other prefix issues PREFIX-NNNN.
 */
export const UNIT_CODE_RE = /^(?:([A-Z0-9]{2,8})-(\d{4})|([1-9]\d{3})(\d{6}))$/
/** Highest suffix of a legacy PREFIX-NNNN prefix. */
export const MAX_UNIT_SEQ = 9999
/** Highest suffix of a 10-digit label number prefix. */
export const MAX_LABEL_SEQ = 999_999
export const LABEL_PREFIX_RE = /^[1-9]\d{3}$/
export const LABEL_NUMBER_RE = /^[1-9]\d{9}$/

/** True for a prefix that issues 10-digit label numbers (4 digits, no leading zero). */
export const isLabelPrefix = (prefix: string): boolean => LABEL_PREFIX_RE.test(prefix)
/** How many codes a prefix can issue: 999,999 for a label-number prefix, 9,999 for a legacy one. */
export const maxSeqFor = (prefix: string): number => (isLabelPrefix(prefix) ? MAX_LABEL_SEQ : MAX_UNIT_SEQ)

export function formatUnitCode(prefix: string, seq: number): string {
  const p = prefix.toUpperCase()
  const max = maxSeqFor(p)
  if (!Number.isInteger(seq) || seq < 1 || seq > max) throw new RangeError(`Unit sequence must be 1..${max}`)
  return isLabelPrefix(p) ? `${p}${String(seq).padStart(6, '0')}` : `${p}-${String(seq).padStart(4, '0')}`
}

export function parseUnitCode(code: string): { prefix: string; seq: number } | null {
  const m = UNIT_CODE_RE.exec(normalizeUnitCode(code))
  if (!m) return null
  return m[1] !== undefined ? { prefix: m[1], seq: Number(m[2]) } : { prefix: m[3], seq: Number(m[4]) }
}

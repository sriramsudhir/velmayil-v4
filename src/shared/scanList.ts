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

/** Unit code format: PREFIX-NNNN (prefix 2-8 chars A-Z0-9, four-digit suffix 0001-9999). */
export const UNIT_CODE_RE = /^([A-Z0-9]{2,8})-(\d{4})$/
export const MAX_UNIT_SEQ = 9999

export function formatUnitCode(prefix: string, seq: number): string {
  if (!Number.isInteger(seq) || seq < 1 || seq > MAX_UNIT_SEQ) throw new RangeError(`Unit sequence must be 1..${MAX_UNIT_SEQ}`)
  return `${prefix.toUpperCase()}-${String(seq).padStart(4, '0')}`
}

export function parseUnitCode(code: string): { prefix: string; seq: number } | null {
  const m = UNIT_CODE_RE.exec(normalizeUnitCode(code))
  return m ? { prefix: m[1], seq: Number(m[2]) } : null
}

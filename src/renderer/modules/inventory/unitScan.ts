import { createScanList, duplicateMessage, normalizeUnitCode, parseUnitCode, type ScanList, type ScanListResult } from '@shared/scanList'

/**
 * The ACTIVE LIST for one inventory screen (count sheet, goods receiving, transfer list, label queue):
 * a scanned unit code that is not in the list is added; one that is already there is rejected with a duplicate warning.
 * Adds an owner map (code -> variantId) so removing a line also frees its codes.
 */
export interface UnitList {
  readonly name: string
  list: ScanList
  /** Claim a code for this list. 'duplicate' = already present (do not add it again). */
  claim(code: string): ScanListResult
  bind(code: string, variantId: number): void
  release(code: string): void
  releaseVariant(variantId: number): void
  codesOf(variantId: number): string[]
  duplicateText(code: string): string
  clear(): void
}

export function createUnitList(name: string, initial: string[] = []): UnitList {
  const list = createScanList(initial)
  const owner = new Map<string, number>()
  return {
    name,
    list,
    claim: (code) => list.tryAdd(code),
    bind: (code, variantId) => void owner.set(normalizeUnitCode(code), variantId),
    release(code) {
      list.remove(code)
      owner.delete(normalizeUnitCode(code))
    },
    releaseVariant(variantId) {
      for (const [c, v] of [...owner]) if (v === variantId) { owner.delete(c); list.remove(c) }
    },
    codesOf: (variantId) => [...owner].filter(([, v]) => v === variantId).map(([c]) => c),
    duplicateText: (code) => duplicateMessage(code, name),
    clear() {
      list.clear()
      owner.clear()
    }
  }
}

/** True when the scanned text has the unit-code shape PREFIX-NNNN. */
export const isUnitCodeText = (code: string): boolean => parseUnitCode(code) !== null

export const notFoundMessage = (code: string): string => `Unit code ${normalizeUnitCode(code)} was not found. Check the label or generate codes for this product first.`

const storeKey = (k: string) => `velmayil.unitlist.${k}`
/** Remember a list across screen reloads within this session (best effort). */
export function loadStoredCodes(key: string): string[] {
  try {
    const raw = sessionStorage.getItem(storeKey(key))
    const v = raw ? (JSON.parse(raw) as unknown) : []
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}
export function storeCodes(key: string, codes: string[]): void {
  try {
    sessionStorage.setItem(storeKey(key), JSON.stringify(codes))
  } catch {
    /* storage unavailable: the list just is not remembered */
  }
}

/**
 * Scan-code variants. A scanner (or its symbology settings) can deliver the same product under a different
 * spelling than the one stored in the catalog: UPC-A read as EAN-13 (and back), a stripped check digit, a GS1
 * "(01)" application identifier / GTIN-14 wrapper, ITF-14 padding, Code 39 "*" start/stop characters, UPC-E
 * (zero-suppressed), AIM "]E0" identifiers, control characters and so on. codeCandidates() returns the spellings
 * to try, best match first.
 * Pure: no database access (core/lookup.ts tries each against the catalog in order).
 */
import { SCAN_CONTROL_CHARS, stripScanDecorations } from '../../../shared/scanCode'

/** GS1 mod-10 check digit for a digit string WITHOUT its check digit (EAN-8/UPC-A/EAN-13/GTIN-14 all use it). */
export function gs1CheckDigit(body: string): string {
  let sum = 0
  for (let i = 0; i < body.length; i++) {
    const d = body.charCodeAt(body.length - 1 - i) - 48
    sum += i % 2 === 0 ? d * 3 : d
  }
  return String((10 - (sum % 10)) % 10)
}

export const hasValidCheckDigit = (code: string): boolean => /^\d{8,14}$/.test(code) && gs1CheckDigit(code.slice(0, -1)) === code.slice(-1)

/** Expand an 8-digit UPC-E (number system 0/1) to its 12-digit UPC-A, or null. */
export function upcEToUpcA(upce: string): string | null {
  if (!/^[01]\d{7}$/.test(upce)) return null
  const ns = upce[0]
  const d = upce.slice(1, 7)
  const chk = upce[7]
  let body: string
  switch (d[5]) {
    case '0': case '1': case '2': body = ns + d.slice(0, 2) + d[5] + '0000' + d.slice(2, 5); break
    case '3': body = ns + d.slice(0, 3) + '00000' + d.slice(3, 5); break
    case '4': body = ns + d.slice(0, 4) + '00000' + d[4]; break
    default: body = ns + d.slice(0, 5) + '0000' + d[5]
  }
  return body + chk
}

/** Expand a 6-digit UPC-E body (no number system / check digit) to the UPC-A candidates for number systems 0 and 1. */
export function upcE6ToUpcA(d: string): string[] {
  if (!/^\d{6}$/.test(d)) return []
  return ['0', '1'].map((ns) => {
    const a = upcEToUpcA(ns + d + '0') // check digit placeholder, replaced below
    return a ? a.slice(0, 11) + gs1CheckDigit(a.slice(0, 11)) : ''
  }).filter(Boolean)
}

const CTRL = SCAN_CONTROL_CHARS
export { stripScanDecorations }

/**
 * How sure a spelling is:
 *  0 = exactly what was scanned (control characters and outer spaces removed);
 *  1 = the same symbol written another way (reader decorations, AIM / GS1 wrappers, UPC-A <-> EAN-13 / GTIN-14 zero padding,
 *      UPC-E expansion, letter case);
 *  2 = a repair guess (check digit dropped or added, leading zeros lost in a spreadsheet, UPC-E without its framing digits).
 * core/lookup.ts takes the best tier that matches and refuses to choose when one tier matches two different items.
 */
export type CandidateTier = 0 | 1 | 2
export interface ScanCandidate { code: string; tier: CandidateTier }

/** Every spelling to try for a scanned text, best first, each with its tier. */
export function scanCandidates(input: string): ScanCandidate[] {
  const out: ScanCandidate[] = []
  const add = (s: string | null | undefined, tier: CandidateTier) => {
    if (!s || s.length === 0) return
    const have = out.find((c) => c.code === s)
    if (!have) out.push({ code: s, tier })
    else if (tier < have.tier) have.tier = tier
  }
  let raw = String(input ?? '').replace(CTRL, '').trim()
  if (!raw) return out
  add(raw, 0)

  // Code 39 start/stop asterisks, surrounding quotes some scanners add
  const unwrapped = raw.replace(/^[*'"]+|[*'"]+$/g, '').trim()
  if (unwrapped !== raw) { add(unwrapped, 1); raw = unwrapped }
  // AIM symbology identifier prefix ("]E0", "]C1", "]A0", "]d2" ... sent when the scanner's AIM option is on); may also sit inside the stars
  const aim = raw.match(/^\][A-Za-z][0-9A-Za-z]/)
  if (aim) {
    raw = raw.slice(3)
    add(raw, 1)
    const again = raw.replace(/^[*'"]+|[*'"]+$/g, '').trim()
    if (again !== raw) { add(again, 1); raw = again }
  }
  // GS1 human readable / element string: "(01)08901234567890(10)LOT" or "010890123456789017..." (FNC1 / GS separators were removed above)
  const gs1 = raw.match(/^\(?01\)?(\d{14})/)
  if (gs1 && (raw.startsWith('(') || raw.length > 16 || /^01\d{14}$/.test(raw))) {
    add(gs1[1], 1)
    raw = gs1[1]
  }
  // plain separators in numeric codes ("8901-2345 67890")
  const compact = raw.replace(/[\s-]+/g, '')
  if (compact !== raw && /^\d+$/.test(compact)) { add(compact, 1); raw = compact }

  if (/^\d+$/.test(raw)) {
    const digits = raw
    const n = digits.length
    // ITF-14 / GTIN-14 with a leading indicator or padding zero => the EAN-13 inside
    if (n === 14) {
      add(digits.slice(1), digits[0] === '0' ? 1 : 2)
      add(digits.slice(1, 13) + gs1CheckDigit(digits.slice(1, 13)), hasValidCheckDigit(digits) ? 1 : 2) // a real GTIN-14 indicator digit changes the check digit: the EAN-13 inside it
      if (digits[0] === '0' && digits[1] === '0') add(digits.slice(2), 1) // UPC-A inside
    }
    // Leading-zero padding (readers pad EAN-8 / UPC-A to 13 or 14 digits): the original shorter forms
    const noZeros = digits.replace(/^0+/, '')
    for (const w of [8, 12, 13]) if (noZeros.length > 0 && noZeros.length <= w && n > w) add(digits.slice(n - w), n >= 12 && n <= 14 ? 1 : 2)
    // UPC-A (12) <-> EAN-13 (leading 0)
    if (n === 12) { add('0' + digits, 1); add(digits.slice(0, 11), 2) }
    if (n === 13 && digits[0] === '0') add(digits.slice(1), 1)
    // UPC-E (8, starts 0/1) -> UPC-A -> EAN-13 ; EAN-8 as GTIN
    if (n === 8) {
      const a = upcEToUpcA(digits)
      if (a) { add(a, 1); add('0' + a, 1) }
      add('00000' + digits, 1)
    }
    // check digit stripped by the scanner (EAN-13 without check = 12 digits, UPC-A without = 11, EAN-8 without = 7)
    if (n === 12) add(digits + gs1CheckDigit(digits), 2)
    if (n === 11) { add(digits + gs1CheckDigit(digits), 2); add('0' + digits + gs1CheckDigit('0' + digits), 2) }
    if (n === 7) add(digits + gs1CheckDigit(digits), 2)
    // UPC-E with the number system digit and/or the check digit dropped (readers' "convert to UPC-A" / "no check digit" options)
    if (n === 6) for (const a of upcE6ToUpcA(digits)) { add(a, 2); add('0' + a, 2) }
    if (n === 7 && /^[01]/.test(digits)) {
      const a = upcEToUpcA(digits + '0')
      if (a) { const f = a.slice(0, 11) + gs1CheckDigit(a.slice(0, 11)); add(f, 2); add('0' + f, 2) }
    }
    if (n === 13) add(digits.slice(0, 12), 2) // check digit sent but catalog stores it stripped (rare)
    // padded-with-zeros / leading-zero-stripped by the scanner or a spreadsheet (EAN-13 starting with 0 loses it)
    if (noZeros && noZeros !== digits) add(noZeros, 2)
    if (n < 13 && n >= 8) add(digits.padStart(13, '0'), 2)
    if (n < 12 && n >= 6) add(digits.padStart(12, '0'), 2)
  } else {
    // Code 39 / SKU: scanners differ on letter case; SKU lookup is case-insensitive but barcode column is exact
    add(raw.toUpperCase(), 1)
    add(raw.toLowerCase(), 1)
  }
  return out.slice(0, 16)
}

/** The spellings only, best first (see scanCandidates). */
export const codeCandidates = (input: string): string[] => scanCandidates(input).map((c) => c.code)

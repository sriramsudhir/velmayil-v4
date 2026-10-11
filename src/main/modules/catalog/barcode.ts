/** Pure barcode helpers (no DB). EAN-13 / EAN-8 / UPC-A check digits and Code128 free-text validation. */

export type BarcodeFormat = 'EAN13' | 'EAN8' | 'UPCA' | 'CODE128'

/** GTIN check digit for a payload (digits without the check digit): weights 3,1,3,1... from the right. */
export function gtinCheckDigit(payload: string): number {
  if (!/^\d+$/.test(payload)) throw new Error('Payload must be digits')
  let sum = 0
  for (let i = payload.length - 1, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) sum += Number(payload[i]) * w
  return (10 - (sum % 10)) % 10
}

export const withCheckDigit = (payload: string): string => payload + gtinCheckDigit(payload)

export function isValidGtin(code: string, length: 8 | 12 | 13): boolean {
  return code.length === length && /^\d+$/.test(code) && gtinCheckDigit(code.slice(0, -1)) === Number(code[code.length - 1])
}

/** Internal EAN-13: `prefix` (3 digits, 200-299 = GS1 restricted/in-store range) + 9-digit sequence + check digit. */
export function generateEan13(seq: number, prefix = '200'): string {
  if (!/^2\d\d$/.test(prefix)) throw new Error('Internal EAN-13 prefix must be 200-299')
  if (!Number.isInteger(seq) || seq < 0 || seq > 999_999_999) throw new Error('Barcode sequence out of range')
  return withCheckDigit(prefix + String(seq).padStart(9, '0'))
}

export interface BarcodeCheck {
  valid: boolean
  format?: BarcodeFormat
  error?: string
  /** Normalized (trimmed) code */
  code: string
}

/**
 * Numeric codes of length 8/12/13 must carry a correct check digit (EAN-8 / UPC-A / EAN-13).
 * Anything else is treated as Code128 free text: printable ASCII, 1-40 chars, no leading/trailing space.
 */
export function validateBarcode(input: string): BarcodeCheck {
  const code = (input ?? '').trim()
  if (!code) return { valid: false, code, error: 'Barcode is empty' }
  if (/^\d+$/.test(code)) {
    const len = code.length
    if (len === 13 || len === 8 || len === 12) {
      const fmt: BarcodeFormat = len === 13 ? 'EAN13' : len === 8 ? 'EAN8' : 'UPCA'
      if (!isValidGtin(code, len)) {
        const expected = gtinCheckDigit(code.slice(0, -1))
        return { valid: false, code, format: fmt, error: `Invalid ${fmt} check digit (expected ${expected}, got ${code[len - 1]})` }
      }
      return { valid: true, code, format: fmt }
    }
  }
  // a spreadsheet turned a long number into "8.90123E+12": the digits are gone, so this can never scan
  if (/^\d\.\d+e\+?\d+$/i.test(code) || /^\d+e\+\d+$/i.test(code))
    return { valid: false, code, error: 'Barcode looks like a number a spreadsheet shortened (for example 8.90123E+12). Format the barcode column as Text and enter the full number.' }
  if (code.length > 40) return { valid: false, code, error: 'Barcode is longer than 40 characters' }
  if (!/^[\x20-\x7E]+$/.test(code)) return { valid: false, code, error: 'Barcode may contain only printable ASCII characters (Code128)' }
  return { valid: true, code, format: 'CODE128' }
}

// ------------------------------------------------------------------ internal barcode numbering
/**
 * How generated product barcodes are numbered (settings catalog.barcode_mode / _prefix / _width / _seq):
 *  - 'sequence' (default): `<prefix><running number, zero-padded to width>` - the prefix never changes, only the suffix counts
 *    up by one (VM000001, VM000002 ...). No check digit. Printed/scanned as Code 128.
 *  - 'ean13': the classic internal EAN-13 (prefix 200-299 + 9-digit number + GTIN check digit), see generateEan13.
 */
export type BarcodeMode = 'sequence' | 'ean13'
export interface BarcodeNumbering {
  mode: BarcodeMode
  /** sequence: 1-8 chars A-Z/0-9 (upper-case); ean13: 200-299 */
  prefix: string
  /** digits of the running number (sequence mode: 4-10; EAN-13 always uses 9) */
  width: number
}
export const BARCODE_NUMBERING_DEFAULT: BarcodeNumbering = { mode: 'sequence', prefix: '200', width: 6 }
export const SEQ_WIDTH_MIN = 4
export const SEQ_WIDTH_MAX = 10
export const EAN13_SEQ_WIDTH = 9

/**
 * All-digit lengths a reader (and validateBarcode / pos/codes.ts) understands as a GTIN or as a GTIN with its check digit
 * dropped. A plain running number of such a length would fail the check-digit rule or could be mistaken for another product's
 * retail code, so these prefix/width combinations are refused.
 */
const GTIN_LIKE: Record<number, string> = { 8: 'EAN-8', 11: 'UPC-A without its check digit', 12: 'UPC-A', 13: 'EAN-13', 14: 'GTIN-14 / ITF-14' }

export type NumberingCheck =
  | { ok: true; cfg: BarcodeNumbering }
  | { ok: false; field: 'mode' | 'prefix' | 'width'; error: string }

/** Validate (and normalise: trimmed, upper-case prefix) a numbering configuration. Pure. */
export function checkNumbering(raw: { mode?: unknown; prefix?: unknown; width?: unknown }): NumberingCheck {
  const mode = String(raw.mode ?? '').trim().toLowerCase()
  if (mode !== 'sequence' && mode !== 'ean13') return { ok: false, field: 'mode', error: 'Barcode numbering must be "sequence" (prefix + running number) or "ean13"' }
  const prefix = String(raw.prefix ?? '').trim().toUpperCase()
  const width = typeof raw.width === 'number' ? raw.width : /^\d+$/.test(String(raw.width ?? '').trim()) ? Number(String(raw.width).trim()) : NaN
  if (mode === 'ean13') {
    if (!/^2\d\d$/.test(prefix)) return { ok: false, field: 'prefix', error: 'Internal barcode prefix must be between 200 and 299' }
    // the width setting is not used by EAN-13 (always 9 digits); keep whatever is stored when it is usable
    return { ok: true, cfg: { mode, prefix, width: Number.isInteger(width) && width >= SEQ_WIDTH_MIN && width <= SEQ_WIDTH_MAX ? width : BARCODE_NUMBERING_DEFAULT.width } }
  }
  if (!prefix) return { ok: false, field: 'prefix', error: 'Enter a barcode prefix (1-8 letters or digits), for example VM' }
  if (!/^[A-Z0-9]{1,8}$/.test(prefix)) return { ok: false, field: 'prefix', error: 'Barcode prefix must be 1-8 letters or digits (A-Z, 0-9), without spaces or symbols' }
  if (!Number.isInteger(width) || width < SEQ_WIDTH_MIN || width > SEQ_WIDTH_MAX)
    return { ok: false, field: 'width', error: `Number of digits must be between ${SEQ_WIDTH_MIN} and ${SEQ_WIDTH_MAX}` }
  if (/^\d+$/.test(prefix)) {
    if (prefix[0] === '0')
      return { ok: false, field: 'prefix', error: 'A prefix made only of digits cannot start with 0 (spreadsheets and some readers drop leading zeros). Start it with another digit or a letter, for example VM.' }
    const total = prefix.length + width
    const like = GTIN_LIKE[total]
    if (like)
      return {
        ok: false, field: 'width',
        error: `Prefix ${prefix} with ${width} digits gives ${total}-digit numbers, which barcode readers treat as ${like}. Choose a different number of digits, or put a letter in the prefix (for example VM).`
      }
  }
  return { ok: true, cfg: { mode, prefix, width } }
}

/** Highest running number a configuration can express. */
export const maxSequenceNumber = (cfg: BarcodeNumbering): number => 10 ** (cfg.mode === 'ean13' ? EAN13_SEQ_WIDTH : cfg.width) - 1

/** The barcode for running number `n`, or null when `n` does not fit (the suffix never grows past its width). */
export function formatInternalBarcode(cfg: BarcodeNumbering, n: number): string | null {
  if (!Number.isInteger(n) || n < 1 || n > maxSequenceNumber(cfg)) return null
  return cfg.mode === 'ean13' ? generateEan13(n, cfg.prefix) : cfg.prefix + String(n).padStart(cfg.width, '0')
}

/** The running number of `code` when it has exactly the shape this configuration generates, else null. */
export function parseInternalBarcode(cfg: BarcodeNumbering, code: string): number | null {
  if (cfg.mode === 'ean13') {
    if (code.length !== 13 || !code.startsWith(cfg.prefix) || !isValidGtin(code, 13)) return null
    return Number(code.slice(3, 12)) || null
  }
  if (code.length !== cfg.prefix.length + cfg.width || !code.startsWith(cfg.prefix)) return null
  const tail = code.slice(cfg.prefix.length)
  return /^\d+$/.test(tail) ? Number(tail) || null : null
}

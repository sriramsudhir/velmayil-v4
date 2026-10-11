/**
 * What a barcode reader (or the keyboard path) may wrap around a code, removed. Shared by the lookup (main) and by every field
 * that accepts a scan (renderer), so a ']E0' prefix or Code 39 stars can never be saved into a product barcode.
 */

// Built from escaped text on purpose: U+2028/2029 and the zero-width characters are invisible (and a line break inside a regex literal).
// C0 + DEL + C1 control characters (CR LF Tab NUL GS/FNC1 STX ETX ...), zero-width characters, line/paragraph separators, BOM.
export const SCAN_CONTROL_CHARS = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028\\u2029\\ufeff]', 'g')

/**
 * Gentle version for TEXT SEARCH boxes: only strips what is unmistakably reader framing (CR/LF/Tab/STX/ETX/GS at the ends, an AIM
 * "]E0" prefix, Code 39 stars around one word). Names that legitimately contain quotes, stars or odd characters are left alone.
 */
export function stripScanFraming(input: string): string {
  let t = String(input ?? '').replace(/^[\r\n\t\u0002\u0003\u0004\u001d]+|[\r\n\t\u0002\u0003\u0004\u001d]+$/g, '')
  if (/^\][A-Za-z][0-9A-Za-z]\S/.test(t)) t = t.slice(3)
  if (/^\*[^\s*]+\*$/.test(t)) t = t.slice(1, -1)
  return t
}

/** Remove control/zero-width characters, Code 39 start/stop stars, quotes and an AIM symbology identifier ("]E0", "]C1", "]d2" ...). */
export function stripScanDecorations(input: string): string {
  let raw = String(input ?? '').replace(SCAN_CONTROL_CHARS, '').trim()
  raw = raw.replace(/^[*'"]+|[*'"]+$/g, '').trim()
  if (/^\][A-Za-z][0-9A-Za-z]/.test(raw)) raw = raw.slice(3)
  return raw
}

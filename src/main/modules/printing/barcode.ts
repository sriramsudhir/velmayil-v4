import { createRequire } from 'node:module'

/** Barcode / QR rendering as inline SVG strings (pure; no DOM, no canvas). */

// Loaded on first use (keeps ~75 ms of require() out of app startup). Both are externalized deps, resolved at runtime.
const nodeRequire = createRequire(__filename)
let jsBarcodeMod: unknown
let qrMod: { create: (t: string, o: object) => { modules: { size: number; data: unknown } } } | undefined
function loadJsBarcode(): unknown {
  if (!jsBarcodeMod) {
    const m = nodeRequire('jsbarcode')
    jsBarcodeMod = m && m.default ? m.default : m
  }
  return jsBarcodeMod
}
function loadQr() {
  if (!qrMod) {
    const m = nodeRequire('qrcode')
    qrMod = m && m.create ? m : m.default
  }
  return qrMod!
}

interface Encoding { data: string; text?: string }

function encode(value: string, format: string): Encoding[] {
  const holder: { encodings?: Encoding[] } = {}
  ;(loadJsBarcode() as unknown as (o: object, v: string, opts: object) => void)(holder, value, { format, valid: () => {}, displayValue: false, margin: 0 })
  if (!holder.encodings?.length) throw new Error('barcode encode failed')
  return holder.encodings
}

// ---------------------------------------------------------------------------- printer dots
/**
 * Printer resolution (printer profile calibration `dpi`). A thermal head prints whole dots only, so every bar must be a whole
 * number of dots wide: a module of e.g. 0.38 mm (3.04 dots) is rounded bar by bar by the driver and the bars come out uneven,
 * which is the usual reason a thermal barcode does not scan.
 * One dot in CSS units is 25.4 / dpi mm: Chromium maps one CSS inch to `dpi` device dots (the driver reports 203, the head
 * really has 8 dots/mm = 203.2 dpi; what matters is that N dots in CSS land on exactly N device dots).
 */
export type PrinterDpi = 203 | 300 | 600
export const DEFAULT_DPI: PrinterDpi = 203
export const PRINTER_DPIS: readonly PrinterDpi[] = [203, 300, 600]
export const parseDpi = (v: unknown): PrinterDpi => (v === 300 || v === 600 ? v : DEFAULT_DPI)
export const dotMm = (dpi: number): number => 25.4 / dpi

/** Largest module (X dimension): bigger bars only waste label width. */
export const MAX_MODULE_MM = 0.5
/** Smallest module that is worth printing: 1 dot at 203 dpi (5 mil). Below this ordinary shop scanners cannot resolve the bars. */
export const MIN_MODULE_MM = 0.125
/** Modules narrower than this (2 dots at 203 dpi) scan only with a good reader and a clean print: reported as a warning. */
export const GOOD_MODULE_MM = 0.25

const r4 = (n: number) => Math.round(n * 10000) / 10000
const EPS = 1e-6

export const minModuleDots = (dpi: number): number => Math.max(1, Math.ceil(MIN_MODULE_MM / dotMm(dpi) - 0.01))
export const maxModuleDots = (dpi: number): number => Math.max(minModuleDots(dpi), Math.round(MAX_MODULE_MM / dotMm(dpi)))

export interface ModuleFit {
  /** printer dots per module (0 when the symbol does not fit) */
  dots: number
  /** module width / symbol width in CSS mm (already divided by the calibration scale, so they PRINT at whole dots) */
  moduleMm: number
  widthMm: number
  /** distance from the left edge of the available width to the symbol, so that the symbol starts on a dot boundary */
  leftMm: number
  fits: boolean
  /** fits, but the module is below GOOD_MODULE_MM */
  narrow: boolean
}

/**
 * Whole-dot module width for a symbol of `totalModules` (bars + quiet zones) inside `availMm`: the largest number of dots
 * that fits, capped at MAX_MODULE_MM, never below MIN_MODULE_MM. `scale` is the printer profile's scale (1 = 100 %): the page is
 * zoomed by it when printing, so CSS sizes are divided by it. `originMm` is where the available width starts, measured from the
 * left edge of the page; the symbol is centred and then moved to the nearest dot boundary.
 */
export function fitModules(totalModules: number, availMm: number, dpi: number = DEFAULT_DPI, o: { scale?: number; originMm?: number } = {}): ModuleFit {
  const scale = o.scale && o.scale > 0 ? o.scale : 1
  const dot = dotMm(dpi) / scale // one printed dot in CSS mm
  const availDots = Math.floor(availMm / dot + EPS)
  const dots = Math.min(maxModuleDots(dpi), Math.floor(availDots / Math.max(1, totalModules)))
  if (totalModules <= 0 || dots < minModuleDots(dpi)) return { dots: 0, moduleMm: 0, widthMm: 0, leftMm: 0, fits: false, narrow: false }
  const widthDots = dots * totalModules
  const origin = o.originMm ?? 0
  let leftDots = Math.round((origin + (availMm - widthDots * dot) / 2) / dot) - origin / dot
  if (leftDots < -EPS) leftDots += 1
  if (leftDots + widthDots > availMm / dot + EPS) leftDots -= 1
  return {
    dots,
    moduleMm: r4(dots * dot),
    widthMm: r4(widthDots * dot),
    leftMm: Math.max(0, r4(leftDots * dot)),
    fits: true,
    narrow: dots * dotMm(dpi) < GOOD_MODULE_MM - 0.005
  }
}

// ---------------------------------------------------------------------------- symbology
export type BarcodeFormat = 'CODE128' | 'EAN13' | 'EAN8' | 'UPC'

/** GS1 mod-10 check digit test for an all-digit EAN-8 / UPC-A / EAN-13 string (last digit = check digit). */
export function gtinCheckOk(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false
  let sum = 0
  for (let i = digits.length - 2, w = 3; i >= 0; i--, w = 4 - w) sum += (digits.charCodeAt(i) - 48) * w
  return (10 - (sum % 10)) % 10 === digits.charCodeAt(digits.length - 1) - 48
}

/**
 * Symbology for a code. Retail symbols are used ONLY when the value is a complete number with a correct check digit
 * (13 digits -> EAN-13, 12 -> UPC-A, 8 -> EAN-8); everything else is Code 128, which encodes the value exactly as given:
 * shop-made numbers without a check digit (`200000123`), letters (`VM000123`), unit codes (`SPK-0001`) and a 13-digit number
 * whose last digit is not a valid check digit. jsbarcode's CODE128 is the automatic variant: runs of digits use code set C
 * (two digits per symbol character), so numeric codes stay compact.
 * 'EAN13' as the preferred type means "EAN-13 when possible"; 'CODE128' forces Code 128.
 */
export function pickFormat(value: string, preferred: 'auto' | 'CODE128' | 'EAN13' = 'auto'): BarcodeFormat {
  if (preferred === 'CODE128') return 'CODE128'
  if (/^\d{13}$/.test(value)) return gtinCheckOk(value) ? 'EAN13' : 'CODE128'
  if (preferred !== 'auto') return 'CODE128'
  if (/^\d{12}$/.test(value) && gtinCheckOk(value)) return 'UPC'
  if (/^\d{8}$/.test(value) && gtinCheckOk(value)) return 'EAN8'
  return 'CODE128'
}

/** Quiet zones in modules [left, right]: what we print by default and the minimum the symbology allows. */
const QUIET: Record<BarcodeFormat, { normal: [number, number]; min: [number, number] }> = {
  EAN13: { normal: [11, 11], min: [11, 7] },
  UPC: { normal: [10, 10], min: [9, 9] },
  EAN8: { normal: [10, 10], min: [7, 7] },
  CODE128: { normal: [10, 10], min: [10, 10] }
}

export type BarcodeProblem = 'too_long' | 'narrow' | 'not_encodable'
export interface BarcodeSymbol {
  /** '' when nothing can be drawn (empty value, `too_long`, `not_encodable`) */
  svg: string
  /** the exact value that is encoded (trimmed); the human-readable line must show this string */
  value: string
  format: BarcodeFormat
  /** bar/space modules without quiet zones */
  modules: number
  quiet: [number, number]
  /** printer dots per module (0 = fills its container, no maxWidthMm given) */
  dots: number
  moduleMm: number
  widthMm: number
  problem?: BarcodeProblem
}
export interface BarcodeOpts {
  heightMm: number
  format?: 'auto' | 'CODE128' | 'EAN13'
  /** width available for bars + quiet zones (mm). Without it the symbol stretches to its container (screen use only). */
  maxWidthMm?: number
  dpi?: number
  /** printer profile scale, 1 = 100 % */
  scale?: number
  /** left edge of the available width, in mm from the left edge of the page (for dot alignment) */
  originMm?: number
}

/**
 * Encode + size a barcode. With `maxWidthMm` the module is a whole number of printer dots (see fitModules), the symbol starts
 * on a dot boundary and is NEVER stretched. If it does not fit at the normal quiet zones it is tried at the minimum ones; if
 * even the smallest printable module does not fit, no bars are drawn at all (`problem: 'too_long'`): a clipped or squeezed
 * barcode cannot be scanned and only looks like it works.
 */
export function barcodeSymbol(value: string, opts: BarcodeOpts = { heightMm: 9 }): BarcodeSymbol {
  const v = value.trim()
  const format = pickFormat(v, opts.format)
  const none = (problem?: BarcodeProblem): BarcodeSymbol => ({ svg: '', value: v, format, modules: 0, quiet: [0, 0], dots: 0, moduleMm: 0, widthMm: 0, problem })
  if (!v) return none()
  let encs: Encoding[]
  try {
    encs = encode(v, format)
  } catch {
    return none('not_encodable')
  }
  const bits = encs.map((e) => e.data).join('')
  const dpi = opts.dpi ?? DEFAULT_DPI
  let quiet = QUIET[format].normal
  let fit: ModuleFit | null = null
  if (opts.maxWidthMm && opts.maxWidthMm > 0) {
    const at = (q: [number, number]) => fitModules(bits.length + q[0] + q[1], opts.maxWidthMm!, dpi, { scale: opts.scale, originMm: opts.originMm })
    fit = at(quiet)
    // smaller quiet zones (still within the standard) when that is what makes the symbol fit, or buys a wider module
    const tight = at(QUIET[format].min)
    if (tight.dots > fit.dots) {
      fit = tight
      quiet = QUIET[format].min
    }
    if (!fit.fits) return { ...none('too_long'), modules: bits.length, quiet }
  }
  const total = bits.length + quiet[0] + quiet[1]
  let rects = ''
  for (let i = 0; i < bits.length; ) {
    if (bits[i] === '1') {
      let j = i
      while (j < bits.length && bits[j] === '1') j++
      rects += `<rect x="${i + quiet[0]}" y="0" width="${j - i}" height="100"/>`
      i = j
    } else i++
  }
  // data-fit lets the print step re-snap the symbol to the dots of the printer that actually prints it (snapBarcodes)
  const size = fit ? `width:${fit.widthMm}mm;margin-left:${fit.leftMm}mm` : 'width:100%'
  const data = fit ? ` data-fit="${total},${r4(opts.maxWidthMm!)},${r4(opts.originMm ?? 0)}"` : ''
  const svg = `<svg class="barcode" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} 100" preserveAspectRatio="none" shape-rendering="crispEdges" role="img" aria-label="barcode ${esc(v)}"${data} style="${size};height:${opts.heightMm}mm;display:block"><rect width="${total}" height="100" fill="#fff"/><g fill="#000">${rects}</g></svg>`
  return { svg, value: v, format, modules: bits.length, quiet, dots: fit?.dots ?? 0, moduleMm: fit?.moduleMm ?? 0, widthMm: fit?.widthMm ?? 0, problem: fit?.narrow ? 'narrow' : undefined }
}

/** Bars as SVG (height in mm). Returns '' for an empty value or a symbol that cannot be printed (see barcodeSymbol). */
export function barcodeSvg(value: string, opts: BarcodeOpts = { heightMm: 9 }): string {
  return barcodeSymbol(value, opts).svg
}

/**
 * Re-snap every sized barcode in a rendered document to the printer that prints it (resolution + scale of the printer profile).
 * The label was rendered for the default label printer; a retry on another printer, or a profile whose scale is not 100 %,
 * must still give whole-dot bars. `offsetXmm` is the profile's horizontal offset (it moves the page, so it moves the dot the
 * symbol starts on). A symbol that no longer fits keeps the smallest printable module.
 */
export function snapBarcodes(html: string, dpi: number = DEFAULT_DPI, scale = 1, offsetXmm = 0): string {
  if (!html.includes('data-fit="')) return html
  return html.replace(/(<svg class="barcode"[^>]*? data-fit="(\d+),([\d.]+),([\d.]+)"[^>]*? style=")width:[\d.]+mm;margin-left:[\d.]+mm/g, (_m, head: string, total: string, avail: string, origin: string) => {
    const n = Number(total)
    let fit = fitModules(n, Number(avail), dpi, { scale, originMm: Number(origin) + offsetXmm })
    if (!fit.fits) {
      const dot = dotMm(dpi) / (scale > 0 ? scale : 1)
      fit = { ...fit, widthMm: r4(n * minModuleDots(dpi) * dot), leftMm: 0 }
    }
    return `${head}width:${fit.widthMm}mm;margin-left:${fit.leftMm}mm`
  })
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

/** QR quiet zone in modules (ISO 18004 asks for 4). */
const QR_QUIET = 4

/**
 * QR code as inline SVG, at most `sizeMm` square. Each module is a whole number of printer dots (at least 2) so the cells
 * print square and even; the symbol is therefore a little smaller than `sizeMm` rather than exactly that size.
 */
export function qrSvg(text: string, sizeMm: number, dpi: number = DEFAULT_DPI): string {
  const qr = loadQr().create(text, { errorCorrectionLevel: 'M' })
  const n = qr.modules.size
  const data = qr.modules.data as unknown as ArrayLike<number>
  let path = ''
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; ) {
      if (data[y * n + x]) {
        let run = 1
        while (x + run < n && data[y * n + x + run]) run++
        path += `M${x + QR_QUIET} ${y + QR_QUIET}h${run}v1h-${run}z`
        x += run
      } else x++
    }
  }
  const total = n + QR_QUIET * 2
  const dots = Math.max(2, Math.floor(sizeMm / dotMm(dpi) / total + EPS))
  const side = r4(total * dots * dotMm(dpi))
  return `<svg class="qr" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges" role="img" aria-label="QR code" style="width:${side}mm;height:${side}mm"><rect width="${total}" height="${total}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`
}

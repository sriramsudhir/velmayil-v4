import { formatINR } from '@shared/money'
import type { InvoiceDocExt } from './context'
import { fmtDate, fmtTime, methodLabel } from './context'
import type { TemplateConfig } from './config'
import type { BusinessProfile } from '@shared/types'

/**
 * ESC/POS byte generator for 58 / 80 mm thermal receipt printers ("Raw" mode, opt-in).
 * Pure: InvoiceDoc in, Buffer out. Text is ASCII only (printers differ in code pages): the rupee sign becomes "Rs.",
 * accents are stripped and scripts such as Tamil cannot be printed in this mode (use the normal Windows-driver mode
 * for those). Dots: 203 dpi = 8 dots/mm; Font A is 12 dots wide.
 */

export const ESC = 0x1b
export const GS = 0x1d
const DOTS_PER_MM = 8
const FONT_A_DOTS = 12

export type Align = 'left' | 'center' | 'right'
export type CutMode = 'none' | 'partial' | 'full'

export interface RasterImage { widthBytes: number; height: number; data: Buffer }

/** Replace characters a thermal printer cannot print (keeps ASCII; rupee sign -> "Rs."). */
export function asciiSafe(s: string): string {
  return s
    .replace(/₹/g, 'Rs.')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\x20-\x7e]/g, '?')
}

export class EscPos {
  private chunks: Buffer[] = []
  private bytes(...b: number[]): this {
    this.chunks.push(Buffer.from(b))
    return this
  }
  /** ESC @ : reset the printer */
  init(): this {
    return this.bytes(ESC, 0x40)
  }
  /** raw printable text (no newline) */
  text(s: string): this {
    this.chunks.push(Buffer.from(asciiSafe(s), 'latin1'))
    return this
  }
  line(s = ''): this {
    return this.text(s).bytes(0x0a)
  }
  /** ESC d n : print and feed n lines */
  feed(n: number): this {
    return this.bytes(ESC, 0x64, Math.max(0, Math.min(255, Math.floor(n))))
  }
  /** ESC a n */
  align(a: Align): this {
    return this.bytes(ESC, 0x61, a === 'left' ? 0 : a === 'center' ? 1 : 2)
  }
  /** ESC E n */
  bold(on: boolean): this {
    return this.bytes(ESC, 0x45, on ? 1 : 0)
  }
  /** ESC G n : double-strike. On thermal heads it prints like emphasized text; every ESC/POS printer understands it. */
  doubleStrike(on: boolean): this {
    return this.bytes(ESC, 0x47, on ? 1 : 0)
  }
  /** GS ( K pL pH fn m, function 49: print density. m = -6..+6 steps around the printer's own setting (sent as 250..255, 0..6). */
  density(step: number): this {
    const m = Math.max(-6, Math.min(6, Math.round(step)))
    return this.bytes(GS, 0x28, 0x4b, 0x02, 0x00, 0x31, m < 0 ? 256 + m : m)
  }
  /** ESC - n */
  underline(on: boolean): this {
    return this.bytes(ESC, 0x2d, on ? 1 : 0)
  }
  /** GS ! n : character magnification 1..8 each way */
  size(w: number, h: number): this {
    const cw = Math.max(1, Math.min(8, w)) - 1
    const ch = Math.max(1, Math.min(8, h)) - 1
    return this.bytes(GS, 0x21, (cw << 4) | ch)
  }
  /** feed then cut (GS V 0 / 1: supported by practically every cutter) */
  cut(mode: CutMode = 'partial', feedLines = 4): this {
    if (mode === 'none') return this.feed(feedLines)
    return this.feed(feedLines).bytes(GS, 0x56, mode === 'full' ? 0 : 1)
  }
  /** ESC p m t1 t2 : cash drawer kick. pin 2 (m=0) is the usual RJ11 wiring; times in 2 ms units. */
  drawerKick(pin: 2 | 5 = 2, onMs = 50, offMs = 500): this {
    return this.bytes(ESC, 0x70, pin === 2 ? 0 : 1, Math.min(255, Math.round(onMs / 2)), Math.min(255, Math.round(offMs / 2)))
  }
  /** GS v 0 : print a 1-bit raster image (bit 1 = black) */
  raster(img: RasterImage): this {
    const { widthBytes, height, data } = img
    this.bytes(GS, 0x76, 0x30, 0x00, widthBytes & 255, widthBytes >> 8, height & 255, height >> 8)
    this.chunks.push(data)
    return this
  }
  rule(width: number, ch = '-'): this {
    return this.line(ch.repeat(width))
  }
  build(): Buffer {
    return Buffer.concat(this.chunks)
  }
}

// ------------------------------------------------------------------ text helpers
export function wrap(s: string, width: number): string[] {
  const out: string[] = []
  for (const para of asciiSafe(s).split(/\r?\n/)) {
    let cur = ''
    for (const word of para.split(/\s+/).filter(Boolean)) {
      let w = word
      while (w.length > width) {
        if (cur) { out.push(cur); cur = '' }
        out.push(w.slice(0, width))
        w = w.slice(width)
      }
      if (!cur) cur = w
      else if (cur.length + 1 + w.length <= width) cur += ' ' + w
      else { out.push(cur); cur = w }
    }
    out.push(cur)
  }
  while (out.length > 1 && out[out.length - 1] === '') out.pop()
  return out
}
/** left text ... right text on one line of `width` columns (left is truncated, never the right value) */
export function kv(left: string, right: string, width: number): string {
  const l = asciiSafe(left)
  const r = asciiSafe(right)
  const room = width - r.length - 1
  return (l.length > room ? l.slice(0, Math.max(0, room)) : l.padEnd(Math.max(0, room))) + ' ' + r
}

/** Columns that fit a printable width: Font A is 12 dots at 203 dpi. */
export function columnsFor(printableMm: number): number {
  return Math.max(20, Math.min(64, Math.floor((printableMm * DOTS_PER_MM) / FONT_A_DOTS)))
}
/** Printable width defaults (typical): 58 mm paper -> 48 mm, 80 mm paper -> 72 mm (some printers 76 mm: set it per printer). */
export const defaultPrintableMm = (paper: 58 | 80): number => (paper === 58 ? 48 : 72)

// ------------------------------------------------------------------ print darkness (printer profile, 1..9, 5 = normal)
/**
 * What "Print darkness" means on the raw path. Level 5 adds NO bytes, so a normal receipt is byte-identical to what was
 * always sent. Choices, in order of how widely they work:
 *  1. Logo raster threshold (always): 160 at level 5, +/-15 per level. A higher threshold turns more grey pixels black.
 *     Done here in software, so it works on every printer.
 *  2. Double-strike `ESC G 1` at levels 7-9: part of the original ESC/POS set and understood by every compatible printer;
 *     body text is then printed like emphasized text. There is no portable way to make text LIGHTER than normal.
 *  3. Density `GS ( K` function 49 (Epson TM-T20 / T82 / T88 family and firmware that copies it): the only standard command
 *     that changes the head energy itself, and the only one that helps a faint print. Printers that implement the `GS (`
 *     family (every model that can print a QR code with `GS ( k`) skip an unknown function by its length bytes. A very
 *     basic clone without `GS (` support could print a stray character at the top of the receipt instead; for those the
 *     profile option `densityCommand: false` leaves the command out. Vendor-private heat commands (`DC2 #`, `ESC 7`) are not
 *     used: they mean other things on other printers.
 * The printer's own density (DIP switch / utility / driver) still decides the baseline.
 */
export const RASTER_THRESHOLD_NORMAL = 160
const lvl = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) ? Math.min(9, Math.max(1, Math.round(n))) : 5)
export const rasterThresholdFor = (level: unknown): number => RASTER_THRESHOLD_NORMAL + (lvl(level) - 5) * 15
const DENSITY_STEPS = [-6, -4, -3, -1, 0, 1, 3, 4, 6]
/** GS ( K density step for a darkness level (0 at level 5 = command not sent). */
export const densityStepFor = (level: unknown): number => DENSITY_STEPS[lvl(level) - 1]
export const doubleStrikeFor = (level: unknown): boolean => lvl(level) >= 7

function applyDarkness(e: EscPos, o: Pick<EscPosOptions, 'darkness' | 'densityCommand'>): void {
  const step = densityStepFor(o.darkness)
  if (step !== 0 && o.densityCommand !== false) e.density(step)
  if (doubleStrikeFor(o.darkness)) e.doubleStrike(true)
}

// ------------------------------------------------------------------ logo
/** BGRA (Electron nativeImage.toBitmap) or RGBA pixels -> 1-bit raster, threshold on luminance; transparent = white. */
export function rasterFromPixels(px: Buffer, w: number, h: number, o: { order?: 'bgra' | 'rgba'; threshold?: number } = {}): RasterImage {
  const widthBytes = Math.ceil(w / 8)
  const data = Buffer.alloc(widthBytes * h)
  const thr = o.threshold ?? RASTER_THRESHOLD_NORMAL
  const bgra = (o.order ?? 'bgra') === 'bgra'
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const r = bgra ? px[i + 2] : px[i]
      const g = px[i + 1]
      const b = bgra ? px[i] : px[i + 2]
      const a = px[i + 3] / 255
      const lum = (0.299 * r + 0.587 * g + 0.114 * b) * a + 255 * (1 - a)
      if (lum < thr) data[y * widthBytes + (x >> 3)] |= 0x80 >> (x & 7)
    }
  }
  return { widthBytes, height: h, data }
}

/** Decodes a PNG/JPEG buffer to pixels no wider than maxWidthPx. null = cannot (no Electron): the logo is skipped. */
export type LogoDecoder = (image: Buffer, maxWidthPx: number) => { width: number; height: number; pixels: Buffer; order: 'bgra' | 'rgba' } | null

// ------------------------------------------------------------------ receipt
export interface EscPosOptions {
  paper: 58 | 80
  /** printable width (mm) of the paper. 80 mm paper: 72 (default) or 76; 58 mm: 48 */
  printableMm?: number
  cut?: CutMode
  drawerKick?: boolean
  drawerPin?: 2 | 5
  /** raster logo, already decoded; omitted = no logo */
  logo?: RasterImage | null
  /** print darkness 1..9 of the printer profile (5 / omitted = normal: no extra bytes) */
  darkness?: number
  /** false = never send the GS ( K density command (printers that do not know it) */
  densityCommand?: boolean
  /** template switches (shop block / sections); missing = show */
  cfg?: Partial<Pick<TemplateConfig, 'showShopName' | 'showAddress' | 'showPhone' | 'showGstin' | 'showCustomer' | 'showCashier' | 'showDiscount' | 'showPayment' | 'showFooter' | 'footerText' | 'terms' | 'showTaxSummary' | 'showHsn'>>
}

const money = (n: number) => formatINR(n, { symbol: false })

function shopBlock(e: EscPos, p: BusinessProfile, W: number, c: NonNullable<EscPosOptions['cfg']>): void {
  e.align('center')
  if (c.showShopName !== false) {
    const name = p.displayName || p.shopName
    e.bold(true).size(2, 2)
    for (const l of wrap(name, Math.floor(W / 2))) e.line(l)
    e.size(1, 1).bold(false)
  }
  const lines: string[] = []
  if (c.showAddress !== false) {
    if (p.address) lines.push(p.address)
    const city = [p.city, [p.state, p.pinCode].filter(Boolean).join(' - ')].filter(Boolean).join(', ')
    if (city) lines.push(city)
  }
  if (c.showPhone !== false && p.phone) lines.push(`Ph: ${p.phone}`)
  if (c.showGstin !== false && p.gstin) lines.push(`GSTIN: ${p.gstin}`)
  for (const l of lines) for (const w of wrap(l, W)) e.line(w)
  e.align('left')
}

/** The 58/80 receipt for a stored sale / return. Uses ONLY the document's data (shop block from doc.profile). */
export function buildEscPosReceipt(doc: InvoiceDocExt, o: EscPosOptions): Buffer {
  const printable = o.printableMm && o.printableMm > 0 ? o.printableMm : defaultPrintableMm(o.paper)
  const W = columnsFor(printable)
  const c = o.cfg ?? {}
  const e = new EscPos().init()
  applyDarkness(e, o)
  if (o.drawerKick) e.drawerKick(o.drawerPin ?? 2)
  if (o.logo) e.align('center').raster(o.logo).align('left')
  shopBlock(e, doc.profile, W, c)
  e.rule(W)
  const title = doc.isReturn ? 'CREDIT NOTE' : doc.profile.gstin ? 'TAX INVOICE' : 'RECEIPT'
  e.align('center').bold(true).line(title).bold(false).align('left')
  e.line(kv('Bill No', doc.invoiceNumber, W))
  e.line(kv('Date', `${fmtDate(doc.createdAt)} ${fmtTime(doc.createdAt)}`, W))
  if (doc.isReturn && doc.originalInvoiceNumber) e.line(kv('Against', doc.originalInvoiceNumber, W))
  if (c.showCashier !== false && doc.cashierName) e.line(kv('Cashier', doc.cashierName, W))
  if (c.showCustomer !== false && (doc.customerName || doc.customerPhone)) e.line(kv('Customer', [doc.customerName, doc.customerPhone].filter(Boolean).join(' '), W))
  e.rule(W)
  for (const l of doc.lines) {
    for (const w of wrap(l.name, W)) e.line(w)
    e.line(kv(`  ${l.qty} x ${money(l.unitPrice)}`, money(l.total), W))
  }
  e.rule(W)
  e.line(kv('Subtotal', money(doc.subtotal), W))
  if (c.showDiscount !== false && doc.discount > 0) e.line(kv('Discount', `-${money(doc.discount)}`, W))
  if (doc.tax > 0) e.line(kv(doc.pricesIncludeTax === false ? 'Tax' : 'Tax (incl.)', money(doc.tax), W))
  if (doc.roundOff !== 0) e.line(kv('Round off', money(doc.roundOff), W))
  e.bold(true).size(1, 2).line(kv('TOTAL', `Rs.${money(doc.total)}`, W)).size(1, 1).bold(false)
  if (c.showPayment !== false && doc.payments.length > 0) {
    e.rule(W)
    for (const p of doc.payments) e.line(kv(`${methodLabel(p.method)}${p.reference ? ` (${p.reference})` : ''}`, money(p.amount), W))
    e.line(kv('Received', money(doc.received), W))
    if (doc.change > 0) e.bold(true).line(kv('Change', money(doc.change), W)).bold(false)
  }
  const footer = (c.footerText ?? '').trim() || doc.profile.footerText
  if (c.showFooter !== false && footer) {
    e.rule(W).align('center')
    for (const l of wrap(footer, W)) e.line(l)
    e.align('left')
  }
  e.cut(o.cut ?? 'partial')
  return e.build()
}

/** Ruler + shop block so paper width / columns can be checked on the real printer. */
export function buildEscPosTest(profile: BusinessProfile, o: EscPosOptions): Buffer {
  const printable = o.printableMm && o.printableMm > 0 ? o.printableMm : defaultPrintableMm(o.paper)
  const W = columnsFor(printable)
  const e = new EscPos().init()
  applyDarkness(e, o)
  if (o.logo) e.align('center').raster(o.logo).align('left')
  shopBlock(e, profile, W, o.cfg ?? {})
  e.rule(W, '=')
  e.align('center').bold(true).line('RAW ESC/POS TEST').bold(false).align('left')
  e.line(`${o.paper} mm paper, ${printable} mm printable, ${W} columns`)
  let ruler = ''
  for (let i = 1; i <= W; i++) ruler += i % 10 === 0 ? String((i / 10) % 10) : String(i % 10)
  e.line(ruler)
  e.line('<' + '-'.repeat(Math.max(0, W - 2)) + '>')
  e.bold(true).line('Bold text').bold(false).size(2, 2).line('Big 2x').size(1, 1)
  e.line(kv('Left', 'Right', W))
  if (o.darkness != null && lvl(o.darkness) !== 5) e.line(`Print darkness ${lvl(o.darkness)} of 9`)
  e.rule(W, '=')
  e.cut(o.cut ?? 'partial')
  return e.build()
}

/** Only the drawer pulse (used by "Open cash drawer" and after a cash sale). */
export function buildDrawerKick(pin: 2 | 5 = 2): Buffer {
  return new EscPos().init().drawerKick(pin).build()
}

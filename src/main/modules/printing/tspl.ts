/**
 * TSPL: the command language of TSC-compatible thermal label printers (4BARCODE, TSC, Xprinter, Gprinter, HPRT, Rongta, TVS ...).
 *
 * Labels go to the printer as one 1-bit picture per label, drawn by the app at exactly the printer's resolution (one pixel = one
 * printer dot). Nothing is scaled or dithered on the way: the Windows driver never touches the job, so the label size, the bar
 * widths and the text come out exactly as drawn. The printer's gap sensor finds each label (SIZE + GAP).
 * PURE: no Electron, no I/O.
 */

/** One drawn label. `bits`: rows top to bottom, ceil(width / 8) bytes per row, most significant bit first, 1 = black dot. */
export interface MonoBitmap { width: number; height: number; bits: Buffer }

export interface TsplOptions {
  widthMm: number
  heightMm: number
  /** gap between two labels on the roll (mm); 0 = continuous paper */
  gapMm: number
  /** printer resolution, for the move-right / move-down calibration */
  dpi: number
  /** print darkness 1 (lightest) .. 5 (the printer's own setting) .. 9 (darkest) */
  darkness?: number
  offsetXmm?: number
  offsetYmm?: number
  /** turn the print round by 180 degrees (labels come out upside down otherwise on some printers) */
  flip?: boolean
}

export const DEFAULT_LABEL_GAP_MM = 2

/** Darkness level 1..9 as TSPL DENSITY 0..15; null at the normal level 5 (the printer keeps the density it is set to). */
export function tsplDensity(darkness: number | undefined): number | null {
  const d = Math.round(Math.min(9, Math.max(1, darkness ?? 5)))
  if (d === 5) return null
  return Math.round(((d - 1) * 15) / 8)
}

const mm = (n: number) => String(Math.round(n * 100) / 100)

/**
 * The TSPL job. Consecutive identical labels (copies) are sent once with PRINT 1,n. TSPL bitmaps print a dot for a 0 bit, so the
 * picture is inverted on the way out.
 */
export function buildTspl(labels: MonoBitmap[], o: TsplOptions): Buffer {
  const dotsPerMm = o.dpi / 25.4
  const out: Buffer[] = []
  const line = (s: string) => out.push(Buffer.from(s + '\r\n', 'latin1'))
  line(`SIZE ${mm(o.widthMm)} mm,${mm(o.heightMm)} mm`)
  line(o.gapMm > 0 ? `GAP ${mm(o.gapMm)} mm,0 mm` : 'GAP 0,0')
  line(`DIRECTION ${o.flip ? 0 : 1},0`)
  line(`REFERENCE ${Math.max(0, Math.round((o.offsetXmm ?? 0) * dotsPerMm))},0`)
  const shift = Math.round((o.offsetYmm ?? 0) * dotsPerMm)
  if (shift) line(`SHIFT ${shift}`)
  const density = tsplDensity(o.darkness)
  if (density != null) line(`DENSITY ${density}`)
  line('SET TEAR ON')
  for (let i = 0; i < labels.length; ) {
    const b = labels[i]
    let n = 1
    while (i + n < labels.length && sameBitmap(labels[i + n], b)) n++
    const rowBytes = Math.ceil(b.width / 8)
    const inverted = Buffer.alloc(rowBytes * b.height)
    for (let k = 0; k < inverted.length; k++) inverted[k] = ~(b.bits[k] ?? 0) & 0xff
    line('CLS')
    out.push(Buffer.from(`BITMAP 0,0,${rowBytes},${b.height},0,`, 'latin1'), inverted, Buffer.from('\r\n', 'latin1'))
    line(`PRINT 1,${n}`)
    i += n
  }
  return Buffer.concat(out)
}

const sameBitmap = (a: MonoBitmap, b: MonoBitmap) => a.width === b.width && a.height === b.height && a.bits.equals(b.bits)

/**
 * A captured picture (BGRA or RGBA, 4 bytes per pixel) as a 1-bit label: a pixel darker than `threshold` (0..255 luminance)
 * becomes a black dot. Pure black and white in, pure black and white out: there is no dithering, so text edges stay clean.
 */
export function toMono(pixels: Buffer, width: number, height: number, o: { order?: 'bgra' | 'rgba'; threshold?: number } = {}): MonoBitmap {
  const threshold = o.threshold ?? 150
  const [ri, bi] = o.order === 'rgba' ? [0, 2] : [2, 0]
  const rowBytes = Math.ceil(width / 8)
  const bits = Buffer.alloc(rowBytes * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4
      const a = pixels[p + 3] / 255
      // transparent counts as white paper
      const lum = 255 - a * (255 - (pixels[p + ri] * 299 + pixels[p + 1] * 587 + pixels[p + bi] * 114) / 1000)
      if (lum < threshold) bits[y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7)
    }
  }
  return { width, height, bits }
}

export { isTsplPrinterName } from '@shared/labelPrinters'

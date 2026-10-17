import { describe, expect, it } from 'vitest'
import { buildTspl, isTsplPrinterName, toMono, tsplDensity, type MonoBitmap } from '../../src/main/modules/printing/tspl'
import { parseCalibration } from '../../src/main/modules/printing/adapter'
import { parseTspl } from './tsplParse'

const solid = (w: number, h: number, black: (x: number, y: number) => boolean): MonoBitmap => {
  const rb = Math.ceil(w / 8)
  const bits = Buffer.alloc(rb * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (black(x, y)) bits[y * rb + (x >> 3)] |= 0x80 >> (x & 7)
  return { width: w, height: h, bits }
}

describe('TSPL label job', () => {
  it('sets the label size, gap and direction, and sends each label as an inverted bitmap', () => {
    const a = solid(16, 2, (x) => x < 8)
    const job = buildTspl([a], { widthMm: 50, heightMm: 25, gapMm: 2, dpi: 203 })
    const { lines, labels } = parseTspl(job)
    expect(lines.slice(0, 3)).toEqual(['SIZE 50 mm,25 mm', 'GAP 2 mm,0 mm', 'DIRECTION 1,0'])
    expect(lines).toContain('CLS')
    expect(lines).not.toContain('DENSITY 8') // normal darkness: the printer keeps its own setting
    // TSPL prints a dot for a 0 bit: black (1) is sent as 0
    const raw = job.subarray(job.indexOf('BITMAP 0,0,2,2,0,', 0, 'latin1') + 'BITMAP 0,0,2,2,0,'.length)
    expect([...raw.subarray(0, 4)]).toEqual([0x00, 0xff, 0x00, 0xff])
    expect(labels).toHaveLength(1)
    expect(labels[0].bitmap.bits.equals(a.bits)).toBe(true)
    expect(labels[0].copies).toBe(1)
  })
  it('copies of the same label are sent once with PRINT 1,n; different labels each get their own bitmap', () => {
    const a = solid(8, 1, () => true)
    const b = solid(8, 1, (x) => x === 0)
    const { labels, lines } = parseTspl(buildTspl([a, a, a, b, a], { widthMm: 50, heightMm: 25, gapMm: 3, dpi: 203 }))
    expect(labels.map((l) => l.copies)).toEqual([3, 1, 1])
    expect(lines.filter((l) => l.startsWith('PRINT'))).toEqual(['PRINT 1,3', 'PRINT 1,1', 'PRINT 1,1'])
    expect(lines[1]).toBe('GAP 3 mm,0 mm')
  })
  it('darkness, offsets, flip and continuous paper', () => {
    const { lines } = parseTspl(buildTspl([solid(8, 1, () => false)], { widthMm: 40, heightMm: 30, gapMm: 0, dpi: 203, darkness: 9, offsetXmm: 1, offsetYmm: -0.5, flip: true }))
    expect(lines).toEqual(expect.arrayContaining(['SIZE 40 mm,30 mm', 'GAP 0,0', 'DIRECTION 0,0', 'REFERENCE 8,0', 'SHIFT -4', 'DENSITY 15']))
    expect(tsplDensity(1)).toBe(0)
    expect(tsplDensity(5)).toBeNull()
    expect(tsplDensity(7)).toBe(11)
  })
  it('toMono: dark pixels become dots, light and transparent ones stay paper', () => {
    // 3 pixels BGRA: black, light grey, transparent black
    const px = Buffer.from([0, 0, 0, 255, 230, 230, 230, 255, 0, 0, 0, 0])
    const m = toMono(px, 3, 1)
    expect(m.bits[0]).toBe(0b1000_0000)
  })
  it('recognises TSPL label printers by name, not office printers', () => {
    expect(isTsplPrinterName('4BARCODE 4B-2054N')).toBe(true)
    expect(isTsplPrinterName('TSC TE244')).toBe(true)
    expect(isTsplPrinterName('Xprinter XP-365B')).toBe(true)
    expect(isTsplPrinterName('Brother DCP-L2520D series')).toBe(false)
    expect(isTsplPrinterName('Microsoft Print to PDF')).toBe(false)
  })
  it('printer profiles keep the TSPL settings (off by default, gap 2 mm)', () => {
    expect(parseCalibration({})).toMatchObject({ tspl: false, labelGapMm: 2, flip: false })
    expect(parseCalibration({ tspl: true, labelGapMm: 3, flip: true })).toMatchObject({ tspl: true, labelGapMm: 3, flip: true })
    expect(parseCalibration({ labelGapMm: 99 }).labelGapMm).toBe(20)
  })
})

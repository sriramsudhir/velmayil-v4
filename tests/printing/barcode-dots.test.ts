import { describe, it, expect } from 'vitest'
import type { BusinessProfile } from '../../src/shared/types'
import {
  barcodeSvg, barcodeSymbol, DEFAULT_DPI, dotMm, fitModules, gtinCheckOk, maxModuleDots, minModuleDots, parseDpi, pickFormat, qrSvg, snapBarcodes
} from '../../src/main/modules/printing/barcode'
import { barcodeWarning, renderLabels, renderTestPage, TEST_BARCODE } from '../../src/main/modules/printing/engine'
import { LABEL_PAGE_SLACK_MM, labelBoxMm } from '../../src/main/modules/printing/layouts'
import { normalizeConfig } from '../../src/main/modules/printing/config'
import { prepareHtml } from '../../src/main/modules/printing/adapter'
import { DEFAULT_LABEL_OPTIONS, LABEL_PRESETS, labelConfigFor, resolveLabelSize } from '../../src/shared/labelSizes'

/**
 * Scannable barcodes: every module is a whole number of printer dots, the symbol starts on a dot boundary, quiet zones are
 * kept, nothing is stretched, and a code that cannot fit is reported instead of being printed broken.
 */

const profile = (over: Partial<BusinessProfile> = {}): BusinessProfile => ({
  id: 1, version: 1, shopName: 'Acme Traders', legalName: 'Acme Traders', displayName: 'Acme Traders', shortName: 'Acme',
  address: '12 Market Road', city: 'Madurai', state: 'Tamil Nadu', pinCode: '625001', phone: '9876543210', email: '', website: '',
  gstin: '', pan: '', footerText: '', logoAssetId: null,
  logoSettings: { visible: true, widthMm: 0, heightMm: 0, alignment: 'center', position: 'top' },
  headerSettings: { showLogo: true, showShopName: true, showAddress: true, showPhone: true, showGstin: true }, createdAt: 1, createdBy: null, ...over
})
const item = (barcode: string, over: Record<string, unknown> = {}) => ({ name: 'Rocket', variant: 'Large', sku: 'RK-1', barcode, mrp: 25000, price: 22000, copies: 1, ...over })

/** Parse the bits of a rendered symbol that matter for scanning. */
function parse(svg: string) {
  const total = Number(/viewBox="0 0 (\d+) 100"/.exec(svg)![1])
  const widthMm = Number(/style="width:([\d.]+)mm/.exec(svg)![1])
  const leftMm = Number(/margin-left:([\d.]+)mm/.exec(svg)![1])
  const heightMm = Number(/height:([\d.]+)mm/.exec(svg)![1])
  const bars = [...svg.matchAll(/<rect x="(\d+)" y="0" width="(\d+)" height="100"\/>/g)].map((m) => ({ x: Number(m[1]), w: Number(m[2]) }))
  return { total, widthMm, leftMm, heightMm, bars, quietLeft: bars[0].x, quietRight: total - (bars[bars.length - 1].x + bars[bars.length - 1].w) }
}
const dotsOf = (mm: number, dpi: number) => mm / dotMm(dpi)
const whole = (n: number) => Math.abs(n - Math.round(n)) < 0.002

describe('printer dots', () => {
  it('one dot is 25.4 / dpi mm; unknown resolutions fall back to 203', () => {
    expect(dotMm(203)).toBeCloseTo(0.12512, 5)
    expect(dotMm(300)).toBeCloseTo(0.08467, 5)
    expect(DEFAULT_DPI).toBe(203)
    expect([parseDpi(203), parseDpi(300), parseDpi(600), parseDpi(180), parseDpi('300'), parseDpi(undefined)]).toEqual([203, 300, 600, 203, 203, 203])
  })
  it('module limits in dots: never finer than 0.125 mm, never wider than 0.5 mm', () => {
    expect([203, 300, 600].map(minModuleDots)).toEqual([1, 2, 3])
    expect([203, 300, 600].map(maxModuleDots)).toEqual([4, 6, 12])
  })

  // [dpi, total modules, available mm, expected dots per module]
  const cases: [number, number, number, number][] = [
    [203, 117, 47, 3], // EAN-13 on 50 mm: 375 dots / 117 = 3.2
    [203, 117, 35.6, 2], // EAN-13 on 38 mm
    [203, 117, 95, 4], // wide label: capped at 4 dots (0.5 mm)
    [203, 121, 47, 3], // 9-char Code 128 on 50 mm
    [203, 132, 35.6, 2], // SPK-0001 on 38 mm
    [203, 187, 35.6, 1], // long unit prefix on 38 mm: only 1 dot fits
    [203, 187, 47, 2],
    [300, 117, 47, 4], // 555 dots / 117
    [300, 117, 35.6, 3],
    [300, 187, 35.6, 2],
    [300, 117, 95, 6],
    [600, 117, 65, 12]
  ]
  for (const [dpi, total, avail, dots] of cases) {
    it(`${dpi} dpi, ${total} modules in ${avail} mm -> ${dots} dot(s) per module, whole dots, inside the width`, () => {
      const f = fitModules(total, avail, dpi)
      expect(f.fits).toBe(true)
      expect(f.dots).toBe(dots)
      expect(whole(dotsOf(f.moduleMm, dpi))).toBe(true)
      expect(dotsOf(f.widthMm, dpi)).toBeCloseTo(total * dots, 2)
      expect(f.leftMm).toBeGreaterThanOrEqual(0)
      expect(f.leftMm + f.widthMm).toBeLessThanOrEqual(avail + 1e-3)
      // the largest that fits: one more dot per module would not (unless capped at the 0.5 mm maximum)
      if (dots < maxModuleDots(dpi)) expect(total * (dots + 1) * dotMm(dpi)).toBeGreaterThan(avail)
    })
  }

  it('the symbol starts on a dot boundary of the page, for any margin', () => {
    for (const dpi of [203, 300]) {
      for (const origin of [1.2, 1.5, 2.5, 3.37, 7]) {
        const f = fitModules(117, 47, dpi, { originMm: origin })
        expect(whole(dotsOf(origin + f.leftMm, dpi)), `${dpi} dpi origin ${origin}`).toBe(true)
        // and it is still centred to within one dot
        expect(Math.abs(f.leftMm - (47 - f.widthMm) / 2)).toBeLessThanOrEqual(dotMm(dpi) + 1e-6)
      }
    }
  })

  it('a scale other than 100 % is compensated so the PRINTED module is still whole dots', () => {
    const f = fitModules(117, 47, 203, { scale: 0.95, originMm: 1.5 })
    expect(whole(dotsOf(f.moduleMm * 0.95, 203))).toBe(true)
    expect(whole(dotsOf((1.5 + f.leftMm) * 0.95, 203))).toBe(true)
    expect(f.widthMm).toBeLessThanOrEqual(47)
  })

  it('does not fit below the smallest printable module', () => {
    expect(fitModules(400, 47, 203)).toMatchObject({ fits: false, dots: 0 }) // 375 dots available
    expect(fitModules(200, 30, 300)).toMatchObject({ fits: false }) // would need 1 dot at 300 dpi (0.085 mm): too fine to scan
    expect(fitModules(187, 35.6, 203)).toMatchObject({ fits: true, dots: 1, narrow: true })
    expect(fitModules(117, 35.6, 203)).toMatchObject({ narrow: false })
  })
})

describe('pickFormat: retail symbols only with a valid check digit', () => {
  it('check digit maths', () => {
    expect(gtinCheckOk('8901234567890')).toBe(true)
    expect(gtinCheckOk('8901234567891')).toBe(false)
    expect(gtinCheckOk('036000291452')).toBe(true)
    expect(gtinCheckOk('96385074')).toBe(true)
    expect(gtinCheckOk('9638507X')).toBe(false)
  })
  it('13 digits: EAN-13 if the check digit is right, otherwise Code 128 (never a silently "corrected" EAN)', () => {
    expect(pickFormat('8901234567890')).toBe('EAN13')
    expect(pickFormat('8901234567891')).toBe('CODE128')
    expect(pickFormat('8901234567890', 'EAN13')).toBe('EAN13')
    expect(pickFormat('8901234567891', 'EAN13')).toBe('CODE128')
    expect(pickFormat('8901234567890', 'CODE128')).toBe('CODE128')
  })
  it('12-digit UPC-A and 8-digit EAN-8 when valid; shop codes, unit codes and anything else are Code 128', () => {
    expect(pickFormat('036000291452')).toBe('UPC')
    expect(pickFormat('036000291453')).toBe('CODE128')
    expect(pickFormat('96385074')).toBe('EAN8')
    expect(pickFormat('96385075')).toBe('CODE128')
    expect(pickFormat('96385074', 'EAN13')).toBe('CODE128')
    for (const c of ['200000123', 'VM000123', 'SPK-0001', 'ABC-123', '12345', '2000001234']) expect(pickFormat(c), c).toBe('CODE128')
  })
  it('an invalid 13-digit number encodes all 13 digits in Code 128 (set C: 6 pairs + 1 digit)', () => {
    const s = barcodeSymbol('8901234567891', { heightMm: 9, maxWidthMm: 47 })
    expect(s.format).toBe('CODE128')
    expect(s.value).toBe('8901234567891')
    expect(s.modules).toBe(11 + 6 * 11 + 11 + 11 + 11 + 13) // start C, 6 pairs, switch to B, 1 digit, check, stop
    expect(s.svg).toContain('aria-label="barcode 8901234567891"')
  })
})

describe('symbol geometry', () => {
  it('Code 128 uses code set C for digit runs, so shop and unit codes stay compact', () => {
    const m = (v: string) => barcodeSymbol(v, { heightMm: 9 }).modules
    expect(m('200000123')).toBe(101) // all code set B would be 134
    expect(m('VM000123')).toBe(101) // B: V M, then C: 00 01 23
    expect(m('SPK-0001')).toBe(112)
    expect(m('2000001234')).toBe(90) // even number of digits: pure set C
  })

  it('quiet zones: EAN-13 11 + 11, Code 128 / UPC-A / EAN-8 10 + 10', () => {
    const q = (v: string) => { const p = parse(barcodeSvg(v, { heightMm: 9, maxWidthMm: 60 })); return [p.quietLeft, p.quietRight, p.total] }
    expect(q('8901234567890')).toEqual([11, 11, 117])
    expect(q('200000123')).toEqual([10, 10, 121])
    expect(q('036000291452')).toEqual([10, 10, 115])
    expect(q('96385074')).toEqual([10, 10, 87])
  })

  it('worked example, 50 x 25 mm label (47 mm for the bars) at 203 dpi', () => {
    const ean = barcodeSymbol('8901234567890', { heightMm: 7.4, maxWidthMm: 47, originMm: 1.5 })
    expect(ean).toMatchObject({ format: 'EAN13', modules: 95, quiet: [11, 11], dots: 3 })
    expect(dotsOf(ean.widthMm, 203)).toBeCloseTo(351, 2) // 117 modules x 3 dots = 43.92 mm
    expect(ean.widthMm).toBeCloseTo(43.918, 2)
    const c128 = barcodeSymbol('200000123', { heightMm: 7.4, maxWidthMm: 47, originMm: 1.5 })
    expect(c128).toMatchObject({ format: 'CODE128', modules: 101, quiet: [10, 10], dots: 3 })
    expect(dotsOf(c128.widthMm, 203)).toBeCloseTo(363, 2) // 121 modules x 3 dots = 45.42 mm
    expect(c128.problem).toBeUndefined()
  })

  it('never stretched: exact mm width, crisp edges, pure black on white, no anti-aliasing hooks', () => {
    const svg = barcodeSvg('8901234567890', { heightMm: 9, maxWidthMm: 47 })
    const p = parse(svg)
    expect(svg).toContain('shape-rendering="crispEdges"')
    expect(svg).toContain('<rect width="117" height="100" fill="#fff"/><g fill="#000">')
    expect(svg).not.toMatch(/width:100%|stroke|filter|opacity|#[0-9a-f]{3,6}(?<!#fff)(?<!#000)/i)
    // viewBox units = modules and the box is exactly modules x module width: preserveAspectRatio="none" cannot distort a module
    expect(svg).toContain('preserveAspectRatio="none"')
    expect(dotsOf(p.widthMm / p.total, 203)).toBeCloseTo(3, 3)
    // every bar is a whole number of modules -> a whole number of dots
    for (const b of p.bars) expect(Number.isInteger(b.x) && Number.isInteger(b.w)).toBe(true)
  })

  it('smaller (still standard) quiet zones are used when that is what makes the symbol fit or buys a wider module', () => {
    // EAN-13 at 2 dots: 117 modules need 29.28 mm, 113 (11 + 7) need 28.28 mm
    const s = barcodeSymbol('8901234567890', { heightMm: 9, maxWidthMm: 28.6 })
    expect(s).toMatchObject({ dots: 2, quiet: [11, 7] })
    const p = parse(s.svg)
    expect([p.quietLeft, p.quietRight, p.total]).toEqual([11, 7, 113])
    // Code 128 has no smaller quiet zone: 10 modules stay
    expect(barcodeSymbol('200000123', { heightMm: 9, maxWidthMm: 28.6 }).quiet).toEqual([10, 10])
  })

  it('too long for the width: no bars at all (a clipped barcode only looks like it works) and a clear reason', () => {
    const s = barcodeSymbol('VM0001234567890123ABCDEFGH', { heightMm: 9, maxWidthMm: 20 })
    expect(s.svg).toBe('')
    expect(s.problem).toBe('too_long')
    expect(barcodeSvg('VM0001234567890123ABCDEFGH', { heightMm: 9, maxWidthMm: 20 })).toBe('')
    expect(barcodeWarning(s, 20)).toMatch(/^Barcode too long for this label width: "VM0001234567890123ABCDEFGH" needs [\d.]+ mm but the label has 20 mm/)
  })

  it('fine bars (1 dot at 203 dpi) are printed but flagged; text that cannot be encoded is flagged', () => {
    const fine = barcodeSymbol('SPARKLER-0001', { heightMm: 9, maxWidthMm: 35.6 })
    expect(fine).toMatchObject({ dots: 1, problem: 'narrow' })
    expect(fine.svg).toContain('<svg class="barcode"')
    expect(barcodeWarning(fine, 35.6)).toMatch(/very fine/)
    const bad = barcodeSymbol('பட்டாசு', { heightMm: 9, maxWidthMm: 47 })
    expect(bad).toMatchObject({ svg: '', problem: 'not_encodable' })
    expect(barcodeWarning(bad, 47)).toMatch(/cannot be made into a barcode/)
    expect(barcodeWarning(barcodeSymbol('200000123', { heightMm: 9, maxWidthMm: 47 }), 47)).toBeNull()
  })

  it('300 dpi printer: same code, whole 300 dpi dots', () => {
    const s = barcodeSymbol('8901234567890', { heightMm: 9, maxWidthMm: 47, dpi: 300 })
    expect(s.dots).toBe(4)
    expect(dotsOf(s.widthMm, 300)).toBeCloseTo(468, 2)
    expect(whole(dotsOf(s.moduleMm, 300))).toBe(true)
  })

  it('snapBarcodes re-fits a rendered document to another printer and is a no-op for the printer it was rendered for', () => {
    const html = `<html><head></head><body>${barcodeSvg('8901234567890', { heightMm: 9, maxWidthMm: 47, originMm: 1.5 })}</body></html>`
    expect(snapBarcodes(html, 203, 1)).toBe(html)
    const at300 = parse(snapBarcodes(html, 300, 1))
    expect(dotsOf(at300.widthMm, 300)).toBeCloseTo(468, 2)
    expect(whole(dotsOf(1.5 + at300.leftMm, 300))).toBe(true)
    // printer profile scale 90 %: CSS size grows so that the printed size is whole dots again
    const scaled = parse(snapBarcodes(html, 203, 0.9))
    expect(whole(dotsOf((scaled.widthMm / 117) * 0.9, 203))).toBe(true)
    expect(scaled.widthMm).toBeLessThanOrEqual(47)
    // horizontal offset of the profile moves the page: the symbol still starts on a dot
    const moved = parse(snapBarcodes(html, 203, 1, 0.7))
    expect(whole(dotsOf(0.7 + 1.5 + moved.leftMm, 203))).toBe(true)
    // documents without sized barcodes are untouched
    expect(snapBarcodes('<p>x</p>', 300, 0.5)).toBe('<p>x</p>')
  })

  it('prepareHtml applies the printer profile resolution to the barcodes; the bars themselves never change', () => {
    const svg = barcodeSvg('200000123', { heightMm: 9, maxWidthMm: 47, originMm: 1.5 })
    const html = `<html><head></head><body>${svg}</body></html>`
    expect(prepareHtml(html, {})).toContain(svg) // 203 dpi default: byte-identical symbol
    const out = prepareHtml(html, { dpi: 300, darkness: 9, logoBrightness: 1 })
    expect(parse(out).bars).toEqual(parse(svg).bars)
    expect(dotsOf(parse(out).widthMm, 300)).toBeCloseTo(121 * 4, 2)
  })

  it('QR code: 4-module quiet zone and whole-dot modules, never larger than asked', () => {
    const svg = qrSvg('upi://pay?pa=acme@upi&pn=Acme&am=10.00&cu=INR&tn=INV-1', 34)
    const total = Number(/viewBox="0 0 (\d+) \d+"/.exec(svg)![1])
    const side = Number(/style="width:([\d.]+)mm/.exec(svg)![1])
    expect(svg).toContain('shape-rendering="crispEdges"')
    expect(svg).toMatch(/<path d="M4 4h7/) // the finder pattern starts after 4 quiet modules
    expect(whole(dotsOf(side / total, 203))).toBe(true)
    expect(dotsOf(side / total, 203)).toBeGreaterThanOrEqual(2)
    expect(side).toBeLessThanOrEqual(34)
  })
})

describe('labels', () => {
  const cfg50 = labelConfigFor(resolveLabelSize({ presetId: '50x25' }), DEFAULT_LABEL_OPTIONS)

  it('the readable line is exactly the encoded value (trimmed once, never shortened)', () => {
    for (const code of ['200000123', 'VM000123', 'SPK-0001', '8901234567890', '8901234567891', ' 200000123 ']) {
      const r = renderLabels('label_barcode', profile(), cfg50, null, [item(code, { unit: code.startsWith('SPK') })])
      const v = code.trim()
      expect(r.html, code).toContain(`<div class="code">${v}</div>`)
      expect(r.html, code).toContain(`aria-label="barcode ${v}"`)
      expect(r.warnings, code).toBeUndefined()
    }
  })

  for (const preset of LABEL_PRESETS) {
    it(`${preset.id}: shop code and EAN-13 print at >= 2 whole dots on the dot grid, at 203 and 300 dpi`, () => {
      const size = resolveLabelSize({ presetId: preset.id })
      const cfg = labelConfigFor(size, DEFAULT_LABEL_OPTIONS)
      const inner = size.widthMm - Number(cfg.marginLeftMm) - Number(cfg.marginRightMm)
      for (const dpi of [203, 300]) {
        for (const code of ['200000123', 'VM000123', '8901234567890']) {
          const r = renderLabels('label_barcode', profile(), cfg, null, [item(code)], { dpi })
          const p = parse(/<svg class="barcode".*?<\/svg>/.exec(r.html)![0])
          const dots = dotsOf(p.widthMm / p.total, dpi)
          expect(whole(dots), `${code} ${dpi}`).toBe(true)
          expect(p.widthMm / p.total).toBeGreaterThanOrEqual(0.25 - 1e-3)
          expect(p.widthMm / p.total).toBeLessThanOrEqual(0.51)
          expect(p.leftMm + p.widthMm).toBeLessThanOrEqual(inner + 1e-3)
          expect(p.quietLeft).toBeGreaterThanOrEqual(10)
          expect(p.quietRight).toBeGreaterThanOrEqual(code.length === 13 ? 7 : 10)
          if (!size.sheet) expect(whole(dotsOf(Number(cfg.marginLeftMm) + p.leftMm, dpi)), `${code} ${dpi} origin`).toBe(true)
          expect(p.heightMm, `${code} bar height`).toBeGreaterThanOrEqual(6)
          expect(r.warnings).toBeUndefined()
        }
      }
    })
  }

  it('bar height never drops below 6 mm / 15 % of the symbol width to make room for a long name', () => {
    const long = 'Extra Long Premium Assorted Multicolour Rainbow Fountain Cracker Gift Box with Extra Sparklers'
    const cfg = labelConfigFor(resolveLabelSize({ presetId: '100x50' }), DEFAULT_LABEL_OPTIONS)
    const p = parse(/<svg class="barcode".*?<\/svg>/.exec(renderLabels('label_barcode', profile(), cfg, null, [item('8901234567890', { name: long })]).html)![0])
    expect(p.heightMm).toBeGreaterThanOrEqual(Math.min(Number(cfg.barcodeHeightMm), Math.max(6, p.widthMm * 0.15)) - 0.05)
  })

  it('a code too long for the label: warning "Barcode too long for this label width", no broken bars, text still printed', () => {
    const cfg = labelConfigFor(resolveLabelSize({ presetId: 'custom', customWidthMm: 20, customHeightMm: 15 }), DEFAULT_LABEL_OPTIONS)
    const r = renderLabels('label_barcode', profile(), cfg, null, [item('VM0001234567890123'), item('VM0001234567890123'), item('12345')])
    expect(r.warnings).toHaveLength(2) // the too-long message once (not per label), plus "fine bars" for the short code at 1 dot
    expect(r.warnings![1]).toMatch(/"12345": the bars are very fine/)
    expect(r.warnings![0]).toContain('Barcode too long for this label width')
    expect(r.warnings![0]).toContain('VM0001234567890123')
    expect((r.html.match(/<svg class="barcode"/g) ?? []).length).toBe(1) // only the short code got bars
    expect(r.html).toContain('<div class="code">VM0001234567890123</div>')
    // a wider label fixes it
    expect(renderLabels('label_barcode', profile(), cfg50, null, [item('VM0001234567890123')]).warnings).toBeUndefined()
  })

  it('at most 5 warnings are listed, the rest are counted', () => {
    const cfg = labelConfigFor(resolveLabelSize({ presetId: 'custom', customWidthMm: 20, customHeightMm: 15 }), DEFAULT_LABEL_OPTIONS)
    const r = renderLabels('label_barcode', profile(), cfg, null, Array.from({ length: 8 }, (_, i) => item(`VM00012345678901${String(i).padStart(2, '0')}`)))
    expect(r.warnings).toHaveLength(6)
    expect(r.warnings![5]).toBe('3 more codes have a barcode problem on this label size.')
  })

  it('product labels are no longer stretched to the label width (the old width:100% gave fractional dots)', () => {
    const r = renderLabels('label_product', profile(), {}, null, [item('8901234567890')])
    const svg = /<svg class="barcode".*?<\/svg>/.exec(r.html)![0]
    expect(svg).not.toContain('width:100%')
    const p = parse(svg)
    expect(whole(dotsOf(p.widthMm / p.total, 203))).toBe(true)
    expect(p.widthMm).toBeLessThanOrEqual(60 - 4)
    expect(whole(dotsOf(2 + p.leftMm, 203))).toBe(true)
  })

  it('one label per page: the printed box is a little shorter than the page, so rounding never spills a blank second label', () => {
    const cfg = normalizeConfig('label_barcode', cfg50)
    expect(labelBoxMm(cfg)).toEqual({ w: 50, h: 25 - LABEL_PAGE_SLACK_MM })
    const html = renderLabels('label_barcode', profile(), cfg50, null, [item('200000123', { copies: 2 })]).html
    expect(html).toContain('@page{size:50mm 25mm;margin:0}')
    expect(html).toContain('.sheet{width:50mm;height:24.5mm;')
    expect(html).toContain('.label{width:50mm;height:24.5mm;')
    expect(html).toContain('.sheet:last-child{break-after:auto;page-break-after:auto}')
    // 300 dpi rounds 25 mm DOWN to 295 dots = 24.98 mm: a 25 mm box would not fit, the 24.5 mm box does
    expect(Math.floor(25 / dotMm(300)) * dotMm(300)).toBeLessThan(25)
    expect(24.5).toBeLessThan(Math.floor(25 / dotMm(300)) * dotMm(300))
    // label sheets keep the exact grid cell
    const a4 = normalizeConfig('label_barcode', labelConfigFor(resolveLabelSize({ presetId: 'a4-3x8' }), DEFAULT_LABEL_OPTIONS))
    expect(labelBoxMm(a4)).toEqual({ w: 70, h: 36 })
    // product labels: same slack, and no forced page break after the last label
    const pl = renderLabels('label_product', profile(), {}, null, [item('200000123', { copies: 2 })]).html
    expect(pl).toContain('min-height:39.5mm')
    expect(pl).toContain('.label:last-child{page-break-after:auto;break-after:auto}')
  })

  it('test page carries a sample barcode sized for the printer and the darkness level', () => {
    const r = renderTestPage('label', profile(), {}, null, { darkness: 7, dpi: 300 })
    const p = parse(/<svg class="barcode".*?<\/svg>/.exec(r.html)![0])
    expect(whole(dotsOf(p.widthMm / p.total, 300))).toBe(true)
    expect(r.html).toContain(`aria-label="barcode ${TEST_BARCODE}"`)
    expect(r.html).toContain(`it must read ${TEST_BARCODE}`)
    expect(r.html).toContain('Print darkness 7 of 9')
    expect(r.html).toContain('300 dpi')
    expect(renderTestPage('80', profile(), {}, null).html).toContain('Print darkness 5 of 9')
  })
})

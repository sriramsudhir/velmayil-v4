import { describe, it, expect, beforeEach } from 'vitest'
import { createTestApp } from '../helpers'
import type { App } from '../../src/main/core/app'
import type { PrintingService } from '../../src/main/modules/printing/service'
import { barcodeSvg } from '../../src/main/modules/printing/barcode'
import { formatINR } from '../../src/shared/money'
import { DEFAULT_LABEL_OPTIONS, LABEL_PRESETS, labelConfigFor, pageSizeOf, resolveLabelSize } from '../../src/shared/labelSizes'
import { formatUnitCode } from '../../src/shared/scanList'

let app: App
let variantId: number
const printing = () => app.get<PrintingService>('printing')
const cat = <T = any>(m: string, a?: unknown) => app.call('catalog', m, a) as Promise<T>
const codes = (n: number, prefix = 'SPK') => Array.from({ length: n }, (_, i) => formatUnitCode(prefix, i + 1))
const count = (html: string, re: RegExp) => (html.match(re) ?? []).length

beforeEach(async () => {
  app = createTestApp()
  const p = await cat('save', { name: 'Sparkler Box', hsn: '3604', taxRateBp: 1800, variants: [{ name: '', mrp: 12000, price: 10000, cost: 7000 }] })
  variantId = p.variants[0].id
})

describe('unit labels (Code 128 per unit code)', () => {
  it('draws a Code 128 symbol for each unit code, with the readable code, product, price and shop', () => {
    const list = codes(3)
    const cfg = labelConfigFor(resolveLabelSize({ presetId: '50x25' }), DEFAULT_LABEL_OPTIONS)
    const r = printing().renderLabelHtml({ unitCodes: list, variantId, config: cfg })
    expect(count(r.html, /<svg class="barcode"/g)).toBe(3)
    for (const c of list) {
      expect(r.html).toContain(`<div class="code">${c}</div>`)
      expect(r.html).toContain(`aria-label="barcode ${c}"`)
    }
    expect(r.html).toContain('Sparkler Box')
    expect(r.html).toContain(formatINR(10000))
    expect(r.html).toContain('Test Shop')
    // distinct symbols (different data)
    const svgs = r.html.match(/<svg class="barcode".*?<\/svg>/g)!
    expect(new Set(svgs).size).toBe(3)
  })

  it('the symbol is Code 128 (EAN-13 would reject letters): same bars as barcodeSvg CODE128', () => {
    const cfg = labelConfigFor(resolveLabelSize({ presetId: '60x40' }), { ...DEFAULT_LABEL_OPTIONS })
    const html = printing().renderLabelHtml({ unitCodes: ['SPK-0001'], variantId, config: cfg }).html
    const rects = (s: string) => (s.match(/<rect x=/g) ?? []).length
    const ref = barcodeSvg('SPK-0001', { heightMm: 10, format: 'CODE128' })
    const mine = /<svg class="barcode".*?<\/svg>/.exec(html)![0]
    expect(rects(mine)).toBe(rects(ref))
    expect(rects(mine)).toBeGreaterThan(10)
  })

  it('copies repeat each unit label; duplicate codes in the request are printed once', () => {
    const cfg = labelConfigFor(resolveLabelSize({ presetId: '50x25' }), DEFAULT_LABEL_OPTIONS)
    const r = printing().renderLabelHtml({ unitCodes: ['spk-0001', 'SPK-0001 ', 'SPK-0002'], copies: 2, variantId, config: cfg })
    expect(count(r.html, /<div class="label bl">/g)).toBe(4)
    expect(count(r.html, /<div class="code">SPK-0001<\/div>/g)).toBe(2)
  })

  for (const preset of LABEL_PRESETS) {
    it(`${preset.id}: page size, barcode fits the label and is a readable width`, () => {
      const size = resolveLabelSize({ presetId: preset.id })
      const page = pageSizeOf(size)
      const cfg = labelConfigFor(size, DEFAULT_LABEL_OPTIONS)
      const r = printing().renderLabelHtml({ unitCodes: ['SPK-0001'], variantId, config: cfg })
      expect(r.widthMm).toBe(page.widthMm)
      expect(r.heightMm).toBe(page.heightMm)
      expect(r.html).toContain(`@page{size:${page.widthMm}mm ${page.heightMm}mm;margin:0}`)
      const w = Number(/<svg class="barcode"[^>]*style="width:([\d.]+)mm/.exec(r.html)?.[1])
      const inner = size.widthMm - Number(cfg.marginLeftMm) - Number(cfg.marginRightMm)
      expect(w).toBeLessThanOrEqual(inner + 1e-6)
      // Code 128 for "SPK-0001": 8 data chars -> 11*8 + 35 modules + 20 quiet = 143 modules; >= 0.2 mm per module scans on any reader
      expect(w / 143).toBeGreaterThanOrEqual(0.2)
      expect(w / 143).toBeLessThanOrEqual(0.5 + 1e-6)
    })
  }

  it('A4 sheet: 24 unit labels per sheet', () => {
    const cfg = labelConfigFor(resolveLabelSize({ presetId: 'a4-3x8' }), DEFAULT_LABEL_OPTIONS)
    const pages = (n: number) => count(printing().renderLabelHtml({ unitCodes: codes(n), variantId, config: cfg }).html, /<div class="sheet">/g)
    expect(pages(24)).toBe(1)
    expect(pages(25)).toBe(2)
  })

  it('shop name and logo options follow the profile: no hard-coded shop names', () => {
    const cfg = labelConfigFor(resolveLabelSize({ presetId: '60x40' }), DEFAULT_LABEL_OPTIONS)
    app.get<any>('businessProfile').save({ shopName: 'Renamed Mart', displayName: 'Renamed Mart' })
    const html = printing().renderLabelHtml({ unitCodes: ['SPK-0001'], variantId, config: cfg }).html
    expect(html).toContain('Renamed Mart')
    expect(html).not.toContain('Test Shop')
    const hidden = printing().renderLabelHtml({ unitCodes: ['SPK-0001'], variantId, config: labelConfigFor(resolveLabelSize({ presetId: '60x40' }), { ...DEFAULT_LABEL_OPTIONS, showShopName: false }) }).html
    expect(hidden).not.toContain('Renamed Mart')
    expect(hidden).toContain('<svg class="barcode"')
  })

  it('code text can be hidden but the barcode stays', () => {
    const cfg = labelConfigFor(resolveLabelSize({ presetId: '60x40' }), { ...DEFAULT_LABEL_OPTIONS, showBarcodeText: false })
    const html = printing().renderLabelHtml({ unitCodes: ['SPK-0001'], variantId, config: cfg }).html
    expect(html).not.toContain('class="code"')
    expect(html).toContain('<svg class="barcode"')
  })

  it('rejects an unknown product and a missing product reference', () => {
    expect(() => printing().renderLabelHtml({ unitCodes: ['SPK-0001'], variantId: 99999 })).toThrow(/not found/i)
    expect(() => printing().renderLabelHtml({ unitCodes: ['SPK-0001'] })).toThrow(/product is unknown/i)
  })

  it('ordinary (non-unit) labels are unchanged: EAN-13 still used for 13-digit barcodes', async () => {
    const code = (await cat('assignBarcode', { variantId })).barcode
    const html = printing().renderLabelHtml({ variantIds: [{ variantId, copies: 1 }], template: 'label_barcode' }).html
    expect(html).toContain(`<div class="code">${code}</div>`)
  })
})

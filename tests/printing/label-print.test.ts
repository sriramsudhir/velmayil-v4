import { describe, it, expect, beforeEach } from 'vitest'
import { createTestApp } from '../helpers'
import type { App } from '../../src/main/core/app'
import type { PrintingService } from '../../src/main/modules/printing/service'
import { formatINR } from '../../src/shared/money'
import { DEFAULT_LABEL_OPTIONS, LABEL_PRESETS, labelConfigFor, pageSizeOf, resolveLabelSize } from '../../src/shared/labelSizes'
import { FakePrinter } from './fixtures'

let app: App
let fake: FakePrinter
const cat = <T = any>(m: string, a?: unknown) => app.call('catalog', m, a) as Promise<T>
const printing = () => app.get<PrintingService>('printing')

const prod = (over: Record<string, unknown> = {}, variant: Record<string, unknown> = {}) => ({
  name: 'Sparkler Box', hsn: '3604', taxRateBp: 1800, variants: [{ name: '', mrp: 12000, price: 10000, cost: 7000, ...variant }], ...over
})

beforeEach(() => {
  app = createTestApp()
  fake = new FakePrinter()
  printing().setAdapter(fake)
})

describe('catalog.assignBarcode (Generate barcode saves it on the variant)', () => {
  it('generates a unique barcode (shop prefix + running number, A-Z 0-9) and persists it', async () => {
    const a = await cat('save', prod({ name: 'A' }))
    const b = await cat('save', prod({ name: 'B' }))
    const ra = await cat('assignBarcode', { variantId: a.variants[0].id })
    const rb = await cat('assignBarcode', { variantId: b.variants[0].id })
    expect(ra.replaced).toBe(false)
    for (const r of [ra, rb]) {
      expect(r.barcode).toMatch(/^[A-Z0-9]{5,18}$/)
    }
    expect(ra.barcode).not.toBe(rb.barcode)
    expect((await cat('get', { id: a.id })).variants[0].barcode).toBe(ra.barcode)
    expect((await cat('get', { id: b.id })).variants[0].barcode).toBe(rb.barcode)
    expect(app.lookup.byCode(ra.barcode)?.productName).toBe('A')
  })

  it('works per variant of a multi-variant product', async () => {
    const p = await cat('save', prod({ name: 'Shirt', variants: [{ name: 'M', price: 500 }, { name: 'L', price: 600 }] }))
    const r = await cat('assignBarcode', { variantId: p.variants[1].id })
    const after = await cat('get', { id: p.id })
    expect(after.variants[0].barcode).toBeFalsy()
    expect(after.variants[1].barcode).toBe(r.barcode)
  })

  it('never replaces an existing barcode without replace:true', async () => {
    const p = await cat('save', prod())
    const first = (await cat('assignBarcode', { variantId: p.variants[0].id })).barcode
    await expect(cat('assignBarcode', { variantId: p.variants[0].id })).rejects.toMatchObject({ code: 'CONFLICT', details: { code: 'BARCODE_EXISTS', barcode: first } })
    await expect(cat('assignBarcode', { variantId: p.variants[0].id, replace: false })).rejects.toMatchObject({ code: 'CONFLICT' })
    expect((await cat('get', { id: p.id })).variants[0].barcode).toBe(first)

    const r = await cat('assignBarcode', { variantId: p.variants[0].id, replace: true })
    expect(r.replaced).toBe(true)
    expect(r.previous).toBe(first)
    expect(r.barcode).not.toBe(first)
    expect((await cat('get', { id: p.id })).variants[0].barcode).toBe(r.barcode)
    // labels already printed with the old number keep scanning (kept as alias)
    expect(app.lookup.byCode(first)?.variantId).toBe(p.variants[0].id)
  })

  it('rejects an unknown variant', async () => {
    await expect(cat('assignBarcode', { variantId: 9999 })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('a price edit never changes the barcode', async () => {
    const p = await cat('save', prod())
    const code = (await cat('assignBarcode', { variantId: p.variants[0].id })).barcode
    const v = (await cat('get', { id: p.id })).variants[0]
    await cat('save', { ...prod({ id: p.id }), variants: [{ id: v.id, name: '', mrp: 15000, price: 9000, cost: 7000 }] })
    expect((await cat('get', { id: p.id })).variants[0].barcode).toBe(code)
  })
})

describe('label rendering for every size', () => {
  let variantId: number
  let code: string
  beforeEach(async () => {
    const p = await cat('save', prod({ name: 'Rose Fountain Deluxe' }, { mrp: 19900, price: 17500 }))
    variantId = p.variants[0].id
    code = (await cat('assignBarcode', { variantId })).barcode
  })

  for (const preset of LABEL_PRESETS) {
    it(`${preset.id}: @page size, shop, product, prices and a barcode that fits`, () => {
      const size = resolveLabelSize({ presetId: preset.id })
      const page = pageSizeOf(size)
      const cfg = labelConfigFor(size, DEFAULT_LABEL_OPTIONS)
      const r = printing().renderLabelHtml({ variantIds: [{ variantId, copies: 1 }], template: 'label_barcode', config: cfg })
      expect(r.widthMm).toBe(page.widthMm)
      expect(r.heightMm).toBe(page.heightMm)
      expect(r.html).toContain(`@page{size:${page.widthMm}mm ${page.heightMm}mm;margin:0}`)
      expect(r.html).toContain('Test Shop')
      expect(r.html).toContain('Rose Fountain Deluxe')
      expect(r.html).toContain(formatINR(17500))
      expect(r.html).toContain(formatINR(19900))
      expect(r.html).toContain(`<div class="code">${code}</div>`)
      expect(r.html).toContain('<svg class="barcode"')
      const w = Number(/<svg class="barcode"[^>]*style="width:([\d.]+)mm/.exec(r.html)?.[1])
      const inner = size.widthMm - Number(cfg.marginLeftMm) - Number(cfg.marginRightMm)
      expect(w).toBeLessThanOrEqual(inner + 1e-6)
      // sensible, uniform module width: a whole number of 203 dpi dots, >= 2 dots (0.25 mm, scannable) and never more than
      // 4 dots (0.5005 mm). The module count is read from the symbol itself (bars + quiet zones), whatever the code type.
      const modules = Number(/<svg class="barcode"[^>]*viewBox="0 0 (\d+) 100"/.exec(r.html)?.[1])
      const dots = w / modules / (25.4 / 203)
      expect(Math.abs(dots - Math.round(dots))).toBeLessThan(0.001)
      expect(Math.round(dots)).toBeGreaterThanOrEqual(2)
      expect(Math.round(dots)).toBeLessThanOrEqual(4)
      if (preset.sheet) expect(r.html).toContain(`grid-template-columns:repeat(${preset.sheet.cols},${preset.widthMm}mm)`)
    })
  }

  it('A4 sheet: 24 labels per page, then a new sheet', () => {
    const size = resolveLabelSize({ presetId: 'a4-3x8' })
    const cfg = labelConfigFor(size, DEFAULT_LABEL_OPTIONS)
    const pages = (n: number) => (printing().renderLabelHtml({ variantIds: [{ variantId, copies: n }], template: 'label_barcode', config: cfg }).html.match(/<div class="sheet">/g) ?? []).length
    expect(pages(24)).toBe(1)
    expect(pages(25)).toBe(2)
    expect(pages(48)).toBe(2)
  })

  it('single labels: one page per copy', () => {
    const cfg = labelConfigFor(resolveLabelSize({ presetId: '50x25' }), DEFAULT_LABEL_OPTIONS)
    const r = printing().renderLabelHtml({ variantIds: [{ variantId, copies: 3 }], template: 'label_barcode', config: cfg })
    expect((r.html.match(/<div class="label bl">/g) ?? []).length).toBe(3)
  })

  it('custom size is honoured and clamped', () => {
    const size = resolveLabelSize({ presetId: 'custom', customWidthMm: 45, customHeightMm: 28 })
    const r = printing().renderLabelHtml({ variantIds: [{ variantId, copies: 1 }], template: 'label_barcode', config: labelConfigFor(size, DEFAULT_LABEL_OPTIONS) })
    expect(r.html).toContain('@page{size:45mm 28mm;margin:0}')
    expect(resolveLabelSize({ presetId: 'custom', customWidthMm: 5, customHeightMm: 5000 })).toMatchObject({ widthMm: 20, heightMm: 297 })
  })

  it('content options hide shop name, product, variant, prices and barcode text', () => {
    const size = resolveLabelSize({ presetId: '60x40' })
    const cfg = labelConfigFor(size, { ...DEFAULT_LABEL_OPTIONS, showShopName: false, showProductName: false, showVariant: false, showMrp: false, showPrice: false, showBarcodeText: false })
    const html = printing().renderLabelHtml({ variantIds: [{ variantId, copies: 1 }], template: 'label_barcode', config: cfg }).html
    expect(html).not.toContain('Test Shop')
    expect(html).not.toContain('Rose Fountain')
    expect(html).not.toContain(formatINR(17500))
    expect(html).not.toContain('class="code"')
    expect(html).toContain('<svg class="barcode"')
  })

  it('uses the CURRENT shop profile', () => {
    app.get<any>('businessProfile').save({ shopName: 'Renamed Mart', displayName: 'Renamed Mart' })
    const html = printing().renderLabelHtml({ variantIds: [{ variantId, copies: 1 }], template: 'label_barcode', config: labelConfigFor(resolveLabelSize({ presetId: '50x25' }), DEFAULT_LABEL_OPTIONS) }).html
    expect(html).toContain('Renamed Mart')
    expect(html).not.toContain('Test Shop')
  })

  it('long product names shrink and are line-limited', () => {
    const long = 'Extra Long Premium Assorted Multicolour Rainbow Fountain Cracker Gift Box with Extra Sparklers'
    const cfg = labelConfigFor(resolveLabelSize({ presetId: '38x25' }), DEFAULT_LABEL_OPTIONS)
    const r = printing().renderLabelHtml({ variantIds: [{ variantId, copies: 1 }], template: 'label_barcode', config: cfg })
    const base = Number(cfg.fontSizePt)
    expect(Number(/class="pname" style="font-size:([\d.]+)pt;/.exec(r.html)?.[1])).toBe(base) // short name: not shrunk
    app.db.run('UPDATE products SET name = ? WHERE id = (SELECT product_id FROM product_variants WHERE id = ?)', long, variantId)
    const r2 = printing().renderLabelHtml({ variantIds: [{ variantId, copies: 1 }], template: 'label_barcode', config: cfg })
    expect(Number(/class="pname" style="font-size:([\d.]+)pt;/.exec(r2.html)?.[1])).toBeLessThan(base)
    expect(r2.html).toMatch(/-webkit-line-clamp:[1-4]"/)
  })
})

describe('printing labels (page size = label size) and failures', () => {
  let variantId: number
  let productId: number
  beforeEach(async () => {
    const p = await cat('save', prod())
    productId = p.id
    variantId = p.variants[0].id
  })

  it('print passes the chosen label size to the printer', async () => {
    const size = resolveLabelSize({ presetId: '75x50' })
    const cfg = labelConfigFor(size, DEFAULT_LABEL_OPTIONS)
    await cat('assignBarcode', { variantId })
    const r = printing().renderLabelHtml({ variantIds: [{ variantId, copies: 2 }], template: 'label_barcode', config: cfg })
    const res = await app.call('printing', 'print', { html: r.html, paper: 'label', widthMm: 75, heightMm: 50 }) as { ok: boolean }
    expect(res.ok).toBe(true)
    expect(fake.jobs[0].opts.widthMm).toBe(75)
    expect(fake.jobs[0].opts.heightMm).toBe(50)
  })

  it('a printer failure returns {ok:false} and the generated barcode stays saved', async () => {
    const code = (await cat('assignBarcode', { variantId })).barcode
    const html = printing().renderLabelHtml({ variantIds: [{ variantId, copies: 1 }], template: 'label_barcode', config: labelConfigFor(resolveLabelSize({ presetId: '50x25' }), DEFAULT_LABEL_OPTIONS) }).html
    fake.failWith = 'Printer offline'
    const res = await app.call('printing', 'print', { html, paper: 'label', widthMm: 50, heightMm: 25 }) as { ok: boolean; error?: string; logId?: number }
    expect(res.ok).toBe(false)
    expect(res.error).toContain('Printer offline')
    fake.failWith = null
    fake.throwWith = 'USB gone'
    const res2 = await app.call('printing', 'print', { html, paper: 'label', widthMm: 50, heightMm: 25 }) as { ok: boolean; error?: string }
    expect(res2).toMatchObject({ ok: false })
    expect((await cat('get', { id: productId })).variants[0].barcode).toBe(code)
    // retry works once the printer is back, and Save PDF is available as the fallback
    fake.throwWith = null
    expect(((await app.call('printing', 'print', { html, paper: 'label', widthMm: 50, heightMm: 25 })) as { ok: boolean }).ok).toBe(true)
    const pdf = await app.call('printing', 'exportPdf', { html, path: 'labels.pdf', paper: 'label', widthMm: 50, heightMm: 25 }) as { path: string }
    expect(pdf.path).toContain('labels')
    expect(fake.pdfs[0].opts).toMatchObject({ widthMm: 50, heightMm: 25 })
  })

  it('the label size is a template config (Printing > Templates stays consistent)', async () => {
    const size = resolveLabelSize({ presetId: '100x50' })
    await app.call('printing', 'saveTemplate', { kind: 'label_barcode', config: labelConfigFor(size, { ...DEFAULT_LABEL_OPTIONS, showLogo: false }) })
    const t = await app.call('printing', 'getTemplate', { kind: 'label_barcode' }) as { config: Record<string, unknown> }
    expect(t.config).toMatchObject({ paperWidthMm: 100, paperHeightMm: 50, labelPreset: '100x50', showBarcodeText: true, sheetCols: 0 })
    // print() with no explicit size falls back to this template
    const html = printing().renderLabelHtml({ variantIds: [{ variantId, copies: 1 }], template: 'label_barcode' }).html
    expect(html).toContain('@page{size:100mm 50mm;margin:0}')
  })
})

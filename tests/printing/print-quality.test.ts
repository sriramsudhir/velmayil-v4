import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTestApp } from '../helpers'
import type { App } from '../../src/main/core/app'
import type { BusinessProfile } from '../../src/shared/types'
import type { BusinessProfileService } from '../../src/main/modules/businessProfile/service'
import { isLandscapeJob, splitJobMeta, type PrintingService } from '../../src/main/modules/printing/service'
import {
  darknessCss, DIALOG_TIMEOUT_MS, imageDarkness, injectStyle, pageSizeMicrons, parseCalibration, prepareHtml, PRINT_TIMEOUT_MS, withTimeout
} from '../../src/main/modules/printing/adapter'
import {
  buildEscPosReceipt, buildEscPosTest, densityStepFor, doubleStrikeFor, EscPos, rasterFromPixels, rasterThresholdFor, RASTER_THRESHOLD_NORMAL
} from '../../src/main/modules/printing/escpos'
import type { RawPrintAdapter } from '../../src/main/modules/printing/rawPrinter'
import { renderInvoice, renderLabels, renderReport, renderTestPage } from '../../src/main/modules/printing/engine'
import { sampleInvoiceDoc } from '../../src/main/modules/printing/docBuilder'
import { barcodeSvg, qrSvg } from '../../src/main/modules/printing/barcode'
import { lookNote, previewDoc, previewHeightPx, previewWidthPx } from '../../src/renderer/modules/printing/previewDoc'
import { FakePrinter, insertSale, makePng } from './fixtures'

/** Print darkness on both print paths, WYSIWYG preview maths and the print-flow fixes. */

const profile = (over: Partial<BusinessProfile> = {}): BusinessProfile => ({
  id: 1, version: 1, shopName: 'Acme Traders', legalName: 'Acme Traders', displayName: 'Acme Traders', shortName: 'Acme',
  address: '12 Market Road', city: 'Madurai', state: 'Tamil Nadu', pinCode: '625001', phone: '9876543210', email: '', website: '',
  gstin: '33ABCDE1234F1Z5', pan: '', footerText: 'Thank you', logoAssetId: null,
  logoSettings: { visible: true, widthMm: 0, heightMm: 0, alignment: 'center', position: 'top' },
  headerSettings: { showLogo: true, showShopName: true, showAddress: true, showPhone: true, showGstin: true }, createdAt: 1, createdBy: null, ...over
})
const hex = (b: Buffer) => b.toString('hex')
const DOC = '<html><head><title>x</title><style>body{color:#000}</style></head><body><p>text</p><img class="logo" src="data:image/png;base64,AA"></body></html>'

// ============================================================================ calibration
describe('printer profile: darkness, logo brightness, resolution', () => {
  it('defaults are the old behaviour: darkness 5, logo 5, 203 dpi, density command allowed', () => {
    expect(parseCalibration({})).toMatchObject({ darkness: 5, logoBrightness: 5, dpi: 203, densityCommand: true })
    expect(parseCalibration(JSON.parse('{"offsetXmm":1,"scalePct":100,"silent":true}'))).toMatchObject({ darkness: 5, logoBrightness: 5, dpi: 203 }) // profiles saved before this setting
  })
  it('values are clamped to 1..9 whole steps; unknown resolutions fall back to 203', () => {
    expect(parseCalibration({ darkness: 99, logoBrightness: -3 })).toMatchObject({ darkness: 9, logoBrightness: 1 })
    expect(parseCalibration({ darkness: 6.4, logoBrightness: '7' })).toMatchObject({ darkness: 6, logoBrightness: 5 })
    expect(parseCalibration({ dpi: 300, densityCommand: false })).toMatchObject({ dpi: 300, densityCommand: false })
    expect(parseCalibration({ dpi: 1200 }).dpi).toBe(203)
  })
  it('logo brightness shifts the darkness that applies to pictures', () => {
    expect(imageDarkness(5, 5)).toBe(5)
    expect(imageDarkness(7, 5)).toBe(7)
    expect(imageDarkness(5, 8)).toBe(2) // brighter logo
    expect(imageDarkness(5, 2)).toBe(8) // darker logo
    expect(imageDarkness(9, 1)).toBe(9)
    expect(imageDarkness(1, 9)).toBe(1)
  })
})

// ============================================================================ Windows driver path
describe('darkness on the Windows-driver path (CSS)', () => {
  it('level 5 adds nothing: the job is exactly what it was before the setting existed', () => {
    expect(darknessCss(5)).toBe('')
    expect(darknessCss(5, 5)).toBe('')
    expect(darknessCss(undefined)).toBe('')
    expect(prepareHtml(DOC, { darkness: 5, logoBrightness: 5 })).toBe(prepareHtml(DOC, {}))
    expect(prepareHtml(DOC, {})).toBe(prepareHtml(DOC))
    expect(prepareHtml(DOC, {})).not.toContain('id="darkness"')
    // a real receipt, a real label and the old calibration options: untouched by the new code path
    const receipt = renderInvoice('receipt80', sampleInvoiceDoc(profile()), { qrEnabled: true, upiId: 'acme@upi' }, null).html
    const label = renderLabels('label_barcode', profile(), {}, null, [{ name: 'Rocket', variant: '', sku: 'R', barcode: '8901234567890', mrp: 1, price: 1, copies: 1 }]).html
    for (const html of [receipt, label]) {
      const out = prepareHtml(html, { darkness: 5 })
      expect(out.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '')).toBe(html)
    }
    expect(prepareHtml(DOC, { offsetXmm: 2, offsetYmm: -1.5, scalePct: 95 })).toContain('left:2mm;top:-1.5mm;zoom:0.95')
  })

  it('darker levels: a heavier stroke in the text colour, 0.1 pt per level; the logo gets darker', () => {
    expect(darknessCss(6)).toContain('body{-webkit-text-stroke:0.10pt currentColor}')
    expect(darknessCss(7)).toContain('body{-webkit-text-stroke:0.20pt currentColor}')
    expect(darknessCss(9)).toContain('body{-webkit-text-stroke:0.40pt currentColor}')
    expect(darknessCss(9)).toContain('img{filter:brightness(0.60) contrast(1.60)}')
    expect(darknessCss(6)).toContain('img{filter:brightness(0.90) contrast(1.15)}')
  })
  it('lighter levels: a paper-white stroke thins the glyphs (pure black and white, no grey); the logo gets lighter', () => {
    expect(darknessCss(4)).toContain('body{-webkit-text-stroke:0.08pt #fff}')
    expect(darknessCss(1)).toContain('body{-webkit-text-stroke:0.32pt #fff}')
    expect(darknessCss(1)).toContain('img{filter:brightness(1.48)}')
    for (let l = 1; l <= 9; l++) expect(darknessCss(l), String(l)).not.toMatch(/gr[ae]y|rgba?\(|opacity|#(?!fff\b)[0-9a-f]{3,6}/i)
  })
  it('never changes the layout: no font size, weight, width, margin or border is touched at any level', () => {
    for (let l = 1; l <= 9; l++) for (let b = 1; b <= 9; b += 4) expect(darknessCss(l, b), `${l}/${b}`).not.toMatch(/font-|width:|margin|padding|border|zoom|transform|letter-spacing/)
  })
  it('logo brightness works on its own and combines with the darkness', () => {
    expect(darknessCss(5, 8)).toBe('img{filter:brightness(1.36)}' + 'svg.barcode,svg.barcode *,svg.qr,svg.qr *{filter:none!important;-webkit-text-stroke:0!important;stroke:none!important;shape-rendering:crispEdges!important}')
    expect(darknessCss(5, 3)).toContain('img{filter:brightness(0.80) contrast(1.30)}')
    expect(darknessCss(5, 3)).not.toContain('text-stroke:0.') // text untouched
    expect(darknessCss(8, 8)).toContain('body{-webkit-text-stroke:0.30pt currentColor}')
    expect(darknessCss(8, 8)).not.toContain('img{') // darker text, logo back to normal
  })
  it('barcodes and QR codes are excluded at every level: the filter targets <img> only and the guard forbids stroke/filter on the symbols', () => {
    const svg = barcodeSvg('200000123', { heightMm: 9, maxWidthMm: 47 })
    const qr = qrSvg('upi://pay?pa=x@y', 20)
    const html = `<html><head></head><body>${svg}${qr}<img class="logo" src="data:image/png;base64,AA"></body></html>`
    for (let l = 1; l <= 9; l++) {
      if (l === 5) continue
      const css = darknessCss(l)
      expect(css).toContain('svg.barcode,svg.barcode *,svg.qr,svg.qr *{filter:none!important;-webkit-text-stroke:0!important;stroke:none!important;shape-rendering:crispEdges!important}')
      expect(css.replace(/svg\.barcode.*$/, '')).not.toMatch(/svg|rect|path|\*\{/) // no rule can reach the symbols
      const out = prepareHtml(html, { darkness: l })
      expect(out).toContain(svg) // bars byte-identical
      expect(out).toContain(qr)
      expect(out).toMatch(/<style id="darkness">[^<]+<\/style><\/head>/)
    }
  })
  it('injectStyle puts the block last in <head> (or in front of a head-less fragment)', () => {
    expect(injectStyle('<html><head><style>a{}</style></head><body></body></html>', 'x', 'b{}')).toBe('<html><head><style>a{}</style><style id="x">b{}</style></head><body></body></html>')
    expect(injectStyle('<p>$1</p>', 'x', 'b{}')).toBe('<style id="x">b{}</style><p>$1</p>')
  })
})

describe('thermal-safe layouts: no grey ink on receipts, labels or the test page', () => {
  const printCss = (html: string) => /<style>([\s\S]*?)<\/style>/.exec(html)![1].replace(/@media screen\{(?:[^{}]|\{[^{}]*\})*\}/g, '')
  const docs: [string, string][] = [
    ['receipt58', renderInvoice('receipt58', sampleInvoiceDoc(profile()), {}, null).html],
    ['receipt80', renderInvoice('receipt80', sampleInvoiceDoc(profile()), { qrEnabled: true, upiId: 'acme@upi' }, null).html],
    ['label_barcode', renderLabels('label_barcode', profile(), {}, null, [{ name: 'R', variant: '', sku: 'R', barcode: '200000123', mrp: 1, price: 1, copies: 1 }]).html],
    ['label_product', renderLabels('label_product', profile(), {}, null, [{ name: 'R', variant: '', sku: 'R', barcode: '200000123', mrp: 1, price: 1, copies: 1 }]).html],
    ['test 80', renderTestPage('80', profile(), {}, null).html],
    ['test label', renderTestPage('label', profile(), {}, null).html]
  ]
  for (const [name, html] of docs) {
    it(`${name}: every colour that prints is #000 or #fff, and no rule is thinner than 0.25 mm`, () => {
      const css = printCss(html)
      const colours = [...new Set(css.match(/#[0-9a-fA-F]{3,6}\b/g) ?? [])]
      expect(colours.filter((c) => !['#000', '#fff'].includes(c.toLowerCase())), css).toEqual([])
      expect(css).not.toMatch(/rgba?\(|opacity/)
      // 0.2 mm is 1.6 dots at 203 dpi: it prints as a faint 1-dot line or not at all
      expect(css).not.toMatch(/(?<![\d.])\.[01]\d*mm (?:solid|dotted|dashed)|(?<![\d.])0?\.5px|#000 \.[01]\d*mm/)
    })
  }
})

// ============================================================================ raw ESC/POS path
describe('darkness on the raw ESC/POS path', () => {
  const doc = sampleInvoiceDoc(profile())
  const DENSITY = (m: number) => '1d284b020031' + m.toString(16).padStart(2, '0')
  const STRIKE = '1b4701'

  it('level 5 (or no setting) is byte-identical to the receipt without the feature', () => {
    const plain = buildEscPosReceipt(doc, { paper: 80, cut: 'full', drawerKick: true })
    expect(buildEscPosReceipt(doc, { paper: 80, cut: 'full', drawerKick: true, darkness: 5 }).equals(plain)).toBe(true)
    expect(buildEscPosReceipt(doc, { paper: 80, cut: 'full', drawerKick: true, darkness: 5, densityCommand: true }).equals(plain)).toBe(true)
    expect(hex(plain)).not.toContain('1d284b')
    expect(hex(plain)).not.toContain('1b47')
    expect(buildEscPosTest(profile(), { paper: 58, darkness: 5 }).equals(buildEscPosTest(profile(), { paper: 58 }))).toBe(true)
  })

  it('mapping: logo threshold +/-15 per level around 160, density -6..+6, double-strike from level 7', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9].map(rasterThresholdFor)).toEqual([100, 115, 130, 145, 160, 175, 190, 205, 220])
    expect(RASTER_THRESHOLD_NORMAL).toBe(160)
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9].map(densityStepFor)).toEqual([-6, -4, -3, -1, 0, 1, 3, 4, 6])
    expect([1, 5, 6, 7, 9].map(doubleStrikeFor)).toEqual([false, false, false, true, true])
    expect([rasterThresholdFor(undefined), densityStepFor('x'), rasterThresholdFor(40), densityStepFor(-2)]).toEqual([160, 0, 220, -6])
  })

  it('commands: GS ( K function 49 (negative steps as 250..255) and ESC G', () => {
    expect(hex(new EscPos().density(3).build())).toBe('1d284b02003103')
    expect(hex(new EscPos().density(-1).build())).toBe('1d284b020031ff')
    expect(hex(new EscPos().density(-6).build())).toBe('1d284b020031fa')
    expect(hex(new EscPos().density(99).build())).toBe('1d284b02003106')
    expect(hex(new EscPos().doubleStrike(true).doubleStrike(false).build())).toBe('1b4701' + '1b4700')
  })

  it('darker: density command right after ESC @, then double-strike; the rest of the receipt is unchanged', () => {
    const plain = hex(buildEscPosReceipt(doc, { paper: 80 }))
    const d8 = hex(buildEscPosReceipt(doc, { paper: 80, darkness: 8 }))
    expect(d8).toBe('1b40' + DENSITY(4) + STRIKE + plain.slice(4))
    const d6 = hex(buildEscPosReceipt(doc, { paper: 80, darkness: 6 }))
    expect(d6).toBe('1b40' + DENSITY(1) + plain.slice(4)) // one step: density only, text not double-struck
  })
  it('lighter: density down, never double-strike', () => {
    const plain = hex(buildEscPosReceipt(doc, { paper: 80 }))
    expect(hex(buildEscPosReceipt(doc, { paper: 80, darkness: 2 }))).toBe('1b40' + DENSITY(252) + plain.slice(4))
  })
  it('densityCommand:false keeps the portable part only (printers that do not know GS ( K)', () => {
    const plain = hex(buildEscPosReceipt(doc, { paper: 80 }))
    expect(hex(buildEscPosReceipt(doc, { paper: 80, darkness: 9, densityCommand: false }))).toBe('1b40' + STRIKE + plain.slice(4))
    expect(hex(buildEscPosReceipt(doc, { paper: 80, darkness: 3, densityCommand: false }))).toBe(plain)
  })
  it('the raw test page names the level so the print can be compared', () => {
    expect(buildEscPosTest(profile(), { paper: 80, darkness: 8 }).toString('latin1')).toContain('Print darkness 8 of 9')
    expect(buildEscPosTest(profile(), { paper: 80 }).toString('latin1')).not.toContain('Print darkness')
  })
  it('logo threshold: a mid-grey pixel is white at normal, black when darker, and a dark grey turns white when lighter', () => {
    const px = (v: number) => Buffer.from([v, v, v, 255])
    const on = (v: number, level: number) => rasterFromPixels(px(v), 1, 1, { order: 'rgba', threshold: rasterThresholdFor(level) }).data[0] === 0x80
    expect(on(170, 5)).toBe(false)
    expect(on(170, 6)).toBe(true)
    expect(on(150, 5)).toBe(true)
    expect(on(150, 4)).toBe(false)
    expect(on(0, 1)).toBe(true) // black stays black at the lightest level
    expect(on(255, 9)).toBe(false) // white stays white at the darkest
  })
})

// ============================================================================ adapter helpers
describe('print job helpers', () => {
  it('page size in microns; landscape passes the portrait sheet plus the flag', () => {
    expect(pageSizeMicrons(50, 25)).toEqual({ width: 50000, height: 25000 }) // a label is NOT rotated
    expect(pageSizeMicrons(38.1, 25.4)).toEqual({ width: 38100, height: 25400 })
    expect(pageSizeMicrons(58, 123.4567)).toEqual({ width: 58000, height: 123457 })
    expect(pageSizeMicrons(297, 210, true)).toEqual({ width: 210000, height: 297000 })
    expect(pageSizeMicrons(210, 297, true)).toEqual({ width: 210000, height: 297000 })
  })
  it('isLandscapeJob: only cut sheets, from the page size or a wide @page rule', () => {
    expect(isLandscapeJob('A4', '', 297, 210)).toBe(true)
    expect(isLandscapeJob('A4', '', 210, 297)).toBe(false)
    expect(isLandscapeJob('A4', '<style>@page{size:297mm 210mm;margin:10mm}</style>', 210, 297)).toBe(true)
    expect(isLandscapeJob('A4', '<style>@page{size:210mm 297mm;margin:10mm}</style>', 210, 297)).toBe(false)
    expect(isLandscapeJob('label', '<style>@page{size:50mm 25mm;margin:0}</style>', 50, 25)).toBe(false) // wide labels are not "landscape"
    expect(isLandscapeJob('80', '', 80, 0)).toBe(false)
  })
  describe('withTimeout', () => {
    beforeEach(() => { vi.useFakeTimers() })
    afterEach(() => { vi.useRealTimers() })
    it('a job that never answers is given up after the timeout instead of hanging for ever', async () => {
      const never = new Promise<string>(() => {})
      const p = withTimeout(never, PRINT_TIMEOUT_MS, () => 'timeout')
      await vi.advanceTimersByTimeAsync(PRINT_TIMEOUT_MS - 1)
      let done = false
      void p.then(() => { done = true })
      await Promise.resolve()
      expect(done).toBe(false)
      await vi.advanceTimersByTimeAsync(2)
      expect(await p).toBe('timeout')
    })
    it('a job that answers in time wins, rejections pass through, and the timer is cleared', async () => {
      expect(await withTimeout(Promise.resolve('ok'), 1000, () => 'timeout')).toBe('ok')
      await expect(withTimeout(Promise.reject(new Error('boom')), 1000, () => 'timeout')).rejects.toThrow('boom')
      expect(vi.getTimerCount()).toBe(0)
    })
    it('the Windows print dialog gets far longer than a silent job', () => {
      expect(PRINT_TIMEOUT_MS).toBe(60_000)
      expect(DIALOG_TIMEOUT_MS).toBeGreaterThanOrEqual(5 * 60_000)
    })
  })
  it('splitJobMeta reads the page size kept with a failed job; old log rows without it still work', () => {
    expect(splitJobMeta('<html>x</html><!--print-job {"w":75,"h":50,"c":3}-->')).toEqual({ html: '<html>x</html>', meta: { w: 75, h: 50, c: 3 } })
    expect(splitJobMeta('<html>x</html>')).toEqual({ html: '<html>x</html>', meta: {} })
    expect(splitJobMeta('<html>x</html><!--print-job {bad}-->')).toEqual({ html: '<html>x</html>', meta: {} })
  })
})

// ============================================================================ reports: landscape
describe('landscape reports', () => {
  const spec = { title: 'Stock', columns: [{ key: 'a', header: 'A' }], rows: [{ a: 1 }] }
  it('the @page rule is valid CSS (wide size, no "landscape" keyword after lengths) and the page is 297 x 210', () => {
    const r = renderReport('report_sales', profile(), { landscape: true }, null, spec)
    expect(r.html).toContain('@page{size:297mm 210mm;margin:10mm 10mm 10mm 10mm}')
    expect(r.html).not.toMatch(/@page\{size:[^;}]*landscape/)
    expect(r).toMatchObject({ widthMm: 297, heightMm: 210 })
  })
  it('portrait reports have a real sheet height (0 would mean "roll paper: measure the content")', () => {
    const r = renderReport('report_sales', profile(), {}, null, spec)
    expect(r.html).toContain('@page{size:210mm 297mm;margin:')
    expect(r).toMatchObject({ widthMm: 210, heightMm: 297 })
  })
})

// ============================================================================ preview (DEF-6)
describe('print preview is WYSIWYG (DEF-6)', () => {
  const MM = 96 / 25.4
  it('the frame is never narrower than the paper (58 mm = 219.2 px used to be cut to 219 px)', () => {
    for (const mm of [58, 80, 148, 210, 50, 38, 100, 297]) {
      expect(previewWidthPx(mm), String(mm)).toBeGreaterThanOrEqual(mm * MM - 0.011)
      expect(previewWidthPx(mm) - mm * MM, String(mm)).toBeLessThan(1)
    }
    expect(previewWidthPx(58)).toBe(220)
    expect(previewWidthPx(80)).toBe(303)
  })
  it('the frame is as tall as the content (roll paper) or at least the page (sheets, labels)', () => {
    expect(previewHeightPx(0, 0)).toBe(120)
    expect(previewHeightPx(0, 913)).toBe(913)
    expect(previewHeightPx(25, 80)).toBe(95)
    expect(previewHeightPx(25, 300)).toBe(300)
    expect(previewHeightPx(297, 0)).toBe(1123)
  })
  it('the frame cannot show its own scrollbars, so nothing is taken off the paper width', () => {
    const html = renderInvoice('receipt58', sampleInvoiceDoc(profile()), {}, null).html
    const doc = previewDoc(html)
    expect(doc).toContain('<style id="preview">html{overflow:hidden!important}</style></head>')
    expect(doc.replace('<style id="preview">html{overflow:hidden!important}</style>', '')).toBe(html) // nothing else changes
    expect(previewDoc('<p>x</p>')).toBe('<style id="preview">html{overflow:hidden!important}</style><p>x</p>')
  })
  it('the darkness CSS of the printer profile is drawn in the preview, after the document styles', () => {
    const doc = previewDoc(DOC, darknessCss(8))
    expect(doc).toContain('html{overflow:hidden!important}body{-webkit-text-stroke:0.30pt currentColor}')
    expect(doc.indexOf('id="preview"')).toBeGreaterThan(doc.indexOf('body{color:#000}'))
  })
  it('the note says which darkness is shown and that the paper depends on the printer', () => {
    expect(lookNote(null)).toBe('')
    expect(lookNote({ darkness: 5, logoBrightness: 5, css: '', printer: '' })).toMatch(/^Shown with print darkness 5 \(normal\)\. .*depends on the printer/)
    expect(lookNote({ darkness: 8, logoBrightness: 5, css: 'x', printer: 'Counter 80' })).toMatch(/print darkness 8 of 9 of printer "Counter 80"\. .*density set in its Windows driver/)
  })
})

// ============================================================================ through the service (DB-backed)
class FakeRaw implements RawPrintAdapter {
  jobs: { device: string; bytes: Buffer }[] = []
  fail: string | null = null
  async sendRaw(device: string, bytes: Buffer) {
    if (this.fail) return { ok: false, error: this.fail }
    this.jobs.push({ device, bytes })
    return { ok: true }
  }
}

describe('PrintingService', () => {
  let app: App
  let svc: PrintingService
  let fake: FakePrinter
  let raw: FakeRaw
  let saleId: number
  const bp = () => app.get<BusinessProfileService>('businessProfile')
  beforeEach(() => {
    app = createTestApp()
    svc = app.get<PrintingService>('printing')
    fake = new FakePrinter()
    raw = new FakeRaw()
    svc.setAdapter(fake)
    svc.setRawAdapter(raw)
    saleId = insertSale(app, { invoiceNo: 'INV-Q-1', profileVersionId: bp().getActive().id })
  })

  describe('darkness', () => {
    it('is stored on the printer profile and survives a round trip through the service API', async () => {
      const saved = (await app.call('printing', 'savePrinterProfile', { name: 'Counter', deviceName: 'POS-58-USB', kind: 'receipt58', isDefault: true, calibration: { darkness: 8, logoBrightness: 3, dpi: 300, densityCommand: false } })) as { id: number; calibration: Record<string, unknown> }
      expect(saved.calibration).toMatchObject({ darkness: 8, logoBrightness: 3, dpi: 300, densityCommand: false })
      expect(svc.listPrinterProfiles()[0].calibration).toMatchObject({ darkness: 8, logoBrightness: 3, dpi: 300 })
      expect(JSON.parse(app.db.value<string>('SELECT calibration_json FROM printer_profiles WHERE id = ?', saved.id)!)).toMatchObject({ darkness: 8 })
    })
    it('driver jobs carry the darkness CSS of the profile they print on; a normal profile sends the document as before', async () => {
      const html = svc.renderInvoiceHtml({ saleId, template: 'receipt80' }).html
      await svc.print({ html, paper: '80' })
      expect(fake.jobs[0].html).not.toContain('id="darkness"')
      const dark = svc.savePrinterProfile({ name: 'Dark', deviceName: 'POS-58-USB', kind: 'receipt80', isDefault: true, calibration: { darkness: 7 } })
      await svc.print({ html, paper: '80' })
      expect(fake.jobs[1].html).toContain('<style id="darkness">body{-webkit-text-stroke:0.20pt currentColor}')
      // only the style block was added
      expect(fake.jobs[1].html.replace(/<style id="darkness">[^<]*<\/style>/, '')).toBe(fake.jobs[0].html)
      svc.savePrinterProfile({ id: dark.id, name: 'Dark', deviceName: 'POS-58-USB', kind: 'receipt80', isDefault: true, calibration: { darkness: 5 } })
      await svc.print({ html, paper: '80' })
      expect(fake.jobs[2].html).toBe(fake.jobs[0].html)
    })
    it('printLook gives previews the same CSS the job gets', async () => {
      expect(svc.printLook({ paper: '80' })).toEqual({ darkness: 5, logoBrightness: 5, css: '', printer: '' })
      svc.savePrinterProfile({ name: 'Dark', deviceName: 'POS-58-USB', kind: 'receipt80', isDefault: true, calibration: { darkness: 3, logoBrightness: 6 } })
      const look = (await app.call('printing', 'printLook', { paper: '80' })) as { darkness: number; css: string; printer: string }
      expect(look).toMatchObject({ darkness: 3, logoBrightness: 6, printer: 'Dark', css: darknessCss(3, 6) })
      expect(svc.printLook({ paper: 'A4' }).css).toBe('') // other paper, other printer
    })
    it('raw receipts: density + double-strike from the profile, and the logo threshold follows darkness and logo brightness', async () => {
      svc.savePrinterProfile({ name: 'T80', deviceName: 'POS-58-USB', kind: 'receipt80', isDefault: true, calibration: { raw: true, darkness: 8 } })
      // one mid-grey row: white at the normal threshold (160), black at level 8 (205)
      svc.setLogoDecoder(() => ({ width: 8, height: 1, order: 'rgba', pixels: Buffer.from(Array.from({ length: 8 }, () => [180, 180, 180, 255]).flat()) }))
      bp().setLogo({ data: makePng(300, 150) })
      const sale = insertSale(app, { invoiceNo: 'INV-Q-2', profileVersionId: bp().getActive().id })
      await svc.printInvoice({ saleId: sale, template: 'receipt80' })
      expect(hex(raw.jobs[0].bytes).startsWith('1b40' + '1d284b02003104' + '1b4701')).toBe(true)
      expect(hex(raw.jobs[0].bytes)).toContain('1d763000' + '0100' + '0100' + 'ff')
      // a brighter logo setting pulls the picture back to normal while the text stays dark
      svc.savePrinterProfile({ id: svc.listPrinterProfiles()[0].id, name: 'T80', deviceName: 'POS-58-USB', kind: 'receipt80', isDefault: true, calibration: { raw: true, darkness: 8, logoBrightness: 8 } })
      await svc.printInvoice({ saleId: sale, template: 'receipt80' })
      expect(hex(raw.jobs[1].bytes)).toContain('1d763000' + '0100' + '0100' + '00')
      // normal profile: no extra bytes at all
      svc.savePrinterProfile({ id: svc.listPrinterProfiles()[0].id, name: 'T80', deviceName: 'POS-58-USB', kind: 'receipt80', isDefault: true, calibration: { raw: true } })
      await svc.printInvoice({ saleId: sale, template: 'receipt80' })
      expect(hex(raw.jobs[2].bytes).startsWith('1b40' + '1b6101' + '1d763000')).toBe(true)
    })
    it('test print shows the level of the printer it goes to (driver and raw)', async () => {
      svc.savePrinterProfile({ name: 'Lbl', deviceName: 'Office A4', kind: 'label', isDefault: true, calibration: { darkness: 7, dpi: 300 } })
      const r = await svc.testPrint({ paper: 'label' })
      expect(r.ok).toBe(true)
      expect(fake.jobs[0].html).toContain('Print darkness 7 of 9')
      expect(fake.jobs[0].html).toContain('300 dpi')
      expect(fake.jobs[0].html).toContain('<style id="darkness">')
      svc.savePrinterProfile({ name: 'T58', deviceName: 'POS-58-USB', kind: 'receipt58', isDefault: true, calibration: { raw: true, darkness: 9 } })
      await svc.testPrint({ paper: '58' })
      expect(raw.jobs[0].bytes.toString('latin1')).toContain('Print darkness 9 of 9')
    })
  })

  describe('labels use the resolution of the label printer', () => {
    it('renderLabelHtml sizes bars for the default label printer; print re-snaps for the printer actually used', async () => {
      const p = app.db.run("INSERT INTO products(uuid,name) VALUES (?,'Flower Pot')", app.uuid()).lastId
      const v = app.db.run('INSERT INTO product_variants(uuid,product_id,name,sku,barcode,mrp,price) VALUES (?,?,?,?,?,?,?)', app.uuid(), p, 'Big', 'FP-1', '200000123', 15000, 12000).lastId
      const width = (html: string) => Number(/<svg class="barcode"[^>]*style="width:([\d.]+)mm/.exec(html)![1])
      const at203 = svc.renderLabelHtml({ variantIds: [{ variantId: v }], template: 'label_barcode' })
      expect(width(at203.html) / (25.4 / 203)).toBeCloseTo(121 * 3, 2)
      const hi = svc.savePrinterProfile({ name: 'Hi-res labels', deviceName: 'Office A4', kind: 'label', isDefault: true, calibration: { dpi: 300 } })
      const at300 = svc.renderLabelHtml({ variantIds: [{ variantId: v }], template: 'label_barcode' })
      expect(width(at300.html) / (25.4 / 300)).toBeCloseTo(121 * 4, 2)
      // the 203 dpi document sent to the 300 dpi printer is re-snapped at print time
      await svc.print({ html: at203.html, paper: 'label', printerProfileId: hi.id, widthMm: 50, heightMm: 25 })
      expect(width(fake.jobs[0].html) / (25.4 / 300)).toBeCloseTo(121 * 4, 2)
    })
    it('a code that does not fit is reported by renderLabelHtml (also through the IPC API)', async () => {
      const p = app.db.run("INSERT INTO products(uuid,name) VALUES (?,'Long code')", app.uuid()).lastId
      const v = app.db.run('INSERT INTO product_variants(uuid,product_id,name,sku,barcode,mrp,price) VALUES (?,?,?,?,?,?,?)', app.uuid(), p, '', 'LC-1', 'VM0001234567890123', 15000, 12000).lastId
      const r = (await app.call('printing', 'renderLabelHtml', { variantIds: [{ variantId: v }], template: 'label_barcode', config: { paperWidthMm: 20, paperHeightMm: 15 } })) as { warnings?: string[]; html: string }
      expect(r.warnings?.[0]).toContain('Barcode too long for this label width')
      expect(r.html).not.toContain('<svg class="barcode"')
      const ok = (await app.call('printing', 'renderLabelHtml', { variantIds: [{ variantId: v }], template: 'label_barcode' })) as { warnings?: string[] }
      expect(ok.warnings).toBeUndefined()
    })
  })

  describe('saved Windows printer no longer exists', () => {
    beforeEach(() => {
      // Electron answers "Invalid deviceName provided" for a printer that is not installed
      const real = fake.print.bind(fake)
      fake.print = async (html, opts) => (opts.deviceName && !fake.printers.some((p) => p.name === opts.deviceName) ? { ok: false, error: 'Invalid deviceName provided' } : real(html, opts))
    })
    it('falls back to the Windows default printer and says so (result, log)', async () => {
      svc.savePrinterProfile({ name: 'Old counter', deviceName: 'POS-80-GONE', kind: 'receipt80', isDefault: true })
      const r = await svc.printInvoice({ saleId, template: 'receipt80' })
      expect(r.ok).toBe(true)
      expect(r.warning).toBe('Printer "POS-80-GONE" was not found in Windows, so this was printed on the Windows default printer (POS-58 USB). Choose the printer again under Printing > Printers.')
      expect(fake.jobs).toHaveLength(1)
      expect(fake.jobs[0].opts.deviceName).toBe('')
      expect(svc.listPrintLog()[0]).toMatchObject({ ok: true, printer: 'POS-58-USB', error: expect.stringContaining('was not found in Windows') })
    })
    it('the cash drawer is not pulsed on the missing printer', async () => {
      svc.savePrinterProfile({ name: 'Old counter', deviceName: 'POS-80-GONE', kind: 'receipt80', isDefault: true, calibration: { drawerKick: true } })
      expect((await svc.printInvoice({ saleId, template: 'receipt80' })).ok).toBe(true)
      expect(raw.jobs).toHaveLength(0)
    })
    it('no default printer in Windows: a clear error, the job is kept for retry', async () => {
      fake.printers = [{ name: 'Office A4', displayName: 'Office A4', isDefault: false }]
      svc.savePrinterProfile({ name: 'Old counter', deviceName: 'POS-80-GONE', kind: 'receipt80', isDefault: true })
      const r = await svc.print({ html: '<html><head></head><body>x</body></html>', paper: '80' })
      expect(r.ok).toBe(false)
      expect(r.error).toBe('Invalid deviceName provided. Printer "POS-80-GONE" was not found in Windows and Windows has no default printer. Choose the printer again under Printing > Printers.')
      expect(svc.listPrintLog({ onlyFailed: true })[0]).toMatchObject({ retryable: true })
    })
    it('the default printer fails too: both facts are reported', async () => {
      svc.savePrinterProfile({ name: 'Old counter', deviceName: 'POS-80-GONE', kind: 'receipt80', isDefault: true })
      const real = fake.print
      fake.print = async (html, opts) => (opts.deviceName === '' ? { ok: false, error: 'Out of paper' } : real(html, opts))
      const r = await svc.print({ html: '<html><head></head><body>x</body></html>', paper: '80' })
      expect(r).toMatchObject({ ok: false, error: expect.stringContaining('the Windows default printer did not print it either') })
    })
    it('a printer that exists but fails is NOT redirected: the real error is shown unchanged', async () => {
      svc.savePrinterProfile({ name: 'Counter', deviceName: 'POS-58-USB', kind: 'receipt80', isDefault: true })
      fake.failWith = 'Out of paper'
      const r = await svc.print({ html: '<html><head></head><body>x</body></html>', paper: '80' })
      expect(r).toMatchObject({ ok: false, error: 'Out of paper' })
      expect(r.warning).toBeUndefined()
    })
    it('raw jobs are never sent to another printer; the error names the missing printer', async () => {
      svc.savePrinterProfile({ name: 'Old counter', deviceName: 'POS-80-GONE', kind: 'receipt80', isDefault: true, calibration: { raw: true } })
      raw.fail = "Raw printing failed: Cannot open printer 'POS-80-GONE' (error 1801)"
      const r = await svc.printInvoice({ saleId, template: 'receipt80' })
      expect(r).toMatchObject({ ok: false, mode: 'raw' })
      expect(r.error).toContain('Printer "POS-80-GONE" was not found in Windows: choose the printer again under Printing > Printers.')
      expect(fake.jobs).toHaveLength(0)
    })
  })

  describe('a remembered printer profile that was deleted', () => {
    it('prints on the default profile for the paper with a warning instead of failing every receipt', async () => {
      const gone = svc.savePrinterProfile({ name: 'Temp', deviceName: 'Office A4', kind: 'receipt80' })
      svc.savePrinterProfile({ name: 'Counter', deviceName: 'POS-58-USB', kind: 'receipt80', isDefault: true })
      svc.deletePrinterProfile(gone.id)
      const r = await svc.printInvoice({ saleId, template: 'receipt80', printerProfileId: gone.id })
      expect(r.ok).toBe(true)
      expect(r.warning).toMatch(/selected printer profile no longer exists/)
      expect(fake.jobs[0].opts.deviceName).toBe('POS-58-USB')
      // raw path too
      svc.savePrinterProfile({ id: svc.listPrinterProfiles()[0].id, name: 'Counter', deviceName: 'POS-58-USB', kind: 'receipt80', isDefault: true, calibration: { raw: true } })
      const r2 = await svc.printInvoice({ saleId, template: 'receipt80', printerProfileId: gone.id })
      expect(r2).toMatchObject({ ok: true, mode: 'raw', warning: expect.stringMatching(/no longer exists/) })
      expect(raw.jobs[0].device).toBe('POS-58-USB')
    })
  })

  describe('retry, copies, page sizes', () => {
    it('retry from the print log prints the same page size and copies as the failed job', async () => {
      fake.failWith = 'Jammed'
      const res = await svc.print({ html: '<html><head></head><body>labels</body></html>', paper: 'label', widthMm: 75, heightMm: 50, copies: 3, docRef: 'labels-3' })
      expect(res.ok).toBe(false)
      fake.failWith = null
      const retry = await svc.retryPrint({ logId: res.logId! })
      expect(retry.ok).toBe(true)
      expect(fake.jobs[0].opts).toMatchObject({ widthMm: 75, heightMm: 50, copies: 3 })
      expect(fake.jobs[0].html).not.toContain('print-job') // the bookkeeping comment is not printed
      expect(fake.jobs[0].html).toContain('<body>labels</body>')
    })
    it('a retried receipt is still a roll job (height measured), a retry that fails again stays retryable', async () => {
      fake.failWith = 'Jammed'
      const res = await svc.print({ html: '<html><head></head><body>r</body></html>', paper: '80', widthMm: 80, heightMm: 0 })
      const again = await svc.retryPrint({ logId: res.logId! })
      expect(again.ok).toBe(false)
      fake.failWith = null
      expect((await svc.retryPrint({ logId: again.logId! })).ok).toBe(true)
      expect(fake.jobs[0].opts).toMatchObject({ widthMm: 80, heightMm: 0, copies: 1 })
    })
    it('cut sheets always get a sheet height: A4 width without height is 297 mm, not "measure the content"', async () => {
      await svc.print({ html: '<html></html>', paper: 'A4', widthMm: 210 })
      await svc.print({ html: '<html></html>', paper: 'A5', widthMm: 148, heightMm: 0 })
      await svc.print({ html: '<html></html>', paper: '80', widthMm: 80 })
      expect(fake.jobs.map((j) => [j.opts.widthMm, j.opts.heightMm])).toEqual([[210, 297], [148, 210], [80, 0]])
    })
    it('a landscape report is printed and exported landscape (portrait sheet + flag); portrait jobs are not', async () => {
      const land = svc.renderReportHtml({ title: 'Stock', columns: [{ key: 'a', header: 'A' }], rows: [{ a: 1 }], config: { landscape: true } })
      await svc.print({ html: land.html, paper: 'A4' }) // how the Reports page prints
      expect(fake.jobs[0].opts).toMatchObject({ widthMm: 210, heightMm: 297, landscape: true })
      await svc.print({ html: land.html, paper: 'A4', widthMm: land.widthMm, heightMm: land.heightMm })
      expect(fake.jobs[1].opts).toMatchObject({ widthMm: 297, heightMm: 210, landscape: true })
      await svc.exportPdf({ html: land.html, paper: 'A4', name: 'report' })
      expect(fake.pdfs[0].opts).toMatchObject({ landscape: true })
      const port = svc.renderReportHtml({ title: 'Stock', columns: [{ key: 'a', header: 'A' }], rows: [{ a: 1 }] })
      await svc.print({ html: port.html, paper: 'A4' })
      expect(fake.jobs[2].opts.landscape).toBe(false)
      await svc.print({ html: svc.renderInvoiceHtml({ saleId, template: 'receipt80' }).html, paper: '80' })
      expect(fake.jobs[3].opts.landscape).toBe(false)
    })
    it('raw copies: every copy is printed (up to 50) and the cash drawer opens once, not once per copy', async () => {
      svc.savePrinterProfile({ name: 'T80', deviceName: 'POS-58-USB', kind: 'receipt80', isDefault: true, calibration: { raw: true, drawerKick: true } })
      await svc.printInvoice({ saleId, template: 'receipt80', copies: 3 })
      const h = hex(raw.jobs[0].bytes)
      expect(h.split('1b40').length - 1).toBe(3) // three receipts
      expect(h.split('1b700019fa').length - 1).toBe(1) // one drawer pulse
      expect(h.startsWith('1b40' + '1b700019fa')).toBe(true)
      await svc.printInvoice({ saleId, template: 'receipt80', copies: 12 })
      expect(hex(raw.jobs[1].bytes).split('1b40').length - 1).toBe(12) // used to be cut to 10 silently
    })
  })
})

// ============================================================================ POS print adapter (renderer)
describe('pos/printAdapter', () => {
  const calls: { service: string; method: string; args: any }[] = []
  let answer: (service: string, method: string, args: any) => unknown
  const store = new Map<string, string>()
  beforeEach(() => {
    calls.length = 0
    store.clear()
    vi.stubGlobal('window', { velmayil: { call: async (service: string, method: string, args: unknown) => { calls.push({ service, method, args }); return answer(service, method, args) } } })
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) })
  })
  afterEach(() => { vi.unstubAllGlobals() })
  const load = () => import('../../src/renderer/modules/pos/printAdapter')
  const okData = (data: unknown) => ({ ok: true, data })
  const fail = (code: string, message: string) => ({ ok: false, error: { code, message } })

  it('passes a warning from the printing service on to the screen', async () => {
    answer = () => okData({ ok: true, logId: 7, warning: 'Printed on the Windows default printer' })
    const { printDocument } = await load()
    expect(await printDocument({ saleId: 1 }, 'receipt80', 3)).toEqual({ ok: true, logId: 7, warning: 'Printed on the Windows default printer' })
    expect(calls[0]).toMatchObject({ method: 'printInvoice', args: { saleId: 1, template: 'receipt80', printerProfileId: 3 } })
  })
  it('a printer failure is returned, never thrown, with the log id for Retry', async () => {
    answer = () => okData({ ok: false, error: 'Out of paper', logId: 9 })
    const { printDocument, retryPrint } = await load()
    expect(await printDocument({ saleId: 1 }, 'receipt58')).toEqual({ ok: false, error: 'Out of paper', logId: 9 })
    expect(await retryPrint(9)).toEqual({ ok: false, error: 'Out of paper', logId: 9 })
    answer = () => okData(null)
    expect(await printDocument({ saleId: 1 }, 'receipt58')).toEqual({ ok: false, error: 'The printer did not accept the job.', logId: undefined })
  })
  it('a real answer from the service ("...not found", validation) is shown as it is, not as "printing is not available"', async () => {
    const { printDocument, retryPrint, missing } = await load()
    answer = () => fail('NOT_FOUND', 'This job cannot be retried (document was not kept). Reprint it from the sale.')
    expect(await retryPrint(5)).toEqual({ ok: false, error: 'This job cannot be retried (document was not kept). Reprint it from the sale.' })
    answer = () => fail('VALIDATION', 'printerProfileId: Expected number')
    expect((await printDocument({ saleId: 1 }, 'receipt80')).error).toBe('printerProfileId: Expected number')
    expect(calls).toHaveLength(2) // no blind second attempt through another method
    expect(missing(new Error('Unknown service method printing.printInvoice'))).toBe(true)
    expect(missing(new Error('Sale 12 not found'))).toBe(false)
  })
  it('an old build without printInvoice falls back to render + print; no printing service at all is said plainly', async () => {
    const { printDocument } = await load()
    answer = (_s, m) => (m === 'printInvoice' ? fail('NOT_FOUND', 'Unknown service method printing.printInvoice') : m === 'renderInvoiceHtml' ? okData({ html: '<p>r</p>', docRef: 'INV-1' }) : okData({ ok: true, logId: 2 }))
    expect(await printDocument({ saleId: 1 }, 'receipt80')).toEqual({ ok: true, logId: 2 })
    expect(calls.map((c) => c.method)).toEqual(['printInvoice', 'renderInvoiceHtml', 'print'])
    expect(calls[2].args).toMatchObject({ html: '<p>r</p>', paper: '80', docRef: 'INV-1' })
    answer = (_s, m) => fail('NOT_FOUND', `Unknown service method printing.${m}`)
    expect(await printDocument({ saleId: 1 }, 'receipt80')).toEqual({ ok: false, error: 'The printing service is not available.' })
  })
  it('a damaged remembered printer id means "no printer chosen", never NaN', async () => {
    const { prefs } = await load()
    expect(prefs.printerId()).toBeUndefined()
    for (const bad of ['abc', '0', '-2', '1.5', '']) { store.set('pos.printerId', bad); expect(prefs.printerId(), bad).toBeUndefined() }
    prefs.setPrinterId(4)
    expect(prefs.printerId()).toBe(4)
    prefs.setPrinterId(undefined)
    expect(prefs.printerId()).toBeUndefined()
  })
})

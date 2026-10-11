import { describe, it, expect } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import type { BusinessProfile } from '../../src/shared/types'
import { DEFAULT_LABEL_OPTIONS, LABEL_PRESETS, labelConfigFor, pageSizeOf, resolveLabelSize } from '../../src/shared/labelSizes'
import { renderInvoice, renderLabels, renderReport } from '../../src/main/modules/printing/engine'
import { sampleInvoiceDoc } from '../../src/main/modules/printing/docBuilder'
import { prepareHtml } from '../../src/main/modules/printing/adapter'
import { previewDoc } from '../../src/renderer/modules/printing/previewDoc'
import { makePng } from './fixtures'

/**
 * Real-Chromium checks of the print path. Opt-in because it launches Electron:  RUN_ELECTRON_LAYOUT=1 npm test -- tests/printing/electron-print
 *  - labels: exactly one page per label at every preset size (no blank second label, also on a page 0.4 mm short), page box = label size
 *  - landscape reports come out landscape, portrait ones portrait
 *  - print darkness: Chromium really applies the text stroke / logo filter and really leaves barcodes and QR codes alone
 *  - receipt preview frame (DEF-6): no scrollbar, page not wider than the frame
 */
const exe = resolve('node_modules/electron/dist/electron.exe')
const enabled = process.env.RUN_ELECTRON_LAYOUT === '1' && existsSync(exe)

const profile: BusinessProfile = {
  id: 1, version: 1, shopName: 'Sri Lakshmi Fireworks', legalName: 'Sri Lakshmi Fireworks', displayName: 'Sri Lakshmi Fireworks', shortName: '', address: '12 Market Road', city: 'Sivakasi', state: 'TN', pinCode: '626123',
  phone: '9876543210', email: '', website: '', gstin: '33ABCDE1234F1Z5', pan: '', footerText: 'Thank you', logoAssetId: 1,
  logoSettings: { visible: true, widthMm: 0, heightMm: 0, alignment: 'center', position: 'top' }, headerSettings: { showLogo: true, showShopName: true, showAddress: true, showPhone: true, showGstin: true }, createdAt: 1, createdBy: null
}
const logo = { widthPx: 400, heightPx: 200, dataUri: () => 'data:image/png;base64,' + makePng(400, 200).toString('base64') }

interface Row {
  file: string; pages: number; boxMm: [number, number] | null; hasDarkness: boolean
  css: { strokePx: number; strokeColor: string; textColor: string; imgFilter: string | null; barFilter: string | null; barStroke: string | null; barFill: string | null; barRendering: string | null; qrFilter: string | null }
  frame: { framePx: number; clientWidth: number; scrollWidth: number; bodyWidth: number; overflow: string } | null
}

describe.skipIf(!enabled)('print path in real Chromium', () => {
  it('labels, landscape, darkness and the receipt preview', { timeout: 600_000 }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'velm-print-'))
    const expectPages = new Map<string, number>()
    const put = (name: string, html: string, pages: number, preview?: string) => {
      writeFileSync(join(dir, name), html)
      if (preview) writeFileSync(join(dir, name + '.preview'), preview)
      expectPages.set(name, pages)
    }
    // ---- labels: 3 copies of a shop code at every size; sheets hold all 3 on one page
    for (const preset of LABEL_PRESETS) {
      const size = resolveLabelSize({ presetId: preset.id })
      const pg = pageSizeOf(size)
      const html = renderLabels('label_barcode', profile, labelConfigFor(size, DEFAULT_LABEL_OPTIONS), logo, [{ name: 'Rose Fountain Deluxe', variant: '500 g', sku: 'S1', barcode: '200000123', mrp: 19900, price: 17500, copies: 3 }]).html
      put(`label-${preset.id}__${pg.widthMm}x${pg.heightMm}.html`, prepareHtml(html, {}), size.sheet ? 1 : 3)
    }
    // a driver whose label is a little SHORTER than nominal and whose paper size wins (no CSS page size): a box as tall as the
    // label spilled onto a second page (6 pages for 3 labels = a blank label after each one); the 0.5 mm slack keeps 3
    const l50 = renderLabels('label_barcode', profile, labelConfigFor(resolveLabelSize({ presetId: '50x25' }), DEFAULT_LABEL_OPTIONS), logo, [{ name: 'Rose', variant: '', sku: 'S1', barcode: '200000123', mrp: 19900, price: 17500, copies: 3 }]).html
    expect(l50).toContain('@page{size:50mm 25mm;margin:0}')
    put('short-page__50x24.6.html', l50.replace('@page{size:50mm 25mm;margin:0}', ''), 3)
    put('plabel__60x40.html', prepareHtml(renderLabels('label_product', profile, {}, logo, [{ name: 'Rose Fountain', variant: '500 g', sku: 'S1', barcode: '8901234567890', mrp: 19900, price: 17500, copies: 2 }]).html, {}), 2)
    // ---- reports
    const spec = { title: 'Stock', columns: [{ key: 'a', header: 'A' }], rows: [{ a: 1 }] }
    put('report-land__210x297L.html', prepareHtml(renderReport('report_sales', profile, { landscape: true }, logo, spec).html, {}), 1)
    put('report-port__210x297.html', prepareHtml(renderReport('report_sales', profile, {}, logo, spec).html, {}), 1)
    // ---- darkness on a receipt with logo + UPI QR and on a label with a barcode
    const receipt = renderInvoice('receipt80', sampleInvoiceDoc(profile), { qrEnabled: true, upiId: 'acme@upi' }, logo).html
    const label = renderLabels('label_barcode', profile, labelConfigFor(resolveLabelSize({ presetId: '50x25' }), { ...DEFAULT_LABEL_OPTIONS, showLogo: true }), logo, [{ name: 'Rose', variant: '', sku: 'S1', barcode: '200000123', mrp: 19900, price: 17500, copies: 1 }]).html
    for (const [tag, cal] of [['d5', {}], ['d8', { darkness: 8 }], ['d2', { darkness: 2 }], ['logo8', { logoBrightness: 8 }]] as const) {
      put(`receipt-${tag}__80x0.html`, prepareHtml(receipt, cal), 1)
      put(`dlabel-${tag}__50x25.html`, prepareHtml(label, cal), 1)
    }
    // ---- preview frames for the two receipts of DEF-6
    for (const [kind, w] of [['receipt58', 58], ['receipt80', 80]] as const) {
      const html = renderInvoice(kind, sampleInvoiceDoc(profile), {}, logo).html
      put(`preview-${kind}__${w}x0.html`, html, 1, previewDoc(html))
    }

    const out = join(dir, 'result.json')
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const r = spawnSync(exe, [resolve('tests/printing/electron-print-main.cjs'), dir, out], { env, timeout: 300_000 })
    expect(existsSync(out), String(r.stderr)).toBe(true)
    const rows = JSON.parse(readFileSync(out, 'utf8')) as Row[]
    expect(rows.length).toBe(expectPages.size)
    const row = (name: string) => rows.find((x) => x.file === name)!

    for (const x of rows) expect(x.pages, x.file).toBe(expectPages.get(x.file))
    for (const preset of LABEL_PRESETS) {
      const pg = pageSizeOf(resolveLabelSize({ presetId: preset.id }))
      const x = row(`label-${preset.id}__${pg.widthMm}x${pg.heightMm}.html`)
      // a PDF page box is in whole points (0.35 mm)
      expect(Math.abs(x.boxMm![0] - pg.widthMm), x.file).toBeLessThan(0.4)
      expect(Math.abs(x.boxMm![1] - pg.heightMm), x.file).toBeLessThan(0.4)
    }
    expect(row('report-land__210x297L.html').boxMm![0]).toBeGreaterThan(290) // 297 wide
    expect(row('report-land__210x297L.html').boxMm![1]).toBeLessThan(215)
    expect(row('report-port__210x297.html').boxMm![0]).toBeLessThan(215)

    // darkness: level 5 = no stroke, no filter; 8 = heavier stroke in the text colour + darker logo; 2 = white stroke + lighter logo
    for (const doc of ['receipt', 'dlabel']) {
      const sz = doc === 'receipt' ? '80x0' : '50x25'
      const d5 = row(`${doc}-d5__${sz}.html`), d8 = row(`${doc}-d8__${sz}.html`), d2 = row(`${doc}-d2__${sz}.html`), l8 = row(`${doc}-logo8__${sz}.html`)
      expect(d5.hasDarkness).toBe(false)
      expect(d5.css.strokePx, doc).toBe(0)
      expect(d5.css.imgFilter, doc).toBe('none')
      expect(d8.css.strokePx, doc).toBeCloseTo(0.4, 1) // 0.30 pt
      expect(d8.css.strokeColor, doc).toBe(d8.css.textColor)
      expect(d8.css.imgFilter, doc).toMatch(/brightness\(0\.7\) contrast\(1\.45\)/)
      expect(d2.css.strokePx, doc).toBeCloseTo(0.32, 1) // 0.24 pt
      expect(d2.css.strokeColor, doc).toBe('rgb(255, 255, 255)')
      expect(d2.css.imgFilter, doc).toMatch(/brightness\(1\.36\)/)
      expect(l8.css.strokePx, doc).toBe(0) // logo only
      expect(l8.css.imgFilter, doc).toMatch(/brightness\(1\.36\)/)
      for (const x of [d5, d8, d2, l8]) {
        if (doc === 'dlabel') {
          expect(x.css.barFilter, x.file).toBe('none')
          expect(x.css.barStroke, x.file).toBe('none')
          expect(x.css.barFill, x.file).toBe('rgb(0, 0, 0)')
          expect(x.css.barRendering, x.file).toBe('crispedges')
        } else expect(x.css.qrFilter, x.file).toBe('none')
      }
    }

    // DEF-6: the preview frame has no scrollbar and the page is not wider than the frame
    for (const name of ['preview-receipt58__58x0.html', 'preview-receipt80__80x0.html']) {
      const f = row(name).frame!
      expect(f.clientWidth, name).toBe(f.framePx) // nothing taken off by a scrollbar
      expect(f.scrollWidth, name).toBeLessThanOrEqual(f.clientWidth)
      expect(f.bodyWidth, name).toBeLessThanOrEqual(f.framePx)
      expect(f.overflow, name).toBe('hidden')
    }
  })
})

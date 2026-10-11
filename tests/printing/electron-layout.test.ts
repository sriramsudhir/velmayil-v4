import { describe, it, expect } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { DEFAULT_LABEL_OPTIONS, LABEL_PRESETS, labelConfigFor, pageSizeOf, resolveLabelSize } from '../../src/shared/labelSizes'
import { renderInvoice, renderLabels } from '../../src/main/modules/printing/engine'
import { sampleInvoiceDoc } from '../../src/main/modules/printing/docBuilder'
import { makePng } from './fixtures'

/**
 * Real-browser layout check. Opt-in because it launches Electron:  RUN_ELECTRON_LAYOUT=1 npm test -- tests/printing/electron-layout
 * Verifies in Chromium that long / Unicode / no-space shop names wrap inside the paper width, never overlap the logo and are not clipped.
 */
const exe = resolve('node_modules/electron/dist/electron.exe')
const enabled = process.env.RUN_ELECTRON_LAYOUT === '1' && existsSync(exe)

describe.skipIf(!enabled)('print layout in real Chromium', () => {
  it('long, Tamil and no-space names wrap without overflow, overlap or clipping (all papers, all logo positions)', { timeout: 300_000 }, () => {
    const names = {
      long: 'Sri Lakshmi Fireworks & Crackers Wholesale and Retail',
      nospace: 'SriLakshmiFireworksAndCrackersWholesaleAndRetailMerchantsAssociationLimited',
      tamil: 'ஸ்ரீ லட்சுமி பட்டாசு மற்றும் வெடிப்பொருள்'
    }
    const dir = mkdtempSync(join(tmpdir(), 'velm-layout-'))
    mkdirSync(dir, { recursive: true })
    const logo = { widthPx: 400, heightPx: 200, dataUri: () => 'data:image/png;base64,' + makePng(400, 200).toString('base64') }
    for (const [n, name] of Object.entries(names))
      for (const kind of ['receipt58', 'receipt80', 'invoiceA4', 'invoiceA5'] as const)
        for (const pos of ['top', 'inline-left', 'inline-right'] as const) {
          const p = {
            id: 1, version: 1, shopName: name, legalName: name + ' Pvt Ltd', displayName: name, shortName: '', address: '12 Market Road ' + name, city: 'Madurai', state: 'TN', pinCode: '625001',
            phone: '9876543210', email: 'a@b.in', website: 'www.x.in', gstin: '33ABCDE1234F1Z5', pan: 'ABCDE1234F', footerText: 'Thanks', logoAssetId: 1,
            logoSettings: { visible: true, widthMm: 0, heightMm: 0, alignment: 'center' as const, position: pos }, headerSettings: { showLogo: true, showShopName: true, showAddress: true, showPhone: true, showGstin: true }, createdAt: 1, createdBy: null
          }
          writeFileSync(join(dir, `${kind}__${n}__${pos}.html`), renderInvoice(kind, sampleInvoiceDoc(p), { logoPosition: pos }, logo).html)
        }
    const out = join(dir, 'result.json')
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const r = spawnSync(exe, [resolve('tests/printing/electron-layout-main.cjs'), dir, out], { env, timeout: 120_000 })
    expect(existsSync(out), String(r.stderr)).toBe(true)
    const rows = JSON.parse(readFileSync(out, 'utf8')) as { file: string; overflowX: boolean; overlap: boolean; clipped: number; outside: number; logoOk: boolean; logoW: number; ratioOk: boolean; lw: number; lh: number }[]
    expect(rows.length).toBe(36)
    for (const row of rows) {
      expect(row.overflowX, row.file).toBe(false)
      expect(row.overlap, row.file).toBe(false)
      expect(row.clipped, row.file).toBe(0)
      expect(row.outside, row.file).toBe(0)
      expect(row.logoOk, row.file + ' logo rendered at its intended width (not collapsed)').toBe(true)
      expect(row.logoW, row.file).toBeGreaterThan(20)
      expect(row.ratioOk, row.file + ' aspect ratio preserved ' + row.lw + 'x' + row.lh).toBe(true)
    }
  })

  it('barcode labels: every size x long/Unicode/no-space names x logo on/off: no overlap, no clipping, barcode exact and scannable', { timeout: 600_000 }, () => {
    const names = {
      short: 'Rose Fountain',
      long: 'Premium Assorted Rainbow Fountain Cracker Gift Box',
      nospace: 'SriLakshmiFireworksCrackersWholesaleAssortedBox',
      tamil: 'ஸ்ரீ லட்சுமி பட்டாசு மற்றும் வெடிப்பொருள்'
    }
    const dir = mkdtempSync(join(tmpdir(), 'velm-label-'))
    const logo = { widthPx: 400, heightPx: 200, dataUri: () => 'data:image/png;base64,' + makePng(400, 200).toString('base64') }
    const sizes = [...LABEL_PRESETS.map((p) => resolveLabelSize({ presetId: p.id })), resolveLabelSize({ presetId: 'custom', customWidthMm: 45, customHeightMm: 28 })]
    let expected = 0
    for (const size of sizes)
      for (const [n, name] of Object.entries(names))
        for (const withLogo of [false, true]) {
          const shop = n === 'nospace' ? name : 'Sri Lakshmi Fireworks & Crackers'
          const p = {
            id: 1, version: 1, shopName: shop, legalName: shop, displayName: shop, shortName: '', address: '', city: '', state: '', pinCode: '', phone: '', email: '', website: '', gstin: '', pan: '', footerText: '',
            logoAssetId: 1, logoSettings: { visible: true, widthMm: 0, heightMm: 0, alignment: 'center' as const, position: 'inline-left' as const },
            headerSettings: { showLogo: true, showShopName: true, showAddress: true, showPhone: true, showGstin: true }, createdAt: 1, createdBy: null
          }
          const cfg = labelConfigFor(size, { ...DEFAULT_LABEL_OPTIONS, showLogo: withLogo })
          const copies = size.sheet ? size.sheet.cols * size.sheet.rows : 1
          const html = renderLabels('label_barcode', p, cfg, logo, [{ name, variant: n === 'short' ? '500 g' : 'Large', sku: 'S1', barcode: '2000000000015', mrp: 1234500, price: 1199900, copies }]).html
          const pg = pageSizeOf(size)
          writeFileSync(join(dir, `label__${size.id}_${n}_${withLogo ? 'logo' : 'nologo'}__${pg.widthMm}x${pg.heightMm}.html`), html)
          expected++
        }
    const out = join(dir, 'result.json')
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const r = spawnSync(exe, [resolve('tests/printing/electron-label-main.cjs'), dir, out], { env, timeout: 300_000 })
    expect(existsSync(out), String(r.stderr)).toBe(true)
    const rows = JSON.parse(readFileSync(out, 'utf8')) as { file: string; labels: number; overlap: number; clipped: number; outside: number; barcodeBad: number; dotBad: number; pageOverflowX: boolean; pages: number; moduleMm: number; notes: string[] }[]
    expect(rows.length).toBe(expected)
    for (const row of rows) {
      const why = row.file + ' ' + row.notes.join('; ')
      expect(row.pageOverflowX, why).toBe(false)
      expect(row.overlap, why).toBe(0)
      expect(row.clipped, why).toBe(0)
      expect(row.outside, why).toBe(0)
      expect(row.barcodeBad, why).toBe(0)
      expect(row.dotBad, why).toBe(0)
      expect(row.moduleMm, why).toBeGreaterThanOrEqual(0.25)
      expect(row.moduleMm, why).toBeLessThanOrEqual(0.501) // 4 dots at 203 dpi = 0.5005 mm
      expect(row.pages, why).toBe(1)
    }
  })
})

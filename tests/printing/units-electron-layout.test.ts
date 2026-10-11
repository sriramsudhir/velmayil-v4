import { describe, it, expect } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { DEFAULT_LABEL_OPTIONS, LABEL_PRESETS, labelConfigFor, pageSizeOf, resolveLabelSize } from '../../src/shared/labelSizes'
import { renderLabels } from '../../src/main/modules/printing/engine'
import { makePng } from './fixtures'

/**
 * Opt-in real Chromium check for Code 128 UNIT labels (reuses electron-label-main.cjs):  RUN_ELECTRON_LAYOUT=1 npm test -- tests/printing/units-electron-layout
 * Every preset size x with/without logo x short/long prefix: no overlap, no clipping, barcode exact size, whole 203 dpi dots per module
 * (>= 2 dots for the usual 3-letter prefix; an 8-letter prefix on the 38 mm label only fits at 1 dot = 0.125 mm, and is reported as "fine bars").
 */
const exe = resolve('node_modules/electron/dist/electron.exe')
const enabled = process.env.RUN_ELECTRON_LAYOUT === '1' && existsSync(exe)

describe.skipIf(!enabled)('unit label layout in real Chromium', () => {
  it('Code 128 unit labels fit and stay scannable at every preset size', { timeout: 600_000 }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'velm-unitlabel-'))
    const logo = { widthPx: 400, heightPx: 200, dataUri: () => 'data:image/png;base64,' + makePng(400, 200).toString('base64') }
    const sizes = [...LABEL_PRESETS.map((p) => resolveLabelSize({ presetId: p.id })), resolveLabelSize({ presetId: 'custom', customWidthMm: 45, customHeightMm: 28 })]
    const shop = 'Sri Lakshmi Fireworks & Crackers'
    const p = {
      id: 1, version: 1, shopName: shop, legalName: shop, displayName: shop, shortName: '', address: '', city: '', state: '', pinCode: '', phone: '', email: '', website: '', gstin: '', pan: '', footerText: '',
      logoAssetId: 1, logoSettings: { visible: true, widthMm: 0, heightMm: 0, alignment: 'center' as const, position: 'inline-left' as const },
      headerSettings: { showLogo: true, showShopName: true, showAddress: true, showPhone: true, showGstin: true }, createdAt: 1, createdBy: null
    }
    let expected = 0
    for (const size of sizes)
      for (const [tag, prefix] of [['short', 'SPK'], ['long', 'SPARKLER']] as const)
        for (const withLogo of [false, true]) {
          const cfg = labelConfigFor(size, { ...DEFAULT_LABEL_OPTIONS, showLogo: withLogo })
          const n = size.sheet ? size.sheet.cols * size.sheet.rows : 1
          const items = Array.from({ length: n }, (_, i) => ({ name: 'Rose Fountain Deluxe', variant: '500 g', sku: 'S1', barcode: `${prefix}-${String(i + 1).padStart(4, '0')}`, mrp: 19900, price: 17500, copies: 1, unit: true }))
          const html = renderLabels('label_barcode', p, cfg, logo, items).html
          const pg = pageSizeOf(size)
          writeFileSync(join(dir, `unit__${size.id}_${tag}_${withLogo ? 'logo' : 'nologo'}__${pg.widthMm}x${pg.heightMm}.html`), html)
          expected++
        }
    const out = join(dir, 'result.json')
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const r = spawnSync(exe, [resolve('tests/printing/electron-label-main.cjs'), dir, out], { env, timeout: 300_000 })
    expect(existsSync(out), String(r.stderr)).toBe(true)
    const rows = JSON.parse(readFileSync(out, 'utf8')) as { file: string; overlap: number; clipped: number; outside: number; barcodeBad: number; dotBad: number; pageOverflowX: boolean; pages: number; moduleMm: number; notes: string[] }[]
    expect(rows.length).toBe(expected)
    for (const row of rows) {
      const why = row.file + ' ' + row.notes.join('; ')
      expect(row.pageOverflowX, why).toBe(false)
      expect(row.overlap, why).toBe(0)
      expect(row.clipped, why).toBe(0)
      expect(row.outside, why).toBe(0)
      expect(row.barcodeBad, why).toBe(0)
      expect(row.dotBad, why).toBe(0)
      // was 0.15 / 0.19 mm: such widths do not exist on a 203 dpi head (1.2 / 1.5 dots), the bars came out uneven
      expect(row.moduleMm, why).toBeGreaterThanOrEqual(/_long_/.test(row.file) ? 0.125 : 0.25)
      expect(row.moduleMm, why).toBeLessThanOrEqual(0.501)
      expect(row.pages, why).toBe(1)
    }
  })
})

import { describe, it, expect, beforeEach } from 'vitest'
import JsBarcode from 'jsbarcode'
import { createTestApp } from '../helpers'
import type { App } from '../../src/main/core/app'
import { isValidGtin } from '../../src/main/modules/catalog/barcode'

let app: App
const cat = <T = any>(m: string, a?: unknown) => app.call('catalog', m, a) as Promise<T>
const pos = <T = any>(m: string, a?: unknown) => app.call('pos', m, a) as Promise<T>

beforeEach(() => {
  app = createTestApp()
})

async function mk(name = 'Rocket', price = 10000) {
  const p = await cat('save', { name, hsn: '3604', taxRateBp: 1800, variants: [{ name: '', mrp: 12000, price, cost: 6000, autoBarcode: true }] })
  return p.variants[0] as { id: number; barcode: string; sku: string }
}

describe('old barcode keeps working when the price changes', () => {
  it('price decrease and increase never change the barcode; the sale uses the CURRENT price', async () => {
    const v = await mk()
    const original = v.barcode
    expect(original).toBe('200000001') // default numbering: fixed prefix + running number
    app.moveStock({ variantId: v.id, delta: 50, type: 'opening' })

    for (const newPrice of [8000, 15000, 9900]) {
      const p = await cat('get', { id: (app.lookup.byCode(original) as any).productId })
      const variant = p.variants[0]
      await cat('save', { id: p.id, name: p.name, hsn: p.hsn, taxRateBp: p.taxRateBp, variants: [{ id: variant.id, name: '', sku: variant.sku, barcode: variant.barcode, mrp: variant.mrp, price: newPrice, cost: variant.cost }] })
      const scanned = await pos('scan', { code: original })
      expect(scanned.price).toBe(newPrice) // old label barcode resolves to the new price
      expect(scanned.barcode).toBe(original)
      const sale = await pos('completeSale', { lines: [{ variantId: scanned.variantId, qty: 1 }], payments: [{ method: 'cash', amount: 100000 }] })
      expect(sale.total).toBe(Math.round(newPrice / 100) * 100)
    }
    // even when the price edit omits the barcode field entirely
    const p = await cat('get', { id: (app.lookup.byCode(original) as any).productId })
    await cat('save', { id: p.id, name: p.name, hsn: p.hsn, taxRateBp: p.taxRateBp, variants: [{ id: p.variants[0].id, name: '', price: 7000, mrp: 12000, cost: 6000 }] })
    expect(app.lookup.byCode(original)?.price).toBe(7000)
  })

  it('price history is audited so the owner can see old vs new price', async () => {
    const v = await mk('Fountain', 5000)
    const p = await cat('get', { id: (app.lookup.byCode(v.barcode) as any).productId })
    await cat('save', { id: p.id, name: p.name, hsn: p.hsn, taxRateBp: p.taxRateBp, variants: [{ id: p.variants[0].id, name: '', sku: v.sku, barcode: v.barcode, mrp: 12000, price: 6500, cost: 6000 }] })
    const hist = await cat('priceHistory', { variantId: p.variants[0].id })
    expect(JSON.stringify(hist)).toContain('6500')
  })
})

describe('barcode generation', () => {
  it('default numbering: the prefix stays, only the suffix counts up; every code renders as Code 128 and scans back', async () => {
    const codes: string[] = []
    for (let i = 0; i < 150; i++) codes.push((await mk(`Item ${i}`)).barcode)
    expect(codes).toEqual(Array.from({ length: 150 }, (_, i) => '200' + String(i + 1).padStart(6, '0')))
    for (const code of codes.slice(0, 20)) {
      const out: { encodings?: unknown[] } = {}
      expect(() => JsBarcode(out, code, { format: 'CODE128', xmlDocument: undefined as never, valid: (ok: boolean) => { if (!ok) throw new Error('invalid ' + code) } })).not.toThrow()
    }
    for (const [i, code] of codes.entries()) expect((await pos('scan', { code })).displayName).toBe(`Item ${i}`)
  })

  it('ean13 numbering: generates valid, unique EAN-13 codes that render as scannable barcodes', async () => {
    await cat('saveSettings', { barcodeMode: 'ean13' })
    const seen = new Set<string>()
    for (let i = 0; i < 150; i++) {
      const v = await mk(`Item ${i}`)
      expect(isValidGtin(v.barcode, 13)).toBe(true)
      expect(seen.has(v.barcode)).toBe(false)
      seen.add(v.barcode)
    }
    // jsbarcode accepts only valid EAN-13 check digits when rendering
    const sample = [...seen].slice(0, 20)
    for (const code of sample) {
      const out: { encodings?: unknown[] } = {}
      expect(() => JsBarcode(out, code, { format: 'EAN13', xmlDocument: undefined as never, valid: (ok: boolean) => { if (!ok) throw new Error('invalid ' + code) } })).not.toThrow()
    }
  })

  it('rejects a wrong check digit and duplicates', async () => {
    await cat('saveSettings', { barcodeMode: 'ean13' })
    const v = await mk()
    const bad = v.barcode.slice(0, 12) + ((Number(v.barcode[12]) + 1) % 10)
    await expect(cat('save', { name: 'X', hsn: '', taxRateBp: 0, variants: [{ name: '', mrp: 1, price: 1, cost: 0, barcode: bad }] })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(cat('save', { name: 'Y', hsn: '', taxRateBp: 0, variants: [{ name: '', mrp: 1, price: 1, cost: 0, barcode: v.barcode }] })).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('EAN-13 barcodes issued before the switch to running numbers keep scanning and printing', async () => {
    await cat('saveSettings', { barcodeMode: 'ean13' })
    const old = await mk('Old EAN item')
    expect(isValidGtin(old.barcode, 13)).toBe(true)
    await cat('saveSettings', { barcodeMode: 'sequence' })
    const fresh = await mk('New item')
    expect(fresh.barcode).toBe('200000002') // the running number simply continues
    expect((await pos('scan', { code: old.barcode })).displayName).toBe('Old EAN item')
    expect((await pos('scan', { code: fresh.barcode })).displayName).toBe('New item')
    expect((await cat('get', { id: (app.lookup.byCode(old.barcode) as any).productId })).variants[0].barcode).toBe(old.barcode)
    const html = (await app.call('printing', 'renderLabelHtml', { variantIds: [{ variantId: old.id, copies: 1 }, { variantId: fresh.id, copies: 1 }], template: 'label_barcode' }) as { html: string }).html
    expect(html).toContain(old.barcode)
    expect(html).toContain(fresh.barcode)
  })
})

describe('A5 paper', () => {
  it('renders an A5 invoice for a real sale with the shop profile', async () => {
    const v = await mk('A5 Item')
    app.moveStock({ variantId: v.id, delta: 5, type: 'opening' })
    const sale = await pos('completeSale', { lines: [{ variantId: v.id, qty: 2 }], payments: [{ method: 'cash', amount: 50000 }] })
    const r = await app.call('printing', 'renderInvoiceHtml', { saleId: sale.saleId, template: 'invoiceA5' }) as { html: string }
    expect(r.html).toContain('Test Shop')
    expect(r.html).toContain(sale.invoiceNo)
    expect(r.html).toMatch(/148mm|A5/i)
    const t = await app.call('printing', 'testPrint', { paper: 'A5', dryRun: true }) as { html: string }
    expect(t.html.length).toBeGreaterThan(100)
  })
})

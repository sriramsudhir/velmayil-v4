import { describe, expect, it, beforeEach } from 'vitest'
import { createTestApp } from '../helpers'
import type { App } from '../../src/main/core/app'
import type { PrintingService } from '../../src/main/modules/printing/service'
import { codeCandidates, gs1CheckDigit, hasValidCheckDigit, upcEToUpcA } from '../../src/main/modules/pos/codes'
import { quickCashAmounts, settlePayments, upiPayUri } from '../../src/shared/billing'
import { FakePrinter } from '../printing/fixtures'

let app: App
const call = <T = any>(method: string, args?: unknown) => app.call('pos', method, args) as Promise<T>

function product(name: string, price: number, barcode: string | null, taxBp = 0): number {
  const p = app.db.run('INSERT INTO products(uuid,name,tax_rate_bp,hsn,track_stock) VALUES (?,?,?,?,1)', app.uuid(), name, taxBp, '3604')
  const v = app.db.run('INSERT INTO product_variants(uuid,product_id,sku,barcode,price,mrp,cost) VALUES (?,?,?,?,?,?,?)', app.uuid(), p.lastId, 'SKU-' + name, barcode, price, price, Math.floor(price / 2))
  app.moveStock({ variantId: v.lastId, delta: 100, type: 'opening' })
  return v.lastId
}

beforeEach(() => {
  app = createTestApp()
})

describe('scan code variants (pure)', () => {
  it('check digits and UPC-E expansion', () => {
    expect(gs1CheckDigit('01234567890')).toBe('5')
    expect(gs1CheckDigit('400638133393')).toBe('1')
    expect(hasValidCheckDigit('4006381333931')).toBe(true)
    expect(hasValidCheckDigit('4006381333932')).toBe(false)
    expect(upcEToUpcA('04252614')).toBe('042100005264')
    expect(upcEToUpcA('24252614')).toBeNull()
  })
  it('exact spelling always comes first', () => {
    expect(codeCandidates('  4006381333931\r\n')[0]).toBe('4006381333931')
    expect(codeCandidates('')).toEqual([])
    expect(codeCandidates('ABC-123')).toEqual(['ABC-123', 'abc-123'])
  })
  it('generates the UPC-A / EAN-13 / GTIN-14 / stripped-check-digit variants', () => {
    expect(codeCandidates('012345678905')).toContain('0012345678905')
    expect(codeCandidates('0012345678905')).toContain('012345678905')
    expect(codeCandidates('01234567890')).toContain('012345678905')
    expect(codeCandidates('400638133393')).toContain('4006381333931')
    expect(codeCandidates('14006381333938')).toContain('4006381333938')
    expect(codeCandidates('0100012345678905')).toContain('0012345678905')
    expect(codeCandidates('(01)00012345678905(10)LOT7')).toContain('0012345678905')
    expect(codeCandidates(']E04006381333931')).toContain('4006381333931')
    expect(codeCandidates('*ABC123*')).toContain('ABC123')
    expect(codeCandidates('8901-2345 67890')).toContain('8901234567890')
    expect(codeCandidates('04252614')).toContain('042100005264')
    expect(codeCandidates('1234567')).toContain('12345670') // EAN-8 without check digit
  })
})

describe('pos.scan finds the product whatever spelling the scanner sent', () => {
  it('UPC-A vs EAN-13, stripped check digit, GTIN-14, GS1, Code 39 stars, SKU case, UPC-E', async () => {
    const upca = product('UpcA', 1000, '012345678905')
    const ean = product('Ean13', 2000, '4006381333931')
    const eanZero = product('EanZero', 3000, '0036000291452')
    const sku = product('Case', 4000, null)
    const upce = product('UpcE', 5000, '042100005264')
    const id = async (code: string) => (await call<{ variantId: number }>('scan', { code })).variantId

    expect(await id('012345678905')).toBe(upca) // exact
    expect(await id('0012345678905')).toBe(upca) // scanner reads UPC-A as EAN-13
    expect(await id('01234567890')).toBe(upca) // check digit stripped
    expect(await id('00012345678905')).toBe(upca) // ITF-14 / GTIN-14 padding
    expect(await id('0100012345678905')).toBe(upca) // GS1 element string (01)
    expect(await id('*012345678905*')).toBe(upca) // Code 39 start/stop
    expect(await id(' 012345678905\r')).toBe(upca) // whitespace / CR from the scanner

    expect(await id('4006381333931')).toBe(ean)
    expect(await id('400638133393')).toBe(ean) // EAN-13 without check digit
    expect(await id('04006381333931')).toBe(ean) // GTIN-14

    expect(await id('036000291452')).toBe(eanZero) // catalog has EAN-13 with leading 0, scanner gives UPC-A
    expect(await id('0036000291452')).toBe(eanZero)

    expect(await id('sku-case')).toBe(sku)
    expect(await id('SKU-CASE')).toBe(sku)
    expect(await id('04252614')).toBe(upce) // UPC-E zero suppression

    await expect(call('scan', { code: '9999999999994' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(call('scan', { code: '' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('an exact match always beats a variant of another product', async () => {
    const a = product('A', 1000, '0012345678905')
    product('B', 1000, '012345678905')
    expect((await call<{ variantId: number }>('scan', { code: '0012345678905' })).variantId).toBe(a)
  })
})

describe('pos.scan: everything a real reader can wrap around or change in a code', () => {
  const id = async (code: string) => (await call<{ variantId: number }>('scan', { code })).variantId

  it('whitespace and control characters: CR, LF, Tab, NUL, STX/ETX, zero-width', async () => {
    const a = product('Plain', 1000, '8901234567890')
    for (const wrapped of ['8901234567890\r', '8901234567890\n', '8901234567890\r\n', '\t8901234567890\t', '8901234567890\u0000', '\u00028901234567890\u0003', '  8901234567890  ', '​8901234567890', '89012\u000034567890'])
      expect(await id(wrapped), JSON.stringify(wrapped)).toBe(a)
  })

  it('AIM symbology identifiers ]E0 ]E4 ]C1 ]d2 ]A0 ]Q1, alone and inside Code 39 stars', async () => {
    const a = product('Aim', 1000, '4006381333931')
    const c = product('Code128', 2000, 'ABC-1234')
    for (const p of [']E0', ']E4', ']E1', ']C1', ']d2', ']A0', ']Q1', ']e0']) expect(await id(p + '4006381333931'), p).toBe(a)
    expect(await id(']C1ABC-1234')).toBe(c)
    expect(await id(']A0*ABC-1234*')).toBe(c)
    expect(await id(']E04006381333931\r')).toBe(a)
  })

  it('GS1: FNC1 / GS separators, (01) wrappers, AIs after the GTIN', async () => {
    const a = product('Gs1', 1000, '8901234567890')
    expect(await id('0108901234567890')).toBe(a) // GTIN-14 of an EAN-13 (leading 0 indicator)
    expect(await id('010890123456789010LOT7\u001d21SER9')).toBe(a) // lot + serial with a GS separator
    expect(await id('\u001d0108901234567890')).toBe(a) // leading FNC1 shown as GS
    expect(await id(']C1010890123456789017261231\u001d10B7')).toBe(a) // AIM ]C1 + expiry + GS + lot
    expect(await id('(01)08901234567890(17)261231')).toBe(a) // human-readable form
    expect(await id('(01)08901234567890')).toBe(a)
  })

  it('Code 39: start/stop stars and lower-case letters (reader or Caps Lock changed the case)', async () => {
    const sku = product('Star', 1000, 'ABC123')
    expect(await id('*ABC123*')).toBe(sku)
    expect(await id('abc123')).toBe(sku) // barcode column is exact but the candidates include the upper-case spelling
    expect(await id('*abc123*')).toBe(sku)
    expect(await id('Abc123')).toBe(sku)
  })

  it('EAN-13 / UPC-A / EAN-8 / UPC-E / GTIN-14 / ITF-14 and their dropped or added digits', async () => {
    const ean13 = product('E13', 1000, '4006381333931')
    const upca = product('UpcA2', 2000, '036000291452')
    const ean8 = product('E8', 3000, '96385074')
    const upce = product('UpcE2', 4000, '042100005264')
    // EAN-13
    expect(await id('4006381333931')).toBe(ean13)
    expect(await id('04006381333931')).toBe(ean13) // GTIN-14 / ITF-14 padded with a zero
    expect(await id('14006381333938')).toBe(ean13) // ITF-14 whose indicator digit is 1 (check digit recomputed)
    expect(await id('400638133393')).toBe(ean13) // check digit stripped
    expect(await id('0004006381333931')).toBe(ean13) // more padding zeros
    // UPC-A
    expect(await id('036000291452')).toBe(upca)
    expect(await id('0036000291452')).toBe(upca) // read as EAN-13
    expect(await id('00036000291452')).toBe(upca) // ITF-14
    expect(await id('03600029145')).toBe(upca) // check digit stripped
    expect(await id('36000291452')).toBe(upca) // leading zero lost (spreadsheet / reader option)
    // EAN-8
    expect(await id('96385074')).toBe(ean8)
    expect(await id('9638507')).toBe(ean8) // check digit stripped
    expect(await id('0000096385074')).toBe(ean8) // padded to 13
    // UPC-E: 8 digits, 7 digits (no check), 6 digits (no number system, no check)
    expect(await id('04252614')).toBe(upce)
    expect(await id('0425261')).toBe(upce)
    expect(await id('425261')).toBe(upce)
    await expect(call('scan', { code: '4006381333932' })).rejects.toMatchObject({ code: 'NOT_FOUND' }) // a corrupted check digit is a misread: never guess
  })

  it('a reader that adds a leading zero / prefix digit to every code is found, wrong products are not invented', async () => {
    const a = product('Padded', 1000, '8901234567890')
    expect(await id('08901234567890')).toBe(a)
    expect(await id('008901234567890')).toBe(a)
    await expect(call('scan', { code: '5901234123457' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(call('scan', { code: '\u0000\r\n ' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('SKU (exact and any case) and the not-found message carries the code', async () => {
    const sku = product('Sku', 1000, null)
    expect(await id('SKU-Sku')).toBe(sku)
    expect(await id('sku-sku')).toBe(sku)
    await expect(call('scan', { code: '123456789\r' })).rejects.toMatchObject({ code: 'NOT_FOUND', message: expect.stringContaining('"123456789"') })
  })

  it('alias barcodes: the old code keeps scanning after the product barcode is replaced', async () => {
    const saved: any = await app.call('catalog', 'save', { name: 'Alias Rocket', hsn: '3604', taxRateBp: 0, variants: [{ name: '', mrp: 5000, price: 5000, cost: 2000, openingStock: 10, barcode: '8901234567890' }] })
    const variantId = saved.variants[0].id
    await app.call('catalog', 'bulkUpdate', { rows: [{ variantId, patch: { barcode: '4006381333931' } }] })
    expect(await id('4006381333931')).toBe(variantId)
    expect(await id('8901234567890')).toBe(variantId) // alias
    expect(await id(']E08901234567890')).toBe(variantId) // alias + reader decoration
    expect(await id('8901234567890\r\n')).toBe(variantId)
  })

  it('inventory count scan, inventory lookup and the catalog resolver use the same tolerant lookup', async () => {
    const v = product('Counted', 1000, '4006381333931')
    expect(((await app.call('inventory', 'lookup', { code: ']E04006381333931\r' })) as any).variantId).toBe(v)
    expect(((await app.call('inventory', 'lookup', { code: '400638133393' })) as any).variantId).toBe(v)
    expect(((await app.call('catalog', 'findByCode', { code: '*4006381333931*' })) as any).variantId).toBe(v)
    const count: any = await app.call('inventory', 'countCreate', {})
    const r: any = await app.call('inventory', 'countScan', { countId: count.id, code: '4006381333931\r\n'.replace('\r\n', '') })
    expect(r.variantId).toBe(v)
    const r2: any = await app.call('inventory', 'countScan', { countId: count.id, code: ']E0400638133393' })
    expect(r2).toMatchObject({ variantId: v, countedQty: 2 })
  })

  it('product search tolerates a scanned code with decorations typed into a search box', async () => {
    const v = product('Searchable', 1000, '4006381333931')
    const rows = (await call<{ variantId: number }[]>('search', { text: ']E04006381333931' })).map((r) => r.variantId)
    expect(rows).toContain(v)
    expect((await call<{ variantId: number }[]>('search', { text: '*4006381333931*' })).map((r) => r.variantId)).toContain(v)
  })
})

describe('payments: cash change, online, mixed', () => {
  let item: number
  beforeEach(() => {
    item = product('Rocket Pack', 400000, '8901111111111')
  })
  const rows = (saleId: number) => app.db.all<{ method: string; amount: number }>('SELECT method, amount FROM sale_payments WHERE sale_id = ? ORDER BY id', saleId)
  const sale = (saleId: number) => app.db.get<any>('SELECT total, paid, change_given FROM sales WHERE id = ?', saleId)!

  it('4000 bill, 4500 cash => change 500; stored cash is net; paid = tendered', async () => {
    const r = await call('completeSale', { lines: [{ variantId: item, qty: 1 }], payments: [{ method: 'cash', amount: 450000 }] })
    expect(r).toMatchObject({ total: 400000, paid: 450000, change: 50000 })
    expect(sale(r.saleId)).toMatchObject({ total: 400000, paid: 450000, change_given: 50000 })
    expect(rows(r.saleId)).toEqual([{ method: 'cash', amount: 400000 }])
  })

  it('4000 bill, 1500 UPI + 3000 cash => change 500 from the cash part only', async () => {
    const r = await call('completeSale', { lines: [{ variantId: item, qty: 1 }], payments: [{ method: 'upi', amount: 150000, reference: 'UPI123' }, { method: 'cash', amount: 300000 }] })
    expect(r).toMatchObject({ total: 400000, paid: 450000, change: 50000 })
    expect(rows(r.saleId)).toEqual([{ method: 'upi', amount: 150000 }, { method: 'cash', amount: 250000 }])
  })

  it('online payments can never produce change (reject overpayment on non-cash)', async () => {
    for (const method of ['upi', 'card', 'other'] as const)
      await expect(call('completeSale', { lines: [{ variantId: item, qty: 1 }], payments: [{ method, amount: 450000 }] })).rejects.toMatchObject({ code: 'VALIDATION', message: /only allowed on cash/ })
    // overpaid online part larger than the cash part cannot be "returned" from cash
    await expect(call('completeSale', { lines: [{ variantId: item, qty: 1 }], payments: [{ method: 'upi', amount: 450000 }, { method: 'cash', amount: 10000 }] })).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(app.db.value('SELECT COUNT(*) FROM sales')).toBe(0)
    // exact online is fine and has no change
    const ok = await call('completeSale', { lines: [{ variantId: item, qty: 1 }], payments: [{ method: 'upi', amount: 400000, reference: 'R1' }] })
    expect(ok.change).toBe(0)
  })

  it('insufficient cash is rejected with the balance due', async () => {
    await expect(call('completeSale', { lines: [{ variantId: item, qty: 1 }], payments: [{ method: 'cash', amount: 350000 }] })).rejects.toMatchObject({ code: 'VALIDATION', details: { balanceDue: 50000 } })
  })

  it('client-side settlement agrees with the server (what the payment screen shows)', () => {
    expect(settlePayments(400000, [{ method: 'cash', amount: 450000 }])).toMatchObject({ change: 50000, balanceDue: 0 })
    expect(settlePayments(400000, [{ method: 'cash', amount: 350000 }])).toMatchObject({ change: 0, balanceDue: 50000 })
    expect(settlePayments(400000, [{ method: 'upi', amount: 150000 }, { method: 'cash', amount: 300000 }])).toMatchObject({ change: 50000, balanceDue: 0 })
  })

  it('printed receipt / A4 / A5 carry Received and Change', async () => {
    printing().setAdapter(new FakePrinter())
    const r = await call('completeSale', { lines: [{ variantId: item, qty: 1 }], payments: [{ method: 'upi', amount: 150000 }, { method: 'cash', amount: 300000 }] })
    for (const template of ['receipt58', 'receipt80', 'invoiceA4', 'invoiceA5'] as const) {
      const { html } = printing().renderInvoiceHtml({ saleId: r.saleId, template })
      const text = html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ')
      expect(text, template).toMatch(/Received:?\s*(₹)?4,500\.00/)
      expect(text, template).toMatch(/Change:?\s*(₹)?500\.00/)
    }
  })

  it('no Change line when the bill is paid exactly', async () => {
    const r = await call('completeSale', { lines: [{ variantId: item, qty: 1 }], payments: [{ method: 'cash', amount: 400000 }] })
    const { html } = printing().renderInvoiceHtml({ saleId: r.saleId, template: 'receipt80' })
    expect(html.replace(/<[^>]+>/g, ' ')).not.toMatch(/Change/)
  })
})

const printing = () => app.get<PrintingService>('printing')

describe('shop UPI id setting', () => {
  it('billing.upi_id is a registered setting and reaches the POS screen settings with the payee name', async () => {
    expect(((await call('settings')) as { upiId: string }).upiId).toBe('')
    await app.call('settings', 'set', { key: 'billing.upi_id', value: ' shop@okbank ' })
    expect(await call('settings')).toMatchObject({ upiId: 'shop@okbank', payeeName: 'Test Shop' })
  })
})

describe('quick cash buttons and UPI payload', () => {
  it('offers exact first, then sensible next amounts', () => {
    expect(quickCashAmounts(400000)).toEqual([400000, 450000, 500000, 600000])
    expect(quickCashAmounts(39500)).toEqual([39500, 40000, 50000, 100000, 200000, 500000])
    expect(quickCashAmounts(0)).toEqual([])
    expect(quickCashAmounts(100)[0]).toBe(100)
  })
  it('builds a UPI pay link with the amount prefilled, and rejects bad ids', () => {
    expect(upiPayUri({ upiId: 'shop@okbank', payeeName: 'Sri Lakshmi & Co', amount: 400050, note: 'INV-1' })).toBe('upi://pay?pa=shop%40okbank&pn=Sri%20Lakshmi%20%26%20Co&am=4000.50&cu=INR&tn=INV-1')
    expect(upiPayUri({ upiId: 'not an id', amount: 100 })).toBe('')
    expect(upiPayUri({ upiId: 'a@b', amount: 100 })).toBe('')
    expect(upiPayUri({ upiId: 'shop@upi', amount: 0 })).toBe('')
  })
})

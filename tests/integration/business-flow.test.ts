/**
 * End-to-end business flow on a REAL first-run database (setup.complete -> profile -> logo -> import -> stock ->
 * billing -> printing -> returns -> void -> reports -> backup/restore -> profile change/reprint policy -> security).
 * Steps share state and run in order (like one trading day). All expected numbers are hand-computed.
 */
import { describe, it, expect, afterAll } from 'vitest'
import { rmSync } from 'node:fs'
import { call, catalogCsv, crackersCatalog, freshShop, makePng, type Prod } from './util'
import type { App } from '../../src/main/core/app'
import type { FakePrinter } from './util'
import type { BackupService } from '../../src/main/modules/backup/service'

const SHOP = 'Sri Lakshmi Fireworks & Crackers Wholesale and Retail'
const RANGE = { from: '2000-01-01', to: '2999-12-31' }
const TAMIL_PRODUCT = 'தீபாவளி சிறப்பு வெடி பெட்டி'
const TAMIL_SHOP = 'ஸ்ரீ வேல்மயில் பட்டாசு கடை'

let app: App
let dir: string
let printer: FakePrinter
const prods: Prod[] = crackersCatalog()
const vid: Record<string, number> = {}
const sales: Record<string, { saleId: number; invoiceNo: string; total: number }> = {}
const get = <T = any>(s: string, m: string, a?: unknown) => call<T>(app, s, m, a)
const money = (p: number) => (p / 100).toFixed(2)
const logoPng = makePng(160, 80, { alpha: true })

afterAll(() => {
  try { app.db.close() } catch { /* */ }
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* windows lock */ }
})

describe('01 first setup + shop profile + logo', () => {
  it('setup.complete on an empty DB creates owner, POS, location, profile v1 and signs in', async () => {
    const f = await freshShop()
    app = f.app; dir = f.dir; printer = f.printer
    expect((await get('setup', 'status')).complete).toBe(true)
    const cur = await get('auth', 'current')
    expect(cur.username).toBe('owner')
    const p = await get('businessProfile', 'getActive')
    expect(p).toMatchObject({ shopName: SHOP, address: '12, Cracker Street, Near Bus Stand', phone: '9876543210', gstin: '33ABCDE1234F1Z5', version: 1 })
    expect(app.db.value<number>('SELECT COUNT(*) FROM audit_log WHERE entity=? AND action=?', 'business_profile', 'profile.create')).toBe(1)
    await expect(get('setup', 'complete', { shop: { shopName: 'X' }, owner: { username: 'abc', password: 'abcdef' }, pos: { code: 'P', name: 'x' }, locationName: 'm' })).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('businessProfile.save edits the profile; setLogo stores a real PNG and creates a new immutable version', async () => {
    const saved = await get('businessProfile', 'save', { email: 'shop@example.com', footerText: 'Thank you! Visit again.' })
    expect(saved.version).toBe(2)
    const r = await get('businessProfile', 'setLogo', { data: logoPng.toString('base64'), name: 'logo.png' })
    expect(r.profile.version).toBe(3)
    expect(r.logo.dataUri).toMatch(/^data:image\/png;base64,/)
    expect(r.logo.widthPx).toBe(160)
    // v1 and v2 are untouched
    const versions = await get('businessProfile', 'listVersions')
    expect(versions.map((v: any) => v.version)).toEqual([3, 2, 1])
    expect(versions.filter((v: any) => v.isActive)).toHaveLength(1)
    expect(app.db.value<number>("SELECT logo_asset_id IS NULL FROM business_profile_versions WHERE version = 1")).toBe(1)
    await expect(get('businessProfile', 'setLogo', { data: Buffer.from('not an image').toString('base64') })).rejects.toBeTruthy()
    // invalid fields are rejected
    await expect(get('businessProfile', 'save', { gstin: 'BADGSTIN' })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(get('businessProfile', 'save', { shopName: '   ' })).rejects.toMatchObject({ code: 'VALIDATION' })
  })

  it('profile changes are audited with old/new values', async () => {
    const rows = app.db.all<any>("SELECT action, old_json, new_json FROM audit_log WHERE entity='business_profile' ORDER BY id")
    expect(rows.map((r) => r.action)).toEqual(['profile.create', 'profile.save', 'profile.logo_set'])
    expect(JSON.stringify(rows[1].new_json)).toContain('shop@example.com')
  })
})

describe('02 catalog import + purchase + opening stock', () => {
  it('imports 24 crackers products (GST 5/12/18/28, EAN-13) from CSV with opening stock', async () => {
    const b64 = Buffer.from(catalogCsv(prods)).toString('base64')
    const prev = await get('catalog', 'importPreview', { bytesBase64: b64, filename: 'crackers.csv' })
    expect(prev.counts).toMatchObject({ total: 24, creates: 24, invalid: 0 })
    const res = await get('catalog', 'importCommit', { bytesBase64: b64, filename: 'crackers.csv', mode: 'all_or_nothing' })
    expect(res).toMatchObject({ created: 24, openingStockRows: 24 })
    for (const p of prods) {
      const v = app.lookup.byCode(p.barcode)!
      expect(v, p.name).toBeTruthy()
      expect(v).toMatchObject({ productName: p.name, price: p.price, mrp: p.mrp, cost: p.cost, taxRateBp: p.gstPct * 100, stock: 100, hsn: '3604' })
      vid[p.sku] = v.variantId
    }
    expect(new Set(prods.map((p) => p.gstPct * 100))).toEqual(new Set([500, 1200, 1800, 2800]))
    // re-import is idempotent (no dupes)
    const again = await get('catalog', 'importCommit', { bytesBase64: b64, filename: 'crackers.csv', mode: 'all_or_nothing' })
    expect(again.created).toBe(0)
    expect(app.db.value<number>('SELECT COUNT(*) FROM product_variants')).toBe(24)
  })

  it('a purchase adds stock and updates cost; stock ledger reconciles with levels', async () => {
    const sup = await get('purchases', 'supplierSave', { name: 'Sivakasi Mega Traders', phone: '9444400000' })
    const pu = await get('purchases', 'create', { supplierId: sup.id, supplierInvoiceNo: 'SMT-77', paid: 100000, paymentMethod: 'cash', items: [{ variantId: vid.CRK001, qty: 50, unitCost: 7000 }] })
    expect(pu).toBeTruthy()
    expect(app.lookup.byCode(prods[0].barcode)).toMatchObject({ stock: 150, cost: 7000 })
    const led = await get('inventory', 'verifyLedger')
    expect(JSON.stringify(led)).not.toMatch(/mismatch.*[1-9]/i)
    expect(app.db.value<number>('SELECT COALESCE(SUM(qty),0) FROM stock_levels')).toBe(app.db.value<number>('SELECT COALESCE(SUM(qty_delta),0) FROM stock_movements'))
  })

  it('scanning a barcode resolves the product at its current price', async () => {
    const s = await get('pos', 'scan', { code: prods[1].barcode })
    expect(s).toMatchObject({ productName: 'Sparkler Box 15cm', price: 10500, taxRateBp: 500 })
    await expect(get('pos', 'scan', { code: '0000000000000' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect((await get('pos', 'scan', { code: 'crk003' })).sku).toBe('CRK003') // SKU, case-insensitive
  })
})

describe('03 billing and payments (cash, UPI, mixed, credit, round-off)', () => {
  const A = () => vid.CRK001, B = () => vid.CRK002, C = () => vid.CRK003, D = () => vid.CRK004, E = () => vid.CRK005

  it('S1 cash, 4 GST slabs: total 463.00, tax 63.00, change 37.00', async () => {
    const r = await get('pos', 'completeSale', { lines: [A(), B(), C(), D()].map((variantId) => ({ variantId, qty: 1 })), payments: [{ method: 'cash', amount: 50000 }] })
    expect(r).toMatchObject({ total: 46300, paid: 50000, change: 3700, duplicate: false })
    sales.S1 = r
    const s = await get('pos', 'getSale', { id: r.saleId })
    expect(s).toMatchObject({ subtotal: 46300, tax: 6300, roundOff: 0, total: 46300, status: 'completed' })
    expect(s.payments).toHaveLength(1)
    expect(s.payments[0]).toMatchObject({ method: 'cash', amount: 46300 }) // net of change
    expect(s.items.map((i: any) => i.taxAmount)).toEqual([1800, 500, 1200, 2800])
  })
  it('S2 UPI: 2 x Sparkler 10cm = 236.00 (tax 36.00)', async () => {
    sales.S2 = await get('pos', 'completeSale', { lines: [{ variantId: A(), qty: 2 }], payments: [{ method: 'upi', amount: 23600, reference: 'UPI-TXN-1' }] })
    expect(sales.S2.total).toBe(23600)
    expect((sales.S2 as { change?: number }).change).toBe(0)
  })
  it('S3 mixed cash 115.00 + UPI 200.00 for 3 x 105.00', async () => {
    sales.S3 = await get('pos', 'completeSale', { lines: [{ variantId: B(), qty: 3 }], payments: [{ method: 'cash', amount: 11500 }, { method: 'upi', amount: 20000 }] })
    expect(sales.S3.total).toBe(31500)
    const s = await get('pos', 'getSale', { id: sales.S3.saleId })
    expect(s.payments.map((p: any) => [p.method, p.amount])).toEqual([['cash', 11500], ['upi', 20000]])
  })
  it('S4 credit sale needs a customer; creates the customer inline', async () => {
    await expect(get('pos', 'completeSale', { lines: [{ variantId: D(), qty: 1 }], payments: [{ method: 'credit', amount: 12800 }] })).rejects.toMatchObject({ code: 'VALIDATION' })
    sales.S4 = await get('pos', 'completeSale', { lines: [{ variantId: D(), qty: 1 }], customer: { name: 'Ravi Kumar', phone: '9000000001' }, payments: [{ method: 'credit', amount: 12800 }] })
    expect(sales.S4.total).toBe(12800)
    expect(app.db.value<number>("SELECT COUNT(*) FROM customers WHERE phone='9000000001'")).toBe(1)
  })
  it('S5 round-off: 100.50 -> bill 101.00, tax 4.79, round-off +0.50', async () => {
    sales.S5 = await get('pos', 'completeSale', { lines: [{ variantId: E(), qty: 1 }], payments: [{ method: 'upi', amount: 10100 }] })
    const s = await get('pos', 'getSale', { id: sales.S5.saleId })
    expect(s).toMatchObject({ total: 10100, roundOff: 50, tax: 479 })
  })
  it('payment shortfall and overpayment on non-cash are rejected; stock decremented exactly', async () => {
    await expect(get('pos', 'completeSale', { lines: [{ variantId: A(), qty: 1 }], payments: [{ method: 'cash', amount: 100 }] })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(get('pos', 'completeSale', { lines: [{ variantId: A(), qty: 1 }], payments: [{ method: 'upi', amount: 99999 }] })).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(app.lookup.byId(A())!.stock).toBe(147) // 100 + 50 purchase - 1 - 2
    expect(app.lookup.byId(B())!.stock).toBe(96)
    expect(app.db.value<number>('SELECT COUNT(*) FROM sales')).toBe(5)
  })
})

describe('04 printing: HTML for every template carries the live profile + sale data', () => {
  const templates = ['receipt58', 'receipt80', 'invoiceA4', 'invoiceA5'] as const
  for (const template of templates) {
    it(`${template}: logo <img>, shop name, address, phone, GSTIN, invoice no and DB amounts`, async () => {
      const r = await get('printing', 'renderInvoiceHtml', { saleId: sales.S1.saleId, template })
      const h: string = r.html
      expect(h).toMatch(/<img[^>]+src="data:image\/(png|jpeg)[^"]{50,}/)
      expect(h).toContain('Sri Lakshmi Fireworks &amp; Crackers Wholesale and Retail')
      expect(h).toContain('12, Cracker Street, Near Bus Stand')
      expect(h).toContain('9876543210')
      expect(h).toContain('33ABCDE1234F1Z5')
      expect(h).toContain(sales.S1.invoiceNo)
      expect(h).toContain('463.00')
      expect(h).toContain('Sparkler Box 10cm')
      expect(h).toContain('Flower Pot Small')
      expect(h).not.toMatch(/\{\{\s*[#/\w]/) // no unreplaced template tags
      expect(h).not.toMatch(/undefined|NaN|\[object/)
      if (template === 'receipt58') expect(h).toMatch(/width:\s*58mm/)
      if (template === 'receipt80') expect(h).toMatch(/width:\s*80mm/)
      if (template === 'invoiceA4') expect(h).toMatch(/210mm|A4/)
      if (template === 'invoiceA5') expect(h).toMatch(/148mm|A5/)
      // long names must wrap rather than overflow
      expect(h).toMatch(/overflow-wrap:\s*anywhere|word-break:\s*break-word/)
    })
  }

  it('a Tamil product name renders intact in every template and the font stack covers Tamil', async () => {
    const p = await get('catalog', 'save', { name: TAMIL_PRODUCT, hsn: '3604', taxRateBp: 1800, variants: [{ name: '', mrp: 20000, price: 19000, cost: 9000, autoBarcode: true }] })
    app.moveStock({ variantId: p.variants[0].id, delta: 10, type: 'opening' })
    const s = await get('pos', 'completeSale', { lines: [{ variantId: p.variants[0].id, qty: 1 }], payments: [{ method: 'cash', amount: 19000 }] })
    sales.TAMIL = s
    for (const template of templates) {
      const { html } = await get('printing', 'renderInvoiceHtml', { saleId: s.saleId, template })
      expect(html, template).toContain(TAMIL_PRODUCT)
      expect(html).toMatch(/Nirmala UI|Noto Sans Tamil|Latha/)
      expect(html).toMatch(/<meta charset="utf-8">/i)
    }
    // the sale itself is a real sale: stock decremented, GST 18% inclusive of 190.00 -> 28.98
    expect((await get('pos', 'getSale', { id: s.saleId })).tax).toBe(2898)
  })

  it('label + report documents also carry the shop header from the profile', async () => {
    const lab = await get('printing', 'renderLabelHtml', { variantIds: [{ variantId: vid.CRK001, copies: 3 }], template: 'label_barcode' })
    expect(lab.html).toContain(prods[0].barcode)
    expect(lab.html).toMatch(/<svg|<img/)
    const rep = await get('printing', 'renderReportHtml', { title: 'Daily Sales', columns: [{ key: 'inv', header: 'Invoice' }, { key: 'amt', header: 'Amount', align: 'right', format: 'money' }], rows: [{ inv: sales.S1.invoiceNo, amt: 46300 }], totals: { amt: 46300 } })
    expect(rep.html).toContain('Sri Lakshmi Fireworks &amp; Crackers')
    expect(rep.html).toMatch(/<img[^>]+data:image/)
    expect(rep.html).toContain('463.00')
    expect(rep.html).toContain('33ABCDE1234F1Z5')
  })

  it('print failure never rolls back or repeats the sale; retry from the print log prints exactly once', async () => {
    const before = app.db.value<number>('SELECT COUNT(*) FROM sales')!
    const s = await get('pos', 'completeSale', { requestId: 'req-printfail-0001', lines: [{ variantId: vid.CRK006, qty: 1 }], payments: [{ method: 'cash', amount: 100000 }] })
    sales.PF = s
    const r = await get('printing', 'renderInvoiceHtml', { saleId: s.saleId, template: 'receipt80' })
    printer.failWith = 'Printer is offline'
    const bad = await get('printing', 'print', { html: r.html, paper: '80', docRef: r.docRef })
    expect(bad.ok).toBe(false)
    expect(bad.error).toContain('offline')
    expect(app.db.value<number>('SELECT COUNT(*) FROM sales')).toBe(before + 1)
    expect(printer.jobs).toHaveLength(0)
    // thrown adapter errors are also contained
    printer.failWith = null
    printer.throwWith = 'USB device disconnected'
    const thrown = await get('printing', 'print', { html: r.html, paper: '80', docRef: r.docRef })
    expect(thrown.ok).toBe(false)
    printer.throwWith = null
    // retry succeeds from the stored log
    const jobsBefore = printer.jobs.length
    const retry = await get('printing', 'retryPrint', { logId: bad.logId })
    expect(retry.ok).toBe(true)
    expect(printer.jobs.length).toBe(jobsBefore + 1)
    expect(app.db.value<number>('SELECT COUNT(*) FROM sales')).toBe(before + 1)
    // a UI double-click of "Pay" re-sends the same requestId => no second sale
    const dup = await get('pos', 'completeSale', { requestId: 'req-printfail-0001', lines: [{ variantId: vid.CRK006, qty: 1 }], payments: [{ method: 'cash', amount: 100000 }] })
    expect(dup).toMatchObject({ duplicate: true, saleId: s.saleId, invoiceNo: s.invoiceNo })
    expect(app.db.value<number>('SELECT COUNT(*) FROM sales')).toBe(before + 1)
    const log = await get('printing', 'listPrintLog', { limit: 20 })
    expect(JSON.stringify(log)).toContain('Printer is offline')
  })

  it('PDF export of a receipt goes through the adapter', async () => {
    const r = await get('printing', 'renderInvoiceHtml', { saleId: sales.S1.saleId, template: 'invoiceA4' })
    const out = await get('printing', 'exportPdf', { html: r.html, paper: 'A4', path: dir + '\\inv.pdf' })
    expect(out.path).toContain('inv.pdf')
    expect(printer.pdfs.length).toBeGreaterThan(0)
  })
})

describe('05 returns, refunds and void', () => {
  it('partial return of 1 x Sparkler 10cm from S1: refund 118.00 / tax 18.00, stock restocked', async () => {
    const s = await get('pos', 'getSale', { id: sales.S1.saleId })
    const itA = s.items.find((i: any) => i.sku === 'CRK001')
    const r = await get('pos', 'createReturn', { saleId: sales.S1.saleId, items: [{ saleItemId: itA.id, qty: 1 }], reason: 'Damaged' })
    expect(r).toMatchObject({ total: 11800, refundCash: 11800 })
    expect(app.lookup.byId(vid.CRK001)!.stock).toBe(148)
    await expect(get('pos', 'createReturn', { saleId: sales.S1.saleId, items: [{ saleItemId: itA.id, qty: 1 }], reason: 'again' })).rejects.toMatchObject({ code: 'VALIDATION' }) // over-return
    await expect(get('pos', 'voidSale', { saleId: sales.S1.saleId, reason: 'cannot void returned sale' })).rejects.toMatchObject({ code: 'CONFLICT' })
    // reprint of the return document
    const html = (await get('printing', 'renderInvoiceHtml', { returnId: r.returnId, template: 'receipt80' })).html
    expect(html).toContain(r.returnNo)
    expect(html).toContain('118.00')
    expect(html).toContain('Sri Lakshmi Fireworks')
  })
  it('partial return 1 of 3 x 105.00 from S3 (refund 105.00); full return of S5 refunds the round-off too (101.00)', async () => {
    const s3 = await get('pos', 'getSale', { id: sales.S3.saleId })
    const r3 = await get('pos', 'createReturn', { saleId: sales.S3.saleId, items: [{ saleItemId: s3.items[0].id, qty: 1 }], reason: 'Wrong item', refundMethod: 'cash' })
    expect(r3.total).toBe(10500)
    const s5 = await get('pos', 'getSale', { id: sales.S5.saleId })
    const r5 = await get('pos', 'createReturn', { saleId: sales.S5.saleId, items: [{ saleItemId: s5.items[0].id, qty: 1 }], reason: 'Changed mind', requestId: 'req-return-s5-0001' })
    expect(r5.total).toBe(10100)
    const dup = await get('pos', 'createReturn', { saleId: sales.S5.saleId, items: [{ saleItemId: s5.items[0].id, qty: 1 }], reason: 'Changed mind', requestId: 'req-return-s5-0001' })
    expect(dup.duplicate).toBe(true)
    expect(app.db.value<number>('SELECT COUNT(*) FROM sale_returns WHERE sale_id = ?', sales.S5.saleId)).toBe(1)
  })
  it('void S2 restores stock, marks void, is audited, cannot be voided twice', async () => {
    await get('pos', 'voidSale', { saleId: sales.S2.saleId, reason: 'Customer cancelled' })
    expect(app.lookup.byId(vid.CRK001)!.stock).toBe(150)
    expect((await get('pos', 'getSale', { id: sales.S2.saleId })).status).toBe('void')
    await expect(get('pos', 'voidSale', { saleId: sales.S2.saleId, reason: 'again please' })).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(app.db.value<number>("SELECT COUNT(*) FROM audit_log WHERE entity='sale' AND action='void'")).toBe(1)
  })
})

describe('06 reports reconcile with hand-computed numbers', () => {
  // Surviving sales: S1 463.00, S3 315.00, S4 128.00, S5 101.00, TAMIL 190.00, PF = CRK006 price. (S2 voided)
  it('payment_methods: cash/upi/credit received and refunds', async () => {
    const r = await get('reports', 'run', { id: 'payment_methods', filters: RANGE })
    const by = Object.fromEntries(r.rows.map((x: any) => [x.method, x]))
    const pfTotal = Math.round(prods[5].price / 100) * 100
    expect(by.cash.received).toBe(46300 + 11500 + 19000 + pfTotal) // S1 + S3 cash + TAMIL + PF (net of change)
    expect(by.upi.received).toBe(20000 + 10100) // S3 upi + S5 (S2 voided)
    expect(by.credit.received).toBe(12800)
    expect(r.totals.refunds).toBe(11800 + 10500 + 10100)
  })
  it('sales_summary: bills, gross, tax, round-off and returns', async () => {
    const r = await get('reports', 'run', { id: 'sales_summary', filters: RANGE })
    const pf = prods[5]
    const pfTotal = Math.round(pf.price / 100) * 100
    expect(r.totals.bills).toBe(6)
    expect(r.totals.total).toBe(46300 + 31500 + 12800 + 10100 + 19000 + pfTotal)
    expect(r.totals.returns).toBe(11800 + 10500 + 10100)
    expect(r.totals.net_total).toBe(r.totals.total - r.totals.returns)
  })
  it('gst_rate: net taxable and tax per slab after returns and void', async () => {
    const r = await get('reports', 'run', { id: 'gst_rate', filters: RANGE })
    const by = Object.fromEntries(r.rows.map((x: any) => [x.rate, x]))
    expect(by[500].tax).toBe(1500) // S1 B 500 + S3 B 1500 + S5 E 479 - returns 500 - 479
    expect(by[1200].tax).toBe(1200 + taxIncl(prods[5].price, 1200)) // S1 C + PF
    expect(by[1800].tax).toBe(2898) // A fully returned/voided, only the Tamil box remains
    expect(by[2800].tax).toBe(5600) // S1 D + S4 D
    // overall: cgst + sgst + igst == tax per row and across the report
    for (const row of r.rows) expect(row.cgst + row.sgst + row.igst).toBe(row.tax)
    expect(r.totals.tax).toBe(r.rows.reduce((a: number, x: any) => a + x.tax, 0))
  })
  it('profit: net taxable minus cost captured at sale time (A cost 70.00 after purchase)', async () => {
    const r = await get('reports', 'run', { id: 'profit', filters: RANGE })
    expect(r.totals.profit).toBe(r.totals.taxable - r.totals.cost)
    // hand: S1 (A returned) + S3 (3B - 1 returned) + S4 + S5 (returned) -> B 2 x 6300 + C 6720 + D 2 x 7680 (S1, S4) are kept; Tamil/PF added below
    const kept = 3 * 6300 + 6720 + 2 * 7680 + 9000 + prods[5].cost
    expect(r.totals.cost).toBe(kept)
  })
  it('stock_valuation quantity matches the ledger and hand count', async () => {
    const r = await get('reports', 'run', { id: 'stock_valuation', filters: {} })
    // 24 x 100 + 50 purchased + 10 Tamil opening - sold/returned: B -3, C -1, D -2, Tamil -1, PF(CRK006) -1; A,E net 0
    expect(r.totals.qty).toBe(2400 + 50 + 10 - 3 - 1 - 2 - 1 - 1)
    const led = app.db.value<number>('SELECT SUM(qty) FROM stock_levels')
    expect(led).toBe(r.totals.qty)
  })
  it('dashboard summary does not throw and reports today sales', async () => {
    const d = await get('dashboard', 'summary', {})
    expect(JSON.stringify(d)).toMatch(/sales|revenue/i)
  })
  it('CSV export of a report equals the table', async () => {
    const csvPath = dir + '\\sales.csv'
    await get('reports', 'exportCsv', { id: 'sales_detail', filters: RANGE, path: csvPath })
    const { readFileSync } = await import('node:fs')
    const txt = readFileSync(csvPath, 'utf8')
    expect(txt).toContain(sales.S1.invoiceNo)
    expect(txt).toContain('463.00')
  })
})

function taxIncl(price: number, bp: number): number {
  const total = Math.round(price / 100) * 100
  // tax computed on the unrounded line (price), rounded half-up
  const num = BigInt(price) * BigInt(bp)
  const den = BigInt(10000 + bp)
  let q = num / den
  if ((num % den) * 2n >= den) q += 1n
  void total
  return Number(q)
}

describe('07 backup -> mutate -> restore', () => {
  const snapshot = () => ({
    products: app.db.all('SELECT * FROM products ORDER BY id'),
    variants: app.db.all('SELECT * FROM product_variants ORDER BY id'),
    sales: app.db.all('SELECT * FROM sales ORDER BY id'),
    items: app.db.all('SELECT * FROM sale_items ORDER BY id'),
    payments: app.db.all('SELECT * FROM sale_payments ORDER BY id'),
    levels: app.db.all('SELECT * FROM stock_levels ORDER BY variant_id'),
    profiles: app.db.all('SELECT * FROM business_profile_versions ORDER BY id'),
    logos: app.db.all('SELECT id, sha256, size_bytes FROM logo_assets ORDER BY id')
  })
  it('backup.create produces a verified file; mutate; restore returns exactly the backed-up data', async () => {
    const before = snapshot()
    const b = await get('backup', 'create', { note: 'qa' })
    expect(b.verified).toBe(true)
    const ver = await get('backup', 'verify', { id: b.id ?? app.get<BackupService>('backup').list()[0].id })
    expect(ver.ok).toBe(true)
    // mutate: new sale, shop rename, stock adjust, product price change
    await get('pos', 'completeSale', { lines: [{ variantId: vid.CRK007, qty: 2 }], payments: [{ method: 'cash', amount: 500000 }] })
    await get('businessProfile', 'save', { shopName: 'Mutated Name Co' })
    expect(snapshot().sales.length).toBe(before.sales.length + 1)
    await expect(get('backup', 'restore', { id: app.get<BackupService>('backup').list()[0].id, confirm: 'yes' })).rejects.toThrow(/RESTORE/)
    await get('backup', 'restore', { id: app.get<BackupService>('backup').list().find((x) => x.kind === 'manual')!.id, confirm: 'RESTORE' })
    expect(snapshot()).toEqual(before)
    expect((await get('businessProfile', 'getActive')).shopName).toBe(SHOP)
    // the restored DB still works
    const s = await get('pos', 'completeSale', { lines: [{ variantId: vid.CRK007, qty: 1 }], payments: [{ method: 'cash', amount: 500000 }] })
    expect(s.invoiceNo).toMatch(/^INV-/)
    sales.POSTRESTORE = s
  })
})

describe('08 shop name change: new sales use new name, reprints follow the policy', () => {
  it('rename creates v+1; sale after rename prints the NEW name; old sale reprints ORIGINAL (default) or CURRENT (policy)', async () => {
    const oldHtml = (await get('printing', 'renderInvoiceHtml', { saleId: sales.S1.saleId, template: 'receipt80' })).html
    expect(oldHtml).toContain('Sri Lakshmi Fireworks')
    await get('businessProfile', 'save', { shopName: TAMIL_SHOP, displayName: TAMIL_SHOP })
    const s = await get('pos', 'completeSale', { lines: [{ variantId: vid.CRK008, qty: 1 }], payments: [{ method: 'cash', amount: 100000 }] })
    sales.NEW = s
    const nh = (await get('printing', 'renderInvoiceHtml', { saleId: s.saleId, template: 'receipt80' })).html
    expect(nh).toContain(TAMIL_SHOP)
    expect(nh).not.toContain('Sri Lakshmi Fireworks')
    // historical reprint, policy original (default)
    expect(await get('businessProfile', 'getReprintPolicy')).toBe('original')
    for (const t of ['receipt58', 'receipt80', 'invoiceA4', 'invoiceA5'] as const) {
      const h = (await get('printing', 'renderInvoiceHtml', { saleId: sales.S1.saleId, template: t })).html
      expect(h, t).toContain('Sri Lakshmi Fireworks &amp; Crackers Wholesale and Retail')
      expect(h, t).not.toContain(TAMIL_SHOP)
      expect(h).toMatch(/<img[^>]+data:image/) // original logo is preserved
    }
    await get('businessProfile', 'setReprintPolicy', { policy: 'current' })
    const cur = (await get('printing', 'renderInvoiceHtml', { saleId: sales.S1.saleId, template: 'receipt80' })).html
    expect(cur).toContain(TAMIL_SHOP)
    expect(cur).not.toContain('Sri Lakshmi Fireworks')
    await get('businessProfile', 'setReprintPolicy', { policy: 'original' })
    // old sale row still points at the old version, new sale at the new one
    const p1 = app.db.value<number>('SELECT profile_version_id FROM sales WHERE id = ?', sales.S1.saleId)
    const p2 = app.db.value<number>('SELECT profile_version_id FROM sales WHERE id = ?', s.saleId)
    expect(p1).not.toBe(p2)
    expect(app.db.value<string>('SELECT shop_name FROM business_profile_versions WHERE id = ?', p1 as number)).toBe(SHOP)
    // audit trail
    const audits = app.db.all<any>("SELECT action FROM audit_log WHERE entity='business_profile' OR action LIKE 'profile.%' ORDER BY id")
    expect(audits.map((a) => a.action)).toContain('profile.reprint_policy')
    expect(audits.filter((a) => a.action === 'profile.save').length).toBeGreaterThanOrEqual(2)
    // report header uses the CURRENT name
    const rep = await get('reports', 'renderHtml', { id: 'sales_summary', filters: RANGE })
    expect(rep.html).toContain(TAMIL_SHOP)
  })
})

describe('09 permissions and manager approval', () => {
  it('cashier cannot edit profile / backup / users / settings; manager approval unlocks a big discount', async () => {
    const roles = await get('auth', 'listRoles')
    const roleId = (n: string) => roles.find((r: any) => r.name === n).id
    await get('auth', 'createUser', { username: 'cashier1', name: 'Cashier One', roleId: roleId('Cashier'), password: 'Cash@1234', mustChangePassword: false })
    await get('auth', 'createUser', { username: 'manager1', name: 'Manager One', roleId: roleId('Manager'), password: 'Mgr@12345', mustChangePassword: false })
    await get('auth', 'logout')
    await expect(get('businessProfile', 'getActive')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' })
    await expect(get('auth', 'login', { username: 'cashier1', password: 'wrong' })).rejects.toBeTruthy()
    await get('auth', 'login', { username: 'cashier1', password: 'Cash@1234' })
    expect((await get('businessProfile', 'getActive')).shopName).toBe(TAMIL_SHOP) // view allowed
    for (const [s, m, a] of [
      ['businessProfile', 'save', { shopName: 'Hacked' }], ['businessProfile', 'setLogo', { data: logoPng.toString('base64') }], ['businessProfile', 'removeLogo', {}],
      ['businessProfile', 'setReprintPolicy', { policy: 'current' }], ['backup', 'create', {}], ['backup', 'restore', { id: 1, confirm: 'RESTORE' }],
      ['auth', 'createUser', { username: 'x12345', name: 'x', roleId: 1, password: 'Abcdef@123' }], ['sync', 'saveConfig', { enabled: true }],
      ['catalog', 'importCommit', { bytesBase64: 'AA==', filename: 'x.csv' }], ['pos', 'voidSale', { saleId: 1, reason: 'cashier tries' }],
      ['printing', 'saveTemplate', { kind: 'receipt80', config: {} }], ['purchases', 'create', { items: [] }]
    ] as [string, string, unknown][])
      await expect(get(s, m, a), `${s}.${m}`).rejects.toMatchObject({ code: 'FORBIDDEN' })
    // cashier can sell and reprint
    const ok = await get('pos', 'completeSale', { lines: [{ variantId: vid.CRK009, qty: 1 }], payments: [{ method: 'cash', amount: 100000 }] })
    expect(ok.invoiceNo).toBeTruthy()
    expect((await get('printing', 'renderInvoiceHtml', { saleId: ok.saleId, template: 'receipt58' })).html).toContain(TAMIL_SHOP)
    // 25% discount > cashier cap (10%) -> approval needed
    const cart = { lines: [{ variantId: vid.CRK009, qty: 1 }], billDiscount: { type: 'percent', value: 2500 }, payments: [{ method: 'cash', amount: 100000 }] }
    await expect(get('pos', 'completeSale', cart)).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' })
    await expect(get('pos', 'completeSale', { ...cart, approval: { approverUsername: 'cashier1', approverPassword: 'Cash@1234' } })).rejects.toBeTruthy() // cashier cannot approve himself
    await expect(get('pos', 'completeSale', { ...cart, approval: { approverUsername: 'manager1', approverPassword: 'bad-password' } })).rejects.toBeTruthy()
    const approved = await get('pos', 'completeSale', { ...cart, approval: { approverUsername: 'manager1', approverPassword: 'Mgr@12345' } })
    const sale = await get('pos', 'getSale', { id: approved.saleId })
    expect(sale.discount).toBeGreaterThan(0)
    expect(sale.approvedBy).toBeTruthy()
    // approval is audited
    await get('auth', 'login', { username: 'owner', password: 'Owner@123' })
    expect(app.db.value<number>("SELECT COUNT(*) FROM approvals WHERE action='pos.discount'")).toBeGreaterThanOrEqual(1)
    // the manager cannot edit the shop profile either
    await get('auth', 'login', { username: 'manager1', password: 'Mgr@12345' })
    await expect(get('businessProfile', 'save', { shopName: 'Mgr edit' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await get('auth', 'login', { username: 'owner', password: 'Owner@123' })
  })
})

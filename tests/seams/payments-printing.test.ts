import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestApp } from '../helpers'
import type { App } from '../../src/main/core/app'
import type { PrintingService } from '../../src/main/modules/printing/service'
import { FakePrinter } from '../printing/fixtures'

let app: App
let fake: FakePrinter
let variantId: number
const call = <T = any>(svc: string, method: string, args?: unknown) => app.call(svc, method, args) as Promise<T>

beforeEach(() => {
  app = createTestApp()
  fake = new FakePrinter()
  app.get<PrintingService>('printing').setAdapter(fake)
  const p = app.db.run('INSERT INTO products(uuid,name,tax_rate_bp,hsn,track_stock) VALUES (?,?,?,?,?)', app.uuid(), 'Rocket', 0, '3604', 0)
  variantId = app.db.run('INSERT INTO product_variants(uuid,product_id,sku,barcode,price,mrp,cost) VALUES (?,?,?,?,?,?,?)', app.uuid(), p.lastId, 'RKT', 'BC-RKT', 64000, 64000, 30000).lastId
})

describe('payment semantics: payments are NET of change, everywhere', () => {
  it('cash 1000 on a 640 bill -> payments report 640, shift expected cash = opening + 640, receipt shows Received 1000 / Change 360', async () => {
    await call('pos', 'openShift', { openingCash: 100000 })
    const sale = await call('pos', 'completeSale', { lines: [{ variantId, qty: 1 }], payments: [{ method: 'cash', amount: 100000 }] })
    expect(sale.total).toBe(64000)
    expect(sale.change).toBe(36000)

    const range = { from: '2000-01-01', to: '2999-12-31' }
    const pay = await call('reports', 'run', { id: 'payment_methods', filters: range })
    const cash = pay.rows.find((r: any) => r.method === 'cash')
    expect(cash.received).toBe(64000)
    expect(cash.net).toBe(64000)
    expect(pay.totals.net).toBe(64000)

    const sum = await call('pos', 'shiftSummary', {})
    expect(sum.expectedCash).toBe(100000 + 64000)
    const rec = await call('reports', 'run', { id: 'shift_cash', filters: range })
    expect(rec.rows[0]).toMatchObject({ opening_cash: 100000, cash_sales: 64000, expected: 164000 })
    const dash = await call('dashboard', 'summary', {})
    expect(dash.openShift.cashSales).toBe(64000)

    for (const template of ['receipt58', 'receipt80', 'invoiceA4', 'invoiceA5'] as const) {
      const { html } = await call('printing', 'renderInvoiceHtml', { saleId: sale.saleId, template })
      expect(html, template).toMatch(/Received:?\s*(<[^>]+>\s*)*₹?\s*1,000\.00/)
      expect(html, template).toMatch(/Change:?\s*(<[^>]+>\s*)*₹?\s*360\.00/)
    }
  })

  it('a voided cash sale leaves the shift expected cash unchanged, in POS and in the report', async () => {
    await call('pos', 'openShift', { openingCash: 50000 })
    const s = await call('pos', 'completeSale', { lines: [{ variantId, qty: 1 }], payments: [{ method: 'cash', amount: 70000 }] })
    await call('pos', 'voidSale', { saleId: s.saleId, reason: 'test void' })
    expect((await call('pos', 'shiftSummary', {})).expectedCash).toBe(50000)
    const rec = await call('reports', 'run', { id: 'shift_cash', filters: { from: '2000-01-01', to: '2999-12-31' } })
    expect(rec.rows[0].expected).toBe(50000)
  })
})

describe('POS -> printing wiring (same calls the renderer printAdapter makes)', () => {
  const paperOf = { receipt58: '58', receipt80: '80', invoiceA4: 'A4', invoiceA5: 'A5' } as const
  for (const template of Object.keys(paperOf) as (keyof typeof paperOf)[]) {
    it(`${template}: renderInvoiceHtml -> print(paper=${paperOf[template]}, docRef) logs and prints`, async () => {
      const sale = await call('pos', 'completeSale', { lines: [{ variantId, qty: 1 }], payments: [{ method: 'upi', amount: 64000 }] })
      const r = await call('printing', 'renderInvoiceHtml', { saleId: sale.saleId, template })
      expect(r.docRef).toBe(sale.invoiceNo)
      const res = await call('printing', 'print', { html: r.html, paper: paperOf[template], docRef: r.docRef })
      expect(res.ok).toBe(true)
      expect(fake.jobs).toHaveLength(1)
      expect(app.db.value('SELECT doc_ref FROM print_log ORDER BY id DESC LIMIT 1')).toBe(sale.invoiceNo)
    })
  }

  it('a print FAILURE leaves exactly one sale, is retryable, and listPrinterProfiles works', async () => {
    const sale = await call('pos', 'completeSale', { lines: [{ variantId, qty: 1 }], payments: [{ method: 'cash', amount: 64000 }] })
    fake.failWith = 'Printer is offline'
    const r = await call('printing', 'renderInvoiceHtml', { saleId: sale.saleId, template: 'receipt80' })
    const res = await call('printing', 'print', { html: r.html, paper: '80', docRef: r.docRef })
    expect(res).toMatchObject({ ok: false, error: 'Printer is offline' })
    expect(app.db.value('SELECT COUNT(*) FROM sales')).toBe(1)
    fake.failWith = null
    const retry = await call('printing', 'retryPrint', { logId: res.logId })
    expect(retry.ok).toBe(true)
    expect(fake.jobs).toHaveLength(1)
    expect(app.db.value('SELECT COUNT(*) FROM sales')).toBe(1)
    expect(Array.isArray(await call('printing', 'listPrinterProfiles'))).toBe(true)
  })

  it('Save PDF with a bare file name never writes to the working directory (userData/pdf fallback without a dialog)', async () => {
    const sale = await call('pos', 'completeSale', { lines: [{ variantId, qty: 1 }], payments: [{ method: 'cash', amount: 64000 }] })
    const r = await call('printing', 'renderInvoiceHtml', { saleId: sale.saleId, template: 'invoiceA5' })
    const out = await call('printing', 'exportPdf', { html: r.html, path: `${sale.invoiceNo}.pdf`, paper: 'A5' })
    expect(out.path.startsWith(app.userDataDir)).toBe(true)
    expect(existsSync(out.path)).toBe(true)
    expect(fake.pdfs[0].opts.widthMm).toBe(148)
    // an absolute path is honoured as-is
    const abs = join(mkdtempSync(join(tmpdir(), 'pdf-')), 'x.pdf')
    expect((await call('printing', 'exportPdf', { html: r.html, path: abs })).path).toBe(abs)
  })

  it('a chooser (save dialog) is used for bare names and cancelling reports an error', async () => {
    const printing = app.get<PrintingService>('printing')
    const dir = mkdtempSync(join(tmpdir(), 'pdf-'))
    ;(fake as any).chooseSavePath = async (name: string) => join(dir, name)
    const out = await printing.exportPdf({ html: '<html></html>', path: 'A.pdf' })
    expect(out.path).toBe(join(dir, 'A.pdf'))
    ;(fake as any).chooseSavePath = async () => null
    await expect(printing.exportPdf({ html: '<html></html>', path: 'B.pdf' })).rejects.toMatchObject({ code: 'PRINT_FAILED' })
  })

  it('catalog labels (label_barcode) and report print/PDF shapes work against the real printing service', async () => {
    const lab = await call('printing', 'renderLabelHtml', { variantIds: [{ variantId, copies: 2 }], template: 'label_barcode' })
    expect(lab.html).toContain('Rocket')
    expect((await call('printing', 'print', { html: lab.html, paper: 'label' })).ok).toBe(true)

    const rep = await call('reports', 'renderHtml', { id: 'payment_methods', filters: { from: '2000-01-01', to: '2999-12-31' } })
    expect(rep.html).toContain('Test Shop') // header comes from businessProfile
    expect((await call('printing', 'print', { html: rep.html, paper: 'A4' })).ok).toBe(true)
    const pdf = await call('reports', 'exportPdf', { id: 'payment_methods', filters: { from: '2000-01-01', to: '2999-12-31' } })
    expect(pdf.mime).toBe('application/pdf')
    expect(pdf.base64).toBeTruthy()
  })
})

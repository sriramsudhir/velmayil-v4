import { describe, it, expect, beforeEach } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { actAs, createTestApp } from '../helpers'
import type { PrintingService } from '../../src/main/modules/printing/service'
import type { BusinessProfileService } from '../../src/main/modules/businessProfile/service'
import { FakePrinter, insertSale, makePng } from './fixtures'
import { TEMPLATE_KINDS } from '../../src/main/modules/printing/config'

type A = ReturnType<typeof createTestApp>
const printing = (a: A) => a.get<PrintingService>('printing')
const profile = (a: A) => a.get<BusinessProfileService>('businessProfile')
const INVOICES = ['receipt58', 'receipt80', 'invoiceA4', 'invoiceA5'] as const

function setup() {
  const app = createTestApp()
  const fake = new FakePrinter()
  printing(app).setAdapter(fake)
  return { app, fake }
}

describe('shop name change: Old -> New', () => {
  let app: A
  let oldSale: number
  let newSale: number
  beforeEach(() => {
    ;({ app } = setup())
    profile(app).save({ shopName: 'Old', displayName: 'Old', address: 'Old Street 1' })
    const oldV = profile(app).getActive().id
    oldSale = insertSale(app, { invoiceNo: 'INV-OLD-1', profileVersionId: oldV })
    profile(app).save({ shopName: 'New', displayName: 'New', address: 'New Avenue 9' })
    newSale = insertSale(app, { invoiceNo: 'INV-NEW-1', profileVersionId: profile(app).getActive().id })
  })

  for (const tpl of INVOICES) {
    it(`${tpl}: new invoices use New; the old sale reprints with Old (policy original) and New (policy current)`, () => {
      const fresh = printing(app).renderInvoiceHtml({ saleId: newSale, template: tpl })
      expect(fresh.html).toContain('New Avenue 9')
      expect(fresh.html).not.toContain('Old Street 1')
      expect(fresh.profileVersion).toBe(profile(app).getActive().version)

      const reprint = printing(app).renderInvoiceHtml({ saleId: oldSale, template: tpl })
      expect(reprint.html).toContain('Old Street 1')
      expect(reprint.html).not.toContain('New Avenue 9')
      expect(reprint.docRef).toBe('INV-OLD-1')

      const current = printing(app).renderInvoiceHtml({ saleId: oldSale, template: tpl, policy: 'current' })
      expect(current.html).toContain('New Avenue 9')
      expect(current.html).not.toContain('Old Street 1')
    })
  }

  it('the global reprint_profile_policy setting switches reprints to the current profile', () => {
    expect(printing(app).renderInvoiceHtml({ saleId: oldSale, template: 'receipt80' }).html).toContain('Old Street 1')
    app.setSetting('reprint_profile_policy', 'current')
    expect(printing(app).renderInvoiceHtml({ saleId: oldSale, template: 'receipt80' }).html).toContain('New Avenue 9')
  })

  it('labels and reports always use the current profile', () => {
    const v = app.db.value<number>('SELECT id FROM product_variants ORDER BY id DESC LIMIT 1')!
    const label = printing(app).renderLabelHtml({ variantIds: [{ variantId: v, copies: 2 }], template: 'label_barcode' })
    expect(label.html).toContain('New')
    expect(label.html).not.toContain('Old Street')
    const rep = printing(app).renderReportHtml({ title: 'Sales', columns: [{ key: 'a', header: 'A' }], rows: [{ a: 1 }] })
    expect(rep.html).toContain('New Avenue 9')
    expect(rep.html).not.toContain('Old Street 1')
  })

  it('designer preview (preview:true) shows the ACTIVE profile on a real, older sale', () => {
    const r = printing(app).renderInvoiceHtml({ saleId: oldSale, template: 'invoiceA4', preview: true })
    expect(r.html).toContain('New Avenue 9')
    expect(r.docRef).toBe('INV-OLD-1')
  })

  it('without ids the preview uses the latest REAL sale', () => {
    const r = printing(app).renderInvoiceHtml({ template: 'receipt58', preview: true })
    expect(r.docRef).toBe('INV-NEW-1')
    expect(r.html).toContain('Sparkler Box')
    expect(r.html).not.toContain('SAMPLE')
  })

  it('goes through the IPC dispatcher too (cashier may reprint)', async () => {
    actAs(app, 'Cashier')
    const r = (await app.call('printing', 'renderInvoiceHtml', { saleId: oldSale, template: 'receipt58' })) as { html: string }
    expect(r.html).toContain('Old Street 1')
  })
})

describe('real data vs sample data', () => {
  it('without any sale and without sample:true -> NOT_FOUND (never silently fakes)', () => {
    const { app } = setup()
    expect(() => printing(app).renderInvoiceHtml({ template: 'receipt58' })).toThrow(/No sales yet/)
    expect(() => printing(app).renderLabelHtml({ template: 'label_barcode' })).toThrow(/No products yet/)
  })
  it('sample:true renders synthetic lines but the REAL shop profile', () => {
    const { app } = setup()
    const r = printing(app).renderInvoiceHtml({ template: 'invoiceA4', sample: true })
    expect(r.html).toContain('SAMPLE-0001')
    expect(r.html).toContain('Test Shop')
    expect(r.html).toContain('1 Main Road')
    expect(printing(app).renderLabelHtml({ sample: true }).html).toContain('Sample product name')
  })
  it('credit notes use the profile pinned on the return', () => {
    const { app } = setup()
    const v1 = profile(app).getActive().id
    const sale = insertSale(app, { invoiceNo: 'INV-R-1', profileVersionId: v1 })
    const item = app.db.get<any>('SELECT * FROM sale_items WHERE sale_id = ?', sale)!
    const ret = app.db.run(
      `INSERT INTO sale_returns(uuid,return_no,sale_id,pos_id,user_id,subtotal,tax,total,refund_method,profile_version_id) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      app.uuid(), 'RET-1', sale, app.localPos().id, app.session!.userId, 11800, 1800, 11800, 'cash', v1
    ).lastId
    app.db.run('INSERT INTO sale_return_items(return_id,sale_item_id,variant_id,qty,unit_price,tax_amount,line_total) VALUES (?,?,?,?,?,?,?)', ret, item.id, item.variant_id, 1, 11800, 1800, 11800)
    profile(app).save({ shopName: 'Renamed Later' })
    const r = printing(app).renderInvoiceHtml({ returnId: ret, template: 'receipt80' })
    expect(r.html).toContain('CREDIT NOTE')
    expect(r.html).toContain('Test Shop')
    expect(r.html).not.toContain('Renamed Later')
    expect(r.docRef).toBe('RET-1')
  })
  it('customer details and payments from the sale appear on the invoice', () => {
    const { app } = setup()
    const s = insertSale(app, { invoiceNo: 'INV-C-1', profileVersionId: profile(app).getActive().id, customer: { name: 'ராமு', phone: '9123456780' } })
    const html = printing(app).renderInvoiceHtml({ saleId: s, template: 'invoiceA4' }).html
    expect(html).toContain('ராமு')
    expect(html).toContain('9123456780')
    expect(html).toContain('Cash')
    expect(html).toContain('₹')
  })
})

describe('logo on documents', () => {
  it('prints the profile logo (aspect preserved) and pins it per version', () => {
    const { app } = setup()
    profile(app).setLogo({ data: makePng(400, 100) })
    profile(app).save({ logoSettings: { visible: true, widthMm: 30, heightMm: 0, alignment: 'center', position: 'top' } })
    const v = profile(app).getActive().id
    const s = insertSale(app, { invoiceNo: 'INV-L-1', profileVersionId: v })
    const html = printing(app).renderInvoiceHtml({ saleId: s, template: 'receipt80' }).html
    expect(html).toMatch(/<img class="logo"[^>]*src="data:image\/png;base64,[^"]+" style="width:30mm;height:auto;max-width:100%">/)
    profile(app).removeLogo()
    expect(printing(app).renderInvoiceHtml({ saleId: s, template: 'receipt80' }).html).toContain('<img class="logo"') // old sale keeps its logo
    const s2 = insertSale(app, { invoiceNo: 'INV-L-2', profileVersionId: profile(app).getActive().id })
    expect(printing(app).renderInvoiceHtml({ saleId: s2, template: 'receipt80' }).html).not.toContain('<img')
  })
})

describe('templates', () => {
  it('seeds a default for every kind lazily; none contains shop data', () => {
    const { app } = setup()
    expect(app.db.value('SELECT COUNT(*) FROM print_templates')).toBe(0)
    const list = printing(app).listTemplates()
    expect(list.map((t) => t.kind)).toEqual([...TEMPLATE_KINDS])
    expect(app.db.value('SELECT COUNT(*) FROM print_templates')).toBe(TEMPLATE_KINDS.length)
    printing(app).ensureTemplates()
    expect(app.db.value('SELECT COUNT(*) FROM print_templates')).toBe(TEMPLATE_KINDS.length) // idempotent
    const all = app.db.all<any>('SELECT config_json FROM print_templates').map((r) => r.config_json).join('')
    expect(all).not.toMatch(/Test Shop/)
  })
  it('saved options change the output; reset restores defaults', () => {
    const { app } = setup()
    const s = insertSale(app, { invoiceNo: 'INV-T-1', profileVersionId: profile(app).getActive().id })
    printing(app).saveTemplate('receipt58', { showAddress: false, fontSizePt: 9, footerText: 'Custom footer' })
    let html = printing(app).renderInvoiceHtml({ saleId: s, template: 'receipt58' }).html
    expect(html).not.toContain('1 Main Road')
    expect(html).toContain('font-size:9pt')
    expect(html).toContain('Custom footer')
    expect(app.db.get<any>("SELECT * FROM audit_log WHERE action='printing.template_save'")).toBeTruthy()
    // unsaved override for live preview
    html = printing(app).renderInvoiceHtml({ saleId: s, template: 'receipt58', config: { showAddress: true } }).html
    expect(html).toContain('1 Main Road')
    printing(app).resetTemplate('receipt58')
    html = printing(app).renderInvoiceHtml({ saleId: s, template: 'receipt58' }).html
    expect(html).toContain('1 Main Road')
    expect(html).not.toContain('Custom footer')
  })
  it('only printing.templates may edit; cashier can still render', async () => {
    const { app } = setup()
    actAs(app, 'Cashier')
    await expect(app.call('printing', 'saveTemplate', { kind: 'receipt58', config: { fontSizePt: 8 } })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(app.call('printing', 'resetTemplate', { kind: 'receipt58' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(app.call('printing', 'savePrinterProfile', { name: 'x', deviceName: '', kind: 'a4' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(((await app.call('printing', 'listTemplates')) as unknown[]).length).toBe(TEMPLATE_KINDS.length)
    app.session = { ...app.session!, permissions: ['*'] }
    await expect(app.call('printing', 'saveTemplate', { kind: 'bogus', config: {} })).rejects.toMatchObject({ code: 'VALIDATION' })
  })
})

describe('printing never breaks the sale', () => {
  it('a failing printer returns {ok:false,error}, leaves sales untouched and can be retried', async () => {
    const { app, fake } = setup()
    const v = profile(app).getActive().id
    const sale = insertSale(app, { invoiceNo: 'INV-P-1', profileVersionId: v })
    const snapshot = () => JSON.stringify([app.db.all('SELECT * FROM sales'), app.db.all('SELECT * FROM sale_items'), app.db.all('SELECT * FROM sale_payments'), app.db.all('SELECT * FROM stock_movements')])
    const before = snapshot()
    const r = printing(app).renderInvoiceHtml({ saleId: sale, template: 'receipt58' })

    fake.failWith = 'Printer is offline'
    const res = await printing(app).print({ html: r.html, paper: '58', docRef: r.docRef })
    expect(res.ok).toBe(false)
    expect(res.error).toBe('Printer is offline')
    expect(res.logId).toBeGreaterThan(0)
    expect(snapshot()).toBe(before)

    fake.throwWith = 'USB device vanished'
    const res2 = await printing(app).print({ html: r.html, paper: '58' })
    expect(res2).toMatchObject({ ok: false, error: 'USB device vanished' })

    const log = printing(app).listPrintLog({ onlyFailed: true })
    expect(log).toHaveLength(2)
    expect(log[1]).toMatchObject({ ok: false, paper: '58', docRef: 'INV-P-1', retryable: true })

    // printer comes back: retry the very same job
    fake.failWith = null
    fake.throwWith = null
    const retry = await printing(app).retryPrint({ logId: res.logId! })
    expect(retry.ok).toBe(true)
    expect(fake.jobs).toHaveLength(1)
    expect(fake.jobs[0].html).toContain('INV-P-1')
    expect(snapshot()).toBe(before)
  })

  it('through the IPC dispatcher a failed print resolves (does not reject)', async () => {
    const { app, fake } = setup()
    fake.failWith = 'No paper'
    const res = (await app.call('printing', 'print', { html: '<html><head></head><body>x</body></html>', paper: '80' })) as { ok: boolean; error: string }
    expect(res).toMatchObject({ ok: false, error: 'No paper' })
  })

  it('retry can target a different printer profile', async () => {
    const { app, fake } = setup()
    const other = printing(app).savePrinterProfile({ name: 'Backup 58', deviceName: 'Backup-Printer', kind: 'receipt58' })
    fake.failWith = 'Jammed'
    const res = await printing(app).print({ html: '<html><head></head><body>doc</body></html>', paper: '58' })
    fake.failWith = null
    const retry = await printing(app).retryPrint({ logId: res.logId!, printerProfileId: other.id })
    expect(retry.ok).toBe(true)
    expect(fake.jobs[0].opts.deviceName).toBe('Backup-Printer')
  })

  it('save as PDF is the fallback when the printer is dead', async () => {
    const { app, fake } = setup()
    const r = await printing(app).exportPdf({ html: '<html><head></head><body>doc</body></html>', paper: '80', name: 'INV 1/2' })
    expect(existsSync(r.path)).toBe(true)
    expect(readFileSync(r.path, 'utf8')).toContain('%PDF')
    expect(r.path).toMatch(/INV_1_2-\d+\.pdf$/)
    expect(fake.pdfs[0].opts.widthMm).toBe(80)
    const explicit = await printing(app).exportPdf({ html: '<html></html>', path: r.path.replace('.pdf', '-b.pdf'), paper: 'A4' })
    expect(existsSync(explicit.path)).toBe(true)
    expect(fake.pdfs[1].opts).toMatchObject({ widthMm: 210, heightMm: 297 })
    fake.pdfs.length = 0
  })

  it('a PDF failure is reported as PRINT_FAILED', async () => {
    const { app, fake } = setup()
    fake.toPdf = async () => { throw new Error('renderer crashed') }
    await expect(printing(app).exportPdf({ html: '<html></html>' })).rejects.toMatchObject({ code: 'PRINT_FAILED' })
  })

  it('cashier can print (reprint) but a user without any print permission cannot', async () => {
    const { app, fake } = setup()
    actAs(app, 'Cashier')
    const ok = (await app.call('printing', 'print', { html: '<html><head></head><body>x</body></html>', paper: '58' })) as { ok: boolean }
    expect(ok.ok).toBe(true)
    expect(fake.jobs).toHaveLength(1)
    app.session = { ...app.session!, permissions: ['catalog.view'] }
    await expect(app.call('printing', 'print', { html: '<html></html>', paper: '58' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('keeps only the latest 200 log rows', async () => {
    const { app } = setup()
    for (let i = 0; i < 205; i++) await printing(app).print({ html: '<html></html>', paper: 'A4' })
    expect(app.db.value('SELECT COUNT(*) FROM print_log')).toBe(200)
  })
})

describe('printer profiles & calibration', () => {
  it('CRUD, per-paper default and device selection', async () => {
    const { app, fake } = setup()
    const a = printing(app).savePrinterProfile({ name: 'Counter 58', deviceName: 'POS-58-USB', kind: 'receipt58', isDefault: true })
    const b = printing(app).savePrinterProfile({ name: 'Spare 58', deviceName: 'POS-58-SPARE', kind: 'receipt58', isDefault: true })
    expect(printing(app).listPrinterProfiles().find((p) => p.id === a.id)!.isDefault).toBe(false) // only one default per kind
    await printing(app).print({ html: '<html><head></head></html>', paper: '58' })
    expect(fake.jobs[0].opts.deviceName).toBe('POS-58-SPARE')
    await printing(app).print({ html: '<html><head></head></html>', paper: '58', printerProfileId: a.id })
    expect(fake.jobs[1].opts.deviceName).toBe('POS-58-USB')
    await printing(app).print({ html: '<html><head></head></html>', paper: 'A4' })
    expect(fake.jobs[2].opts.deviceName).toBe('') // system default printer
    expect(() => printing(app).savePrinterProfile({ name: 'Spare 58', deviceName: 'x', kind: 'a4' })).toThrow(/already exists/)
    printing(app).deletePrinterProfile(b.id)
    expect(printing(app).listPrinterProfiles()).toHaveLength(1)
    expect(await printing(app).listSystemPrinters()).toHaveLength(2)
  })
  it('applies calibration offsets/scale and page size to the job', async () => {
    const { app, fake } = setup()
    printing(app).savePrinterProfile({ name: 'Label', deviceName: 'LBL', kind: 'label', calibration: { offsetXmm: 1.5, offsetYmm: -2, scalePct: 98, silent: false }, isDefault: true })
    await printing(app).print({ html: '<html><head></head><body>l</body></html>', paper: 'label' })
    const job = fake.jobs[0]
    expect(job.html).toContain('left:1.5mm;top:-2mm;zoom:0.98')
    expect(job.html).toContain('Content-Security-Policy')
    expect(job.opts).toMatchObject({ silent: false, widthMm: 50, heightMm: 25, deviceName: 'LBL' })
  })
  it('no profile and the Windows default only makes a file (OneNote, PDF): the dialog is shown instead of "printing" nothing', async () => {
    const { app, fake } = setup()
    fake.printers = [{ name: 'OneNote (Desktop)', displayName: 'OneNote (Desktop)', isDefault: true }, { name: '4BARCODE 4B-2054N', displayName: '4BARCODE 4B-2054N', isDefault: false }]
    const r = await printing(app).print({ html: '<html><head></head><body>l</body></html>', paper: 'label', widthMm: 50, heightMm: 25 })
    expect(fake.jobs[0].opts).toMatchObject({ silent: false, deviceName: '' })
    expect(r.warning).toContain('No label printer is set up, so the Windows print dialog was shown')
    // other papers: the dialog only when the Windows default makes a file
    const a4 = await printing(app).print({ html: '<html><head></head><body>x</body></html>', paper: 'A4' })
    expect(fake.jobs[1].opts).toMatchObject({ silent: false, deviceName: '' })
    expect(a4.warning).toContain('No A4 printer is set up and the Windows default printer (OneNote (Desktop)) does not print on paper')
    fake.printers = [{ name: 'Brother', displayName: 'Brother', isDefault: true }]
    await printing(app).print({ html: '<html><head></head><body>x</body></html>', paper: 'A4' })
    expect(fake.jobs[2].opts).toMatchObject({ silent: true })
    // a label never goes silently to an office printer
    await printing(app).print({ html: '<html><head></head><body>l</body></html>', paper: 'label', widthMm: 50, heightMm: 25 })
    expect(fake.jobs[3].opts).toMatchObject({ silent: false })
    fake.jobs.splice(0, 3)
    // with a profile for the paper the job goes straight to that printer
    printing(app).savePrinterProfile({ name: 'Labels', deviceName: '4BARCODE 4B-2054N', kind: 'label', isDefault: true })
    const ok = await printing(app).print({ html: '<html><head></head><body>l</body></html>', paper: 'label', widthMm: 50, heightMm: 25 })
    expect(fake.jobs[1].opts).toMatchObject({ silent: true, deviceName: '4BARCODE 4B-2054N' })
    expect(ok.warning).toBeUndefined()
  })
  it('receipt jobs measure their own height (roll paper)', async () => {
    const { app, fake } = setup()
    await printing(app).print({ html: '<html></html>', paper: '80' })
    expect(fake.jobs[0].opts).toMatchObject({ widthMm: 80, heightMm: 0 })
  })
})

describe('test print', () => {
  it('prints logo + shop name + address + ruler on the chosen paper', async () => {
    const { app, fake } = setup()
    profile(app).setLogo({ data: makePng(300, 150) })
    for (const paper of ['58', '80', 'A4', 'label'] as const) {
      const res = await printing(app).testPrint({ paper })
      expect(res.ok).toBe(true)
    }
    expect(fake.jobs).toHaveLength(4)
    for (const j of fake.jobs) {
      expect(j.html).toContain('Test Shop')
      expect(j.html).toContain('class="ruler"')
    }
    // receipts and sheets: address and logo too; the label printer gets one test label
    for (const j of fake.jobs.slice(0, 3)) {
      expect(j.html).toContain('1 Main Road')
      expect(j.html).toContain('<img class="logo"')
    }
    expect(fake.jobs[3].html).toContain('Print darkness 5 of 9')
    expect(fake.jobs[0].opts.widthMm).toBe(58)
    expect(fake.jobs[2].opts.widthMm).toBe(210)
  })
  it('reports a printer failure instead of throwing', async () => {
    const { app, fake } = setup()
    fake.failWith = 'Out of paper'
    expect(await printing(app).testPrint({ paper: '58' })).toMatchObject({ ok: false, error: 'Out of paper' })
  })
})

describe('labels & reports through the service', () => {
  it('renders labels for real variants with copies', () => {
    const { app } = setup()
    const p = app.db.run("INSERT INTO products(uuid,name) VALUES (?,'Flower Pot')", app.uuid()).lastId
    const v = app.db.run("INSERT INTO product_variants(uuid,product_id,name,sku,barcode,mrp,price) VALUES (?,?,?,?,?,?,?)", app.uuid(), p, 'Big', 'FP-1', '8901234567890', 15000, 12000).lastId
    const r = printing(app).renderLabelHtml({ variantIds: [{ variantId: v, copies: 4 }], template: 'label_product' })
    expect((r.html.match(/class="label pl"/g) ?? []).length).toBe(4)
    for (const s of ['Flower Pot', 'Big', '₹120.00', '<svg class="barcode"', 'Test Shop']) expect(r.html).toContain(s)
    expect(r.widthMm).toBe(60)
    expect(() => printing(app).renderLabelHtml({ variantIds: [{ variantId: 99999 }] })).toThrow(/not found/)
  })
  it('report header follows ReportHeaderSettings from the profile', () => {
    const { app } = setup()
    profile(app).save({ headerSettings: { showLogo: true, showShopName: false, showAddress: false, showPhone: true, showGstin: false } })
    const html = printing(app).renderReportHtml({ title: 'Stock', subtitle: 'As of today', columns: [{ key: 'q', header: 'Qty' }], rows: [{ q: 5 }], template: 'report_inventory' }).html
    expect(html).not.toContain('Test Shop')
    expect(html).not.toContain('1 Main Road')
    expect(html).toContain('9876543210')
    expect(html).not.toContain('33ABCDE1234F1Z5')
    expect(html).toContain('Stock')
  })
})

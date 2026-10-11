import { describe, expect, it, beforeEach } from 'vitest'
import { existsSync, readdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestApp } from '../helpers'
import type { App } from '../../src/main/core/app'
import type { PrintingService } from '../../src/main/modules/printing/service'
import type { BusinessProfileService } from '../../src/main/modules/businessProfile/service'
import type { InvoiceDocExt } from '../../src/main/modules/printing/context'
import { asciiSafe, buildDrawerKick, buildEscPosReceipt, buildEscPosTest, columnsFor, EscPos, kv, rasterFromPixels, wrap } from '../../src/main/modules/printing/escpos'
import { RAW_PS_SCRIPT, WindowsRawPrinter, type ExecFileFn, type RawPrintAdapter } from '../../src/main/modules/printing/rawPrinter'
import { parseCalibration } from '../../src/main/modules/printing/adapter'
import { FakePrinter, insertSale, makePng } from './fixtures'

const hex = (b: Buffer) => b.toString('hex')

// ------------------------------------------------------------------ a fixed document (no database, no hard-coded shop in the code under test)
const profile = {
  id: 1, version: 1, shopName: 'Test Mart', displayName: 'Test Mart', legalName: '', shortName: '', address: '12 Main Road', city: 'Sivakasi', state: 'Tamil Nadu', pinCode: '626123',
  phone: '9876543210', email: '', website: '', gstin: '33ABCDE1234F1Z5', pan: '', footerText: 'Thank you', logoAssetId: null,
  logoSettings: { visible: true, position: 'top', alignment: 'center', widthMm: 0, heightMm: 0 }
} as unknown as InvoiceDocExt['profile']
const doc: InvoiceDocExt = {
  invoiceNumber: 'INV-1', createdAt: new Date(2026, 0, 5, 14, 30).getTime(), posName: 'Counter 1', cashierName: 'Asha', customerName: '', customerPhone: '',
  lines: [{ name: 'Rocket', sku: 'R1', hsn: '3604', qty: 2, unitPrice: 200000, discount: 0, taxRateBp: 0, taxAmount: 0, total: 400000 }],
  subtotal: 400000, discount: 0, tax: 0, roundOff: 0, total: 400000,
  payments: [{ method: 'cash', amount: 400000 }], received: 450000, change: 50000, pricesIncludeTax: true, profile
}

describe('ESC/POS byte generator', () => {
  it('primitives produce the exact command bytes', () => {
    expect(hex(new EscPos().init().build())).toBe('1b40')
    expect(hex(new EscPos().align('center').align('right').align('left').build())).toBe('1b6101' + '1b6102' + '1b6100')
    expect(hex(new EscPos().bold(true).bold(false).build())).toBe('1b4501' + '1b4500')
    expect(hex(new EscPos().size(2, 2).size(1, 1).size(3, 2).build())).toBe('1d2111' + '1d2100' + '1d2121')
    expect(hex(new EscPos().feed(3).build())).toBe('1b6403')
    expect(hex(new EscPos().cut('partial', 2).build())).toBe('1b6402' + '1d5601')
    expect(hex(new EscPos().cut('full', 2).build())).toBe('1b6402' + '1d5600')
    expect(hex(new EscPos().cut('none', 2).build())).toBe('1b6402')
    expect(hex(new EscPos().drawerKick().build())).toBe('1b70' + '00' + '19' + 'fa') // pin 2, 50 ms on, 500 ms off
    expect(hex(new EscPos().drawerKick(5, 100, 200).build())).toBe('1b70' + '01' + '32' + '64')
    expect(hex(buildDrawerKick())).toBe('1b40' + '1b700019fa')
    expect(hex(new EscPos().line('Hi').build())).toBe('48690a')
  })

  it('raster image header and bit packing (1 = black, MSB first)', () => {
    // 10 x 2 image: first pixel black, others white; second row all black
    const px = Buffer.alloc(10 * 2 * 4, 255)
    px[0] = 0; px[1] = 0; px[2] = 0 // pixel (0,0) black (bgra)
    for (let x = 0; x < 10; x++) { const i = (10 + x) * 4; px[i] = 0; px[i + 1] = 0; px[i + 2] = 0 }
    const r = rasterFromPixels(px, 10, 2)
    expect(r.widthBytes).toBe(2)
    expect(hex(r.data)).toBe('8000' + 'ffc0')
    expect(hex(new EscPos().raster(r).build())).toBe('1d763000' + '0200' + '0200' + '8000ffc0')
    // transparent pixels print white
    const t = Buffer.alloc(8 * 1 * 4, 0)
    expect(hex(rasterFromPixels(t, 8, 1).data)).toBe('00')
  })

  it('text helpers: ascii-safe, wrapping, columns, key/value alignment', () => {
    expect(asciiSafe('₹500 café “x” – ok')).toBe('Rs.500 cafe "x" - ok')
    expect(asciiSafe('தமிழ்')).toBe('?????')
    expect(wrap('aaa bbb ccc', 7)).toEqual(['aaa bbb', 'ccc'])
    expect(wrap('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij'])
    expect(columnsFor(48)).toBe(32)
    expect(columnsFor(72)).toBe(48)
    expect(columnsFor(76)).toBe(50)
    expect(kv('Total', '10.00', 20)).toBe('Total          10.00')
    expect(kv('A very long item name here', '1.00', 12)).toBe('A very  1.00')
  })

  const GOLDEN_58 =
    '1b40' + '1b700019fa' + '1b6101' + '1b4501' + '1d2111' + '54657374204d617274' + '0a' + '1d2100' + '1b4500' +
    '3132204d61696e20526f6164' + '0a' + '536976616b6173692c2054616d696c204e616475202d20363236313233' + '0a' + '50683a2039383736353433323130' + '0a' +
    '475354494e3a20333341424344453132333446315a35' + '0a' + '1b6100' + '2d'.repeat(32) + '0a' +
    '1b6101' + '1b4501' + '54415820494e564f494345' + '0a' + '1b4500' + '1b6100' +
    '42696c6c204e6f' + '20'.repeat(32 - 'Bill No'.length - 'INV-1'.length) + '494e562d31' + '0a' +
    '44617465' + '20'.repeat(32 - 'Date'.length - '05/01/2026 02:30 PM'.length) + '30352f30312f323032362030323a333020504d' + '0a' +
    '43617368696572' + '20'.repeat(32 - 'Cashier'.length - 'Asha'.length) + '41736861' + '0a' +
    '2d'.repeat(32) + '0a' + '526f636b6574' + '0a' +
    '20203220782032' + '2c3030302e3030' + '20'.repeat(32 - '  2 x 2,000.00'.length - '4,000.00'.length) + '342c3030302e3030' + '0a' +
    '2d'.repeat(32) + '0a' +
    '537562746f74616c' + '20'.repeat(32 - 'Subtotal'.length - '4,000.00'.length) + '342c3030302e3030' + '0a' +
    '1b4501' + '1d2101' + '544f54414c' + '20'.repeat(32 - 'TOTAL'.length - 'Rs.4,000.00'.length) + '52732e342c3030302e3030' + '0a' + '1d2100' + '1b4500' +
    '2d'.repeat(32) + '0a' +
    '43617368' + '20'.repeat(32 - 'Cash'.length - '4,000.00'.length) + '342c3030302e3030' + '0a' +
    '5265636569766564' + '20'.repeat(32 - 'Received'.length - '4,500.00'.length) + '342c3530302e3030' + '0a' +
    '1b4501' + '4368616e6765' + '20'.repeat(32 - 'Change'.length - '500.00'.length) + '3530302e3030' + '0a' + '1b4500' +
    '2d'.repeat(32) + '0a' + '1b6101' + '5468616e6b20796f75' + '0a' + '1b6100' + '1b6404' + '1d5600'

  it('golden bytes: 58 mm cash receipt, full cut, drawer kick (shop block comes from the document)', () => {
    const out = buildEscPosReceipt(doc, { paper: 58, cut: 'full', drawerKick: true })
    expect(hex(out)).toBe(GOLDEN_58)
  })

  it('80 mm: 48 columns by default, 76 mm printable gives 50 columns; paper width is configurable', () => {
    const lines = (b: Buffer) => b.toString('latin1').split('\n')
    const a = lines(buildEscPosReceipt(doc, { paper: 80 }))
    expect(a.some((l) => l.endsWith('-'.repeat(48)) && !l.endsWith('-'.repeat(49)))).toBe(true)
    const b = lines(buildEscPosReceipt(doc, { paper: 80, printableMm: 76 }))
    expect(b.some((l) => l.endsWith('-'.repeat(50)))).toBe(true)
    const c = lines(buildEscPosReceipt(doc, { paper: 58 }))
    expect(c.some((l) => l.endsWith('-'.repeat(32)) && !l.endsWith('-'.repeat(33)))).toBe(true)
    expect(a.find((l) => l.includes('Change'))!.replace(/[^ -~]/g, '').trim().endsWith('500.00')).toBe(true)
    expect(a.find((l) => l.includes('Received'))!.endsWith('4,500.00')).toBe(true)
  })

  it('no hard-coded shop name: the shop block follows the document profile; Tamil/non-ASCII degrade to ?', () => {
    const other = { ...doc, profile: { ...profile, shopName: 'Zed & Co', displayName: 'Zed & Co' } } as InvoiceDocExt
    const txt = buildEscPosReceipt(other, { paper: 80 }).toString('latin1')
    expect(txt).toContain('Zed & Co')
    expect(txt).not.toContain('Test Mart')
  })

  it('no Change line without change, return documents say CREDIT NOTE, optional sections respect the template switches', () => {
    const exact = { ...doc, received: 400000, change: 0 } as InvoiceDocExt
    expect(buildEscPosReceipt(exact, { paper: 80 }).toString('latin1')).not.toContain('Change')
    const ret = { ...doc, isReturn: true, originalInvoiceNumber: 'INV-0' } as InvoiceDocExt
    expect(buildEscPosReceipt(ret, { paper: 80 }).toString('latin1')).toContain('CREDIT NOTE')
    const bare = buildEscPosReceipt(doc, { paper: 80, cfg: { showAddress: false, showPhone: false, showGstin: false, showFooter: false, showCashier: false } }).toString('latin1')
    for (const s of ['12 Main Road', 'Ph:', 'GSTIN', 'Thank you', 'Cashier']) expect(bare).not.toContain(s)
  })

  it('test page has a ruler and the shop block; drawer pulse is just reset + ESC p', () => {
    const t = buildEscPosTest(profile, { paper: 58, printableMm: 48 }).toString('latin1')
    expect(t).toContain('RAW ESC/POS TEST')
    expect(t).toContain('12345678911234567892123456789312')
    expect(t).toContain('32 columns')
  })
})

describe('Windows raw sender (spooler route) failure paths', () => {
  const tmp = () => mkdtempSync(join(tmpdir(), 'raw-'))
  const run = (exec: ExecFileFn, platform: NodeJS.Platform = 'win32') => new WindowsRawPrinter({ tmpDir: tmp(), platform, exec, timeoutMs: 50 }).sendRaw('POS-80', Buffer.from('hi'))

  it('is not available off Windows, and refuses empty jobs', async () => {
    expect(await run(() => undefined, 'linux')).toEqual({ ok: false, error: expect.stringContaining('only available on Windows') })
    expect(await new WindowsRawPrinter({ tmpDir: tmp(), platform: 'win32' }).sendRaw('x', Buffer.alloc(0))).toMatchObject({ ok: false })
  })
  it('passes the printer name and files as separate arguments (no shell) and cleans up temp files', async () => {
    const dir = tmp()
    let seen: { file: string; args: string[] } | null = null
    const exec: ExecFileFn = (file, args, _o, cb) => { seen = { file, args }; expect(existsSync(args[args.indexOf('-File') + 1])).toBe(true); cb(null, '', '') }
    const r = await new WindowsRawPrinter({ tmpDir: dir, platform: 'win32', exec }).sendRaw('My Printer; calc', Buffer.from([1, 2, 3]))
    expect(r).toEqual({ ok: true })
    expect(seen!.file).toBe('powershell.exe')
    expect(seen!.args).toContain('My Printer; calc') // one argv entry, never interpreted
    expect(seen!.args).toEqual(expect.arrayContaining(['-NoProfile', '-NonInteractive', '-Printer']))
    expect(readdirSync(dir)).toEqual([])
  })
  it('default printer: no -Printer argument', async () => {
    let args: string[] = []
    await new WindowsRawPrinter({ tmpDir: tmp(), platform: 'win32', exec: (_f, a, _o, cb) => { args = a; cb(null, '', '') } }).sendRaw('', Buffer.from('x'))
    expect(args).not.toContain('-Printer')
  })
  it('maps failures to {ok:false,error}: driver refuses RAW, powershell missing, timeout, spawn throws', async () => {
    const mk = (err: Partial<Error> & { code?: unknown; killed?: boolean }, stderr = ''): ExecFileFn => (_f, _a, _o, cb) => cb(Object.assign(new Error('boom'), err), '', stderr)
    expect(await run(mk({ code: 2 }, 'The printer driver does not accept RAW jobs (error 1804)\r\n'))).toEqual({ ok: false, error: 'Raw printing failed: The printer driver does not accept RAW jobs (error 1804)' })
    expect(await run(mk({ code: 'ENOENT' }))).toMatchObject({ ok: false, error: expect.stringContaining('PowerShell was not found') })
    expect(await run(mk({ killed: true }))).toMatchObject({ ok: false, error: expect.stringContaining('timed out') })
    expect(await run(() => { throw new Error('spawn EPERM') })).toMatchObject({ ok: false, error: expect.stringContaining('spawn EPERM') })
    expect(await run(mk({}, ''))).toMatchObject({ ok: false, error: 'Raw printing failed: boom' })
  })
  it('the PowerShell script uses the spooler API with the RAW data type', () => {
    expect(RAW_PS_SCRIPT).toContain('winspool.drv')
    expect(RAW_PS_SCRIPT).toContain('pDataType = "RAW"')
    expect(RAW_PS_SCRIPT).toContain('WritePrinter')
  })
})

describe('calibration defaults (raw ESC/POS and cash drawer are opt-in, default OFF)', () => {
  it('parseCalibration', () => {
    expect(parseCalibration({})).toMatchObject({ raw: false, drawerKick: false, drawerPin: 2, cut: 'partial', printableMm: 0, silent: true })
    expect(parseCalibration({ raw: true, drawerKick: true, drawerPin: 5, cut: 'full', printableMm: 76 })).toMatchObject({ raw: true, drawerKick: true, drawerPin: 5, cut: 'full', printableMm: 76 })
    expect(parseCalibration({ raw: 'yes', printableMm: 5, cut: 'weird' })).toMatchObject({ raw: false, printableMm: 40, cut: 'partial' })
  })
})

// ------------------------------------------------------------------ through the printing service (DB-backed)
class FakeRaw implements RawPrintAdapter {
  jobs: { device: string; bytes: Buffer }[] = []
  fail: string | null = null
  throws: string | null = null
  async sendRaw(device: string, bytes: Buffer) {
    if (this.throws) throw new Error(this.throws)
    if (this.fail) return { ok: false, error: this.fail }
    this.jobs.push({ device, bytes })
    return { ok: true }
  }
}

describe('PrintingService: raw mode, drawer, failures never touch the sale', () => {
  let app: App
  let svc: PrintingService
  let raw: FakeRaw
  let fake: FakePrinter
  let saleId: number
  const salesCount = () => app.db.value<number>('SELECT COUNT(*) FROM sales')!
  beforeEach(() => {
    app = createTestApp()
    svc = app.get<PrintingService>('printing')
    raw = new FakeRaw()
    fake = new FakePrinter()
    svc.setAdapter(fake)
    svc.setRawAdapter(raw)
    app.get<BusinessProfileService>('businessProfile').save({ shopName: 'Bright Store', displayName: 'Bright Store' })
    saleId = insertSale(app, { invoiceNo: 'INV-RAW-1', profileVersionId: app.get<BusinessProfileService>('businessProfile').getActive().id })
  })

  it('default (raw off): the Windows driver path is used and nothing is sent raw, no drawer kick', async () => {
    svc.savePrinterProfile({ name: 'T80', deviceName: 'POS-80', kind: 'receipt80', isDefault: true })
    const r = await svc.printInvoice({ saleId, template: 'receipt80' })
    expect(r).toMatchObject({ ok: true, mode: 'driver' })
    expect(fake.jobs).toHaveLength(1)
    expect(raw.jobs).toHaveLength(0)
  })

  it('raw on: ESC/POS bytes go to the named printer; shop name comes from the sale, change is printed', async () => {
    svc.savePrinterProfile({ name: 'T80', deviceName: 'POS-80', kind: 'receipt80', isDefault: true, calibration: { raw: true } })
    const r = await svc.printInvoice({ saleId, template: 'receipt80' })
    expect(r).toMatchObject({ ok: true, mode: 'raw' })
    expect(fake.jobs).toHaveLength(0)
    expect(raw.jobs).toHaveLength(1)
    expect(raw.jobs[0].device).toBe('POS-80')
    const txt = raw.jobs[0].bytes.toString('latin1')
    expect(txt).toContain('Bright Store')
    expect(txt).toContain('Change')
    expect(hex(raw.jobs[0].bytes.subarray(0, 2))).toBe('1b40')
    expect(hex(raw.jobs[0].bytes)).not.toContain('1b700019fa') // drawer kick is opt-in
    expect(svc.listPrintLog()[0]).toMatchObject({ ok: true, action: 'print-raw' })
    // A4 never goes raw
    svc.savePrinterProfile({ name: 'A4', deviceName: 'Office A4', kind: 'a4', isDefault: true, calibration: { raw: true } })
    expect(await svc.printInvoice({ saleId, template: 'invoiceA4' })).toMatchObject({ ok: true, mode: 'driver' })
  })

  it('raw failure returns {ok:false} and a log row; the sale is untouched; a thrown adapter error is caught too', async () => {
    svc.savePrinterProfile({ name: 'T80', deviceName: 'POS-80', kind: 'receipt80', isDefault: true, calibration: { raw: true } })
    const before = salesCount()
    raw.fail = 'The printer driver does not accept RAW jobs (error 1804)'
    const r = await svc.printInvoice({ saleId, template: 'receipt80' })
    expect(r).toMatchObject({ ok: false, mode: 'raw', error: expect.stringContaining('RAW') })
    expect(svc.listPrintLog({ onlyFailed: true })[0]).toMatchObject({ ok: false, action: 'print-raw' })
    raw.throws = 'spooler exploded'
    expect(await svc.printInvoice({ saleId, template: 'receipt80' })).toMatchObject({ ok: false, error: 'spooler exploded' })
    expect(await svc.printInvoice({ saleId: 99999, template: 'receipt80' })).toMatchObject({ ok: false })
    expect(salesCount()).toBe(before)
  })

  it('cash drawer: opt-in; kicks after a cash sale (raw bytes at the start, or a separate pulse in driver mode); failures are ignored', async () => {
    svc.savePrinterProfile({ name: 'T80', deviceName: 'POS-80', kind: 'receipt80', isDefault: true, calibration: { drawerKick: true } })
    expect(await svc.printInvoice({ saleId, template: 'receipt80' })).toMatchObject({ ok: true, mode: 'driver' })
    expect(raw.jobs).toHaveLength(1)
    expect(hex(raw.jobs[0].bytes)).toBe('1b40' + '1b700019fa')
    // drawer failure does not fail the print
    raw.fail = 'no raw'
    expect(await svc.printInvoice({ saleId, template: 'receipt80' })).toMatchObject({ ok: true, mode: 'driver' })
    raw.fail = null
    // raw + kick: pulse is in the same job
    svc.savePrinterProfile({ name: 'T80', deviceName: 'POS-80', kind: 'receipt80', isDefault: true, calibration: { drawerKick: true, raw: true }, id: svc.listPrinterProfiles()[0].id })
    raw.jobs.length = 0
    await svc.printInvoice({ saleId, template: 'receipt80' })
    expect(raw.jobs).toHaveLength(1)
    expect(hex(raw.jobs[0].bytes).startsWith('1b40' + '1b700019fa')).toBe(true)
    // the explicit "Open cash drawer" button
    raw.jobs.length = 0
    expect(await svc.openDrawer()).toMatchObject({ ok: true })
    expect(hex(raw.jobs[0].bytes)).toBe('1b40' + '1b700019fa')
    raw.fail = 'offline'
    expect(await svc.openDrawer()).toMatchObject({ ok: false, error: 'offline' })
    // no receipt printer configured at all
    app.db.run('DELETE FROM printer_profiles')
    expect(await svc.openDrawer()).toMatchObject({ ok: false })
  })

  it('a sale without cash does not kick the drawer', async () => {
    const p = app.db.run('INSERT INTO products(uuid,name,tax_rate_bp,hsn,track_stock) VALUES (?,?,0,?,0)', app.uuid(), 'Svc', '1')
    const v = app.db.run('INSERT INTO product_variants(uuid,product_id,sku,price,mrp) VALUES (?,?,?,?,?)', app.uuid(), p.lastId, 'SVC', 10000, 10000)
    const upi = await app.call('pos', 'completeSale', { lines: [{ variantId: v.lastId, qty: 1 }], payments: [{ method: 'upi', amount: 10000 }] })
    saleId = (upi as { saleId: number }).saleId
    svc.savePrinterProfile({ name: 'T80', deviceName: 'POS-80', kind: 'receipt80', isDefault: true, calibration: { drawerKick: true } })
    await svc.printInvoice({ saleId, template: 'receipt80' })
    expect(raw.jobs).toHaveLength(0)
  })

  it('raw test print uses the same builder; dry run never sends; logo decoder absence just skips the logo', async () => {
    svc.savePrinterProfile({ name: 'T58', deviceName: 'POS-58', kind: 'receipt58', isDefault: true, calibration: { raw: true, printableMm: 46 } })
    const d = await svc.testPrint({ paper: '58', dryRun: true })
    expect(d.ok).toBe(true)
    expect(raw.jobs).toHaveLength(0)
    svc.setLogoDecoder(() => null)
    const r = await svc.testPrint({ paper: '58' })
    expect(r.ok).toBe(true)
    expect(raw.jobs[0].bytes.toString('latin1')).toContain('RAW ESC/POS TEST')
    expect(raw.jobs[0].bytes.toString('latin1')).toContain('30 columns') // 46 mm printable
    fake.printers.push({ name: 'POS-58', displayName: 'POS-58', isDefault: false }) // installed in Windows: the failure is the printer's own
    raw.fail = 'nope'
    expect(await svc.testPrint({ paper: '58' })).toMatchObject({ ok: false, error: 'nope' })
  })

  it('a logo decoded by the (injected) decoder is sent as a GS v 0 raster', async () => {
    svc.savePrinterProfile({ name: 'T80', deviceName: 'POS-80', kind: 'receipt80', isDefault: true, calibration: { raw: true } })
    const bp = app.get<BusinessProfileService>('businessProfile')
    let asked = 0
    svc.setLogoDecoder((_b, maxW) => { asked = maxW; return { width: 16, height: 2, order: 'rgba', pixels: Buffer.from(Array.from({ length: 16 * 2 }, () => [0, 0, 0, 255]).flat()) } })
    // no logo stored: the decoder is never asked and the receipt still prints
    await svc.printInvoice({ saleId, template: 'receipt80' })
    expect(asked).toBe(0)
    expect(raw.jobs).toHaveLength(1)
    bp.setLogo({ data: makePng(300, 150) })
    const sale2 = insertSale(app, { invoiceNo: 'INV-RAW-2', profileVersionId: bp.getActive().id })
    await svc.printInvoice({ saleId: sale2, template: 'receipt80' })
    expect(asked).toBe(240) // 72 mm = 576 dots, 60 % = 345, capped at 240
    expect(hex(raw.jobs[1].bytes)).toContain('1d763000' + '0200' + '0200' + 'ffff'.repeat(2))
    // a logo hidden by the template/profile is skipped
    asked = 0
    svc.saveTemplate('receipt80', { logoEnabled: false })
    await svc.printInvoice({ saleId: sale2, template: 'receipt80' })
    expect(asked).toBe(0)
  })
})

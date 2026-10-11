/** Profile/logo/print steps not covered by business-flow: field edits, logo settings, replace/remove, header toggles, test print. */
import { describe, it, expect, beforeAll } from 'vitest'
import { call, crackersCatalog, catalogCsv, freshShop, makePng, type FakePrinter } from './util'
import type { App } from '../../src/main/core/app'

let app: App
let printer: FakePrinter
let saleId: number
const get = <T = any>(s: string, m: string, a?: unknown) => call<T>(app, s, m, a)
const html = async (template: string, id = saleId) => (await get('printing', 'renderInvoiceHtml', { saleId: id, template })).html as string
const T4 = ['receipt58', 'receipt80', 'invoiceA4', 'invoiceA5'] as const

beforeAll(async () => {
  const f = await freshShop({ shopName: 'Step Shop' })
  app = f.app; printer = f.printer
  const prods = crackersCatalog()
  await get('catalog', 'importCommit', { bytesBase64: Buffer.from(catalogCsv(prods)).toString('base64'), filename: 'c.csv', mode: 'all_or_nothing' })
  const s = await get('pos', 'completeSale', { lines: [{ variantId: app.lookup.byCode(prods[0].barcode)!.variantId, qty: 1 }], payments: [{ method: 'cash', amount: 20000 }] })
  saleId = s.saleId
})

describe('profile field edits each create an audited version and show on every template', () => {
  for (const [field, value, needle] of [
    ['shopName', 'Renamed Shop Ltd', 'Renamed Shop Ltd'], ['address', '77 New Address Lane', '77 New Address Lane'], ['phone', '8123456789', '8123456789'],
    ['gstin', '29ABCDE1234F1Z5', '29ABCDE1234F1Z5'], ['footerText', 'Come again soon!', 'Come again soon!']
  ] as const) {
    it(`edit ${field}`, async () => {
      const before = (await get('businessProfile', 'getActive')).version
      const p = await get('businessProfile', 'save', { [field]: value })
      expect(p.version).toBe(before + 1)
      expect(p[field]).toBe(value)
      const last = app.db.get<any>("SELECT old_json, new_json FROM audit_log WHERE entity='business_profile' ORDER BY id DESC LIMIT 1")
      expect(last.new_json).toContain(value)
      // a NEW sale pins the new version and prints it on all four sizes
      const sale = await get('pos', 'completeSale', { lines: [{ variantId: 1, qty: 1 }], payments: [{ method: 'cash', amount: 20000 }] })
      for (const t of T4) expect(await html(t, sale.saleId), `${field}/${t}`).toContain(needle)
    })
  }
  it('saving identical data creates no new version (no audit spam)', async () => {
    const cur = await get('businessProfile', 'getActive')
    const again = await get('businessProfile', 'save', { shopName: cur.shopName })
    expect(again.version).toBe(cur.version)
  })
  it('invalid input is rejected without side effects', async () => {
    const v = (await get('businessProfile', 'getActive')).version
    for (const bad of [{ gstin: '12345' }, { phone: 'abc' }, { pinCode: '12' }, { email: 'nope' }, { shopName: 'x'.repeat(121) }])
      await expect(get('businessProfile', 'save', bad), JSON.stringify(bad)).rejects.toMatchObject({ code: 'VALIDATION' })
    expect((await get('businessProfile', 'getActive')).version).toBe(v)
  })
})

describe('logo upload, settings, replace, remove', () => {
  it('upload -> appears on all 4 documents + labels none; sizes/alignment settings change the markup', async () => {
    await get('businessProfile', 'setLogo', { data: makePng(200, 100).toString('base64') })
    for (const t of T4) expect(await html(t, (await newSale()).saleId), t).toMatch(/<img[^>]+class="logo"[^>]+src="data:image\/png/)
    await get('businessProfile', 'save', { logoSettings: { visible: true, widthMm: 20, heightMm: 0, alignment: 'left', position: 'top' } })
    const h = await html('receipt80', (await newSale()).saleId)
    expect(h).toMatch(/width:\s*20mm/)
  })
  it('logoSettings.visible=false and headerSettings.showLogo=false hide the logo', async () => {
    await get('businessProfile', 'save', { logoSettings: { visible: false, widthMm: 0, heightMm: 0, alignment: 'center', position: 'top' } })
    expect(await html('receipt80', (await newSale()).saleId)).not.toMatch(/<img[^>]+class="logo"/)
    await get('businessProfile', 'save', { logoSettings: { visible: true, widthMm: 0, heightMm: 0, alignment: 'center', position: 'top' }, headerSettings: { showLogo: true, showShopName: true, showAddress: false, showPhone: false, showGstin: false } })
    const h = await html('receipt80', (await newSale()).saleId)
    expect(h).toMatch(/class="logo"/)
    expect(h).not.toContain('33ABCDE1234F1Z5')
    await get('businessProfile', 'save', { headerSettings: { showLogo: true, showShopName: true, showAddress: true, showPhone: true, showGstin: true } })
  })
  it('replace logo -> new sha, previous sales keep the old logo bytes under policy "original"', async () => {
    const oldSale = await newSale()
    const oldHtml = await html('receipt80', oldSale.saleId)
    const oldB64 = /src="(data:image\/[a-z]+;base64,[^"]+)"/.exec(oldHtml)![1]
    await get('businessProfile', 'setLogo', { data: makePng(120, 120, { alpha: true }).toString('base64') })
    const newHtml = await html('receipt80', (await newSale()).saleId)
    const newB64 = /src="(data:image\/[a-z]+;base64,[^"]+)"/.exec(newHtml)![1]
    expect(newB64).not.toBe(oldB64)
    expect(/src="(data:image\/[a-z]+;base64,[^"]+)"/.exec(await html('receipt80', oldSale.saleId))![1]).toBe(oldB64)
  })
  it('remove logo -> no <img> on new documents; old document still has its logo; audited', async () => {
    const withLogo = await newSale()
    await get('businessProfile', 'removeLogo')
    expect(await html('invoiceA4', (await newSale()).saleId)).not.toMatch(/<img/)
    expect(await html('invoiceA4', withLogo.saleId)).toMatch(/<img/)
    expect(app.db.value<number>("SELECT COUNT(*) FROM audit_log WHERE action='profile.logo_remove'")).toBe(1)
  })
  it('rejects non-images, empty files and oversize files', async () => {
    await expect(get('businessProfile', 'setLogo', { data: '' })).rejects.toBeTruthy()
    await expect(get('businessProfile', 'setLogo', { data: Buffer.from('GIF89a-not-really').toString('base64') })).rejects.toBeTruthy()
    await expect(get('businessProfile', 'setLogo', { data: Buffer.alloc(8 * 1024 * 1024, 1).toString('base64') })).rejects.toBeTruthy()
  })
})

describe('test print and templates', () => {
  it('testPrint for 58/80/A4/label goes through the printer adapter; failure is reported, not thrown', async () => {
    for (const paper of ['58', '80', 'A4', 'label'] as const) {
      const r = await get('printing', 'testPrint', { paper })
      expect(r.ok, paper).toBe(true)
    }
    expect(printer.jobs.length).toBeGreaterThanOrEqual(4)
    expect(printer.jobs.some((j) => j.html.includes('Renamed Shop Ltd'))).toBe(true)
    printer.failWith = 'No paper'
    const bad = await get('printing', 'testPrint', { paper: '80' })
    expect(bad.ok).toBe(false)
    printer.failWith = null
  })
  it('sample preview (no sale) renders every template with the live profile', async () => {
    for (const t of T4) {
      const r = await get('printing', 'renderInvoiceHtml', { template: t, sample: true })
      expect(r.html, t).toContain('Renamed Shop Ltd')
    }
  })
})

async function newSale() {
  return get('pos', 'completeSale', { lines: [{ variantId: 2, qty: 1 }], payments: [{ method: 'cash', amount: 20000 }] })
}

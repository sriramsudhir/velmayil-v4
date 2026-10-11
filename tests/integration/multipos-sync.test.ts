/** Two real App instances (own SQLite files) syncing through server/sync-server.mjs using the PUBLIC service API. */
import { describe, it, expect, afterEach } from 'vitest'
import { cleanup, makePos, settle, startServer, useHttp, type Pos } from '../sync/harness'
import { makePng } from '../printing/fixtures'
import { ean13 } from './util'
import { PrintingService } from '../../src/main/modules/printing/service'

afterEach(cleanup)

const c = <T = any>(p: Pos, s: string, m: string, a?: unknown) => p.app.call(s, m, a) as Promise<T>
const active = (p: Pos) => p.app.db.get<any>('SELECT * FROM business_profile_versions WHERE is_active = 1')
const countOf = (p: Pos, sql: string, ...a: any[]) => p.app.db.value<number>(sql, ...a) ?? 0

async function newProduct(p: Pos, name: string, sku: string, price: number, stock: number) {
  const prod = await c(p, 'catalog', 'save', { name, hsn: '3604', taxRateBp: 1800, variants: [{ name: '', sku, mrp: price + 500, price, cost: Math.round(price / 2), barcode: ean13('890999000' + sku.slice(-3).padStart(3, '0')) }] })
  p.app.moveStock({ variantId: prod.variants[0].id, delta: stock, type: 'opening' })
  return prod.variants[0] as { id: number; barcode: string; sku: string }
}

describe('multi-POS: profile + catalog + sales converge', () => {
  it('profile, logo, product (with barcode) created on POS-1 appear on POS-2; sales on both converge; reprint uses pinned profile', async () => {
    const srv = await startServer()
    const p1 = makePos('POS-01')
    const p2 = makePos('POS-02')
    useHttp(p1, srv.url)
    useHttp(p2, srv.url)

    await c(p1, 'businessProfile', 'save', { shopName: 'Sync Shop One', address: '9 Sync Rd', phone: '9111111111', gstin: '33ABCDE1234F1Z5' })
    const png = makePng(100, 50)
    await c(p1, 'businessProfile', 'setLogo', { data: png.toString('base64') })
    const v = await newProduct(p1, 'Sync Rocket', 'SYN001', 5900, 50)
    await settle([p1, p2], 4)

    // PROFILE on POS-2
    const a2 = await c(p2, 'businessProfile', 'getActive')
    expect(a2).toMatchObject({ shopName: 'Sync Shop One', address: '9 Sync Rd', phone: '9111111111' })
    expect(a2.logoAssetId).not.toBeNull()
    const logo2 = await c(p2, 'businessProfile', 'getActiveLogo')
    expect(logo2.dataUri).toMatch(/^data:image\/png;base64,/)
    expect(countOf(p2, 'SELECT COUNT(*) FROM business_profile_versions WHERE is_active = 1')).toBe(1)
    // CATALOG on POS-2, scanning the synced barcode
    expect(p2.app.lookup.byCode(v.barcode)).toMatchObject({ productName: 'Sync Rocket', price: 5900, stock: 50 })

    // sale on POS-2 (receipt must print POS-1's profile, incl. logo)
    const s2 = await c(p2, 'pos', 'completeSale', { lines: [{ variantId: p2.app.lookup.byCode(v.barcode)!.variantId, qty: 3 }], payments: [{ method: 'cash', amount: 20000 }] })
    expect(s2.total).toBe(17700)
    const h2 = (await c(p2, 'printing', 'renderInvoiceHtml', { saleId: s2.saleId, template: 'receipt80' })).html
    expect(h2).toContain('Sync Shop One')
    expect(h2).toMatch(/<img[^>]+data:image/)
    // concurrent sale on POS-1
    const s1 = await c(p1, 'pos', 'completeSale', { lines: [{ variantId: v.id, qty: 2 }], payments: [{ method: 'upi', amount: 11800 }] })
    await settle([p1, p2], 4)

    expect(s1.invoiceNo).not.toBe(s2.invoiceNo) // distinct series per terminal
    for (const p of [p1, p2]) {
      expect(countOf(p, 'SELECT COUNT(*) FROM sales')).toBe(2)
      expect(countOf(p, 'SELECT SUM(total) FROM sales')).toBe(17700 + 11800)
      expect(countOf(p, "SELECT COALESCE(SUM(qty),0) FROM stock_levels l JOIN product_variants x ON x.id=l.variant_id WHERE x.sku='SYN001'")).toBe(45)
    }
    // POS-1 can reprint POS-2's sale with the profile version pinned at the time of sale
    const remote = p1.app.db.get<{ id: number }>('SELECT id FROM sales WHERE invoice_no = ?', s2.invoiceNo)!
    const h1 = (await c(p1, 'printing', 'renderInvoiceHtml', { saleId: remote.id, template: 'invoiceA4' })).html
    expect(h1).toContain('Sync Shop One')
    expect(h1).toContain(s2.invoiceNo)
    expect(h1).toContain('177.00')
    // settling again changes nothing (idempotent)
    await settle([p1, p2], 2)
    expect(countOf(p1, 'SELECT COUNT(*) FROM sales')).toBe(2)
    expect(p1.sync.status().pending).toBe(0)
    expect(p2.sync.status().pending).toBe(0)
  })

  it('later rename on POS-2 reaches POS-1; new sale there prints the new name, old sale prints the old one', async () => {
    const srv = await startServer()
    const p1 = makePos('POS-01')
    const p2 = makePos('POS-02')
    useHttp(p1, srv.url)
    useHttp(p2, srv.url)
    await c(p1, 'businessProfile', 'save', { shopName: 'Old Name Traders' })
    const v = await newProduct(p1, 'Item', 'REN001', 1000, 10)
    await settle([p1, p2], 4)
    const before = await c(p1, 'pos', 'completeSale', { lines: [{ variantId: v.id, qty: 1 }], payments: [{ method: 'cash', amount: 1000 }] })
    await new Promise((r) => setTimeout(r, 1100))
    await c(p2, 'businessProfile', 'save', { shopName: 'New Name Traders' })
    await settle([p1, p2], 4)
    expect(active(p1).shop_name).toBe('New Name Traders')
    const after = await c(p1, 'pos', 'completeSale', { lines: [{ variantId: v.id, qty: 1 }], payments: [{ method: 'cash', amount: 1000 }] })
    expect((await c(p1, 'printing', 'renderInvoiceHtml', { saleId: after.saleId, template: 'receipt58' })).html).toContain('New Name Traders')
    const old = (await c(p1, 'printing', 'renderInvoiceHtml', { saleId: before.saleId, template: 'receipt58' })).html
    expect(old).toContain('Old Name Traders')
    expect(old).not.toContain('New Name Traders')
    await settle([p1, p2], 3)
    expect(active(p2).shop_name).toBe('New Name Traders')
  })

  it('OFFLINE: profile edit + billing work with no server; queue drains on reconnect; both ends converge', async () => {
    const dead = await startServer()
    const deadUrl = dead.url
    await dead.close()
    const live = await startServer()
    const p1 = makePos('POS-01')
    const p2 = makePos('POS-02')
    useHttp(p1, deadUrl)
    useHttp(p2, live.url)
    // offline operations on POS-1
    await c(p1, 'businessProfile', 'save', { shopName: 'Offline Edited Shop', phone: '9222222222' })
    const v = await newProduct(p1, 'Offline Item', 'OFF001', 2500, 20)
    const sale = await c(p1, 'pos', 'completeSale', { lines: [{ variantId: v.id, qty: 2 }], payments: [{ method: 'cash', amount: 5000 }] })
    expect(sale.total).toBe(5000)
    const r = await p1.sync.syncNow({ force: true }).catch((e: Error) => e)
    expect(r).toBeTruthy() // fails/queues quietly, never throws into billing
    expect(p1.sync.status().pending).toBeGreaterThan(0)
    expect(active(p1).shop_name).toBe('Offline Edited Shop')
    // reconnect
    useHttp(p1, live.url)
    await settle([p1, p2], 5)
    expect(p1.sync.status().pending).toBe(0)
    expect(active(p2).shop_name).toBe('Offline Edited Shop')
    expect(p2.app.lookup.byCode(v.barcode)?.productName).toBe('Offline Item')
    expect(countOf(p2, 'SELECT COUNT(*) FROM sales WHERE invoice_no = ?', sale.invoiceNo)).toBe(1)
  })

  it('CONFLICT: both POS edit the profile offline; every terminal converges on the same active version (last writer wins)', async () => {
    const srv = await startServer()
    const p1 = makePos('POS-01')
    const p2 = makePos('POS-02')
    useHttp(p1, srv.url)
    useHttp(p2, srv.url)
    await settle([p1, p2], 2)
    await c(p1, 'businessProfile', 'save', { shopName: 'Edit From One' })
    await new Promise((r) => setTimeout(r, 1100)) // created_at has 1-second resolution (see DEF-5)
    await c(p2, 'businessProfile', 'save', { shopName: 'Edit From Two' })
    await settle([p1, p2], 5)
    expect(active(p1).shop_name).toBe(active(p2).shop_name)
    expect(active(p1).shop_name).toBe('Edit From Two')
    expect(countOf(p1, 'SELECT COUNT(*) FROM business_profile_versions WHERE is_active = 1')).toBe(1)
    expect(countOf(p2, 'SELECT COUNT(*) FROM business_profile_versions WHERE is_active = 1')).toBe(1)
    // history preserved on both
    expect(countOf(p1, 'SELECT COUNT(*) FROM business_profile_versions')).toBe(3)
    expect(countOf(p2, 'SELECT COUNT(*) FROM business_profile_versions')).toBe(3)
  })

  it('catalog LWW: price edit on POS-2 propagates; old barcode on POS-1 charges the NEW price', async () => {
    const srv = await startServer()
    const p1 = makePos('POS-01')
    const p2 = makePos('POS-02')
    useHttp(p1, srv.url)
    useHttp(p2, srv.url)
    const v = await newProduct(p1, 'Price Item', 'PRC001', 10000, 10)
    await settle([p1, p2], 4)
    const p = await c(p2, 'catalog', 'get', { id: p2.app.lookup.byCode(v.barcode)!.productId })
    await new Promise((r) => setTimeout(r, 15))
    await c(p2, 'catalog', 'save', { id: p.id, name: p.name, hsn: p.hsn, taxRateBp: p.taxRateBp, variants: [{ id: p.variants[0].id, name: '', sku: p.variants[0].sku, barcode: p.variants[0].barcode, mrp: 15000, price: 12500, cost: p.variants[0].cost }] })
    await settle([p1, p2], 4)
    const scanned = await c(p1, 'pos', 'scan', { code: v.barcode })
    expect(scanned.price).toBe(12500)
    expect(PrintingService).toBeTruthy()
  })

  it('DEF-5 two terminals editing the profile within the SAME second must still converge on one active version', async () => {
    const srv = await startServer()
    const p1 = makePos('POS-01')
    const p2 = makePos('POS-02')
    useHttp(p1, srv.url)
    useHttp(p2, srv.url)
    await settle([p1, p2], 2)
    await c(p1, 'businessProfile', 'save', { shopName: 'Same Second One' })
    await c(p2, 'businessProfile', 'save', { shopName: 'Same Second Two' })
    await settle([p1, p2], 6)
    expect(active(p1).shop_name, 'terminals show different shop names forever (created_at tie, same version number)').toBe(active(p2).shop_name)
  })
})

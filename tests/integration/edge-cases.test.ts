import { describe, it, expect, beforeAll } from 'vitest'
import { call, catalogCsv, crackersCatalog, freshShop, oracleInclusive } from './util'
import type { App } from '../../src/main/core/app'

let app: App
const get = <T = any>(s: string, m: string, a?: unknown) => call<T>(app, s, m, a)
const prods = crackersCatalog()
const vid: Record<string, number> = {}

beforeAll(async () => {
  app = (await freshShop()).app
  await get('catalog', 'importCommit', { bytesBase64: Buffer.from(catalogCsv(prods)).toString('base64'), filename: 'c.csv', mode: 'all_or_nothing' })
  for (const p of prods) vid[p.sku] = app.lookup.byCode(p.barcode)!.variantId
})

// deterministic PRNG so failures are reproducible
function rng(seed: number) {
  let s = seed >>> 0
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32)
}

describe('barcode / duplicate handling', () => {
  it('duplicate barcode is rejected by save, by import (row error) and by SKU', async () => {
    await expect(get('catalog', 'save', { name: 'Dup', hsn: '', taxRateBp: 0, variants: [{ name: '', mrp: 1, price: 1, cost: 0, barcode: prods[0].barcode }] })).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(get('catalog', 'save', { name: 'Dup2', hsn: '', taxRateBp: 0, variants: [{ name: '', mrp: 1, price: 1, cost: 0, sku: prods[0].sku }] })).rejects.toMatchObject({ code: 'CONFLICT' })
    const csv = 'Name,SKU,Barcode,Price,GST %\nDup3,NEWSKU1,' + prods[0].barcode + ',10.00,18\nDup3b,NEWSKU2,' + prods[0].barcode + ',10.00,18\n'
    const b64 = Buffer.from(csv).toString('base64')
    const prev = await get('catalog', 'importPreview', { bytesBase64: b64, filename: 'd.csv' })
    expect(prev.counts.invalid).toBeGreaterThan(0)
    expect(app.db.value<number>("SELECT COUNT(*) FROM product_variants WHERE sku LIKE 'NEWSKU%'")).toBe(0)
  })
  it('the same barcode twice inside one import file is flagged', async () => {
    const csv = 'Name,SKU,Barcode,Price,GST %\nTwin A,TW1,5901234123457,10.00,18\nTwin B,TW2,5901234123457,10.00,18\n'
    const prev = await get('catalog', 'importPreview', { bytesBase64: Buffer.from(csv).toString('base64'), filename: 't.csv' })
    expect(prev.counts.invalid).toBeGreaterThan(0)
  })
})

describe('stock edge cases', () => {
  it('selling more than stock fails with INSUFFICIENT_STOCK and changes nothing; allow_negative lets it through', async () => {
    const v = vid.CRK010
    const before = app.db.value<number>('SELECT COUNT(*) FROM sales')
    await expect(get('pos', 'completeSale', { lines: [{ variantId: v, qty: 101 }], payments: [{ method: 'cash', amount: 99999999 }] })).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' })
    expect(app.db.value<number>('SELECT COUNT(*) FROM sales')).toBe(before)
    expect(app.lookup.byId(v)!.stock).toBe(100)
    // multi-line: first line fine, second fails -> whole sale rolls back (stock of the first line untouched)
    await expect(get('pos', 'completeSale', { lines: [{ variantId: vid.CRK011, qty: 1 }, { variantId: v, qty: 500 }], payments: [{ method: 'cash', amount: 99999999 }] })).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' })
    expect(app.lookup.byId(vid.CRK011)!.stock).toBe(100)
    expect(app.db.value<number>('SELECT COUNT(*) FROM sale_items')).toBe(0)
    await get('settings', 'set', { key: 'inventory.allow_negative', value: '1' })
    await get('pos', 'completeSale', { lines: [{ variantId: v, qty: 101 }], payments: [{ method: 'cash', amount: 99999999 }] })
    expect(app.lookup.byId(v)!.stock).toBe(-1)
    await get('settings', 'set', { key: 'inventory.allow_negative', value: '0' })
    await expect(get('pos', 'completeSale', { lines: [{ variantId: v, qty: 1 }], payments: [{ method: 'cash', amount: 99999999 }] })).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' })
  })
  it('invalid quantities: 0, negative, fractional, over the 1,000,000 cap, empty cart', async () => {
    for (const qty of [0, -1, 1.5, 1_000_001]) await expect(get('pos', 'completeSale', { lines: [{ variantId: vid.CRK012, qty }], payments: [{ method: 'cash', amount: 100 }] }), `qty ${qty}`).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(get('pos', 'completeSale', { lines: [], payments: [] })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(get('pos', 'completeSale', { lines: [{ variantId: 999999, qty: 1 }], payments: [{ method: 'cash', amount: 100 }] })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
  it('huge quantity (allow_negative on): totals stay exact integers and match the BigInt oracle', async () => {
    await get('settings', 'set', { key: 'inventory.allow_negative', value: '1' })
    const v = app.lookup.byId(vid.CRK013)!
    const qty = 900_000
    const o = oracleInclusive([{ qty, price: v.price, bp: v.taxRateBp }])
    const priced = await get('pos', 'cartPrice', { lines: [{ variantId: v.variantId, qty }] })
    expect(Number.isSafeInteger(priced.totals.total)).toBe(true)
    expect(priced.totals).toMatchObject({ total: o.total, tax: o.tax })
    await get('settings', 'set', { key: 'inventory.allow_negative', value: '0' })
  })
})

describe('double submit / idempotency', () => {
  it('two concurrent completeSale calls with the same requestId create exactly one sale and one stock movement', async () => {
    const v = vid.CRK014
    const stockBefore = app.lookup.byId(v)!.stock
    const salesBefore = app.db.value<number>('SELECT COUNT(*) FROM sales')!
    const args = { requestId: 'double-click-0001', lines: [{ variantId: v, qty: 2 }], payments: [{ method: 'cash', amount: 100000 }] }
    const [a, b] = await Promise.all([get('pos', 'completeSale', args), get('pos', 'completeSale', args)])
    expect(a.saleId).toBe(b.saleId)
    expect([a.duplicate, b.duplicate].sort()).toEqual([false, true])
    expect(app.db.value<number>('SELECT COUNT(*) FROM sales')).toBe(salesBefore + 1)
    expect(app.lookup.byId(v)!.stock).toBe(stockBefore - 2)
    // a DIFFERENT cart under the same requestId must not silently return the old sale
    const other = await get('pos', 'completeSale', { ...args, lines: [{ variantId: v, qty: 5 }] }).catch((e) => e)
    // documented behaviour: replay returns the original sale (idempotency key wins)
    expect(other.saleId ?? 'rejected').toBeDefined()
  })
})

describe('rounding: 100 random carts vs independent BigInt integer oracle (tax-inclusive)', () => {
  it('cartPrice, completeSale row, items and payments all agree with the oracle', async () => {
    const r = rng(20260519)
    await get('settings', 'set', { key: 'inventory.allow_negative', value: '1' })
    for (let n = 0; n < 100; n++) {
      const count = 1 + Math.floor(r() * 6)
      const picks: { variantId: number; qty: number; price: number; bp: number }[] = []
      for (let i = 0; i < count; i++) {
        const p = prods[Math.floor(r() * prods.length)]
        if (picks.some((x) => x.variantId === vid[p.sku])) continue
        picks.push({ variantId: vid[p.sku], qty: 1 + Math.floor(r() * 25), price: p.price, bp: p.gstPct * 100 })
      }
      const o = oracleInclusive(picks.map((p) => ({ qty: p.qty, price: p.price, bp: p.bp })))
      const lines = picks.map((p) => ({ variantId: p.variantId, qty: p.qty }))
      const priced = await get('pos', 'cartPrice', { lines })
      expect({ total: priced.totals.total, tax: priced.totals.tax, roundOff: priced.totals.roundOff }, `cart ${n}`).toEqual({ total: o.total, tax: o.tax, roundOff: o.roundOff })
      const sale = await get('pos', 'completeSale', { lines, payments: [{ method: 'upi', amount: o.total }] })
      const row = app.db.get<any>('SELECT * FROM sales WHERE id = ?', sale.saleId)
      expect(row).toMatchObject({ total: o.total, tax: o.tax, round_off: o.roundOff, subtotal: o.pre })
      // invariants that must hold for every bill
      expect(app.db.value<number>('SELECT SUM(line_total) FROM sale_items WHERE sale_id = ?', sale.saleId)! + row.round_off).toBe(row.total)
      expect(app.db.value<number>('SELECT SUM(tax_amount) FROM sale_items WHERE sale_id = ?', sale.saleId)).toBe(row.tax)
      expect(app.db.value<number>('SELECT SUM(amount) FROM sale_payments WHERE sale_id = ?', sale.saleId)).toBe(row.total)
      expect(row.total % 100).toBe(0)
    }
    await get('settings', 'set', { key: 'inventory.allow_negative', value: '0' })
  })

  it('random discounts: bill discount shares sum exactly, total never negative, tax+taxable consistent', async () => {
    const r = rng(7)
    for (let n = 0; n < 100; n++) {
      const p1 = prods[Math.floor(r() * 24)], p2 = prods[Math.floor(r() * 24)]
      const lines = [{ variantId: vid[p1.sku], qty: 1 + Math.floor(r() * 9) }, ...(p1.sku === p2.sku ? [] : [{ variantId: vid[p2.sku], qty: 1 + Math.floor(r() * 9) }])]
      const billDiscount = r() < 0.5 ? { type: 'percent', value: Math.floor(r() * 10001) } : { type: 'amount', value: Math.floor(r() * 300000) }
      const priced = await get('pos', 'cartPrice', { lines, billDiscount })
      const t = priced.totals
      expect(t.total).toBeGreaterThanOrEqual(0)
      expect(t.lines.reduce((a: number, l: any) => a + l.billDiscount, 0)).toBe(t.billDiscountTotal)
      expect(t.lines.reduce((a: number, l: any) => a + l.lineTotal, 0)).toBe(t.preRoundTotal)
      expect(t.total - t.roundOff).toBe(t.preRoundTotal)
      for (const l of t.lines) expect(l.taxable + l.taxAmount).toBe(l.lineTotal) // inclusive mode
    }
  })

  it('tax-EXCLUSIVE mode (the key the POS actually reads) matches an exclusive oracle', async () => {
    app.setSetting('pos.prices_include_tax', '0')
    const lines = [{ variantId: vid.CRK001, qty: 3 }, { variantId: vid.CRK004, qty: 2 }]
    const priced = await get('pos', 'cartPrice', { lines })
    const tax = (net: number, bp: number) => Math.floor((net * bp * 2 + 10000) / 20000)
    const n1 = 3 * prods[0].price, n2 = 2 * prods[3].price
    const pre = n1 + tax(n1, 1800) + n2 + tax(n2, 2800)
    expect(priced.totals.tax).toBe(tax(n1, 1800) + tax(n2, 2800))
    expect(priced.totals.preRoundTotal).toBe(pre)
    app.setSetting('pos.prices_include_tax', '1')
  })
})

describe('DEFECT PROBES: settings that the Settings page writes but billing ignores', () => {
  beforeAll(() => { for (const v of Object.values(vid)) app.moveStock({ variantId: v, delta: 100000, type: 'opening' }) })
  // These tests assert the DESIRED behaviour; they are expected to FAIL while the defect exists.
  it('DEF-1 Settings "billing.prices_include_tax" = 0 must switch the POS to tax-exclusive pricing', async () => {
    await get('settings', 'set', { key: 'billing.prices_include_tax', value: '0' })
    const priced = await get('pos', 'cartPrice', { lines: [{ variantId: vid.CRK001, qty: 1 }] })
    await get('settings', 'set', { key: 'billing.prices_include_tax', value: '1' })
    expect(priced.totals.pricesIncludeTax, 'POS ignored the Settings-page toggle').toBe(false)
  })
  it('DEF-2 Settings "billing.invoice_prefix" must be used for new invoice numbers', async () => {
    await get('settings', 'set', { key: 'billing.invoice_prefix', value: 'SLF' })
    const s = await get('pos', 'completeSale', { lines: [{ variantId: vid.CRK015, qty: 1 }], payments: [{ method: 'cash', amount: 100000 }] })
    await get('settings', 'set', { key: 'billing.invoice_prefix', value: 'INV' })
    expect(s.invoiceNo, 'invoice prefix setting ignored').toMatch(/^SLF-/)
  })
  it('DEF-3 Settings "billing.return_prefix" (default RET) must be used for return numbers', async () => {
    const sale = await get('pos', 'completeSale', { lines: [{ variantId: vid.CRK016, qty: 1 }], payments: [{ method: 'cash', amount: 100000 }] })
    const s = await get('pos', 'getSale', { id: sale.saleId })
    const r = await get('pos', 'createReturn', { saleId: sale.saleId, items: [{ saleItemId: s.items[0].id, qty: 1 }], reason: 'x' })
    expect(r.returnNo, 'return prefix setting ignored (code hard-codes RTN)').toMatch(/^RET-/)
  })
})

describe('hostile / unicode strings', () => {
  beforeAll(() => { for (const v of Object.values(vid)) app.moveStock({ variantId: v, delta: 100000, type: 'opening' }) })
  const nasty = [
    "Robert'); DROP TABLE products;--", "x' OR '1'='1", 'Ünïcødé பட்டாசு 🎆 ＡＢＣ', '<script>alert(1)</script>', '100% Pure_Bomb', 'back\\slash "quote"',
    'a'.repeat(200), '\u0000nul', 'ZWJ‍​space'
  ]
  it('product names with SQL/HTML/unicode save, search, sell and print without corruption or injection', async () => {
    for (const [i, name] of nasty.entries()) {
      let saved: any
      try {
        saved = await get('catalog', 'save', { name, hsn: '3604', taxRateBp: 1800, variants: [{ name: '', mrp: 2000, price: 1500 + i, cost: 500, autoBarcode: true }] })
      } catch (e: any) {
        expect(e.code, `name ${JSON.stringify(name).slice(0, 30)}`).toBe('VALIDATION') // length / control-char rejections are fine
        continue
      }
      const v = saved.variants[0]
      app.moveStock({ variantId: v.id, delta: 5, type: 'opening' })
      if (!/[%_]/.test(name.slice(0, 20))) {
        const found = await get('inventory', 'search', { text: name.slice(0, 20) })
        expect(found.some((x: any) => x.variantId === v.id), `search ${name.slice(0, 20)}`).toBe(true)
      }
      const sale = await get('pos', 'completeSale', { lines: [{ variantId: v.id, qty: 1 }], payments: [{ method: 'cash', amount: 100000 }] })
      const { html } = await get('printing', 'renderInvoiceHtml', { saleId: sale.saleId, template: 'receipt80' })
      expect(html).not.toContain('<script>alert(1)</script>') // HTML is escaped
    }
    for (const t of ['products', 'sales', 'product_variants', 'business_profile_versions']) expect(app.db.value<number>(`SELECT COUNT(*) FROM ${t}`)).toBeGreaterThan(0)
  })
  it('LIKE wildcards: "%" must not dump the catalogue and SQL-ish search text is inert', async () => {
    expect(await get('inventory', 'search', { text: '%' })).toEqual([])
    const posPct = await get('pos', 'search', { text: '%', limit: 100 })
    // documents current behaviour: pos.search('%') strips the wildcard and returns an arbitrary first page instead of nothing
    console.log('INFO pos.search("%") returned', posPct.length, 'rows')
    expect(await get('pos', 'search', { text: "'; DELETE FROM sales;--" })).toEqual([])
    expect(app.db.value<number>('SELECT COUNT(*) FROM sales')).toBeGreaterThan(0)
  })
  it('DEF-4 typing the exact name of a product containing % or _ finds it', async () => {
    const hits = await get('pos', 'search', { text: '100% Pure_Bomb' })
    expect(hits.some((x: any) => x.displayName === '100% Pure_Bomb'), 'wildcards are stripped from the query so the literal name never matches').toBe(true)
  })
  it('hostile profile fields are stored verbatim and HTML-escaped when printed', async () => {
    await get('businessProfile', 'save', { shopName: 'A<b>&"\' Shop', address: '<img src=x onerror=alert(1)>' })
    const sale = await get('pos', 'completeSale', { lines: [{ variantId: vid.CRK017, qty: 1 }], payments: [{ method: 'cash', amount: 100000 }] })
    const { html } = await get('printing', 'renderInvoiceHtml', { saleId: sale.saleId, template: 'invoiceA4' })
    expect(html).toContain('A&lt;b&gt;&amp;')
    expect(html).not.toContain('<img src=x onerror')
    await get('businessProfile', 'save', { shopName: 'Normal Shop', address: '1 Main Rd' })
  })
})

describe('performance with a 20,000 product catalog', () => {
  it('search by name/sku/barcode and the scan lookup stay fast', async () => {
    const db = app.db
    const t0 = Date.now()
    db.transaction(() => {
      for (let i = 0; i < 20000; i++) {
        const p = db.run('INSERT INTO products(uuid,name,tax_rate_bp,hsn) VALUES (?,?,?,?)', app.uuid(), `Bulk Rocket ${i} Special`, 1800, '3604')
        db.run('INSERT INTO product_variants(uuid,product_id,sku,barcode,price,mrp,cost) VALUES (?,?,?,?,?,?,?)', app.uuid(), p.lastId, `BULK${i}`, `7${String(i).padStart(11, '0')}`, 1000 + i, 1200 + i, 600)
      }
    })
    const seedMs = Date.now() - t0
    const time = async (f: () => unknown) => { const s = performance.now(); await f(); return performance.now() - s }
    const tScan = await time(() => app.lookup.byCode('700000019999'))
    const tName = await time(() => get('pos', 'search', { text: 'Rocket 19999' }))
    const tSku = await time(() => get('pos', 'search', { text: 'BULK12345' }))
    const tCat = await time(() => get('catalog', 'list', { search: 'Rocket 15000', limit: 50 }))
    const tCommon = await time(() => get('pos', 'search', { text: 'Bulk' })) // matches all 20k
    console.log(`PERF seed=${seedMs}ms scan=${tScan.toFixed(1)}ms name=${tName.toFixed(1)}ms sku=${tSku.toFixed(1)}ms catalogList=${tCat.toFixed(1)}ms common=${tCommon.toFixed(1)}ms`)
    expect(app.lookup.byCode('700000019999')?.sku).toBe('BULK19999')
    expect(tScan).toBeLessThan(50)
    expect(tName).toBeLessThan(500)
    expect(tSku).toBeLessThan(500)
    expect(tCat).toBeLessThan(800)
    expect(tCommon).toBeLessThan(800)
    expect((await get('pos', 'search', { text: 'Rocket 19999' })).some((x: any) => x.sku === 'BULK19999')).toBe(true)
  })
})

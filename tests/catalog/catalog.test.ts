import { describe, it, expect, beforeEach } from 'vitest'
import { createTestApp, actAs } from '../helpers'
import type { App } from '../../src/main/core/app'
import { snapshotRow } from '../../src/main/core/snapshot'
import { PRODUCT_CHILDREN } from '../../src/main/modules/catalog/service'

let app: App
const call = <T = any>(m: string, a?: unknown) => app.call('catalog', m, a) as Promise<T>

const prod = (over: Record<string, unknown> = {}, variant: Record<string, unknown> = {}) => ({
  name: 'Sparkler Box',
  hsn: '3604',
  taxRateBp: 1800,
  variants: [{ name: '', mrp: 12000, price: 10000, cost: 7000, ...variant }],
  ...over
})

beforeEach(() => {
  app = createTestApp()
})

describe('products CRUD + variants', () => {
  it('creates a simple product with a default variant and auto SKU', async () => {
    const p = await call('save', prod())
    expect(p.id).toBeGreaterThan(0)
    expect(p.variants).toHaveLength(1)
    expect(p.variants[0].name).toBe('')
    expect(p.variants[0].sku).toBe('SKU-000001')
    const p2 = await call('save', prod({ name: 'Second' }))
    expect(p2.variants[0].sku).toBe('SKU-000002')
    expect(app.lookup.byCode('sku-000001')?.productName).toBe('Sparkler Box')
  })

  it('requires at least one variant and a name', async () => {
    await expect(call('save', { name: 'x', variants: [] })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call('save', prod({ name: '  ' }))).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call('save', prod({ taxRateBp: -1 }))).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call('save', prod({ hsn: 'abc' }))).rejects.toMatchObject({ code: 'VALIDATION' })
  })

  it('supports multiple variants, updates them and adds a new one', async () => {
    const p = await call('save', prod({ name: 'Shirt', variants: [{ name: 'M', price: 500 }, { name: 'L', price: 600 }] }))
    expect(p.variants.map((v: any) => v.name)).toEqual(['M', 'L'])
    const upd = await call('save', {
      ...prod({ id: p.id, name: 'Shirt', variants: [
        { id: p.variants[0].id, name: 'M', price: 550 },
        { name: 'XL', price: 700 }
      ] })
    })
    expect(upd.variants).toHaveLength(3)
    expect(upd.variants.find((v: any) => v.name === 'M').price).toBe(550)
    expect(upd.variants.find((v: any) => v.name === 'L').price).toBe(600) // omitted variants untouched
    await expect(call('save', prod({ id: p.id, name: 'Shirt', variants: [{ name: 'XL' }] }))).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(call('save', prod({ name: 'Dup', variants: [{ name: 'A' }, { name: 'a' }] }))).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('lists with search, filters and pagination', async () => {
    const cat = (await call('saveCategory', { name: 'Fireworks' })).id
    const brand = (await call('saveBrand', { name: 'Standard' })).id
    for (let i = 1; i <= 7; i++)
      await call('save', prod({ name: `Item ${i}`, categoryId: i <= 3 ? cat : null, brandId: i === 1 ? brand : null }, { barcode: i === 2 ? null : undefined }))
    const all = await call('list', { limit: 5 })
    expect(all.total).toBe(7)
    expect(all.rows).toHaveLength(5)
    expect((await call('list', { limit: 5, offset: 5 })).rows).toHaveLength(2)
    expect((await call('list', { search: 'item 3' })).total).toBe(1)
    expect((await call('list', { categoryId: cat })).total).toBe(3)
    expect((await call('list', { brandId: brand })).total).toBe(1)
    expect((await call('list', { noBarcode: true })).total).toBe(7)
    const p1 = all.rows[0]
    await call('setActive', { ids: [p1.id], active: false })
    expect((await call('list', { active: true })).total).toBe(6)
    expect((await call('list', { active: false })).total).toBe(1)
  })

  it('finds by alias barcode and SKU in search; low stock filter', async () => {
    const p = await call('save', prod({ variants: [{ name: '', barcode: '4006381333931', aliases: ['ALIAS-77'], reorderLevel: 5, openingStock: 3, price: 100 }] }))
    expect((await call('list', { search: 'ALIAS-77' })).total).toBe(1)
    expect((await call('list', { search: '4006381333931' })).rows[0].id).toBe(p.id)
    expect((await call('list', { lowStock: true })).total).toBe(1)
    expect((await call('list', { lowStock: true })).rows[0].lowStock).toBe(true)
    app.moveStock({ variantId: p.variants[0].id, delta: 10, type: 'adjustment' })
    expect((await call('list', { lowStock: true })).total).toBe(0)
    expect(app.lookup.byCode('ALIAS-77')?.productId).toBe(p.id)
    expect((await call('list', { noBarcode: true })).total).toBe(0)
  })
})

describe('uniqueness and conflicts', () => {
  it('rejects duplicate SKU (case-insensitive) with a friendly CONFLICT', async () => {
    await call('save', prod({ name: 'A', variants: [{ sku: 'ABC-1' }] }))
    const e = await call('save', prod({ name: 'B', variants: [{ sku: 'abc-1' }] })).catch((x) => x)
    expect(e.code).toBe('CONFLICT')
    expect(e.message).toMatch(/SKU abc-1 is already used by "A"/)
  })

  it('rejects duplicate barcode and alias collisions', async () => {
    await call('save', prod({ name: 'A', variants: [{ barcode: '4006381333931', aliases: ['AL1'] }] }))
    const e1 = await call('save', prod({ name: 'B', variants: [{ barcode: '4006381333931' }] })).catch((x) => x)
    expect(e1).toMatchObject({ code: 'CONFLICT' })
    expect(e1.message).toMatch(/already used by "A"/)
    await expect(call('save', prod({ name: 'C', variants: [{ aliases: ['AL1'] }] }))).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(call('save', prod({ name: 'D', variants: [{ barcode: 'AL1' }] }))).rejects.toMatchObject({ code: 'CONFLICT' })
    // failed save leaves no partial product behind
    expect(app.db.value('SELECT COUNT(*) FROM products')).toBe(1)
  })

  it('validates barcode check digits (strict by default) and can be relaxed', async () => {
    await expect(call('save', prod({ variants: [{ barcode: '4006381333932' }] }))).rejects.toMatchObject({ code: 'VALIDATION' })
    await call('saveSettings', { strictBarcodes: false })
    const p = await call('save', prod({ variants: [{ barcode: '4006381333932' }] }))
    expect(p.variants[0].barcode).toBe('4006381333932')
  })

  it('validateBarcode reports owners; generateBarcode previews the next prefix + running number', async () => {
    const p = await call('save', prod({ variants: [{ barcode: '4006381333931' }] }))
    const r = await call('validateBarcode', { code: '4006381333931' })
    expect(r.valid).toBe(false)
    expect(r.owner).toBe('Sparkler Box')
    expect((await call('validateBarcode', { code: '4006381333931', variantId: p.variants[0].id })).valid).toBe(true)
    // default numbering = fixed prefix + running number; "Generate" only previews, so clicking twice burns nothing
    const a = (await call('generateBarcode')).barcode
    const b = (await call('generateBarcode')).barcode
    expect(a).toBe('200000001')
    expect(b).toBe(a)
    expect((await call('generateBarcode', { exclude: [a] })).barcode).toBe('200000002') // second unsaved variant of the same form
    expect((await call('validateBarcode', { code: a })).valid).toBe(true)
  })

  it('ean13 numbering: generateBarcode returns unique valid EAN-13 codes', async () => {
    await call('saveSettings', { barcodeMode: 'ean13' })
    const a = (await call('generateBarcode')).barcode
    const b = (await call('generateBarcode', { exclude: [a] })).barcode
    expect(a).not.toBe(b)
    expect(a).toMatch(/^200\d{10}$/)
    expect(a).toBe('2000000000015')
    expect(b).toBe('2000000000022')
    expect((await call('validateBarcode', { code: a })).valid).toBe(true)
    expect((await call('validateBarcode', { code: a })).format).toBe('EAN13')
  })

  it('autoBarcode + bulk generate missing barcodes', async () => {
    const p = await call('save', prod({ variants: [{ autoBarcode: true }] }))
    expect(p.variants[0].barcode).toBe('200000001')
    for (let i = 0; i < 4; i++) await call('save', prod({ name: `NoCode ${i}` }))
    const r = await call('generateMissingBarcodes')
    expect(r).toEqual({ assigned: 4, remaining: 0 })
    const codes = app.db.all<{ barcode: string }>('SELECT barcode FROM product_variants ORDER BY id').map((x) => x.barcode)
    expect(codes).toEqual(['200000001', '200000002', '200000003', '200000004', '200000005'])
    expect((await call('generateMissingBarcodes')).assigned).toBe(0)
  })

  it('ean13 numbering: autoBarcode + bulk generate missing barcodes', async () => {
    await call('saveSettings', { barcodeMode: 'ean13' })
    const p = await call('save', prod({ variants: [{ autoBarcode: true }] }))
    expect(p.variants[0].barcode).toMatch(/^200\d{10}$/)
    for (let i = 0; i < 4; i++) await call('save', prod({ name: `NoCode ${i}` }))
    expect(await call('generateMissingBarcodes')).toEqual({ assigned: 4, remaining: 0 })
    const codes = app.db.all<{ barcode: string }>('SELECT barcode FROM product_variants').map((x) => x.barcode)
    expect(new Set(codes).size).toBe(5)
    for (const c of codes) expect(c).toMatch(/^200\d{10}$/)
  })

  it('SKU prefix is configurable', async () => {
    await call('saveSettings', { skuPrefix: 'VM' })
    expect((await call('save', prod())).variants[0].sku).toBe('VM-000001')
    await expect(call('saveSettings', { skuPrefix: 'bad prefix!' })).rejects.toMatchObject({ code: 'VALIDATION' })
    // EAN-13 numbering still needs the in-store range 200-299 (a running-number prefix may be any letters/digits)
    await expect(call('saveSettings', { barcodeMode: 'ean13', barcodePrefix: '150' })).rejects.toMatchObject({ code: 'VALIDATION' })
    expect((await call('getSettings')).barcodeMode).toBe('sequence')
  })

  it('category and brand names are unique, tree has no cycles', async () => {
    const a = (await call('saveCategory', { name: 'Root' })).id
    const b = (await call('saveCategory', { name: 'Child', parentId: a })).id
    await expect(call('saveCategory', { name: 'root' })).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(call('saveCategory', { id: a, name: 'Root', parentId: b })).rejects.toMatchObject({ code: 'VALIDATION' })
    await call('saveBrand', { name: 'Acme' })
    await expect(call('saveBrand', { name: 'ACME' })).rejects.toMatchObject({ code: 'CONFLICT' })
    const cats = await call('listCategories')
    expect(cats.find((c: any) => c.id === b).path).toBe('Root > Child')
  })
})

describe('deactivation rules', () => {
  it('hard-deletes a product with no history, deactivates one with stock or sales', async () => {
    const clean = await call('save', prod({ name: 'Clean', image: { mime: 'image/png', base64: Buffer.from('png').toString('base64') } }))
    expect(app.db.value('SELECT COUNT(*) FROM product_images')).toBe(1)
    expect(await call('remove', { id: clean.id })).toMatchObject({ deleted: true })
    expect(app.db.value('SELECT COUNT(*) FROM products')).toBe(0)
    expect(app.db.value('SELECT COUNT(*) FROM product_images')).toBe(0)

    const stocked = await call('save', prod({ name: 'Stocked', variants: [{ openingStock: 5 }] }))
    const r = await call('remove', { id: stocked.id })
    expect(r).toMatchObject({ deleted: false, deactivated: true })
    expect((await call('get', { id: stocked.id })).active).toBe(false)

    const sold = await call('save', prod({ name: 'Sold' }))
    const v = sold.variants[0]
    const sale = app.db.run(
      `INSERT INTO sales(uuid,invoice_no,pos_id,user_id,subtotal,total,profile_version_id) VALUES ('s1','INV-1',?,?,100,100,1)`,
      app.session!.posId, app.session!.userId
    )
    app.db.run(`INSERT INTO sale_items(sale_id,variant_id,name,sku,qty,unit_price,line_total) VALUES (?,?, 'Sold','x',1,100,100)`, sale.lastId, v.id)
    expect(await call('remove', { id: sold.id })).toMatchObject({ deleted: false, deactivated: true })
    expect(app.db.value('SELECT COUNT(*) FROM products WHERE id = ?', sold.id)).toBe(1)
  })

  it('removeVariant keeps at least one variant and deactivates used ones', async () => {
    const p = await call('save', prod({ variants: [{ name: 'A' }, { name: 'B', openingStock: 2 }] }))
    await expect(call('removeVariant', { id: 999999 })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(await call('removeVariant', { id: p.variants[1].id })).toMatchObject({ deactivated: true, deleted: false })
    const q = await call('save', prod({ name: 'Q', variants: [{ name: 'A' }, { name: 'B' }] }))
    expect(await call('removeVariant', { id: q.variants[1].id })).toMatchObject({ deleted: true })
    await expect(call('removeVariant', { id: q.variants[0].id })).rejects.toMatchObject({ code: 'VALIDATION' })
  })

  it('bulk activate/deactivate and assign category', async () => {
    const ids: number[] = []
    for (let i = 0; i < 3; i++) ids.push((await call('save', prod({ name: `P${i}` }))).id)
    const cat = (await call('saveCategory', { name: 'Bulk' })).id
    expect(await call('assignCategory', { ids, categoryId: cat })).toEqual({ changed: 3 })
    expect(await call('assignCategory', { ids, categoryId: cat })).toEqual({ changed: 0 })
    expect(await call('setActive', { ids, active: false })).toEqual({ changed: 3 })
    expect(app.lookup.byCode('SKU-000001')?.active).toBe(false)
    expect(await call('setActive', { ids, active: true })).toEqual({ changed: 3 })
    const c = await call('deleteCategory', { id: cat })
    expect(c).toMatchObject({ deactivated: true, deleted: false })
  })
})

describe('opening stock, audit and sync', () => {
  it('posts opening stock through the ledger in the same transaction', async () => {
    const p = await call('save', prod({ variants: [{ name: 'S', openingStock: 12, cost: 4500 }, { name: 'M', openingStock: 3 }] }))
    const ledger = app.db.all<any>("SELECT * FROM stock_movements WHERE type='opening' ORDER BY id")
    expect(ledger.map((l) => l.qty_delta)).toEqual([12, 3])
    expect(ledger[0].unit_cost).toBe(4500)
    expect(app.lookup.byId(p.variants[0].id)?.stock).toBe(12)
    // untracked product ignores opening stock
    await call('save', prod({ name: 'Service', trackStock: false, variants: [{ openingStock: 9 }] }))
    expect(app.db.value('SELECT COUNT(*) FROM stock_movements')).toBe(2)
    // opening stock is ignored for existing variants on update
    await call('save', prod({ id: p.id, variants: [{ id: p.variants[0].id, name: 'S', openingStock: 99 }] }))
    expect(app.db.value('SELECT COUNT(*) FROM stock_movements')).toBe(2)
  })

  it('rolls back the product when opening stock cannot be posted', async () => {
    app.db.run('UPDATE locations SET active = 0')
    app.db.run('DELETE FROM locations')
    await expect(call('save', prod({ variants: [{ openingStock: 5 }] }))).rejects.toBeTruthy()
    expect(app.db.value('SELECT COUNT(*) FROM products')).toBe(0)
    expect(app.db.value('SELECT COUNT(*) FROM audit_log WHERE entity = ?', 'product')).toBe(0)
  })

  it('audits price, cost and tax changes with old/new and keeps price history', async () => {
    const p = await call('save', prod())
    const vid = p.variants[0].id
    await call('save', prod({ id: p.id, taxRateBp: 500, hsn: '9999', variants: [{ id: vid, price: 11000, mrp: 13000, cost: 7500 }] }))
    const hist = await call('priceHistory', { variantId: vid })
    expect(hist).toHaveLength(1)
    expect(hist[0].old).toEqual({ mrp: 12000, price: 10000, cost: 7000 })
    expect(hist[0].new).toEqual({ mrp: 13000, price: 11000, cost: 7500 })
    const tax = app.db.get<any>("SELECT * FROM audit_log WHERE entity='product' AND action='tax_change'")!
    expect(JSON.parse(tax.old_json)).toEqual({ taxRateBp: 1800, hsn: '3604' })
    expect(JSON.parse(tax.new_json)).toEqual({ taxRateBp: 500, hsn: '9999' })
    expect(app.db.value("SELECT COUNT(*) FROM audit_log WHERE entity='product' AND action='create'")).toBe(1)
    // identical save writes nothing
    const before = app.db.value<number>('SELECT COUNT(*) FROM audit_log')!
    await call('save', prod({ id: p.id, taxRateBp: 500, hsn: '9999', variants: [{ id: vid, price: 11000, mrp: 13000, cost: 7500 }] }))
    expect(app.db.value('SELECT COUNT(*) FROM audit_log')).toBe(before)
  })

  it('queues sync snapshots with variants and uuid refs', async () => {
    const cat = (await call('saveCategory', { name: 'Sync Cat' })).id
    const p = await call('save', prod({ categoryId: cat, variants: [{ name: 'A', aliases: ['SYNC-AL'] }, { name: 'B' }] }))
    const q = app.db.all<any>("SELECT * FROM sync_queue WHERE entity='products'")
    expect(q).toHaveLength(1)
    const snap = JSON.parse(q[0].payload_json)
    expect(q[0].entity_uuid).toBe(p.uuid)
    expect(snap.children.product_variants).toHaveLength(2)
    expect(snap.children.product_variants[0].children.variant_barcodes[0].row.barcode).toBe('SYNC-AL')
    expect(snap.refs.category_id.uuid).toBe(app.db.value('SELECT uuid FROM categories WHERE id = ?', cat))
    expect(app.db.value("SELECT COUNT(*) FROM sync_queue WHERE entity='categories'")).toBe(1)
    await call('save', prod({ id: p.id, name: 'Renamed', categoryId: cat, variants: [{ id: p.variants[0].id, name: 'A' }] }))
    expect(app.db.value("SELECT COUNT(*) FROM sync_queue WHERE entity='products'")).toBe(2)
    // the optimised snapshot is identical to the generic core snapshot
    const generic = JSON.parse(JSON.stringify(snapshotRow(app.db, 'products', p.id, PRODUCT_CHILDREN)))
    const latest = JSON.parse(app.db.value<string>("SELECT payload_json FROM sync_queue WHERE entity='products' ORDER BY id DESC LIMIT 1")!)
    expect(latest).toEqual(generic)
    await call('saveBrand', { name: 'BrandSync' })
    expect(app.db.value("SELECT COUNT(*) FROM sync_queue WHERE entity='brands'")).toBe(1)
  })
})

describe('images', () => {
  it('stores, serves as data URI, replaces and limits size', async () => {
    const png = Buffer.from('fake-png-bytes').toString('base64')
    const p = await call('save', prod({ image: { mime: 'image/png', base64: png } }))
    expect(p.imageDataUri).toBe(`data:image/png;base64,${png}`)
    const jpg = Buffer.from('fake-jpg').toString('base64')
    const p2 = await call('save', prod({ id: p.id, image: { mime: 'image/jpeg', base64: jpg }, variants: [{ id: p.variants[0].id }] }))
    expect(p2.imageDataUri).toBe(`data:image/jpeg;base64,${jpg}`)
    expect(app.db.value('SELECT COUNT(*) FROM product_images')).toBe(1)
    const p3 = await call('save', prod({ id: p.id, removeImage: true, variants: [{ id: p.variants[0].id }] }))
    expect(p3.imageDataUri).toBeNull()
    expect(app.db.value('SELECT COUNT(*) FROM product_images')).toBe(0)
    const big = Buffer.alloc(2 * 1024 * 1024 + 1, 1).toString('base64')
    await expect(call('save', prod({ name: 'Big', image: { mime: 'image/png', base64: big } }))).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call('save', prod({ name: 'Bad', image: { mime: 'text/html', base64: png } }))).rejects.toMatchObject({ code: 'VALIDATION' })
  })
})

describe('permissions', () => {
  it('cashier can view but not edit/delete/import; manager can', async () => {
    const p = await call('save', prod())
    actAs(app, 'Cashier')
    expect((await call('list')).total).toBe(1)
    expect((await call('get', { id: p.id })).name).toBe('Sparkler Box')
    for (const [m, a] of [
      ['save', prod({ name: 'Nope' })], ['remove', { id: p.id }], ['setActive', { ids: [p.id], active: false }],
      ['saveCategory', { name: 'X' }], ['saveBrand', { name: 'X' }], ['generateBarcode', {}], ['generateMissingBarcodes', {}],
      ['importPreview', { bytesBase64: 'YQ==', filename: 'a.csv' }], ['exportFile', { format: 'csv' }], ['packageExport', {}]
    ] as const)
      await expect(call(m, a), m).rejects.toMatchObject({ code: 'FORBIDDEN' })
    actAs(app, 'Manager')
    expect((await call('save', prod({ name: 'Ok' }))).id).toBeGreaterThan(0)
    expect(await call('setActive', { ids: [p.id], active: false })).toEqual({ changed: 1 })
  })

  it('requires a session', async () => {
    app.session = null
    await expect(call('list')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' })
  })
})

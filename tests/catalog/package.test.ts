import { describe, it, expect, beforeEach } from 'vitest'
import { gzipSync } from 'node:zlib'
import { createTestApp, actAs } from '../helpers'
import type { App } from '../../src/main/core/app'
import { buildPackage, decodePackage, encodePackage, mergePackage, checksumOf } from '../../src/main/modules/catalog/package'

let A: App
let B: App
const call = <T = any>(app: App, m: string, a?: unknown) => app.call('catalog', m, a) as Promise<T>

const seedA = async () => {
  const cat = (await call(A, 'saveCategory', { name: 'Fireworks' })).id
  const sub = (await call(A, 'saveCategory', { name: 'Sparklers', parentId: cat })).id
  const brand = (await call(A, 'saveBrand', { name: 'Standard' })).id
  const p = await call(A, 'save', {
    name: 'Sparkler', categoryId: sub, brandId: brand, hsn: '3604', taxRateBp: 1800,
    variants: [
      { name: '10cm', sku: 'SP-10', barcode: '4006381333931', aliases: ['SP10-ALT'], mrp: 5000, price: 4000, cost: 2500, openingStock: 40 },
      { name: '30cm', sku: 'SP-30', price: 9000 }
    ]
  })
  return p
}
const pkgOf = (app: App) => decodePackage(encodePackage(buildPackage(app.db)))

beforeEach(() => {
  A = createTestApp()
  B = createTestApp()
})

describe('catalog package', () => {
  it('exports a versioned, checksummed, uuid-keyed package (json and gzip)', async () => {
    await seedA()
    const pkg = buildPackage(A.db)
    expect(pkg).toMatchObject({ format: 'velmayil-catalog', schemaVersion: 1, source: { posCode: 'POS-01' } })
    expect(pkg.data.categories).toHaveLength(2)
    expect(pkg.data.variants).toHaveLength(2)
    expect(pkg.data.barcodes).toEqual([{ barcode: 'SP10-ALT', variantUuid: expect.any(String) }])
    expect(pkg.data.products[0].categoryUuid).toBe(A.db.value("SELECT uuid FROM categories WHERE name='Sparklers'"))
    expect(pkg.checksum).toBe(checksumOf(pkg.data))
    // no stock/sales leakage
    expect(JSON.stringify(pkg)).not.toMatch(/qty|stock_levels|invoice/)
    const plain = encodePackage(pkg)
    const gz = encodePackage(pkg, true)
    expect(gz.length).toBeLessThan(plain.length)
    expect(decodePackage(gz).checksum).toBe(pkg.checksum)
    expect(decodePackage(plain).data).toEqual(pkg.data)
  })

  it('rejects corrupt, tampered, foreign and too-new packages', async () => {
    await seedA()
    const pkg = buildPackage(A.db)
    const tampered = JSON.parse(JSON.stringify(pkg))
    tampered.data.variants[0].price = 1
    expect(() => decodePackage(Buffer.from(JSON.stringify(tampered)))).toThrow(/checksum/)
    expect(() => decodePackage(Buffer.from('not json'))).toThrow(/valid catalog package/)
    expect(() => decodePackage(Buffer.from(JSON.stringify({ format: 'other' })))).toThrow(/not a Velmayil catalog package/)
    expect(() => decodePackage(gzipSync(Buffer.from('{bad')))).toThrow()
    expect(() => decodePackage(Buffer.from(JSON.stringify({ ...pkg, schemaVersion: 99 })))).toThrow(/newer/)
  })

  it('merges into another POS by uuid, preserving uuids, aliases and timestamps; second merge is a no-op', async () => {
    await seedA()
    const rep = mergePackage(B, pkgOf(A))
    expect(rep.conflicts).toEqual([])
    expect(rep.counts.categories.created).toBe(2)
    expect(rep.counts.brands.created).toBe(1)
    expect(rep.counts.products.created).toBe(1)
    expect(rep.counts.variants.created).toBe(2)
    expect(rep.counts.barcodes.created).toBe(1)
    expect(B.db.value('SELECT uuid FROM products')).toBe(A.db.value('SELECT uuid FROM products'))
    expect(B.lookup.byCode('SP10-ALT')).toMatchObject({ displayName: 'Sparkler - 10cm', price: 4000, stock: 0 })
    expect(B.lookup.byCode('4006381333931')?.variantName).toBe('10cm')
    expect(B.db.get<any>("SELECT p.name AS parent FROM categories c JOIN categories p ON p.id=c.parent_id WHERE c.name='Sparklers'")).toEqual({ parent: 'Fireworks' })
    expect(B.db.value('SELECT updated_at FROM products')).toBe(A.db.value('SELECT updated_at FROM products'))
    expect(B.db.value("SELECT COUNT(*) FROM sync_queue WHERE entity='products'")).toBe(1)
    expect(B.db.value("SELECT COUNT(*) FROM audit_log WHERE action='package_import'")).toBe(1)

    const again = mergePackage(B, pkgOf(A))
    expect(again.counts.products).toMatchObject({ created: 0, updated: 0, unchanged: 1 })
    expect(again.counts.variants).toMatchObject({ created: 0, updated: 0, unchanged: 2 })
    expect(again.conflicts).toEqual([])
  })

  it('dry run reports what would happen and changes nothing', async () => {
    await seedA()
    const before = B.db.value<number>('SELECT COUNT(*) FROM audit_log')
    const rep = mergePackage(B, pkgOf(A), { dryRun: true })
    expect(rep.dryRun).toBe(true)
    expect(rep.counts.products.created).toBe(1)
    expect(rep.counts.variants.created).toBe(2)
    for (const t of ['products', 'product_variants', 'categories', 'brands', 'variant_barcodes', 'sync_queue'])
      expect(B.db.value(`SELECT COUNT(*) FROM ${t}`), t).toBe(0)
    expect(B.db.value('SELECT COUNT(*) FROM audit_log')).toBe(before)
    // the real run matches the dry run
    const real = mergePackage(B, pkgOf(A))
    expect(real.counts).toEqual(rep.counts)
  })

  it('last-writer-wins: newer incoming applies (with price audit), older incoming is reported as a conflict', async () => {
    const p = await seedA()
    mergePackage(B, pkgOf(A))
    // A changes the price later
    A.db.run('UPDATE product_variants SET price = 4500, updated_at = updated_at + 1000 WHERE sku = ?', 'SP-10')
    A.db.run('UPDATE products SET name = ?, updated_at = updated_at + 1000', 'Sparkler Deluxe')
    const rep = mergePackage(B, pkgOf(A))
    expect(rep.counts.variants.updated).toBe(1)
    expect(rep.counts.products.updated).toBe(1)
    expect(B.lookup.byCode('SP-10')).toMatchObject({ price: 4500, productName: 'Sparkler Deluxe' })
    const audit = B.db.get<any>("SELECT * FROM audit_log WHERE action='price_change'")!
    expect(JSON.parse(audit.old_json).price).toBe(4000)
    expect(JSON.parse(audit.new_json).price).toBe(4500)
    expect(audit.note).toMatch(/package/)

    // B edits locally later than anything in A's package -> A's package loses
    const pkgOld = pkgOf(A)
    B.db.run('UPDATE product_variants SET price = 7777, updated_at = updated_at + 5000 WHERE sku = ?', 'SP-10')
    const rep2 = mergePackage(B, pkgOld)
    expect(rep2.counts.variants.skipped).toBe(1)
    expect(rep2.conflicts).toEqual([expect.objectContaining({ entity: 'variant', reason: 'local_newer' })])
    expect(B.lookup.byCode('SP-10')?.price).toBe(7777)
    void p
  })

  it('reports SKU / barcode / name conflicts instead of overwriting unrelated local data', async () => {
    await seedA()
    await call(B, 'save', { name: 'Local Thing', variants: [{ sku: 'SP-30', barcode: '5901234123457' }] })
    await call(B, 'saveCategory', { name: 'Fireworks' })
    await call(B, 'save', { name: 'Other', variants: [{ sku: 'ZZ', aliases: ['SP10-ALT'] }] })
    const rep = mergePackage(B, pkgOf(A))
    const reasons = rep.conflicts.map((c) => c.reason).sort()
    expect(reasons).toContain('sku_conflict')
    expect(reasons).toContain('name_exists')
    expect(reasons).toContain('barcode_conflict')
    expect(B.lookup.byCode('SP-30')?.productName).toBe('Local Thing') // untouched
    expect(B.lookup.byCode('SP10-ALT')?.productName).toBe('Other')
    // the product still arrives, attached to the existing same-named category
    const prod = B.db.get<any>("SELECT c.name AS cat FROM products p JOIN categories c ON c.id=p.category_id WHERE p.name='Sparkler'")!
    expect(prod.cat).toBe('Sparklers')
  })

  it('propagates alias barcode removal when the variant version is newer', async () => {
    const p = await seedA()
    mergePackage(B, pkgOf(A))
    await call(A, 'save', { id: p.id, name: 'Sparkler', variants: [{ id: p.variants[0].id, name: '10cm', aliases: [] }] })
    A.db.run('UPDATE product_variants SET updated_at = updated_at + 2000 WHERE sku = ?', 'SP-10')
    mergePackage(B, pkgOf(A))
    expect(B.lookup.byCode('SP10-ALT')).toBeUndefined()
  })

  it('service methods: packageExport / packageImport (bytes, dry run, permissions)', async () => {
    await seedA()
    const out = await call(A, 'packageExport', { gzip: true })
    expect(out.filename).toBe('catalog-package.json.gz')
    expect(out.counts).toMatchObject({ products: 1, variants: 2 })
    const dry = await call(B, 'packageImport', { bytesBase64: out.bytesBase64, filename: out.filename, dryRun: true })
    expect(dry.counts.products.created).toBe(1)
    expect(B.db.value('SELECT COUNT(*) FROM products')).toBe(0)
    const real = await call(B, 'packageImport', { bytesBase64: out.bytesBase64, filename: out.filename })
    expect(real.counts.variants.created).toBe(2)
    actAs(B, 'Cashier')
    await expect(call(B, 'packageImport', { bytesBase64: out.bytesBase64 })).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})

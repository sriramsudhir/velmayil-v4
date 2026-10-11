import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addProduct, cleanup, makePos, settle, useFolder } from '../sync/harness'
import { makePng } from '../printing/fixtures'
import type { BusinessProfileService } from '../../src/main/modules/businessProfile/service'

afterEach(cleanup)

const val = (p: { app: import('../../src/main/core/app').App }, sql: string, ...a: (string | number)[]) => p.app.db.value<number | string>(sql, ...a)

describe('sync apply <-> businessProfile (real PNG logo, via applySynced / applySyncedLogo)', () => {
  it('shop name + validated logo reach the other terminal; print bytes are produced by the profile service', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'vsync-folder-'))
    const p1 = makePos('POS-01')
    const p2 = makePos('POS-02')
    useFolder(p1, folder)
    useFolder(p2, folder)
    await settle([p1, p2])

    const png = makePng(40, 20)
    p1.app.get<BusinessProfileService>('businessProfile').save({ shopName: 'Seam Crackers', displayName: 'Seam Crackers' })
    p1.app.get<BusinessProfileService>('businessProfile').setLogo({ data: png.toString('base64') })
    await settle([p1, p2])

    const bp2 = p2.app.get<BusinessProfileService>('businessProfile').getActive()
    expect(bp2.shopName).toBe('Seam Crackers')
    expect(bp2.logoAssetId).not.toBeNull()
    expect(val(p2, 'SELECT COUNT(*) FROM business_profile_versions WHERE is_active = 1')).toBe(1)
    // logo went through the profile service (it generates print_bytes); a raw insert would leave them NULL
    expect(val(p2, 'SELECT COUNT(*) FROM logo_assets WHERE print_bytes IS NULL')).toBe(0)
    expect(val(p2, 'SELECT COUNT(*) FROM logo_assets')).toBeGreaterThan(0)
  })
})

describe('sync apply: op=delete for catalog entities', () => {
  it('unused product / category / brand deleted on POS-1 are deleted on POS-2; used ones are only deactivated', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'vsync-folder-'))
    const p1 = makePos('POS-01')
    const p2 = makePos('POS-02')
    useFolder(p1, folder)
    useFolder(p2, folder)
    const cat = (await p1.app.call('catalog', 'saveCategory', { name: 'Fountains' })) as { id: number }
    const brand = (await p1.app.call('catalog', 'saveBrand', { name: 'Standard' })) as { id: number }
    const keep = (await p1.app.call('catalog', 'saveCategory', { name: 'Keepers' })) as { id: number }
    const prod = addProduct(p1.app, { name: 'Gone Soon', sku: 'GONE1', price: 1000 })
    addProduct(p1.app, { name: 'Stays', sku: 'STAY1', price: 1000 })
    await settle([p1, p2])
    expect(val(p2, "SELECT COUNT(*) FROM categories WHERE name = 'Fountains'")).toBe(1)
    expect(val(p2, "SELECT COUNT(*) FROM brands WHERE name = 'Standard'")).toBe(1)
    expect(val(p2, "SELECT COUNT(*) FROM products WHERE name = 'Gone Soon'")).toBe(1)

    // POS-2 uses "Keepers" in a product, so a remote delete must not break it
    const keepUuid = val(p1, 'SELECT uuid FROM categories WHERE id = ?', keep.id)
    const keepLocal = val(p2, 'SELECT id FROM categories WHERE uuid = ?', keepUuid as string)
    p2.app.db.run("INSERT INTO products(uuid,name,category_id) VALUES (?,?,?)", p2.app.uuid(), 'Local user of Keepers', keepLocal as number)

    await p1.app.call('catalog', 'deleteCategory', { id: cat.id })
    await p1.app.call('catalog', 'deleteBrand', { id: brand.id })
    await p1.app.call('catalog', 'deleteCategory', { id: keep.id })
    await p1.app.call('catalog', 'remove', { id: prod.productId })
    await settle([p1, p2])

    expect(val(p1, "SELECT COUNT(*) FROM categories WHERE name = 'Fountains'")).toBe(0)
    expect(val(p2, "SELECT COUNT(*) FROM categories WHERE name = 'Fountains'")).toBe(0)
    expect(val(p2, "SELECT COUNT(*) FROM brands WHERE name = 'Standard'")).toBe(0)
    expect(val(p2, "SELECT COUNT(*) FROM products WHERE name = 'Gone Soon'")).toBe(0)
    expect(val(p2, "SELECT COUNT(*) FROM product_variants WHERE sku = 'GONE1'")).toBe(0)
    expect(val(p2, "SELECT COUNT(*) FROM products WHERE name = 'Stays'")).toBe(1)
    // still referenced locally -> kept (deactivated), product untouched
    expect(val(p2, "SELECT active FROM categories WHERE name = 'Keepers'")).toBe(0)
    expect(val(p2, "SELECT COUNT(*) FROM products WHERE name = 'Local user of Keepers'")).toBe(1)
  })
})

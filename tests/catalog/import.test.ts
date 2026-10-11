import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestApp } from '../helpers'
import type { App } from '../../src/main/core/app'
import { parseTable } from '../../src/main/modules/catalog/io'

let app: App
const call = <T = any>(m: string, a?: unknown) => app.call('catalog', m, a) as Promise<T>
const csv = (text: string, filename = 'products.csv') => ({ bytesBase64: Buffer.from(text, 'utf8').toString('base64'), filename })
const H = 'Name,Variant,SKU,Barcode,Alias Barcodes,Category,Brand,HSN,GST %,Unit,MRP,Price,Cost,Reorder Level,Opening Stock,Active,Track Stock,Description'

beforeEach(() => {
  app = createTestApp()
})

describe('import preview', () => {
  it('reports per-row errors and warnings and counts creates/updates', async () => {
    await call('save', { name: 'Existing', variants: [{ sku: 'EX-1', barcode: '4006381333931', price: 100 }] })
    const text = [
      H,
      'Good One,,G-1,,,Toys,Acme,9503,18,pcs,120,100,60,2,10,Yes,Yes,',
      ',,G-2,,,,,,18,,,50,,,,,,', // missing name
      'Bad GST,,G-3,,,,,,abc,,,50,,,,,,',
      'Huge GST,,G-4,,,,,,150,,,50,,,,,,',
      'Odd GST,,G-5,,,,,,7,,,50,,,,,,',
      'Neg Price,,G-6,,,,,,18,,,-5,,,,,,',
      'Mrp Low,,G-7,,,,,,18,,40,50,,,,,,',
      'Dup A,,G-8,5901234123457,,,,,18,,,50,,,,,,',
      'Dup B,,G-9,5901234123457,,,,,18,,,50,,,,,,',
      'Dup SKU,,G-1,,,,,,18,,,50,,,,,,',
      'Used Code,,G-10,4006381333931,,,,,18,,,50,,,,,,',
      'Bad Check,,G-11,4006381333932,,,,,18,,,50,,,,,,',
      'Update Me,,EX-1,,,,,,18,,,150,,,,,,',
      'Bad Qty,,G-12,,,,,,18,,,50,,,2.5,,,'
    ].join('\n')
    const p = await call('importPreview', csv(text))
    expect(p.counts.total).toBe(14)
    expect(p.counts.creates).toBe(4) // Good One, Odd GST, Mrp Low, Dup A
    expect(p.counts.updates).toBe(1)
    expect(p.counts.invalid).toBe(9)
    expect(p.canCommit).toBe(true)
    const byRow = (n: number) => p.issues.find((i: any) => i.rowNo === n)
    expect(byRow(3).errors.join()).toMatch(/Name is missing/)
    expect(byRow(4).errors.join()).toMatch(/GST rate "abc"/)
    expect(byRow(5).errors.join()).toMatch(/GST rate "150"/)
    expect(byRow(6).errors).toEqual([])
    expect(byRow(6).warnings.join()).toMatch(/standard slab/)
    expect(byRow(7).errors.join()).toMatch(/negative/)
    expect(byRow(8).warnings.join()).toMatch(/MRP is lower/)
    expect(byRow(10).errors.join()).toMatch(/Duplicate barcode/)
    expect(byRow(11).errors.join()).toMatch(/Duplicate SKU/)
    expect(byRow(12).errors.join()).toMatch(/already belongs to "Existing"/)
    expect(byRow(13).errors.join()).toMatch(/check digit/)
    expect(byRow(15).errors.join()).toMatch(/whole number/)
    expect(p.counts.newCategories).toBe(1)
    expect(p.counts.newBrands).toBe(1)
    // preview never writes
    expect(app.db.value('SELECT COUNT(*) FROM products')).toBe(1)
    expect(app.db.value('SELECT COUNT(*) FROM categories')).toBe(0)
  })

  it('auto-maps differently named columns and honours explicit mapping', async () => {
    const text = 'Item Name,Selling Price,Item Code,Stock\nPen,10.50,PEN-1,20\n'
    const p = await call('importPreview', csv(text))
    expect(p.mapping).toMatchObject({ name: 0, price: 1, sku: 2, opening: 3 })
    expect(p.counts.creates).toBe(1)
    const noName = await call('importPreview', csv('A,B\n1,2\n'))
    expect(noName.canCommit).toBe(false)
    const mapped = await call('importPreview', { ...csv('A,B\nPen,10\n'), mapping: { name: 0, price: 1 } })
    expect(mapped.counts.creates).toBe(1)
    const c = await call('importCommit', { ...csv('A,B\nPen,10\n'), mapping: { name: 0, price: 1 } })
    expect(c.created).toBe(1)
    expect(app.db.value("SELECT price FROM product_variants WHERE sku LIKE 'SKU-%'")).toBe(1000)
  })
})

describe('import commit', () => {
  it('creates products, categories (paths), brands, variants, aliases and opening stock', async () => {
    const text = [
      H,
      'Shirt,M,SH-M,,,Apparel > Shirts,Acme,6205,12,pcs,999,799,500,5,20,Yes,Yes,Nice',
      'Shirt,L,SH-L,,A-L1;A-L2,Apparel > Shirts,Acme,6205,12,pcs,999.50,799.99,500,5,10,Yes,Yes,',
      'Notebook,,NB,4006381333931,,Stationery,,4820,5,pcs,60,50,35,10,100,No,Yes,',
      'Service Fee,,SVC,,,,,,18,nos,0,250,0,0,50,Yes,No,'
    ].join('\n')
    const r = await call('importCommit', csv(text))
    expect(r).toMatchObject({ created: 4, updated: 0, skipped: 0 })
    expect(app.db.value('SELECT COUNT(*) FROM products')).toBe(3)
    expect(app.db.value('SELECT COUNT(*) FROM product_variants')).toBe(4)
    expect(app.db.get<any>("SELECT c.name, p.name AS parent FROM categories c JOIN categories p ON p.id = c.parent_id WHERE c.name='Shirts'")).toEqual({ name: 'Shirts', parent: 'Apparel' })
    expect(app.db.value('SELECT COUNT(*) FROM brands')).toBe(1)
    const l = app.lookup.byCode('SH-L')!
    expect(l).toMatchObject({ mrp: 99950, price: 79999, taxRateBp: 1200, stock: 10 })
    expect(app.lookup.byCode('A-L2')?.variantId).toBe(l.variantId)
    expect(app.lookup.byCode('NB')?.active).toBe(false)
    expect(app.lookup.byCode('4006381333931')?.productName).toBe('Notebook')
    // untracked product: stock not posted
    expect(app.lookup.byCode('SVC')?.stock).toBe(0)
    expect(app.db.value("SELECT COUNT(*) FROM stock_movements WHERE type='opening'")).toBe(3)
    expect(app.db.value("SELECT COUNT(*) FROM audit_log WHERE entity='catalog' AND action='import'")).toBe(1)
    expect(app.db.value("SELECT COUNT(*) FROM sync_queue WHERE entity='products'")).toBeGreaterThanOrEqual(3)
    // product-level grouping: both shirts share one product
    expect(app.lookup.byCode('SH-M')?.productId).toBe(l.productId)
  })

  it('upserts by SKU and by barcode; unchanged rows are not rewritten', async () => {
    await call('save', { name: 'Old Name', variants: [{ sku: 'U-1', barcode: '4006381333931', price: 100, mrp: 120, cost: 60 }] })
    const text = [H, 'New Name,,U-1,,,,,,18,,150,125,,,,,,', 'Whatever,,,4006381333931,,,,,,,,130,,,,,,'].join('\n')
    const p = await call('importPreview', csv(text))
    expect(p.counts).toMatchObject({ creates: 0, updates: 2 })
    const r = await call('importCommit', csv(text))
    expect(r).toMatchObject({ created: 0, updated: 2 })
    expect(app.lookup.byCode('U-1')).toMatchObject({ productName: 'Whatever', price: 13000, mrp: 15000, cost: 60 })
    expect(app.db.value('SELECT COUNT(*) FROM products')).toBe(1)
    expect(app.db.value("SELECT COUNT(*) FROM audit_log WHERE action='price_change'")).toBe(2)
    const again = await call('importCommit', csv([H, 'Whatever,,U-1,,,,,,18,,150,130,0.60,,,,,'].join('\n')))
    expect(again).toMatchObject({ created: 0, updated: 0, unchanged: 1 })
    // opening stock column does not touch existing items
    await call('importCommit', csv([H, 'Whatever,,U-1,,,,,,,,,,,,500,,,'].join('\n')))
    expect(app.db.value('SELECT COUNT(*) FROM stock_movements')).toBe(0)
  })

  it('all-or-nothing refuses when any row is bad and writes nothing', async () => {
    const text = [H, 'Ok,,A-1,,,Cat,Brand,,18,,,10,,,,,,', 'Bad,,A-2,,,,,,abc,,,10,,,,,,'].join('\n')
    await expect(call('importCommit', csv(text))).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(app.db.value('SELECT COUNT(*) FROM products')).toBe(0)
    expect(app.db.value('SELECT COUNT(*) FROM categories')).toBe(0)
    expect(app.db.value('SELECT COUNT(*) FROM sync_queue')).toBe(0)
  })

  it('skip-bad-rows commits only the good rows', async () => {
    const text = [H, 'Ok,,A-1,,,Cat,Brand,,18,,,10,,,,,,', 'Bad,,A-2,,,,,,abc,,,10,,,,,,', 'Ok2,,A-3,,,,,,18,,,10,,,,,,'].join('\n')
    const r = await call('importCommit', { ...csv(text), mode: 'skip_bad_rows' })
    expect(r).toMatchObject({ created: 2, skipped: 1 })
    expect(r.errors[0].rowNo).toBe(3)
    expect(app.db.value('SELECT COUNT(*) FROM products')).toBe(2)
  })

  it('rolls back everything when a failure happens mid-commit', async () => {
    app.db.run('DELETE FROM locations') // opening stock on the 2nd row cannot be posted -> runtime failure
    const text = [H, 'First,,R-1,,,NewCat,NewBrand,,18,,,10,,,,,,', 'Second,,R-2,,,,,,18,,,10,,,5,,,'].join('\n')
    const pv = await call('importPreview', csv(text))
    expect(pv.counts.invalid).toBe(0)
    await expect(call('importCommit', { ...csv(text), mode: 'skip_bad_rows' })).rejects.toBeTruthy()
    expect(app.db.value('SELECT COUNT(*) FROM products')).toBe(0)
    expect(app.db.value('SELECT COUNT(*) FROM categories')).toBe(0)
    expect(app.db.value('SELECT COUNT(*) FROM brands')).toBe(0)
    expect(app.db.value('SELECT COUNT(*) FROM audit_log WHERE entity IN (?, ?)', 'product', 'category')).toBe(0)
    expect(app.db.value('SELECT COUNT(*) FROM sync_queue')).toBe(0)
  })

  it('handles quoted CSV cells, BOM and CRLF', async () => {
    const text = '﻿Name,SKU,Price\r\n"Rope, 10m ""Heavy""",ROPE,"1,250.00"\r\n'
    await call('importCommit', csv(text))
    expect(app.lookup.byCode('ROPE')).toMatchObject({ productName: 'Rope, 10m "Heavy"', price: 125000 })
  })
})

describe('export / template / round trip', () => {
  const seed = async () => {
    await call('importCommit', csv([
      H,
      'Shirt,M,SH-M,,,Apparel > Shirts,Acme,6205,12,pcs,999,799,500,5,,Yes,Yes,"Nice, soft"',
      'Shirt,L,SH-L,4006381333931,A-L1;A-L2,Apparel > Shirts,Acme,6205,12,pcs,999.50,799.99,500,5,,Yes,Yes,',
      'Old Item,,OLD,,,Misc,,0005,0,pcs,10,8,5,0,,No,Yes,',
      'Loose Rope,,ROPE,,,,,,2.5,m,100,90,50,0,,Yes,No,'
    ].join('\n')))
  }
  const asRows = async (res: { bytesBase64?: string; filename: string }) => {
    const t = await parseTable(Buffer.from(res.bytesBase64!, 'base64'), res.filename)
    return t.rows
  }

  it('CSV round trip: export -> import into a fresh DB -> export is identical; re-import is a no-op', async () => {
    await seed()
    const a = await call('exportFile', { format: 'csv' })
    const rowsA = await asRows(a)
    expect(rowsA).toHaveLength(4)
    const noop = await call('importPreview', { bytesBase64: a.bytesBase64, filename: a.filename })
    expect(noop.counts).toMatchObject({ creates: 0, updates: 0, unchanged: 4, invalid: 0 })

    const app2 = createTestApp()
    const r = await app2.call('catalog', 'importCommit', { bytesBase64: a.bytesBase64, filename: a.filename })
    expect(r).toMatchObject({ created: 4, skipped: 0 })
    const b = (await app2.call('catalog', 'exportFile', { format: 'csv' })) as any
    expect(await asRows(b)).toEqual(rowsA)
    expect(app2.lookup.byCode('A-L2')?.displayName).toBe('Shirt - L')
    expect(app2.lookup.byCode('OLD')?.active).toBe(false)
    expect(app2.lookup.byCode('ROPE')?.taxRateBp).toBe(250)
  })

  it('XLSX round trip keeps leading-zero HSN, barcodes, decimals and variants', async () => {
    await seed()
    const a = await call('exportFile', { format: 'xlsx' })
    expect(Buffer.from(a.bytesBase64, 'base64').subarray(0, 2).toString()).toBe('PK')
    const rowsA = await asRows(a)
    expect(rowsA).toHaveLength(4)
    expect(await call('importPreview', { bytesBase64: a.bytesBase64, filename: a.filename }).then((p: any) => p.counts)).toMatchObject({
      unchanged: 4, creates: 0, updates: 0, invalid: 0
    })
    const app2 = createTestApp()
    await app2.call('catalog', 'importCommit', { bytesBase64: a.bytesBase64, filename: 'x.xlsx' })
    expect(app2.lookup.byCode('OLD')).toMatchObject({ hsn: '0005', taxRateBp: 0, active: false })
    expect(app2.lookup.byCode('4006381333931')).toMatchObject({ price: 79999, mrp: 99950, variantName: 'L' })
    const b = (await app2.call('catalog', 'exportFile', { format: 'xlsx' })) as any
    expect(await asRows(b)).toEqual(rowsA)
  })

  it('exports with stock when asked and writes to a given path', async () => {
    await call('save', { name: 'Stocked', variants: [{ sku: 'ST', openingStock: 7 }] })
    const dir = mkdtempSync(join(tmpdir(), 'cat-exp-'))
    const out = await call('exportFile', { format: 'csv', path: join(dir, 'out.csv'), includeStock: true })
    expect(out.path).toBe(join(dir, 'out.csv'))
    expect(readFileSync(out.path, 'utf8')).toContain(',7,Yes,Yes,')
    const back = await call('importPreview', { path: out.path })
    expect(back.counts.unchanged + back.counts.updates).toBe(1)
  })

  it('provides an import template (CSV and XLSX) that previews cleanly', async () => {
    for (const format of ['csv', 'xlsx'] as const) {
      const t = await call('templateFile', { format })
      expect(t.filename).toBe(`product-import-template.${format}`)
      const p = await call('importPreview', { bytesBase64: t.bytesBase64, filename: t.filename })
      expect(p.counts).toMatchObject({ total: 3, creates: 3, invalid: 0 })
      expect(p.headers).toHaveLength(18)
    }
  })
})

import { describe, it, expect } from 'vitest'
import { createTestApp } from '../helpers'

const call = <T = any>(app: ReturnType<typeof createTestApp>, m: string, a?: unknown) => app.call('catalog', m, a) as Promise<T>

describe('performance sanity', () => {
  it('commits a 5,000-row import in about 10 s or less', async () => {
    const app = createTestApp()
    const lines = ['Name,Variant,SKU,Barcode,Category,Brand,HSN,GST %,MRP,Price,Cost,Opening Stock']
    for (let i = 1; i <= 5000; i++)
      lines.push(`Item ${i},,IMP-${i},,Cat ${i % 20},Brand ${i % 10},3604,18,${100 + i},${90 + i},${50 + i},${i % 50}`)
    const file = { bytesBase64: Buffer.from(lines.join('\n')).toString('base64'), filename: 'big.csv' }
    const t0 = performance.now()
    const preview = await call(app, 'importPreview', file)
    const tPreview = performance.now() - t0
    expect(preview.counts).toMatchObject({ creates: 5000, invalid: 0 })
    const t1 = performance.now()
    const r = await call(app, 'importCommit', file)
    const tCommit = performance.now() - t1
    console.log(`import 5000 rows: preview ${Math.round(tPreview)} ms, commit ${Math.round(tCommit)} ms`)
    expect(r.created).toBe(5000)
    expect(app.db.value('SELECT COUNT(*) FROM products')).toBe(5000)
    // target ~10 s on an idle machine (measured ~6-10 s while 9 other agents were running tests); hard-fail guard is looser to avoid CI flake
    expect(tCommit).toBeLessThan(15_000)
    // re-import is a pure no-op (unchanged) and fast
    const t2 = performance.now()
    const again = await call(app, 'importCommit', file)
    expect(again).toMatchObject({ created: 0, updated: 0 })
    console.log(`re-import 5000 unchanged rows: ${Math.round(performance.now() - t2)} ms`)
  }, 120_000)

  it('searches 20,000 products in under 100 ms', async () => {
    const app = createTestApp()
    app.db.transaction(() => {
      for (let i = 1; i <= 20000; i++) {
        const p = app.db.run('INSERT INTO products(uuid,name) VALUES (?,?)', `p${i}`, `Product number ${i} crackers`)
        app.db.run('INSERT INTO product_variants(uuid,product_id,sku,barcode,price) VALUES (?,?,?,?,?)', `v${i}`, p.lastId, `S-${i}`, `BC${i}`, 100)
      }
    })
    const time = async (args: unknown) => {
      const t = performance.now()
      const r = await call(app, 'list', args)
      return { ms: performance.now() - t, r }
    }
    await time({ search: 'warmup' })
    for (const args of [
      { search: 'number 12345 crackers' }, { search: 'S-19999' }, { search: 'BC777' }, { search: 'nomatchatall' }, { limit: 50, offset: 10000 }, { noBarcode: true }, { lowStock: true }
    ]) {
      const { ms, r } = await time(args)
      console.log(`list ${JSON.stringify(args)} -> ${r.total} rows in ${ms.toFixed(1)} ms`)
      expect(ms).toBeLessThan(100)
    }
    expect((await time({ search: 'S-19999' })).r.total).toBe(1)
    const t = performance.now()
    app.lookup.byCode('S-15000')
    app.lookup.byCode('BC15000')
    expect(performance.now() - t).toBeLessThan(50)
  }, 120_000)
})

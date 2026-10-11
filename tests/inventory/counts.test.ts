import { describe, expect, it } from 'vitest'
import { makeCategory, makeVariant, newApp, qtyAt, rejects } from './fixtures'

describe('stock counts', () => {
  it('snapshots expected qty, supports category filter and scan entry', async () => {
    const app = newApp()
    const cat = makeCategory(app, 'Crackers')
    const a = makeVariant(app, { qty: 10, categoryId: cat })
    makeVariant(app, { qty: 4 })
    const full: any = await app.call('inventory', 'countCreate', {})
    expect(full.items).toBe(2)
    const part: any = await app.call('inventory', 'countCreate', { categoryId: cat })
    expect(part.items).toBe(1)
    expect(part.number).toMatch(/^CNT-\d{4}-\d{6}$/)

    const barcode = app.db.value<string>('SELECT barcode FROM product_variants WHERE id=?', a)!
    await app.call('inventory', 'countScan', { countId: part.id, code: barcode })
    const s: any = await app.call('inventory', 'countScan', { countId: part.id, code: barcode, qty: 2 })
    expect(s.countedQty).toBe(3)
    expect(s.expectedQty).toBe(10)
    expect(s.variance).toBe(-7)
    const set: any = await app.call('inventory', 'countScan', { countId: part.id, code: barcode, qty: 9, mode: 'set' })
    expect(set.countedQty).toBe(9)
    await rejects(app.call('inventory', 'countScan', { countId: part.id, code: 'NOPE' }), 'NOT_FOUND')
    // a product outside the filtered sheet cannot be scanned in
    const other = makeVariant(app, { qty: 1 })
    const ob = app.db.value<string>('SELECT barcode FROM product_variants WHERE id=?', other)!
    await rejects(app.call('inventory', 'countScan', { countId: part.id, code: ob }), 'NOT_FOUND')
  })

  it('apply writes count movements for differences only, in one go, then is immutable', async () => {
    const app = newApp()
    const a = makeVariant(app, { qty: 10 })
    const b = makeVariant(app, { qty: 10 })
    const c = makeVariant(app, { qty: 10 })
    const d = makeVariant(app, { qty: 10 })
    const cnt: any = await app.call('inventory', 'countCreate', {})
    await app.call('inventory', 'countSet', {
      countId: cnt.id,
      entries: [{ variantId: a, countedQty: 10 }, { variantId: b, countedQty: 7 }, { variantId: c, countedQty: 13 }] // d uncounted
    })
    const g: any = await app.call('inventory', 'countGet', { id: cnt.id })
    expect(g.summary).toMatchObject({ items: 4, counted: 3, uncounted: 1, varianceItems: 2, surplusQty: 3, shortageQty: 3 })
    expect(((await app.call('inventory', 'countGet', { id: cnt.id, filter: 'variance' })) as any).items).toHaveLength(2)

    const before = app.db.value<number>('SELECT COUNT(*) FROM stock_movements')!
    // a sale happens during counting; the count variance is applied on top of it
    app.moveStock({ variantId: b, delta: -1, type: 'sale' })
    const r: any = await app.call('inventory', 'countApply', { countId: cnt.id })
    expect(r).toEqual({ adjusted: 2, uncounted: 1 })
    expect(app.db.value<number>("SELECT COUNT(*) FROM stock_movements WHERE type='count'")).toBe(2)
    expect(app.db.value<number>('SELECT COUNT(*) FROM stock_movements')).toBe(before + 3)
    expect(qtyAt(app, a)).toBe(10)
    expect(qtyAt(app, b)).toBe(6) // 10 - 1 sale - 3 variance
    expect(qtyAt(app, c)).toBe(13)
    expect(qtyAt(app, d)).toBe(10)

    expect(((await app.call('inventory', 'countGet', { id: cnt.id })) as any).status).toBe('applied')
    await rejects(app.call('inventory', 'countApply', { countId: cnt.id }), 'CONFLICT')
    await rejects(app.call('inventory', 'countSet', { countId: cnt.id, entries: [{ variantId: a, countedQty: 1 }] }), 'CONFLICT')
    await rejects(app.call('inventory', 'countScan', { countId: cnt.id, code: 'x' }), 'CONFLICT')
    await rejects(app.call('inventory', 'countCancel', { countId: cnt.id }), 'CONFLICT')
    expect(app.db.value<number>('SELECT COUNT(*) FROM audit_log WHERE entity=? AND action=?', 'stock_count', 'apply')).toBe(1)
    expect(app.db.value<number>("SELECT COUNT(*) FROM sync_queue WHERE entity='stock_counts'")).toBeGreaterThanOrEqual(3)
  })

  it('apply is atomic: a failing line rolls everything back and leaves the count open', async () => {
    const app = newApp()
    const a = makeVariant(app, { qty: 5 })
    const b = makeVariant(app, { qty: 5 })
    const cnt: any = await app.call('inventory', 'countCreate', {})
    await app.call('inventory', 'countSet', { countId: cnt.id, entries: [{ variantId: a, countedQty: 9 }, { variantId: b, countedQty: 0 }] })
    app.moveStock({ variantId: b, delta: -5, type: 'sale' }) // b is now 0, count wants -5 more
    await rejects(app.call('inventory', 'countApply', { countId: cnt.id }), 'INSUFFICIENT_STOCK')
    expect(qtyAt(app, a)).toBe(5)
    expect(((await app.call('inventory', 'countGet', { id: cnt.id })) as any).status).toBe('open')
  })

  it('cancel makes a count immutable without touching stock', async () => {
    const app = newApp()
    const a = makeVariant(app, { qty: 5 })
    const cnt: any = await app.call('inventory', 'countCreate', {})
    await app.call('inventory', 'countSet', { countId: cnt.id, entries: [{ variantId: a, countedQty: 1 }] })
    await app.call('inventory', 'countCancel', { countId: cnt.id })
    expect(qtyAt(app, a)).toBe(5)
    await rejects(app.call('inventory', 'countApply', { countId: cnt.id }), 'CONFLICT')
    expect(((await app.call('inventory', 'countList', { status: 'cancelled' })) as any).total).toBe(1)
  })
})

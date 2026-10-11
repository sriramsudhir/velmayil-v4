import { describe, expect, it } from 'vitest'
import { actAs } from '../helpers'
import { makeCategory, makeLocation, makeVariant, newApp, qtyAt, rejects, totalStock } from './fixtures'

describe('stock queries', () => {
  it('lists stock with search, category, status filters and pagination', async () => {
    const app = newApp()
    const cat = makeCategory(app, 'Sparklers')
    const a = makeVariant(app, { name: 'Rocket', categoryId: cat, qty: 50, reorder: 10, cost: 200 })
    const b = makeVariant(app, { name: 'Flower Pot', categoryId: cat, qty: 5, reorder: 10, cost: 300 })
    const c = makeVariant(app, { name: 'Chakra', qty: 0, reorder: 0 })
    makeVariant(app, { name: 'Service', track: 0 })

    const all: any = await app.call('inventory', 'stock', {})
    expect(all.total).toBe(3) // untracked product excluded
    expect(all.totalQty).toBe(55)
    expect(all.totalValue).toBe(50 * 200 + 5 * 300)

    expect(((await app.call('inventory', 'stock', { search: 'rock' })) as any).rows.map((r: any) => r.variantId)).toEqual([a])
    expect(((await app.call('inventory', 'stock', { categoryId: cat })) as any).total).toBe(2)
    expect(((await app.call('inventory', 'stock', { status: 'low' })) as any).rows.map((r: any) => r.variantId)).toEqual([b])
    expect(((await app.call('inventory', 'stock', { status: 'out' })) as any).rows.map((r: any) => r.variantId)).toEqual([c])
    const p1: any = await app.call('inventory', 'stock', { limit: 2, offset: 0 })
    const p2: any = await app.call('inventory', 'stock', { limit: 2, offset: 2 })
    expect(p1.rows).toHaveLength(2)
    expect(p2.rows).toHaveLength(1)
    expect(p1.total).toBe(3)
  })

  it('filters by location', async () => {
    const app = newApp()
    const loc2 = makeLocation(app, 'Godown')
    const v = makeVariant(app, { qty: 10 })
    app.moveStock({ variantId: v, delta: 7, type: 'opening', locationId: loc2 })
    expect(((await app.call('inventory', 'stock', { locationId: loc2 })) as any).rows[0].qty).toBe(7)
    expect(((await app.call('inventory', 'stock', { locationId: app.defaultLocationId() })) as any).rows[0].qty).toBe(10)
    expect(((await app.call('inventory', 'stock', {})) as any).rows[0].qty).toBe(17)
  })

  it('low stock list and counts use reorder_level', async () => {
    const app = newApp()
    makeVariant(app, { qty: 3, reorder: 5 })
    makeVariant(app, { qty: 0, reorder: 5 })
    makeVariant(app, { qty: 100, reorder: 5 })
    makeVariant(app, { qty: 1, reorder: 0 }) // no reorder level -> never "low"
    const low: any = await app.call('inventory', 'lowStock', {})
    expect(low.total).toBe(2)
    expect(low.rows.every((r: any) => r.suggestedQty >= 1)).toBe(true)
    expect(await app.call('inventory', 'lowStockCount', {})).toEqual({ low: 2, out: 1 })
  })

  it('valuation sums qty*cost and requires cost permission', async () => {
    const app = newApp()
    const cat = makeCategory(app, 'C')
    makeVariant(app, { qty: 10, cost: 500, categoryId: cat })
    makeVariant(app, { qty: 2, cost: 1000 })
    const v: any = await app.call('inventory', 'valuation', {})
    expect(v.totalValue).toBe(5000 + 2000)
    expect(v.totalQty).toBe(12)
    expect(v.byCategory).toHaveLength(2)
    actAs(app, 'Cashier')
    await rejects(app.call('inventory', 'valuation', {}), 'FORBIDDEN')
    // cashier can view stock, but cost is masked
    const s: any = await app.call('inventory', 'stock', {})
    expect(s.rows[0].cost).toBeNull()
    expect(s.totalValue).toBeNull()
  })
})

describe('ledger', () => {
  it('returns movements with running balance and filters', async () => {
    const app = newApp()
    const v = makeVariant(app, { qty: 10 })
    app.moveStock({ variantId: v, delta: -3, type: 'sale' })
    app.moveStock({ variantId: v, delta: 5, type: 'purchase' })
    const l: any = await app.call('inventory', 'ledger', { variantId: v })
    expect(l.total).toBe(3)
    expect(l.rows.map((r: any) => r.running)).toEqual([12, 7, 10])
    expect(l.rows[0].balanceAfter).toBe(12)
    const sales: any = await app.call('inventory', 'ledger', { variantId: v, type: 'sale' })
    expect(sales.rows).toHaveLength(1)
    expect(sales.rows[0].running).toBe(7) // running balance is not distorted by filtering
    const none: any = await app.call('inventory', 'ledger', { variantId: v, from: Date.now() + 100000 })
    expect(none.rows).toHaveLength(0)
  })
})

describe('adjustments', () => {
  it('increases and decreases with a reason, writing ledger + audit + sync', async () => {
    const app = newApp()
    const v = makeVariant(app, { qty: 10 })
    await app.call('inventory', 'adjust', { variantId: v, delta: -4, reason: 'damage', note: 'dropped' })
    await app.call('inventory', 'adjust', { variantId: v, delta: 2, reason: 'found' })
    expect(qtyAt(app, v)).toBe(8)
    const l: any = await app.call('inventory', 'ledger', { variantId: v, type: 'adjustment' })
    expect(l.rows).toHaveLength(2)
    expect(app.db.value<number>("SELECT COUNT(*) FROM audit_log WHERE entity='stock' AND action='adjust'")).toBe(2)
    expect(app.db.value<number>("SELECT COUNT(*) FROM sync_queue WHERE entity='stock_adjustments'")).toBe(2)
    const adj: any = await app.call('inventory', 'adjustments', {})
    expect(adj.total).toBe(2)
  })

  it('blocks going below zero, missing/invalid reasons and wrong direction', async () => {
    const app = newApp()
    const v = makeVariant(app, { qty: 3 })
    await rejects(app.call('inventory', 'adjust', { variantId: v, delta: -4, reason: 'theft' }), 'INSUFFICIENT_STOCK')
    await rejects(app.call('inventory', 'adjust', { variantId: v, delta: -1 }), 'VALIDATION')
    await rejects(app.call('inventory', 'adjust', { variantId: v, delta: -1, reason: 'because' }), 'VALIDATION')
    await rejects(app.call('inventory', 'adjust', { variantId: v, delta: 0, reason: 'correction' }), 'VALIDATION')
    await rejects(app.call('inventory', 'adjust', { variantId: v, delta: 1, reason: 'theft' }), 'VALIDATION')
    expect(qtyAt(app, v)).toBe(3)
    expect(app.db.value<number>('SELECT COUNT(*) FROM stock_adjustments')).toBe(0)
  })

  it('denies users without inventory.adjust', async () => {
    const app = newApp()
    const v = makeVariant(app, { qty: 3 })
    actAs(app, 'Cashier')
    await rejects(app.call('inventory', 'adjust', { variantId: v, delta: -1, reason: 'damage' }), 'FORBIDDEN')
    await rejects(app.call('inventory', 'countCreate', {}), 'FORBIDDEN')
    await rejects(app.call('inventory', 'transferCreate', { fromLocationId: 1, toLocationId: 2, items: [{ variantId: v, qty: 1 }] }), 'FORBIDDEN')
    expect(totalStock(app, v)).toBe(3)
    expect(((await app.call('inventory', 'stock', {})) as any).total).toBe(1) // view is allowed
  })
})

describe('transfers', () => {
  it('moves stock between locations atomically and conserves the total', async () => {
    const app = newApp()
    const loc2 = makeLocation(app, 'Godown')
    const a = makeVariant(app, { qty: 20 })
    const b = makeVariant(app, { qty: 5 })
    const main = app.defaultLocationId()
    const r: any = await app.call('inventory', 'transferCreate', { fromLocationId: main, toLocationId: loc2, items: [{ variantId: a, qty: 8 }, { variantId: b, qty: 5 }] })
    expect(r.number).toMatch(/^TRF-\d{4}-\d{6}$/)
    expect(qtyAt(app, a, main)).toBe(12)
    expect(qtyAt(app, a, loc2)).toBe(8)
    expect(totalStock(app, a)).toBe(20)
    expect(totalStock(app, b)).toBe(5)
    const t: any = await app.call('inventory', 'transferGet', { id: r.id })
    expect(t.items).toHaveLength(2)
    expect(app.db.value<number>("SELECT COUNT(*) FROM stock_movements WHERE type IN ('transfer_out','transfer_in')")).toBe(4)
    expect(app.db.value<number>("SELECT COUNT(*) FROM sync_queue WHERE entity='stock_transfers'")).toBe(1)
  })

  it('rolls back fully when a later line lacks stock; rejects same-location', async () => {
    const app = newApp()
    const loc2 = makeLocation(app, 'Godown')
    const a = makeVariant(app, { qty: 20 })
    const b = makeVariant(app, { qty: 1 })
    const main = app.defaultLocationId()
    await rejects(app.call('inventory', 'transferCreate', { fromLocationId: main, toLocationId: loc2, items: [{ variantId: a, qty: 8 }, { variantId: b, qty: 5 }] }), 'INSUFFICIENT_STOCK')
    expect(qtyAt(app, a, main)).toBe(20)
    expect(qtyAt(app, a, loc2)).toBe(0)
    expect(app.db.value<number>('SELECT COUNT(*) FROM stock_transfers')).toBe(0)
    await rejects(app.call('inventory', 'transferCreate', { fromLocationId: main, toLocationId: main, items: [{ variantId: a, qty: 1 }] }), 'VALIDATION')
  })
})

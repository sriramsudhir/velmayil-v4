import { beforeEach, describe, expect, it } from 'vitest'
import { actAs, createTestApp } from '../helpers'
import type { App } from '../../src/main/core/app'
import { CAT, INV, U, assertInvariant, availCodes, count, stockAt, statusOf } from '../units/helpers'

/** "Stock in hand" on the product screen: a wrong opening stock (or any wrong count) is put right, with an audit trail. */
let app: App
beforeEach(() => {
  app = createTestApp()
})

async function product(o: { qty: number; barcode?: string }) {
  const p = await CAT(app, 'save', { name: 'Chikoo & Bunny', variants: [{ name: '', barcode: o.barcode, price: 5000, mrp: 5000, cost: 2000, openingStock: o.qty }] })
  return p.variants[0].id as number
}
const setStock = (variantId: number, qty: number, expected: number) => INV(app, 'setStock', { variantId, qty, expected })

describe('stock in hand (opening stock correction)', () => {
  it('a plain product goes up and down; every change is a stock adjustment in the ledger', async () => {
    const v = await product({ qty: 2000 })
    expect(await setStock(v, 200, 2000)).toMatchObject({ delta: -1800, stock: 200, unitCodes: [] })
    expect(stockAt(app, v)).toBe(200)
    expect(await setStock(v, 250, 200)).toMatchObject({ delta: 50, stock: 250 })
    expect(stockAt(app, v)).toBe(250)
    expect(await setStock(v, 250, 250)).toMatchObject({ delta: 0 })
    const adj = (await INV(app, 'adjustments', { variantId: v })).rows as { qty_delta?: number; qtyDelta?: number; reason: string; note: string }[]
    expect(adj).toHaveLength(2)
    expect(adj.map((r) => r.reason).sort()).toEqual(['correction', 'found'])
    expect(adj.some((r) => /corrected from 2000 to 200/.test(r.note))).toBe(true)
    await assertInvariant(app)
  })
  it('the stock changed meanwhile (a sale on another screen): nothing is changed', async () => {
    const v = await product({ qty: 10 })
    await expect(setStock(v, 5, 12)).rejects.toMatchObject({ code: 'CONFLICT', details: { code: 'STOCK_CHANGED', stock: 10 } })
    expect(stockAt(app, v)).toBe(10)
  })
  it('only whole numbers, never negative; needs the stock adjustment permission', async () => {
    const v = await product({ qty: 10 })
    await expect(setStock(v, -1, 10)).rejects.toMatchObject({ code: 'VALIDATION' })
    actAs(app, 'Cashier')
    await expect(setStock(v, 5, 10)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(stockAt(app, v)).toBe(10)
  })
  it('label numbers: more stock gets new numbers; less stock removes pieces without a printed label first, then the newest numbers', async () => {
    const v = await product({ qty: 6, barcode: '200000555' })
    const printedCodes = (await U(app, 'issueLabels', { items: [{ variantId: v, count: 4 }] })).items[0].codes as string[] // 4 of 6 labelled
    const before = availCodes(app, v)
    const unlabelled = before.filter((c) => !printedCodes.includes(c))
    expect(unlabelled).toHaveLength(2)

    // down by 3: the 2 unlabelled pieces and the newest printed number
    const r = await setStock(v, 3, 6)
    expect(r.unitCodes).toHaveLength(3)
    expect(r.unitCodes).toEqual(expect.arrayContaining(unlabelled))
    expect(r.removedLabelled).toEqual([printedCodes[3]])
    for (const c of r.unitCodes) expect(statusOf(app, c)).toBe('void')
    expect(availCodes(app, v).sort()).toEqual(printedCodes.slice(0, 3).sort())
    expect(stockAt(app, v)).toBe(3)

    // up by 2: two new numbers
    const up = await setStock(v, 5, 3)
    expect(up.unitCodes).toHaveLength(2)
    expect(availCodes(app, v)).toHaveLength(5)
    expect(count(app, "SELECT COUNT(*) FROM product_units WHERE variant_id=? AND status IN ('in_stock','returned')", v)).toBe(5)
    await assertInvariant(app)
  })
})

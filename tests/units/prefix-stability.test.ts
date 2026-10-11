import { beforeEach, describe, expect, it } from 'vitest'
import { createTestApp } from '../helpers'
import type { App } from '../../src/main/core/app'
import { parseUnitCode } from '../../src/shared/scanList'
import { CAT, INV, POS, PUR, U, assertInvariant, cashSale, trackedProduct } from './helpers'

/**
 * Owner rule: for one product the unit-code PREFIX never changes; only the 4-digit suffix counts up by one, whatever
 * created the unit (opening stock, purchase, adjustment, backfill) and whatever happened to earlier units (sale, void, return).
 */
let app: App
beforeEach(() => {
  app = createTestApp()
})

const allCodes = (variantId: number) =>
  app.db.all<{ code: string }>('SELECT code FROM product_units WHERE variant_id = ? ORDER BY id', variantId).map((r) => r.code)
const prefixOf = (productId: number) => app.db.value<string>('SELECT unit_prefix FROM products WHERE id = ?', productId)

/** every code has the same prefix and the suffixes are exactly 1..n in creation order */
function expectRunning(codes: string[], prefix: string): void {
  expect(codes.length).toBeGreaterThan(0)
  codes.forEach((code, i) => {
    const u = parseUnitCode(code)
    expect(u, code).not.toBeNull()
    expect(u!.prefix).toBe(prefix)
    expect(u!.seq).toBe(i + 1)
    expect(code).toBe(`${prefix}-${String(i + 1).padStart(4, '0')}`)
  })
}

describe('one product: constant prefix, suffix +1', () => {
  it('across opening stock, purchases, adjustments, sales, voids, returns, write-offs, cancelled purchases and backfill', async () => {
    const p = await trackedProduct(app, { prefix: 'SPK', qty: 3 }) // opening stock: 0001-0003
    const v = p.variantId
    expect(allCodes(v)).toEqual(['SPK-0001', 'SPK-0002', 'SPK-0003'])

    const buy1 = await PUR(app, 'create', { items: [{ variantId: v, qty: 2, unitCost: 100 }] })
    expect(buy1.items[0].unitCodes).toEqual(['SPK-0004', 'SPK-0005'])
    expect((await INV(app, 'adjust', { variantId: v, delta: 1, reason: 'found' })).unitCodes).toEqual(['SPK-0006'])

    // selling, voiding the sale and returning units never frees or reuses a number
    const sale = await cashSale(app, [{ variantId: v, qty: 2, unitCodes: ['SPK-0001', 'SPK-0002'] }])
    await POS(app, 'voidSale', { saleId: sale.saleId, reason: 'mistake' })
    const sale2 = await cashSale(app, [{ variantId: v, qty: 2, unitCodes: ['SPK-0001', 'SPK-0004'] }])
    const item = (await POS(app, 'getSale', { id: sale2.saleId })).items[0]
    await POS(app, 'createReturn', { saleId: sale2.saleId, reason: 'returned', items: [{ saleItemId: item.id, qty: 1, unitCodes: ['SPK-0001'], restock: true }] })
    await POS(app, 'createReturn', { saleId: sale2.saleId, reason: 'broken', items: [{ saleItemId: item.id, qty: 1, unitCodes: ['SPK-0004'], restock: false }] })
    expect((await PUR(app, 'create', { items: [{ variantId: v, qty: 1, unitCost: 100 }] })).items[0].unitCodes).toEqual(['SPK-0007'])

    // write-off (void) and a decrease by adjustment: the numbers stay used
    await U(app, 'markVoid', { codes: ['SPK-0002'], reason: 'burnt in transit' })
    await INV(app, 'adjust', { variantId: v, delta: -1, reason: 'damage', unitCodes: ['SPK-0003'] })
    expect((await INV(app, 'adjust', { variantId: v, delta: 2, reason: 'correction' })).unitCodes).toEqual(['SPK-0008', 'SPK-0009'])

    // a cancelled purchase voids its units; the next purchase continues after them
    const buy2 = await PUR(app, 'create', { items: [{ variantId: v, qty: 2, unitCost: 100 }] })
    expect(buy2.items[0].unitCodes).toEqual(['SPK-0010', 'SPK-0011'])
    await PUR(app, 'cancel', { id: buy2.id, reason: 'wrong goods' })
    expect((await PUR(app, 'create', { items: [{ variantId: v, qty: 1, unitCost: 100 }] })).items[0].unitCodes).toEqual(['SPK-0012'])

    // stock received without codes, coded later (backfill through units.generate)
    await PUR(app, 'create', { items: [{ variantId: v, qty: 2, unitCost: 100 }], generateUnits: false })
    const g = await U(app, 'generate', { variantId: v, count: 2, reason: 'backfill' })
    expect(g).toMatchObject({ prefix: 'SPK', firstSeq: 13, lastSeq: 14, codes: ['SPK-0013', 'SPK-0014'] })

    // a failed operation gives its numbers back (no gap)
    await expect(PUR(app, 'create', { items: [{ variantId: v, qty: 2, unitCost: 100 }, { variantId: 999999, qty: 1, unitCost: 1 }] })).rejects.toBeTruthy()
    expect((await PUR(app, 'create', { items: [{ variantId: v, qty: 1, unitCost: 100 }] })).items[0].unitCodes).toEqual(['SPK-0015'])

    expectRunning(allCodes(v), 'SPK')
    expect(prefixOf(p.productId)).toBe('SPK')
    expect(app.db.value('SELECT last_seq FROM unit_sequences WHERE prefix = ?', 'SPK')).toBe(15)
    await assertInvariant(app)
  })

  it('turning tracking on later backfills existing stock with one prefix; off and on again keeps prefix and numbering', async () => {
    const saved = await CAT(app, 'save', { name: 'Flower Pot', variants: [{ name: '', price: 5000, cost: 2000, openingStock: 4 }] })
    const v = saved.variants[0].id as number
    const on = await U(app, 'setTracking', { productId: saved.id, trackUnits: true, prefix: 'fp' })
    expect(on.prefix).toBe('FP')
    expect(allCodes(v)).toEqual(['FP-0001', 'FP-0002', 'FP-0003', 'FP-0004'])
    await U(app, 'setTracking', { productId: saved.id, trackUnits: false, discardUnits: true })
    expect(prefixOf(saved.id)).toBe('FP') // remembered while tracking is off
    const again = await U(app, 'setTracking', { productId: saved.id, trackUnits: true }) // no prefix given
    expect(again.prefix).toBe('FP')
    expect(again.backfilled[0].codes).toEqual(['FP-0005', 'FP-0006', 'FP-0007', 'FP-0008'])
    expectRunning(allCodes(v), 'FP')
    await assertInvariant(app)
  })

  it('all variants of a product share its prefix and one running number', async () => {
    const saved = await CAT(app, 'save', {
      name: 'Rocket', trackUnits: true, unitPrefix: 'RKT',
      variants: [{ name: 'Small', price: 1000, cost: 500, openingStock: 2 }, { name: 'Large', price: 2000, cost: 900, openingStock: 1 }]
    })
    const [small, large] = saved.variants.map((x: any) => x.id as number)
    await PUR(app, 'create', { items: [{ variantId: large, qty: 1, unitCost: 100 }, { variantId: small, qty: 1, unitCost: 100 }] })
    const every = app.db.all<{ code: string }>('SELECT code FROM product_units ORDER BY id').map((r) => r.code)
    expectRunning(every, 'RKT')
    expect(allCodes(small)).toEqual(['RKT-0001', 'RKT-0002', 'RKT-0005'])
    expect(allCodes(large)).toEqual(['RKT-0003', 'RKT-0004'])
  })

  it('two products never share a prefix, and each keeps its own running number', async () => {
    const a = await trackedProduct(app, { name: 'Sparkler Box', prefix: null, qty: 2 })
    const b = await trackedProduct(app, { name: 'Sparkler Box', prefix: null, qty: 2 })
    expect(a.prefix).not.toBe(b.prefix)
    await PUR(app, 'create', { items: [{ variantId: b.variantId, qty: 1, unitCost: 1 }, { variantId: a.variantId, qty: 1, unitCost: 1 }] })
    expectRunning(allCodes(a.variantId), a.prefix!)
    expectRunning(allCodes(b.variantId), b.prefix!)
  })
})

describe('the prefix is never changed or re-suggested once set', () => {
  it('renaming the product keeps prefix and numbering', async () => {
    const p = await trackedProduct(app, { name: 'Sparkler Box', prefix: null, qty: 2 })
    const prefix = p.prefix!
    const d = await CAT(app, 'get', { id: p.productId })
    const body = (name: string, extra: Record<string, unknown> = {}) => ({ id: d.id, name, variants: [{ id: d.variants[0].id, name: '', price: 10000, cost: 5000 }], ...extra })
    // the form sends trackUnits + the prefix it shows; a price-list import / the spreadsheet send neither
    expect((await CAT(app, 'save', body('Golden Fountain Deluxe', { trackUnits: true, unitPrefix: prefix }))).unitPrefix).toBe(prefix)
    expect((await CAT(app, 'save', body('Zebra Crackers'))).unitPrefix).toBe(prefix)
    expect((await CAT(app, 'save', body('Mega Bomb', { trackUnits: true }))).unitPrefix).toBe(prefix)
    expect((await CAT(app, 'save', body('Mega Bomb', { trackUnits: true, unitPrefix: prefix.toLowerCase() }))).unitPrefix).toBe(prefix)
    await app.call('catalog', 'bulkUpdate', { rows: [{ variantId: d.variants[0].id, patch: { name: 'Renamed In Grid' } }] })
    expect(prefixOf(p.productId)).toBe(prefix)
    expect((await PUR(app, 'create', { items: [{ variantId: p.variantId, qty: 1, unitCost: 1 }] })).items[0].unitCodes).toEqual([`${prefix}-0003`])
    expectRunning(allCodes(p.variantId), prefix)
    // a different prefix is refused while codes exist; nothing changes
    await expect(CAT(app, 'save', body('Mega Bomb', { trackUnits: true, unitPrefix: 'MGB' }))).rejects.toMatchObject({ code: 'CONFLICT', details: { code: 'PREFIX_LOCKED' } })
    expect(prefixOf(p.productId)).toBe(prefix)
    expect((await CAT(app, 'get', { id: p.productId })).name).toBe('Renamed In Grid')
  })

  it('re-opening the product form (suggestPrefix with its id) proposes the product\'s own prefix, whatever the name is now', async () => {
    const p = await trackedProduct(app, { name: 'Sparkler Box', prefix: 'SPK', qty: 1 })
    for (const name of ['Sparkler Box', 'Golden Fountain', 'Zebra', 'X'])
      expect(await U(app, 'suggestPrefix', { name, productId: p.productId }), name).toEqual({ prefix: 'SPK' })
    // also right after tracking was turned on and before any unit exists
    const q = await trackedProduct(app, { name: 'Rocket', prefix: 'RKT' })
    expect(await U(app, 'suggestPrefix', { name: 'Completely Different', productId: q.productId })).toEqual({ prefix: 'RKT' })
    // a NEW product with the same name still gets a free prefix of its own
    const other = await U(app, 'suggestPrefix', { name: 'Sparkler Box' })
    expect(other.prefix).not.toBe('SPK')
    expect(other.prefix).toMatch(/^[A-Z0-9]{2,8}$/)
    // and the answer is repeatable
    expect(await U(app, 'suggestPrefix', { name: 'Sparkler Box' })).toEqual(other)
  })

  it('only when all 9999 codes are used does the product get (and get suggested) a new prefix', async () => {
    const p = await trackedProduct(app, { prefix: 'SPK', qty: 1 })
    app.db.run("UPDATE unit_sequences SET last_seq = 9999 WHERE prefix = 'SPK'")
    const s = await U(app, 'suggestPrefix', { name: 'Sparkler Box', productId: p.productId })
    expect(s.prefix).not.toBe('SPK')
    await U(app, 'setTracking', { productId: p.productId, trackUnits: true, prefix: s.prefix })
    expect((await PUR(app, 'create', { items: [{ variantId: p.variantId, qty: 2, unitCost: 1 }] })).items[0].unitCodes).toEqual([`${s.prefix}-0001`, `${s.prefix}-0002`])
    expect(allCodes(p.variantId)[0]).toBe('SPK-0001') // old labels keep their code
  })
})

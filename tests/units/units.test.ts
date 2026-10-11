import { beforeEach, describe, expect, it } from 'vitest'
import { actAs, createTestApp } from '../helpers'
import type { App } from '../../src/main/core/app'
import { createScanList } from '../../src/shared/scanList'
import { CAT, INV, POS, PUR, U, assertInvariant, availCodes, cashSale, count, plainProduct, stockAt, statusOf, trackedProduct, pipe } from './helpers'

let app: App
beforeEach(() => {
  app = createTestApp()
})

const buy = (variantId: number, qty: number, extra: Record<string, unknown> = {}) =>
  PUR(app, 'create', { items: [{ variantId, qty, unitCost: 1000 }], ...extra })

describe('prefix', () => {
  it('is unique across products (case-insensitive), validated, and suggested uniquely', async () => {
    await trackedProduct(app, { prefix: 'SPK' })
    await expect(trackedProduct(app, { name: 'Other', prefix: 'spk' })).rejects.toMatchObject({ code: 'CONFLICT', details: { code: 'PREFIX_TAKEN' } })
    await expect(trackedProduct(app, { name: 'Bad', prefix: 'A' })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(trackedProduct(app, { name: 'Bad2', prefix: 'AB-C' })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(trackedProduct(app, { name: 'Bad3', prefix: 'ABCDEFGHI' })).rejects.toMatchObject({ code: 'VALIDATION' })
    // failed saves left nothing behind
    expect(count(app, "SELECT COUNT(*) FROM products WHERE name IN ('Other','Bad','Bad2','Bad3')")).toBe(0)

    const a = await U(app, 'suggestPrefix', { name: 'Sparkler Box' })
    expect(a.prefix).toMatch(/^[A-Z0-9]{2,8}$/)
    const p1 = await trackedProduct(app, { name: 'Sparkler Box', prefix: null }) // auto-suggested
    const p2 = await trackedProduct(app, { name: 'Sparkler Box', prefix: null })
    const p3 = await trackedProduct(app, { name: 'Sparkler Box', prefix: null })
    expect(new Set([p1.prefix, p2.prefix, p3.prefix]).size).toBe(3)
    expect(p1.prefix).toBe(a.prefix)
  })

  it('the database itself refuses lower-case, duplicate and frozen prefixes', async () => {
    const p = await trackedProduct(app, { qty: 2 })
    expect(() => app.db.run("UPDATE products SET unit_prefix='low' WHERE id=?", p.productId)).toThrow()
    const other = app.db.run('INSERT INTO products(uuid,name) VALUES (?,?)', app.uuid(), 'Dup').lastId
    expect(() => app.db.run("UPDATE products SET unit_prefix='SPK', track_units=1 WHERE id=?", other)).toThrow(/UNIQUE|unit prefix/i)
    expect(() => app.db.run("UPDATE products SET unit_prefix='NEWP' WHERE id=?", p.productId)).toThrow(/cannot change/)
    expect(() => app.db.run('UPDATE products SET track_units=1, unit_prefix=NULL WHERE id=?', other)).toThrow()
  })

  it('refuses a prefix that collides with an existing barcode / alias / SKU namespace, and vice versa', async () => {
    await plainProduct(app, { name: 'Has barcode' })
    const v = app.db.value<number>('SELECT id FROM product_variants LIMIT 1')!
    app.db.run("UPDATE product_variants SET barcode='ZED-0001' WHERE id=?", v)
    await expect(trackedProduct(app, { name: 'Z', prefix: 'ZED' })).rejects.toMatchObject({ code: 'CONFLICT', details: { code: 'PREFIX_CLASH' } })
    app.db.run("INSERT INTO variant_barcodes(barcode,variant_id) VALUES ('YEL-0042',?)", v)
    await expect(trackedProduct(app, { name: 'Y', prefix: 'YEL' })).rejects.toMatchObject({ details: { code: 'PREFIX_CLASH' } })
    // the suggestion never proposes a clashing prefix
    const s = await U(app, 'suggestPrefix', { name: 'Zed' })
    expect(s.prefix).not.toBe('ZED')
    // an issued unit code can never be reused as a barcode / alias / sku
    const p = await trackedProduct(app, { prefix: 'ABC', qty: 1 })
    expect(() => app.db.run("UPDATE product_variants SET barcode='ABC-0001' WHERE id=?", v)).toThrow(/unit code/)
    expect(() => app.db.run("INSERT INTO variant_barcodes(barcode,variant_id) VALUES ('abc-0001',?)", v)).toThrow(/unit code/)
    expect(() => app.db.run("UPDATE product_variants SET sku='ABC-0001' WHERE id=?", v)).toThrow(/unit code/)
    expect(availCodes(app, p.variantId)).toEqual(['ABC-0001'])
  })

  it('a pre-existing barcode inside the range blocks generation instead of issuing a clashing code', async () => {
    const p = await trackedProduct(app, { prefix: 'ABC' })
    const v = await plainProduct(app, { name: 'Late' })
    // barcode ABC-0003 was assigned before codes reached it
    app.db.run("UPDATE product_variants SET barcode='ABC-0003' WHERE id=?", v.variantId)
    await expect(buy(p.variantId, 5)).rejects.toMatchObject({ code: 'CONFLICT', details: { code: 'UNIT_CODE_CLASH', unitCode: 'ABC-0003' } })
    expect(stockAt(app, p.variantId)).toBe(0)
    expect((await buy(p.variantId, 2)).items[0].unitCodes).toEqual(['ABC-0001', 'ABC-0002'])
  })
})

describe('generation', () => {
  it('is sequential and gap-free across opening stock, purchases, adjustments and failures', async () => {
    const p = await trackedProduct(app, { qty: 3 }) // opening stock -> backfilled
    expect(availCodes(app, p.variantId)).toEqual(['SPK-0001', 'SPK-0002', 'SPK-0003'])
    const r = await buy(p.variantId, 2)
    expect(r.items[0].unitCodes).toEqual(['SPK-0004', 'SPK-0005'])
    // a failed operation must not burn numbers
    await expect(buy(p.variantId, 0)).rejects.toBeTruthy()
    const adj = await INV(app, 'adjust', { variantId: p.variantId, delta: 2, reason: 'found' })
    expect(adj.unitCodes).toEqual(['SPK-0006', 'SPK-0007'])
    const seqs = app.db.all<{ seq: number }>('SELECT seq FROM product_units ORDER BY seq').map((x) => x.seq)
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(app.db.value('SELECT last_seq FROM unit_sequences WHERE prefix=?', 'SPK')).toBe(7)
    expect(stockAt(app, p.variantId)).toBe(7)
    await assertInvariant(app)
  })

  it('stops at 9999 with UNIT_LIMIT_REACHED, never silently going to 5 digits, and changes prefix afterwards', async () => {
    const p = await trackedProduct(app, { prefix: 'LIM' })
    app.db.run("INSERT INTO unit_sequences(prefix,last_seq) VALUES ('LIM',9997)")
    await expect(buy(p.variantId, 3)).rejects.toMatchObject({ code: 'CONFLICT', details: { code: 'UNIT_LIMIT_REACHED', prefix: 'LIM', remaining: 2 } })
    // nothing changed: no stock, no purchase, same sequence
    expect(stockAt(app, p.variantId)).toBe(0)
    expect(count(app, 'SELECT COUNT(*) FROM purchases')).toBe(0)
    expect(app.db.value('SELECT last_seq FROM unit_sequences WHERE prefix=?', 'LIM')).toBe(9997)

    expect((await buy(p.variantId, 2)).items[0].unitCodes).toEqual(['LIM-9998', 'LIM-9999'])
    const err: any = await buy(p.variantId, 1).catch((e) => e)
    expect(err.details.code).toBe('UNIT_LIMIT_REACHED')
    expect(err.message).toMatch(/new prefix/i)
    expect(count(app, "SELECT COUNT(*) FROM product_units WHERE length(code) > 8")).toBe(0)
    expect(() => app.db.run("INSERT INTO product_units(uuid,variant_id,prefix,seq,code) VALUES ('x',?,'LIM',10000,'LIM-10000')", p.variantId)).toThrow()

    // the prefix is only changeable once its 9999 codes are used up
    const r = await U(app, 'setTracking', { productId: p.productId, trackUnits: true, prefix: 'LIM2' })
    expect(r.prefix).toBe('LIM2')
    expect((await buy(p.variantId, 1)).items[0].unitCodes).toEqual(['LIM2-0001'])
    await assertInvariant(app)
  })

  it('is atomic: a failing line rolls back units, sequence, stock and the purchase of the earlier lines', async () => {
    const a = await trackedProduct(app, { name: 'A', prefix: 'AAA' })
    const b = await trackedProduct(app, { name: 'B', prefix: 'BBB' })
    app.db.run("INSERT INTO unit_sequences(prefix,last_seq) VALUES ('BBB',9999)")
    await expect(PUR(app, 'create', { items: [{ variantId: a.variantId, qty: 2, unitCost: 100 }, { variantId: b.variantId, qty: 1, unitCost: 100 }] })).rejects.toMatchObject({
      details: { code: 'UNIT_LIMIT_REACHED' }
    })
    expect(count(app, 'SELECT COUNT(*) FROM product_units')).toBe(0)
    expect(count(app, 'SELECT COUNT(*) FROM unit_sequences WHERE prefix=?', 'AAA')).toBe(0)
    expect(stockAt(app, a.variantId)).toBe(0)
    expect(count(app, 'SELECT COUNT(*) FROM purchases')).toBe(0)
    expect(count(app, 'SELECT COUNT(*) FROM stock_movements')).toBe(0)
  })

  it('generate() only codes stock that has no code yet (count <= remaining)', async () => {
    const p = await trackedProduct(app)
    await buy(p.variantId, 3, { generateUnits: false })
    expect(count(app, 'SELECT COUNT(*) FROM product_units')).toBe(0)
    let rep: any = await INV(app, 'verifyLedger')
    expect(rep.ok).toBe(false)
    expect(rep.unitMismatches[0]).toMatchObject({ variantId: p.variantId, level: 3, units: 0, difference: 3 })
    await expect(U(app, 'generate', { variantId: p.variantId, count: 4 })).rejects.toMatchObject({ code: 'VALIDATION', details: { code: 'UNIT_COUNT_EXCEEDS_STOCK', remaining: 3 } })
    const g = await U(app, 'generate', { variantId: p.variantId, count: 3, reason: 'backfill' })
    expect(g).toMatchObject({ prefix: 'SPK', firstSeq: 1, lastSeq: 3, codes: ['SPK-0001', 'SPK-0002', 'SPK-0003'] })
    rep = await INV(app, 'verifyLedger')
    expect(rep.ok).toBe(true)
    await expect(U(app, 'generate', { variantId: p.variantId, count: 1 })).rejects.toMatchObject({ details: { code: 'UNIT_COUNT_EXCEEDS_STOCK', remaining: 0 } })
  })
})

describe('tracking on/off', () => {
  it('turning tracking on codes the existing stock; the prefix then stays; turning off needs discardUnits', async () => {
    const p = await plainProduct(app, { name: 'Rocket', qty: 4 })
    const r = await U(app, 'setTracking', { productId: p.productId, trackUnits: true })
    expect(r.prefix).toMatch(/^[A-Z0-9]{2,8}$/)
    expect(r.backfilled[0].codes).toHaveLength(4)
    expect((await CAT(app, 'get', { id: p.productId })).trackUnits).toBe(true)
    expect((await CAT(app, 'get', { id: p.productId })).unitPrefix).toBe(r.prefix)
    expect((await CAT(app, 'list', {})).rows.find((x: any) => x.id === p.productId)).toMatchObject({ trackUnits: true, unitPrefix: r.prefix })
    await assertInvariant(app)

    await expect(U(app, 'setTracking', { productId: p.productId, trackUnits: true, prefix: 'OTHER' })).rejects.toMatchObject({ details: { code: 'PREFIX_LOCKED' } })
    await expect(U(app, 'setTracking', { productId: p.productId, trackUnits: false })).rejects.toMatchObject({ details: { code: 'UNITS_IN_STOCK', inStock: 4 } })
    await U(app, 'setTracking', { productId: p.productId, trackUnits: false, discardUnits: true })
    expect(count(app, "SELECT COUNT(*) FROM product_units WHERE status='void'")).toBe(4)
    expect(stockAt(app, p.variantId)).toBe(4) // stock untouched
    // switching back on codes the stock again with the same prefix, continuing the sequence
    const again = await U(app, 'setTracking', { productId: p.productId, trackUnits: true })
    expect(again.prefix).toBe(r.prefix)
    expect(again.backfilled[0].codes[0]).toBe(`${r.prefix}-0005`)
    await assertInvariant(app)
  })

  it('refuses unit tracking for products that do not track stock or have negative stock', async () => {
    const p = await CAT(app, 'save', { name: 'Service', trackStock: false, variants: [{ name: '', price: 100 }] })
    await expect(U(app, 'setTracking', { productId: p.id, trackUnits: true })).rejects.toMatchObject({ code: 'VALIDATION' })
    const q = await plainProduct(app, { name: 'Neg' })
    app.moveStock({ variantId: q.variantId, delta: -2, type: 'adjustment', allowNegative: true })
    await expect(U(app, 'setTracking', { productId: q.productId, trackUnits: true })).rejects.toMatchObject({ details: { code: 'NEGATIVE_STOCK' } })
  })

  it('units are never deleted and codes never change', async () => {
    const p = await trackedProduct(app, { qty: 1 })
    expect(() => app.db.run('DELETE FROM product_units')).toThrow(/never deleted/)
    expect(() => app.db.run("UPDATE product_units SET code='SPK-0009'")).toThrow(/never change/)
    expect(() => app.db.run('UPDATE product_units SET variant_id=variant_id+1')).toThrow()
    expect(availCodes(app, p.variantId)).toEqual(['SPK-0001'])
  })
})

describe('scan resolution', () => {
  it('resolves a unit code to its variant (any case/spacing) and ordinary barcodes still work', async () => {
    const p = await trackedProduct(app, { qty: 3, barcode: '8901234567890' })
    const s = await POS(app, 'scan', { code: ' spk-0002 ' })
    expect(s.unit).toMatchObject({ code: 'SPK-0002', status: 'in_stock', variantId: p.variantId, saleId: null })
    expect(s.unitOfMeasure).toBe('pcs')
    expect(s).toMatchObject({ variantId: p.variantId, trackUnits: true, price: 10000 })
    // the shop barcode of a tracked product: variant with trackUnits:true so the UI asks for a unit code
    const b = await POS(app, 'scan', { code: '8901234567890' })
    expect(b).toMatchObject({ variantId: p.variantId, trackUnits: true, unit: 'pcs', unitOfMeasure: 'pcs' })

    const r = await U(app, 'resolve', { code: 'SPK-0003' })
    expect(r.unit).toMatchObject({ code: 'SPK-0003', status: 'in_stock', variantId: p.variantId })
    expect(r.variant.variantId).toBe(p.variantId)
    expect(await U(app, 'resolve', { code: 'SPK-0099' })).toBeNull()
    expect(await U(app, 'resolve', { code: 'nope' })).toBeNull()
    await expect(POS(app, 'scan', { code: 'SPK-0099' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    // the same through the shared lookup used by inventory / catalog
    expect((await INV(app, 'lookup', { code: 'SPK-0001' })).variantId).toBe(p.variantId)
    expect((await CAT(app, 'findByCode', { code: 'SPK-0001' })).variantId).toBe(p.variantId)
  })

  it('a sold or void unit is rejected at the scan with a clear message; returned/in_stock are sellable', async () => {
    const p = await trackedProduct(app, { qty: 4 })
    await cashSale(app, [{ variantId: p.variantId, qty: 1, unitCodes: ['SPK-0003'] }])
    await expect(POS(app, 'scan', { code: 'SPK-0003' })).rejects.toMatchObject({
      code: 'CONFLICT', message: 'Unit SPK-0003 is already sold', details: { code: 'UNIT_NOT_AVAILABLE', status: 'sold' }
    })
    await U(app, 'markVoid', { codes: ['SPK-0004'], reason: 'damaged in storage' })
    await expect(POS(app, 'scan', { code: 'SPK-0004' })).rejects.toMatchObject({ details: { code: 'UNIT_NOT_AVAILABLE', status: 'void' } })
    expect((await POS(app, 'scan', { code: 'SPK-0001' })).unit.status).toBe('in_stock')
    app.db.run("UPDATE product_units SET status='returned' WHERE code='SPK-0002'")
    expect((await POS(app, 'scan', { code: 'SPK-0002' })).unit.status).toBe('returned')
  })

  it('non-tracked products behave exactly as before', async () => {
    const p = await plainProduct(app, { qty: 5 })
    const v = await POS(app, 'scan', { code: app.db.value<string>('SELECT sku FROM product_variants WHERE id=?', p.variantId)! })
    expect(v).toMatchObject({ variantId: p.variantId, trackUnits: false, unit: 'pcs' })
    const r = await cashSale(app, [{ variantId: p.variantId, qty: 2 }])
    expect(r.duplicate).toBe(false)
    expect(stockAt(app, p.variantId)).toBe(3)
    await expect(cashSale(app, [{ variantId: p.variantId, qty: 1, unitCodes: ['SPK-0001'] }])).rejects.toMatchObject({ details: { code: 'UNIT_NOT_TRACKED' } })
    expect(count(app, 'SELECT COUNT(*) FROM product_units')).toBe(0)
  })
})

describe('selling', () => {
  it('marks units sold, links them to the sale line and moves stock in the same transaction', async () => {
    const p = await trackedProduct(app, { qty: 5 })
    const r = await cashSale(app, [{ variantId: p.variantId, qty: 2, unitCodes: ['spk-0002', 'SPK-0004'] }])
    expect(stockAt(app, p.variantId)).toBe(3)
    const item = app.db.get<any>('SELECT * FROM sale_items WHERE sale_id=?', r.saleId)!
    const rows = app.db.all<any>("SELECT code, status, sale_id, sale_item_id FROM product_units WHERE status='sold' ORDER BY code")
    expect(rows).toEqual([
      { code: 'SPK-0002', status: 'sold', sale_id: r.saleId, sale_item_id: item.id },
      { code: 'SPK-0004', status: 'sold', sale_id: r.saleId, sale_item_id: item.id }
    ])
    expect((await POS(app, 'getSale', { id: r.saleId })).items[0].unitCodes).toEqual(['SPK-0002', 'SPK-0004'])
    expect((await U(app, 'counts', { variantId: p.variantId }))).toEqual({ in_stock: 3, sold: 2, returned: 0, void: 0 })
    expect((await U(app, 'resolve', { code: 'SPK-0002' })).unit).toMatchObject({ status: 'sold', saleId: r.saleId })
    await assertInvariant(app)
  })

  it('requires unit codes for tracked products and checks quantity, product and availability', async () => {
    const a = await trackedProduct(app, { name: 'A', prefix: 'AAA', qty: 3 })
    const b = await trackedProduct(app, { name: 'B', prefix: 'BBB', qty: 3 })
    await expect(cashSale(app, [{ variantId: a.variantId, qty: 1 }])).rejects.toMatchObject({ details: { code: 'UNIT_CODES_REQUIRED' } })
    await expect(cashSale(app, [{ variantId: a.variantId, qty: 2, unitCodes: ['AAA-0001'] }])).rejects.toMatchObject({ details: { code: 'UNIT_QTY_MISMATCH' } })
    await expect(cashSale(app, [{ variantId: a.variantId, qty: 1, unitCodes: ['BBB-0001'] }])).rejects.toMatchObject({ message: expect.stringContaining('BBB-0001'), details: { code: 'UNIT_WRONG_PRODUCT' } })
    await expect(cashSale(app, [{ variantId: a.variantId, qty: 1, unitCodes: ['AAA-0099'] }])).rejects.toMatchObject({ message: expect.stringContaining('AAA-0099'), details: { code: 'UNIT_NOT_FOUND' } })
    expect(count(app, 'SELECT COUNT(*) FROM sales')).toBe(0)
    await cashSale(app, [{ variantId: a.variantId, qty: 1, unitCodes: ['AAA-0001'] }])
    await expect(cashSale(app, [{ variantId: a.variantId, qty: 1, unitCodes: ['AAA-0001'] }])).rejects.toMatchObject({
      message: 'Unit AAA-0001 is already sold', details: { code: 'UNIT_NOT_AVAILABLE' }
    })
    expect(stockAt(app, b.variantId)).toBe(3)
  })

  it('rejects the same code twice inside one sale (same line or two lines)', async () => {
    const p = await trackedProduct(app, { qty: 4 })
    await expect(cashSale(app, [{ variantId: p.variantId, qty: 2, unitCodes: ['SPK-0001', 'spk-0001'] }])).rejects.toMatchObject({
      code: 'VALIDATION', details: { code: 'UNIT_DUPLICATE', unitCode: 'SPK-0001' }, message: expect.stringMatching(/Duplicate entry: SPK-0001/)
    })
    await expect(cashSale(app, [{ variantId: p.variantId, qty: 1, unitCodes: ['SPK-0001'] }, { variantId: p.variantId, qty: 1, unitCodes: ['SPK-0001'] }])).rejects.toMatchObject({
      details: { code: 'UNIT_DUPLICATE' }
    })
    expect(stockAt(app, p.variantId)).toBe(4)
    expect(availCodes(app, p.variantId)).toHaveLength(4)
  })

  it('the shared scan-list rule: unknown code added, duplicate flagged (client and server agree)', async () => {
    const p = await trackedProduct(app, { qty: 2 })
    const list = createScanList()
    expect(list.tryAdd('SPK-0001')).toBe('added')
    expect(list.tryAdd('spk-0001')).toBe('duplicate')
    const lines = [{ variantId: p.variantId, qty: list.size, unitCodes: list.codes() }]
    expect((await cashSale(app, lines)).saleId).toBeGreaterThan(0)
  })

  it('rolls everything back when the sale fails after units were touched (stock, units, sale rows, ledger)', async () => {
    const p = await trackedProduct(app, { qty: 3 })
    const plain = await plainProduct(app, { qty: 1 })
    const before = { stock: stockAt(app, p.variantId), moves: count(app, 'SELECT COUNT(*) FROM stock_movements') }
    // 1. second line fails (insufficient stock of the plain product, after the unit line was processed)
    await expect(cashSale(app, [{ variantId: p.variantId, qty: 2, unitCodes: ['SPK-0001', 'SPK-0002'] }, { variantId: plain.variantId, qty: 5 }])).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' })
    // 2. payment short
    await expect(POS(app, 'completeSale', { lines: [{ variantId: p.variantId, qty: 1, unitCodes: ['SPK-0003'] }], payments: [{ method: 'cash', amount: 1 }] })).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(count(app, 'SELECT COUNT(*) FROM sales')).toBe(0)
    expect(count(app, "SELECT COUNT(*) FROM product_units WHERE status<>'in_stock'")).toBe(0)
    expect(stockAt(app, p.variantId)).toBe(before.stock)
    expect(count(app, 'SELECT COUNT(*) FROM stock_movements')).toBe(before.moves)
    await assertInvariant(app)
  })

  it('retrying the same requestId does not touch units again', async () => {
    const p = await trackedProduct(app, { qty: 3 })
    const lines = [{ variantId: p.variantId, qty: 1, unitCodes: ['SPK-0001'] }]
    const first = await cashSale(app, lines, { requestId: 'req-unit-0001' })
    const moves = count(app, 'SELECT COUNT(*) FROM stock_movements')
    const queue = count(app, "SELECT COUNT(*) FROM sync_queue WHERE entity='product_units'")
    const again = await cashSale(app, lines, { requestId: 'req-unit-0001' })
    expect(again).toMatchObject({ duplicate: true, saleId: first.saleId })
    expect(count(app, 'SELECT COUNT(*) FROM sales')).toBe(1)
    expect(count(app, 'SELECT COUNT(*) FROM stock_movements')).toBe(moves)
    expect(count(app, "SELECT COUNT(*) FROM sync_queue WHERE entity='product_units'")).toBe(queue)
    expect(stockAt(app, p.variantId)).toBe(2)
    // a return retried with the same requestId is idempotent too
    const sale = await POS(app, 'getSale', { id: first.saleId })
    const ret = { saleId: first.saleId, requestId: 'req-ret-00001', reason: 'changed mind', items: [{ saleItemId: sale.items[0].id, qty: 1, unitCodes: ['SPK-0001'] }] }
    const r1 = await POS(app, 'createReturn', ret)
    const r2 = await POS(app, 'createReturn', ret)
    expect(r2).toMatchObject({ duplicate: true, returnId: r1.returnId })
    expect(stockAt(app, p.variantId)).toBe(3)
    expect(statusOf(app, 'SPK-0001')).toBe('in_stock')
    await assertInvariant(app)
  })
})

describe('void and return', () => {
  it('voiding a sale puts its units back in stock, at the location they left', async () => {
    const p = await trackedProduct(app, { qty: 4 })
    const loc2 = app.db.run('INSERT INTO locations(uuid,name) VALUES (?,?)', app.uuid(), 'Godown').lastId
    await INV(app, 'transferCreate', { fromLocationId: app.defaultLocationId(), toLocationId: loc2, items: [{ variantId: p.variantId, qty: 1, unitCodes: ['SPK-0004'] }] })
    const r = await cashSale(app, [{ variantId: p.variantId, qty: 2, unitCodes: ['SPK-0001', 'SPK-0004'] }])
    expect(stockAt(app, p.variantId)).toBe(2)
    expect(stockAt(app, p.variantId, loc2)).toBe(0)
    await POS(app, 'voidSale', { saleId: r.saleId, reason: 'customer left' })
    expect(statusOf(app, 'SPK-0001')).toBe('in_stock')
    expect(statusOf(app, 'SPK-0004')).toBe('in_stock')
    expect(stockAt(app, p.variantId)).toBe(3)
    expect(stockAt(app, p.variantId, loc2)).toBe(1)
    await assertInvariant(app)
    // and they can be sold again
    await cashSale(app, [{ variantId: p.variantId, qty: 1, unitCodes: ['SPK-0004'] }])
    expect(statusOf(app, 'SPK-0004')).toBe('sold')
  })

  it('returns name the units: restock -> in_stock, no restock -> void; wrong units are refused', async () => {
    const p = await trackedProduct(app, { qty: 5 })
    const r = await cashSale(app, [{ variantId: p.variantId, qty: 4, unitCodes: ['SPK-0001', 'SPK-0002', 'SPK-0003', 'SPK-0004'] }])
    const item = (await POS(app, 'getSale', { id: r.saleId })).items[0]
    const ret = (items: any[]) => POS(app, 'createReturn', { saleId: r.saleId, reason: 'test', items })
    await expect(ret([{ saleItemId: item.id, qty: 1 }])).rejects.toMatchObject({ details: { code: 'UNIT_CODES_REQUIRED' } })
    await expect(ret([{ saleItemId: item.id, qty: 2, unitCodes: ['SPK-0001'] }])).rejects.toMatchObject({ details: { code: 'UNIT_QTY_MISMATCH' } })
    await expect(ret([{ saleItemId: item.id, qty: 1, unitCodes: ['SPK-0005'] }])).rejects.toMatchObject({ details: { code: 'UNIT_NOT_ON_SALE' } })
    expect(statusOf(app, 'SPK-0001')).toBe('sold')

    await ret([{ saleItemId: item.id, qty: 2, unitCodes: ['SPK-0001', 'SPK-0002'], restock: true }])
    expect(statusOf(app, 'SPK-0001')).toBe('in_stock')
    expect(stockAt(app, p.variantId)).toBe(3)
    await ret([{ saleItemId: item.id, qty: 1, unitCodes: ['SPK-0003'], restock: false }])
    expect(statusOf(app, 'SPK-0003')).toBe('void')
    expect(stockAt(app, p.variantId)).toBe(3)
    // a unit that already came back cannot be returned again
    await expect(ret([{ saleItemId: item.id, qty: 1, unitCodes: ['SPK-0001'] }])).rejects.toMatchObject({ code: 'CONFLICT', details: { code: 'UNIT_NOT_AVAILABLE', status: 'in_stock' } })
    await assertInvariant(app)
  })
})

describe('inventory flows', () => {
  it('receiving purchases auto-generates codes per item; generateUnits:false skips; cancelling voids them', async () => {
    const p = await trackedProduct(app)
    const q = await plainProduct(app)
    const r = await PUR(app, 'create', { items: [{ variantId: p.variantId, qty: 3, unitCost: 100 }, { variantId: q.variantId, qty: 2, unitCost: 100 }] })
    expect(r.items).toEqual([
      { variantId: p.variantId, qty: 3, unitCodes: ['SPK-0001', 'SPK-0002', 'SPK-0003'] },
      { variantId: q.variantId, qty: 2, unitCodes: [] }
    ])
    expect(app.db.all<any>('SELECT purchase_id FROM product_units').every((u) => u.purchase_id === r.id)).toBe(true)
    await PUR(app, 'cancel', { id: r.id, reason: 'wrong goods' })
    expect(count(app, "SELECT COUNT(*) FROM product_units WHERE status='void'")).toBe(3)
    expect(stockAt(app, p.variantId)).toBe(0)
    await assertInvariant(app)
    // cancelling is refused when one of its units was already sold
    const r2 = await PUR(app, 'create', { items: [{ variantId: p.variantId, qty: 2, unitCost: 100 }] })
    await cashSale(app, [{ variantId: p.variantId, qty: 1, unitCodes: [r2.items[0].unitCodes[0]] }])
    await expect(PUR(app, 'cancel', { id: r2.id, reason: 'x' })).rejects.toMatchObject({ details: { code: 'UNIT_NOT_AVAILABLE' } })
    expect(count(app, "SELECT COUNT(*) FROM product_units WHERE status='in_stock'")).toBe(1)
    await assertInvariant(app)
  })

  it('adjustments: increases issue codes, decreases must name the units', async () => {
    const p = await trackedProduct(app, { qty: 3 })
    const up = await INV(app, 'adjust', { variantId: p.variantId, delta: 1, reason: 'found' })
    expect(up.unitCodes).toEqual(['SPK-0004'])
    await expect(INV(app, 'adjust', { variantId: p.variantId, delta: -2, reason: 'damage' })).rejects.toMatchObject({ details: { code: 'UNIT_CODES_REQUIRED' } })
    await expect(INV(app, 'adjust', { variantId: p.variantId, delta: -1, reason: 'damage', unitCodes: ['SPK-0099'] })).rejects.toMatchObject({ details: { code: 'UNIT_NOT_FOUND' } })
    const down = await INV(app, 'adjust', { variantId: p.variantId, delta: -2, reason: 'damage', unitCodes: ['SPK-0001', 'SPK-0003'] })
    expect(down.unitCodes).toEqual(['SPK-0001', 'SPK-0003'])
    expect(statusOf(app, 'SPK-0001')).toBe('void')
    expect(stockAt(app, p.variantId)).toBe(2)
    expect(app.db.value('SELECT void_reason FROM product_units WHERE code=?', 'SPK-0001')).toMatch(/damage/)
    await assertInvariant(app)
  })

  it('markVoid writes units off (stock reduced in the same transaction), atomically', async () => {
    const p = await trackedProduct(app, { qty: 3 })
    await expect(U(app, 'markVoid', { codes: ['SPK-0001', 'SPK-0099'], reason: 'lost in fire' })).rejects.toMatchObject({ details: { code: 'UNIT_NOT_FOUND' } })
    expect(stockAt(app, p.variantId)).toBe(3)
    expect(statusOf(app, 'SPK-0001')).toBe('in_stock')
    await expect(U(app, 'markVoid', { codes: ['SPK-0001'], reason: 'x' })).rejects.toMatchObject({ code: 'VALIDATION' })
    const r = await U(app, 'markVoid', { codes: ['spk-0001', 'SPK-0002'], reason: 'lost in fire' })
    expect(r).toEqual({ voided: 2, codes: ['SPK-0001', 'SPK-0002'] })
    expect(stockAt(app, p.variantId)).toBe(1)
    await expect(U(app, 'markVoid', { codes: ['SPK-0001'], reason: 'again please' })).rejects.toMatchObject({ details: { status: 'void' } })
    expect(count(app, "SELECT COUNT(*) FROM audit_log WHERE entity='unit' AND action='void'")).toBeGreaterThan(0)
    await assertInvariant(app)
  })

  it('transfers move the named units between locations; supplier returns void them', async () => {
    const p = await trackedProduct(app, { qty: 4 })
    const loc2 = app.db.run('INSERT INTO locations(uuid,name) VALUES (?,?)', app.uuid(), 'Shelf 2').lastId
    const def = app.defaultLocationId()
    await expect(INV(app, 'transferCreate', { fromLocationId: def, toLocationId: loc2, items: [{ variantId: p.variantId, qty: 2 }] })).rejects.toMatchObject({ details: { code: 'UNIT_CODES_REQUIRED' } })
    await INV(app, 'transferCreate', { fromLocationId: def, toLocationId: loc2, items: [{ variantId: p.variantId, qty: 2, unitCodes: ['SPK-0001', 'SPK-0002'] }] })
    expect(availCodes(app, p.variantId, loc2)).toEqual(['SPK-0001', 'SPK-0002'])
    expect(stockAt(app, p.variantId, loc2)).toBe(2)
    // a unit that is not at the source location cannot be transferred from there
    await expect(INV(app, 'transferCreate', { fromLocationId: def, toLocationId: loc2, items: [{ variantId: p.variantId, qty: 1, unitCodes: ['SPK-0001'] }] })).rejects.toMatchObject({ details: { code: 'UNIT_WRONG_LOCATION' } })
    await assertInvariant(app)

    const sup = app.db.run('INSERT INTO suppliers(uuid,name) VALUES (?,?)', app.uuid(), 'Sup').lastId
    await expect(PUR(app, 'returnCreate', { supplierId: sup, items: [{ variantId: p.variantId, qty: 1 }] })).rejects.toMatchObject({ details: { code: 'UNIT_CODES_REQUIRED' } })
    await PUR(app, 'returnCreate', { supplierId: sup, items: [{ variantId: p.variantId, qty: 1, unitCodes: ['SPK-0003'] }] })
    expect(statusOf(app, 'SPK-0003')).toBe('void')
    expect(stockAt(app, p.variantId)).toBe(1)
    await assertInvariant(app)
  })

  it('stock counts compare scanned unit codes with the expected units: duplicates flagged, missing voided, unknown rejected', async () => {
    const p = await trackedProduct(app, { qty: 4 })
    const plain = await plainProduct(app, { qty: 5, name: 'Loose' })
    await cashSale(app, [{ variantId: p.variantId, qty: 1, unitCodes: ['SPK-0004'] }]) // sold: not expected on the shelf any more
    const c = await INV(app, 'countCreate', {})
    await expect(INV(app, 'countScan', { countId: c.id, code: app.db.value<string>('SELECT sku FROM product_variants WHERE id=?', p.variantId)! })).rejects.toMatchObject({ details: { code: 'UNIT_CODE_REQUIRED' } })
    await expect(INV(app, 'countSet', { countId: c.id, entries: [{ variantId: p.variantId, countedQty: 2 }] })).rejects.toMatchObject({ details: { code: 'UNIT_CODE_REQUIRED' } })
    const s1 = await INV(app, 'countScan', { countId: c.id, code: 'SPK-0001' })
    expect(s1).toMatchObject({ duplicate: false, unexpected: false, countedQty: 1, expectedQty: 3 })
    const dup = await INV(app, 'countScan', { countId: c.id, code: 'spk-0001' })
    expect(dup).toMatchObject({ duplicate: true, countedQty: 1 }) // not added again
    expect(count(app, 'SELECT COUNT(*) FROM stock_count_units WHERE count_id=?', c.id)).toBe(1)
    const sold = await INV(app, 'countScan', { countId: c.id, code: 'SPK-0004' })
    expect(sold).toMatchObject({ unexpected: true, countedQty: 1 })
    await expect(INV(app, 'countScan', { countId: c.id, code: 'SPK-0555' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await INV(app, 'countScan', { countId: c.id, code: 'SPK-0002' })
    // plain product counted the old way
    await INV(app, 'countSet', { countId: c.id, entries: [{ variantId: plain.variantId, countedQty: 5 }] })

    const rep = await U(app, 'countReport', { countId: c.id })
    expect(rep.missing).toEqual(['SPK-0003'])
    expect(rep.unexpected.map((u: any) => u.code)).toEqual(['SPK-0004'])
    const applied = await INV(app, 'countApply', { countId: c.id })
    expect(applied.missingUnits).toEqual(['SPK-0003'])
    expect(applied.unexpectedUnits).toEqual(['SPK-0004'])
    expect(statusOf(app, 'SPK-0003')).toBe('void')
    expect(app.db.value('SELECT void_reason FROM product_units WHERE code=?', 'SPK-0003')).toBe('count')
    expect(statusOf(app, 'SPK-0004')).toBe('sold') // unexpected units are reported, never changed
    expect(stockAt(app, p.variantId)).toBe(2)
    expect(count(app, "SELECT COUNT(*) FROM stock_movements WHERE type='count'")).toBe(1)
    await assertInvariant(app)
  })

  it('verifyLedger reports unit/stock mismatches', async () => {
    const p = await trackedProduct(app, { qty: 2 })
    app.moveStock({ variantId: p.variantId, delta: 1, type: 'adjustment' }) // bypasses the units
    const rep: any = await INV(app, 'verifyLedger')
    expect(rep.ok).toBe(false)
    expect(rep.mismatches).toHaveLength(0)
    expect(rep.unitMismatches).toEqual([{ variantId: p.variantId, locationId: app.defaultLocationId(), level: 3, units: 2, difference: 1 }])
  })
})

describe('permissions, audit and sync', () => {
  it('every method is permission-checked', async () => {
    const p = await trackedProduct(app, { qty: 2 })
    actAs(app, 'Cashier') // pos.sell, catalog.view, inventory.view only
    await expect(U(app, 'setTracking', { productId: p.productId, trackUnits: false })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(U(app, 'generate', { variantId: p.variantId, count: 1 })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(U(app, 'markVoid', { codes: ['SPK-0001'], reason: 'nope nope' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(CAT(app, 'save', { id: p.productId, name: 'x', trackUnits: false, variants: [{ id: p.variantId, name: '' }] })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect((await U(app, 'resolve', { code: 'SPK-0001' })).unit.code).toBe('SPK-0001')
    expect((await U(app, 'list', { variantId: p.variantId })).total).toBe(2)
    expect((await U(app, 'counts', { variantId: p.variantId })).in_stock).toBe(2)
    app.session = { ...app.session!, permissions: [] }
    await expect(U(app, 'resolve', { code: 'SPK-0001' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(U(app, 'list', {})).rejects.toMatchObject({ code: 'FORBIDDEN' })
    app.session = null
    await expect(U(app, 'list', {})).rejects.toMatchObject({ code: 'UNAUTHENTICATED' })
  })

  it('validates input', async () => {
    const p = await trackedProduct(app, { qty: 1 })
    await expect(U(app, 'generate', { variantId: p.variantId, count: 0 })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(U(app, 'generate', { variantId: p.variantId, count: 10000 })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(U(app, 'markVoid', { codes: [], reason: 'xxx' })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(U(app, 'setTracking', { productId: 'a', trackUnits: true })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(U(app, 'list', { status: 'lost' })).rejects.toMatchObject({ code: 'VALIDATION' })
  })

  it('list filters and paginates; audit rows and sync snapshots are written for generate, sale, void', async () => {
    const p = await trackedProduct(app, { qty: 3 })
    expect(count(app, "SELECT COUNT(*) FROM audit_log WHERE entity='unit' AND action='generate'")).toBe(1)
    const queued = () => count(app, "SELECT COUNT(*) FROM sync_queue WHERE entity='product_units'")
    expect(queued()).toBe(3)
    const r = await cashSale(app, [{ variantId: p.variantId, qty: 1, unitCodes: ['SPK-0002'] }])
    expect(count(app, "SELECT COUNT(*) FROM audit_log WHERE entity='unit' AND action='sold'")).toBe(1)
    expect(queued()).toBe(4)
    const snap = JSON.parse(app.db.value<string>("SELECT payload_json FROM sync_queue WHERE entity='product_units' ORDER BY id DESC LIMIT 1")!)
    expect(snap).toMatchObject({ table: 'product_units', row: { code: 'SPK-0002', status: 'sold' }, refs: { variant_id: { table: 'product_variants' }, sale_id: { table: 'sales' } } })
    await POS(app, 'voidSale', { saleId: r.saleId, reason: 'oops oops' })
    expect(queued()).toBe(5)
    expect(count(app, "SELECT COUNT(*) FROM audit_log WHERE entity='unit' AND action='restore'")).toBe(1)

    const sold = await U(app, 'list', { variantId: p.variantId, status: 'in_stock', limit: 2, offset: 0 })
    expect(sold.total).toBe(3)
    expect(sold.rows).toHaveLength(2)
    expect((await U(app, 'list', { search: 'spk-0003' })).rows.map((x: any) => x.code)).toEqual(['SPK-0003'])
    expect((await U(app, 'list', { productId: p.productId })).total).toBe(3)
  })
})

describe('multi-terminal sync', () => {
  it('units travel to another terminal idempotently; the receiver continues the sequence', async () => {
    const b = createTestApp()
    const p = await trackedProduct(app, { qty: 3 })
    const first = pipe(app, b)
    expect(first.statuses.filter((s) => s.startsWith('product_units')).every((s) => s.endsWith('applied'))).toBe(true)
    expect(b.db.all<any>('SELECT code, uuid, status FROM product_units ORDER BY code')).toEqual(
      app.db.all<any>('SELECT code, uuid, status FROM product_units ORDER BY code')
    )
    expect(b.db.value('SELECT last_seq FROM unit_sequences WHERE prefix=?', 'SPK')).toBe(3)
    // replaying is a no-op
    const again = pipe(app, b)
    expect(again.statuses.filter((s) => s.startsWith('product_units')).every((s) => s.endsWith('skipped'))).toBe(true)
    expect(count(b, 'SELECT COUNT(*) FROM product_units')).toBe(3)

    // a later status change (sold) updates the existing unit on the other side
    const since = first.last
    await new Promise((r) => setTimeout(r, 5))
    app.enqueueSnapshot('business_profile_versions', app.db.value<number>('SELECT id FROM business_profile_versions WHERE is_active=1')!)
    await cashSale(app, [{ variantId: p.variantId, qty: 1, unitCodes: ['SPK-0002'] }])
    // the unit snapshot is queued before its sale; the receiver parks it until the sale (and its line) arrived, then applies it
    pipe(app, b, since)
    expect(statusOf(b, 'SPK-0002')).toBe('sold')
    expect(b.db.value('SELECT sale_id FROM product_units WHERE code=?', 'SPK-0002')).not.toBeNull()
    expect(b.db.value('SELECT sale_item_id FROM product_units WHERE code=?', 'SPK-0002')).not.toBeNull()

    // the receiving terminal keeps numbering from where the sender stopped (stock movements travel separately)
    const bv = b.db.value<number>('SELECT id FROM product_variants LIMIT 1')!
    b.moveStock({ variantId: bv, delta: 4, type: 'adjustment' })
    const g = await U(b, 'generate', { variantId: bv, count: 2 })
    expect(g.codes).toEqual(['SPK-0004', 'SPK-0005'])
    b.close()
  })

  it('the same code issued offline on two terminals is detected and logged, never overwritten', async () => {
    const b = createTestApp()
    const p = await trackedProduct(app, { qty: 1 })
    const s0 = pipe(app, b)
    const bv = b.db.value<number>('SELECT id FROM product_variants LIMIT 1')!
    // both go offline and each receives one more unit -> both pick SPK-0002
    app.moveStock({ variantId: p.variantId, delta: 1, type: 'adjustment' })
    const ga = await U(app, 'generate', { variantId: p.variantId, count: 1 })
    b.moveStock({ variantId: bv, delta: 2, type: 'adjustment' }) // stock of the first unit + one new piece (movements sync separately)
    const gb = await U(b, 'generate', { variantId: bv, count: 1 })
    expect(ga.codes).toEqual(['SPK-0002'])
    expect(gb.codes).toEqual(['SPK-0002'])
    const localUuid = b.db.value<string>("SELECT uuid FROM product_units WHERE code='SPK-0002'")!
    const res = pipe(app, b, s0.last)
    expect(res.statuses).toContain('product_units:skipped')
    // B keeps its own unit; A's unit with the same code was NOT applied, and the clash is on record
    expect(b.db.value<string>("SELECT uuid FROM product_units WHERE code='SPK-0002'")).toBe(localUuid)
    expect(count(b, "SELECT COUNT(*) FROM product_units WHERE code='SPK-0002'")).toBe(1)
    const conflict = b.db.get<any>("SELECT * FROM sync_conflicts WHERE entity='product_units'")!
    expect(conflict.kind).toBe('duplicate_key')
    expect(conflict.resolution).toMatch(/SPK-0002/)
    expect(JSON.parse(conflict.remote_json).code).toBe('SPK-0002')
    b.close()
  })
})

describe('invariant fuzz: stock == in-stock units after every operation', () => {
  it('survives 250 random purchases, sales, voids, returns, adjustments, write-offs, transfers and counts', async () => {
    let seed = 20260401
    const rnd = (n: number) => {
      seed = (seed * 1664525 + 1013904223) >>> 0
      return seed % n
    }
    const a = await trackedProduct(app, { name: 'Fuzz A', prefix: 'FZA', qty: 6 })
    const b = await trackedProduct(app, { name: 'Fuzz B', prefix: 'FZB', qty: 4 })
    const vs = [a.variantId, b.variantId]
    const loc2 = app.db.run('INSERT INTO locations(uuid,name) VALUES (?,?)', app.uuid(), 'Fuzz Godown').lastId
    const locs = [app.defaultLocationId(), loc2]
    const sales: number[] = []
    const sup = app.db.run('INSERT INTO suppliers(uuid,name) VALUES (?,?)', app.uuid(), 'Fuzz Sup').lastId
    let performed = 0
    for (let i = 0; i < 250; i++) {
      const v = vs[rnd(2)]
      const loc = locs[rnd(2)]
      const avail = availCodes(app, v, loc)
      const pick = (n: number) => avail.slice(0, Math.min(n, avail.length))
      try {
        switch (rnd(9)) {
          case 0:
            await PUR(app, 'create', { locationId: loc, items: [{ variantId: v, qty: 1 + rnd(4), unitCost: 100 }] })
            break
          case 1: {
            // sell from whichever location the chosen units sit in
            const all = availCodes(app, v)
            if (!all.length) break
            const codes = all.slice(0, 1 + rnd(Math.min(3, all.length)))
            sales.push((await cashSale(app, [{ variantId: v, qty: codes.length, unitCodes: codes }])).saleId)
            break
          }
          case 2: {
            const id = sales.splice(rnd(Math.max(1, sales.length)), 1)[0]
            if (id) await POS(app, 'voidSale', { saleId: id, reason: 'fuzz void' })
            break
          }
          case 3: {
            const id = sales[rnd(Math.max(1, sales.length))]
            if (!id) break
            const sale = await POS(app, 'getSale', { id })
            if (sale.status !== 'completed') break
            const line = sale.items[0]
            const soldNow = app.db.all<{ code: string }>("SELECT code FROM product_units WHERE sale_item_id=? AND status='sold'", line.id).map((x) => x.code)
            if (!soldNow.length) break
            await POS(app, 'createReturn', { saleId: id, reason: 'fuzz', items: [{ saleItemId: line.id, qty: 1, unitCodes: [soldNow[0]], restock: rnd(2) === 0 }] })
            break
          }
          case 4:
            await INV(app, 'adjust', { variantId: v, locationId: loc, delta: 1 + rnd(3), reason: 'found' })
            break
          case 5:
            if (avail.length) await INV(app, 'adjust', { variantId: v, locationId: loc, delta: -1, reason: 'damage', unitCodes: pick(1) })
            break
          case 6:
            if (avail.length) await U(app, 'markVoid', { codes: pick(1 + rnd(2)), reason: 'fuzz write-off' })
            break
          case 7:
            if (avail.length) {
              const codes = pick(1 + rnd(2))
              const to = locs.find((l) => l !== loc)!
              await INV(app, 'transferCreate', { fromLocationId: loc, toLocationId: to, items: [{ variantId: v, qty: codes.length, unitCodes: codes }] })
            }
            break
          case 8:
            if (avail.length) await PUR(app, 'returnCreate', { supplierId: sup, locationId: loc, items: [{ variantId: v, qty: 1, unitCodes: pick(1) }] })
            break
        }
        performed++
      } catch (e) {
        // a rejected operation must leave everything consistent too
        if (!(e as { code?: string }).code) throw e
      }
      await assertInvariant(app)
    }
    expect(performed).toBeGreaterThan(150)
    // codes stayed gap-free and unique
    for (const prefix of ['FZA', 'FZB']) {
      const seqs = app.db.all<{ seq: number }>('SELECT seq FROM product_units WHERE prefix=? ORDER BY seq', prefix).map((x) => x.seq)
      expect(seqs).toEqual(seqs.map((_, i) => i + 1))
    }
    for (const v of vs) {
      const c = await U(app, 'counts', { variantId: v })
      expect(c.in_stock + c.returned).toBe(app.db.value('SELECT COALESCE(SUM(qty),0) FROM stock_levels WHERE variant_id=?', v))
    }
  })
})

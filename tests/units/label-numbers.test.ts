import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { actAs, createTestApp } from '../helpers'
import { App } from '../../src/main/core/app'
import { registerAllModules } from '../../src/main/core/modules'
import { Db } from '../../src/main/db/driver'
import { allMigrations, runMigrations } from '../../src/main/db/migrate'
import {
  LABEL_NUMBER_RE, MAX_LABEL_SEQ, MAX_UNIT_SEQ, UNIT_CODE_RE, createScanList, duplicateMessage, formatUnitCode, isLabelPrefix, maxSeqFor, parseUnitCode
} from '../../src/shared/scanList'
import { addUnit, classifyScan, isLocalDuplicate, legacyScanAllowed, saleLinePayload } from '../../src/renderer/modules/pos/unitCart'
import type { CartLine } from '../../src/renderer/modules/pos/types'
import { chunk, codeRangeText, shortfallExtra, shortfallLines, shortfallsOf, splitPlans, type LabelPlan } from '../../src/renderer/modules/printing/labelJob'
import { CAT, INV, POS, PUR, U, assertInvariant, availCodes, cashSale, count, pipe, stockAt, statusOf, trackedProduct } from './helpers'

/**
 * Owner rule: every printed barcode label carries its OWN number. The prefix stays the same for a product and only the suffix
 * counts up (2000000190, 2000000191 ...), a number is never issued twice, and a label that was scanned once cannot be billed again.
 */
let app: App
beforeEach(() => {
  app = createTestApp()
})

/** An ordinary stock-tracked product, exactly as the shop creates it: nothing ticked, no prefix typed. */
async function stockProduct(a: App, o: { name?: string; qty?: number; barcode?: string; price?: number } = {}) {
  const p = await CAT(a, 'save', {
    name: o.name ?? 'Flower Pot', variants: [{ name: '', barcode: o.barcode, price: o.price ?? 5000, mrp: o.price ?? 5000, cost: 2000, openingStock: o.qty ?? 0 }]
  })
  return { productId: p.id as number, variantId: p.variants[0].id as number }
}
const issue = async (a: App, variantId: number, n: number, extra: Record<string, unknown> = {}): Promise<string[]> =>
  ((await U(a, 'issueLabels', { items: [{ variantId, count: n }], ...extra })) as { items: { codes: string[] }[] }).items[0].codes
const unitCount = (a: App) => count(a, 'SELECT COUNT(*) FROM product_units')
const productRow = (a: App, id: number) => a.db.get<{ track_units: number; unit_auto: number; unit_prefix: string | null }>('SELECT track_units, unit_auto, unit_prefix FROM products WHERE id=?', id)!
const printed = (a: App, code: string) => a.db.value<number | null>('SELECT label_printed_at FROM product_units WHERE code=?', code)

describe('label number format', () => {
  it('is 10 digits: a 4-digit prefix that never starts with 0, then a 6-digit zero-padded suffix, no dash', () => {
    expect(formatUnitCode('2000', 190)).toBe('2000000190')
    expect(formatUnitCode('2000', 191)).toBe('2000000191')
    expect(formatUnitCode('9999', 1)).toBe('9999000001')
    expect(formatUnitCode('2000', MAX_LABEL_SEQ)).toBe('2000999999')
    expect(MAX_LABEL_SEQ).toBe(999_999)
    expect(() => formatUnitCode('2000', MAX_LABEL_SEQ + 1)).toThrow()
    expect(() => formatUnitCode('2000', 0)).toThrow()
    expect(LABEL_NUMBER_RE.test('2000000190')).toBe(true)
    expect(isLabelPrefix('2000')).toBe(true)
    for (const bad of ['0200', '200', '20000', 'AB12', '20A0']) expect(isLabelPrefix(bad), bad).toBe(false)
    expect(maxSeqFor('2000')).toBe(999_999)
    expect(maxSeqFor('SPK')).toBe(MAX_UNIT_SEQ)
  })

  it('parses both spellings: the new digits-only number and the older PREFIX-NNNN', () => {
    expect(parseUnitCode('2000000190')).toEqual({ prefix: '2000', seq: 190 })
    expect(parseUnitCode(' 2000000191 ')).toEqual({ prefix: '2000', seq: 191 })
    expect(parseUnitCode('SPK-0007')).toEqual({ prefix: 'SPK', seq: 7 })
    expect(parseUnitCode('spk-0007')).toEqual({ prefix: 'SPK', seq: 7 })
    expect(formatUnitCode('spk', 7)).toBe('SPK-0007') // a letter prefix keeps the old spelling
    // not label numbers: leading zero, 9 / 11 digits, EAN-13
    for (const no of ['0200000190', '200000019', '20000001900', '8901234567890', 'SPK-00007', '2000-000190']) expect(parseUnitCode(no), no).toBeNull()
    expect(UNIT_CODE_RE.test('2000000190')).toBe(true)
    expect(UNIT_CODE_RE.test('SPK-0001')).toBe(true)
  })

  it('the shared scan-list rule works for label numbers (bill, stock count, receiving, transfers)', () => {
    const list = createScanList()
    expect(list.tryAdd('2000000190')).toBe('added')
    expect(list.tryAdd(' 2000000190 ')).toBe('duplicate')
    expect(list.tryAdd('2000000191')).toBe('added')
    expect(list.size).toBe(2)
    expect(duplicateMessage('2000000190', 'this bill')).toBe('Duplicate entry: 2000000190 is already in this bill. Not added again.')
    list.remove('2000000190')
    expect(list.tryAdd('2000000190')).toBe('added')
    expect(isLocalDuplicate(list, '2000000190')).toBe(true)
    expect(isLocalDuplicate(list, '2000000999')).toBe(false)
  })
})

describe('printing labels issues consecutive numbers', () => {
  it('N labels = N different consecutive numbers with one prefix; nobody ticks a box or invents a prefix', async () => {
    const p = await stockProduct(app, { qty: 5 })
    expect(productRow(app, p.productId)).toMatchObject({ track_units: 0, unit_prefix: null })
    const codes = await issue(app, p.variantId, 3)
    expect(codes).toHaveLength(3)
    for (const c of codes) expect(c).toMatch(/^[1-9]\d{9}$/)
    const prefix = codes[0].slice(0, 4)
    expect(codes).toEqual([1, 2, 3].map((n) => formatUnitCode(prefix, n)))
    expect(codes.map((c) => Number(c.slice(4)))).toEqual([1, 2, 3])
    // unit tracking was switched on automatically, with that prefix
    expect(productRow(app, p.productId)).toEqual({ track_units: 1, unit_auto: 1, unit_prefix: prefix })
    // stock is untouched and still equals the number of in-stock units
    expect(stockAt(app, p.variantId)).toBe(5)
    await assertInvariant(app)
    for (const c of codes) expect(printed(app, c)).not.toBeNull()
  })

  it('printing again continues with the next number and never reissues one', async () => {
    const p = await stockProduct(app, { qty: 10 })
    const a = await issue(app, p.variantId, 2)
    const b = await issue(app, p.variantId, 3)
    const c = await issue(app, p.variantId, 1)
    const all = [...a, ...b, ...c]
    expect(new Set(all).size).toBe(6)
    expect(all.map((x) => Number(x.slice(4)))).toEqual([1, 2, 3, 4, 5, 6])
    expect(new Set(all.map((x) => x.slice(0, 4))).size).toBe(1)
    expect(stockAt(app, p.variantId)).toBe(10)
  })

  it('the owner example: after ...0190 comes ...0191 (same prefix, suffix + 1)', async () => {
    const p = await stockProduct(app, { qty: 1 })
    const [first] = await issue(app, p.variantId, 1)
    const prefix = first.slice(0, 4)
    // 188 more pieces arrive and are labelled, then two more
    await PUR(app, 'create', { items: [{ variantId: p.variantId, qty: 190, unitCost: 1000 }] })
    await issue(app, p.variantId, 188)
    expect(await issue(app, p.variantId, 2)).toEqual([`${prefix}000190`, `${prefix}000191`])
    await assertInvariant(app)
  })

  it('every product gets its own prefix; all variants of one product share prefix and running number', async () => {
    const a = await stockProduct(app, { name: 'A', qty: 2 })
    const b = await stockProduct(app, { name: 'B', qty: 2 })
    const ca = await issue(app, a.variantId, 2)
    const cb = await issue(app, b.variantId, 2)
    expect(ca[0].slice(0, 4)).not.toBe(cb[0].slice(0, 4))
    expect(cb.map((c) => Number(c.slice(4)))).toEqual([1, 2])
    const two = await CAT(app, 'save', { name: 'Two sizes', variants: [{ name: 'S', price: 100, openingStock: 2 }, { name: 'L', price: 200, openingStock: 3 }] })
    const s = await issue(app, two.variants[0].id, 2)
    const l = await issue(app, two.variants[1].id, 3)
    expect(new Set([...s, ...l].map((c) => c.slice(0, 4))).size).toBe(1)
    expect(new Set([...s, ...l]).size).toBe(5)
    expect([...s, ...l].map((c) => Number(c.slice(4))).sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5])
  })

  it('a prefix that would collide with an existing 10-digit barcode is skipped', async () => {
    const other = await stockProduct(app, { name: 'Has a 10-digit barcode', barcode: '2000000005', qty: 1 })
    const p = await stockProduct(app, { name: 'New', qty: 2 })
    const codes = await issue(app, p.variantId, 2)
    expect(codes[0].slice(0, 4)).not.toBe('2000')
    // and the shared barcode of the other product still resolves to it
    expect((await POS(app, 'scan', { code: '2000000005' })).variantId).toBe(other.variantId)
    // an issued label number can never become a barcode / alias / SKU
    expect(() => app.db.run('UPDATE product_variants SET barcode=? WHERE id=?', codes[0], other.variantId)).toThrow(/unit code/)
    await expect(CAT(app, 'save', { name: 'Clash', variants: [{ name: '', barcode: `${codes[0].slice(0, 4)}000777`, price: 100 }] })).rejects.toMatchObject({ details: { code: 'UNIT_NAMESPACE' } })
  })

  it('one job for several products is all-or-nothing', async () => {
    const a = await stockProduct(app, { name: 'A', qty: 3 })
    const b = await stockProduct(app, { name: 'B', qty: 1 })
    await expect(U(app, 'issueLabels', { items: [{ variantId: a.variantId, count: 2 }, { variantId: b.variantId, count: 5 }] })).rejects.toMatchObject({ details: { code: 'LABELS_EXCEED_STOCK' } })
    expect(unitCount(app)).toBe(0)
    expect(productRow(app, a.productId).track_units).toBe(0)
    const r = await U(app, 'issueLabels', { items: [{ variantId: a.variantId, count: 2 }, { variantId: b.variantId, count: 1 }] })
    expect(r.total).toBe(3)
    expect(r.items.map((i: any) => i.codes.length)).toEqual([2, 1])
  })

  it('labelPlan previews the next numbers without reserving anything', async () => {
    const p = await stockProduct(app, { qty: 4 })
    const before = await U(app, 'labelPlan', { variantId: p.variantId, count: 3 })
    expect(before).toMatchObject({ mode: 'unique', tracked: false, unlabelled: 4, stock: 4, blocked: null })
    expect(unitCount(app)).toBe(0)
    expect(productRow(app, p.productId).track_units).toBe(0)
    const codes = await issue(app, p.variantId, 3)
    expect(before.previewCodes).toEqual(codes)
    const after = await U(app, 'labelPlan', { variantId: p.variantId, count: 3 })
    expect(after).toMatchObject({ tracked: true, unlabelled: 1 })
    expect(after.previewCodes.map((c: string) => Number(c.slice(4)))).toEqual([4, 5, 6])
    // a product that does not track stock keeps the shared product barcode on its labels
    const svc = await CAT(app, 'save', { name: 'Service', trackStock: false, variants: [{ name: '', price: 100 }] })
    expect(await U(app, 'labelPlan', { variantId: svc.variants[0].id })).toMatchObject({ mode: 'shared' })
    await expect(issue(app, svc.variants[0].id, 1)).rejects.toMatchObject({ details: { code: 'NOT_STOCK_TRACKED' } })
  })

  it('a failed job burns no number: the next print starts where the last good one stopped', async () => {
    const p = await stockProduct(app, { qty: 3 })
    await issue(app, p.variantId, 2)
    await expect(issue(app, p.variantId, 9)).rejects.toBeTruthy()
    await expect(U(app, 'issueLabels', { items: [{ variantId: p.variantId, count: 0 }] })).rejects.toMatchObject({ code: 'VALIDATION' })
    expect((await issue(app, p.variantId, 1)).map((c) => Number(c.slice(4)))).toEqual([3])
  })
})

describe('no reuse after the app is closed and opened again', () => {
  it('numbers continue from the database, not from memory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'velmayil-labels-'))
    const dbPath = join(dir, 'pos.db')
    const first = createTestApp({ dbPath, userDataDir: dir })
    const p = await stockProduct(first, { qty: 6 })
    const a = await issue(first, p.variantId, 2)
    const session = first.session
    first.close()

    const second = new App({ dbPath, userDataDir: dir })
    registerAllModules(second)
    second.session = session
    const b = await issue(second, p.variantId, 2)
    expect(b.map((c) => Number(c.slice(4)))).toEqual([3, 4])
    expect(b[0].slice(0, 4)).toBe(a[0].slice(0, 4))
    second.close()

    const third = new App({ dbPath, userDataDir: dir })
    registerAllModules(third)
    third.session = session
    // extra pieces received while printing also continue the same counter
    const c = await issue(third, p.variantId, 4, { receiveExtra: true })
    expect(c.map((x) => Number(x.slice(4)))).toEqual([5, 6, 7, 8])
    expect(new Set([...a, ...b, ...c]).size).toBe(8)
    expect(third.db.value('SELECT last_seq FROM unit_sequences WHERE prefix=?', a[0].slice(0, 4))).toBe(8)
    third.close()
  })
})

describe('reprinting a damaged label', () => {
  it('prints the existing number again and never creates a new one', async () => {
    const p = await stockProduct(app, { qty: 3 })
    const codes = await issue(app, p.variantId, 2)
    const prefix = codes[0].slice(0, 4)
    const units = unitCount(app)
    const seq = app.db.value<number>('SELECT last_seq FROM unit_sequences WHERE prefix=?', prefix)
    const firstPrint = printed(app, codes[0])
    const r = await U(app, 'reprintLabels', { codes: [codes[0], ` ${codes[0]} `] })
    expect(r.codes).toEqual([codes[0]])
    expect(unitCount(app)).toBe(units)
    expect(app.db.value<number>('SELECT last_seq FROM unit_sequences WHERE prefix=?', prefix)).toBe(seq)
    expect(printed(app, codes[0])).toBe(firstPrint)
    expect(stockAt(app, p.variantId)).toBe(3)
    // the next NEW label still gets the next number
    expect((await issue(app, p.variantId, 1)).map((c) => Number(c.slice(4)))).toEqual([3])
  })

  it('refuses a number that was never issued, and a void one', async () => {
    const p = await stockProduct(app, { qty: 2 })
    const codes = await issue(app, p.variantId, 2)
    const never = `${codes[0].slice(0, 4)}000777`
    await expect(U(app, 'reprintLabels', { codes: [never] })).rejects.toMatchObject({ code: 'NOT_FOUND', details: { code: 'UNIT_NOT_FOUND' } })
    expect(unitCount(app)).toBe(2)
    await U(app, 'markVoid', { codes: [codes[1]], reason: 'damaged in store' })
    await expect(U(app, 'reprintLabels', { codes: [codes[1]] })).rejects.toMatchObject({ details: { code: 'UNIT_NOT_AVAILABLE' } })
  })

  it('reprinting a sold label is allowed but does not make it sellable again', async () => {
    const p = await stockProduct(app, { qty: 1 })
    const [code] = await issue(app, p.variantId, 1)
    await cashSale(app, [{ variantId: p.variantId, qty: 1, unitCodes: [code] }])
    await U(app, 'reprintLabels', { codes: [code] })
    await expect(POS(app, 'scan', { code })).rejects.toMatchObject({ details: { code: 'UNIT_NOT_AVAILABLE', status: 'sold' } })
  })
})

describe('more labels than unlabelled stock', () => {
  it('is refused without changing anything, naming the numbers', async () => {
    const p = await stockProduct(app, { qty: 2 })
    await expect(issue(app, p.variantId, 5)).rejects.toMatchObject({ code: 'CONFLICT', details: { code: 'LABELS_EXCEED_STOCK', requested: 5, unlabelled: 2, extra: 3 } })
    expect(stockAt(app, p.variantId)).toBe(2)
    expect(unitCount(app)).toBe(0)
    expect(productRow(app, p.productId)).toMatchObject({ track_units: 0, unit_prefix: null })
    expect(count(app, 'SELECT COUNT(*) FROM stock_adjustments')).toBe(0)
  })

  it('with receiveExtra the extra pieces are received through the normal stock adjustment, in the same transaction', async () => {
    const p = await stockProduct(app, { qty: 2 })
    const codes = await issue(app, p.variantId, 5, { receiveExtra: true })
    expect(codes.map((c) => Number(c.slice(4)))).toEqual([1, 2, 3, 4, 5])
    expect(stockAt(app, p.variantId)).toBe(5)
    await assertInvariant(app)
    const adj = app.db.get<{ qty_delta: number; reason: string }>('SELECT qty_delta, reason FROM stock_adjustments')!
    expect(adj).toMatchObject({ qty_delta: 3, reason: 'found' })
    expect(count(app, "SELECT COUNT(*) FROM stock_movements WHERE variant_id=? AND type='adjustment' AND qty_delta=3", p.variantId)).toBe(1)
    // zero stock: everything asked for is received
    const z = await stockProduct(app, { name: 'Empty', qty: 0 })
    await expect(issue(app, z.variantId, 2)).rejects.toMatchObject({ details: { code: 'LABELS_EXCEED_STOCK', unlabelled: 0, extra: 2 } })
    expect((await issue(app, z.variantId, 2, { receiveExtra: true })).length).toBe(2)
    expect(stockAt(app, z.variantId)).toBe(2)
    await assertInvariant(app)
  })

  it('receiving the extra pieces needs the stock adjustment permission; plain printing does not', async () => {
    const p = await stockProduct(app, { qty: 2 })
    actAs(app, 'Cashier')
    await expect(issue(app, p.variantId, 3, { receiveExtra: true })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(stockAt(app, p.variantId)).toBe(2)
    expect(unitCount(app)).toBe(0)
    expect(await issue(app, p.variantId, 2)).toHaveLength(2)
  })

  it('negative stock must be corrected first (nothing is guessed)', async () => {
    const p = await stockProduct(app, { qty: 0 })
    app.moveStock({ variantId: p.variantId, delta: -2, type: 'adjustment', allowNegative: true })
    await expect(issue(app, p.variantId, 1, { receiveExtra: true })).rejects.toMatchObject({ details: { code: 'NEGATIVE_STOCK' } })
    expect(unitCount(app)).toBe(0)
  })
})

describe('billing with unique labels', () => {
  it('a label is added once; a second scan on the same bill is a duplicate; a sold label is refused', async () => {
    const p = await stockProduct(app, { qty: 3, barcode: '200000001' })
    const [c1, c2] = await issue(app, p.variantId, 3)

    // scan -> the server resolves the label to its own unit
    const s = await POS(app, 'scan', { code: c1 })
    expect(s.variantId).toBe(p.variantId)
    expect(s.unit).toMatchObject({ code: c1, status: 'in_stock' })
    expect(classifyScan(s)).toBe('unit')

    // the bill (active list): first scan adds, the second is refused
    const list = createScanList()
    let n = 0
    const key = () => `k${++n}`
    const first = addUnit([], list, s, c1, key)
    expect(first.result).toBe('added')
    const again = addUnit(first.lines, list, s, c1, key)
    expect(again.result).toBe('duplicate')
    expect(again.lines).toBe(first.lines)
    expect(isLocalDuplicate(list, c1)).toBe(true)
    expect(saleLinePayload(first.lines[0])).toMatchObject({ qty: 1, unitCodes: [c1] })

    // the server applies the same rule, whatever the screen sends
    await expect(cashSale(app, [{ variantId: p.variantId, qty: 2, unitCodes: [c1, c1] }])).rejects.toMatchObject({ details: { code: 'UNIT_DUPLICATE', unitCode: c1 } })
    await expect(cashSale(app, [{ variantId: p.variantId, qty: 1, unitCodes: [c1] }, { variantId: p.variantId, qty: 1, unitCodes: [c1] }])).rejects.toMatchObject({ details: { code: 'UNIT_DUPLICATE' } })
    expect(stockAt(app, p.variantId)).toBe(3)

    await cashSale(app, [{ variantId: p.variantId, qty: 1, unitCodes: [c1] }])
    expect(statusOf(app, c1)).toBe('sold')
    expect(stockAt(app, p.variantId)).toBe(2)
    // the same label on a later bill
    await expect(POS(app, 'scan', { code: c1 })).rejects.toMatchObject({ code: 'CONFLICT', message: `Unit ${c1} is already sold`, details: { code: 'UNIT_NOT_AVAILABLE', status: 'sold' } })
    await expect(cashSale(app, [{ variantId: p.variantId, qty: 1, unitCodes: [c1] }])).rejects.toMatchObject({ details: { code: 'UNIT_NOT_AVAILABLE' } })
    expect(stockAt(app, p.variantId)).toBe(2)
    // the other label still sells
    await cashSale(app, [{ variantId: p.variantId, qty: 1, unitCodes: [c2] }])
    await assertInvariant(app)
  })

  it('a void sale puts the label back on the shelf; a return restocks or writes it off', async () => {
    const p = await stockProduct(app, { qty: 2 })
    const [c1, c2] = await issue(app, p.variantId, 2)
    const sale = await cashSale(app, [{ variantId: p.variantId, qty: 2, unitCodes: [c1, c2] }])
    await POS(app, 'voidSale', { saleId: sale.saleId, reason: 'wrong customer' })
    expect(availCodes(app, p.variantId)).toEqual([c1, c2])
    expect((await POS(app, 'scan', { code: c1 })).unit).toMatchObject({ status: 'in_stock' })
    await assertInvariant(app)
  })
})

describe('quantity by "+" on the bill (units.nextAvailable)', () => {
  it('names the next pieces in stock, skips the ones on the bill, unlabelled pieces first, and the sale goes through', async () => {
    const p = await stockProduct(app, { qty: 5, barcode: '200000031' })
    const [c1, c2] = await issue(app, p.variantId, 2) // 2 pieces with a printed label, 3 without
    const all = availCodes(app, p.variantId)
    expect(all).toHaveLength(5)
    const unlabelled = all.filter((c) => c !== c1 && c !== c2)

    // c1 was scanned; "+" twice
    const one = await U(app, 'nextAvailable', { variantId: p.variantId, exclude: [c1] })
    expect(one.codes).toEqual([unlabelled[0]])
    expect(one.left).toBe(3)
    const two = await U(app, 'nextAvailable', { variantId: p.variantId, exclude: [c1, ...one.codes] })
    expect(two.codes).toEqual([unlabelled[1]])
    // a typed quantity asks for several at once; more than there is gives what there is
    const many = await U(app, 'nextAvailable', { variantId: p.variantId, exclude: [c1], count: 10 })
    expect(many.codes).toEqual([...unlabelled, c2])
    expect(many.left).toBe(0)

    await cashSale(app, [{ variantId: p.variantId, qty: 3, unitCodes: [c1, ...one.codes, ...two.codes] }])
    expect(stockAt(app, p.variantId)).toBe(2)
    expect(statusOf(app, unlabelled[0])).toBe('sold')
    // sold pieces are never offered again
    expect((await U(app, 'nextAvailable', { variantId: p.variantId, count: 10 })).codes).toEqual([unlabelled[2], c2])
    await assertInvariant(app)
  })
  it('nothing left: an empty answer, never an error', async () => {
    const p = await stockProduct(app, { qty: 1 })
    const [c1] = await issue(app, p.variantId, 1)
    expect(await U(app, 'nextAvailable', { variantId: p.variantId, exclude: [c1] })).toEqual({ codes: [], left: 0 })
  })
})

describe('old labels with the shared product barcode', () => {
  it('are accepted while unlabelled stock exists, consume one such piece per sale, and are refused afterwards', async () => {
    const p = await stockProduct(app, { qty: 3, barcode: '200000001' })
    const labelled = await issue(app, p.variantId, 1) // 1 piece has its own label, 2 still carry the old shared one

    let s = await POS(app, 'scan', { code: '200000001' })
    expect(s).toMatchObject({ variantId: p.variantId, trackUnits: true, unlabelledUnits: 2 })
    expect(classifyScan(s)).toBe('tracked-product')
    expect(legacyScanAllowed([], s, 1)).toBe(true)

    await cashSale(app, [{ variantId: p.variantId, qty: 1 }])
    expect(stockAt(app, p.variantId)).toBe(2)
    expect(statusOf(app, labelled[0])).toBe('in_stock') // the labelled piece was not touched
    expect(count(app, "SELECT COUNT(*) FROM product_units WHERE variant_id=? AND status='sold' AND label_printed_at IS NULL", p.variantId)).toBe(1)
    await assertInvariant(app)

    s = await POS(app, 'scan', { code: '200000001' })
    expect(s.unlabelledUnits).toBe(1)
    // two shared-barcode pieces on one bill, only one left
    await expect(cashSale(app, [{ variantId: p.variantId, qty: 2 }])).rejects.toMatchObject({ code: 'VALIDATION', details: { code: 'UNIT_CODES_REQUIRED', unlabelled: 1 } })
    await cashSale(app, [{ variantId: p.variantId, qty: 1 }])

    // every piece left has its own label: the shared barcode is refused with the existing hint
    s = await POS(app, 'scan', { code: '200000001' })
    expect(s).toMatchObject({ trackUnits: true, unlabelledUnits: 0 })
    expect(legacyScanAllowed([], s, 1)).toBe(false)
    await expect(cashSale(app, [{ variantId: p.variantId, qty: 1 }])).rejects.toMatchObject({ details: { code: 'UNIT_CODES_REQUIRED' } })
    expect(stockAt(app, p.variantId)).toBe(1)
    await cashSale(app, [{ variantId: p.variantId, qty: 1, unitCodes: labelled }])
    expect(stockAt(app, p.variantId)).toBe(0)
    await assertInvariant(app)
  })

  it('a bill can mix own-label pieces and shared-barcode pieces of one product without selling a piece twice', async () => {
    const p = await stockProduct(app, { qty: 4, barcode: '200000001' })
    const [c1, c2] = await issue(app, p.variantId, 2)
    const sale = await cashSale(app, [{ variantId: p.variantId, qty: 1, unitCodes: [c1] }, { variantId: p.variantId, qty: 2 }])
    expect(stockAt(app, p.variantId)).toBe(1)
    expect(availCodes(app, p.variantId)).toEqual([c2])
    expect(count(app, 'SELECT COUNT(DISTINCT id) FROM product_units WHERE sale_id=?', sale.saleId)).toBe(3)
    // one line: 1 scanned label + 1 more by quantity is refused once no unlabelled piece is left
    await expect(cashSale(app, [{ variantId: p.variantId, qty: 2, unitCodes: [c2] }])).rejects.toMatchObject({ details: { code: 'UNIT_QTY_MISMATCH' } })
    await assertInvariant(app)
  })

  it('the bill screen rule: the shared barcode is allowed only up to the unlabelled pieces not yet on the bill', () => {
    const v = { variantId: 7, trackUnits: true, unlabelledUnits: 2 }
    const line = (qty: number, tracked = false): CartLine => ({ key: `k${qty}${tracked}`, variantId: 7, name: 'X', sku: 'X', qty, price: 100, overridePrice: null, discount: null, taxRateBp: 0, trackStock: true, stock: 5, tracked, unitCodes: tracked ? ['2000000001'] : undefined })
    expect(legacyScanAllowed([], v, 1)).toBe(true)
    expect(legacyScanAllowed([], v, 2)).toBe(true)
    expect(legacyScanAllowed([], v, 3)).toBe(false)
    expect(legacyScanAllowed([line(1)], v, 1)).toBe(true)
    expect(legacyScanAllowed([line(2)], v, 1)).toBe(false)
    expect(legacyScanAllowed([line(1, true)], v, 2)).toBe(true) // a scanned own-label line does not use up unlabelled pieces
    expect(legacyScanAllowed([], { variantId: 7, trackUnits: true }, 1)).toBe(false)
    expect(legacyScanAllowed([], { variantId: 7, trackUnits: true, unlabelledUnits: 0 }, 1)).toBe(false)
  })

  it('new stock that arrives later is unlabelled until its labels are printed', async () => {
    const p = await stockProduct(app, { qty: 1, barcode: '200000001' })
    await issue(app, p.variantId, 1)
    expect((await POS(app, 'scan', { code: '200000001' })).unlabelledUnits).toBe(0)
    const pur = await PUR(app, 'create', { items: [{ variantId: p.variantId, qty: 2, unitCost: 1000 }] })
    expect(pur.items[0].unitCodes).toHaveLength(2)
    expect((await POS(app, 'scan', { code: '200000001' })).unlabelledUnits).toBe(2)
    // printing takes exactly those numbers (no new ones) and closes the shared barcode again
    expect(await issue(app, p.variantId, 2)).toEqual(pur.items[0].unitCodes)
    expect((await POS(app, 'scan', { code: '200000001' })).unlabelledUnits).toBe(0)
    await assertInvariant(app)
  })

  it('stock adjustments, transfers and counts handle unlabelled pieces by quantity and labelled ones by scanning', async () => {
    const p = await stockProduct(app, { qty: 6, barcode: '200000001' })
    const [c1, c2] = await issue(app, p.variantId, 2) // 2 labelled, 4 unlabelled
    // write off 1 unlabelled piece without naming a code
    const adj = await INV(app, 'adjust', { variantId: p.variantId, delta: -1, reason: 'damage' })
    expect(adj.unitCodes).toHaveLength(1)
    expect(adj.unitCodes[0]).not.toBe(c1)
    expect(stockAt(app, p.variantId)).toBe(5)
    // more than the unlabelled pieces: the labelled ones must be scanned
    await expect(INV(app, 'adjust', { variantId: p.variantId, delta: -4, reason: 'damage' })).rejects.toMatchObject({ details: { code: 'UNIT_CODES_REQUIRED' } })
    await assertInvariant(app)

    // transfer: 1 scanned label + 1 unlabelled piece
    const loc2 = app.db.run('INSERT INTO locations(uuid,name) VALUES (?,?)', app.uuid(), 'Godown').lastId
    await INV(app, 'transferCreate', { fromLocationId: app.defaultLocationId(), toLocationId: loc2, items: [{ variantId: p.variantId, qty: 2, unitCodes: [c1] }] })
    expect(stockAt(app, p.variantId)).toBe(3)
    expect(stockAt(app, p.variantId, loc2)).toBe(2)
    expect(app.db.value('SELECT location_id FROM product_units WHERE code=?', c1)).toBe(loc2)
    await assertInvariant(app)

    // count at the main store: c2 (labelled) + 2 unlabelled expected; scan the label, scan the shared barcode once -> 1 unlabelled missing
    const cnt = await INV(app, 'countCreate', {})
    expect((await INV(app, 'countScan', { countId: cnt.id, code: c2 })).countedQty).toBe(1)
    expect((await INV(app, 'countScan', { countId: cnt.id, code: c2 })).duplicate).toBe(true)
    expect((await INV(app, 'countScan', { countId: cnt.id, code: '200000001' })).countedQty).toBe(2)
    await expect(INV(app, 'countSet', { countId: cnt.id, entries: [{ variantId: p.variantId, countedQty: 9 }] })).rejects.toMatchObject({ details: { code: 'UNIT_CODE_REQUIRED' } })
    const applied = await INV(app, 'countApply', { countId: cnt.id })
    expect(applied.missingUnits).toHaveLength(1)
    expect(applied.missingUnits[0]).not.toBe(c2)
    expect(stockAt(app, p.variantId)).toBe(2)
    expect(statusOf(app, c2)).toBe('in_stock')
    await assertInvariant(app)
  })
})

describe('label dialog helpers and the screens around it', () => {
  it('splits a job into unique-number products and shared-barcode products, and words the stock question', async () => {
    const plan = (variantId: number, mode: 'unique' | 'shared'): LabelPlan => ({ variantId, displayName: `P${variantId}`, mode, tracked: false, prefix: null, stock: 0, unlabelled: 0, previewCodes: [], blocked: null, canReceive: true })
    expect(splitPlans([1, 2, 3], [plan(1, 'unique'), plan(2, 'shared'), plan(3, 'unique')])).toEqual({ unique: [1, 3], shared: [2] })
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
    expect(codeRangeText(['2000000190'])).toBe('2000000190')
    expect(codeRangeText(['2000000190', '2000000191', '2000000192'])).toBe('2000000190 to 2000000192 (3)')
    // the real error of the server feeds the dialog
    const p = await stockProduct(app, { name: 'Rocket', qty: 2 })
    const err = await issue(app, p.variantId, 5).catch((e) => e)
    const short = shortfallsOf(err)!
    expect(short).toEqual([{ variantId: p.variantId, name: 'Rocket', requested: 5, unlabelled: 2, extra: 3 }])
    expect(shortfallExtra(short)).toBe(3)
    expect(shortfallLines(short)).toEqual(['Rocket: only 2 pieces in stock have no label yet, but 5 labels were asked for.'])
    expect(shortfallLines([{ ...short[0], unlabelled: 0 }])[0]).toMatch(/no piece in stock is waiting for a label/)
    expect(shortfallsOf(new Error('printer offline'))).toBeNull()
  })

  it('printing.renderLabelHtml draws one label per issued number (digits only, product name and price)', async () => {
    const p = await stockProduct(app, { name: 'Rocket', qty: 3, barcode: '200000001' })
    const codes = await issue(app, p.variantId, 3)
    const r = (await app.call('printing', 'renderLabelHtml', { template: 'label_barcode', unitCodes: codes, copies: 1 })) as { html: string; warnings?: string[] }
    for (const c of codes) expect(r.html).toContain(c)
    expect(r.html).toContain('Rocket')
    expect(r.html).not.toContain('200000001<') // the shared product barcode is not what these labels carry
    expect(r.warnings ?? []).toEqual([])
    expect((r.html.match(/class="barcode"|<svg[^>]*barcode/g) ?? []).length).toBeGreaterThanOrEqual(3)
  })

  it('inventory.lookup reports the unlabelled pieces at a location; a typed count total covers scanned + unlabelled', async () => {
    const p = await stockProduct(app, { qty: 4, barcode: '200000001' })
    const [c1] = await issue(app, p.variantId, 1)
    expect(await INV(app, 'lookup', { code: '200000001' })).toMatchObject({ variantId: p.variantId, trackUnits: true, unlabelledUnits: 3, qtyAtLocation: 4 })
    const cnt = await INV(app, 'countCreate', {})
    await INV(app, 'countScan', { countId: cnt.id, code: c1 })
    await INV(app, 'countSet', { countId: cnt.id, entries: [{ variantId: p.variantId, countedQty: 4 }] }) // 1 scanned + 3 unlabelled
    await expect(INV(app, 'countSet', { countId: cnt.id, entries: [{ variantId: p.variantId, countedQty: 5 }] })).rejects.toMatchObject({ details: { code: 'UNIT_CODE_REQUIRED' } })
    const applied = await INV(app, 'countApply', { countId: cnt.id })
    expect(applied.missingUnits).toEqual([])
    expect(stockAt(app, p.variantId)).toBe(4)
    await assertInvariant(app)
  })

  it('the product barcode generator and the label prefixes never share a number range', async () => {
    // "Barcode numbering" set to 10-digit numbers starting 200...: label prefixes 2000-2009 are left to it
    app.setSetting('catalog.barcode_mode', 'sequence')
    app.setSetting('catalog.barcode_prefix', '200')
    app.setSetting('catalog.barcode_width', '7')
    const p = await stockProduct(app, { qty: 1 })
    const [code] = await issue(app, p.variantId, 1)
    expect(code.startsWith('200')).toBe(false)
    expect(code).toMatch(/^[1-9]\d{9}$/)
  })
})

describe('older PREFIX-NNNN codes', () => {
  it('still resolve, sell once and are refused when sold; their products stay strict', async () => {
    const p = await trackedProduct(app, { prefix: 'SPK', qty: 3, barcode: '200000009' })
    expect(availCodes(app, p.variantId)).toEqual(['SPK-0001', 'SPK-0002', 'SPK-0003'])
    const s = await POS(app, 'scan', { code: 'spk-0002 ' })
    expect(s.unit).toMatchObject({ code: 'SPK-0002', status: 'in_stock' })
    await cashSale(app, [{ variantId: p.variantId, qty: 1, unitCodes: ['SPK-0002'] }])
    await expect(POS(app, 'scan', { code: 'SPK-0002' })).rejects.toMatchObject({ details: { code: 'UNIT_NOT_AVAILABLE', status: 'sold' } })
    // the owner ticked "track each unit" for this product: its shared barcode is never accepted, as before
    expect(await POS(app, 'scan', { code: '200000009' })).toMatchObject({ trackUnits: true, unlabelledUnits: 0 })
    await expect(cashSale(app, [{ variantId: p.variantId, qty: 1 }])).rejects.toMatchObject({ details: { code: 'UNIT_CODES_REQUIRED' } })
    // new codes for a letter prefix keep the old spelling and the 9999 limit
    const g = await PUR(app, 'create', { items: [{ variantId: p.variantId, qty: 1, unitCost: 1000 }] })
    expect(g.items[0].unitCodes).toEqual(['SPK-0004'])
    await assertInvariant(app)
  })

  it('both spellings live side by side in one database', async () => {
    const old = await trackedProduct(app, { prefix: 'RKT', qty: 1 })
    const p = await stockProduct(app, { qty: 1 })
    const [code] = await issue(app, p.variantId, 1)
    expect((await U(app, 'resolve', { code: 'RKT-0001' })).variant.variantId).toBe(old.variantId)
    expect((await U(app, 'resolve', { code })).variant.variantId).toBe(p.variantId)
    await cashSale(app, [{ variantId: old.variantId, qty: 1, unitCodes: ['RKT-0001'] }, { variantId: p.variantId, qty: 1, unitCodes: [code] }])
    expect(statusOf(app, 'RKT-0001')).toBe('sold')
    expect(statusOf(app, code)).toBe('sold')
  })
})

describe('LAN sync client mode', () => {
  it('a client refuses to issue label numbers and says to print on the admin system', async () => {
    const p = await stockProduct(app, { qty: 3 })
    const admin = await issue(app, p.variantId, 1)
    app.setSetting('sync.role', 'client')
    await expect(issue(app, p.variantId, 1)).rejects.toMatchObject({ code: 'FORBIDDEN', message: expect.stringMatching(/admin system/i), details: { code: 'LABELS_ADMIN_ONLY' } })
    expect(count(app, 'SELECT COUNT(*) FROM product_units WHERE label_printed_at IS NOT NULL')).toBe(1)
    expect((await U(app, 'labelPlan', { variantId: p.variantId })).blocked).toMatch(/admin system/i)
    // a product that never had labels is not switched to unit tracking either
    const q = await stockProduct(app, { name: 'Other', qty: 2 })
    await expect(issue(app, q.variantId, 1, { receiveExtra: true })).rejects.toMatchObject({ details: { code: 'LABELS_ADMIN_ONLY' } })
    expect(productRow(app, q.productId).track_units).toBe(0)
    // no path on a client creates a number: receiving stock of a unit-tracked product is refused the same way
    await expect(PUR(app, 'create', { items: [{ variantId: p.variantId, qty: 1, unitCost: 1000 }] })).rejects.toMatchObject({ details: { code: 'LABELS_ADMIN_ONLY' } })
    expect(stockAt(app, p.variantId)).toBe(3)
    // what a client CAN do: reprint an existing number, and sell
    expect((await U(app, 'reprintLabels', { codes: admin })).codes).toEqual(admin)
    await cashSale(app, [{ variantId: p.variantId, qty: 1, unitCodes: admin }])
    await cashSale(app, [{ variantId: p.variantId, qty: 1 }])
    // ordinary products are unaffected on a client
    await PUR(app, 'create', { items: [{ variantId: q.variantId, qty: 1, unitCost: 1000 }] })
    expect(stockAt(app, q.variantId)).toBe(3)
  })

  it('standalone and admin issue numbers', async () => {
    const p = await stockProduct(app, { qty: 4 })
    expect(await issue(app, p.variantId, 1)).toHaveLength(1)
    app.setSetting('sync.role', 'admin')
    expect(await issue(app, p.variantId, 1)).toHaveLength(1)
    app.setSetting('sync.role', 'standalone')
    expect(await issue(app, p.variantId, 1)).toHaveLength(1)
  })
})

describe('permissions and validation', () => {
  it('needs a signed-in user with a catalog or stock permission', async () => {
    const p = await stockProduct(app, { qty: 2 })
    const saved = app.session
    app.session = null
    await expect(issue(app, p.variantId, 1)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' })
    app.session = { ...saved!, permissions: ['pos.sell'] }
    await expect(issue(app, p.variantId, 1)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(U(app, 'labelPlan', { variantId: p.variantId })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    app.session = saved
    await expect(U(app, 'issueLabels', { items: [] })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(U(app, 'issueLabels', { items: [{ variantId: p.variantId, count: 1 }, { variantId: p.variantId, count: 1 }] })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(U(app, 'issueLabels', { items: [{ variantId: 99999, count: 1 }] })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(U(app, 'reprintLabels', { codes: [] })).rejects.toMatchObject({ code: 'VALIDATION' })
  })
})

describe('migration 910', () => {
  it('keeps existing units, widens the suffix to 999999 and keeps the guards', () => {
    const db = new Db(':memory:')
    const all = allMigrations()
    runMigrations(db, all.filter((m) => m.version < 910))
    // a database as it is in the shop today: one ticked product with PREFIX-NNNN units, one sold
    db.run("INSERT INTO products(uuid,name,track_units,unit_prefix) VALUES ('p1','Sparkler',1,'SPK')")
    const pid = db.value<number>('SELECT id FROM products')!
    db.run("INSERT INTO product_variants(uuid,product_id,sku) VALUES ('v1',?,'SKU1')", pid)
    const vid = db.value<number>('SELECT id FROM product_variants')!
    db.run("INSERT INTO product_units(uuid,variant_id,prefix,seq,code,status,created_at,updated_at) VALUES ('u1',?,'SPK',1,'SPK-0001','in_stock',111,222)", vid)
    db.run("INSERT INTO product_units(uuid,variant_id,prefix,seq,code,status,created_at,updated_at) VALUES ('u2',?,'SPK',2,'SPK-0002','sold',333,444)", vid)
    db.run("INSERT INTO unit_sequences(prefix,last_seq) VALUES ('SPK',2)")
    expect(() => db.run("INSERT INTO product_units(uuid,variant_id,prefix,seq,code) VALUES ('u3',?,'2000',10000,'2000010000')", vid)).toThrow(/CHECK/)
    const before = db.all('SELECT id,uuid,variant_id,prefix,seq,code,status,created_at,updated_at FROM product_units ORDER BY id')

    expect(runMigrations(db, all.filter((m) => m.version <= 910))).toEqual([910])
    expect(db.all('SELECT id,uuid,variant_id,prefix,seq,code,status,created_at,updated_at FROM product_units ORDER BY id')).toEqual(before)
    // units that existed before are taken as labelled; the product stays strict
    expect(db.all<{ label_printed_at: number }>('SELECT label_printed_at FROM product_units ORDER BY id').map((r) => r.label_printed_at)).toEqual([111, 333])
    expect(db.value('SELECT unit_auto FROM products')).toBe(0)
    expect(db.value("SELECT last_seq FROM unit_sequences WHERE prefix='SPK'")).toBe(2)
    // the wider suffix
    db.run("INSERT INTO product_units(uuid,variant_id,prefix,seq,code) VALUES ('u3',?,'2000',999999,'2000999999')", vid)
    db.run("INSERT INTO unit_sequences(prefix,last_seq) VALUES ('2000',999999)")
    expect(() => db.run("INSERT INTO product_units(uuid,variant_id,prefix,seq,code) VALUES ('u4',?,'2000',1000000,'20001000000')", vid)).toThrow(/CHECK/)
    expect(() => db.run("UPDATE unit_sequences SET last_seq=1000000 WHERE prefix='2000'")).toThrow(/CHECK/)
    // a PREFIX-NNNN prefix still stops at 9999 (never a 5th digit)
    expect(() => db.run("INSERT INTO product_units(uuid,variant_id,prefix,seq,code) VALUES ('u6',?,'SPK',10000,'SPK-10000')", vid)).toThrow(/CHECK/)
    expect(() => db.run("UPDATE unit_sequences SET last_seq=10000 WHERE prefix='SPK'")).toThrow(/CHECK/)
    // new ids continue after the old ones (AUTOINCREMENT was carried over)
    expect(db.value<number>("SELECT id FROM product_units WHERE uuid='u3'")).toBe(3)
    // guards: no delete, immutable code, unique code / (prefix, seq), codes stay out of the barcode namespace, frozen prefix
    expect(() => db.run("DELETE FROM product_units WHERE uuid='u1'")).toThrow(/never deleted/)
    expect(() => db.run("UPDATE product_units SET code='SPK-0009' WHERE uuid='u1'")).toThrow(/never change/)
    expect(() => db.run("INSERT INTO product_units(uuid,variant_id,prefix,seq,code) VALUES ('u5',?,'SPK',1,'SPK-0001')", vid)).toThrow(/UNIQUE/)
    expect(() => db.run("UPDATE product_variants SET barcode='2000999999' WHERE id=?", vid)).toThrow(/unit code/)
    expect(() => db.run("INSERT INTO variant_barcodes(barcode,variant_id) VALUES ('spk-0001',?)", vid)).toThrow(/unit code/)
    expect(() => db.run("UPDATE products SET unit_prefix='NEWP' WHERE id=?", pid)).toThrow(/cannot change/)
    expect(() => db.run('UPDATE products SET unit_auto=2 WHERE id=?', pid)).toThrow(/unit_auto/)
    db.run("UPDATE product_units SET status='sold', label_printed_at=5 WHERE uuid='u1'")
    // running everything again changes nothing
    expect(runMigrations(db, all.filter((m) => m.version <= 910))).toEqual([])
    db.close()
  })

  it('an upgraded database keeps selling its old codes through the services', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'velmayil-mig-'))
    const dbPath = join(dir, 'pos.db')
    const first = createTestApp({ dbPath, userDataDir: dir })
    const p = await trackedProduct(first, { prefix: 'SPK', qty: 2 })
    const session = first.session
    first.close()
    const again = new App({ dbPath, userDataDir: dir })
    registerAllModules(again)
    again.session = session
    expect((await POS(again, 'scan', { code: 'SPK-0001' })).unit).toMatchObject({ code: 'SPK-0001' })
    await cashSale(again, [{ variantId: p.variantId, qty: 1, unitCodes: ['SPK-0001'] }])
    expect(statusOf(again, 'SPK-0001')).toBe('sold')
    again.close()
  })
})

describe('sync apply accepts label numbers', () => {
  it('label numbers, the printed mark and the automatic tracking travel to another terminal', async () => {
    const b = createTestApp()
    const p = await stockProduct(app, { qty: 3, barcode: '200000001' })
    const codes = await issue(app, p.variantId, 2)
    const prefix = codes[0].slice(0, 4)
    const r = pipe(app, b)
    expect(r.statuses.filter((s) => s.startsWith('product_units')).some((s) => s.endsWith('applied'))).toBe(true)
    expect(r.statuses.filter((s) => s.endsWith('failed') || s.endsWith('conflict'))).toEqual([])
    expect(b.db.all('SELECT code, prefix, seq, status, uuid FROM product_units ORDER BY seq')).toEqual(app.db.all('SELECT code, prefix, seq, status, uuid FROM product_units ORDER BY seq'))
    expect(b.db.value('SELECT last_seq FROM unit_sequences WHERE prefix=?', prefix)).toBe(3)
    expect(b.db.get('SELECT track_units, unit_auto, unit_prefix FROM products WHERE unit_prefix=?', prefix)).toEqual({ track_units: 1, unit_auto: 1, unit_prefix: prefix })
    // the receiver knows which pieces have their own label
    expect(b.db.all<{ c: string }>('SELECT code AS c FROM product_units WHERE label_printed_at IS NOT NULL ORDER BY seq').map((x) => x.c)).toEqual(codes)
    // so billing behaves the same there: own labels scan, the shared barcode covers exactly the 1 unlabelled piece
    expect((await POS(b, 'scan', { code: codes[0] })).unit).toMatchObject({ code: codes[0], status: 'in_stock' })
    expect((await POS(b, 'scan', { code: '200000001' })).unlabelledUnits).toBe(1)
    // replay is a no-op
    const again = pipe(app, b)
    expect(again.statuses.filter((s) => s.startsWith('product_units')).every((s) => s.endsWith('skipped'))).toBe(true)
    expect(count(b, 'SELECT COUNT(*) FROM product_units')).toBe(3)
    // a high suffix (beyond the old 9999 limit) is accepted
    const u = app.db.get<Record<string, unknown>>('SELECT * FROM product_units WHERE code=?', codes[0])!
    const vb = b.db.value<string>('SELECT uuid FROM product_variants WHERE id=(SELECT variant_id FROM product_units LIMIT 1)')!
    const big = { ...u, id: undefined, uuid: 'big-unit', seq: 123456, code: `${prefix}123456`, updated_at: Date.now() }
    const { applyChange } = await import('../../src/main/modules/sync/apply')
    const res = applyChange(b, {
      device: 'dev-x', deviceCode: 'POS-09', deviceName: 'Other', qid: 1, entity: 'product_units', entityUuid: 'big-unit', op: 'upsert', createdAt: Date.now(),
      payload: { table: 'product_units', uuid: 'big-unit', row: big, refs: { variant_id: { table: 'product_variants', uuid: vb }, sale_id: null, sale_item_id: null, purchase_id: null, location_id: null } }
    } as never)
    expect(res.status).toBe('applied')
    expect(b.db.value('SELECT seq FROM product_units WHERE code=?', `${prefix}123456`)).toBe(123456)
    expect(b.db.value('SELECT last_seq FROM unit_sequences WHERE prefix=?', prefix)).toBe(123456)
    b.close()
  })

  it('a snapshot from a terminal that did not know about the print never clears the printed mark', async () => {
    const b = createTestApp()
    const p = await stockProduct(app, { qty: 1 })
    const [code] = await issue(app, p.variantId, 1)
    pipe(app, b)
    expect(b.db.value('SELECT label_printed_at FROM product_units WHERE code=?', code)).not.toBeNull()
    const u = b.db.get<Record<string, unknown>>('SELECT * FROM product_units WHERE code=?', code)!
    const vb = b.db.value<string>('SELECT uuid FROM product_variants LIMIT 1')!
    const { applyChange } = await import('../../src/main/modules/sync/apply')
    const res = applyChange(b, {
      device: 'dev-x', deviceCode: 'POS-09', deviceName: 'Other', qid: 2, entity: 'product_units', entityUuid: u.uuid, op: 'upsert', createdAt: Date.now(),
      payload: { table: 'product_units', uuid: u.uuid, row: { ...u, label_printed_at: null, updated_at: Number(u.updated_at) + 5000 }, refs: { variant_id: { table: 'product_variants', uuid: vb }, sale_id: null, sale_item_id: null, purchase_id: null, location_id: null } }
    } as never)
    expect(res.status).toBe('applied')
    expect(b.db.value('SELECT label_printed_at FROM product_units WHERE code=?', code)).not.toBeNull()
    b.close()
  })
})

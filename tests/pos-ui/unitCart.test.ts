import { describe, it, expect } from 'vitest'
import { createScanList } from '../../src/shared/scanList'
import { addUnit, classifyScan, isLocalDuplicate, listFromLines, lineWithCode, normalizeResumed, notAvailableMessage, removeLine, removeUnit, saleLinePayload, allUnitCodes } from '../../src/renderer/modules/pos/unitCart'
import type { CartLine, Variant } from '../../src/renderer/modules/pos/types'

const V = (id: number, name = `P${id}`): Variant => ({
  variantId: id, productId: id, productName: name, variantName: '', displayName: name, sku: `S${id}`, barcode: null, hsn: '', taxRateBp: 0,
  mrp: 100, price: 100, cost: 50, unit: 'pc', trackStock: true, stock: 10, trackUnits: true
})
let n = 0
const key = () => `k${++n}`

describe('unit lines on the bill (active list = the bill)', () => {
  it('adds a new unit as a tracked line, merges the next unit of the same variant', () => {
    const list = createScanList()
    const a = addUnit([], list, V(1), 'SPK-0001', key)
    expect(a.result).toBe('added')
    expect(a.lines).toHaveLength(1)
    expect(a.lines[0]).toMatchObject({ tracked: true, qty: 1, unitCodes: ['SPK-0001'] })
    const b = addUnit(a.lines, list, V(1), 'spk-0002 ', key)
    expect(b.lines).toHaveLength(1)
    expect(b.lines[0]).toMatchObject({ qty: 2, unitCodes: ['SPK-0001', 'SPK-0002'] })
    const c = addUnit(b.lines, list, V(2), 'ABC-0001', key)
    expect(c.lines).toHaveLength(2)
  })

  it('duplicate: bill unchanged, points at the existing line', () => {
    const list = createScanList()
    const a = addUnit([], list, V(1), 'SPK-0001', key)
    const d = addUnit(a.lines, list, V(1), 'spk-0001', key)
    expect(d.result).toBe('duplicate')
    expect(d.lines).toBe(a.lines)
    expect(d.lineKey).toBe(a.lines[0].key)
    expect(isLocalDuplicate(list, 'SPK-0001')).toBe(true)
    expect(isLocalDuplicate(list, 'SPK-0009')).toBe(false)
    expect(isLocalDuplicate(list, '8901234567890')).toBe(false) // not unit format
  })

  it('removing a code (or a line) releases it so it can be scanned again; the last code removes the line', () => {
    const list = createScanList()
    let lines = addUnit([], list, V(1), 'SPK-0001', key).lines
    lines = addUnit(lines, list, V(1), 'SPK-0002', key).lines
    const k = lines[0].key
    lines = removeUnit(lines, list, k, 'SPK-0001')
    expect(lines[0]).toMatchObject({ qty: 1, unitCodes: ['SPK-0002'] })
    expect(addUnit(lines, list, V(1), 'SPK-0001', key).result).toBe('added')
    list.remove('SPK-0001') // the probe above registered it without keeping the lines
    lines = removeLine(lines, list, k)
    expect(lines).toEqual([])
    expect(list.size).toBe(0)
    const l2 = addUnit([], list, V(1), 'SPK-0003', key)
    expect(removeUnit(l2.lines, list, l2.lines[0].key, 'SPK-0003')).toEqual([])
  })

  it('sale payload: tracked lines send unitCodes with qty === length, plain lines are unchanged', () => {
    const list = createScanList()
    let lines = addUnit([], list, V(1), 'SPK-0001', key).lines
    lines = addUnit(lines, list, V(1), 'SPK-0002', key).lines
    expect(saleLinePayload(lines[0])).toEqual({ variantId: 1, qty: 2, unitPriceOverride: undefined, lineDiscount: null, unitCodes: ['SPK-0001', 'SPK-0002'] })
    const plain: CartLine = { key: 'p', variantId: 9, name: 'x', sku: 'x', qty: 3, price: 1, overridePrice: null, discount: null, taxRateBp: 0, trackStock: true, stock: 5 }
    expect(saleLinePayload(plain)).toEqual({ variantId: 9, qty: 3, unitPriceOverride: undefined, lineDiscount: null })
  })

  it('hold/resume: JSON round trip keeps the codes and rebuilds the scan list', () => {
    const list = createScanList()
    let lines = addUnit([], list, V(1), 'SPK-0001', key).lines
    lines = addUnit(lines, list, V(2), 'ABC-0007', key).lines
    const resumed = normalizeResumed(JSON.parse(JSON.stringify(lines)))
    const list2 = listFromLines(resumed)
    expect(allUnitCodes(resumed).sort()).toEqual(['ABC-0007', 'SPK-0001'])
    expect(list2.tryAdd('SPK-0001')).toBe('duplicate')
    expect(list2.tryAdd('SPK-0002')).toBe('added')
    expect(lineWithCode(resumed, 'abc-0007')?.variantId).toBe(2)
  })

  it('classifies scan responses and words the not-available message', () => {
    expect(classifyScan({ unit: { code: 'SPK-0001', status: 'in_stock' } })).toBe('unit')
    expect(classifyScan({ trackUnits: true })).toBe('tracked-product')
    expect(classifyScan({})).toBe('plain')
    expect(notAvailableMessage('spk-0003', 'sold')).toBe('SPK-0003 is already sold')
    expect(notAvailableMessage('SPK-0003', 'void')).toBe('SPK-0003 is already void')
  })
})

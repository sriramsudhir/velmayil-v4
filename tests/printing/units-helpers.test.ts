import { describe, it, expect } from 'vitest'
import { capacityText, generateRangeText, prefixError, sanitizePrefix, selectUnitsForPrint, unitCapacity, unitErrorMessage, validateGenerateCount, type UnitRow } from '../../src/renderer/modules/catalog/unitsModel'
import { createUnitList, isUnitCodeText, notFoundMessage } from '../../src/renderer/modules/inventory/unitScan'

const row = (n: number, status: UnitRow['status'] = 'in_stock', printedAt: number | null = null): UnitRow => ({ code: `SPK-${String(n).padStart(4, '0')}`, status, variantId: 1, saleId: null, printedAt })

describe('prefix helpers', () => {
  it('uppercases, strips symbols and caps at 8', () => {
    expect(sanitizePrefix('spk-1 x')).toBe('SPK1X')
    expect(sanitizePrefix('abcdefghijkl')).toBe('ABCDEFGH')
  })
  it('validates 2-8 chars A-Z0-9', () => {
    expect(prefixError('')).toMatch(/Enter a prefix/)
    expect(prefixError('A')).toMatch(/at least 2/)
    expect(prefixError('ab')).toMatch(/capital/)
    expect(prefixError('SPK')).toBeNull()
    expect(prefixError('SPARKLER9')).toMatch(/at most 8/)
  })
})

describe('capacity', () => {
  it('shows next code and remaining of 9999', () => {
    expect(unitCapacity('SPK', 0)).toEqual({ nextCode: 'SPK-0001', remaining: 9999, full: false })
    expect(unitCapacity('SPK', 9998)).toMatchObject({ nextCode: 'SPK-9999', remaining: 1 })
    expect(unitCapacity('SPK', 9999)).toEqual({ nextCode: null, remaining: 0, full: true })
    expect(capacityText('SPK', 3)).toContain('Next code: SPK-0004')
    expect(capacityText('SPK', 9999)).toMatch(/used/)
  })
  it('validates the generate count against the remaining capacity', () => {
    expect(validateGenerateCount('5', 0)).toEqual({ ok: true, count: 5 })
    expect(validateGenerateCount('0', 0)).toMatchObject({ ok: false })
    expect(validateGenerateCount('x', 0)).toMatchObject({ ok: false })
    expect(validateGenerateCount('10', 9995)).toMatchObject({ ok: false, message: expect.stringContaining('Only 4') })
    expect(validateGenerateCount('1', 9999)).toMatchObject({ ok: false, message: expect.stringContaining('limit') })
  })
  it('range text', () => {
    expect(generateRangeText('SPK', 1, 3)).toBe('SPK-0001 to SPK-0003')
    expect(generateRangeText('SPK', 7, 7)).toBe('SPK-0007')
  })
  it('maps backend errors to clear messages', () => {
    expect(unitErrorMessage({ code: 'UNIT_LIMIT_REACHED', message: 'x' })).toMatch(/9999 unit limit/)
    expect(unitErrorMessage({ details: { code: 'PREFIX_REQUIRED' } })).toMatch(/Set a prefix/)
    expect(unitErrorMessage(new Error('boom'))).toBe('boom')
  })
})

describe('selectUnitsForPrint', () => {
  const units = [row(1, 'in_stock', 100), row(2, 'sold'), row(3, 'void'), row(4, 'in_stock'), row(5, 'returned')]
  it('all / in stock / unprinted skip void units', () => {
    expect(selectUnitsForPrint(units, { mode: 'all' })).toEqual(['SPK-0001', 'SPK-0002', 'SPK-0004', 'SPK-0005'])
    expect(selectUnitsForPrint(units, { mode: 'in_stock' })).toEqual(['SPK-0001', 'SPK-0004'])
    expect(selectUnitsForPrint(units, { mode: 'unprinted' })).toEqual(['SPK-0002', 'SPK-0004', 'SPK-0005'])
  })
  it('range is inclusive and order-insensitive', () => {
    expect(selectUnitsForPrint(units, { mode: 'range', from: 4, to: 2 })).toEqual(['SPK-0002', 'SPK-0004'])
  })
})

describe('active list rule (unit list)', () => {
  it('adds a new code, flags a duplicate, normalises case', () => {
    const l = createUnitList('this count sheet')
    expect(l.claim('SPK-0001')).toBe('added')
    expect(l.claim(' spk-0001 ')).toBe('duplicate')
    expect(l.claim('SPK-0002')).toBe('added')
    expect(l.list.size).toBe(2)
    expect(l.duplicateText('spk-0001')).toBe('Duplicate entry: SPK-0001 is already in this count sheet. Not added again.')
  })
  it('release frees a code so it can be scanned again; releaseVariant frees a whole line', () => {
    const l = createUnitList('the list')
    l.claim('SPK-0001'); l.bind('SPK-0001', 7)
    l.claim('SPK-0002'); l.bind('SPK-0002', 7)
    l.claim('ABC-0001'); l.bind('ABC-0001', 8)
    expect(l.codesOf(7).sort()).toEqual(['SPK-0001', 'SPK-0002'])
    l.releaseVariant(7)
    expect(l.claim('SPK-0001')).toBe('added')
    expect(l.claim('ABC-0001')).toBe('duplicate')
    l.release('ABC-0001')
    expect(l.claim('ABC-0001')).toBe('added')
  })
  it('detects unit-code text and builds a not-found message with the exact code', () => {
    expect(isUnitCodeText('spk-0001')).toBe(true)
    expect(isUnitCodeText('8901234567890')).toBe(false)
    expect(notFoundMessage('spk-9999')).toContain('SPK-9999')
  })
})

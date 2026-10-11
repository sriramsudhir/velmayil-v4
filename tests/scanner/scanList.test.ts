import { describe, it, expect } from 'vitest'
import { createScanList, duplicateMessage, formatUnitCode, parseUnitCode } from '../../src/shared/scanList'

describe('scan list rule', () => {
  it('adds a new code, flags a duplicate, ignores case and whitespace', () => {
    const l = createScanList()
    expect(l.tryAdd('SPK-0001')).toBe('added')
    expect(l.tryAdd(' spk-0001 ')).toBe('duplicate')
    expect(l.tryAdd('SPK-0002')).toBe('added')
    expect(l.size).toBe(2)
    l.remove('spk-0001')
    expect(l.tryAdd('SPK-0001')).toBe('added')
  })
  it('formats and parses unit codes', () => {
    expect(formatUnitCode('spk', 7)).toBe('SPK-0007')
    expect(formatUnitCode('RKT', 9999)).toBe('RKT-9999')
    expect(() => formatUnitCode('RKT', 10000)).toThrow()
    expect(() => formatUnitCode('RKT', 0)).toThrow()
    expect(parseUnitCode('spk-0042')).toEqual({ prefix: 'SPK', seq: 42 })
    expect(parseUnitCode('SPK-42')).toBeNull()
    expect(parseUnitCode('8901234567890')).toBeNull()
  })
  it('duplicate message names the code', () => {
    expect(duplicateMessage('spk-0003', 'this bill')).toContain('SPK-0003')
  })
})

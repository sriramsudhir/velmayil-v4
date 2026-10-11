import { describe, it, expect } from 'vitest'
import { generateEan13, gtinCheckDigit, validateBarcode, withCheckDigit } from '../../src/main/modules/catalog/barcode'
import { parseScaled } from '../../src/main/modules/catalog/importer'

describe('barcode helpers', () => {
  it('computes known GTIN check digits', () => {
    expect(gtinCheckDigit('400638133393')).toBe(1) // EAN-13 4006381333931
    expect(gtinCheckDigit('590123412345')).toBe(7) // 5901234123457
    expect(gtinCheckDigit('9638507')).toBe(4) // EAN-8 96385074
    expect(gtinCheckDigit('03600029145')).toBe(2) // UPC-A 036000291452
    expect(withCheckDigit('629104150021')).toBe('6291041500213')
  })

  it('generates internal EAN-13 in the 200-299 range with a valid check digit', () => {
    for (const seq of [0, 1, 7, 123456, 999999999]) {
      const code = generateEan13(seq)
      expect(code).toMatch(/^2\d{12}$/)
      expect(validateBarcode(code)).toMatchObject({ valid: true, format: 'EAN13' })
    }
    expect(generateEan13(1)).toBe('2000000000015')
    expect(generateEan13(1, '299').startsWith('299')).toBe(true)
    expect(() => generateEan13(1, '150')).toThrow()
  })

  it('validates EAN-13 / EAN-8 / UPC-A / Code128', () => {
    expect(validateBarcode('4006381333931')).toMatchObject({ valid: true, format: 'EAN13' })
    expect(validateBarcode('4006381333932')).toMatchObject({ valid: false, format: 'EAN13' })
    expect(validateBarcode('96385074')).toMatchObject({ valid: true, format: 'EAN8' })
    expect(validateBarcode('96385075').valid).toBe(false)
    expect(validateBarcode('036000291452')).toMatchObject({ valid: true, format: 'UPCA' })
    expect(validateBarcode('036000291453').valid).toBe(false)
    expect(validateBarcode('ABC-123 x')).toMatchObject({ valid: true, format: 'CODE128' })
    expect(validateBarcode('12345')).toMatchObject({ valid: true, format: 'CODE128' })
    expect(validateBarcode('').valid).toBe(false)
    expect(validateBarcode('x'.repeat(41)).valid).toBe(false)
    expect(validateBarcode('தமிழ்').valid).toBe(false)
    expect(validateBarcode('  4006381333931  ').code).toBe('4006381333931')
  })
})

describe('decimal parsing (no floats)', () => {
  it('parses money and percentages exactly', () => {
    expect(parseScaled('1.005', 2)).toBe(101)
    expect(parseScaled('₹1,299.50', 2)).toBe(129950)
    expect(parseScaled('19.99', 2)).toBe(1999)
    expect(parseScaled('18%', 2)).toBe(1800)
    expect(parseScaled('2.5', 2)).toBe(250)
    expect(parseScaled('abc', 2)).toBeNull()
    expect(parseScaled('', 2)).toBeNull()
    expect(parseScaled('-5', 2)).toBe(-500)
  })
})

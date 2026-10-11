import { describe, it, expect } from 'vitest'
import { allocate, calcBill, divRound, roundToNearestRupee, settlePayments, splitGst, taxFromInclusive, returnShare, effectiveDiscountBp, taxSummary } from '../../src/shared/billing'

describe('billing math', () => {
  it('divRound rounds half up', () => {
    expect(divRound(5, 10)).toBe(1)
    expect(divRound(4, 10)).toBe(0)
    expect(divRound(15, 10)).toBe(2)
    expect(divRound(0, 7)).toBe(0)
  })

  it('inclusive tax: MRP price contains the tax', () => {
    // Rs 118 at 18% inclusive => tax 18, taxable 100
    const b = calcBill([{ qty: 1, unitPrice: 11800, taxRateBp: 1800 }], { pricesIncludeTax: true })
    expect(b.lines[0]).toMatchObject({ gross: 11800, taxAmount: 1800, taxable: 10000, lineTotal: 11800 })
    expect(b.total).toBe(11800)
    expect(b.tax).toBe(1800)
    expect(taxFromInclusive(10000, 0)).toBe(0)
  })

  it('exclusive tax adds on top', () => {
    const b = calcBill([{ qty: 2, unitPrice: 10000, taxRateBp: 1800 }], { pricesIncludeTax: false })
    expect(b.lines[0]).toMatchObject({ gross: 20000, taxAmount: 3600, taxable: 20000, lineTotal: 23600 })
    expect(b.total).toBe(23600)
    expect(b.subtotal - b.discount + b.tax).toBe(b.preRoundTotal)
  })

  it('line discount by amount and percent, clamped', () => {
    const b = calcBill(
      [
        { qty: 1, unitPrice: 10000, taxRateBp: 0, discount: { type: 'amount', value: 2500 } },
        { qty: 1, unitPrice: 10000, taxRateBp: 0, discount: { type: 'percent', value: 1000 } },
        { qty: 1, unitPrice: 1000, taxRateBp: 0, discount: { type: 'amount', value: 999999 } }
      ],
      { pricesIncludeTax: true }
    )
    expect(b.lines.map((l) => l.lineDiscount)).toEqual([2500, 1000, 1000])
    expect(b.lines[2].lineTotal).toBe(0)
  })

  it('bill discount allocates proportionally and sums exactly (no lost paise)', () => {
    const lines = [
      { qty: 1, unitPrice: 3333, taxRateBp: 1800 },
      { qty: 3, unitPrice: 1999, taxRateBp: 500 },
      { qty: 1, unitPrice: 1, taxRateBp: 0 }
    ]
    for (const d of [1, 7, 100, 999, 1234, 5000, { t: 'p', v: 3333 }, { t: 'p', v: 10000 }]) {
      const billDiscount = typeof d === 'number' ? ({ type: 'amount', value: d } as const) : ({ type: 'percent', value: d.v } as const)
      const b = calcBill(lines, { pricesIncludeTax: true, billDiscount })
      expect(b.lines.reduce((a, l) => a + l.billDiscount, 0)).toBe(b.billDiscountTotal)
      expect(b.discount).toBe(b.lineDiscountTotal + b.billDiscountTotal)
      expect(b.lines.every((l) => l.net >= 0)).toBe(true)
      expect(b.subtotal - b.discount).toBe(b.preRoundTotal)
    }
    const b = calcBill(lines, { pricesIncludeTax: true, billDiscount: { type: 'amount', value: 100 } })
    expect(b.billDiscountTotal).toBe(100)
  })

  it('bill discount cannot exceed the bill', () => {
    const b = calcBill([{ qty: 1, unitPrice: 5000, taxRateBp: 0 }], { pricesIncludeTax: true, billDiscount: { type: 'amount', value: 90000 } })
    expect(b.billDiscountTotal).toBe(5000)
    expect(b.total).toBe(0)
  })

  it('allocate uses largest remainder', () => {
    expect(allocate(10, [10, 10, 10])).toEqual([4, 3, 3])
    expect(allocate(10, [0, 50, 50])).toEqual([0, 5, 5])
    expect(allocate(5, [0, 0])).toEqual([0, 0])
    expect(allocate(100, [30, 31, 33]).reduce((a, b) => a + b, 0)).toBe(94)
    // huge values do not overflow
    const big = allocate(123456789, [987654321, 123456789, 5])
    expect(big.reduce((a, b) => a + b, 0)).toBe(123456789)
  })

  it('rounds to the nearest rupee and records round-off', () => {
    expect(roundToNearestRupee(10049)).toEqual({ total: 10000, roundOff: -49 })
    expect(roundToNearestRupee(10050)).toEqual({ total: 10100, roundOff: 50 })
    expect(roundToNearestRupee(10100)).toEqual({ total: 10100, roundOff: 0 })
    const b = calcBill([{ qty: 1, unitPrice: 9999, taxRateBp: 1800 }], { pricesIncludeTax: true })
    expect(b.preRoundTotal).toBe(9999)
    expect(b.total).toBe(10000)
    expect(b.roundOff).toBe(1)
    expect(calcBill([{ qty: 1, unitPrice: 9999, taxRateBp: 0 }], { pricesIncludeTax: true, roundToRupee: false }).total).toBe(9999)
  })

  it('splits GST into CGST/SGST exactly and IGST inter-state', () => {
    expect(splitGst(1801)).toEqual({ cgst: 900, sgst: 901, igst: 0 })
    expect(splitGst(1800)).toEqual({ cgst: 900, sgst: 900, igst: 0 })
    expect(splitGst(1801, false)).toEqual({ cgst: 0, sgst: 0, igst: 1801 })
  })

  it('tax summary groups by rate and totals tie out', () => {
    const b = calcBill(
      [
        { qty: 1, unitPrice: 11800, taxRateBp: 1800 },
        { qty: 1, unitPrice: 10500, taxRateBp: 500 },
        { qty: 2, unitPrice: 11800, taxRateBp: 1800 }
      ],
      { pricesIncludeTax: true }
    )
    const ts = taxSummary(b.lines)
    expect(ts.map((t) => t.rateBp)).toEqual([500, 1800])
    expect(ts.reduce((a, t) => a + t.tax, 0)).toBe(b.tax)
    expect(b.taxable + b.tax).toBe(b.preRoundTotal)
  })

  it('effective discount bp', () => {
    const b = calcBill([{ qty: 1, unitPrice: 10000, taxRateBp: 0, discount: { type: 'percent', value: 1500 } }], { pricesIncludeTax: true })
    expect(effectiveDiscountBp(b)).toBe(1500)
    expect(effectiveDiscountBp({ discount: 0, subtotal: 0 })).toBe(0)
  })

  it('payments: change only from cash', () => {
    expect(settlePayments(10000, [{ method: 'cash', amount: 20000 }])).toMatchObject({ change: 10000, balanceDue: 0, cashNet: 10000 })
    expect(settlePayments(10000, [{ method: 'upi', amount: 10000 }, { method: 'cash', amount: 500 }])).toMatchObject({ change: 500, cashNet: 0 })
    expect(settlePayments(10000, [{ method: 'card', amount: 12000 }])).toMatchObject({ change: 0 }) // service rejects: overpay without cash
    expect(settlePayments(10000, [{ method: 'cash', amount: 4000 }])).toMatchObject({ balanceDue: 6000, change: 0 })
  })

  it('return share hands out the remainder on the final return', () => {
    // line total 1000 over 3 units: 333 + 333 + 334
    const a = returnShare(1000, 3, 1, 0, 0)
    const b = returnShare(1000, 3, 1, 1, a)
    const c = returnShare(1000, 3, 1, 2, a + b)
    expect([a, b, c]).toEqual([333, 333, 334])
  })

  it('rejects invalid input', () => {
    expect(() => calcBill([{ qty: 0, unitPrice: 100, taxRateBp: 0 }], { pricesIncludeTax: true })).toThrow()
    expect(() => calcBill([{ qty: 1, unitPrice: 10.5, taxRateBp: 0 }], { pricesIncludeTax: true })).toThrow()
  })
})

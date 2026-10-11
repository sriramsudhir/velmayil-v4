/**
 * Billing math. Pure, integer-only (paise / basis points). Used by the renderer (live cart) AND by the
 * main process (authoritative recalculation at sale completion - client totals are never trusted).
 *
 * Model per line:
 *   gross        = qty * unitPrice
 *   lineDiscount = amount (paise) or percent (bp of gross), clamped to [0, gross]
 *   billDiscount = share of the bill-level discount, allocated across lines proportionally to
 *                  (gross - lineDiscount) with the largest-remainder method => shares sum EXACTLY to the bill discount
 *   net          = gross - lineDiscount - billDiscount          (what the customer pays for the line, before exclusive tax)
 *   inclusive:   taxAmount = net * bp / (10000 + bp)  (tax is already inside net);  taxable = net - taxAmount; lineTotal = net
 *   exclusive:   taxAmount = net * bp / 10000;         taxable = net;              lineTotal = net + taxAmount
 *
 * Bill:  subtotal(gross) - discount (+ tax when exclusive) = sum(lineTotal) = preRoundTotal;
 *        total = preRoundTotal rounded to the nearest rupee (half up); roundOff = total - preRoundTotal.
 */
import type { Paise } from './money'

export type Discount = { type: 'amount'; value: Paise } | { type: 'percent'; value: number /* basis points */ } | null | undefined

export interface BillLineInput {
  qty: number
  unitPrice: Paise
  discount?: Discount
  taxRateBp: number
}

export interface BillLine {
  qty: number
  unitPrice: Paise
  taxRateBp: number
  gross: Paise
  lineDiscount: Paise
  billDiscount: Paise
  /** lineDiscount + billDiscount (what is stored in sale_items.discount) */
  discount: Paise
  net: Paise
  /** value excluding tax */
  taxable: Paise
  taxAmount: Paise
  /** amount payable for the line (includes tax in both modes) */
  lineTotal: Paise
}

export interface BillTotals {
  lines: BillLine[]
  pricesIncludeTax: boolean
  /** sum of gross (qty * unitPrice) before any discount */
  subtotal: Paise
  lineDiscountTotal: Paise
  billDiscountTotal: Paise
  discount: Paise
  taxable: Paise
  tax: Paise
  /** sum of lineTotal */
  preRoundTotal: Paise
  roundOff: Paise
  /** payable total (rounded to the rupee unless rounding is disabled) */
  total: Paise
}

export interface BillOptions {
  pricesIncludeTax: boolean
  billDiscount?: Discount
  /** round the payable total to the nearest rupee (default true) */
  roundToRupee?: boolean
}

/** Integer division rounding half up (non-negative n and positive d). Exact for |n| < 2^53. */
export function divRound(n: number, d: number): number {
  if (d <= 0) throw new Error('divRound: divisor must be positive')
  if (n < 0) return -divRound(-n, d)
  return Math.floor((2 * n + d) / (2 * d))
}

const assertInt = (v: number, what: string) => {
  if (!Number.isInteger(v)) throw new Error(`${what} must be an integer (got ${v})`)
}

/** Resolve a discount to paise against a base amount; clamped to [0, base]. */
export function discountAmount(d: Discount, base: Paise): Paise {
  if (!d || base <= 0) return 0
  assertInt(d.value, 'discount value')
  if (d.value <= 0) return 0
  const raw = d.type === 'amount' ? d.value : divRound(base * Math.min(d.value, 10000), 10000)
  return Math.min(Math.max(raw, 0), base)
}

/**
 * Split `total` across `weights` proportionally so the parts sum exactly to `total` (largest remainder,
 * ties to the earlier index). total is clamped to the weight sum; zero weights get zero.
 */
export function allocate(total: Paise, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0)
  const t = Math.min(Math.max(total, 0), sum)
  if (t === 0 || sum === 0) return weights.map(() => 0)
  const T = BigInt(t)
  const S = BigInt(sum)
  const base = weights.map((w) => (T * BigInt(w)) / S)
  const rem = weights.map((w, i) => ({ i, r: (T * BigInt(w)) % S }))
  let left = Number(T - base.reduce((a, b) => a + b, 0n))
  rem.sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1))
  const out = base.map(Number)
  for (const { i, r } of rem) {
    if (left <= 0) break
    if (r === 0n && weights[i] === 0) continue
    out[i] += 1
    left -= 1
  }
  return out
}

/** Tax contained in a tax-inclusive amount. */
export const taxFromInclusive = (amount: Paise, bp: number): Paise => (bp <= 0 ? 0 : divRound(amount * bp, 10000 + bp))
/** Tax to add on a tax-exclusive amount. */
export const taxOnExclusive = (amount: Paise, bp: number): Paise => (bp <= 0 ? 0 : divRound(amount * bp, 10000))

/** Round to the nearest rupee (50 paise rounds up). roundOff is the signed adjustment that was applied. */
export function roundToNearestRupee(amount: Paise): { total: Paise; roundOff: Paise } {
  const total = divRound(amount, 100) * 100
  return { total, roundOff: total - amount }
}

/** Intra-state GST split: CGST gets the floor half, SGST the remainder, so cgst + sgst === tax. */
export function splitGst(tax: Paise, intraState = true): { cgst: Paise; sgst: Paise; igst: Paise } {
  if (!intraState) return { cgst: 0, sgst: 0, igst: tax }
  const cgst = Math.floor(tax / 2)
  return { cgst, sgst: tax - cgst, igst: 0 }
}

export function calcBill(inputs: BillLineInput[], opts: BillOptions): BillTotals {
  const inc = opts.pricesIncludeTax
  const pre = inputs.map((l) => {
    assertInt(l.qty, 'qty')
    assertInt(l.unitPrice, 'unitPrice')
    assertInt(l.taxRateBp, 'taxRateBp')
    if (l.qty <= 0) throw new Error('qty must be positive')
    if (l.unitPrice < 0) throw new Error('unitPrice cannot be negative')
    const gross = l.qty * l.unitPrice
    const lineDiscount = discountAmount(l.discount, gross)
    return { l, gross, lineDiscount, afterLine: gross - lineDiscount }
  })
  const afterLineTotal = pre.reduce((a, p) => a + p.afterLine, 0)
  const billDiscountTotal = discountAmount(opts.billDiscount, afterLineTotal)
  const shares = allocate(billDiscountTotal, pre.map((p) => p.afterLine))

  const lines: BillLine[] = pre.map((p, i) => {
    const billDiscount = shares[i]
    const net = p.afterLine - billDiscount
    const taxAmount = inc ? taxFromInclusive(net, p.l.taxRateBp) : taxOnExclusive(net, p.l.taxRateBp)
    return {
      qty: p.l.qty,
      unitPrice: p.l.unitPrice,
      taxRateBp: p.l.taxRateBp,
      gross: p.gross,
      lineDiscount: p.lineDiscount,
      billDiscount,
      discount: p.lineDiscount + billDiscount,
      net,
      taxable: inc ? net - taxAmount : net,
      taxAmount,
      lineTotal: inc ? net : net + taxAmount
    }
  })
  const sum = (f: (l: BillLine) => number) => lines.reduce((a, l) => a + f(l), 0)
  const preRoundTotal = sum((l) => l.lineTotal)
  const doRound = opts.roundToRupee !== false
  const { total, roundOff } = doRound ? roundToNearestRupee(preRoundTotal) : { total: preRoundTotal, roundOff: 0 }
  return {
    lines,
    pricesIncludeTax: inc,
    subtotal: sum((l) => l.gross),
    lineDiscountTotal: sum((l) => l.lineDiscount),
    billDiscountTotal,
    discount: sum((l) => l.discount),
    taxable: sum((l) => l.taxable),
    tax: sum((l) => l.taxAmount),
    preRoundTotal,
    roundOff,
    total
  }
}

/** Overall discount as basis points of the gross subtotal (used for the role max-discount check). */
export function effectiveDiscountBp(t: Pick<BillTotals, 'discount' | 'subtotal'>): number {
  return t.subtotal <= 0 ? 0 : divRound(t.discount * 10000, t.subtotal)
}

/** Group tax by rate for the tax summary on invoices. */
export function taxSummary(lines: BillLine[]): { rateBp: number; taxable: Paise; tax: Paise }[] {
  const m = new Map<number, { rateBp: number; taxable: Paise; tax: Paise }>()
  for (const l of lines) {
    const e = m.get(l.taxRateBp) ?? { rateBp: l.taxRateBp, taxable: 0, tax: 0 }
    e.taxable += l.taxable
    e.tax += l.taxAmount
    m.set(l.taxRateBp, e)
  }
  return [...m.values()].sort((a, b) => a.rateBp - b.rateBp)
}

export interface PaymentInput { method: string; amount: Paise }
/** Settle payments against a total. Change can only come from cash. Returns the balance still due (>0 = underpaid). */
export function settlePayments(total: Paise, payments: PaymentInput[]): { tendered: Paise; change: Paise; balanceDue: Paise; cashNet: Paise } {
  const tendered = payments.reduce((a, p) => a + p.amount, 0)
  const cash = payments.filter((p) => p.method === 'cash').reduce((a, p) => a + p.amount, 0)
  const excess = Math.max(0, tendered - total)
  const change = Math.min(excess, cash)
  return { tendered, change, balanceDue: Math.max(0, total - tendered), cashNet: cash - change }
}

/**
 * Quick "cash received" suggestions (paise): the exact total first, then the next round amounts the customer is likely
 * to hand over (next 100 / 500 / 1000 / 2000 / 5000 above or equal, plus a 500 / 2000 note above an already round total).
 */
export function quickCashAmounts(total: Paise, max = 6): Paise[] {
  if (!Number.isInteger(total) || total <= 0) return []
  const out: Paise[] = [total]
  const add = (v: number) => { if (v > total && !out.includes(v)) out.push(v) }
  for (const rupees of [100, 500, 1000, 2000, 5000]) add(Math.ceil(total / (rupees * 100)) * rupees * 100)
  for (const rupees of [500, 2000]) add(Math.ceil((total + 1) / (rupees * 100)) * rupees * 100)
  return [out[0], ...out.slice(1).sort((a, b) => a - b)].slice(0, max)
}

/** UPI deep link / QR payload (NPCI spec) with the amount prefilled. Empty string when no valid UPI id. */
export function upiPayUri(o: { upiId: string; payeeName?: string; amount: Paise; note?: string }): string {
  const id = o.upiId.trim()
  if (!/^[\w.\-]{2,}@[A-Za-z][\w.\-]{1,}$/.test(id) || !(o.amount > 0)) return ''
  const q = (s: string) => encodeURIComponent(s)
  const am = `${Math.floor(o.amount / 100)}.${String(o.amount % 100).padStart(2, '0')}`
  return `upi://pay?pa=${q(id)}${o.payeeName ? `&pn=${q(o.payeeName)}` : ''}&am=${am}&cu=INR${o.note ? `&tn=${q(o.note)}` : ''}`
}

/**
 * Proportional share of a line amount for a partial return of `qty` of `soldQty`. When the return finishes the
 * line (alreadyReturnedQty + qty === soldQty) the remainder is refunded so no paise are lost.
 */
export function returnShare(lineAmount: Paise, soldQty: number, qty: number, alreadyReturnedQty: number, alreadyRefunded: Paise): Paise {
  if (alreadyReturnedQty + qty >= soldQty) return lineAmount - alreadyRefunded
  return divRound(lineAmount * qty, soldQty)
}

/** All money is stored as INTEGER paise (1 INR = 100 paise). Never use floats for money. */
export type Paise = number

export const toPaise = (rupees: number | string): Paise => {
  const n = typeof rupees === 'string' ? Number(rupees.replace(/[₹,\s]/g, '')) : rupees
  if (!Number.isFinite(n)) throw new Error(`Invalid amount: ${rupees}`)
  return Math.round(n * 100)
}
export const toRupees = (p: Paise): number => p / 100

/** Integer-safe percentage: pct in basis points (1800 = 18%). Rounds half away from zero. */
export const pctOf = (amount: Paise, bp: number): Paise => {
  const v = (amount * bp) / 10000
  return v < 0 ? -Math.round(-v) : Math.round(v)
}

export const formatINR = (p: Paise, opts: { symbol?: boolean } = {}): string => {
  const sym = opts.symbol === false ? '' : '₹'
  const neg = p < 0
  const abs = Math.abs(p)
  const rupees = Math.floor(abs / 100)
  const paise = abs % 100
  const s = rupees.toString()
  // Indian digit grouping: last 3 digits, then groups of 2
  const grouped = s.length > 3 ? s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + s.slice(-3) : s
  return `${neg ? '-' : ''}${sym}${grouped}.${paise.toString().padStart(2, '0')}`
}

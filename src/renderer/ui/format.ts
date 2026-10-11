import { formatINR, type Paise } from '@shared/money'

// ---- money (paise integers in, display strings out) ----

/** Format paise as Indian-grouped rupees: 123456 -> "₹1,234.56". */
export const formatMoney = (p: Paise | null | undefined, opts: { symbol?: boolean; decimals?: boolean } = {}): string => {
  const v = Math.round(Number(p ?? 0))
  if (opts.decimals === false) {
    const s = formatINR(v, { symbol: opts.symbol })
    return s.replace(/\.\d{2}$/, '')
  }
  return formatINR(v, { symbol: opts.symbol })
}

/** Compact: 1,25,000 -> "₹1.25L", 2.5 crore -> "₹2.5Cr", 12,300 -> "₹12.3K". */
export const formatMoneyCompact = (p: Paise | null | undefined): string => {
  const rupees = Math.round(Number(p ?? 0)) / 100
  const abs = Math.abs(rupees)
  const sign = rupees < 0 ? '-' : ''
  const f = (n: number) => String(Math.round(n * 100) / 100)
  if (abs >= 1e7) return `${sign}₹${f(abs / 1e7)}Cr`
  if (abs >= 1e5) return `${sign}₹${f(abs / 1e5)}L`
  if (abs >= 1e4) return `${sign}₹${f(abs / 1e3)}K`
  return formatINR(Math.round(rupees * 100), { symbol: true }).replace(/\.00$/, '')
}

/** Plain Indian-grouped integer: 1234567 -> "12,34,567". */
export const formatNumber = (n: number | null | undefined, maxFractionDigits = 0): string =>
  new Intl.NumberFormat('en-IN', { maximumFractionDigits: maxFractionDigits }).format(Number(n ?? 0))

/** Parse rupee text ("1,234.5", "₹ 99") into integer paise WITHOUT float math. Returns null when not a valid amount. */
export function parseRupeesToPaise(text: string): number | null {
  const t = text.replace(/[₹,\s]/g, '')
  if (!t) return null
  const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(t)
  if (!m || (m[2] === '' && !m[3])) return null
  const whole = Number(m[2] || '0')
  let frac = (m[3] ?? '').slice(0, 3)
  const third = frac.length > 2 ? Number(frac[2]) : 0
  frac = frac.slice(0, 2).padEnd(2, '0')
  let paise = whole * 100 + Number(frac) + (third >= 5 ? 1 : 0)
  if (m[1] === '-') paise = -paise
  return Number.isSafeInteger(paise) ? paise : null
}

/** Paise -> editable rupee string without grouping: 12345 -> "123.45" (integer math). */
export function paiseToRupeeString(p: number | null | undefined, opts: { trimZero?: boolean } = {}): string {
  if (p == null || !Number.isFinite(p)) return ''
  const v = Math.round(p)
  const abs = Math.abs(v)
  const s = `${v < 0 ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
  return opts.trimZero ? s.replace(/\.00$/, '') : s
}

// ---- dates: always en-IN, Asia/Kolkata (IST) ----
const TZ = 'Asia/Kolkata'
const IST_OFFSET_MS = 330 * 60 * 1000
const fmt = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-IN', { timeZone: TZ, ...opts })
const dDate = fmt({ day: '2-digit', month: 'short', year: 'numeric' })
const dTime = fmt({ hour: '2-digit', minute: '2-digit', hour12: true })
const dDateTime = fmt({ day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true })
const dShort = fmt({ day: '2-digit', month: 'short' })

type Ts = number | Date | null | undefined
const toDate = (t: Ts) => (t instanceof Date ? t : new Date(Number(t)))
const valid = (t: Ts) => t != null && !Number.isNaN(toDate(t).getTime())

export const formatDate = (t: Ts): string => (valid(t) ? dDate.format(toDate(t)) : '')
export const formatTime = (t: Ts): string => (valid(t) ? dTime.format(toDate(t)).toUpperCase() : '')
export const formatDateTime = (t: Ts): string => (valid(t) ? dDateTime.format(toDate(t)).replace(/\b(am|pm)\b/, (s) => s.toUpperCase()) : '')
export const formatDayMonth = (t: Ts): string => (valid(t) ? dShort.format(toDate(t)) : '')

/** "YYYY-MM-DD" for an epoch ms in IST. */
export const istDateString = (t: Ts = Date.now()): string => new Date(toDate(t).getTime() + IST_OFFSET_MS).toISOString().slice(0, 10)
export const todayISO = (): string => istDateString(Date.now())
/** Epoch ms of 00:00 IST on the given IST "YYYY-MM-DD" (default today). */
export const startOfDayIST = (day: string = todayISO()): number => Date.parse(`${day}T00:00:00+05:30`)
export const endOfDayIST = (day: string = todayISO()): number => startOfDayIST(day) + 86_400_000 - 1
export const addDaysISO = (day: string, n: number): string => istDateString(startOfDayIST(day) + n * 86_400_000 + 3_600_000)

export function relativeTime(t: Ts, now = Date.now()): string {
  if (!valid(t)) return ''
  const s = Math.round((now - toDate(t).getTime()) / 1000)
  if (s < 45) return 'just now'
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`
  if (s < 172_800) return 'yesterday'
  return formatDate(t)
}

/** Percent change; null when the baseline is 0/absent. */
export const pctChange = (now: number, before: number | null | undefined): number | null =>
  before ? ((now - before) / Math.abs(before)) * 100 : null

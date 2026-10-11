import type { ReportColumn, ReportRow } from '@shared/reports'
import { formatMoney, formatNumber, formatDate, formatDateTime } from '@/ui'

/** Display text for one report cell. Money arrives in paise, percent in basis points, dates as epoch ms. */
export function cellText(c: ReportColumn, v: string | number | null | undefined): string {
  if (v == null || v === '') return ''
  if (typeof v === 'string') return v
  switch (c.type) {
    case 'money': return formatMoney(v, { symbol: false })
    case 'percent': return `${(v / 100).toFixed(2)}%`
    case 'date': return c.time ? formatDateTime(v) : formatDate(v)
    case 'int': return formatNumber(v)
    default: return String(v)
  }
}

/** value used for sorting (numbers numerically, text case-insensitively) */
export function sortValue(c: ReportColumn, row: ReportRow): number | string | null {
  const v = row[c.key]
  if (v == null || v === '') return null
  return typeof v === 'number' ? v : v.toLowerCase()
}

export function downloadBase64(base64: string, filename: string, mime: string): void {
  const bin = atob(base64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

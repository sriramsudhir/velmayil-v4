import type { ReportColumn, ReportResult, ReportRow } from '@shared/reports'
import { formatINR } from '@shared/money'
import type { ShopHeader } from './engine'

const pad = (n: number) => String(n).padStart(2, '0')
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** integer paise -> "1234.50" (no float math) */
export function plainMoney(p: number): string {
  const neg = p < 0
  const a = Math.abs(Math.round(p))
  return `${neg ? '-' : ''}${Math.floor(a / 100)}.${pad(a % 100)}`
}
/** basis points -> "25.50" */
export const plainPercent = (bp: number): string => plainMoney(bp)

export function isoLocal(ms: number, time: boolean): string {
  const d = new Date(ms)
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  return time ? `${date} ${pad(d.getHours())}:${pad(d.getMinutes())}` : date
}
export function prettyDate(ms: number, time: boolean): string {
  const d = new Date(ms)
  const date = `${pad(d.getDate())}-${MONTHS[d.getMonth()]}-${d.getFullYear()}`
  return time ? `${date} ${pad(d.getHours())}:${pad(d.getMinutes())}` : date
}

/** Guard against spreadsheet formula injection in free text (names, notes typed by users). */
export const safeText = (s: string): string => (/^[=+@\t\r]/.test(s) ? `'${s}` : s)

/** machine-friendly cell (CSV) */
export function csvCell(c: ReportColumn, v: string | number | null | undefined): string {
  if (v == null || v === '') return ''
  if (typeof v === 'string') return c.type === 'text' ? safeText(v) : v
  switch (c.type) {
    case 'money': return plainMoney(v)
    case 'percent': return plainPercent(v)
    case 'date': return isoLocal(v, !!c.time)
    default: return String(v)
  }
}

/** human display (PDF / print) */
export function displayCell(c: ReportColumn, v: string | number | null | undefined): string {
  if (v == null || v === '') return ''
  if (typeof v === 'string') return v
  switch (c.type) {
    case 'money': return formatINR(v, { symbol: false })
    case 'percent': return `${plainPercent(v)}%`
    case 'date': return prettyDate(v, !!c.time)
    default: return v.toLocaleString('en-IN')
  }
}

export function csvEscape(s: string): string {
  return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function periodText(r: ReportResult): string {
  return r.period ? `${r.period.label}${r.period.label.includes(r.period.from) ? '' : ` (${r.period.from} to ${r.period.to})`}` : `As of ${isoLocal(r.generatedAt, true)}`
}

/** CSV with UTF-8 BOM and CRLF line endings. Money as plain decimals (rupees, 2dp), percentages as 12.50. */
export function toCsv(r: ReportResult, shop: ShopHeader, headerBlock = false): Buffer {
  const lines: string[] = []
  if (headerBlock) {
    lines.push(csvEscape(shop.name), csvEscape(r.title), csvEscape(periodText(r)), '')
  }
  lines.push(r.columns.map((c) => csvEscape(c.header)).join(','))
  for (const row of r.rows) lines.push(r.columns.map((c) => csvEscape(csvCell(c, row[c.key]))).join(','))
  if (r.totals) lines.push(r.columns.map((c) => csvEscape(csvCell(c, r.totals![c.key]))).join(','))
  return Buffer.from('﻿' + lines.join('\r\n') + '\r\n', 'utf8')
}

export async function toXlsx(r: ReportResult, shop: ShopHeader): Promise<Buffer> {
  const mod = (await import('exceljs')) as unknown as { default?: typeof import('exceljs'); Workbook?: typeof import('exceljs').Workbook }
  const Workbook = (mod.default?.Workbook ?? mod.Workbook)!
  const wb = new Workbook()
  wb.creator = shop.name || 'POS'
  wb.created = new Date(r.generatedAt)
  const sheetName = r.title.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Report'
  const ws = wb.addWorksheet(sheetName, { views: [{ state: 'frozen', ySplit: 6 }] })

  const ncols = Math.max(r.columns.length, 1)
  const head = (row: number, text: string, size: number, bold: boolean) => {
    const c = ws.getCell(row, 1)
    c.value = text
    c.font = { bold, size }
    if (ncols > 1) ws.mergeCells(row, 1, row, Math.min(ncols, 6))
  }
  head(1, shop.name, 14, true)
  head(2, [shop.address, shop.gstin ? `GSTIN ${shop.gstin}` : ''].filter(Boolean).join('   '), 10, false)
  head(3, r.title + (r.subtitle ? ` - ${r.subtitle}` : ''), 12, true)
  head(4, periodText(r), 10, false)
  head(5, `Generated ${isoLocal(r.generatedAt, true)}`, 9, false)

  const hr = ws.getRow(6)
  r.columns.forEach((c, i) => {
    const cell = hr.getCell(i + 1)
    cell.value = c.header
    cell.font = { bold: true }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EEF4' } }
    cell.border = { bottom: { style: 'thin' } }
    cell.alignment = { horizontal: c.align ?? (c.type === 'text' ? 'left' : 'right'), wrapText: true }
  })

  const put = (rowIdx: number, row: ReportRow, bold: boolean) => {
    const wr = ws.getRow(rowIdx)
    r.columns.forEach((c, i) => {
      const v = row[c.key]
      const cell = wr.getCell(i + 1)
      if (v == null || v === '') return
      if (typeof v === 'string') {
        cell.value = c.type === 'text' ? safeText(v) : v
      } else if (c.type === 'money') {
        cell.value = Number(plainMoney(v)); cell.numFmt = '#,##0.00'
      } else if (c.type === 'percent') {
        cell.value = v / 10000; cell.numFmt = '0.00%'
      } else if (c.type === 'date') {
        const d = new Date(v) // Excel has no time zones: store the local wall-clock as the serial
        cell.value = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()))
        cell.numFmt = c.time ? 'dd-mmm-yyyy hh:mm' : 'dd-mmm-yyyy'
      } else {
        cell.value = v; cell.numFmt = '#,##0'
      }
      if (bold) cell.font = { bold: true }
    })
  }
  let idx = 7
  for (const row of r.rows) put(idx++, row, false)
  if (r.totals) {
    put(idx, r.totals, true)
    ws.getRow(idx).eachCell((c) => { c.border = { top: { style: 'thin' } } })
  }
  r.columns.forEach((c, i) => {
    const maxLen = Math.max(c.header.length, ...r.rows.slice(0, 200).map((row) => displayCell(c, row[c.key]).length))
    ws.getColumn(i + 1).width = Math.min(Math.max(10, maxLen + 2), 48)
  })
  if (r.rows.length) ws.autoFilter = { from: { row: 6, column: 1 }, to: { row: 6 + r.rows.length, column: ncols } }
  return Buffer.from(await wb.xlsx.writeBuffer())
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** rows pre-formatted for printing.renderReportHtml (which has no column types) */
export function displayRows(r: ReportResult): { rows: Record<string, string>[]; totals?: Record<string, string> } {
  const fmt = (row: ReportRow) => Object.fromEntries(r.columns.map((c) => [c.key, displayCell(c, row[c.key])]))
  return { rows: r.rows.map(fmt), totals: r.totals ? fmt(r.totals) : undefined }
}

/** Minimal standalone report HTML, used only if the printing module is unavailable. */
export function fallbackHtml(r: ReportResult, shop: ShopHeader): string {
  const d = displayRows(r)
  const th = r.columns.map((c) => `<th style="text-align:${c.align ?? 'left'}">${esc(c.header)}</th>`).join('')
  const tr = (row: Record<string, string>, bold = false) =>
    `<tr${bold ? ' style="font-weight:bold"' : ''}>${r.columns.map((c) => `<td style="text-align:${c.align ?? 'left'}">${esc(row[c.key] ?? '')}</td>`).join('')}</tr>`
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(r.title)}</title><style>
body{font:12px Segoe UI,Arial,sans-serif;margin:16px}table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid #ccc;padding:3px 6px}
th{background:#eef2f6}</style></head><body><h2>${esc(shop.name)}</h2><h3>${esc(r.title)}</h3><p>${esc(periodText(r))}</p>
<table><thead><tr>${th}</tr></thead><tbody>${d.rows.map((x) => tr(x)).join('')}${d.totals ? tr(d.totals, true) : ''}</tbody></table></body></html>`
}

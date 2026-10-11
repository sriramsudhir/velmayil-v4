import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ExcelJS from 'exceljs'
import { beforeAll, describe, expect, it } from 'vitest'
import type { App } from '../../src/main/core/app'
import type { ReportExportResult } from '../../src/shared/reports'
import { csvCell, csvEscape, plainMoney, safeText } from '../../src/main/modules/reports/export'
import { buildMini, RANGE, reportsApp, type Mini } from './setup'
import { local } from './fixture'

let app: App
let m: Mini
beforeAll(() => {
  app = reportsApp()
  m = buildMini(app)
})

/** minimal RFC 4180 parser for verifying quoting */
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = [], cell = '', q = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++ } else q = false } else cell += c
    } else if (c === '"') q = true
    else if (c === ',') { row.push(cell); cell = '' }
    else if (c === '\r') { /* skip */ }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = '' }
    else cell += c
  }
  if (cell || row.length) { row.push(cell); rows.push(row) }
  return rows
}
const call = <T>(method: string, args: unknown) => app.call('reports', method, args) as Promise<T>
const bytesOf = (x: ReportExportResult) => Buffer.from(x.base64!, 'base64')

describe('CSV', () => {
  it('UTF-8 BOM, CRLF, quoting of commas/quotes/newlines, unicode preserved', async () => {
    const x = await call<ReportExportResult>('exportCsv', { id: 'customers', filters: { from: '2026-04-01', to: '2026-04-30' } })
    expect(x.mime).toContain('text/csv')
    expect(x.filename).toBe('customers_2026-04-01_2026-04-30.csv')
    const buf = bytesOf(x)
    expect([buf[0], buf[1], buf[2]]).toEqual([0xef, 0xbb, 0xbf])
    const text = buf.toString('utf8').slice(1)
    expect(text.endsWith('\r\n')).toBe(true)
    const rows = parseCsv(text)
    expect(rows[0]).toEqual(['Customer', 'Phone', 'GSTIN', 'Bills', 'Sales', 'Returns', 'Net spend', 'Avg bill', 'Sold on credit', 'Last purchase'])
    const ravi = rows.find((r) => r[0] === 'Ravi')!
    expect(ravi.slice(3, 9)).toEqual(['2', '764.00', '0.00', '764.00', '382.00', '200.00'])
    expect(ravi[9]).toBe('2026-04-10')
    expect(rows[rows.length - 1][0]).toBe('Total')
  })

  it('a customer name with comma, quotes, newline and Tamil text round-trips', async () => {
    const cid = m.cat.customers.meena
    const { insertSale } = (await import('./fixture')).makeInserter(app)
    insertSale({ no: 'MEENA-1', ts: local(2026, 4, 12, 10), posId: app.localPos().id, userId: m.cat.users.A, customerId: cid, lines: [{ v: m.cat.variants.V3, qty: 1 }], pays: [{ method: 'cash', amount: 10500 }] })
    const x = await call<ReportExportResult>('exportCsv', { id: 'customers', filters: { from: '2026-04-12', to: '2026-04-12' } })
    const text = bytesOf(x).toString('utf8')
    expect(text).toContain('"Meena, ""M"" Traders\nUnit 2 ராஜா"')
    const rows = parseCsv(text.slice(1))
    expect(rows[1][0]).toBe('Meena, "M" Traders\nUnit 2 ராஜா')
    expect(rows[1]).toHaveLength(10)
  })

  it('money as 2dp rupees, percent as 2dp, header block optional, writes to path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rpt-export-'))
    const path = join(dir, 'items.csv')
    const x = await call<ReportExportResult>('exportCsv', { id: 'item_sales', filters: RANGE, path, headerBlock: true })
    expect(x.path).toBe(path)
    expect(existsSync(path)).toBe(true)
    expect(x.base64).toBeUndefined()
    const lines = readFileSync(path, 'utf8').slice(1).split('\r\n')
    expect(lines[0]).toBe('Test Shop')
    expect(lines[1]).toBe('Item-wise sales')
    expect(lines[2]).toContain('2026-04-10 to 2026-04-11')
    const rows = parseCsv(lines.slice(4).join('\n'))
    const v1 = rows.find((r) => r[1] === 'V1')!
    expect(v1).toContain('236.00') // net total
    expect(v1).toContain('40.00') // margin 40.00 %
    expect(x.bytes).toBe(readFileSync(path).length)
    await expect(call('exportCsv', { id: 'item_sales', filters: RANGE, path: 'relative/x.csv' })).rejects.toMatchObject({ code: 'VALIDATION' })
  })

  it('helpers: escaping, formula-injection guard, integer money', () => {
    expect(csvEscape('plain')).toBe('plain')
    expect(csvEscape('a,b')).toBe('"a,b"')
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""')
    expect(csvEscape('line1\nline2')).toBe('"line1\nline2"')
    expect(csvEscape(' padded')).toBe('" padded"')
    expect(safeText('=SUM(A1)')).toBe("'=SUM(A1)")
    expect(safeText('+91 98765')).toBe("'+91 98765")
    expect(safeText('@x')).toBe("'@x")
    expect(safeText('Normal')).toBe('Normal')
    expect(csvCell({ key: 'n', header: 'n', type: 'text' }, '=1+1')).toBe("'=1+1")
    expect(plainMoney(0)).toBe('0.00')
    expect(plainMoney(5)).toBe('0.05')
    expect(plainMoney(-12345)).toBe('-123.45')
    expect(plainMoney(100000000)).toBe('1000000.00')
  })
})

describe('XLSX', () => {
  const load = async (x: ReportExportResult) => {
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(bytesOf(x) as never)
    return wb.worksheets[0]
  }

  it('reopens with shop header, numeric rupees (2dp), percent, dates and totals', async () => {
    const x = await call<ReportExportResult>('exportXlsx', { id: 'item_sales', filters: RANGE })
    expect(x.mime).toContain('spreadsheetml')
    const ws = await load(x)
    expect(ws.getCell('A1').value).toBe('Test Shop') // from business_profile_versions (no businessProfile service in this app)
    expect(String(ws.getCell('A2').value)).toContain('1 Main Road')
    expect(String(ws.getCell('A3').value)).toContain('Item-wise sales')
    expect(String(ws.getCell('A4').value)).toContain('2026-04-10')
    const header = (ws.getRow(6).values as unknown[]).slice(1)
    expect(header.slice(0, 3)).toEqual(['Product', 'SKU', 'HSN'])
    const rows: Record<string, unknown>[] = []
    for (let r = 7; r <= ws.rowCount; r++) {
      const vals = (ws.getRow(r).values as unknown[]).slice(1)
      rows.push(Object.fromEntries(header.map((h, i) => [String(h), vals[i]])))
    }
    const v1 = rows.find((r) => r['SKU'] === 'V1')!
    expect(v1['Net total']).toBe(236)
    expect(typeof v1['Net total']).toBe('number')
    expect(v1['Net sales (ex-tax)']).toBe(200)
    expect(v1['Profit']).toBe(80)
    expect(v1['Margin']).toBeCloseTo(0.4, 10)
    expect(v1['Net qty']).toBe(2)
    const totals = rows[rows.length - 1]
    expect(totals['Product']).toBe('Total')
    expect(totals['Net total']).toBe(999.99)
    expect(totals['Profit']).toBe(365.22)
    const colIdx = header.indexOf('Net total') + 1
    expect(ws.getCell(7, colIdx).numFmt).toBe('#,##0.00')
    expect(ws.getCell(7, header.indexOf('Margin') + 1).numFmt).toBe('0.00%')
  })

  it('date cells keep the local wall-clock time', async () => {
    const x = await call<ReportExportResult>('exportXlsx', { id: 'sales_detail', filters: RANGE })
    const ws = await load(x)
    const header = (ws.getRow(6).values as unknown[]).slice(1)
    const d = ws.getCell(7, header.indexOf('Date') + 1).value as Date
    expect(d).toBeInstanceOf(Date)
    expect([d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes()]).toEqual([2026, 4, 10, 10, 15])
    expect(ws.getCell(7, header.indexOf('Invoice') + 1).value).toBe('INV-1')
    expect(ws.getCell(7, header.indexOf('Total') + 1).value).toBe(236)
  })

  it('uses businessProfile.getActive() when the service exists (never a hard-coded name)', async () => {
    const a2 = reportsApp()
    buildMini(a2)
    a2.provide('businessProfile', { getActive: () => ({ displayName: 'Velmayil Crackers & Gifts', shopName: 'x', address: 'Sivakasi', city: '', gstin: '33ZZZZZ9999Z1Z1' }) })
    const x = (await a2.call('reports', 'exportXlsx', { id: 'sales_summary', filters: RANGE })) as ReportExportResult
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(Buffer.from(x.base64!, 'base64') as never)
    expect(wb.worksheets[0].getCell('A1').value).toBe('Velmayil Crackers & Gifts')
    expect(String(wb.worksheets[0].getCell('A2').value)).toContain('GSTIN 33ZZZZZ9999Z1Z1')
  })

  it('falls back to SQL when businessProfile throws; formula-looking text is neutralised', async () => {
    const a2 = reportsApp()
    const mm = buildMini(a2)
    a2.provide('businessProfile', { getActive: () => { throw new Error('boom') } })
    a2.db.run('UPDATE customers SET name = ? WHERE id = ?', '=HYPERLINK("http://x")', mm.cat.customers.ravi)
    const x = (await a2.call('reports', 'exportXlsx', { id: 'customers', filters: RANGE })) as ReportExportResult
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(Buffer.from(x.base64!, 'base64') as never)
    const ws = wb.worksheets[0]
    expect(ws.getCell('A1').value).toBe('Test Shop')
    expect(ws.getCell('A7').value).toBe(`'=HYPERLINK("http://x")`)
  })

  it('export is audited', () => {
    const n = app.db.value<number>("SELECT COUNT(*) FROM audit_log WHERE entity='report' AND action='export'")!
    expect(n).toBeGreaterThanOrEqual(5)
  })
})

describe('PDF via printing', () => {
  it('builds report HTML with printing.renderReportHtml then printing.exportPdf (path or base64)', async () => {
    const a2 = reportsApp()
    buildMini(a2)
    const seen: { html?: string; path?: string; report?: Record<string, unknown> } = {}
    a2.provide('printing', {
      renderReportHtml: (r: Record<string, unknown>) => { seen.report = r; return { html: `<html>${String(r.title)}</html>` } },
      exportPdf: async (o: { html: string; path: string }) => {
        seen.html = o.html; seen.path = o.path
        const { writeFileSync } = await import('node:fs')
        writeFileSync(o.path, Buffer.from('%PDF-1.4 fake'))
        return { path: o.path }
      }
    })
    const x = (await a2.call('reports', 'exportPdf', { id: 'payment_methods', filters: RANGE })) as ReportExportResult
    expect(x.mime).toBe('application/pdf')
    expect(Buffer.from(x.base64!, 'base64').toString()).toBe('%PDF-1.4 fake')
    expect(seen.html).toBe('<html>Payment methods</html>')
    const rep = seen.report as { rows: Record<string, string>[]; totals: Record<string, string>; subtitle: string; columns: { key: string; align?: string }[] }
    expect(rep.subtitle).toContain('2026-04-10')
    expect(rep.rows[0]).toMatchObject({ method: 'cash', received: '590.00', refunds: '118.00', net: '472.00' })
    expect(rep.totals.net).toBe('1,000.00')
    expect(rep.columns.find((c) => c.key === 'net')!.align).toBe('right')
    expect(existsSync(seen.path!)).toBe(false) // temp file cleaned up

    const dir = mkdtempSync(join(tmpdir(), 'rpt-pdf-'))
    const path = join(dir, 'p.pdf')
    const y = (await a2.call('reports', 'exportPdf', { id: 'payment_methods', filters: RANGE, path })) as ReportExportResult
    expect(y.path).toBe(path)
    expect(readFileSync(path, 'utf8')).toBe('%PDF-1.4 fake')
  })

  it('missing printing service: renderHtml falls back to plain HTML, PDF reports a clear error', async () => {
    const a2 = reportsApp()
    buildMini(a2)
    const { html } = (await a2.call('reports', 'renderHtml', { id: 'returns', filters: RANGE })) as { html: string }
    expect(html).toContain('Test Shop')
    expect(html).toContain('RET-1')
    expect(html).toContain('118.00')
    await expect(a2.call('reports', 'exportPdf', { id: 'returns', filters: RANGE })).rejects.toMatchObject({ code: 'PRINT_FAILED' })
  })

  it('renderHtml uses printing.renderReportHtml when available', async () => {
    const a2 = reportsApp()
    buildMini(a2)
    a2.provide('printing', { renderReportHtml: () => ({ html: '<p>from printing</p>' }) })
    expect(await a2.call('reports', 'renderHtml', { id: 'returns', filters: RANGE })).toEqual({ html: '<p>from printing</p>' })
  })
})

import { readFileSync, writeFileSync } from 'node:fs'
import { basename, extname } from 'node:path'
// exceljs is loaded on first use (~460 ms of require() kept out of app startup)
const loadExcel = async () => {
  const mod = (await import('exceljs')) as unknown as { default?: typeof import('exceljs'); Workbook?: typeof import('exceljs').Workbook }
  return (mod.default ?? mod) as typeof import('exceljs')
}
import { AppError } from '@shared/ipc'
import type { FileInputT } from './schemas'

export type Table = { headers: string[]; rows: string[][] }

export const MAX_IMPORT_BYTES = 25 * 1024 * 1024

/** Resolve {path} | {bytesBase64, filename} into bytes (+ name). Tests and the renderer both use this. */
export function readInput(f: FileInputT): { bytes: Buffer; filename: string } {
  if (f.bytesBase64) {
    const bytes = Buffer.from(f.bytesBase64, 'base64')
    if (bytes.length > MAX_IMPORT_BYTES) throw new AppError('VALIDATION', 'File is too large (max 25 MB)')
    return { bytes, filename: f.filename ?? 'import.csv' }
  }
  if (f.path) {
    try {
      const bytes = readFileSync(f.path)
      if (bytes.length > MAX_IMPORT_BYTES) throw new AppError('VALIDATION', 'File is too large (max 25 MB)')
      return { bytes, filename: basename(f.path) }
    } catch (e) {
      if (e instanceof AppError) throw e
      throw new AppError('VALIDATION', `Cannot read file: ${(e as Error).message}`)
    }
  }
  throw new AppError('VALIDATION', 'Provide {path} or {bytesBase64, filename}')
}

// ---------------------------------------------------------------- Electron dialogs (optional; absent in tests)
async function electronDialog(): Promise<any | null> {
  try {
    const mod: any = await import('electron')
    const d = mod?.dialog ?? mod?.default?.dialog
    return d ?? null
  } catch {
    return null
  }
}
export async function chooseSavePath(defaultName: string, ext: string): Promise<string | null | undefined> {
  const d = await electronDialog()
  if (!d) return undefined // no UI available -> caller returns bytes instead
  const r = await d.showSaveDialog({ defaultPath: defaultName, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] })
  return r.canceled || !r.filePath ? null : r.filePath
}
export async function chooseOpenPath(exts: string[]): Promise<string | null | undefined> {
  const d = await electronDialog()
  if (!d) return undefined
  const r = await d.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'Catalog files', extensions: exts }] })
  return r.canceled || !r.filePaths[0] ? null : r.filePaths[0]
}

/** Write bytes to `path`, or pick a path via dialog, or (no UI) hand the bytes back. */
export async function deliver(
  bytes: Buffer, opts: { path?: string; filename: string; ext: string; mime: string }
): Promise<{ path?: string; cancelled?: boolean; bytesBase64?: string; filename: string; mime: string; size: number }> {
  let path = opts.path
  if (!path) {
    const chosen = await chooseSavePath(opts.filename, opts.ext)
    if (chosen === null) return { cancelled: true, filename: opts.filename, mime: opts.mime, size: bytes.length }
    if (chosen === undefined) return { bytesBase64: bytes.toString('base64'), filename: opts.filename, mime: opts.mime, size: bytes.length }
    path = chosen
  }
  writeFileSync(path, bytes)
  return { path, filename: basename(path), mime: opts.mime, size: bytes.length }
}

// ---------------------------------------------------------------- CSV
export function parseCsv(text: string): string[][] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  const firstLine = text.split(/\r?\n/, 1)[0] ?? ''
  const count = (c: string) => firstLine.split(c).length - 1
  const delim = [',', ';', '\t'].reduce((best, c) => (count(c) > count(best) ? c : best), ',')
  const rows: string[][] = []
  let row: string[] = []
  let cur = ''
  let inQ = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') (cur += '"', i++)
        else inQ = false
      } else cur += ch
    } else if (ch === '"' && cur === '') inQ = true
    else if (ch === delim) (row.push(cur), (cur = ''))
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(cur)
      cur = ''
      rows.push(row)
      row = []
    } else cur += ch
  }
  if (cur !== '' || row.length) (row.push(cur), rows.push(row))
  return rows
}

const csvCell = (s: string) => (/[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)
export const toCsv = (headers: string[], rows: string[][]): Buffer =>
  Buffer.from('﻿' + [headers, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n', 'utf8')

// ---------------------------------------------------------------- XLSX
function cellText(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  const o = v as Record<string, unknown>
  if (Array.isArray(o.richText)) return (o.richText as { text: string }[]).map((t) => t.text).join('')
  if ('result' in o) return cellText(o.result)
  if (typeof o.text === 'string') return o.text
  if (o.error) return ''
  return String(v)
}

export async function parseXlsx(bytes: Buffer): Promise<string[][]> {
  const ExcelJS = await loadExcel()
  const wb = new ExcelJS.Workbook()
  try {
    await wb.xlsx.load(bytes as any)
  } catch (e) {
    throw new AppError('VALIDATION', `Not a valid .xlsx file: ${(e as Error).message}`)
  }
  const ws = wb.worksheets[0]
  if (!ws) throw new AppError('VALIDATION', 'The workbook has no sheets')
  const rows: string[][] = []
  const cols = ws.actualColumnCount
  ws.eachRow({ includeEmpty: false }, (row) => {
    const out: string[] = []
    for (let c = 1; c <= cols; c++) out.push(cellText(row.getCell(c).value))
    rows.push(out)
  })
  return rows
}

export async function toXlsx(headers: string[], rows: (string | number)[][], textCols: number[] = []): Promise<Buffer> {
  const ExcelJS = await loadExcel()
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Products')
  ws.addRow(headers).font = { bold: true }
  for (const r of rows) ws.addRow(r)
  for (const c of textCols) ws.getColumn(c + 1).numFmt = '@'
  ws.views = [{ state: 'frozen', ySplit: 1 }]
  headers.forEach((h, i) => (ws.getColumn(i + 1).width = Math.max(12, h.length + 4)))
  return Buffer.from(await wb.xlsx.writeBuffer())
}

/** Parse CSV or XLSX bytes by file extension (falls back to content sniffing: zip magic = xlsx). */
export async function parseTable(bytes: Buffer, filename: string): Promise<Table> {
  const ext = extname(filename).toLowerCase()
  const isZip = bytes.length > 3 && bytes[0] === 0x50 && bytes[1] === 0x4b
  const raw = ext === '.xlsx' || isZip ? await parseXlsx(bytes) : parseCsv(bytes.toString('utf8'))
  const rows = raw.filter((r) => r.some((c) => c.trim() !== ''))
  if (!rows.length) throw new AppError('VALIDATION', 'The file is empty')
  return { headers: rows[0].map((h) => h.trim()), rows: rows.slice(1) }
}

import { parseRupees } from './types'

/** One row of catalog.gridList (a product variant joined with its product). */
export interface GridRow {
  variantId: number; productId: number; sku: string; name: string; variantName: string
  categoryId: number | null; category: string | null; brandId: number | null; brand: string | null
  barcode: string | null; mrp: number; price: number; cost: number; taxRateBp: number; hsn: string
  reorderLevel: number; stock: number; active: boolean; trackStock: boolean
  /** Unique-unit tracking (read-only here: change it in the product form before any unit codes exist). */
  trackUnits?: boolean; unitPrefix?: string | null
}

export type ColKey = 'sku' | 'name' | 'variantName' | 'category' | 'brand' | 'barcode' | 'mrp' | 'price' | 'cost' | 'gst' | 'hsn' | 'reorder' | 'stock' | 'active' | 'trackUnits' | 'unitPrefix'
export interface Col {
  key: ColKey
  header: string
  width: number
  /** patch field understood by catalog.bulkUpdate (undefined = read-only) */
  field?: string
  num?: boolean
  frozen?: boolean
}

export const COLS: Col[] = [
  { key: 'sku', header: 'SKU', width: 110, field: 'sku', frozen: true },
  { key: 'name', header: 'Product name', width: 230, field: 'name', frozen: true },
  { key: 'variantName', header: 'Variant', width: 110, field: 'variantName' },
  { key: 'category', header: 'Category', width: 150, field: 'categoryId' },
  { key: 'brand', header: 'Brand', width: 120, field: 'brandId' },
  { key: 'barcode', header: 'Barcode', width: 140, field: 'barcode' },
  { key: 'mrp', header: 'MRP ₹', width: 90, field: 'mrp', num: true },
  { key: 'price', header: 'Selling ₹', width: 90, field: 'price', num: true },
  { key: 'cost', header: 'Cost ₹', width: 90, field: 'cost', num: true },
  { key: 'gst', header: 'GST %', width: 72, field: 'taxRateBp', num: true },
  { key: 'hsn', header: 'HSN', width: 90, field: 'hsn' },
  { key: 'reorder', header: 'Reorder', width: 80, field: 'reorderLevel', num: true },
  { key: 'stock', header: 'Stock', width: 74, num: true },
  { key: 'active', header: 'Active', width: 70, field: 'active' },
  { key: 'trackUnits', header: 'Unit codes', width: 90 },
  { key: 'unitPrefix', header: 'Prefix', width: 80 }
]
export const FIELD_TO_COL: Record<string, ColKey> = Object.fromEntries(COLS.filter((c) => c.field).map((c) => [c.field!, c.key]))

export const money = (p: number): string => (p / 100).toFixed(2)
const pct = (bp: number): string => String(Number((bp / 100).toFixed(2)))

export function baseText(g: GridRow, k: ColKey): string {
  switch (k) {
    case 'sku': return g.sku
    case 'name': return g.name
    case 'variantName': return g.variantName
    case 'category': return g.category ?? ''
    case 'brand': return g.brand ?? ''
    case 'barcode': return g.barcode ?? ''
    case 'mrp': return money(g.mrp)
    case 'price': return money(g.price)
    case 'cost': return money(g.cost)
    case 'gst': return pct(g.taxRateBp)
    case 'hsn': return g.hsn
    case 'reorder': return String(g.reorderLevel)
    case 'stock': return g.trackStock ? String(g.stock) : 'n/a'
    case 'active': return g.active ? 'Yes' : 'No'
    case 'trackUnits': return g.trackUnits ? 'Yes' : 'No'
    case 'unitPrefix': return g.trackUnits ? (g.unitPrefix ?? '') : ''
  }
}

export const blankRow = (): GridRow => ({
  variantId: 0, productId: 0, sku: '', name: '', variantName: '', categoryId: null, category: null, brandId: null, brand: null,
  barcode: null, mrp: 0, price: 0, cost: 0, taxRateBp: 1800, hsn: '', reorderLevel: 0, stock: 0, active: true, trackStock: true
})

export interface Lookups { categories: Map<string, number>; brands: Map<string, number> }
export type Parsed = { ok: true; value: unknown } | { ok: false; msg: string }

/** Convert the text of a cell into the value sent to bulkUpdate. */
export function parseCell(k: ColKey, raw: string, lk: Lookups): Parsed {
  const t = raw.trim()
  switch (k) {
    case 'mrp': case 'price': case 'cost': {
      const p = parseRupees(t)
      return p === null ? { ok: false, msg: 'Enter a valid amount (digits, up to 2 decimals, not negative)' } : { ok: true, value: p }
    }
    case 'gst': {
      const n = t === '' ? 0 : Number(t.replace(/%$/, ''))
      return Number.isFinite(n) && n >= 0 && n <= 100 ? { ok: true, value: Math.round(n * 100) } : { ok: false, msg: 'GST % must be between 0 and 100' }
    }
    case 'reorder': {
      const n = t === '' ? 0 : Number(t)
      return Number.isInteger(n) && n >= 0 ? { ok: true, value: n } : { ok: false, msg: 'Reorder level must be a whole number, 0 or more' }
    }
    case 'active': {
      const v = t.toLowerCase()
      if (['yes', 'y', '1', 'true', 'active'].includes(v)) return { ok: true, value: true }
      if (['no', 'n', '0', 'false', 'inactive'].includes(v)) return { ok: true, value: false }
      return { ok: false, msg: 'Use Yes or No' }
    }
    case 'category': case 'brand': {
      if (t === '') return { ok: true, value: null }
      const id = (k === 'category' ? lk.categories : lk.brands).get(t.toLowerCase())
      return id ? { ok: true, value: id } : { ok: false, msg: `Unknown ${k} "${t}" (create it under Categories & Brands first)` }
    }
    case 'barcode': return { ok: true, value: t === '' ? null : t }
    case 'name': return t ? { ok: true, value: t } : { ok: false, msg: 'Name is required' }
    case 'sku': return t ? { ok: true, value: t } : { ok: false, msg: 'SKU is required' }
    case 'hsn': return /^\d{0,8}$/.test(t) ? { ok: true, value: t } : { ok: false, msg: 'HSN must be up to 8 digits' }
    default: return { ok: true, value: t }
  }
}

export const GST_OK = new Set([0, 5, 12, 18, 28])

/** Parse clipboard text from Excel / Sheets into a matrix. Handles quoted cells and CRLF; drops one trailing empty line. */
export function parseClipboard(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let q = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (q) {
      if (ch === '"') {
        if (text[i + 1] === '"') (cell += '"', i++)
        else q = false
      } else cell += ch
    } else if (ch === '"' && cell === '') q = true
    else if (ch === '\t') (row.push(cell), (cell = ''))
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += ch
  }
  if (cell !== '' || row.length) (row.push(cell), rows.push(row))
  return rows
}

/** Serialise a matrix for the clipboard (tab/newline, quoting cells that contain tabs, quotes or newlines). */
export function toClipboard(m: string[][]): string {
  const q = (s: string) => (/[\t\n\r"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)
  return m.map((r) => r.map(q).join('\t')).join('\n')
}

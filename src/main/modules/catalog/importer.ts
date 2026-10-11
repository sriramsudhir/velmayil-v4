import type { App } from '../../core/app'
import { AppError } from '@shared/ipc'
import { enqueueProductSnapshot, type CatalogService } from './service'
import { ProductInput, parse, type ProductInputT } from './schemas'
import { parseTable, readInput, toCsv, toXlsx, type Table } from './io'

// ---------------------------------------------------------------- column layout (shared by import, export and template)
export const FIELDS = [
  { key: 'name', header: 'Name', syn: ['name', 'productname', 'product', 'item', 'itemname', 'title', 'description1'] },
  { key: 'variant', header: 'Variant', syn: ['variant', 'variantname', 'size', 'option'] },
  { key: 'sku', header: 'SKU', syn: ['sku', 'code', 'itemcode', 'productcode'] },
  { key: 'barcode', header: 'Barcode', syn: ['barcode', 'ean', 'upc', 'primarybarcode', 'ean13'] },
  { key: 'aliases', header: 'Alias Barcodes', syn: ['aliasbarcodes', 'aliases', 'altbarcodes', 'otherbarcodes', 'alias'] },
  { key: 'category', header: 'Category', syn: ['category', 'group', 'categorypath'] },
  { key: 'brand', header: 'Brand', syn: ['brand', 'manufacturer', 'make'] },
  { key: 'hsn', header: 'HSN', syn: ['hsn', 'hsncode', 'hsnsac'] },
  { key: 'gst', header: 'GST %', syn: ['gst', 'gstrate', 'tax', 'taxrate', 'taxpercent', 'gstpercent'] },
  { key: 'unit', header: 'Unit', syn: ['unit', 'uom'] },
  { key: 'mrp', header: 'MRP', syn: ['mrp', 'maxretailprice'] },
  { key: 'price', header: 'Price', syn: ['price', 'sellingprice', 'saleprice', 'rate', 'sp'] },
  { key: 'cost', header: 'Cost', syn: ['cost', 'costprice', 'purchaseprice', 'cp'] },
  { key: 'reorder', header: 'Reorder Level', syn: ['reorderlevel', 'reorder', 'minstock', 'minimumstock'] },
  { key: 'opening', header: 'Opening Stock', syn: ['openingstock', 'stock', 'qty', 'quantity', 'openingqty'] },
  { key: 'active', header: 'Active', syn: ['active', 'status', 'enabled'] },
  { key: 'trackStock', header: 'Track Stock', syn: ['trackstock', 'trackinventory'] },
  { key: 'description', header: 'Description', syn: ['description', 'desc', 'details'] }
] as const
export type FieldKey = (typeof FIELDS)[number]['key']
export type Mapping = Partial<Record<FieldKey, number | null>>
export const HEADERS: string[] = FIELDS.map((f) => f.header)
const STANDARD_SLABS = new Set([0, 25, 300, 500, 1200, 1800, 2800, 4000])

export function autoMap(headers: string[]): Mapping {
  const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, '')
  const m: Mapping = {}
  const used = new Set<number>()
  for (const f of FIELDS) {
    // exact header match first, then synonyms
    let idx = headers.findIndex((h, i) => !used.has(i) && norm(h) === norm(f.header))
    if (idx < 0) idx = headers.findIndex((h, i) => !used.has(i) && (f.syn as readonly string[]).includes(norm(h)))
    m[f.key] = idx >= 0 ? idx : null
    if (idx >= 0) used.add(idx)
  }
  return m
}

// ---------------------------------------------------------------- scalar parsers
/** Decimal string -> integer scaled by 10^scale (half-up), without float math. null when not a plain number. */
export function parseScaled(input: string, scale: number): number | null {
  const t = input.replace(/[₹,\s]/g, '').replace(/%$/, '')
  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(t)
  if (!m || (!m[2] && !m[3])) return null
  const int = m[2] || '0'
  const frac = m[3] ?? ''
  if (int.length > 12) return null
  let v = Number(int + frac.slice(0, scale).padEnd(scale, '0'))
  if (frac.length > scale && frac[scale] >= '5') v += 1
  return m[1] === '-' ? -v : v
}
const parseBool = (s: string): boolean | null => {
  const t = s.trim().toLowerCase()
  if (['yes', 'y', 'true', '1', 'active', 'enabled'].includes(t)) return true
  if (['no', 'n', 'false', '0', 'inactive', 'disabled'].includes(t)) return false
  return null
}
const fmtPaise = (p: number) => (p / 100).toFixed(2)
const fmtPct = (bp: number) => String(Number((bp / 100).toFixed(2)))

// ---------------------------------------------------------------- normalized rows + plan
export interface NormRow {
  rowNo: number
  name: string
  variant: string | null
  sku: string
  barcode: string | null
  aliases: string[] | null
  category: string | null
  brand: string | null
  hsn: string | null
  taxRateBp: number | null
  unit: string | null
  mrp: number | null
  price: number | null
  cost: number | null
  reorder: number | null
  opening: number | null
  active: boolean | null
  trackStock: boolean | null
  description: string | null
}
export interface PlanRow {
  rowNo: number
  name: string
  sku: string
  errors: string[]
  warnings: string[]
  action: 'create' | 'update' | 'unchanged' | 'invalid'
  productId?: number
  variantId?: number
  groupKey?: string
  norm: NormRow
}
export interface ImportOptions {
  mapping?: Mapping
  mode?: 'all_or_nothing' | 'skip_bad_rows'
}
export interface Preview {
  filename: string
  headers: string[]
  mapping: Mapping
  sample: string[][]
  counts: { total: number; creates: number; updates: number; unchanged: number; invalid: number; warnings: number; newCategories: number; newBrands: number }
  issues: { rowNo: number; name: string; sku: string; errors: string[]; warnings: string[] }[]
  issuesTruncated: boolean
  canCommit: boolean
}

export class Importer {
  constructor(private app: App, private svc: CatalogService) {}
  private get db() {
    return this.app.db
  }

  // ------------------------------------------------------------ parse + plan
  private normalize(table: Table, mapping: Mapping): { plan: PlanRow[]; newCategories: Set<string>; newBrands: Set<string> } {
    if (mapping.name == null) throw new AppError('VALIDATION', 'Map a column to "Name" before importing')
    const cell = (r: string[], k: FieldKey): string | undefined => {
      const i = mapping[k]
      return i == null || i < 0 ? undefined : (r[i] ?? '').trim()
    }
    const defaultTax = Number(this.app.setting('catalog.default_tax_bp', '1800')) || 1800
    const plan: PlanRow[] = []
    const seenSku = new Map<string, number>()
    const seenCode = new Map<string, number>()
    const seenCodeLc = new Map<string, number>()
    // "8901234567890.0": a number cell exported as a decimal. The digits are intact, so drop the ".0" instead of storing it
    const wholeNumber = (s: string) => (/^\d+\.0+$/.test(s) ? s.replace(/\.0+$/, '') : s)
    const groupVariants = new Map<string, Set<string>>()
    const newCategories = new Set<string>()
    const newBrands = new Set<string>()
    const cats = new Set(this.db.all<{ name: string }>('SELECT name FROM categories').map((c) => c.name.toLowerCase()))
    const brands = new Set(this.db.all<{ name: string }>('SELECT name FROM brands').map((c) => c.name.toLowerCase()))

    table.rows.forEach((r, idx) => {
      const rowNo = idx + 2
      const errors: string[] = []
      const warnings: string[] = []
      const get = (k: FieldKey) => {
        const v = cell(r, k)
        return v === undefined || v === '' ? null : v
      }
      const money = (k: FieldKey, label: string): number | null => {
        const s = get(k)
        if (s == null) return null
        const v = parseScaled(s, 2)
        if (v == null) return (errors.push(`${label} "${s}" is not a valid amount`), null)
        if (v < 0) return (errors.push(`${label} cannot be negative`), null)
        return v
      }
      const intField = (k: FieldKey, label: string): number | null => {
        const s = get(k)
        if (s == null) return null
        const v = parseScaled(s, 0)
        if (v == null || !/^[+-]?\d+(\.0*)?$/.test(s.replace(/,/g, ''))) return (errors.push(`${label} "${s}" must be a whole number`), null)
        if (v < 0) return (errors.push(`${label} cannot be negative`), null)
        return v
      }
      const n: NormRow = {
        rowNo, name: (get('name') ?? '').slice(0, 400), variant: get('variant'), sku: get('sku') ?? '', barcode: null, aliases: null,
        category: get('category'), brand: get('brand'), hsn: get('hsn'), taxRateBp: null, unit: get('unit'),
        mrp: money('mrp', 'MRP'), price: money('price', 'Price'), cost: money('cost', 'Cost'),
        reorder: intField('reorder', 'Reorder level'), opening: intField('opening', 'Opening stock'),
        active: null, trackStock: null, description: get('description')
      }
      if (!n.name) errors.push('Name is missing')
      else if (n.name.length > 200) errors.push('Name is longer than 200 characters')
      if ((n.variant ?? '').length > 120) errors.push('Variant name is longer than 120 characters')
      if (n.sku.length > 64) errors.push('SKU is longer than 64 characters')
      if (n.unit && n.unit.length > 16) errors.push('Unit is longer than 16 characters')
      if (n.hsn && !/^\d{1,8}$/.test(n.hsn)) errors.push(`HSN "${n.hsn}" must be 1-8 digits`)

      const gst = get('gst')
      if (gst != null) {
        const bp = parseScaled(gst, 2)
        if (bp == null || bp < 0 || bp > 10000) errors.push(`GST rate "${gst}" is invalid (use 0-100)`)
        else {
          n.taxRateBp = bp
          if (!STANDARD_SLABS.has(bp)) warnings.push(`GST ${fmtPct(bp)}% is not a standard slab (0, 0.25, 3, 5, 12, 18, 28, 40)`)
        }
      }
      const act = get('active')
      if (act != null) {
        n.active = parseBool(act)
        if (n.active === null) errors.push(`Active "${act}" must be Yes or No`)
      }
      const ts = get('trackStock')
      if (ts != null) {
        n.trackStock = parseBool(ts)
        if (n.trackStock === null) errors.push(`Track Stock "${ts}" must be Yes or No`)
      }
      // barcodes
      const codes: string[] = []
      const bc = get('barcode')
      if (bc) {
        const c = this.svc.checkBarcode(wholeNumber(bc))
        if (!c.valid) errors.push(`Barcode: ${c.error}`)
        else (n.barcode = c.code, codes.push(c.code))
      }
      const al = get('aliases')
      if (al != null) {
        n.aliases = []
        for (const a of al.split(/[;|]/).map((x) => x.trim()).filter(Boolean)) {
          const c = this.svc.checkBarcode(wholeNumber(a))
          if (!c.valid) errors.push(`Alias barcode "${a}": ${c.error}`)
          else if (!codes.includes(c.code)) (n.aliases.push(c.code), codes.push(c.code))
        }
      }
      // duplicates inside the file
      if (n.sku) {
        const k = n.sku.toLowerCase()
        const prev = seenSku.get(k)
        if (prev) errors.push(`Duplicate SKU ${n.sku} (also on row ${prev})`)
        else seenSku.set(k, rowNo)
        // a scan resolves barcode before SKU: one row's SKU must not be another row's barcode
        const asCode = seenCodeLc.get(k)
        if (asCode && asCode !== rowNo) errors.push(`SKU ${n.sku} is also the barcode of row ${asCode}`)
      }
      for (const c of codes) {
        const prev = seenCode.get(c)
        if (prev) errors.push(`Duplicate barcode ${c} (also on row ${prev})`)
        else seenCode.set(c, rowNo)
        const asSku = seenSku.get(c.toLowerCase())
        if (asSku && asSku !== rowNo) errors.push(`Barcode ${c} is also the SKU of row ${asSku}`)
        if (!seenCodeLc.has(c.toLowerCase())) seenCodeLc.set(c.toLowerCase(), rowNo)
      }
      // pricing sanity
      if (n.price != null && n.mrp != null && n.mrp > 0 && n.mrp < n.price) warnings.push('MRP is lower than the selling price')
      if (n.price != null && n.cost != null && n.cost > n.price) warnings.push('Cost is higher than the selling price')
      for (const seg of (n.category ?? '').split('>').map((s) => s.trim()).filter(Boolean))
        if (!cats.has(seg.toLowerCase())) newCategories.add(seg.toLowerCase())
      if (n.brand && !brands.has(n.brand.toLowerCase())) newBrands.add(n.brand.toLowerCase())

      const pr: PlanRow = { rowNo, name: n.name, sku: n.sku, errors, warnings, action: 'invalid', norm: n }
      this.resolveTarget(pr, groupVariants, defaultTax)
      if (pr.errors.length) pr.action = 'invalid'
      plan.push(pr)
    })
    return { plan, newCategories, newBrands }
  }

  /** Decide create/update/unchanged by SKU, then barcode, then (no SKU & no barcode) product+variant name. Adds DB conflict errors. */
  private resolveTarget(pr: PlanRow, groupVariants: Map<string, Set<string>>, defaultTax: number): void {
    const n = pr.norm
    const { errors } = pr
    const variantRow = (where: string, ...p: (string | number)[]) =>
      this.db.get<Record<string, any>>(
        `SELECT v.*, p.name AS pname, p.description AS pdesc, p.hsn, p.tax_rate_bp, p.unit, p.track_stock, p.active AS pactive, p.category_id, p.brand_id
         FROM product_variants v JOIN products p ON p.id = v.product_id WHERE ${where}`,
        ...p
      )
    let target: Record<string, any> | undefined
    if (n.sku) {
      target = variantRow('v.sku = ? COLLATE NOCASE', n.sku)
    } else if (n.barcode) {
      target = variantRow('v.barcode = ?', n.barcode) ?? variantRow('v.id = (SELECT variant_id FROM variant_barcodes WHERE barcode = ?)', n.barcode)
    } else if (n.name) {
      target = variantRow('p.name = ? COLLATE NOCASE AND v.name = ? COLLATE NOCASE ORDER BY v.id LIMIT 1', n.name, n.variant ?? '')
    }
    const exceptId = target?.id as number | undefined
    for (const c of [n.barcode, ...(n.aliases ?? [])]) {
      if (!c) continue
      const o = this.svc.barcodeOwner(c, exceptId)
      if (o) errors.push(o.via === 'sku' ? `Barcode ${c} is already the SKU of "${o.name}"` : `Barcode ${c} already belongs to "${o.name}"`)
      else {
        const unitClash = c === target?.barcode ? undefined : this.svc.unitNamespaceClash(c)
        if (unitClash) errors.push(unitClash)
      }
    }
    if (n.sku && !target) {
      // new SKU (unique among SKUs, see the lookup above): it must not be another item's barcode either
      const shadow = this.svc.skuShadowedBy(n.sku)
      if (shadow) errors.push(`SKU ${n.sku} is already the barcode of "${shadow.name}"`)
      const unitClash = this.svc.unitNamespaceClash(n.sku, 'SKU')
      if (unitClash) errors.push(unitClash)
    }

    if (target) {
      pr.productId = target.product_id
      pr.variantId = target.id
      if (!pr.sku) pr.sku = target.sku
      pr.action = this.isUnchanged(target, n) ? 'unchanged' : 'update'
      return
    }
    // create path: attach to existing product by name when a variant name is given
    pr.action = 'create'
    const vname = (n.variant ?? '').toLowerCase()
    if (n.name && n.variant) {
      const prod = this.db.get<{ id: number }>('SELECT id FROM products WHERE name = ? COLLATE NOCASE ORDER BY id LIMIT 1', n.name)
      if (prod) {
        pr.productId = prod.id
        const clash = this.db.get<{ sku: string }>('SELECT sku FROM product_variants WHERE product_id = ? AND name = ? COLLATE NOCASE', prod.id, n.variant)
        if (clash) errors.push(`Variant "${n.variant}" already exists on "${n.name}" (SKU ${clash.sku})`)
      } else {
        pr.groupKey = n.name.toLowerCase()
      }
    }
    if (pr.groupKey) {
      const set = groupVariants.get(pr.groupKey) ?? groupVariants.set(pr.groupKey, new Set()).get(pr.groupKey)!
      if (set.has(vname)) errors.push(`Variant "${n.variant}" is repeated for "${n.name}" in this file`)
      set.add(vname)
    }
    if (n.price == null) pr.warnings.push('Price is missing; it will be 0')
    else if (n.price === 0) pr.warnings.push('Price is 0')
    if (n.taxRateBp == null) pr.warnings.push(`GST rate missing; default ${fmtPct(defaultTax)}% will be used`)
  }

  private isUnchanged(t: Record<string, any>, n: NormRow): boolean {
    const eq = (a: unknown, b: unknown) => a === b
    if (n.name !== t.pname) return false
    if (n.variant != null && n.variant !== t.name) return false
    if (n.mrp != null && n.mrp !== t.mrp) return false
    if (n.price != null && n.price !== t.price) return false
    if (n.cost != null && n.cost !== t.cost) return false
    if (n.reorder != null && n.reorder !== t.reorder_level) return false
    if (n.hsn != null && n.hsn !== t.hsn) return false
    if (n.taxRateBp != null && n.taxRateBp !== t.tax_rate_bp) return false
    if (n.unit != null && n.unit !== t.unit) return false
    if (n.description != null && n.description !== t.pdesc) return false
    if (n.barcode != null && !eq(n.barcode, t.barcode)) return false
    if (n.sku && n.sku !== t.sku) return false
    if (n.active != null && n.active !== !!(t.active && t.pactive)) return false
    if (n.trackStock != null && n.trackStock !== !!t.track_stock) return false
    if (n.category != null) {
      const leaf = n.category.split('>').map((s) => s.trim()).filter(Boolean).pop() ?? ''
      const cur = t.category_id ? this.db.value<string>('SELECT name FROM categories WHERE id = ?', t.category_id) : ''
      if (leaf.toLowerCase() !== (cur ?? '').toLowerCase()) return false
    }
    if (n.brand != null) {
      const cur = t.brand_id ? this.db.value<string>('SELECT name FROM brands WHERE id = ?', t.brand_id) : ''
      if (n.brand.toLowerCase() !== (cur ?? '').toLowerCase()) return false
    }
    if (n.aliases != null) {
      const have = this.db.all<{ barcode: string }>('SELECT barcode FROM variant_barcodes WHERE variant_id = ?', t.id).map((x) => x.barcode).sort()
      if (JSON.stringify(have) !== JSON.stringify([...n.aliases].sort())) return false
    }
    return true
  }

  private async load(file: { path?: string; bytesBase64?: string; filename?: string }, mapping?: Mapping) {
    const { bytes, filename } = readInput(file)
    const table = await parseTable(bytes, filename)
    const map = mapping ?? autoMap(table.headers)
    return { table, map, filename }
  }

  // ------------------------------------------------------------ preview
  async preview(file: { path?: string; bytesBase64?: string; filename?: string }, opts: ImportOptions = {}): Promise<Preview> {
    const { table, map, filename } = await this.load(file, opts.mapping)
    const base = { filename, headers: table.headers, mapping: map, sample: table.rows.slice(0, 5) }
    if (map.name == null) {
      return {
        ...base, issues: [], issuesTruncated: false, canCommit: false,
        counts: { total: table.rows.length, creates: 0, updates: 0, unchanged: 0, invalid: 0, warnings: 0, newCategories: 0, newBrands: 0 }
      }
    }
    const { plan, newCategories, newBrands } = this.normalize(table, map)
    const issues = plan.filter((p) => p.errors.length || p.warnings.length)
    const count = (a: PlanRow['action']) => plan.filter((p) => p.action === a).length
    const invalid = count('invalid')
    return {
      ...base,
      counts: {
        total: plan.length, creates: count('create'), updates: count('update'), unchanged: count('unchanged'), invalid,
        warnings: plan.filter((p) => p.warnings.length).length, newCategories: newCategories.size, newBrands: newBrands.size
      },
      issues: issues.slice(0, 1000).map((p) => ({ rowNo: p.rowNo, name: p.name, sku: p.sku, errors: p.errors, warnings: p.warnings })),
      issuesTruncated: issues.length > 1000,
      canCommit: plan.length > 0 && invalid < plan.length
    }
  }

  // ------------------------------------------------------------ commit
  async commit(file: { path?: string; bytesBase64?: string; filename?: string }, opts: ImportOptions = {}) {
    const { table, map } = await this.load(file, opts.mapping)
    const mode = opts.mode ?? 'all_or_nothing'
    const { plan } = this.normalize(table, map)
    const bad = plan.filter((p) => p.errors.length)
    if (mode === 'all_or_nothing' && bad.length)
      throw new AppError('VALIDATION', `${bad.length} row(s) have errors - nothing was imported. Fix them or use "skip bad rows".`, {
        rows: bad.slice(0, 50).map((p) => ({ rowNo: p.rowNo, errors: p.errors }))
      })
    const good = plan.filter((p) => !p.errors.length)
    const result = this.db.transaction(() => {
      const r = { created: 0, updated: 0, unchanged: 0, skipped: bad.length, openingStockRows: 0 }
      const groups = new Map<string, number>()
      const catCache = new Map<string, number | null>()
      const cat = (path: string) => {
        const k = path.toLowerCase()
        if (!catCache.has(k)) catCache.set(k, this.svc.ensureCategoryPath(path))
        return catCache.get(k)!
      }
      const brandCache = new Map<string, number | null>()
      const brand = (name: string) => {
        const k = name.toLowerCase()
        if (!brandCache.has(k)) brandCache.set(k, this.svc.ensureBrand(name))
        return brandCache.get(k)!
      }
      const deferSync = new Set<number>()
      const defaultTax = Number(this.app.setting('catalog.default_tax_bp', '1800')) || 1800
      for (const p of good) {
        const n = p.norm
        if (p.action === 'unchanged') {
          r.unchanged++
          continue
        }
        const note = 'Import row ' + p.rowNo
        const variant = {
          id: p.action === 'update' ? p.variantId : undefined,
          name: n.variant ?? undefined,
          sku: n.sku || undefined,
          barcode: n.barcode ?? undefined,
          aliases: n.aliases ?? undefined,
          mrp: n.mrp ?? undefined,
          price: n.price ?? undefined,
          cost: n.cost ?? undefined,
          reorderLevel: n.reorder ?? undefined,
          active: n.active ?? undefined,
          openingStock: p.action === 'create' ? n.opening ?? undefined : undefined
        }
        if (p.action === 'update') {
          const old = this.db.get<Record<string, any>>('SELECT * FROM product_variants WHERE id = ?', p.variantId!)!
          const multi = (this.db.value<number>('SELECT COUNT(*) FROM product_variants WHERE product_id = ?', p.productId!) ?? 1) > 1
          const input = this.baseInput(p.productId!, {
            name: n.name,
            description: n.description ?? undefined,
            categoryId: n.category != null ? cat(n.category) : undefined,
            brandId: n.brand != null ? brand(n.brand) : undefined,
            hsn: n.hsn ?? undefined, taxRateBp: n.taxRateBp ?? undefined, unit: n.unit ?? undefined, trackStock: n.trackStock ?? undefined,
            active: n.active == null ? undefined : n.active ? true : multi ? undefined : false
          }, [{ ...variant, name: variant.name ?? old.name, mrp: variant.mrp ?? old.mrp, price: variant.price ?? old.price, cost: variant.cost ?? old.cost, reorderLevel: variant.reorderLevel ?? old.reorder_level, active: variant.active ?? !!old.active }])
          this.svc.saveTx(input, { note, deferSync })
          r.updated++
          continue
        }
        // create
        const existingProduct = p.productId ?? (p.groupKey ? groups.get(p.groupKey) : undefined)
        if (existingProduct) {
          const input = this.baseInput(existingProduct, {}, [{ ...variant, name: variant.name ?? '' }])
          this.svc.saveTx(input, { note, deferSync })
        } else {
          const raw: Record<string, unknown> = {
            name: n.name, description: n.description ?? '', categoryId: n.category ? cat(n.category) : null,
            brandId: n.brand ? brand(n.brand) : null, hsn: n.hsn ?? '', taxRateBp: n.taxRateBp ?? defaultTax,
            unit: n.unit ?? 'pcs', trackStock: n.trackStock ?? true, active: true,
            variants: [{ ...variant, name: variant.name ?? '', active: variant.active ?? true }]
          }
          const out = this.svc.saveTx(parse(ProductInput, raw), { note, deferSync, quietCreate: true })
          if (p.groupKey) groups.set(p.groupKey, out.productId)
        }
        if (n.opening) r.openingStockRows++
        r.created++
      }
      for (const id of deferSync) enqueueProductSnapshot(this.app, id)
      this.app.audit({
        entity: 'catalog', action: 'import', note: `created ${r.created}, updated ${r.updated}, unchanged ${r.unchanged}, skipped ${r.skipped}`,
        new: { mode, rows: plan.length }
      })
      return r
    })
    return {
      ...result, mode,
      errors: bad.slice(0, 200).map((p) => ({ rowNo: p.rowNo, name: p.name, errors: p.errors }))
    }
  }

  /** Build a full ProductInput for an existing product, applying overrides (undefined = keep). */
  private baseInput(productId: number, o: Partial<ProductInputT>, variants: unknown[]): ProductInputT {
    const p = this.db.get<Record<string, any>>('SELECT * FROM products WHERE id = ?', productId)!
    const pick = <T>(v: T | undefined, cur: T) => (v === undefined ? cur : v)
    return parse(ProductInput, {
      id: productId,
      name: pick(o.name, p.name), description: pick(o.description, p.description),
      categoryId: pick(o.categoryId, p.category_id), brandId: pick(o.brandId, p.brand_id),
      hsn: pick(o.hsn, p.hsn), taxRateBp: pick(o.taxRateBp, p.tax_rate_bp), unit: pick(o.unit, p.unit),
      trackStock: pick(o.trackStock, !!p.track_stock), active: pick(o.active, !!p.active),
      variants: variants.map((v) => Object.fromEntries(Object.entries(v as object).filter(([, x]) => x !== undefined)))
    })
  }

  // ------------------------------------------------------------ export + template
  exportRows(filters: { categoryId?: number; brandId?: number; active?: boolean; includeStock?: boolean } = {}): (string | number)[][] {
    const w = ['1=1']
    const params: number[] = []
    if (filters.categoryId) (w.push(`p.category_id IN (WITH RECURSIVE t(id) AS (SELECT ? UNION ALL SELECT c.id FROM categories c JOIN t ON c.parent_id=t.id) SELECT id FROM t)`), params.push(filters.categoryId))
    if (filters.brandId) (w.push('p.brand_id = ?'), params.push(filters.brandId))
    if (filters.active !== undefined) (w.push('p.active = ?'), params.push(filters.active ? 1 : 0))
    const cats = new Map(this.db.all<{ id: number; name: string; parent_id: number | null }>('SELECT id, name, parent_id FROM categories').map((c) => [c.id, c]))
    const path = (id: number | null): string => {
      const parts: string[] = []
      for (let c = id ? cats.get(id) : undefined, hops = 0; c && hops < 50; c = c.parent_id ? cats.get(c.parent_id) : undefined, hops++) parts.unshift(c.name)
      return parts.join(' > ')
    }
    const aliasMap = new Map<number, string[]>()
    for (const a of this.db.all<{ variant_id: number; barcode: string }>('SELECT variant_id, barcode FROM variant_barcodes ORDER BY rowid'))
      (aliasMap.get(a.variant_id) ?? aliasMap.set(a.variant_id, []).get(a.variant_id)!).push(a.barcode)
    const rows = this.db.all<Record<string, any>>(
      `SELECT p.name pname, p.description, p.category_id, b.name brand, p.hsn, p.tax_rate_bp, p.unit, p.track_stock, p.active pactive,
              v.id vid, v.name vname, v.sku, v.barcode, v.mrp, v.price, v.cost, v.reorder_level, v.active vactive,
              COALESCE((SELECT SUM(qty) FROM stock_levels s WHERE s.variant_id = v.id), 0) AS stock
       FROM products p JOIN product_variants v ON v.product_id = p.id LEFT JOIN brands b ON b.id = p.brand_id
       WHERE ${w.join(' AND ')} ORDER BY p.name COLLATE NOCASE, p.id, v.id`,
      ...params
    )
    return rows.map((r) => [
      r.pname, r.vname, r.sku, r.barcode ?? '', (aliasMap.get(r.vid) ?? []).join(';'), path(r.category_id), r.brand ?? '', r.hsn,
      fmtPct(r.tax_rate_bp), r.unit, fmtPaise(r.mrp), fmtPaise(r.price), fmtPaise(r.cost), String(r.reorder_level),
      filters.includeStock ? String(r.stock) : '', r.pactive && r.vactive ? 'Yes' : 'No', r.track_stock ? 'Yes' : 'No', r.description
    ])
  }

  async buildExport(format: 'csv' | 'xlsx', filters: Parameters<Importer['exportRows']>[0] = {}): Promise<Buffer> {
    const rows = this.exportRows(filters)
    return format === 'csv' ? toCsv(HEADERS, rows as string[][]) : toXlsx(HEADERS, rows, [1, 2, 3, 4, 7, 8, 14, 17])
  }

  async buildTemplate(format: 'csv' | 'xlsx'): Promise<Buffer> {
    const rows = [
      ['Cotton Shirt', 'M', 'SHIRT-M', '', '', 'Apparel > Shirts', 'Acme', '6205', '12', 'pcs', '999.00', '799.00', '500.00', '5', '20', 'Yes', 'Yes', 'Sample variant row'],
      ['Cotton Shirt', 'L', 'SHIRT-L', '', '', 'Apparel > Shirts', 'Acme', '6205', '12', 'pcs', '999.00', '799.00', '500.00', '5', '10', 'Yes', 'Yes', ''],
      ['Notebook A5', '', 'NB-A5', '', '', 'Stationery', '', '4820', '12', 'pcs', '60.00', '50.00', '35.00', '10', '100', 'Yes', 'Yes', 'Simple product (no variant)']
    ]
    return format === 'csv' ? toCsv(HEADERS, rows) : toXlsx(HEADERS, rows, [1, 2, 3, 4, 7, 8, 14, 17])
  }
}

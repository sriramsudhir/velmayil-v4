import { z } from 'zod'
import type { App } from '../../core/app'
import { AppError } from '@shared/ipc'
import { enqueueProductSnapshot, type CatalogService } from './service'
import { ProductInput } from './schemas'

const money = z.number().int().min(0, 'Cannot be negative').max(2_000_000_000, 'Too large')

/** Editable cells of the spreadsheet. Product-level: name, categoryId, brandId, hsn, taxRateBp. Variant-level: the rest. */
export const GridPatch = z
  .object({
    name: z.string().trim().min(1, 'Name is required').max(200),
    variantName: z.string().trim().max(120),
    sku: z.string().trim().min(1, 'SKU is required').max(64),
    barcode: z.string().trim().max(64).nullable(),
    categoryId: z.number().int().positive().nullable(),
    brandId: z.number().int().positive().nullable(),
    mrp: money,
    price: money,
    cost: money,
    taxRateBp: z.number().int().min(0, 'GST cannot be negative').max(10000, 'GST cannot exceed 100%'),
    hsn: z.string().trim().regex(/^\d{0,8}$/, 'HSN must be up to 8 digits'),
    reorderLevel: z.number().int().min(0, 'Cannot be negative').max(1_000_000_000),
    active: z.boolean()
  })
  .partial()
  .strict()
export type GridPatchT = z.output<typeof GridPatch>

export const BulkUpdateInput = z.object({
  rows: z
    .array(
      z.object({
        /** existing variant to update; omit to create a NEW product (needs patch.name) */
        variantId: z.number().int().positive().optional(),
        /** client key echoed back in errors (e.g. temp id of a new row) */
        key: z.string().max(64).optional(),
        patch: z.record(z.string(), z.unknown())
      })
    )
    .min(1, 'Nothing to save')
    .max(5000, 'Too many rows in one save (max 5000)')
})

export interface RowError { variantId?: number; key?: string; field?: string; message: string }
export interface BulkResult { updated: number; created: number; unchanged: number; variantIds: number[] }

export interface GridRow {
  variantId: number
  productId: number
  sku: string
  name: string
  variantName: string
  categoryId: number | null
  category: string | null
  brandId: number | null
  brand: string | null
  barcode: string | null
  mrp: number
  price: number
  cost: number
  taxRateBp: number
  hsn: string
  reorderLevel: number
  stock: number
  active: boolean
  trackStock: boolean
}

export function gridList(app: App, raw: unknown): { rows: GridRow[]; total: number } {
  app.requirePermission('catalog.view')
  const a = z.object({ active: z.boolean().optional(), limit: z.number().int().min(1).max(100000).default(100000) }).parse(raw ?? {})
  const rows = app.db.all<Record<string, any>>(
    `SELECT v.id AS variant_id, p.id AS product_id, v.sku, p.name, v.name AS variant_name, p.category_id, c.name AS category,
            p.brand_id, b.name AS brand, v.barcode, v.mrp, v.price, v.cost, p.tax_rate_bp, p.hsn, v.reorder_level, p.track_stock,
            (v.active AND p.active) AS active,
            COALESCE((SELECT SUM(qty) FROM stock_levels s WHERE s.variant_id = v.id), 0) AS stock
     FROM product_variants v JOIN products p ON p.id = v.product_id
     LEFT JOIN categories c ON c.id = p.category_id LEFT JOIN brands b ON b.id = p.brand_id
     ${a.active === undefined ? '' : 'WHERE (v.active AND p.active) = ' + (a.active ? 1 : 0)}
     ORDER BY p.name COLLATE NOCASE, v.id LIMIT ?`,
    a.limit
  )
  return {
    total: rows.length,
    rows: rows.map((r) => ({
      variantId: r.variant_id, productId: r.product_id, sku: r.sku, name: r.name, variantName: r.variant_name,
      categoryId: r.category_id, category: r.category, brandId: r.brand_id, brand: r.brand, barcode: r.barcode,
      mrp: r.mrp, price: r.price, cost: r.cost, taxRateBp: r.tax_rate_bp, hsn: r.hsn, reorderLevel: r.reorder_level,
      stock: r.stock, active: !!r.active, trackStock: !!r.track_stock
    }))
  }
}

/**
 * Apply many cell edits in ONE transaction. Any invalid row => nothing is saved and every row error is returned in
 * AppError('VALIDATION').details.rowErrors. Barcodes are only touched when the patch contains `barcode` (a price edit never
 * changes it); a replaced barcode is kept as an alias so printed labels keep scanning.
 */
export function bulkUpdate(app: App, svc: CatalogService, raw: unknown): BulkResult {
  app.requirePermission('catalog.edit')
  const parsed = BulkUpdateInput.safeParse(raw ?? {})
  if (!parsed.success) throw new AppError('VALIDATION', parsed.error.issues[0].message, parsed.error.issues)
  const db = app.db
  return db.transaction(() => {
    const errors: RowError[] = []
    const touched = new Set<number>()
    const out: BulkResult = { updated: 0, created: 0, unchanged: 0, variantIds: [] }
    const now = Date.now()

    for (const row of parsed.data.rows) {
      const id = { variantId: row.variantId, key: row.key }
      const p = GridPatch.safeParse(row.patch)
      if (!p.success) {
        for (const i of p.error.issues) errors.push({ ...id, field: String(i.path[0] ?? ''), message: i.message })
        continue
      }
      const patch = p.data
      try {
        if (row.variantId === undefined) createRow(patch, errors, id)
        else updateRow(row.variantId, patch, errors, id)
      } catch (e) {
        errors.push({ ...id, message: e instanceof Error ? e.message : String(e) })
      }
    }

    if (errors.length)
      throw new AppError('VALIDATION', `${errors.length} problem(s) found; nothing was saved. ${errors[0].message}`, { rowErrors: errors })

    for (const pid of touched) enqueueProductSnapshot(app, pid)
    app.audit({ entity: 'catalog', action: 'bulk_update', new: { updated: out.updated, created: out.created, rows: parsed.data.rows.length } })
    return out

    // ---------------------------------------------------------------- helpers
    function createRow(patch: GridPatchT, errs: RowError[], id: { variantId?: number; key?: string }): void {
      if (!patch.name) return void errs.push({ ...id, field: 'name', message: 'Name is required for a new product' })
      const input = ProductInput.safeParse({
        name: patch.name, categoryId: patch.categoryId ?? null, brandId: patch.brandId ?? null, hsn: patch.hsn ?? '',
        taxRateBp: patch.taxRateBp ?? Number(app.setting('catalog.default_tax_bp', '1800')),
        variants: [{
          name: patch.variantName ?? '', sku: patch.sku, barcode: patch.barcode ?? undefined, autoBarcode: !patch.barcode,
          mrp: patch.mrp ?? 0, price: patch.price ?? 0, cost: patch.cost ?? 0, reorderLevel: patch.reorderLevel ?? 0, active: patch.active ?? true
        }]
      })
      if (!input.success) return void errs.push({ ...id, message: input.error.issues[0].message })
      const before = errs.length
      try {
        const r = svc.saveTx(input.data, { deferSync: touched, note: 'grid' })
        out.created++
        out.variantIds.push(...r.variantIds)
      } catch (e) {
        if (errs.length === before) errs.push({ ...id, message: e instanceof Error ? e.message : String(e) })
      }
    }

    function updateRow(variantId: number, patch: GridPatchT, errs: RowError[], id: { variantId?: number; key?: string }): void {
      const v = db.get<Record<string, any>>('SELECT * FROM product_variants WHERE id = ?', variantId)
      const p0 = v && db.get<Record<string, any>>('SELECT * FROM products WHERE id = ?', v.product_id)
      if (!v || !p0) return void errs.push({ ...id, message: 'Item no longer exists (refresh the grid)' })
      const bad = (field: string, message: string) => errs.push({ ...id, field, message })
      const before = errs.length

      if (patch.categoryId && !db.value('SELECT 1 FROM categories WHERE id = ?', patch.categoryId)) bad('categoryId', 'Category does not exist')
      if (patch.brandId && !db.value('SELECT 1 FROM brands WHERE id = ?', patch.brandId)) bad('brandId', 'Brand does not exist')

      let sku = v.sku as string
      if (patch.sku !== undefined && patch.sku !== v.sku) {
        const o = svc.skuOwner(patch.sku, v.id)
        const shadow = o ? undefined : svc.skuShadowedBy(patch.sku, v.id)
        const unitClash = svc.unitNamespaceClash(patch.sku, 'SKU')
        if (o) bad('sku', `SKU ${patch.sku} is already used by "${o.name}"`)
        else if (shadow) bad('sku', `SKU ${patch.sku} is already the barcode of "${shadow.name}"`)
        else if (unitClash) bad('sku', unitClash)
        else sku = patch.sku
      }
      let barcode: string | null = v.barcode
      if (patch.barcode !== undefined) {
        const code = patch.barcode ? patch.barcode : null
        if (code) {
          const c = svc.checkBarcode(code)
          if (!c.valid) bad('barcode', c.error ?? 'Invalid barcode')
          else {
            const o = c.code !== v.barcode ? svc.barcodeOwner(c.code, v.id) : undefined
            const unitClash = c.code !== v.barcode ? svc.unitNamespaceClash(c.code) : undefined
            if (o) bad('barcode', o.via === 'sku' ? `Barcode ${c.code} is already the SKU of "${o.name}"` : `Barcode ${c.code} is already used by "${o.name}"`)
            else if (unitClash) bad('barcode', unitClash)
            else barcode = c.code
          }
        } else barcode = null
      }
      const variantName = patch.variantName ?? v.name
      if (patch.variantName !== undefined && patch.variantName.toLowerCase() !== String(v.name).toLowerCase()) {
        const clash = db.value('SELECT 1 FROM product_variants WHERE product_id = ? AND id <> ? AND name = ? COLLATE NOCASE', v.product_id, v.id, patch.variantName)
        if (clash) bad('variantName', `Variant "${patch.variantName || '(default)'}" already exists on this product`)
      }
      if (errs.length > before) return

      // ---- variant level
      const nextV = {
        name: variantName, sku, barcode, mrp: patch.mrp ?? v.mrp, price: patch.price ?? v.price, cost: patch.cost ?? v.cost,
        reorder_level: patch.reorderLevel ?? v.reorder_level, active: patch.active === undefined ? v.active : patch.active ? 1 : 0
      }
      const vChanges = Object.entries(nextV).filter(([k, nv]) => v[k] !== nv).map(([k]) => k)
      // ---- product level
      const nextP = {
        name: patch.name ?? p0.name, category_id: patch.categoryId === undefined ? p0.category_id : patch.categoryId,
        brand_id: patch.brandId === undefined ? p0.brand_id : patch.brandId, hsn: patch.hsn ?? p0.hsn, tax_rate_bp: patch.taxRateBp ?? p0.tax_rate_bp,
        active: patch.active === true ? 1 : p0.active
      }
      const pChanges = Object.entries(nextP).filter(([k, nv]) => p0[k] !== nv).map(([k]) => k)
      if (!vChanges.length && !pChanges.length) {
        out.unchanged++
        return
      }

      if (vChanges.length) {
        if (barcode && vChanges.includes('barcode')) svc.claimBarcode(barcode) // typed the generator's next number: consume it
        db.run(
          'UPDATE product_variants SET name=?,sku=?,barcode=?,mrp=?,price=?,cost=?,reorder_level=?,active=?,updated_at=? WHERE id=?',
          nextV.name, nextV.sku, nextV.barcode, nextV.mrp, nextV.price, nextV.cost, nextV.reorder_level, nextV.active, now, v.id
        )
        if (vChanges.includes('barcode') && v.barcode && barcode !== v.barcode && !db.value('SELECT 1 FROM variant_barcodes WHERE barcode = ?', v.barcode))
          db.run('INSERT INTO variant_barcodes(barcode, variant_id) VALUES (?,?)', v.barcode, v.id) // old printed labels keep working
        if (barcode && db.value('SELECT 1 FROM variant_barcodes WHERE barcode = ? AND variant_id = ?', barcode, v.id))
          db.run('DELETE FROM variant_barcodes WHERE barcode = ?', barcode) // promoted alias is now primary
        if (['mrp', 'price', 'cost'].some((k) => vChanges.includes(k)))
          app.audit({
            entity: 'variant', entityId: v.id, action: 'price_change', note: `${v.sku} (grid)`,
            old: { mrp: v.mrp, price: v.price, cost: v.cost }, new: { mrp: nextV.mrp, price: nextV.price, cost: nextV.cost }
          })
        const other = vChanges.filter((k) => !['mrp', 'price', 'cost'].includes(k))
        if (other.length)
          app.audit({
            entity: 'variant', entityId: v.id, action: 'update', note: 'grid',
            old: Object.fromEntries(other.map((k) => [k, v[k]])), new: Object.fromEntries(other.map((k) => [k, (nextV as any)[k]]))
          })
      }
      if (pChanges.length) {
        db.run('UPDATE products SET name=?,category_id=?,brand_id=?,hsn=?,tax_rate_bp=?,active=?,updated_at=? WHERE id=?',
          nextP.name, nextP.category_id, nextP.brand_id, nextP.hsn, nextP.tax_rate_bp, nextP.active, now, p0.id)
        if (pChanges.includes('tax_rate_bp') || pChanges.includes('hsn'))
          app.audit({
            entity: 'product', entityId: p0.id, action: 'tax_change', note: 'grid',
            old: { taxRateBp: p0.tax_rate_bp, hsn: p0.hsn }, new: { taxRateBp: nextP.tax_rate_bp, hsn: nextP.hsn }
          })
        const rest = pChanges.filter((k) => k !== 'tax_rate_bp' && k !== 'hsn')
        if (rest.length)
          app.audit({
            entity: 'product', entityId: p0.id, action: 'update', note: 'grid',
            old: Object.fromEntries(rest.map((k) => [k, p0[k]])), new: Object.fromEntries(rest.map((k) => [k, (nextP as any)[k]]))
          })
      } else db.run('UPDATE products SET updated_at = ? WHERE id = ?', now, p0.id)
      touched.add(p0.id)
      out.updated++
      out.variantIds.push(v.id)
    }
  })
}

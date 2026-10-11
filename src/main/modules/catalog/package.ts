import { createHash } from 'node:crypto'
import { gunzipSync, gzipSync } from 'node:zlib'
import type { App } from '../../core/app'
import type { Db } from '../../db/driver'
import { AppError } from '@shared/ipc'
import { enqueueProductSnapshot } from './service'

/**
 * Catalog package: a single versioned, checksummed JSON describing categories, brands, products, variants and alias
 * barcodes, keyed by uuid, so one POS can distribute its catalog to another (file now, network sync later).
 * buildPackage/encode/decode are pure; mergePackage is last-writer-wins by updated_at and reports conflicts.
 */
export const PACKAGE_FORMAT = 'velmayil-catalog'
export const PACKAGE_SCHEMA_VERSION = 1

export interface PkgCategory { uuid: string; name: string; parentUuid: string | null; active: boolean; updatedAt: number }
export interface PkgBrand { uuid: string; name: string; active: boolean; updatedAt: number }
export interface PkgProduct {
  uuid: string; name: string; description: string; categoryUuid: string | null; brandUuid: string | null; hsn: string
  taxRateBp: number; unit: string; trackStock: boolean; active: boolean; createdAt: number; updatedAt: number
}
export interface PkgVariant {
  uuid: string; productUuid: string; name: string; sku: string; barcode: string | null; mrp: number; price: number; cost: number
  reorderLevel: number; active: boolean; createdAt: number; updatedAt: number
}
export interface PkgBarcode { barcode: string; variantUuid: string }
export interface PackageData {
  categories: PkgCategory[]
  brands: PkgBrand[]
  products: PkgProduct[]
  variants: PkgVariant[]
  barcodes: PkgBarcode[]
}
export interface CatalogPackage {
  format: typeof PACKAGE_FORMAT
  schemaVersion: number
  exportedAt: number
  source: { posCode: string | null }
  checksum: string
  data: PackageData
}

export const checksumOf = (data: PackageData): string => createHash('sha256').update(JSON.stringify(data)).digest('hex')

export function buildPackage(db: Db, opts: { now?: number } = {}): CatalogPackage {
  const b = (v: unknown) => !!v
  const data: PackageData = {
    categories: db
      .all<Record<string, any>>(
        `SELECT c.uuid, c.name, pc.uuid AS parent_uuid, c.active, c.updated_at FROM categories c LEFT JOIN categories pc ON pc.id = c.parent_id ORDER BY c.uuid`
      )
      .map((r) => ({ uuid: r.uuid, name: r.name, parentUuid: r.parent_uuid, active: b(r.active), updatedAt: r.updated_at })),
    brands: db
      .all<Record<string, any>>('SELECT uuid, name, active, updated_at FROM brands ORDER BY uuid')
      .map((r) => ({ uuid: r.uuid, name: r.name, active: b(r.active), updatedAt: r.updated_at })),
    products: db
      .all<Record<string, any>>(
        `SELECT p.*, c.uuid AS cuuid, br.uuid AS buuid FROM products p LEFT JOIN categories c ON c.id = p.category_id
         LEFT JOIN brands br ON br.id = p.brand_id ORDER BY p.uuid`
      )
      .map((r) => ({
        uuid: r.uuid, name: r.name, description: r.description, categoryUuid: r.cuuid, brandUuid: r.buuid, hsn: r.hsn,
        taxRateBp: r.tax_rate_bp, unit: r.unit, trackStock: b(r.track_stock), active: b(r.active), createdAt: r.created_at, updatedAt: r.updated_at
      })),
    variants: db
      .all<Record<string, any>>(`SELECT v.*, p.uuid AS puuid FROM product_variants v JOIN products p ON p.id = v.product_id ORDER BY v.uuid`)
      .map((r) => ({
        uuid: r.uuid, productUuid: r.puuid, name: r.name, sku: r.sku, barcode: r.barcode, mrp: r.mrp, price: r.price, cost: r.cost,
        reorderLevel: r.reorder_level, active: b(r.active), createdAt: r.created_at, updatedAt: r.updated_at
      })),
    barcodes: db
      .all<Record<string, any>>(`SELECT vb.barcode, v.uuid AS vuuid FROM variant_barcodes vb JOIN product_variants v ON v.id = vb.variant_id ORDER BY vb.barcode`)
      .map((r) => ({ barcode: r.barcode, variantUuid: r.vuuid }))
  }
  return {
    format: PACKAGE_FORMAT,
    schemaVersion: PACKAGE_SCHEMA_VERSION,
    exportedAt: opts.now ?? Date.now(),
    source: { posCode: db.value<string>('SELECT code FROM pos_terminals WHERE is_local = 1') ?? null },
    checksum: checksumOf(data),
    data
  }
}

export function encodePackage(pkg: CatalogPackage, gzip = false): Buffer {
  const raw = Buffer.from(JSON.stringify(pkg), 'utf8')
  return gzip ? gzipSync(raw) : raw
}

/** Parse + verify (gzip auto-detected). Throws AppError('VALIDATION') for corrupt / foreign / too-new packages. */
export function decodePackage(bytes: Buffer | Uint8Array): CatalogPackage {
  let buf = Buffer.from(bytes)
  try {
    if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) buf = gunzipSync(buf)
    return validatePackage(JSON.parse(buf.toString('utf8')))
  } catch (e) {
    if (e instanceof AppError) throw e
    throw new AppError('VALIDATION', `Not a valid catalog package: ${(e as Error).message}`)
  }
}

export function validatePackage(pkg: any): CatalogPackage {
  if (!pkg || pkg.format !== PACKAGE_FORMAT) throw new AppError('VALIDATION', 'This file is not a Velmayil catalog package')
  if (typeof pkg.schemaVersion !== 'number' || pkg.schemaVersion > PACKAGE_SCHEMA_VERSION)
    throw new AppError('VALIDATION', `Package schema version ${pkg.schemaVersion} is newer than this app supports (${PACKAGE_SCHEMA_VERSION}). Update the app.`)
  const d = pkg.data
  for (const k of ['categories', 'brands', 'products', 'variants', 'barcodes'])
    if (!d || !Array.isArray(d[k])) throw new AppError('VALIDATION', `Package is missing "${k}"`)
  if (checksumOf(d) !== pkg.checksum) throw new AppError('VALIDATION', 'Package checksum mismatch - the file is corrupt or was modified')
  return pkg as CatalogPackage
}

// ====================================================================== merge
export type ConflictReason =
  | 'local_newer' | 'name_exists' | 'sku_conflict' | 'barcode_conflict' | 'missing_parent' | 'missing_product' | 'missing_variant'
export interface Conflict { entity: 'category' | 'brand' | 'product' | 'variant' | 'barcode'; uuid: string; name: string; reason: ConflictReason; detail: string }
type Counter = { created: number; updated: number; unchanged: number; skipped: number }
export interface MergeReport {
  dryRun: boolean
  source: string | null
  schemaVersion: number
  counts: Record<'categories' | 'brands' | 'products' | 'variants' | 'barcodes', Counter>
  conflicts: Conflict[]
}
export interface MergeOptions { dryRun?: boolean; /** queue snapshots for onward sync (default true) */ enqueue?: boolean }

class Rollback extends Error {
  constructor(public report: MergeReport) {
    super('dry-run rollback')
  }
}

/** Merge a package into this POS by uuid, last-writer-wins on updated_at. No permission check - callers do that. */
export function mergePackage(app: App, pkgIn: CatalogPackage, opts: MergeOptions = {}): MergeReport {
  const pkg = validatePackage(pkgIn)
  if (!opts.dryRun) return app.db.transaction(() => doMerge(app, pkg, opts))
  try {
    app.db.transaction(() => {
      throw new Rollback(doMerge(app, pkg, opts))
    })
  } catch (e) {
    if (e instanceof Rollback) return e.report
    throw e
  }
  throw new Error('unreachable')
}

function doMerge(app: App, pkg: CatalogPackage, opts: MergeOptions): MergeReport {
  const db = app.db
  const counter = (): Counter => ({ created: 0, updated: 0, unchanged: 0, skipped: 0 })
  const report: MergeReport = {
    dryRun: !!opts.dryRun, source: pkg.source?.posCode ?? null, schemaVersion: pkg.schemaVersion,
    counts: { categories: counter(), brands: counter(), products: counter(), variants: counter(), barcodes: counter() },
    conflicts: []
  }
  const conflict = (c: Conflict) => report.conflicts.push(c)
  const touched = { categories: new Set<number>(), brands: new Set<number>(), products: new Set<number>() }
  const idByUuid = (table: string, uuid: string | null): number | null =>
    uuid ? db.value<number>(`SELECT id FROM ${table} WHERE uuid = ?`, uuid) ?? null : null

  // ---------------- categories (parents first)
  const pending = [...pkg.data.categories]
  const doCategory = (c: PkgCategory, parentId: number | null) => {
    const local = db.get<Record<string, any>>('SELECT * FROM categories WHERE uuid = ?', c.uuid)
    const cnt = report.counts.categories
    if (!local) {
      const same = db.get<{ id: number }>('SELECT id FROM categories WHERE name = ? COLLATE NOCASE', c.name)
      if (same) {
        cnt.skipped++
        conflict({ entity: 'category', uuid: c.uuid, name: c.name, reason: 'name_exists', detail: 'A category with this name already exists locally; products will use it' })
        return
      }
      const id = db.run('INSERT INTO categories(uuid,name,parent_id,active,updated_at) VALUES (?,?,?,?,?)', c.uuid, c.name, parentId, c.active ? 1 : 0, c.updatedAt).lastId
      touched.categories.add(id)
      cnt.created++
      return
    }
    const differs = local.name !== c.name || local.parent_id !== parentId || !!local.active !== c.active
    if (!differs) return void cnt.unchanged++
    if (c.updatedAt > local.updated_at) {
      const clash = db.get('SELECT id FROM categories WHERE name = ? COLLATE NOCASE AND id <> ?', c.name, local.id)
      if (clash) {
        cnt.skipped++
        return conflict({ entity: 'category', uuid: c.uuid, name: c.name, reason: 'name_exists', detail: `Another local category is already named "${c.name}"` })
      }
      db.run('UPDATE categories SET name=?, parent_id=?, active=?, updated_at=? WHERE id=?', c.name, parentId, c.active ? 1 : 0, c.updatedAt, local.id)
      touched.categories.add(local.id)
      cnt.updated++
    } else {
      cnt.skipped++
      conflict({ entity: 'category', uuid: c.uuid, name: c.name, reason: 'local_newer', detail: `Local "${local.name}" is newer; kept local` })
    }
  }
  for (let progress = true; pending.length && progress; ) {
    progress = false
    for (let i = 0; i < pending.length; i++) {
      const c = pending[i]
      if (c.parentUuid && idByUuid('categories', c.parentUuid) == null && pending.some((x) => x.uuid === c.parentUuid)) continue
      const parentId = idByUuid('categories', c.parentUuid)
      if (c.parentUuid && parentId == null) conflict({ entity: 'category', uuid: c.uuid, name: c.name, reason: 'missing_parent', detail: 'Parent category not found; placed at top level' })
      doCategory(c, parentId)
      pending.splice(i--, 1)
      progress = true
    }
  }
  for (const c of pending) doCategory(c, null) // cyclic parents (corrupt data): attach at top level

  // ---------------- brands
  for (const br of pkg.data.brands) {
    const cnt = report.counts.brands
    const local = db.get<Record<string, any>>('SELECT * FROM brands WHERE uuid = ?', br.uuid)
    if (!local) {
      if (db.value('SELECT 1 FROM brands WHERE name = ? COLLATE NOCASE', br.name)) {
        cnt.skipped++
        conflict({ entity: 'brand', uuid: br.uuid, name: br.name, reason: 'name_exists', detail: 'A brand with this name already exists locally; products will use it' })
        continue
      }
      touched.brands.add(db.run('INSERT INTO brands(uuid,name,active,updated_at) VALUES (?,?,?,?)', br.uuid, br.name, br.active ? 1 : 0, br.updatedAt).lastId)
      cnt.created++
    } else if (local.name === br.name && !!local.active === br.active) cnt.unchanged++
    else if (br.updatedAt > local.updated_at) {
      if (db.value('SELECT 1 FROM brands WHERE name = ? COLLATE NOCASE AND id <> ?', br.name, local.id)) {
        cnt.skipped++
        conflict({ entity: 'brand', uuid: br.uuid, name: br.name, reason: 'name_exists', detail: `Another local brand is already named "${br.name}"` })
        continue
      }
      db.run('UPDATE brands SET name=?, active=?, updated_at=? WHERE id=?', br.name, br.active ? 1 : 0, br.updatedAt, local.id)
      touched.brands.add(local.id)
      cnt.updated++
    } else {
      cnt.skipped++
      conflict({ entity: 'brand', uuid: br.uuid, name: br.name, reason: 'local_newer', detail: `Local "${local.name}" is newer; kept local` })
    }
  }

  // category/brand by uuid, falling back to a same-named local row (name_exists case)
  const nameOf = new Map<string, string>()
  for (const c of pkg.data.categories) nameOf.set('c:' + c.uuid, c.name)
  for (const b of pkg.data.brands) nameOf.set('b:' + b.uuid, b.name)
  const resolveRef = (table: 'categories' | 'brands', uuid: string | null): number | null => {
    if (!uuid) return null
    const direct = idByUuid(table, uuid)
    if (direct != null) return direct
    const nm = nameOf.get((table === 'categories' ? 'c:' : 'b:') + uuid)
    return nm ? db.value<number>(`SELECT id FROM ${table} WHERE name = ? COLLATE NOCASE`, nm) ?? null : null
  }

  // ---------------- products
  for (const p of pkg.data.products) {
    const cnt = report.counts.products
    const categoryId = resolveRef('categories', p.categoryUuid)
    const brandId = resolveRef('brands', p.brandUuid)
    const local = db.get<Record<string, any>>('SELECT * FROM products WHERE uuid = ?', p.uuid)
    if (!local) {
      const id = db.run(
        `INSERT INTO products(uuid,name,description,category_id,brand_id,hsn,tax_rate_bp,unit,track_stock,active,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        p.uuid, p.name, p.description, categoryId, brandId, p.hsn, p.taxRateBp, p.unit, p.trackStock ? 1 : 0, p.active ? 1 : 0, p.createdAt, p.updatedAt
      ).lastId
      touched.products.add(id)
      cnt.created++
      continue
    }
    const differs =
      local.name !== p.name || local.description !== p.description || local.category_id !== categoryId || local.brand_id !== brandId ||
      local.hsn !== p.hsn || local.tax_rate_bp !== p.taxRateBp || local.unit !== p.unit || !!local.track_stock !== p.trackStock || !!local.active !== p.active
    if (!differs) cnt.unchanged++
    else if (p.updatedAt > local.updated_at) {
      if (local.tax_rate_bp !== p.taxRateBp || local.hsn !== p.hsn)
        app.audit({ entity: 'product', entityId: local.id, action: 'tax_change', note: 'catalog package import', old: { taxRateBp: local.tax_rate_bp, hsn: local.hsn }, new: { taxRateBp: p.taxRateBp, hsn: p.hsn } })
      db.run(
        `UPDATE products SET name=?,description=?,category_id=?,brand_id=?,hsn=?,tax_rate_bp=?,unit=?,track_stock=?,active=?,updated_at=? WHERE id=?`,
        p.name, p.description, categoryId, brandId, p.hsn, p.taxRateBp, p.unit, p.trackStock ? 1 : 0, p.active ? 1 : 0, p.updatedAt, local.id
      )
      touched.products.add(local.id)
      cnt.updated++
    } else {
      cnt.skipped++
      conflict({ entity: 'product', uuid: p.uuid, name: p.name, reason: 'local_newer', detail: `Local "${local.name}" is newer; kept local` })
    }
  }

  // ---------------- variants
  const aliasByVariant = new Map<string, string[]>()
  for (const a of pkg.data.barcodes) (aliasByVariant.get(a.variantUuid) ?? aliasByVariant.set(a.variantUuid, []).get(a.variantUuid)!).push(a.barcode)
  const appliedVariants = new Set<string>()
  for (const v of pkg.data.variants) {
    const cnt = report.counts.variants
    const productId = idByUuid('products', v.productUuid)
    const label = `${v.name ? v.name + ' / ' : ''}${v.sku}`
    if (productId == null) {
      cnt.skipped++
      conflict({ entity: 'variant', uuid: v.uuid, name: label, reason: 'missing_product', detail: 'Parent product not found' })
      continue
    }
    const local = db.get<Record<string, any>>('SELECT * FROM product_variants WHERE uuid = ?', v.uuid)
    let sku = v.sku
    let barcode = v.barcode
    const skuClash = db.get<{ id: number }>('SELECT id FROM product_variants WHERE sku = ? COLLATE NOCASE AND id <> ?', sku, local?.id ?? 0)
    if (skuClash) {
      cnt.skipped++
      conflict({ entity: 'variant', uuid: v.uuid, name: label, reason: 'sku_conflict', detail: `SKU ${sku} is used by a different local item` })
      continue
    }
    if (barcode && app.db.value('SELECT 1 FROM (SELECT barcode b, id vid FROM product_variants UNION ALL SELECT barcode, variant_id FROM variant_barcodes) WHERE b = ? AND vid <> ?', barcode, local?.id ?? 0)) {
      conflict({ entity: 'variant', uuid: v.uuid, name: label, reason: 'barcode_conflict', detail: `Barcode ${barcode} is used by a different local item; imported without it` })
      barcode = local?.barcode ?? null
    }
    if (!local) {
      const id = db.run(
        `INSERT INTO product_variants(uuid,product_id,name,sku,barcode,mrp,price,cost,reorder_level,active,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        v.uuid, productId, v.name, sku, barcode, v.mrp, v.price, v.cost, v.reorderLevel, v.active ? 1 : 0, v.createdAt, v.updatedAt
      ).lastId
      touched.products.add(productId)
      appliedVariants.add(v.uuid)
      void id
      cnt.created++
      continue
    }
    const differs =
      local.product_id !== productId || local.name !== v.name || local.sku !== sku || local.barcode !== barcode || local.mrp !== v.mrp ||
      local.price !== v.price || local.cost !== v.cost || local.reorder_level !== v.reorderLevel || !!local.active !== v.active
    if (!differs) {
      cnt.unchanged++
      if (v.updatedAt > local.updated_at) appliedVariants.add(v.uuid) // same content, newer stamp: still reconcile aliases
    } else if (v.updatedAt > local.updated_at) {
      if (local.mrp !== v.mrp || local.price !== v.price || local.cost !== v.cost)
        app.audit({
          entity: 'variant', entityId: local.id, action: 'price_change', note: 'catalog package import',
          old: { mrp: local.mrp, price: local.price, cost: local.cost }, new: { mrp: v.mrp, price: v.price, cost: v.cost }
        })
      db.run(
        'UPDATE product_variants SET product_id=?,name=?,sku=?,barcode=?,mrp=?,price=?,cost=?,reorder_level=?,active=?,updated_at=? WHERE id=?',
        productId, v.name, sku, barcode, v.mrp, v.price, v.cost, v.reorderLevel, v.active ? 1 : 0, v.updatedAt, local.id
      )
      touched.products.add(productId)
      appliedVariants.add(v.uuid)
      cnt.updated++
    } else {
      cnt.skipped++
      conflict({ entity: 'variant', uuid: v.uuid, name: label, reason: 'local_newer', detail: `Local ${local.sku} is newer; kept local` })
    }
  }

  // ---------------- alias barcodes (replace the alias set of every variant that took the incoming version)
  for (const vuuid of appliedVariants) {
    const row = db.get<{ id: number; product_id: number }>('SELECT id, product_id FROM product_variants WHERE uuid = ?', vuuid)
    if (!row) continue
    const want = aliasByVariant.get(vuuid) ?? []
    const have = db.all<{ barcode: string }>('SELECT barcode FROM variant_barcodes WHERE variant_id = ?', row.id).map((r) => r.barcode)
    for (const h of have) if (!want.includes(h)) (db.run('DELETE FROM variant_barcodes WHERE barcode = ?', h), touched.products.add(row.product_id))
    for (const code of want) {
      if (have.includes(code)) continue
      const clash = db.value(
        'SELECT 1 FROM (SELECT barcode b, id vid FROM product_variants UNION ALL SELECT barcode, variant_id FROM variant_barcodes) WHERE b = ? AND vid <> ?', code, row.id
      )
      if (clash || db.value('SELECT 1 FROM product_variants WHERE id = ? AND barcode = ?', row.id, code)) {
        report.counts.barcodes.skipped++
        if (clash) conflict({ entity: 'barcode', uuid: vuuid, name: code, reason: 'barcode_conflict', detail: `Alias ${code} is used by a different local item` })
        continue
      }
      db.run('INSERT INTO variant_barcodes(barcode, variant_id) VALUES (?,?)', code, row.id)
      report.counts.barcodes.created++
      touched.products.add(row.product_id)
    }
  }
  const knownVariants = new Set(pkg.data.variants.map((v) => v.uuid))
  for (const a of pkg.data.barcodes)
    if (!knownVariants.has(a.variantUuid) && !db.value('SELECT 1 FROM product_variants WHERE uuid = ?', a.variantUuid)) {
      report.counts.barcodes.skipped++
      conflict({ entity: 'barcode', uuid: a.variantUuid, name: a.barcode, reason: 'missing_variant', detail: 'Variant not found' })
    }

  // ---------------- onward sync + audit
  if (opts.enqueue !== false) {
    for (const id of touched.categories) app.enqueueSnapshot('categories', id)
    for (const id of touched.brands) app.enqueueSnapshot('brands', id)
    for (const id of touched.products) enqueueProductSnapshot(app, id)
  }
  const total = (k: keyof MergeReport['counts']) => report.counts[k].created + report.counts[k].updated
  app.audit({
    entity: 'catalog', action: 'package_import', note: opts.dryRun ? 'dry run' : `from ${report.source ?? 'unknown'}`,
    new: { categories: total('categories'), brands: total('brands'), products: total('products'), variants: total('variants'), conflicts: report.conflicts.length }
  })
  return report
}

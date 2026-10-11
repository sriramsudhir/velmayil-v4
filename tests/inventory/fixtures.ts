import { expect } from 'vitest'
import type { App } from '../../src/main/core/app'
import { createTestApp } from '../helpers'

export const newApp = (): App => createTestApp()

let seq = 0
export function makeVariant(
  app: App,
  o: { name?: string; cost?: number; price?: number; reorder?: number; taxBp?: number; categoryId?: number | null; track?: number; qty?: number } = {}
): number {
  seq++
  const p = app.db.run(
    'INSERT INTO products(uuid,name,category_id,tax_rate_bp,track_stock) VALUES (?,?,?,?,?)',
    app.uuid(), o.name ?? `Item ${seq}`, o.categoryId ?? null, o.taxBp ?? 1800, o.track ?? 1
  )
  const v = app.db.run(
    'INSERT INTO product_variants(uuid,product_id,sku,barcode,cost,price,mrp,reorder_level) VALUES (?,?,?,?,?,?,?,?)',
    app.uuid(), p.lastId, `SKU${seq}`, `890000${String(seq).padStart(6, '0')}`, o.cost ?? 1000, o.price ?? 1500, o.price ?? 1500, o.reorder ?? 0
  )
  if (o.qty) app.moveStock({ variantId: v.lastId, delta: o.qty, type: 'opening' })
  return v.lastId
}

export const makeCategory = (app: App, name: string): number =>
  app.db.run('INSERT INTO categories(uuid,name) VALUES (?,?)', app.uuid(), name).lastId

export const makeLocation = (app: App, name: string): number =>
  app.db.run('INSERT INTO locations(uuid,name) VALUES (?,?)', app.uuid(), name).lastId

export const makeSupplier = (app: App, name = 'Supplier A'): number =>
  app.db.run('INSERT INTO suppliers(uuid,name) VALUES (?,?)', app.uuid(), name).lastId

export const qtyAt = (app: App, variantId: number, locationId?: number): number =>
  app.db.value<number>('SELECT qty FROM stock_levels WHERE variant_id=? AND location_id=?', variantId, locationId ?? app.defaultLocationId()) ?? 0

export const costOf = (app: App, variantId: number): number => app.db.value<number>('SELECT cost FROM product_variants WHERE id=?', variantId)!

export const totalStock = (app: App, variantId: number): number =>
  app.db.value<number>('SELECT COALESCE(SUM(qty),0) FROM stock_levels WHERE variant_id=?', variantId)!

export async function rejects(p: Promise<unknown> | (() => unknown), code?: string): Promise<Error & { code?: string }> {
  try {
    await (typeof p === 'function' ? p() : p)
  } catch (e) {
    const err = e as Error & { code?: string }
    if (code) expect(err.code).toBe(code)
    return err
  }
  throw new Error('expected rejection')
}

import type { Db } from '../../db/driver'
import { StampCache } from '../reports/cache'

/**
 * Number of active, stock-tracked variants at or below their reorder level (all locations summed).
 * Only variants that HAVE a reorder level are visited (partial index idx_variants_reorder), with a direct stock_levels
 * lookup per variant instead of grouping the whole stock table. The result is cached against a stamp that moves whenever
 * stock moves or a variant/product is edited, so the dashboard's 60 s refresh and the shell never recompute it needlessly.
 */
const cache = new WeakMap<Db, StampCache<number>>()

export function lowStockCount(db: Db): number {
  return (
    db.value<number>(
      `SELECT COUNT(*) FROM product_variants v JOIN products p ON p.id = v.product_id
       WHERE v.reorder_level > 0 AND v.active = 1 AND p.active = 1 AND p.track_stock = 1
         AND COALESCE((SELECT SUM(sl.qty) FROM stock_levels sl WHERE sl.variant_id = v.id), 0) <= v.reorder_level`
    ) ?? 0
  )
}

/** Cheap fingerprint of everything lowStockCount() depends on. */
export function stockStamp(db: Db): string {
  const r = db.get<Record<string, number>>(
    `SELECT (SELECT COALESCE(seq,0) FROM sqlite_sequence WHERE name = 'stock_movements') AS mv,
            (SELECT COALESCE(MAX(updated_at),0) FROM product_variants) AS vu,
            (SELECT COALESCE(MAX(updated_at),0) FROM products) AS pu`
  )!
  return `${r.mv}|${r.vu}|${r.pu}`
}

export function lowStockCountCached(db: Db): number {
  let c = cache.get(db)
  if (!c) cache.set(db, (c = new StampCache<number>(1, 60_000)))
  return c.memo('low', stockStamp(db), () => lowStockCount(db))
}

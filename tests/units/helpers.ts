import type { App } from '../../src/main/core/app'
import { applyChange } from '../../src/main/modules/sync/apply'
import { enrichPayload } from '../../src/main/modules/sync/collector'
import type { Change } from '../../src/main/modules/sync/protocol'
import type { Snapshot } from '../../src/main/core/snapshot'

export const U = <T = any>(app: App, method: string, args?: unknown) => app.call('units', method, args) as Promise<T>
export const POS = <T = any>(app: App, method: string, args?: unknown) => app.call('pos', method, args) as Promise<T>
export const INV = <T = any>(app: App, method: string, args?: unknown) => app.call('inventory', method, args) as Promise<T>
export const PUR = <T = any>(app: App, method: string, args?: unknown) => app.call('purchases', method, args) as Promise<T>
export const CAT = <T = any>(app: App, method: string, args?: unknown) => app.call('catalog', method, args) as Promise<T>

/** A product with per-unit codes (created through catalog.save, so opening stock gets its codes too). */
export async function trackedProduct(app: App, o: { name?: string; prefix?: string | null; qty?: number; price?: number; sku?: string; barcode?: string } = {}) {
  const p = await CAT(app, 'save', {
    name: o.name ?? 'Sparkler Box',
    trackUnits: true,
    unitPrefix: o.prefix === undefined ? 'SPK' : o.prefix,
    variants: [{ name: '', sku: o.sku, barcode: o.barcode, price: o.price ?? 10000, mrp: o.price ?? 10000, cost: 5000, openingStock: o.qty ?? 0 }]
  })
  return { productId: p.id as number, variantId: p.variants[0].id as number, prefix: p.unitPrefix as string | null }
}

/** An ordinary product (no unit codes). */
export async function plainProduct(app: App, o: { name?: string; qty?: number; price?: number } = {}) {
  const p = await CAT(app, 'save', {
    name: o.name ?? 'Plain Item', variants: [{ name: '', price: o.price ?? 5000, mrp: o.price ?? 5000, cost: 2000, openingStock: o.qty ?? 0 }]
  })
  return { productId: p.id as number, variantId: p.variants[0].id as number }
}

export const stockAt = (app: App, variantId: number, loc?: number): number =>
  app.db.value<number>('SELECT qty FROM stock_levels WHERE variant_id=? AND location_id=?', variantId, loc ?? app.defaultLocationId()) ?? 0

export const availCodes = (app: App, variantId: number, loc?: number): string[] =>
  app.db
    .all<{ code: string }>(
      `SELECT code FROM product_units WHERE variant_id=? AND status IN ('in_stock','returned') ${loc ? 'AND location_id=' + loc : ''} ORDER BY id`, variantId
    )
    .map((r) => r.code)

export const statusOf = (app: App, code: string): string | undefined => app.db.value<string>('SELECT status FROM product_units WHERE code=?', code)

export const count = (app: App, sql: string, ...p: (string | number)[]): number => app.db.value<number>(sql, ...p) ?? 0

/** stock_levels == in-stock units for every tracked variant and location, and the ledger is consistent. */
export async function assertInvariant(app: App): Promise<void> {
  const r = (await INV(app, 'verifyLedger')) as { ok: boolean; mismatches: unknown[]; unitMismatches: unknown[] }
  if (!r.ok) throw new Error('invariant broken: ' + JSON.stringify(r.unitMismatches.length ? r.unitMismatches : r.mismatches))
}

export const cashSale = (app: App, lines: { variantId: number; qty: number; unitCodes?: string[] }[], extra: Record<string, unknown> = {}) =>
  POS(app, 'completeSale', { lines, payments: [{ method: 'cash', amount: 100_000_000 }], ...extra })

/** Replays this terminal's sync queue (rows with id > since) into another App, like the transport would. */
export function pipe(from: App, to: App, since = 0): { last: number; statuses: string[] } {
  const dev = from.db.get<{ uuid: string; code: string; name: string }>('SELECT uuid, code, name FROM pos_terminals WHERE is_local=1')!
  const rows = from.db.all<{ id: number; entity: string; entity_uuid: string; op: 'upsert' | 'delete'; payload_json: string; created_at: number }>(
    'SELECT * FROM sync_queue WHERE id > ? ORDER BY id', since
  )
  let pending: Change[] = rows.map((r) => ({
    device: dev.uuid, deviceCode: dev.code, deviceName: dev.name, qid: r.id, entity: r.entity, entityUuid: r.entity_uuid, op: r.op, createdAt: r.created_at,
    payload: enrichPayload(from.db, r.entity, JSON.parse(r.payload_json) as Snapshot)
  }))
  const statuses: string[] = []
  for (let pass = 0; pass < 5 && pending.length; pass++) {
    const next: Change[] = []
    for (const c of pending) {
      const res = applyChange(to, c)
      if (res.status === 'deferred') next.push(c)
      else statuses.push(`${c.entity}:${res.status}`)
    }
    pending = next
  }
  return { last: rows.length ? rows[rows.length - 1].id : since, statuses }
}

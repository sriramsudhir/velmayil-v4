import type { Snapshot } from '../../../core/snapshot'
import { Deferred, type Ctx } from './context'
import { resolveRef, ensureTerminal } from './refs'
import type { Outcome } from './engine'
import type { SyncPayload } from '../protocol'

/**
 * Stock is CRDT-like: every movement is an immutable fact with a global uuid. Applying a remote movement = insert it once
 * (by uuid) and add its delta to the local level. Summing the same set of movements converges on every terminal,
 * regardless of arrival order. (Never goes through app.moveStock: no negative-stock check, no echo into the queue.)
 */
export function applyStockMovement(ctx: Ctx, snap: Snapshot): Outcome {
  const { db } = ctx
  if (db.get('SELECT 1 FROM stock_movements WHERE uuid = ?', snap.uuid)) return 'skipped'
  const r = snap.row
  const vref = snap.refs?.variant_id
  if (!vref) throw new Error('stock movement without variant reference')
  const variantId = resolveRef(ctx, vref)
  if (!variantId) throw new Deferred(`product_variants:${vref.uuid}`)
  const lref = snap.refs?.location_id
  const locationId = lref ? resolveRef(ctx, lref) ?? ctx.app.defaultLocationId() : ctx.app.defaultLocationId()
  const delta = Number(r.qty_delta)
  const level = (db.value<number>('SELECT qty FROM stock_levels WHERE variant_id = ? AND location_id = ?', variantId, locationId) ?? 0) + delta
  db.run(
    'INSERT INTO stock_levels(variant_id,location_id,qty) VALUES (?,?,?) ON CONFLICT(variant_id,location_id) DO UPDATE SET qty = excluded.qty',
    variantId, locationId, level
  )
  const userRef = snap.refs?.user_id
  const posRef = snap.refs?.pos_id
  const userId = userRef ? resolveRef(ctx, userRef) : null
  const posId = posRef ? ensureTerminal(ctx, posRef.uuid) : ensureTerminal(ctx, ctx.change.device)
  const meta = (snap as SyncPayload).meta ?? ctx.change.payload.meta
  let refId: string | null = r.ref_id == null ? null : String(r.ref_id)
  if (meta?.refTable && meta.refUuid) {
    const local = db.value<number>(`SELECT id FROM ${meta.refTable} WHERE uuid = ?`, meta.refUuid)
    refId = local ? String(local) : meta.refUuid // keep the portable uuid when the document is not (yet) here
  }
  db.run(
    `INSERT INTO stock_movements(uuid,variant_id,location_id,qty_delta,balance_after,type,ref_type,ref_id,unit_cost,note,user_id,pos_id,ts)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    snap.uuid, variantId, locationId, delta, level, String(r.type), (r.ref_type as string) ?? null, refId,
    (r.unit_cost as number) ?? null, (r.note as string) ?? null, userId, posId, Number(r.ts ?? Date.now())
  )
  return 'applied'
}

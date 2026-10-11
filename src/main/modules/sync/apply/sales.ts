import type { Db } from '../../../db/driver'
import type { Snapshot } from '../../../core/snapshot'
import { purgeSale } from '../../pos/service'
import type { Ctx } from './context'
import type { Outcome } from './engine'

/** True when the invoice with this sales.uuid was permanently deleted (here or on another terminal). */
export const saleTombstoned = (db: Db, uuid: string | null | undefined): boolean =>
  !!uuid && !!db.get('SELECT 1 FROM deleted_sales WHERE uuid = ?', uuid)

/**
 * Inbound "delete order" (entity 'sales', op 'delete'; payload from pos saleDeletePayload). Idempotent by sales.uuid.
 *
 * The bill, its lines, payments, return notes and print history are removed and a tombstone is kept, so a copy of the bill
 * that arrives later (slow terminal, resync, parked change) is ignored. Stock is NOT touched here: the terminal where the
 * bill was deleted put the stock back with ordinary stock movements, and those travel (once, by uuid) like every other
 * movement. Unit codes of the bill that are still marked sold go back in stock, exactly as on the deleting terminal.
 * The delete is recorded even when the bill itself never reached this terminal.
 */
export function applySaleDelete(ctx: Ctx, snap: Snapshot): Outcome {
  const { app, db, change } = ctx
  const uuid = String(snap.uuid ?? change.entityUuid ?? '')
  if (!uuid) return 'skipped'
  const known = saleTombstoned(db, uuid)
  const r = snap.row ?? {}
  const local = db.get<{ id: number; invoice_no: string; total: number }>('SELECT id, invoice_no, total FROM sales WHERE uuid = ?', uuid)
  const by = String(r.deleted_by_name ?? '')
  const reason = String(r.reason ?? '')
  const saleId = purgeSale(db, {
    uuid, invoiceNo: String(r.invoice_no ?? local?.invoice_no ?? ''), total: Number(r.total ?? local?.total ?? 0),
    deletedAt: Number(r.deleted_at ?? change.createdAt ?? Date.now()), deletedBy: null, deletedByName: by, reason,
    originDevice: String(r.origin_device ?? change.device ?? '')
  })
  if (saleId != null) {
    const where = change.deviceCode || change.device.slice(0, 8)
    app.audit({
      entity: 'sale', entityId: saleId, action: 'delete', old: { uuid, invoiceNo: local?.invoice_no, total: local?.total },
      new: { deleted: true, reason, deletedBy: by, device: where, via: 'sync' }, note: `Deleted on ${where}${by ? ` by ${by}` : ''}: ${reason}`
    })
  }
  return saleId != null || !known ? 'applied' : 'skipped'
}

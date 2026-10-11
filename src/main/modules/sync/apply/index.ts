import type { App } from '../../../core/app'
import { Deferred, tableInfo, type Ctx } from './context'
import { applyEntity, applyKeyed, type Outcome } from './engine'
import { applyLogoAsset, applyProfileVersion } from './profile'
import { applyStockMovement } from './stock'
import { applyUnit } from './units'
import { applySaleDelete, saleTombstoned } from './sales'
import { applyShared } from '../shared'
import { enforceProfile, noteProfile } from './authority'
import type { RemoteChange } from '../protocol'

export { Deferred } from './context'

export type ApplyResult = { status: Outcome | 'ignored'; lostRemote?: boolean } | { status: 'deferred'; missing: string }

/** Entities that are never applied from remote (credentials, local-only state, bookkeeping). */
const IGNORED = new Set([
  'users', 'roles', 'approvals', 'audit_log', 'pos_terminals', 'locations', 'held_carts',
  'printer_profiles', 'print_log', 'invoice_sequences', 'stock_levels', 'sync_queue', 'backups'
])

/** Shop-wide configuration (shared.ts): accepted only by a Client, only from the Admin system. */
const SHARED = new Set(['settings', 'print_templates'])

/**
 * Apply ONE remote change atomically. The ONLY place where inbound sync writes syncable tables.
 *  - upsert by uuid, resolve uuid refs -> local ids, policy per entity (lww / immutable fact / stock ledger / profile)
 *  - never enqueues: anything a delegated service queued during the apply is marked as echo-suppressed
 *  - a missing referenced row parks the change as 'deferred' (rolled back, retried later)
 *  - a permanently deleted invoice (deleted_sales tombstone) is removed here too and never comes back: late copies of the
 *    bill or of its return notes are skipped
 */
export function applyChange(app: App, change: RemoteChange): ApplyResult {
  const r = app.setting('sync.role', 'standalone')
  const role = r === 'admin' || r === 'client' ? r : 'standalone'
  const ctx: Ctx = { app, db: app.db, change, role, authoritative: role === 'client' && change.fromAdmin === true }
  const snap = change.payload
  const table = snap?.table ?? change.entity
  if (!snap || typeof snap !== 'object') return { status: 'ignored' }
  if (IGNORED.has(change.entity) || !tableInfo(app.db, change.entity)) return { status: 'ignored' }
  if (SHARED.has(change.entity)) {
    if (!ctx.authoritative || snap.meta?.shared !== true || change.op !== 'upsert') return { status: 'ignored' }
    return { status: app.db.transaction(() => applyShared(app, change.entity, snap)) }
  }
  try {
    return app.db.transaction((): ApplyResult => {
      const q0 = app.db.value<number>('SELECT COALESCE(MAX(id),0) FROM sync_queue') ?? 0
      let out: Outcome
      switch (change.entity) {
        case 'stock_movements':
          out = change.op === 'delete' ? 'skipped' : applyStockMovement(ctx, snap)
          break
        case 'business_profile_versions':
          if (change.op === 'delete') out = 'skipped'
          else if (role === 'standalone') out = applyProfileVersion(ctx, snap)
          else {
            // the Admin system decides which shop profile is in use (authority.ts)
            const existed = !!app.db.get('SELECT 1 FROM business_profile_versions WHERE uuid = ?', snap.uuid)
            out = applyProfileVersion(ctx, snap)
            noteProfile(ctx, snap, existed)
            enforceProfile(app, role)
          }
          break
        case 'logo_assets':
          out = applyLogoAsset(ctx, snap)
          break
        case 'variant_barcodes':
          out = applyKeyed(ctx, snap, change.op)
          break
        case 'product_units':
          out = applyUnit(ctx, snap, change.op)
          break
        case 'sales':
          if (table !== change.entity) return { status: 'ignored' }
          if (change.op === 'delete') out = applySaleDelete(ctx, snap)
          else out = saleTombstoned(app.db, snap.uuid) ? 'skipped' : applyEntity(ctx, snap, change.op)
          break
        case 'sale_returns':
          if (table !== change.entity) return { status: 'ignored' }
          // a return note of a deleted bill went with the bill
          out = saleTombstoned(app.db, snap.refs?.sale_id?.uuid) ? 'skipped' : applyEntity(ctx, snap, change.op)
          break
        default:
          if (table !== change.entity) return { status: 'ignored' }
          out = applyEntity(ctx, snap, change.op)
      }
      // no echo loops: nothing applied from a remote may travel back out
      app.db.run(
        "UPDATE sync_queue SET status = 'sent', sent_at = ?, last_error = 'echo-suppressed' WHERE id > ? AND status = 'pending'",
        Date.now(), q0
      )
      return { status: out, lostRemote: ctx.lostRemote }
    })
  } catch (e) {
    if (e instanceof Deferred) return { status: 'deferred', missing: e.missing }
    throw e
  }
}

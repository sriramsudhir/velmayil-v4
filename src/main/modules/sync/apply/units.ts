import type { Snapshot } from '../../../core/snapshot'
import { Deferred, logConflict, tableInfo, toSql, type Ctx } from './context'
import { buildRow, type Outcome } from './engine'
import { saleTombstoned } from './sales'

/**
 * Inbound unit code (product_units). Idempotent by uuid.
 *
 * The code is taken as issued, in either spelling: a 10-digit label number (4-digit prefix + 6-digit suffix, e.g. 2000000190) or an
 * older PREFIX-NNNN code; the database checks its shape (migration 910 widened the suffix to 999999).
 *
 * Multi-terminal strategy ("conflict reporting"): codes come from a per-prefix counter. With LAN sync only the admin system issues
 * numbers (a client refuses, see UnitsService.canIssue); terminals that are not in client mode keep their own counter. Applying a
 * remote unit bumps the local counter (unit_sequences) to at least its suffix, so a terminal that is online keeps issuing fresh
 * numbers. Two terminals that generate the SAME prefix while offline can still pick the same suffix; when the second unit arrives
 * its code already exists under another uuid. That is detected here, logged to sync_conflicts (kind duplicate_key) and the local row
 * is kept - the remote unit is never silently overwritten or merged into the local one. The owner resolves it (re-label one unit).
 *
 * An existing unit takes the remote status/links only when the remote row is newer (updated_at, last writer wins). Stock levels are
 * NOT touched here: stock moves travel as their own immutable stock_movements.
 *
 * A unit snapshot that still points at a permanently deleted bill (deleted_sales) is applied without that link, and a unit
 * that was "sold" on it is back in stock: the same thing the delete did to the units it found (see apply/sales.ts).
 */
export function applyUnit(ctx: Ctx, input: Snapshot, op: 'upsert' | 'delete'): Outcome {
  if (op === 'delete') return 'skipped' // unit codes are never deleted
  const { db } = ctx
  let snap = input
  if (saleTombstoned(db, snap.refs?.sale_id?.uuid)) {
    snap = {
      ...snap,
      row: { ...snap.row, sale_id: null, sale_item_id: null, status: snap.row.status === 'sold' ? 'in_stock' : snap.row.status },
      refs: { ...snap.refs, sale_id: null, sale_item_id: null }
    }
  }
  const info = tableInfo(db, 'product_units')!
  const code = String(snap.row.code ?? '')
  const existing = db.get<{ id: number; updated_at: number }>('SELECT id, updated_at FROM product_units WHERE uuid = ?', snap.uuid)

  if (!existing) {
    const clash = db.get<Record<string, unknown>>('SELECT * FROM product_units WHERE code = ?', code)
    if (clash) {
      logConflict(ctx, 'duplicate_key', 'product_units', snap.uuid, clash, snap.row,
        `Unit code ${code} was issued on two terminals; the local unit is kept and the remote unit is NOT applied`)
      return 'skipped'
    }
    const row = buildRow(ctx, snap)
    // an unresolved optional link must wait for its document instead of silently becoming null
    for (const col of ['sale_id', 'purchase_id']) if (snap.refs?.[col] && row[col] == null) throw new Deferred(`${snap.refs[col]!.table}:${snap.refs[col]!.uuid}`)
    if (snap.row.sale_item_id != null && row.sale_item_id == null && snap.refs?.sale_item_id) throw new Deferred(`sale_items:${snap.refs.sale_item_id.uuid}`)
    const cols = Object.keys(row).filter((c) => info.cols.includes(c))
    db.run(`INSERT INTO product_units(${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, ...cols.map((c) => toSql(row[c])))
    db.run(
      'INSERT INTO unit_sequences(prefix,last_seq) VALUES (?,?) ON CONFLICT(prefix) DO UPDATE SET last_seq = MAX(last_seq, excluded.last_seq)',
      String(snap.row.prefix), Number(snap.row.seq)
    )
    return 'applied'
  }

  const ru = Number(snap.row.updated_at ?? 0)
  if (ru <= existing.updated_at) return 'skipped'
  const row = buildRow(ctx, snap)
  for (const col of ['sale_id', 'purchase_id']) if (snap.refs?.[col] && row[col] == null) throw new Deferred(`${snap.refs[col]!.table}:${snap.refs[col]!.uuid}`)
  if (snap.row.sale_item_id != null && row.sale_item_id == null && snap.refs?.sale_item_id) throw new Deferred(`sale_items:${snap.refs.sale_item_id.uuid}`)
  // label_printed_at travels too (a label printed on the admin system stops the shared product barcode for that unit everywhere);
  // a printed label is never "unprinted" again by a snapshot from a terminal that did not know about it yet
  const cols = ['status', 'sale_id', 'sale_item_id', 'purchase_id', 'location_id', 'void_reason', 'label_printed_at', 'updated_at']
    .filter((c) => c in row && info.cols.includes(c) && !(c === 'label_printed_at' && row[c] == null))
  db.run(`UPDATE product_units SET ${cols.map((c) => `${c} = ?`).join(',')} WHERE id = ?`, ...cols.map((c) => toSql(row[c])), existing.id)
  return 'applied'
}

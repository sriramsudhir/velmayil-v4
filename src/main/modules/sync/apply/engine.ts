import type { Snapshot } from '../../../core/snapshot'
import { snapshotRow } from '../../../core/snapshot'
import { ADMIN_OWNED, Deferred, locallyEdited, logConflict, tableInfo, toSql, type Ctx } from './context'
import { resolveRef } from './refs'

export type Outcome = 'applied' | 'skipped'

export interface TableSpec {
  policy: 'lww' | 'fact'
  /** natural keys: a different local row with the same value is "the same thing" -> alias + converge */
  identity?: string[]
  /** unique columns where a collision just drops the remote value (e.g. a barcode already used locally) */
  soft?: string[]
}

/** Explicit policies; everything else with a uuid defaults to lww (has updated_at) or fact (append-only). */
export const SPECS: Record<string, TableSpec> = {
  categories: { policy: 'lww', identity: ['name'] },
  brands: { policy: 'lww', identity: ['name'] },
  products: { policy: 'lww' },
  product_variants: { policy: 'lww', identity: ['sku'], soft: ['barcode'] },
  suppliers: { policy: 'lww' },
  customers: { policy: 'fact' }
}

const NUMBER_COLS = ['invoice_no', 'return_no', 'number']

export function specFor(ctx: Ctx, table: string): TableSpec | null {
  const info = tableInfo(ctx.db, table)
  if (!info || !info.hasUuid) return null
  return SPECS[table] ?? { policy: info.cols.includes('updated_at') ? 'lww' : 'fact' }
}

// ---------------------------------------------------------------------------------------------------------------------
/** Local row image of a snapshot: columns that exist locally, FK/portable refs resolved to local ids. */
export function buildRow(ctx: Ctx, snap: Snapshot, skip: string[] = [], overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const info = tableInfo(ctx.db, snap.table)!
  const row: Record<string, unknown> = {}
  for (const c of info.cols) if (c !== 'id' && c in snap.row) row[c] = snap.row[c]
  const declared = new Map(info.fks.map((f) => [f.from, f.table]))
  const refCols = new Set([...declared.keys(), ...Object.keys(snap.refs ?? {})])
  for (const col of refCols) {
    if (!info.cols.includes(col) || skip.includes(col)) continue
    if (col in overrides) {
      row[col] = overrides[col]
      continue
    }
    const ref = snap.refs?.[col]
    const nullable = !info.notNull.has(col)
    if (ref) {
      const id = resolveRef(ctx, ref)
      if (id == null && !nullable) throw new Deferred(`${ref.table}:${ref.uuid}`)
      row[col] = id
    } else if (snap.row[col] == null) {
      row[col] = null
    } else if (declared.has(col)) {
      // value present, target has no uuid (product_images, logo_assets...): cannot be carried over
      if (!nullable) throw new Error(`Cannot resolve ${snap.table}.${col} (no portable reference in the change)`)
      row[col] = null
    }
  }
  for (const [k, v] of Object.entries(overrides)) if (info.cols.includes(k)) row[k] = v
  return row
}

function insertRow(ctx: Ctx, table: string, row: Record<string, unknown>): number {
  const cols = Object.keys(row)
  const r = ctx.db.run(
    `INSERT INTO ${table}(${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
    ...cols.map((c) => toSql(row[c]))
  )
  return r.lastId
}

function updateRow(ctx: Ctx, table: string, id: number, row: Record<string, unknown>, keep: string[] = ['uuid']): void {
  const cols = Object.keys(row).filter((c) => !keep.includes(c))
  if (!cols.length) return
  ctx.db.run(`UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(',')} WHERE id = ?`, ...cols.map((c) => toSql(row[c])), id)
}

/** Device-independent comparable form (no ids, no FK columns, no uuid). */
export function portable(snap: Snapshot): string {
  const skip = new Set(['id', 'uuid', ...Object.keys(snap.refs ?? {})])
  const keys = Object.keys(snap.row).filter((k) => !skip.has(k)).sort()
  return JSON.stringify(keys.map((k) => [k, snap.row[k]]))
}

function findByUuid(ctx: Ctx, table: string, uuid: string): { id: number; uuid: string } | undefined {
  const r = ctx.db.get<{ id: number; uuid: string }>(`SELECT id, uuid FROM ${table} WHERE uuid = ?`, uuid)
  if (r) return r
  const aliased = ctx.db.value<number>('SELECT local_id FROM sync_aliases WHERE alias_uuid = ? AND table_name = ?', uuid, table)
  return aliased ? ctx.db.get<{ id: number; uuid: string }>(`SELECT id, uuid FROM ${table} WHERE id = ?`, aliased) : undefined
}

const isUniqueError = (e: unknown) => /UNIQUE constraint failed/i.test((e as Error)?.message ?? '')

// ---------------------------------------------------------------------------------------------------------------------
export function applyEntity(ctx: Ctx, snap: Snapshot, op: 'upsert' | 'delete', overrides: Record<string, unknown> = {}): Outcome {
  const spec = specFor(ctx, snap.table)
  if (!spec) return 'skipped'
  return spec.policy === 'lww' ? applyLww(ctx, snap, spec, op, overrides) : applyFact(ctx, snap, op, overrides)
}

function applyLww(ctx: Ctx, snap: Snapshot, spec: TableSpec, op: 'upsert' | 'delete', overrides: Record<string, unknown>): Outcome {
  const { db } = ctx
  const t = snap.table
  const info = tableInfo(db, t)!
  let existing = findByUuid(ctx, t, snap.uuid)

  if (op === 'delete') {
    if (!existing) return 'skipped'
    // the sender only deletes rows that were never used; mirror that when the row is also unused here, else deactivate
    if (t === 'categories' || t === 'brands' || t === 'products') {
      try {
        db.transaction(() => {
          if (t === 'products') {
            db.run('DELETE FROM variant_barcodes WHERE variant_id IN (SELECT id FROM product_variants WHERE product_id = ?)', existing!.id)
            db.run('DELETE FROM product_variants WHERE product_id = ?', existing!.id)
          }
          db.run(`DELETE FROM ${t} WHERE id = ?`, existing!.id)
        })
        return 'applied'
      } catch {
        /* referenced by local history (sales, stock, children): keep it, just deactivate below */
      }
    }
    if (info.cols.includes('active')) {
      db.run(`UPDATE ${t} SET active = 0${info.cols.includes('updated_at') ? ', updated_at = MAX(updated_at, ?)' : ''} WHERE id = ?`,
        ...(info.cols.includes('updated_at') ? [Number(snap.row.updated_at ?? Date.now()), existing.id] : [existing.id]))
      return 'applied'
    }
    return 'skipped'
  }

  const row = buildRow(ctx, snap, [], overrides)

  if (!existing) {
    for (const col of spec.identity ?? []) {
      if (row[col] == null) continue
      const other = db.get<{ id: number; uuid: string }>(`SELECT id, uuid FROM ${t} WHERE ${col} = ?`, toSql(row[col]) as string)
      if (other && other.uuid !== snap.uuid) {
        // same natural key created independently on two terminals -> they are the same thing; converge via LWW
        db.run('INSERT OR REPLACE INTO sync_aliases(alias_uuid,table_name,local_id) VALUES (?,?,?)', snap.uuid, t, other.id)
        logConflict(ctx, 'duplicate_key', t, snap.uuid, { id: other.id, uuid: other.uuid, [col]: row[col] }, snap.row,
          `Same ${col} "${row[col]}" exists locally under another id; treated as one record (aliased)`)
        existing = other
        break
      }
    }
  }
  for (const col of spec.soft ?? []) {
    if (row[col] == null) continue
    const clash = db.get<{ id: number; uuid: string }>(`SELECT id, uuid FROM ${t} WHERE ${col} = ?`, toSql(row[col]) as string)
    const aliasClash = !clash && t === 'product_variants' && db.get('SELECT 1 FROM variant_barcodes WHERE barcode = ?', toSql(row[col]) as string)
    if ((clash && clash.uuid !== snap.uuid && clash.id !== existing?.id) || aliasClash) {
      logConflict(ctx, 'duplicate_key', t, snap.uuid, clash ?? null, snap.row, `${col} "${row[col]}" is already used locally; remote value dropped`)
      row[col] = null
    }
  }

  if (!existing) {
    const id = insertRow(ctx, t, row)
    applyChildren(ctx, snap, id, true)
    return 'applied'
  }

  const local = snapshotRow(db, t, existing.id)
  const lu = Number(local.row.updated_at ?? 0)
  const ru = Number(snap.row.updated_at ?? 0)
  // LAN roles: the Admin system is the authority for the catalog, so on a Client its copy wins regardless of timestamps
  // (two laptops without internet have no common clock)
  const forced = !!ctx.authoritative && ADMIN_OWNED.has(t)
  const remoteWins = forced ? true : ru !== lu ? ru > lu : portable(snap) > portable(local)
  if (!remoteWins) {
    if (portable(snap) !== portable(local)) {
      ctx.lostRemote = true
      logConflict(ctx, 'lww_lost_remote', t, snap.uuid, local.row, snap.row, 'Local copy is newer; remote edit ignored')
    }
    return 'skipped'
  }
  try {
    db.transaction(() => {
      updateRow(ctx, t, existing!.id, row)
      applyChildren(ctx, snap, existing!.id, true)
    })
  } catch (e) {
    if (!isUniqueError(e)) throw e
    logConflict(ctx, 'duplicate_key', t, snap.uuid, local.row, snap.row, `Remote edit collides with a unique value (${(e as Error).message}); kept local`)
    return 'skipped'
  }
  // Standalone (legacy) terminals list every overwritten copy; Admin / Client terminals only when this terminal had
  // edited the record itself - otherwise every price change made on the Admin would show up as a "conflict" on the Client.
  if (portable(snap) !== portable(local) && (!ctx.role || ctx.role === 'standalone' || locallyEdited(ctx))) {
    logConflict(ctx, 'lww_lost_local', t, snap.uuid, local.row, snap.row, forced ? 'The Admin system decides catalog and prices; local edit overwritten' : 'Remote edit is newer; local edit overwritten')
  }
  return 'applied'
}

function applyFact(ctx: Ctx, snap: Snapshot, op: 'upsert' | 'delete', overrides: Record<string, unknown>): Outcome {
  const { db } = ctx
  const t = snap.table
  const info = tableInfo(db, t)!
  const existing = findByUuid(ctx, t, snap.uuid)
  if (op === 'delete') return 'skipped' // facts are never deleted
  if (existing) {
    forwardUpdate(ctx, snap, existing.id)
    return 'skipped'
  }
  const row = buildRow(ctx, snap, [], overrides)
  for (const col of NUMBER_COLS) {
    if (!info.cols.includes(col) || row[col] == null) continue
    if (db.get(`SELECT 1 FROM ${t} WHERE ${col} = ?`, toSql(row[col]) as string)) {
      const tag = ctx.change.deviceCode || ctx.change.device.slice(0, 8)
      const fixed = `${row[col]}~${tag}`
      logConflict(ctx, 'number_collision', t, snap.uuid, null, snap.row, `${col} "${row[col]}" already exists locally; stored as "${fixed}"`)
      row[col] = fixed
    }
  }
  const id = insertRow(ctx, t, row)
  applyChildren(ctx, snap, id, false)
  return 'applied'
}

/** Monotonic status changes of an immutable document (a void can arrive after the sale). */
function forwardUpdate(ctx: Ctx, snap: Snapshot, id: number): void {
  if (snap.table === 'shifts') {
    const sh = ctx.db.get<{ closed_at: number | null }>('SELECT closed_at FROM shifts WHERE id = ?', id)
    if (sh && sh.closed_at == null && snap.row.closed_at != null) {
      ctx.db.run('UPDATE shifts SET closed_at = ?, closing_cash = ?, expected_cash = ?, note = ? WHERE id = ?',
        toSql(snap.row.closed_at), toSql(snap.row.closing_cash), toSql(snap.row.expected_cash), String(snap.row.note ?? ''), id)
    }
    return
  }
  if (snap.table !== 'sales') return
  const local = ctx.db.get<{ voided_at: number | null }>('SELECT voided_at FROM sales WHERE id = ?', id)
  if (!local || local.voided_at != null || snap.row.voided_at == null) return
  const row = buildRow(ctx, snap)
  const cols = ['status', 'void_reason', 'voided_by', 'voided_at', 'void_shift_id', 'void_approved_by'].filter((c) => c in row)
  ctx.db.run(`UPDATE sales SET ${cols.map((c) => `${c} = ?`).join(',')} WHERE id = ?`, ...cols.map((c) => toSql(row[c])), id)
}

// ---------------------------------------------------------------------------------------------------------------------
/** Child rows (sale_items, purchase_items, variants of a product, barcodes of a variant...). */
function applyChildren(ctx: Ctx, snap: Snapshot, parentId: number, replace: boolean): void {
  if (!snap.children) return
  const { db } = ctx
  for (const [ct, kids] of Object.entries(snap.children)) {
    const cinfo = tableInfo(db, ct)
    if (!cinfo) continue
    const fk = cinfo.fks.find((f) => f.table === snap.table)
    if (!fk) continue
    if (cinfo.hasUuid) {
      for (const kid of kids) applyEntity(ctx, kid, 'upsert', { [fk.from]: parentId })
      continue
    }
    if (replace) db.run(`DELETE FROM ${ct} WHERE ${fk.from} = ?`, parentId)
    for (const kid of kids) {
      const row = buildRow(ctx, kid, [], { [fk.from]: parentId })
      try {
        insertRow(ctx, ct, row)
      } catch (e) {
        if (!isUniqueError(e) && !/already used/i.test((e as Error).message)) throw e
        logConflict(ctx, 'duplicate_key', ct, snap.uuid, null, kid.row, `${(e as Error).message}; remote child row skipped`)
      }
    }
  }
}

/** Top-level uuid-less rows (variant_barcodes). */
export function applyKeyed(ctx: Ctx, snap: Snapshot, op: 'upsert' | 'delete'): Outcome {
  const { db } = ctx
  if (snap.table !== 'variant_barcodes') return 'skipped'
  const barcode = String(snap.row.barcode ?? '')
  if (!barcode) return 'skipped'
  if (op === 'delete') {
    db.run('DELETE FROM variant_barcodes WHERE barcode = ?', barcode)
    return 'applied'
  }
  const row = buildRow(ctx, snap)
  try {
    db.run('INSERT INTO variant_barcodes(barcode,variant_id) VALUES (?,?) ON CONFLICT(barcode) DO UPDATE SET variant_id = excluded.variant_id', barcode, row.variant_id as number)
  } catch (e) {
    logConflict(ctx, 'duplicate_key', 'variant_barcodes', barcode, null, snap.row, (e as Error).message)
    return 'skipped'
  }
  return 'applied'
}

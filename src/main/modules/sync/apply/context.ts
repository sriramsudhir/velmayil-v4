import type { App } from '../../../core/app'
import type { Db } from '../../../db/driver'
import type { RemoteChange } from '../protocol'

/** Thrown by handlers when a referenced row has not arrived yet; the change is parked in sync_deferred and retried. */
export class Deferred extends Error {
  constructor(public missing: string) {
    super('deferred: ' + missing)
  }
}

export interface Ctx {
  app: App
  db: Db
  change: RemoteChange
  /** this terminal's sync.role */
  role?: 'standalone' | 'admin' | 'client'
  /** Client applying a change of the Admin system: the Admin's catalog always wins, whatever the clocks say */
  authoritative?: boolean
  /** set by the engine when a remote edit lost against a different local copy (the Admin then sends its copy back) */
  lostRemote?: boolean
}

/** Catalog tables for which the Admin system is the authority. */
export const ADMIN_OWNED = new Set(['categories', 'brands', 'products', 'product_variants'])

/**
 * Has THIS terminal edited the record the change is about (a queued change of its own, not an echo of a remote one)?
 * Used so that an ordinary update from another terminal is not listed as a "conflict" on a terminal that never touched it.
 */
export function locallyEdited(ctx: Ctx): boolean {
  return !!ctx.db.get(
    "SELECT 1 FROM sync_queue WHERE entity = ? AND entity_uuid = ? AND COALESCE(last_error,'') <> 'echo-suppressed' LIMIT 1",
    ctx.change.entity, ctx.change.entityUuid ?? ''
  )
}

export interface TableInfo {
  name: string
  cols: string[]
  notNull: Set<string>
  hasUuid: boolean
  fks: { from: string; table: string }[]
}

const cache = new WeakMap<Db, Map<string, TableInfo | null>>()
const SAFE = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Schema introspection (cached). Returns null for unknown tables — also the guard against hostile entity names. */
export function tableInfo(db: Db, table: string): TableInfo | null {
  let m = cache.get(db)
  if (!m) cache.set(db, (m = new Map()))
  if (m.has(table)) return m.get(table) ?? null
  let info: TableInfo | null = null
  if (SAFE.test(table) && db.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?", table)) {
    const cols = db.all<{ name: string; notnull: number; dflt_value: unknown; pk: number }>(`PRAGMA table_info(${table})`)
    info = {
      name: table,
      cols: cols.map((c) => c.name),
      notNull: new Set(cols.filter((c) => c.notnull && c.dflt_value == null && !c.pk).map((c) => c.name)),
      hasUuid: cols.some((c) => c.name === 'uuid'),
      fks: db.all<{ from: string; table: string }>(`PRAGMA foreign_key_list(${table})`).map((f) => ({ from: f.from, table: f.table }))
    }
  }
  m.set(table, info)
  return info
}

export const toSql = (v: unknown): string | number | bigint | null | Uint8Array => {
  if (v === undefined || v === null) return null
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'object') return JSON.stringify(v)
  return v as string | number
}

export function logConflict(
  ctx: Ctx, kind: string, entity: string, entityUuid: string, local: unknown, remote: unknown, resolution: string
): void {
  ctx.db.run(
    'INSERT INTO sync_conflicts(kind,entity,entity_uuid,device,local_json,remote_json,resolution) VALUES (?,?,?,?,?,?,?)',
    kind, entity, entityUuid, ctx.change.device,
    local === undefined ? null : JSON.stringify(local), remote === undefined ? null : JSON.stringify(remote), resolution
  )
}

import { Deferred, tableInfo, type Ctx } from './context'

/** Portable reference -> local integer id. Returns null when the target legitimately does not exist locally (e.g. shifts). */
export function resolveRef(ctx: Ctx, ref: { table: string; uuid: string }): number | null {
  const { db } = ctx
  const info = tableInfo(db, ref.table)
  if (!info) throw new Error(`Unknown reference table "${ref.table}"`)

  // virtual uuid for uuid-less sale lines: "#<saleUuid>:<ordinal>" (added by the sender's enrichPayload)
  if (ref.table === 'sale_items' && ref.uuid.startsWith('#')) {
    const [saleUuid, ord] = ref.uuid.slice(1).split(':')
    const saleId = db.value<number>('SELECT id FROM sales WHERE uuid = ?', saleUuid)
    if (!saleId) throw new Deferred(`sales:${saleUuid}`)
    const id = db.value<number>('SELECT id FROM sale_items WHERE sale_id = ? ORDER BY id LIMIT 1 OFFSET ?', saleId, Number(ord))
    if (!id) throw new Deferred(`sale_items:${ref.uuid}`)
    return id
  }
  if (!info.hasUuid) return null

  const direct = db.value<number>(`SELECT id FROM ${ref.table} WHERE uuid = ?`, ref.uuid)
  if (direct) return direct
  const alias = db.value<number>('SELECT local_id FROM sync_aliases WHERE alias_uuid = ? AND table_name = ?', ref.uuid, ref.table)
  if (alias) return alias

  switch (ref.table) {
    case 'users':
      return stubUser(ctx, ref.uuid)
    case 'pos_terminals':
      return ensureTerminal(ctx, ref.uuid)
    case 'locations': {
      const name = ctx.change.payload.meta?.locationName
      const byName = name ? db.value<number>('SELECT id FROM locations WHERE name = ? COLLATE NOCASE', name) : undefined
      if (byName) return byName
      if (name) {
        return db.run('INSERT INTO locations(uuid,name,is_default) VALUES (?,?,0)', ref.uuid, name).lastId
      }
      return ctx.app.defaultLocationId()
    }
    case 'shifts':
      return null // a remote cashier shift is not needed locally
    default:
      throw new Deferred(`${ref.table}:${ref.uuid}`)
  }
}

/** pos_terminals row for a remote terminal (needed as FK target of remote sales). */
export function ensureTerminal(ctx: Ctx, uuid: string): number {
  const { db } = ctx
  const have = db.value<number>('SELECT id FROM pos_terminals WHERE uuid = ?', uuid)
  if (have) return have
  const known = uuid === ctx.change.device
  let code = known && ctx.change.deviceCode ? ctx.change.deviceCode : `REMOTE-${uuid.slice(0, 8)}`
  if (db.get('SELECT 1 FROM pos_terminals WHERE code = ?', code)) code = `${code}-${uuid.slice(0, 8)}`
  const name = (known && ctx.change.deviceName) || code
  return db.run('INSERT INTO pos_terminals(uuid,code,name,is_local,active) VALUES (?,?,?,0,1)', uuid, code, name).lastId
}

/** Inactive placeholder for a user known only by uuid (users are not synced: credentials never leave a terminal). */
function stubUser(ctx: Ctx, uuid: string): number {
  const { db } = ctx
  const role =
    db.value<number>(`SELECT id FROM roles WHERE permissions NOT LIKE '%"*"%' ORDER BY length(permissions) LIMIT 1`) ??
    db.value<number>('SELECT id FROM roles LIMIT 1')
  if (!role) throw new Deferred('roles')
  const label = ctx.change.deviceCode || uuid.slice(0, 8)
  const base = `remote-${uuid.slice(0, 8)}`
  return db.run(
    'INSERT INTO users(uuid,username,name,role_id,password_hash,active) VALUES (?,?,?,?,?,0)',
    uuid, base, `Remote user (${label})`, role, 'disabled:remote'
  ).lastId
}

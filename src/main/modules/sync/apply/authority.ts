import type { App } from '../../../core/app'
import type { Snapshot } from '../../../core/snapshot'
import type { Ctx } from './context'

/**
 * LAN roles: the shop profile (name, address, GSTIN, logo) is decided on the Admin system.
 *
 * Profile versions are immutable history and every terminal keeps all of them; what differs is which one is ACTIVE.
 * Without roles the highest (version, created_at, uuid) wins everywhere, which would let a Client laptop that was set
 * up later replace the shop name of the Admin. With roles:
 *   - Admin  : stays on the newest version that was made on the Admin itself (versions received from clients are kept
 *              as history, never activated);
 *   - Client : uses the newest version it received from the Admin.
 * Only `is_active` is touched (the one column the immutability trigger leaves free).
 */
const FROM_CLIENTS = 'profile_from_clients' // admin: uuids of versions received from other terminals
const FROM_ADMIN = 'profile_from_admin' // client: [version, created_at, uuid] of the newest version the Admin sent

const get = (app: App, key: string): string | undefined => app.db.value<string>('SELECT value FROM sync_state WHERE key = ?', key)
const set = (app: App, key: string, value: string): void => {
  app.db.run('INSERT INTO sync_state(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value)
}
const parse = <T>(s: string | undefined, d: T): T => {
  try {
    return s ? (JSON.parse(s) as T) : d
  } catch {
    return d
  }
}

type Key = [number, number, string]
const newer = (a: Key, b: Key | null): boolean => {
  if (!b) return true
  if (a[0] !== b[0]) return a[0] > b[0]
  if (a[1] !== b[1]) return a[1] > b[1]
  return a[2] > b[2]
}

/** Remember where an inbound profile version came from (call inside the apply transaction). */
export function noteProfile(ctx: Ctx, snap: Snapshot, existedBefore: boolean): void {
  if (!snap.uuid) return
  if (ctx.role === 'client' && ctx.authoritative) {
    const k: Key = [Number(snap.row.version) || 0, Number(snap.row.created_at) || 0, snap.uuid]
    if (newer(k, parse<Key | null>(get(ctx.app, FROM_ADMIN), null))) set(ctx.app, FROM_ADMIN, JSON.stringify(k))
  } else if (ctx.role === 'admin' && !existedBefore) {
    const seen = parse<string[]>(get(ctx.app, FROM_CLIENTS), [])
    if (!seen.includes(snap.uuid)) set(ctx.app, FROM_CLIENTS, JSON.stringify([...seen, snap.uuid]))
  }
}

/** Make the version the role calls for the active one. Returns true when it had to switch. Cheap when nothing is wrong. */
export function enforceProfile(app: App, role: string | undefined): boolean {
  const db = app.db
  let want: number | undefined
  if (role === 'client') {
    const k = parse<Key | null>(get(app, FROM_ADMIN), null)
    if (!k) return false
    want = db.value<number>('SELECT id FROM business_profile_versions WHERE uuid = ?', k[2])
  } else if (role === 'admin') {
    const seen = parse<string[]>(get(app, FROM_CLIENTS), [])
    if (!seen.length) return false
    want = db.value<number>(
      `SELECT id FROM business_profile_versions WHERE uuid NOT IN (${seen.map(() => '?').join(',')}) ORDER BY version DESC, created_at DESC, uuid DESC LIMIT 1`, ...seen
    )
  }
  if (!want) return false
  const active = db.all<{ id: number }>('SELECT id FROM business_profile_versions WHERE is_active = 1')
  if (active.length === 1 && active[0].id === want) return false
  db.transaction(() => {
    db.run('UPDATE business_profile_versions SET is_active = 0 WHERE is_active = 1 AND id <> ?', want as number)
    db.run('UPDATE business_profile_versions SET is_active = 1 WHERE id = ?', want as number)
  })
  return true
}

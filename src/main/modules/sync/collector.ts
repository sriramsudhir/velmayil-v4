import type { App } from '../../core/app'
import type { Db } from '../../db/driver'
import type { ChildSpec, Snapshot } from '../../core/snapshot'
import { tableInfo } from './apply/context'
import { saleDeletePayload, saleTombstones } from '../pos/service'
import type { LogoPayload, SyncPayload } from './protocol'

/**
 * Columns that hold a local id but have no declared FOREIGN KEY (so snapshotRow cannot produce a ref for them).
 * The sender resolves them to uuids just before pushing, so a receiver never sees another terminal's raw ids.
 */
const CONVENTION: Record<string, string> = {
  pos_id: 'pos_terminals', user_id: 'users', created_by: 'users', voided_by: 'users', approved_by: 'users', void_approved_by: 'users',
  shift_id: 'shifts', void_shift_id: 'shifts', variant_id: 'product_variants', category_id: 'categories', brand_id: 'brands',
  customer_id: 'customers', supplier_id: 'suppliers', location_id: 'locations'
}

/** Deep copy of a queued snapshot + portable refs for undeclared id columns + logo bytes / location / document refs. */
export function enrichPayload(db: Db, entity: string, queued: Snapshot): SyncPayload {
  const snap: SyncPayload = JSON.parse(JSON.stringify(queued))
  if (typeof snap.table !== 'string' || !snap.row) return snap // custom payload (e.g. logo_assets bytes): pass through untouched
  enrichNode(db, snap)
  const meta: NonNullable<SyncPayload['meta']> = {}
  if (entity === 'product_units') {
    // locations are matched by name across terminals (same convention as stock movements)
    const loc = db.value<string>('SELECT name FROM locations WHERE id = ?', Number(snap.row.location_id))
    if (loc) meta.locationName = loc
  }
  if (entity === 'stock_movements') {
    const loc = db.value<string>('SELECT name FROM locations WHERE id = ?', Number(snap.row.location_id))
    if (loc) meta.locationName = loc
    const ref = movementDocRef(db, snap.row.ref_type as string | null, snap.row.ref_id as string | null)
    if (ref) Object.assign(meta, ref)
  }
  if (entity === 'business_profile_versions' || entity === 'logo_assets') {
    const logo = logoPayload(db, entity === 'logo_assets' ? undefined : Number(snap.row.logo_asset_id), String(snap.row.sha256 ?? snap.row.logo_sha256 ?? ''))
    if (logo) meta.logo = logo
  }
  if (Object.keys(meta).length) snap.meta = meta
  return snap
}

function enrichNode(db: Db, node: Snapshot): void {
  const info = tableInfo(db, node.table)
  if (info) {
    node.refs ??= {}
    for (const [col, target] of Object.entries(CONVENTION)) {
      const v = node.row[col]
      if (!info.cols.includes(col) || node.refs[col] !== undefined || typeof v !== 'number') continue
      const ti = tableInfo(db, target)
      if (!ti?.hasUuid) continue
      const uuid = db.value<string>(`SELECT uuid FROM ${target} WHERE id = ?`, v)
      if (uuid) node.refs[col] = { table: target, uuid }
    }
    for (const fk of info.fks) {
      const v = node.row[fk.from]
      if (fk.table === 'sale_items' && node.refs[fk.from] == null && typeof v === 'number') {
        const si = db.get<{ sale_id: number }>('SELECT sale_id FROM sale_items WHERE id = ?', v)
        const saleUuid = si ? db.value<string>('SELECT uuid FROM sales WHERE id = ?', si.sale_id) : undefined
        if (si && saleUuid) {
          const ord = db.value<number>('SELECT COUNT(*) FROM sale_items WHERE sale_id = ? AND id < ?', si.sale_id, v) ?? 0
          node.refs[fk.from] = { table: 'sale_items', uuid: `#${saleUuid}:${ord}` }
        }
      }
    }
  }
  for (const kids of Object.values(node.children ?? {})) for (const k of kids) enrichNode(db, k)
}

function movementDocRef(db: Db, refType: string | null, refId: string | null): { refTable: string; refUuid: string } | undefined {
  if (!refType || !refId || !/^\d+$/.test(refId)) return undefined
  const cands = [refType, refType + 's', refType.replace(/y$/, 'ies'), refType.replace(/_?return$/, '_returns')]
  for (const c of cands) {
    const ti = tableInfo(db, c)
    if (ti?.hasUuid) {
      const uuid = db.value<string>(`SELECT uuid FROM ${c} WHERE id = ?`, Number(refId))
      if (uuid) return { refTable: c, refUuid: uuid }
    }
  }
  return undefined
}

function logoPayload(db: Db, assetId: number | undefined, sha: string): LogoPayload | undefined {
  const r = assetId
    ? db.get<Record<string, unknown>>('SELECT * FROM logo_assets WHERE id = ?', assetId)
    : sha ? db.get<Record<string, unknown>>('SELECT * FROM logo_assets WHERE sha256 = ?', sha) : undefined
  if (!r) return undefined
  const b64 = (v: unknown) => (v ? Buffer.from(v as Uint8Array).toString('base64') : null)
  return {
    sha256: r.sha256 as string, mime: r.mime as string, widthPx: r.width_px as number, heightPx: r.height_px as number,
    sizeBytes: r.size_bytes as number, hasTransparency: (r.has_transparency as number) ?? 0, createdAt: r.created_at as number,
    bytesB64: b64(r.bytes) ?? '', printBytesB64: b64(r.print_bytes), printMime: (r.print_mime as string) ?? null
  }
}

// ---------------------------------------------------------------------------------------------------------------------
/**
 * Stock movements are written by app.moveStock (core) which does not enqueue. The sync module therefore queues every
 * movement made by THIS terminal itself (pos_id = local or null) that it has not queued yet — remote-applied movements
 * carry the remote terminal's pos_id and are never re-sent (no echo).
 */
export function collectLocalMovements(app: App, limit = 5000): number {
  const db = app.db
  const local = db.value<number>('SELECT id FROM pos_terminals WHERE is_local = 1')
  const cursor = Number(db.value<string>("SELECT value FROM sync_state WHERE key = 'moves_cursor'") ?? 0)
  const rows = db.all<{ id: number; pos_id: number | null }>('SELECT id, pos_id FROM stock_movements WHERE id > ? ORDER BY id LIMIT ?', cursor, limit)
  if (!rows.length) return 0
  let n = 0
  db.transaction(() => {
    for (const r of rows) {
      if (r.pos_id != null && r.pos_id !== local) continue
      app.enqueueSnapshot('stock_movements', r.id)
      n++
    }
    db.run("INSERT INTO sync_state(key,value) VALUES ('moves_cursor',?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", String(rows[rows.length - 1].id))
  })
  return n
}

const children = (table: string, fk: string, kids: ChildSpec[] = []): ChildSpec => ({ table, fk, children: kids })

/** Documents + their line tables, in dependency order, for (re)sending everything this terminal has. */
const FULL: { table: string; children?: ChildSpec[] }[] = [
  { table: 'categories' },
  { table: 'brands' },
  { table: 'products', children: [children('product_variants', 'product_id', [children('variant_barcodes', 'variant_id')])] },
  { table: 'customers' },
  { table: 'suppliers' },
  { table: 'business_profile_versions' },
  { table: 'sales', children: [children('sale_items', 'sale_id'), children('sale_payments', 'sale_id')] },
  { table: 'sale_returns', children: [children('sale_return_items', 'return_id')] },
  { table: 'purchases', children: [children('purchase_items', 'purchase_id')] },
  { table: 'purchase_payments' },
  { table: 'supplier_returns', children: [children('supplier_return_items', 'return_id')] },
  { table: 'stock_adjustments' },
  { table: 'product_units' }
]

/** Queue every syncable row again (new terminal joins, or after a server reset). Receivers are idempotent. */
export function resyncAll(app: App): { queued: number } {
  const db = app.db
  let queued = 0
  const prev = app.forceEnqueue
  app.forceEnqueue = true
  try {
  db.transaction(() => {
    for (const f of FULL) {
      if (!tableInfo(db, f.table)) continue
      for (const r of db.all<{ id: number }>(`SELECT id FROM ${f.table} ORDER BY id`)) {
        const kids = (f.children ?? []).filter((c) => tableInfo(db, c.table))
        app.enqueueSnapshot(f.table, r.id, kids)
        queued++
      }
    }
    // permanently deleted invoices: a terminal that still holds a copy must drop it (and never send it back)
    if (tableInfo(db, 'deleted_sales')) {
      for (const t of saleTombstones(db)) {
        app.enqueueSync('sales', t.uuid, 'delete', saleDeletePayload(t))
        queued++
      }
    }
    db.run("INSERT INTO sync_state(key,value) VALUES ('moves_cursor','0') ON CONFLICT(key) DO UPDATE SET value = '0'")
  })
  } finally {
    app.forceEnqueue = prev
  }
  return { queued }
}


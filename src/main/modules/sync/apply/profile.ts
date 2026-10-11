import type { Snapshot } from '../../../core/snapshot'
import { logConflict, tableInfo, toSql, type Ctx } from './context'
import { buildRow, type Outcome } from './engine'
import type { LogoPayload, SyncPayload } from '../protocol'

/** logo_assets are content-addressed (sha256): insert once, reuse everywhere. Bytes travel in meta.logo (snapshots skip blobs). */
export function ensureLogo(ctx: Ctx, logo: LogoPayload | undefined): number | null {
  if (!logo?.sha256) return null
  const { db } = ctx
  const have = db.value<number>('SELECT id FROM logo_assets WHERE sha256 = ?', logo.sha256)
  if (have) return have
  return db.run(
    `INSERT INTO logo_assets(sha256,mime,width_px,height_px,bytes,print_bytes,print_mime,size_bytes,has_transparency,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    logo.sha256, logo.mime, logo.widthPx, logo.heightPx, Buffer.from(logo.bytesB64, 'base64'),
    logo.printBytesB64 ? Buffer.from(logo.printBytesB64, 'base64') : null, logo.printMime, logo.sizeBytes, logo.hasTransparency, logo.createdAt
  ).lastId
}

/**
 * Explicit `logo_assets` entity. Payload (businessProfile module): { sha256, mime, widthPx, heightPx, sizeBytes,
 * hasTransparency, bytesBase64 }. Delegated to businessProfile.applySyncedLogo when available (it also releases profile
 * versions that were waiting for these bytes); otherwise stored directly.
 */
export function applyLogoAsset(ctx: Ctx, snap: Snapshot): Outcome {
  const p = snap as unknown as Record<string, unknown>
  const sha = String(p.sha256 ?? '')
  const b64 = String(p.bytesBase64 ?? (snap as SyncPayload).meta?.logo?.bytesB64 ?? '')
  if (!sha || !b64) return 'skipped'
  const before = ctx.db.value<number>('SELECT COUNT(*) FROM logo_assets')
  if (ctx.app.has('businessProfile')) {
    const svc = ctx.app.get<{ applySyncedLogo?: (x: { sha256: string; bytesBase64: string }) => unknown }>('businessProfile')
    if (typeof svc.applySyncedLogo === 'function') {
      svc.applySyncedLogo({ sha256: sha, bytesBase64: b64 })
      return ctx.db.value<number>('SELECT COUNT(*) FROM logo_assets') !== before ? 'applied' : 'skipped'
    }
  }
  ensureLogo(ctx, {
    sha256: sha, mime: String(p.mime ?? 'image/png'), widthPx: Number(p.widthPx ?? 0), heightPx: Number(p.heightPx ?? 0),
    sizeBytes: Number(p.sizeBytes ?? 0), hasTransparency: p.hasTransparency ? 1 : 0, createdAt: Date.now(), bytesB64: b64,
    printBytesB64: null, printMime: null
  })
  return ctx.db.value<number>('SELECT COUNT(*) FROM logo_assets') !== before ? 'applied' : 'skipped'
}

interface BpvRow { id: number; uuid: string; version: number; created_at: number }
const keyOf = (r: { version: number; created_at: number; uuid: string }) => [Number(r.version), Number(r.created_at), r.uuid] as const
const cmp = (a: readonly (number | string)[], b: readonly (number | string)[]): number => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1
  return 0
}

/**
 * Business profile versions are immutable history. A remote version is inserted as a new row (never UPDATE); the active
 * one is the highest (version, created_at, uuid) — identical on every terminal. Version-number clashes (two terminals
 * both made "v7" offline) keep both rows, the later one is renumbered to max+1 locally and a conflict is logged.
 * If the businessProfile module offers applySynced(snapshot) we delegate to it (single owner of that table).
 */
export function applyProfileVersion(ctx: Ctx, snap: Snapshot): Outcome {
  const { app, db } = ctx
  if (app.has('businessProfile')) {
    const svc = app.get<{ applySynced?: (s: unknown) => unknown; applySyncedLogo?: (x: { sha256: string; bytesBase64: string }) => unknown }>('businessProfile')
    if (typeof svc.applySynced === 'function') {
      // logo bytes first (through the profile service, which validates/optimises them), so the version can be adopted at once
      const logo = (snap as SyncPayload).meta?.logo
      if (logo?.sha256 && logo.bytesB64) {
        try {
          if (typeof svc.applySyncedLogo === 'function') svc.applySyncedLogo({ sha256: logo.sha256, bytesBase64: logo.bytesB64 })
          else ensureLogo(ctx, logo)
        } catch {
          // bytes the profile module refuses to decode (corrupt/unknown format): keep them as-is so the shop name still syncs
          ensureLogo(ctx, logo)
        }
      }
      svc.applySynced(snap)
      return 'applied'
    }
  }
  ensureLogo(ctx, (snap as SyncPayload).meta?.logo)
  if (db.get('SELECT 1 FROM business_profile_versions WHERE uuid = ?', snap.uuid)) return 'skipped'

  const info = tableInfo(db, 'business_profile_versions')!
  const row = buildRow(ctx, snap, ['logo_asset_id'])
  const logoId = ensureLogo(ctx, (snap as SyncPayload).meta?.logo)
  row.logo_asset_id = logoId
  if (info.cols.includes('logo_sha256')) row.logo_sha256 = (snap as SyncPayload).meta?.logo?.sha256 ?? (snap.row.logo_sha256 as string) ?? ''
  const remoteVersion = Number(snap.row.version)
  if (db.get('SELECT 1 FROM business_profile_versions WHERE version = ?', remoteVersion)) {
    const next = (db.value<number>('SELECT MAX(version) FROM business_profile_versions') ?? 0) + 1
    logConflict(ctx, 'version_collision', 'business_profile_versions', snap.uuid, null, { version: remoteVersion, shop_name: snap.row.shop_name },
      `Version ${remoteVersion} already exists locally; stored remote copy as version ${next}`)
    row.version = next
  }
  row.is_active = 0
  const cols = Object.keys(row)
  const id = db.run(`INSERT INTO business_profile_versions(${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, ...cols.map((c) => toSql(row[c]))).lastId

  const cur = db.get<BpvRow>('SELECT id, uuid, version, created_at FROM business_profile_versions WHERE is_active = 1')
  const remoteKey = keyOf({ version: remoteVersion, created_at: Number(snap.row.created_at ?? 0), uuid: snap.uuid })
  if (!cur || cmp(remoteKey, keyOf(cur)) > 0) {
    if (cur) db.run('UPDATE business_profile_versions SET is_active = 0 WHERE id = ?', cur.id)
    db.run('UPDATE business_profile_versions SET is_active = 1 WHERE id = ?', id)
  }
  return 'applied'
}

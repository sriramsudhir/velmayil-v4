import { z } from 'zod'
import type { App } from '../../core/app'
import type { Snapshot } from '../../core/snapshot'
import { AppError } from '@shared/ipc'
import type { BusinessProfile } from '@shared/types'
import { checkLogoQuality, optimizeForPrint, parseLogoFile, type LogoQuality } from './imageTools'
import { parseHeaderSettings, parseLogoSettings, parseProfileFields, type ProfileFields } from './schema'

export type ReprintPolicy = 'original' | 'current'

export interface LogoAsset {
  id: number
  sha256: string
  mime: string
  bytes: Buffer
  printMime: string
  printBytes: Buffer
  widthPx: number
  heightPx: number
  sizeBytes: number
  hasTransparency: boolean
  /** data: URI of the print-optimised image (default) or the original. */
  dataUri(original?: boolean): string
}

export interface ProfileVersionSummary {
  id: number
  version: number
  shopName: string
  displayName: string
  logoSha256: string
  isActive: boolean
  createdAt: number
  createdBy: number | null
  createdByName: string | null
}

type Row = Record<string, any>

const FIELD_KEYS = ['shopName', 'legalName', 'displayName', 'shortName', 'address', 'city', 'state', 'pinCode', 'phone', 'email', 'website', 'gstin', 'pan', 'footerText'] as const
/** Always captured in the audit trail (old/new), whether changed or not. */
const AUDIT_KEYS = ['shopName', 'address', 'gstin', 'phone'] as const

const toProfile = (r: Row): BusinessProfile => ({
  id: r.id,
  version: r.version,
  shopName: r.shop_name,
  legalName: r.legal_name,
  displayName: r.display_name || r.shop_name,
  shortName: r.short_name,
  address: r.address,
  city: r.city,
  state: r.state,
  pinCode: r.pin_code,
  phone: r.phone,
  email: r.email,
  website: r.website,
  gstin: r.gstin,
  pan: r.pan,
  footerText: r.footer_text,
  logoAssetId: r.logo_asset_id ?? null,
  logoSettings: parseLogoSettings(safeJson(r.logo_settings_json)),
  headerSettings: parseHeaderSettings(safeJson(r.header_settings_json)),
  createdAt: r.created_at,
  createdBy: r.created_by ?? null
})
function safeJson(s: unknown): unknown {
  try {
    return JSON.parse(String(s ?? '{}'))
  } catch {
    return {}
  }
}

const toFields = (p: BusinessProfile): Record<string, unknown> => ({
  shopName: p.shopName, legalName: p.legalName, displayName: p.displayName, shortName: p.shortName, address: p.address, city: p.city,
  state: p.state, pinCode: p.pinCode, phone: p.phone, email: p.email, website: p.website, gstin: p.gstin, pan: p.pan,
  footerText: p.footerText, logoSettings: p.logoSettings, headerSettings: p.headerSettings
})

const logoInput = z.object({
  /** base64 (optionally a data: URI) or raw bytes */
  data: z.union([z.string().min(1), z.instanceof(Uint8Array)]),
  name: z.string().optional()
})
export interface LogoFileInput { data: string | Uint8Array; name?: string }

export class BusinessProfileService {
  private logoCache = new Map<number, LogoAsset>()
  constructor(private app: App) {}

  // ---------------------------------------------------------------- reads
  findActive(): BusinessProfile | null {
    const r = this.app.db.get<Row>('SELECT * FROM business_profile_versions WHERE is_active = 1')
    return r ? toProfile(r) : null
  }
  getActive(): BusinessProfile {
    const p = this.findActive()
    if (!p) throw new AppError('NOT_FOUND', 'Shop profile has not been set up yet')
    return p
  }
  getById(versionId: number): BusinessProfile {
    const r = this.app.db.get<Row>('SELECT * FROM business_profile_versions WHERE id = ?', versionId)
    if (!r) throw new AppError('NOT_FOUND', `Shop profile version ${versionId} not found`)
    return toProfile(r)
  }
  getReprintPolicy(): ReprintPolicy {
    return this.app.setting('reprint_profile_policy', 'original') === 'current' ? 'current' : 'original'
  }
  setReprintPolicy(policy: ReprintPolicy): void {
    if (policy !== 'original' && policy !== 'current') throw new AppError('VALIDATION', 'Policy must be original or current')
    const old = this.getReprintPolicy()
    this.app.setSetting('reprint_profile_policy', policy)
    this.app.audit({ entity: 'settings', entityId: 'reprint_profile_policy', action: 'profile.reprint_policy', old: { policy: old }, new: { policy } })
  }
  /** Profile to print on a historical document. 'original' = the pinned version, 'current' = the active one. */
  getForDocument(profileVersionId: number | null | undefined, policy?: ReprintPolicy): BusinessProfile {
    const pol = policy ?? this.getReprintPolicy()
    if (pol === 'current' || profileVersionId == null) return this.getActive()
    const r = this.app.db.get<Row>('SELECT * FROM business_profile_versions WHERE id = ?', profileVersionId)
    return r ? toProfile(r) : this.getActive()
  }
  listVersions(): ProfileVersionSummary[] {
    return this.app.db
      .all<Row>(
        `SELECT b.id, b.version, b.shop_name, b.display_name, b.logo_sha256, b.is_active, b.created_at, b.created_by, u.name AS user_name
         FROM business_profile_versions b LEFT JOIN users u ON u.id = b.created_by ORDER BY b.version DESC`
      )
      .map((r) => ({
        id: r.id, version: r.version, shopName: r.shop_name, displayName: r.display_name || r.shop_name, logoSha256: r.logo_sha256 ?? '',
        isActive: !!r.is_active, createdAt: r.created_at, createdBy: r.created_by ?? null, createdByName: r.user_name ?? null
      }))
  }

  getLogo(assetId: number | null | undefined): LogoAsset | null {
    if (assetId == null) return null
    const hit = this.logoCache.get(assetId)
    if (hit) return hit
    const r = this.app.db.get<Row>('SELECT * FROM logo_assets WHERE id = ?', assetId)
    if (!r) return null
    const bytes = Buffer.from(r.bytes as Uint8Array)
    const printBytes = r.print_bytes ? Buffer.from(r.print_bytes as Uint8Array) : bytes
    const printMime: string = r.print_mime || r.mime
    const mime: string = r.mime
    const asset: LogoAsset = {
      id: r.id, sha256: r.sha256, mime, bytes, printMime, printBytes,
      widthPx: r.width_px, heightPx: r.height_px, sizeBytes: r.size_bytes, hasTransparency: !!r.has_transparency,
      dataUri: (original = false) => `data:${original ? mime : printMime};base64,${(original ? bytes : printBytes).toString('base64')}`
    }
    this.logoCache.set(assetId, asset)
    return asset
  }

  /** Print-quality report for a stored logo at a target size (mm). */
  checkLogoQuality(assetId: number, targetMm: number | { widthMm?: number; heightMm?: number }): LogoQuality {
    const a = this.getLogo(assetId)
    if (!a) throw new AppError('NOT_FOUND', 'Logo not found')
    return checkLogoQuality(a, targetMm)
  }

  // ---------------------------------------------------------------- writes
  /**
   * Save the profile. Creates a NEW immutable version (v1 when none exists, used by first-run setup). Input is merged
   * over the active version, so partial updates work. The logo is unchanged (use setLogo / removeLogo).
   * An identical save is a no-op and returns the active version.
   */
  save(input: Record<string, unknown>): BusinessProfile {
    const cur = this.findActive()
    const merged: Record<string, unknown> = { ...(cur ? toFields(cur) : {}), ...stripUndefined(input) }
    // a printed name that simply mirrored the shop name keeps following it
    if (cur && 'shopName' in input && !('displayName' in input) && cur.displayName === cur.shopName) merged.displayName = ''
    let fields: ProfileFields
    try {
      fields = parseProfileFields(merged)
    } catch (e) {
      throw validationError(e)
    }
    if (cur && sameFields(toFields(cur), fields)) return cur
    return this.createVersion(fields, cur?.logoAssetId ?? null, null, cur, cur ? 'profile.save' : 'profile.create')
  }

  setLogo(file: LogoFileInput): { profile: BusinessProfile; quality: LogoQuality } {
    const parsed = logoInput.safeParse(file)
    if (!parsed.success) throw new AppError('VALIDATION', 'Logo file is required')
    const raw = typeof parsed.data.data === 'string' ? Buffer.from(parsed.data.data.replace(/^data:[^,]*,/, ''), 'base64') : Buffer.from(parsed.data.data)
    const logo = parseLogoFile(raw)
    const cur = this.getActive()
    const existing = this.app.db.get<Row>('SELECT id FROM logo_assets WHERE sha256 = ?', logo.sha256)
    const profile = this.app.db.transaction(() => {
      let assetId: number
      if (existing) assetId = existing.id
      else {
        const opt = optimizeForPrint(logo)
        assetId = this.app.db.run(
          `INSERT INTO logo_assets(sha256,mime,width_px,height_px,bytes,print_bytes,print_mime,size_bytes,has_transparency) VALUES (?,?,?,?,?,?,?,?,?)`,
          logo.sha256, logo.mime, logo.widthPx, logo.heightPx, logo.bytes, opt.bytes, opt.mime, logo.sizeBytes, logo.hasTransparency ? 1 : 0
        ).lastId
        this.app.enqueueSync('logo_assets', logo.sha256, 'upsert', {
          sha256: logo.sha256, mime: logo.mime, widthPx: logo.widthPx, heightPx: logo.heightPx, sizeBytes: logo.sizeBytes,
          hasTransparency: logo.hasTransparency, bytesBase64: logo.bytes.toString('base64')
        })
      }
      return this.createVersion(toFieldsParsed(cur), assetId, logo.sha256, cur, 'profile.logo_set')
    })
    return { profile, quality: checkLogoQuality(logo, { widthMm: cur.logoSettings.widthMm, heightMm: cur.logoSettings.heightMm }) }
  }

  removeLogo(): BusinessProfile {
    const cur = this.getActive()
    if (cur.logoAssetId == null) return cur
    return this.createVersion(toFieldsParsed(cur), null, '', cur, 'profile.logo_remove')
  }

  private createVersion(fields: ProfileFields, logoAssetId: number | null, logoShaHint: string | null, old: BusinessProfile | null, action: string): BusinessProfile {
    const app = this.app
    return app.db.transaction(() => {
      const sha = logoAssetId == null ? '' : (logoShaHint ?? app.db.value<string>('SELECT sha256 FROM logo_assets WHERE id = ?', logoAssetId) ?? '')
      const next = (app.db.value<number>('SELECT COALESCE(MAX(version),0) FROM business_profile_versions') ?? 0) + 1
      app.db.run('UPDATE business_profile_versions SET is_active = 0 WHERE is_active = 1')
      const pos = app.db.value<number>('SELECT id FROM pos_terminals WHERE is_local = 1') ?? null
      const id = app.db.run(
        `INSERT INTO business_profile_versions(uuid,version,shop_name,legal_name,display_name,short_name,address,city,state,pin_code,phone,email,website,gstin,pan,footer_text,
           logo_asset_id,logo_sha256,logo_settings_json,header_settings_json,is_active,created_by,pos_id,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?)`,
        app.uuid(), next, fields.shopName, fields.legalName, fields.displayName, fields.shortName, fields.address, fields.city, fields.state,
        fields.pinCode, fields.phone, fields.email, fields.website, fields.gstin, fields.pan, fields.footerText, logoAssetId, sha,
        JSON.stringify(fields.logoSettings), JSON.stringify(fields.headerSettings), app.session?.userId ?? null, pos, Date.now()
      ).lastId
      const created = this.getById(id)
      app.audit({ entity: 'business_profile', entityId: id, action, ...diffForAudit(old, created, old ? this.logoSha(old) : '', sha), note: `v${old?.version ?? 0} -> v${next}` })
      app.enqueueSnapshot('business_profile_versions', id)
      return created
    })
  }
  private logoSha(p: BusinessProfile): string {
    return p.logoAssetId == null ? '' : (this.app.db.value<string>('SELECT sha256 FROM logo_assets WHERE id = ?', p.logoAssetId) ?? '')
  }

  // ---------------------------------------------------------------- multi-POS inbound
  /**
   * Adopt a profile version created on another terminal. Local history is never rewritten: the remote row is inserted
   * as a new immutable version and becomes active only if it is newer (created_at, then version) than the active one.
   * If its logo bytes have not arrived yet the snapshot is parked until applySyncedLogo() delivers them.
   */
  applySynced(snapshot: Pick<Snapshot, 'uuid' | 'row'>): { adopted: boolean; activated: boolean; pending?: boolean; versionId?: number } {
    const app = this.app
    const r = snapshot.row as Row
    const uuid = snapshot.uuid || r.uuid
    if (!uuid || !r.shop_name) throw new AppError('VALIDATION', 'Invalid profile snapshot')
    if (app.db.get('SELECT 1 FROM business_profile_versions WHERE uuid = ?', uuid)) return { adopted: false, activated: false }
    const sha: string = r.logo_sha256 ?? ''
    let assetId: number | null = null
    if (sha) {
      assetId = app.db.value<number>('SELECT id FROM logo_assets WHERE sha256 = ?', sha) ?? null
      if (assetId == null) {
        this.parkPending(uuid, snapshot)
        return { adopted: false, activated: false, pending: true }
      }
    }
    return app.db.transaction(() => {
      const active = this.findActive()
      const maxV = app.db.value<number>('SELECT COALESCE(MAX(version),0) FROM business_profile_versions') ?? 0
      const clash = !!app.db.get('SELECT 1 FROM business_profile_versions WHERE version = ?', r.version)
      const version = clash || !(r.version > 0) ? maxV + 1 : r.version
      const createdAt: number = r.created_at ?? Date.now()
      // Deterministic total order shared by every terminal: created_at, then uuid. (The local `version` number is NOT
      // used: it is re-numbered on clash while adopting, so it differs per terminal and would make the two sides disagree.)
      // The loser is still stored as an inactive version, so no history is lost.
      const activeUuid = active ? (app.db.value<string>('SELECT uuid FROM business_profile_versions WHERE id = ?', active.id) ?? '') : ''
      const wins = !active || createdAt > active.createdAt || (createdAt === active.createdAt && uuid > activeUuid)
      if (wins) app.db.run('UPDATE business_profile_versions SET is_active = 0 WHERE is_active = 1')
      const id = app.db.run(
        `INSERT INTO business_profile_versions(uuid,version,shop_name,legal_name,display_name,short_name,address,city,state,pin_code,phone,email,website,gstin,pan,footer_text,
           logo_asset_id,logo_sha256,logo_settings_json,header_settings_json,is_active,created_at,created_by,pos_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL)`,
        uuid, version, r.shop_name, r.legal_name ?? '', r.display_name || r.shop_name, r.short_name ?? '', r.address ?? '', r.city ?? '', r.state ?? '',
        r.pin_code ?? '', r.phone ?? '', r.email ?? '', r.website ?? '', r.gstin ?? '', r.pan ?? '', r.footer_text ?? '', assetId, sha,
        typeof r.logo_settings_json === 'string' ? r.logo_settings_json : '{}', typeof r.header_settings_json === 'string' ? r.header_settings_json : '{}',
        wins ? 1 : 0, createdAt
      ).lastId
      app.audit({
        entity: 'business_profile', entityId: id, action: 'profile.sync_adopted',
        old: active ? { version: active.version, shopName: active.shopName } : null, new: { version, shopName: r.shop_name, active: wins },
        note: 'inbound from another terminal'
      })
      return { adopted: true, activated: wins, versionId: id }
    })
  }

  /** Inbound 'logo_assets' entity (bytes as base64). Also releases profile snapshots that were waiting for it. */
  applySyncedLogo(payload: { sha256: string; bytesBase64: string }): { stored: boolean; released: number } {
    const logo = parseLogoFile(Buffer.from(payload.bytesBase64, 'base64'))
    if (payload.sha256 && logo.sha256 !== payload.sha256) {
      // SVG sanitisation may legitimately change the bytes; any other mismatch is corruption.
      if (logo.format !== 'svg') throw new AppError('VALIDATION', 'Logo checksum mismatch')
    }
    let stored = false
    if (!this.app.db.get('SELECT 1 FROM logo_assets WHERE sha256 = ?', logo.sha256)) {
      const opt = optimizeForPrint(logo)
      this.app.db.run(
        `INSERT INTO logo_assets(sha256,mime,width_px,height_px,bytes,print_bytes,print_mime,size_bytes,has_transparency) VALUES (?,?,?,?,?,?,?,?,?)`,
        logo.sha256, logo.mime, logo.widthPx, logo.heightPx, logo.bytes, opt.bytes, opt.mime, logo.sizeBytes, logo.hasTransparency ? 1 : 0
      )
      stored = true
    }
    let released = 0
    const pending = this.readPending()
    for (const [uuid, snap] of Object.entries(pending)) {
      if ((snap.row.logo_sha256 as string) === logo.sha256 || (payload.sha256 && snap.row.logo_sha256 === payload.sha256)) {
        delete pending[uuid]
        this.writePending(pending)
        this.applySynced(snap)
        released++
      }
    }
    return { stored, released }
  }
  private readPending(): Record<string, Pick<Snapshot, 'uuid' | 'row'>> {
    try {
      return JSON.parse(this.app.setting('profile.pending_sync', '{}'))
    } catch {
      return {}
    }
  }
  private writePending(p: Record<string, unknown>): void {
    this.app.setSetting('profile.pending_sync', JSON.stringify(p))
  }
  private parkPending(uuid: string, snap: Pick<Snapshot, 'uuid' | 'row'>): void {
    const p = this.readPending()
    p[uuid] = { uuid, row: snap.row }
    this.writePending(p)
  }
}

function stripUndefined(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v !== undefined))
}
function toFieldsParsed(p: BusinessProfile): ProfileFields {
  return parseProfileFields(toFields(p))
}
function sameFields(a: Record<string, unknown>, b: ProfileFields): boolean {
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b))
}
const canon = (o: Record<string, unknown>) => FIELD_KEYS.map((k) => o[k]).concat([o.logoSettings, o.headerSettings] as any)

function diffForAudit(old: BusinessProfile | null, now: BusinessProfile, oldSha: string, newSha: string) {
  const o: Record<string, unknown> = {}
  const n: Record<string, unknown> = {}
  const get = (p: BusinessProfile | null, k: string) => (p ? (p as unknown as Record<string, unknown>)[k] : null)
  for (const k of FIELD_KEYS) {
    if ((AUDIT_KEYS as readonly string[]).includes(k) || get(old, k) !== get(now, k)) {
      o[k] = get(old, k)
      n[k] = get(now, k)
    }
  }
  o.logoSha256 = oldSha
  n.logoSha256 = newSha
  if (old && JSON.stringify(old.logoSettings) !== JSON.stringify(now.logoSettings)) { o.logoSettings = old.logoSettings; n.logoSettings = now.logoSettings }
  if (old && JSON.stringify(old.headerSettings) !== JSON.stringify(now.headerSettings)) { o.headerSettings = old.headerSettings; n.headerSettings = now.headerSettings }
  return { old: old ? o : undefined, new: n }
}

export function validationError(e: unknown): AppError {
  if (e instanceof z.ZodError) {
    const first = e.issues[0]
    const path = first.path.join('.')
    return new AppError('VALIDATION', first.message, { fields: Object.fromEntries(e.issues.map((i) => [i.path.join('.'), i.message])), path })
  }
  return e instanceof AppError ? e : new AppError('VALIDATION', e instanceof Error ? e.message : String(e))
}

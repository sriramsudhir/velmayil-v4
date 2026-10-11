import { z } from 'zod'
import type { App } from '../../core/app'
import { settingDef, settingDefs, validateSetting, type SettingDef } from '../../core/settings'
import { parseInput } from '../../core/validate'
import { AppError } from '@shared/ipc'
import { POS_CODE_RE } from '../setup/service'

/** Setting keys holding credentials (e.g. the sync API key). */
export const isSecretKey = (k: string): boolean => /(^|\.)(key|secret|password|token)$/i.test(k)
const MASK = '********'

const id = z.object({ id: z.number().int().positive() })
const locName = z.string().trim().min(1, 'Name is required').max(60)
const posName = z.string().trim().min(1, 'Name is required').max(60)
const posCode = z.string().trim().toUpperCase().regex(POS_CODE_RE, 'Code: letters, digits and dashes (max 16)')

export interface TerminalRow { id: number; uuid: string; code: string; name: string; isLocal: boolean; active: boolean }
export interface LocationRow { id: number; uuid: string; name: string; isDefault: boolean; active: boolean; stockQty: number }

export class SettingsService {
  constructor(private app: App) {}

  // ---------- settings ----------
  /** Secrets are never sent to anyone but the owner, and even then only as a mask (the value stays in the DB). */
  getAll(): { values: Record<string, string>; defs: SettingDef[] } {
    const owner = !!this.app.session?.permissions.includes('*')
    const defs = settingDefs().filter((d) => owner || !isSecretKey(d.key))
    const values: Record<string, string> = {}
    for (const d of defs) {
      const v = this.app.setting(d.key, d.default)
      values[d.key] = isSecretKey(d.key) ? (v ? MASK : '') : v
    }
    return { values, defs }
  }

  set(args: unknown): { key: string; value: string } {
    this.app.requirePermission('settings.edit')
    const { key, value } = parseInput(z.object({ key: z.string().min(1), value: z.union([z.string(), z.number(), z.boolean()]) }), args)
    if (isSecretKey(key) && value === MASK) return { key, value: MASK } // unchanged mask echoed back by the UI
    return this.setOne(key, value)
  }

  setMany(args: unknown): Record<string, string> {
    this.app.requirePermission('settings.edit')
    const { values } = parseInput(z.object({ values: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])) }), args)
    return this.app.db.transaction(() => {
      const out: Record<string, string> = {}
      for (const [k, v] of Object.entries(values)) out[k] = this.setOne(k, v).value
      return out
    })
  }

  private setOne(key: string, raw: string | number | boolean): { key: string; value: string } {
    if (!settingDef(key)) throw new AppError('VALIDATION', `Unknown setting "${key}"`)
    let value: string
    try {
      value = validateSetting(key, raw)
    } catch (e) {
      if (e instanceof AppError) throw e
      const msg = (e as { issues?: { message: string }[] }).issues?.[0]?.message ?? (e as Error).message
      throw new AppError('VALIDATION', `${settingDef(key)!.label}: ${msg}`)
    }
    const old = this.app.setting(key, settingDef(key)!.default)
    if (old === value) return { key, value }
    this.app.db.transaction(() => {
      this.app.setSetting(key, value)
      this.app.audit({ entity: 'setting', entityId: key, action: 'setting.update', old, new: value })
    })
    return { key, value }
  }

  // ---------- terminals ----------
  listTerminals(): TerminalRow[] {
    this.app.requireSession()
    return this.app.db
      .all<{ id: number; uuid: string; code: string; name: string; is_local: number; active: number }>('SELECT id,uuid,code,name,is_local,active FROM pos_terminals ORDER BY is_local DESC, code')
      .map((r) => ({ id: r.id, uuid: r.uuid, code: r.code, name: r.name, isLocal: !!r.is_local, active: !!r.active }))
  }

  /** Register another terminal's identity (multi-POS). The local terminal is created by first-run setup. */
  addTerminal(args: unknown): TerminalRow {
    this.app.requirePermission('settings.edit')
    const { code, name } = parseInput(z.object({ code: posCode, name: posName }), args)
    return this.app.db.transaction(() => {
      this.assertCodeFree(code)
      const r = this.app.db.run('INSERT INTO pos_terminals(uuid,code,name,is_local,updated_at) VALUES (?,?,?,0,?)', this.app.uuid(), code, name, Date.now())
      this.app.audit({ entity: 'pos_terminal', entityId: r.lastId, action: 'terminal.add', new: { code, name } })
      return this.terminal(r.lastId)
    })
  }

  updateTerminal(args: unknown): TerminalRow {
    this.app.requirePermission('settings.edit')
    const a = parseInput(id.extend({ code: posCode.optional(), name: posName.optional(), active: z.boolean().optional() }), args)
    return this.app.db.transaction(() => {
      const old = this.terminal(a.id)
      if (a.code && a.code !== old.code) this.assertCodeFree(a.code, a.id)
      if (a.active === false && old.isLocal) throw new AppError('CONFLICT', 'The terminal this computer uses cannot be deactivated')
      const next = { code: a.code ?? old.code, name: a.name ?? old.name, active: a.active ?? old.active }
      this.app.db.run('UPDATE pos_terminals SET code=?, name=?, active=?, updated_at=? WHERE id=?', next.code, next.name, next.active ? 1 : 0, Date.now(), a.id)
      this.app.audit({ entity: 'pos_terminal', entityId: a.id, action: 'terminal.update', old: { code: old.code, name: old.name, active: old.active }, new: next })
      const row = this.terminal(a.id)
      if (this.app.session && row.isLocal) this.app.session = { ...this.app.session, posCode: row.code }
      return row
    })
  }

  private terminal(tid: number): TerminalRow {
    const r = this.listTerminals().find((t) => t.id === tid)
    if (!r) throw new AppError('NOT_FOUND', 'Terminal not found')
    return r
  }
  private assertCodeFree(code: string, exceptId = 0): void {
    if (this.app.db.value<number>('SELECT 1 FROM pos_terminals WHERE code = ? AND id <> ?', code, exceptId))
      throw new AppError('CONFLICT', `POS code ${code} is already used`)
  }

  // ---------- locations ----------
  listLocations(): LocationRow[] {
    this.app.requireSession()
    return this.app.db
      .all<{ id: number; uuid: string; name: string; is_default: number; active: number; q: number }>(
        `SELECT l.id,l.uuid,l.name,l.is_default,l.active,COALESCE((SELECT SUM(qty) FROM stock_levels s WHERE s.location_id=l.id),0) q
         FROM locations l ORDER BY l.is_default DESC, l.name COLLATE NOCASE`
      )
      .map((r) => ({ id: r.id, uuid: r.uuid, name: r.name, isDefault: !!r.is_default, active: !!r.active, stockQty: r.q }))
  }

  addLocation(args: unknown): LocationRow {
    this.app.requirePermission('settings.edit')
    const { name } = parseInput(z.object({ name: locName }), args)
    return this.app.db.transaction(() => {
      this.assertLocName(name)
      const r = this.app.db.run('INSERT INTO locations(uuid,name,is_default,active,updated_at) VALUES (?,?,0,1,?)', this.app.uuid(), name, Date.now())
      this.app.enqueueSnapshot('locations', r.lastId)
      this.app.audit({ entity: 'location', entityId: r.lastId, action: 'location.add', new: { name } })
      return this.location(r.lastId)
    })
  }

  renameLocation(args: unknown): LocationRow {
    this.app.requirePermission('settings.edit')
    const { id: lid, name } = parseInput(id.extend({ name: locName }), args)
    return this.app.db.transaction(() => {
      const old = this.location(lid)
      this.assertLocName(name, lid)
      this.app.db.run('UPDATE locations SET name=?, updated_at=? WHERE id=?', name, Date.now(), lid)
      this.app.enqueueSnapshot('locations', lid)
      this.app.audit({ entity: 'location', entityId: lid, action: 'location.rename', old: { name: old.name }, new: { name } })
      return this.location(lid)
    })
  }

  setDefaultLocation(args: unknown): LocationRow {
    this.app.requirePermission('settings.edit')
    const { id: lid } = parseInput(id, args)
    return this.app.db.transaction(() => {
      const loc = this.location(lid)
      if (!loc.active) throw new AppError('CONFLICT', 'Activate the location before making it the default')
      const now = Date.now()
      this.app.db.run('UPDATE locations SET is_default=0, updated_at=? WHERE is_default=1 AND id<>?', now, lid)
      this.app.db.run('UPDATE locations SET is_default=1, updated_at=? WHERE id=?', now, lid)
      for (const l of this.app.db.all<{ id: number }>('SELECT id FROM locations WHERE updated_at=?', now)) this.app.enqueueSnapshot('locations', l.id)
      this.app.audit({ entity: 'location', entityId: lid, action: 'location.set_default', new: { name: loc.name } })
      return this.location(lid)
    })
  }

  setLocationActive(args: unknown): LocationRow {
    this.app.requirePermission('settings.edit')
    const { id: lid, active } = parseInput(id.extend({ active: z.boolean() }), args)
    return this.app.db.transaction(() => {
      const loc = this.location(lid)
      if (!active) {
        if (loc.isDefault) throw new AppError('CONFLICT', 'Make another location the default before deactivating this one')
        if (loc.stockQty !== 0) throw new AppError('CONFLICT', `Location still holds ${loc.stockQty} units; transfer or adjust stock first`)
      }
      this.app.db.run('UPDATE locations SET active=?, updated_at=? WHERE id=?', active ? 1 : 0, Date.now(), lid)
      this.app.enqueueSnapshot('locations', lid)
      this.app.audit({ entity: 'location', entityId: lid, action: active ? 'location.activate' : 'location.deactivate', new: { name: loc.name } })
      return this.location(lid)
    })
  }

  private location(lid: number): LocationRow {
    const r = this.listLocations().find((l) => l.id === lid)
    if (!r) throw new AppError('NOT_FOUND', 'Location not found')
    return r
  }
  private assertLocName(name: string, exceptId = 0): void {
    if (this.app.db.value<number>('SELECT 1 FROM locations WHERE name = ? COLLATE NOCASE AND id <> ?', name, exceptId))
      throw new AppError('CONFLICT', `A location named "${name}" already exists`)
  }

  // ---------- database health ----------
  integrityCheck(): {
    ok: boolean
    integrity: string[]
    foreignKeyViolations: { table: string; rowid: number; parent: string }[]
    stockMismatches: { variantId: number; locationId: number; level: number; ledger: number }[]
  } {
    this.app.requirePermission('settings.edit')
    const db = this.app.db
    const integrity = db.all<{ integrity_check: string }>('PRAGMA integrity_check').map((r) => r.integrity_check)
    const foreignKeyViolations = db
      .all<{ table: string; rowid: number; parent: string }>('PRAGMA foreign_key_check')
      .map((r) => ({ table: r.table, rowid: r.rowid, parent: r.parent }))
    const stockMismatches = db
      .all<{ variant_id: number; location_id: number; level: number; ledger: number }>(
        `SELECT v.variant_id, v.location_id, v.level, v.ledger FROM (
           SELECT COALESCE(s.variant_id,m.variant_id) variant_id, COALESCE(s.location_id,m.location_id) location_id,
                  COALESCE(s.qty,0) level, COALESCE(m.q,0) ledger
           FROM stock_levels s
           LEFT JOIN (SELECT variant_id, location_id, SUM(qty_delta) q FROM stock_movements GROUP BY variant_id, location_id) m
             ON m.variant_id=s.variant_id AND m.location_id=s.location_id
           UNION
           SELECT m.variant_id, m.location_id, COALESCE(s.qty,0), m.q
           FROM (SELECT variant_id, location_id, SUM(qty_delta) q FROM stock_movements GROUP BY variant_id, location_id) m
           LEFT JOIN stock_levels s ON s.variant_id=m.variant_id AND s.location_id=m.location_id
         ) v WHERE v.level <> v.ledger LIMIT 200`
      )
      .map((r) => ({ variantId: r.variant_id, locationId: r.location_id, level: r.level, ledger: r.ledger }))
    return {
      ok: integrity.length === 1 && integrity[0] === 'ok' && foreignKeyViolations.length === 0 && stockMismatches.length === 0,
      integrity,
      foreignKeyViolations,
      stockMismatches
    }
  }

  dbStats(): {
    path: string
    sizeBytes: number
    walMode: string
    schemaVersion: number
    migrations: number
    tables: { name: string; rows: number }[]
  } {
    this.app.requirePermission('settings.edit')
    const db = this.app.db
    const names = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((r) => r.name)
    const tables = names.map((name) => ({ name, rows: db.value<number>(`SELECT COUNT(*) FROM "${name}"`) ?? 0 }))
    const pages = db.value<number>('PRAGMA page_count') ?? 0
    const pageSize = db.value<number>('PRAGMA page_size') ?? 0
    return {
      path: db.path,
      sizeBytes: pages * pageSize,
      walMode: String(db.value<string>('PRAGMA journal_mode') ?? ''),
      schemaVersion: db.value<number>('SELECT MAX(version) FROM schema_migrations') ?? 0,
      migrations: db.value<number>('SELECT COUNT(*) FROM schema_migrations') ?? 0,
      tables
    }
  }
}

import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { z } from 'zod'
import { DatabaseSync } from 'node:sqlite'
import type { App } from '../../core/app'
import { AppError } from '@shared/ipc'
import { allMigrations, runMigrations } from '../../db/migrate'
import {
  BACKUP_EXT, describeFile, finalizeSnapshotFile, manifestPathFor, quoteIdent, readManifest, removeQuiet, sha256File,
  tableNames, verifyBackupFile, writeJsonAtomic, type Manifest, type VerifyResult
} from './engine'
import { runSnapshotInWorker } from './snapshotWorker'

export type BackupKind = 'manual' | 'auto' | 'safety' | 'close'

export interface BackupRow {
  id: number
  path: string
  sizeBytes: number
  sha256: string
  kind: string
  verified: boolean
  verifiedAt: number | null
  createdAt: number
  schemaVersion: number | null
  exists: boolean
  note: string | null
}

export interface BackupSettings {
  autoEnabled: boolean
  intervalHours: number
  retention: number
  folder: string
  copyFolder: string
  onClose: boolean
}

export interface CreateResult {
  id: number
  path: string
  manifest: Manifest
  verified: boolean
  problems: string[]
  copiedTo?: string
  warnings: string[]
}

export interface RestoreResult {
  restoredFrom: string
  safetyBackupId: number
  safetyBackupPath: string
  tablesReplaced: number
  reloginRequired: boolean
  migrationsRun: number[]
}

const parse = <T extends z.ZodType>(schema: T, args: unknown): z.infer<T> => {
  const r = schema.safeParse(args ?? {})
  if (!r.success) throw new AppError('VALIDATION', r.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; '))
  return r.data
}

const stamp = (t: number): string => new Date(t).toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-')
const appVersion = (): string => process.env.VELMAYIL_VERSION ?? process.env.npm_package_version ?? '1.0.11'

/** Tables whose live content is kept as-is during restore (history of the backups themselves, schema bookkeeping). */
const KEEP_ON_RESTORE = new Set(['backups', 'schema_migrations'])

export class BackupService {
  private busy = false
  private timer: NodeJS.Timeout | undefined
  private startupTimer: NodeJS.Timeout | undefined
  private closed = false
  /** Test hook: throw while replacing this table (proves the restore transaction rolls back). */
  failAtTable: string | undefined

  constructor(private app: App) {}

  // ---------------- settings ----------------
  getSettings(): BackupSettings {
    const a = this.app
    return {
      autoEnabled: a.setting('backup.auto_enabled', '1') === '1',
      intervalHours: Math.max(1, Number(a.setting('backup.interval_hours', '24')) || 24),
      retention: Math.max(1, Number(a.setting('backup.retention', '14')) || 14),
      folder: a.setting('backup.folder', '') || this.defaultFolder(),
      copyFolder: a.setting('backup.copy_folder', ''),
      onClose: a.setting('backup.on_close', '0') === '1'
    }
  }
  defaultFolder(): string {
    return join(this.app.userDataDir, 'backups')
  }
  saveSettings(input: unknown): BackupSettings {
    const s = parse(
      z.object({
        autoEnabled: z.boolean().optional(),
        intervalHours: z.number({ message: 'Back up every (hours): enter a whole number' }).int('Back up every (hours): enter a whole number').min(1, 'Back up every (hours) must be at least 1').max(24 * 30, 'Back up every (hours) can be at most 720').optional(),
        retention: z.number({ message: 'Backups to keep: enter a whole number' }).int('Backups to keep: enter a whole number').min(1, 'Keep at least 1 automatic backup').max(365, 'At most 365 automatic backups can be kept').optional(),
        folder: z.string().max(500).optional(),
        copyFolder: z.string().max(500).optional(),
        onClose: z.boolean().optional()
      }),
      input
    )
    for (const [label, v] of [['Backup folder', s.folder], ['Second copy folder', s.copyFolder]] as const) {
      if (v !== undefined && v.trim() && !isAbsolute(v.trim())) throw new AppError('VALIDATION', `${label}: enter the full path, for example D:\\Backups`)
    }
    if (s.folder?.trim()) this.ensureFolder(resolve(s.folder.trim()))
    const before = this.getSettings()
    this.app.db.transaction(() => {
      if (s.autoEnabled !== undefined) this.app.setSetting('backup.auto_enabled', s.autoEnabled ? '1' : '0')
      if (s.intervalHours !== undefined) this.app.setSetting('backup.interval_hours', String(s.intervalHours))
      if (s.retention !== undefined) this.app.setSetting('backup.retention', String(s.retention))
      if (s.folder !== undefined) this.app.setSetting('backup.folder', s.folder.trim())
      if (s.copyFolder !== undefined) this.app.setSetting('backup.copy_folder', s.copyFolder.trim())
      if (s.onClose !== undefined) this.app.setSetting('backup.on_close', s.onClose ? '1' : '0')
      this.app.audit({ entity: 'backup_settings', action: 'update', old: before, new: this.getSettings() })
    })
    return this.getSettings()
  }

  // ---------------- create ----------------
  /** Consistent snapshot of the live DB (VACUUM INTO — never a raw copy of a WAL database), verified by re-opening it. */
  create(opts: { kind?: BackupKind; folder?: string; copyFolder?: string; note?: string; now?: number } = {}): CreateResult {
    const kind = opts.kind ?? 'manual'
    if (this.busy) throw new AppError('CONFLICT', 'Another backup or restore is already running')
    this.busy = true
    try {
      return this.createLocked(kind, opts)
    } finally {
      this.busy = false
    }
  }

  /**
   * Same result as create(), but the heavy file work (VACUUM INTO, hashing, verification, second copy) runs in a worker
   * thread so IPC keeps flowing (the synchronous version froze the whole app for 6-8 s on an 80 MB database). Only the
   * small bookkeeping INSERT runs on the main thread. Falls back to create() for in-memory databases (tests).
   */
  async createAsync(opts: { kind?: BackupKind; folder?: string; copyFolder?: string; note?: string; now?: number } = {}): Promise<CreateResult> {
    if (this.app.db.path === ':memory:') return this.create(opts)
    const kind = opts.kind ?? 'manual'
    if (this.busy) throw new AppError('CONFLICT', 'Another backup or restore is already running')
    this.busy = true
    try {
      const plan = this.plan(kind, opts)
      let out
      try {
        out = await runSnapshotInWorker({
          dbPath: this.app.db.path, partial: plan.partial, final: plan.final, manifestPath: manifestPathFor(plan.final),
          copyFolder: plan.copyFolder, kind, pos: plan.pos, appVersion: appVersion(), now: plan.now
        })
      } catch (e) {
        removeQuiet(plan.partial)
        throw e
      }
      return this.record(kind, opts.note, plan.final, out.manifest, { ok: out.ok, problems: out.problems }, out.copiedTo, out.warnings)
    } finally {
      this.busy = false
    }
  }

  /** Decide where a backup goes (creates the folder, no other file IO). */
  private plan(kind: BackupKind, opts: { folder?: string; copyFolder?: string; now?: number }) {
    const s = this.getSettings()
    const folder = resolve(opts.folder ?? s.folder)
    const copyFolder = opts.copyFolder ?? s.copyFolder
    this.ensureFolder(folder)
    const now = opts.now ?? Date.now()
    const pos = this.app.db.value<string>('SELECT code FROM pos_terminals WHERE is_local = 1') ?? 'POS'
    let final = join(folder, `velmayil-${pos}-${stamp(now)}-${kind}${BACKUP_EXT}`)
    for (let i = 2; existsSync(final) || existsSync(final + '.partial'); i++) final = join(folder, `velmayil-${pos}-${stamp(now)}-${kind}-${i}${BACKUP_EXT}`)
    return { copyFolder, now, pos, final, partial: final + '.partial' }
  }

  /** Create the backup folder; a drive that is not connected / a read-only place is explained in plain words. */
  private ensureFolder(folder: string): void {
    try {
      mkdirSync(folder, { recursive: true })
    } catch (e) {
      const why = (e as NodeJS.ErrnoException).code ?? (e as Error).message
      throw new AppError('VALIDATION', `The backup folder "${folder}" cannot be used (${why}). Connect that drive, or choose another folder under Backup > Schedule & locations.`)
    }
  }

  /** Insert the backups row + audit entry (one small transaction) and shape the result. */
  private record(
    kind: BackupKind, note: string | undefined, final: string, manifest: Manifest, v: { ok: boolean; problems: string[] },
    copiedTo: string | undefined, warnings: string[]
  ): CreateResult {
    if (!v.ok) warnings.push('Verification failed: ' + v.problems.join('; '))
    const id = this.app.db.transaction(() => {
      const r = this.app.db.run(
        `INSERT INTO backups(path,size_bytes,sha256,kind,verified,created_at,schema_version,manifest_json,verified_at,note) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        final, manifest.sizeBytes, manifest.sha256, kind, v.ok ? 1 : 0, manifest.createdAt, manifest.schemaVersion, JSON.stringify(manifest), v.ok ? Date.now() : null, note ?? null
      )
      this.app.audit({ entity: 'backup', entityId: r.lastId, action: 'create', new: { path: final, kind, verified: v.ok, sizeBytes: manifest.sizeBytes, copiedTo }, note })
      return r.lastId
    })
    if (!v.ok) throw new AppError('INTERNAL', 'Backup was written but failed verification: ' + v.problems.join('; '), { id })
    return { id, path: final, manifest, verified: v.ok, problems: v.problems, copiedTo, warnings }
  }

  private createLocked(kind: BackupKind, opts: { folder?: string; copyFolder?: string; note?: string; now?: number }): CreateResult {
    const { copyFolder, now, pos, final, partial } = this.plan(kind, opts)
    try {
      this.app.db.run('VACUUM INTO ?', partial)
      finalizeSnapshotFile(partial)
      const info = describeFile(partial)
      const manifest: Manifest = {
        format: 1,
        app: 'velmayil-pos',
        appVersion: appVersion(),
        createdAt: now,
        kind,
        posCode: pos,
        schemaVersion: info.schemaVersion,
        schemaCount: info.schemaCount,
        sizeBytes: statSync(partial).size,
        sha256: sha256File(partial),
        tables: info.tables
      }
      renameSync(partial, final)
      writeJsonAtomic(manifestPathFor(final), manifest)
      const v = verifyBackupFile(final, manifest)
      const warnings: string[] = []
      let copiedTo: string | undefined
      if (copyFolder) {
        try {
          mkdirSync(copyFolder, { recursive: true })
          const dest = join(copyFolder, basename(final))
          copyFileSync(final, dest)
          copyFileSync(manifestPathFor(final), manifestPathFor(dest))
          if (sha256File(dest) !== manifest.sha256) throw new Error('copy hash mismatch')
          copiedTo = dest
        } catch (e) {
          warnings.push(`Second copy to "${copyFolder}" failed: ${(e as Error).message}`)
        }
      }
      return this.record(kind, opts.note, final, manifest, v, copiedTo, warnings)
    } catch (e) {
      removeQuiet(partial)
      throw e
    }
  }

  // ---------------- verify ----------------
  verify(opts: { id?: number; path?: string }): VerifyResult & { path: string } {
    const row = opts.id != null ? this.rowOrThrow(opts.id) : undefined
    const path = row?.path ?? opts.path
    if (!path) throw new AppError('VALIDATION', 'id or path required')
    const res = verifyBackupFile(path)
    if (row) {
      this.app.db.run('UPDATE backups SET verified = ?, verified_at = ? WHERE id = ?', res.ok ? 1 : 0, Date.now(), row.id)
    }
    this.app.audit({ entity: 'backup', entityId: row?.id ?? path, action: 'verify', new: { ok: res.ok, problems: res.problems } })
    return { ...res, path }
  }

  // ---------------- list / delete / retention ----------------
  list(): BackupRow[] {
    return this.app.db
      .all<{ id: number; path: string; size_bytes: number; sha256: string; kind: string; verified: number; verified_at: number | null; created_at: number; schema_version: number | null; note: string | null }>(
        'SELECT * FROM backups ORDER BY created_at DESC, id DESC'
      )
      .map((r) => ({
        id: r.id, path: r.path, sizeBytes: r.size_bytes, sha256: r.sha256, kind: r.kind, verified: !!r.verified, verifiedAt: r.verified_at,
        createdAt: r.created_at, schemaVersion: r.schema_version, exists: existsSync(r.path), note: r.note
      }))
  }

  /** .vbak files in the backup folder that this database does not know about (e.g. after a re-install). */
  untracked(): { path: string; manifest?: Manifest }[] {
    const folder = this.getSettings().folder
    if (!existsSync(folder)) return []
    const known = new Set(this.list().map((r) => resolve(r.path)))
    return readdirSync(folder)
      .filter((f) => f.endsWith(BACKUP_EXT))
      .map((f) => join(folder, f))
      .filter((p) => !known.has(resolve(p)))
      .map((p) => ({ path: p, manifest: readManifest(p) }))
  }

  /** Remove a backup. The newest backup (and the only verified one) cannot be deleted. */
  delete(id: number): void {
    const row = this.rowOrThrow(id)
    const all = this.list()
    if (all[0]?.id === id) throw new AppError('CONFLICT', 'The most recent backup cannot be deleted')
    const verified = all.filter((b) => b.verified && b.exists)
    if (row.verified && verified.length <= 1) throw new AppError('CONFLICT', 'This is the only verified backup; keep it')
    this.removeFiles(row.path)
    this.app.db.transaction(() => {
      this.app.db.run('DELETE FROM backups WHERE id = ?', id)
      this.app.audit({ entity: 'backup', entityId: id, action: 'delete', old: { path: row.path, kind: row.kind } })
    })
  }

  /** Keep the newest N automatic backups (manual / safety backups are never pruned automatically). */
  applyRetention(keep = this.getSettings().retention): number {
    const autos = this.app.db.all<{ id: number; path: string }>("SELECT id, path FROM backups WHERE kind IN ('auto','close') ORDER BY created_at DESC, id DESC")
    const doomed = autos.slice(keep)
    for (const b of doomed) {
      this.removeFiles(b.path)
      this.app.db.run('DELETE FROM backups WHERE id = ?', b.id)
    }
    if (doomed.length) this.app.audit({ entity: 'backup', action: 'retention', new: { removed: doomed.length, keep } })
    return doomed.length
  }

  private removeFiles(path: string): void {
    removeQuiet(path)
    removeQuiet(manifestPathFor(path))
    const cf = this.getSettings().copyFolder
    if (cf) {
      removeQuiet(join(cf, basename(path)))
      removeQuiet(manifestPathFor(join(cf, basename(path))))
    }
  }

  private rowOrThrow(id: number): BackupRow {
    const r = this.list().find((b) => b.id === id)
    if (!r) throw new AppError('NOT_FOUND', `Backup #${id} not found`)
    return r
  }

  // ---------------- scheduling ----------------
  lastSuccessAt(): number | undefined {
    return this.app.db.value<number>("SELECT MAX(created_at) FROM backups WHERE kind IN ('auto','manual','close') AND verified = 1") ?? undefined
  }
  isDue(now = Date.now()): boolean {
    const s = this.getSettings()
    if (!s.autoEnabled) return false
    const last = this.lastSuccessAt()
    return last == null || now - last >= s.intervalHours * 3600_000
  }
  /** Run an automatic backup if one is overdue. Never throws (records the error in settings + audit). */
  runIfDue(now = Date.now()): CreateResult | undefined {
    if (this.closed || !this.isDue(now)) return undefined
    try {
      const r = this.create({ kind: 'auto', now })
      this.app.setSetting('backup.last_error', '')
      this.applyRetention()
      return r
    } catch (e) {
      try {
        this.app.setSetting('backup.last_error', (e as Error).message)
        this.app.audit({ entity: 'backup', action: 'auto_failed', note: (e as Error).message })
      } catch {
        /* db may be closing */
      }
      return undefined
    }
  }
  /** Scheduler flavour of runIfDue(): the backup itself runs in a worker thread, so the UI never freezes. Never rejects. */
  async runIfDueAsync(now = Date.now()): Promise<CreateResult | undefined> {
    if (this.closed || this.busy || !this.isDue(now)) return undefined
    try {
      const r = await this.createAsync({ kind: 'auto', now })
      this.app.setSetting('backup.last_error', '')
      this.applyRetention()
      return r
    } catch (e) {
      try {
        this.app.setSetting('backup.last_error', (e as Error).message)
        this.app.audit({ entity: 'backup', action: 'auto_failed', note: (e as Error).message })
      } catch {
        /* db may be closing */
      }
      return undefined
    }
  }
  start(checkEveryMs = 15 * 60_000, startupDelayMs = 10_000): void {
    this.stop()
    this.closed = false
    this.startupTimer = setTimeout(() => void this.runIfDueAsync(), startupDelayMs)
    this.startupTimer.unref?.()
    this.timer = setInterval(() => void this.runIfDueAsync(), checkEveryMs)
    this.timer.unref?.()
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer)
    if (this.startupTimer) clearTimeout(this.startupTimer)
    this.timer = this.startupTimer = undefined
  }
  /** Called right before the database is closed. */
  onClosing(): void {
    this.closed = true
    this.stop()
    if (this.getSettings().onClose) {
      try {
        this.closed = false
        this.create({ kind: 'close' })
        this.applyRetention()
      } catch {
        /* never block app exit */
      }
      this.closed = true
    }
  }

  // ---------------- restore ----------------
  /**
   * Replace the live data with a backup, in ONE transaction (ATTACH + table-by-table replace), so the App keeps its open
   * connection. Steps: validate (manifest, sha256, integrity, FK, counts) on a private copy -> refuse newer schema ->
   * safety backup of the current DB -> swap -> foreign_key_check -> commit (any failure rolls everything back).
   */
  restore(opts: { id?: number; path?: string }): RestoreResult {
    if (this.busy) throw new AppError('CONFLICT', 'Another backup or restore is already running')
    const src = opts.id != null ? this.rowOrThrow(opts.id).path : opts.path
    if (!src) throw new AppError('VALIDATION', 'id or path required')
    if (!existsSync(src)) throw new AppError('NOT_FOUND', 'Backup file not found: ' + src)
    const manifest = readManifest(src)
    if (!manifest) throw new AppError('VALIDATION', 'Backup manifest is missing or unreadable; refusing to restore')

    // private working copy: protects against the file changing between verification and use
    const work = join(this.app.userDataDir, `restore-${Date.now()}.work`)
    mkdirSync(dirname(work), { recursive: true })
    copyFileSync(src, work)
    this.busy = true
    let attached = false
    try {
      const v = verifyBackupFile(work, manifest)
      if (!v.ok) {
        this.app.audit({ entity: 'backup', action: 'restore_refused', new: { src, problems: v.problems } })
        throw new AppError('VALIDATION', 'Backup failed verification and was NOT restored: ' + v.problems.join('; '), v.problems)
      }
      const appMax = Math.max(...allMigrations().map((m) => m.version))
      if ((v.schemaVersion ?? 0) > appMax) {
        this.app.audit({ entity: 'backup', action: 'restore_refused', new: { src, schemaVersion: v.schemaVersion, appMax } })
        throw new AppError('VALIDATION', `This backup was made by a newer version of the app (schema ${v.schemaVersion} > ${appMax}). Update the app first.`)
      }

      this.busy = false // allow the nested safety backup
      let safety: CreateResult
      try {
        safety = this.create({ kind: 'safety', note: 'Automatic safety backup before restore' })
      } finally {
        this.busy = true
      }

      const db = this.app.db
      db.run('ATTACH DATABASE ? AS bk', work)
      attached = true
      db.exec('PRAGMA foreign_keys = OFF')
      let replaced = 0
      try {
        db.transaction(() => {
          const triggers = db.all<{ name: string; sql: string }>("SELECT name, sql FROM main.sqlite_master WHERE type='trigger' AND sql IS NOT NULL")
          for (const t of triggers) db.exec(`DROP TRIGGER ${quoteIdent(t.name)}`) // append-only guards would block the replace
          const bkTables = new Set(tableNames(db.raw, 'bk'))
          for (const t of tableNames(db.raw, 'main')) {
            if (KEEP_ON_RESTORE.has(t)) continue
            db.exec(`DELETE FROM main.${quoteIdent(t)}`)
            if (bkTables.has(t)) {
              const live = db.all<{ name: string }>(`PRAGMA main.table_info(${quoteIdent(t)})`).map((c) => c.name)
              const bkc = new Set(db.all<{ name: string }>(`PRAGMA bk.table_info(${quoteIdent(t)})`).map((c) => c.name))
              const cols = live.filter((c) => bkc.has(c)).map(quoteIdent).join(',')
              if (cols) db.exec(`INSERT INTO main.${quoteIdent(t)}(${cols}) SELECT ${cols} FROM bk.${quoteIdent(t)}`)
            }
            replaced++
            if (this.failAtTable === t) throw new Error(`Injected failure at ${t}`)
          }
          // AUTOINCREMENT counters
          db.exec(`DELETE FROM main.sqlite_sequence WHERE name <> 'backups'`)
          if (bkTables.has('sqlite_sequence') || db.get(`SELECT 1 FROM bk.sqlite_master WHERE name='sqlite_sequence'`)) {
            db.exec(`INSERT OR REPLACE INTO main.sqlite_sequence(name,seq) SELECT name,seq FROM bk.sqlite_sequence WHERE name <> 'backups' AND name IN (SELECT name FROM main.sqlite_master WHERE type='table')`)
          }
          for (const t of triggers) db.exec(t.sql)
          const bad = db.all('PRAGMA main.foreign_key_check')
          if (bad.length) throw new Error(`Restored data has ${bad.length} foreign key violation(s)`)
          db.run(
            "INSERT INTO audit_log(user_id,user_name,entity,entity_id,action,new_json,note) VALUES (?,?,'backup',?,'restore',?,?)",
            this.app.session?.userId ?? null, this.app.session?.name ?? null, basename(src), JSON.stringify({ src, manifest, safetyBackup: safety.path }), 'Database restored from backup'
          )
        })
      } finally {
        db.exec('PRAGMA foreign_keys = ON')
      }
      db.exec('DETACH DATABASE bk')
      attached = false

      const migrationsRun = runMigrations(db)
      let relogin = false
      const sess = this.app.session
      if (sess && !db.get('SELECT 1 FROM users WHERE id = ? AND username = ? AND active = 1', sess.userId, sess.username)) {
        this.app.session = null
        relogin = true
      } else if (sess && this.app.has('auth')) {
        // the restored database may give this user's role other permissions (or another name): use those from now on
        try {
          this.app.get<{ refreshSession(): void }>('auth').refreshSession()
        } catch {
          this.app.session = null
          relogin = true
        }
      }
      return { restoredFrom: src, safetyBackupId: safety.id, safetyBackupPath: safety.path, tablesReplaced: replaced, reloginRequired: relogin, migrationsRun }
    } finally {
      if (attached) {
        try {
          this.app.db.exec('DETACH DATABASE bk')
        } catch {
          /* ignore */
        }
      }
      this.busy = false
      removeQuiet(work)
    }
  }
}

/** Open a backup read-only for ad-hoc inspection (tests / tools). */
export function openBackup(path: string): DatabaseSync {
  return new DatabaseSync(path, { readOnly: true })
}

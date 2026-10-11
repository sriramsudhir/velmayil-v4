import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { App } from '../../core/app'
import { ensureDefaultSettings } from '../../core/settings'
import { Db } from '../../db/driver'
import { allMigrations, runMigrations } from '../../db/migrate'
import { AppError } from '@shared/ipc'
import {
  describeFile, manifestPathFor, quoteIdent, removeQuiet, schemaInfo, sha256File, tableCounts, writeJsonAtomic, type Manifest
} from '../backup/engine'
import { appVersion, type BackupService } from '../backup/service'
import { runSnapshotInWorker } from '../backup/snapshotWorker'
import { checkPayload, readHeader, TransferFileError, TRANSFER_EXT, writeContainer, type Summary, type TransferHeader } from './container'
import {
  localizeForTarget, readTargetState, scrubMachineData, summarize, SUMMARY_FIELDS, TARGET_OWNED_TABLES, type LocalizeResult
} from './localize'

export interface SummaryRow {
  key: string
  label: string
  inFile: number
  /** after an import: the value in this laptop's database */
  now?: number
  ok?: boolean
}

export interface TargetInfo {
  setupComplete: boolean
  shopName: string
  terminal: { uuid: string; code: string; name: string } | null
  products: number
  sales: number
  users: number
}

export interface ExportResult {
  cancelled?: boolean
  path?: string
  sizeBytes?: number
  sha256?: string
  createdAt?: number
  summary?: SummaryRow[]
}

export interface InspectResult {
  ok: boolean
  /** why the file cannot be imported (plain words); empty when ok */
  problems: string[]
  path: string
  file?: {
    sizeBytes: number
    createdAt: number
    appVersion: string
    schemaVersion: number
    source: TransferHeader['source']
    summary: SummaryRow[]
    /** made by an older version: it is brought up to date during the import */
    olderVersion: boolean
  }
  target: TargetInfo
  /** the file was exported by a terminal with the same identity as this laptop */
  sameDevice: boolean
}

export interface ImportResult {
  importedFrom: string
  source: TransferHeader['source']
  terminal: { uuid: string; code: string; name: string }
  identityCreated: boolean
  codeChangedFrom: string | null
  safetyBackupPath: string
  /** schema updates applied to the file's data before it was imported */
  migrationsRun: number[]
  summary: SummaryRow[]
  /** true when every number in `summary` matches */
  verified: boolean
  /** Windows printer names the copied printer profiles point to (check them on this laptop) */
  printers: string[]
  reloginRequired: true
}

const stamp = (t: number): string => {
  const d = new Date(t)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}

const rows = (file: Summary, now?: Summary): SummaryRow[] =>
  SUMMARY_FIELDS.map(([key, label]) => ({
    key, label, inFile: file[key] ?? 0,
    ...(now ? { now: now[key] ?? 0, ok: (now[key] ?? 0) === (file[key] ?? 0) } : {})
  }))

/** Open a private working copy read-write; closeWork() leaves it as one self-contained file again. */
const closeWork = (db: Db): void => {
  try {
    db.exec('PRAGMA journal_mode = DELETE')
  } finally {
    db.close()
  }
}

/**
 * "Export everything" / "Import everything": make a second laptop the same as this one.
 *
 * The file is a whole-database snapshot (see container.ts), so nothing depends on a list of tables or columns. The
 * import prepares a private copy of that snapshot (schema brought up to date, machine-specific data replaced by this
 * laptop's own: see localize.ts) and then hands it to BackupService.restore(), which already does the safe part:
 * verification, automatic safety backup, ONE transaction for the whole replacement and a full rollback on any error.
 */
export class TransferService {
  private busy = false
  /** Test hook: runs inside the import transaction after the data was replaced (throwing proves the rollback). */
  failBeforeCommit: (() => void) | undefined

  constructor(private app: App) {}

  private backup(): BackupService {
    return this.app.get<BackupService>('backup')
  }
  private tmpDir(): string {
    const d = join(this.app.userDataDir, 'transfer-tmp')
    mkdirSync(d, { recursive: true })
    // leftovers of an interrupted run
    for (const f of readdirSync(d)) {
      try {
        if (Date.now() - statSync(join(d, f)).mtimeMs > 3600_000) removeQuiet(join(d, f))
      } catch {
        /* ignore */
      }
    }
    return d
  }
  defaultFolder(): string {
    return join(this.app.userDataDir, 'transfer')
  }

  /** First-time setup was done on this laptop (there is at least one user). */
  setupComplete(): boolean {
    const db = this.app.db
    return db.value<string>("SELECT value FROM settings WHERE key = 'setup.complete'") === '1' || !!db.value<number>('SELECT 1 FROM users LIMIT 1')
  }

  target(): TargetInfo {
    const db = this.app.db
    return {
      setupComplete: this.setupComplete(),
      shopName: db.value<string>('SELECT display_name FROM business_profile_versions WHERE is_active = 1') ?? '',
      terminal: db.get<{ uuid: string; code: string; name: string }>('SELECT uuid, code, name FROM pos_terminals WHERE is_local = 1') ?? null,
      products: db.value<number>('SELECT COUNT(*) FROM products') ?? 0,
      sales: db.value<number>('SELECT COUNT(*) FROM sales') ?? 0,
      users: db.value<number>('SELECT COUNT(*) FROM users') ?? 0
    }
  }

  suggestedName(now = Date.now()): string {
    const pos = this.app.db.value<string>('SELECT code FROM pos_terminals WHERE is_local = 1') ?? 'POS'
    return `Velmayil-everything-${pos}-${stamp(now)}${TRANSFER_EXT}`
  }

  // ---------------- export ----------------
  /** Write ONE file with everything another laptop needs. `path` = full file name, or a folder to put the file in. */
  async export(opts: { path?: string; now?: number } = {}): Promise<ExportResult> {
    const app = this.app
    const me = app.db.get<{ uuid: string; code: string; name: string }>('SELECT uuid, code, name FROM pos_terminals WHERE is_local = 1')
    if (!me || !app.db.value<number>('SELECT 1 FROM users LIMIT 1')) {
      throw new AppError('CONFLICT', 'Finish the first-time setup on this laptop before exporting.')
    }
    if (this.busy) throw new AppError('CONFLICT', 'An export or import is already running')
    this.busy = true
    const now = opts.now ?? Date.now()
    const snap = join(this.tmpDir(), `export-${now}-${process.pid}.db`)
    try {
      let dest = opts.path?.trim() || join(this.defaultFolder(), this.suggestedName(now))
      if (!isAbsolute(dest)) throw new AppError('VALIDATION', 'Choose where to save the file (full path, for example E:\\).')
      dest = resolve(dest)
      if (existsSync(dest) && statSync(dest).isDirectory()) dest = join(dest, this.suggestedName(now))
      if (!dest.toLowerCase().endsWith(TRANSFER_EXT)) dest += TRANSFER_EXT
      try {
        mkdirSync(dirname(dest), { recursive: true })
      } catch (e) {
        throw new AppError('VALIDATION', `The folder "${dirname(dest)}" cannot be used (${(e as NodeJS.ErrnoException).code ?? (e as Error).message}). Choose another place, for example a USB drive.`)
      }

      // 1. consistent snapshot of the live database (worker thread for real files, so the app keeps responding)
      if (app.db.path === ':memory:') app.db.run('VACUUM INTO ?', snap)
      else {
        const out = await runSnapshotInWorker({
          dbPath: app.db.path, partial: snap + '.partial', final: snap, manifestPath: snap + '.json', copyFolder: '', kind: 'transfer', pos: me.code,
          appVersion: appVersion(), now
        })
        removeQuiet(snap + '.json')
        if (!out.ok) throw new AppError('INTERNAL', 'The database failed its integrity check, nothing was exported: ' + out.problems.join('; '))
      }

      // 2. take out what must not leave this laptop (sync key, queues, parked bills, backup list) and shrink the file
      const w = new Db(snap)
      let summary: Summary
      try {
        w.exec('PRAGMA foreign_keys = OFF')
        scrubMachineData(w)
        w.exec('VACUUM')
        summary = summarize(w)
      } finally {
        closeWork(w)
      }

      // 3. one file: description + checksums + data
      const info = describeFile(snap)
      const header: TransferHeader = {
        format: 1, kind: 'everything', app: 'velmayil-pos', appVersion: appVersion(), createdAt: now,
        source: {
          deviceUuid: me.uuid, posCode: me.code, posName: me.name,
          shopName: app.db.value<string>('SELECT display_name FROM business_profile_versions WHERE is_active = 1') ?? ''
        },
        schemaVersion: info.schemaVersion, schemaCount: info.schemaCount,
        payload: { sizeBytes: statSync(snap).size, sha256: sha256File(snap) },
        tables: info.tables, summary
      }
      let sizeBytes: number
      try {
        sizeBytes = writeContainer(snap, dest, header)
        checkPayload(dest) // read it back from where it was written (a failing USB stick shows up now, not on the other laptop)
      } catch (e) {
        removeQuiet(dest)
        removeQuiet(dest + '.partial')
        if (e instanceof AppError) throw e
        throw new AppError('INTERNAL', `The file could not be written to "${dirname(dest)}" (${(e as NodeJS.ErrnoException).code ?? (e as Error).message}). Check that the drive is connected and has free space.`)
      }
      app.audit({ entity: 'transfer', entityId: basename(dest), action: 'export', new: { path: dest, sizeBytes, sha256: header.payload.sha256, summary } })
      return { path: dest, sizeBytes, sha256: header.payload.sha256, createdAt: now, summary: rows(summary) }
    } finally {
      removeQuiet(snap)
      removeQuiet(snap + '.partial')
      removeQuiet(snap + '.json')
      this.busy = false
    }
  }

  // ---------------- inspect ----------------
  /** Look at a file without changing anything: is it intact, where is it from, what is in it, what is on this laptop now. */
  inspect(path: string): InspectResult {
    const target = this.target()
    const base = { path, target, sameDevice: false }
    let header: TransferHeader
    try {
      header = checkPayload(path)
    } catch (e) {
      if (e instanceof TransferFileError) return { ...base, ok: false, problems: [e.message] }
      return { ...base, ok: false, problems: [`The file cannot be read (${(e as NodeJS.ErrnoException).code ?? (e as Error).message}).`] }
    }
    const appMax = Math.max(...allMigrations().map((m) => m.version))
    const problems: string[] = []
    if (header.schemaVersion > appMax) problems.push(this.newerMessage(header))
    return {
      ...base, ok: problems.length === 0, problems,
      file: {
        sizeBytes: readHeader(path).fileSize, createdAt: header.createdAt, appVersion: header.appVersion, schemaVersion: header.schemaVersion,
        source: header.source, summary: rows(header.summary ?? {}), olderVersion: header.schemaVersion < appMax
      },
      sameDevice: !!target.terminal && target.terminal.uuid === header.source?.deviceUuid
    }
  }

  private newerMessage(h: TransferHeader): string {
    return `This file was made by a newer version of the app (${h.appVersion}) than the one on this laptop (${appVersion()}). Update the app on this laptop first, then import again. Nothing was changed.`
  }

  // ---------------- import ----------------
  /**
   * Replace ALL data of this laptop with the file's data, keeping this laptop's own terminal identity and machine
   * settings. All-or-nothing: every check runs before the live database is touched, a safety backup is taken, and the
   * replacement is one transaction (including the comparison of the result with the file).
   * `sameLaptop`: only matters when the file comes from a terminal with this laptop's identity: true = it really is this
   * laptop (keep the identity), otherwise this laptop gets a fresh identity so two laptops never share one.
   */
  import(opts: { path: string; sameLaptop?: boolean }): ImportResult {
    const app = this.app
    if (this.busy) throw new AppError('CONFLICT', 'An export or import is already running')
    const src = opts.path
    const refuse = (message: string, extra: Record<string, unknown> = {}): never => {
      try {
        app.audit({ entity: 'transfer', entityId: basename(src), action: 'import_refused', new: { src, ...extra }, note: message })
      } catch {
        /* never hide the real reason */
      }
      throw new AppError('VALIDATION', message, extra)
    }

    this.busy = true
    const work = join(this.tmpDir(), `import-${Date.now()}-${process.pid}.vbak`)
    try {
      // 1. file checks (header checksum, size, SHA-256) while copying the data to a private working file
      let header: TransferHeader
      try {
        header = checkPayload(src, work)
      } catch (e) {
        if (e instanceof TransferFileError) return refuse(e.message)
        return refuse(`The file cannot be read (${(e as NodeJS.ErrnoException).code ?? (e as Error).message}). Nothing was imported.`)
      }

      // 2. it must be a healthy database of a version this app understands
      const appMax = Math.max(...allMigrations().map((m) => m.version))
      let fileSchema = 0
      const problems: string[] = []
      let ro: DatabaseSync | undefined
      try {
        ro = new DatabaseSync(work, { readOnly: true })
        const ic = ro.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[]
        if (!(ic.length === 1 && ic[0].integrity_check === 'ok')) problems.push('the data inside is damaged')
        if (ro.prepare('PRAGMA foreign_key_check').all().length) problems.push('the data inside is inconsistent')
        fileSchema = schemaInfo(ro).max
        const counts = tableCounts(ro)
        for (const t of ['users', 'roles', 'pos_terminals', 'products', 'settings']) if (counts[t] === undefined) problems.push(`table ${t} is missing`)
        if (!problems.length && !counts.users) problems.push('it holds no users (first-time setup was not finished on the other laptop)')
      } catch (e) {
        problems.push(`it cannot be opened (${(e as Error).message})`)
      } finally {
        try {
          ro?.close()
        } catch {
          /* ignore */
        }
      }
      if (problems.length) return refuse(`This file cannot be imported: ${problems.join('; ')}. Nothing was changed. Export it again on the other laptop.`, { problems })
      if (fileSchema > appMax || header.schemaVersion > appMax) return refuse(this.newerMessage(header), { schemaVersion: fileSchema, appMax })

      // 3. prepare the private copy: bring an older file up to date, then make it THIS laptop's database
      const target = readTargetState(app.db)
      const sameDevice = !!target.terminal && target.terminal.uuid === header.source?.deviceUuid
      let migrationsRun: number[] = []
      let loc: LocalizeResult
      let expected: Summary
      let expectedTables: Record<string, number>
      let printers: string[] = []
      try {
        const w = new Db(work)
        try {
          migrationsRun = runMigrations(w)
          w.exec('PRAGMA foreign_keys = OFF') // checked as a whole right below (and again by restore)
          scrubMachineData(w)
          loc = localizeForTarget(w, target, { freshIdentity: sameDevice && opts.sameLaptop !== true })
          if (w.all('PRAGMA foreign_key_check').length) throw new Error('prepared data is inconsistent')
          expected = summarize(w)
          expectedTables = tableCounts(w.raw)
          printers = w.all<{ device_name: string }>("SELECT DISTINCT device_name FROM printer_profiles WHERE device_name <> ''").map((r) => r.device_name)
        } finally {
          closeWork(w)
        }
      } catch (e) {
        return refuse(`This file could not be prepared for this version of the app (${(e as Error).message}). Nothing was changed.`)
      }
      const info = describeFile(work)
      const manifest: Manifest = {
        format: 1, app: 'velmayil-pos', appVersion: header.appVersion, createdAt: header.createdAt, kind: 'transfer', posCode: header.source?.posCode ?? '',
        schemaVersion: info.schemaVersion, schemaCount: info.schemaCount, sizeBytes: statSync(work).size, sha256: sha256File(work), tables: info.tables
      }
      writeJsonAtomic(manifestPathFor(work), manifest)

      // 4. safety backup + ONE transaction (BackupService.restore); the result is compared with the file before COMMIT
      let actual: Summary = {}
      const restored = this.backup().restore({
        path: work,
        safetyNote: `Automatic safety backup before "Import everything" from ${header.source?.posCode ?? 'another laptop'}`,
        auditAction: 'transfer_import',
        auditEntityId: basename(src),
        auditSource: src,
        auditNote: `Everything imported from ${header.source?.posCode ?? '?'} (${header.source?.shopName ?? ''}); this terminal is ${loc.terminal.code}`,
        beforeCommit: () => {
          const db = app.db
          const bad: string[] = []
          for (const [t, n] of Object.entries(expectedTables)) {
            if (TARGET_OWNED_TABLES.includes(t)) continue
            const want = t === 'audit_log' ? n + 1 : n // restore() itself adds one audit entry
            const have = Number(db.value<number>(`SELECT COUNT(*) FROM main.${quoteIdent(t)}`) ?? -1)
            if (have !== want) bad.push(`${t}: ${have} instead of ${want}`)
          }
          actual = summarize(db)
          for (const [key, label] of SUMMARY_FIELDS) if ((actual[key] ?? 0) !== (expected[key] ?? 0)) bad.push(`${label}: ${actual[key]} instead of ${expected[key]}`)
          const me = db.get<{ uuid: string }>('SELECT uuid FROM pos_terminals WHERE is_local = 1')
          if (me?.uuid !== loc.terminal.uuid) bad.push('terminal identity was not set')
          if (bad.length) throw new AppError('INTERNAL', 'The imported data does not match the file, so nothing was changed: ' + bad.slice(0, 8).join('; '), { mismatches: bad })
          this.failBeforeCommit?.()
        }
      })

      // 5. afterwards (the data is committed): defaults for settings this version added, and a clean sign-in
      try {
        ensureDefaultSettings(app)
      } catch {
        /* defaults are also seeded on every start */
      }
      app.session = null
      // "in the file" = what the exporting laptop wrote down; for an older file, its data after it was brought up to date
      const summary = rows(migrationsRun.length || !header.summary ? expected : { ...expected, ...header.summary }, actual)
      return {
        importedFrom: src, source: header.source, terminal: loc.terminal, identityCreated: loc.identityCreated, codeChangedFrom: loc.codeChangedFrom,
        safetyBackupPath: restored.safetyBackupPath, migrationsRun, summary, verified: summary.every((r) => r.ok), printers, reloginRequired: true
      }
    } finally {
      removeQuiet(work)
      removeQuiet(manifestPathFor(work))
      removeQuiet(work + '-wal')
      removeQuiet(work + '-shm')
      this.busy = false
    }
  }
}

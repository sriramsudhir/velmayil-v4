import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { closeSync, existsSync, openSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'

/**
 * Backup file format ("*.vbak"): a plain, self-contained SQLite file (journal_mode=DELETE, produced by VACUUM INTO so it is
 * transactionally consistent even while the live database is in WAL mode) + a sidecar "<file>.json" manifest.
 */
export const BACKUP_EXT = '.vbak'
export const MANIFEST_EXT = '.json'

export interface Manifest {
  format: 1
  app: 'velmayil-pos'
  appVersion: string
  createdAt: number
  kind: string
  posCode: string
  /** highest schema_migrations.version contained in the file */
  schemaVersion: number
  schemaCount: number
  sizeBytes: number
  sha256: string
  /** row count of every table in the backup */
  tables: Record<string, number>
}

export interface VerifyResult {
  ok: boolean
  problems: string[]
  manifest?: Manifest
  schemaVersion?: number
}

export const manifestPathFor = (file: string): string => file + MANIFEST_EXT

export function sha256File(path: string): string {
  const h = createHash('sha256')
  const fd = openSync(path, 'r')
  const buf = Buffer.allocUnsafe(1 << 20)
  try {
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null)
      if (n <= 0) break
      h.update(buf.subarray(0, n))
    }
  } finally {
    closeSync(fd)
  }
  return h.digest('hex')
}

export const quoteIdent = (n: string): string => `"${n.replace(/"/g, '""')}"`

export function tableNames(db: DatabaseSync, schema = 'main'): string[] {
  return (db.prepare(`SELECT name FROM ${schema}.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as { name: string }[]).map((r) => r.name)
}

export function tableCounts(db: DatabaseSync): Record<string, number> {
  const out: Record<string, number> = {}
  for (const t of tableNames(db)) out[t] = Number((db.prepare(`SELECT COUNT(*) AS c FROM ${quoteIdent(t)}`).get() as { c: number }).c)
  return out
}

export function schemaInfo(db: DatabaseSync): { max: number; count: number } {
  const r = db.prepare('SELECT COALESCE(MAX(version),0) AS m, COUNT(*) AS c FROM schema_migrations').get() as { m: number; c: number }
  return { max: Number(r.m), count: Number(r.c) }
}

/** Convert a freshly produced VACUUM INTO file to journal_mode=DELETE so it is one self-contained file. */
export function finalizeSnapshotFile(path: string): void {
  const db = new DatabaseSync(path)
  try {
    db.exec('PRAGMA journal_mode = DELETE')
  } finally {
    db.close()
  }
}

/** Counts + schema read from the file itself (used to build the manifest). */
export function describeFile(path: string): { tables: Record<string, number>; schemaVersion: number; schemaCount: number } {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const s = schemaInfo(db)
    return { tables: tableCounts(db), schemaVersion: s.max, schemaCount: s.count }
  } finally {
    db.close()
  }
}

export function readManifest(file: string): Manifest | undefined {
  const mp = manifestPathFor(file)
  if (!existsSync(mp)) return undefined
  try {
    const m = JSON.parse(readFileSync(mp, 'utf8')) as Manifest
    return m && m.format === 1 && typeof m.sha256 === 'string' ? m : undefined
  } catch {
    return undefined
  }
}

export function writeJsonAtomic(path: string, data: unknown): void {
  const tmp = path + '.tmp'
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
  renameSync(tmp, path)
}

export function removeQuiet(path: string): void {
  try {
    if (existsSync(path)) unlinkSync(path)
  } catch {
    /* best effort */
  }
}

/** Full verification: manifest present, size + sha256 match, opens read-only, integrity_check, foreign_key_check, row counts. */
export function verifyBackupFile(path: string, expected?: Manifest): VerifyResult {
  const problems: string[] = []
  if (!existsSync(path)) return { ok: false, problems: ['Backup file is missing'] }
  const manifest = expected ?? readManifest(path)
  if (!manifest) problems.push('Manifest (.json sidecar) is missing or unreadable')
  if (manifest) {
    const size = statSync(path).size
    if (size !== manifest.sizeBytes) problems.push(`Size mismatch (file ${size}, manifest ${manifest.sizeBytes})`)
    let actual = ''
    try {
      actual = sha256File(path)
    } catch (e) {
      problems.push(`Cannot read file: ${(e as Error).message}`)
    }
    if (actual && actual !== manifest.sha256) problems.push('SHA-256 mismatch: the file was modified or corrupted')
  }
  let db: DatabaseSync | undefined
  let schemaVersion: number | undefined
  try {
    db = new DatabaseSync(path, { readOnly: true })
    const ic = db.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[]
    if (!(ic.length === 1 && ic[0].integrity_check === 'ok')) problems.push(`integrity_check failed: ${ic.slice(0, 3).map((r) => r.integrity_check).join('; ')}`)
    const fk = db.prepare('PRAGMA foreign_key_check').all()
    if (fk.length) problems.push(`foreign_key_check found ${fk.length} violation(s)`)
    schemaVersion = schemaInfo(db).max
    if (manifest) {
      if (manifest.schemaVersion !== schemaVersion) problems.push(`Schema version mismatch (file ${schemaVersion}, manifest ${manifest.schemaVersion})`)
      const counts = tableCounts(db)
      for (const [t, n] of Object.entries(manifest.tables)) {
        if (counts[t] !== n) problems.push(`Row count mismatch in ${t} (file ${counts[t] ?? 'missing'}, manifest ${n})`)
      }
    }
  } catch (e) {
    problems.push(`Cannot open as a database: ${(e as Error).message}`)
  } finally {
    try {
      db?.close()
    } catch {
      /* ignore */
    }
  }
  return { ok: problems.length === 0, problems, manifest, schemaVersion }
}

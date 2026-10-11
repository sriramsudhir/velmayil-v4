import type { Db } from './driver'

export interface Migration {
  version: number
  name: string
  sql?: string
  up?: (db: Db) => void
}

const mods = import.meta.glob('./migrations/*.ts', { eager: true }) as Record<string, { migration: Migration }>

/** All migrations, sorted by version. Versions must be unique across files (see ARCHITECTURE.md ranges). */
export function allMigrations(): Migration[] {
  return sortMigrations(Object.values(mods).map((m) => m.migration).filter(Boolean))
}

/** Validates (unique positive integer versions) and sorts. Throws on duplicates. */
export function sortMigrations(list: Migration[]): Migration[] {
  const seen = new Map<number, string>()
  for (const m of list) {
    if (!Number.isInteger(m.version) || m.version < 1) throw new Error(`Invalid migration version ${m.version} (${m.name})`)
    if (seen.has(m.version)) throw new Error(`Duplicate migration version ${m.version} (${seen.get(m.version)} / ${m.name})`)
    seen.set(m.version, m.name)
  }
  return [...list].sort((a, b) => a.version - b.version)
}

export function runMigrations(db: Db, migrations: Migration[] = allMigrations()): number[] {
  migrations = sortMigrations(migrations)
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)'
  )
  const applied = new Set(db.all<{ version: number }>('SELECT version FROM schema_migrations').map((r) => r.version))
  const ran: number[] = []
  for (const m of migrations) {
    if (applied.has(m.version)) continue
    db.transaction(() => {
      if (m.sql) db.exec(m.sql)
      if (m.up) m.up(db)
      db.run('INSERT INTO schema_migrations(version,name,applied_at) VALUES (?,?,?)', m.version, m.name, Date.now())
    })
    ran.push(m.version)
  }
  return ran
}

import { DatabaseSync } from 'node:sqlite'

type Param = string | number | bigint | null | Uint8Array
type Row = Record<string, unknown>

/** Thin wrapper over node:sqlite with nested-safe transactions. All DB access in the app goes through this. */
export class Db {
  readonly raw: DatabaseSync
  private depth = 0

  constructor(readonly path: string) {
    this.raw = new DatabaseSync(path)
    this.raw.exec('PRAGMA foreign_keys = ON')
    this.raw.exec('PRAGMA busy_timeout = 5000')
    if (path !== ':memory:') {
      this.raw.exec('PRAGMA journal_mode = WAL')
      this.raw.exec('PRAGMA synchronous = NORMAL')
      // Read-path tuning (no durability change): 64 MB page cache, GROUP BY / ORDER BY temp b-trees in RAM,
      // memory-mapped reads, and a bounded WAL file.
      this.raw.exec('PRAGMA cache_size = -65536')
      this.raw.exec('PRAGMA temp_store = MEMORY')
      this.raw.exec('PRAGMA mmap_size = 268435456')
      this.raw.exec('PRAGMA journal_size_limit = 67108864')
    } else {
      this.raw.exec('PRAGMA temp_store = MEMORY')
    }
  }

  exec(sql: string): void {
    this.raw.exec(sql)
  }

  run(sql: string, ...params: Param[]): { changes: number; lastId: number } {
    const r = this.raw.prepare(sql).run(...params)
    return { changes: Number(r.changes), lastId: Number(r.lastInsertRowid) }
  }

  all<T = Row>(sql: string, ...params: Param[]): T[] {
    return this.raw.prepare(sql).all(...params).map((r) => ({ ...r })) as T[]
  }

  get<T = Row>(sql: string, ...params: Param[]): T | undefined {
    const r = this.raw.prepare(sql).get(...params)
    return r ? ({ ...r } as T) : undefined
  }

  /** First column of first row. */
  value<T = number>(sql: string, ...params: Param[]): T | undefined {
    const r = this.raw.prepare(sql).get(...params) as Row | undefined
    return r ? (Object.values(r)[0] as T) : undefined
  }

  /** Atomic. Nested calls become savepoints, so services can compose inside one outer transaction. */
  transaction<T>(fn: () => T): T {
    const nested = this.depth > 0
    const sp = `sp_${this.depth}`
    this.raw.exec(nested ? `SAVEPOINT ${sp}` : 'BEGIN IMMEDIATE')
    this.depth++
    try {
      const out = fn()
      if (out && typeof (out as { then?: unknown }).then === 'function') {
        throw new Error('db.transaction callback must be synchronous (got a Promise)')
      }
      this.raw.exec(nested ? `RELEASE ${sp}` : 'COMMIT')
      this.depth--
      return out
    } catch (e) {
      this.depth--
      try {
        this.raw.exec(nested ? `ROLLBACK TO ${sp}; RELEASE ${sp}` : 'ROLLBACK')
      } catch {
        /* already rolled back */
      }
      throw e
    }
  }

  get inTransaction(): boolean {
    return this.depth > 0
  }

  /** Flush the WAL into the main file (safe no-op for in-memory DBs). */
  checkpoint(): void {
    if (this.path === ':memory:') return
    try {
      this.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    } catch {
      /* best effort */
    }
  }

  close(): void {
    if (!this.raw.isOpen) return
    this.checkpoint()
    this.raw.close()
  }
}

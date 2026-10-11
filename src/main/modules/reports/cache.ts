import type { Db } from '../../db/driver'

/**
 * Tiny result cache for expensive read-only queries (dashboard history, stock totals, report results).
 *
 * Entries are tied to a "stamp": SQLite's total_changes() for this connection, i.e. the number of rows written (by anyone
 * going through app.db: sales, stock moves, settings, audit, ...) since the connection opened. Any write anywhere
 * invalidates, so a cached value can never be stale with respect to this process's own writes; a max age bounds the
 * damage if the file is ever changed by something else (restore swaps tables on the same connection, so it counts too).
 *
 * Callers that know a cheaper, more specific fingerprint pass it as `stamp` (e.g. the dashboard history only cares about
 * sales that are not from today).
 */
export const dataStamp = (db: Db): number => db.value<number>('SELECT total_changes()') ?? 0

interface Entry<T> { stamp: string | number; at: number; value: T }

export class StampCache<T> {
  private map = new Map<string, Entry<T>>()
  constructor(private maxEntries = 16, private maxAgeMs = 5 * 60_000) {}

  get(key: string, stamp: string | number, now = Date.now()): T | undefined {
    const e = this.map.get(key)
    if (!e) return undefined
    if (e.stamp !== stamp || now - e.at > this.maxAgeMs) {
      this.map.delete(key)
      return undefined
    }
    // refresh recency
    this.map.delete(key)
    this.map.set(key, e)
    return e.value
  }

  set(key: string, stamp: string | number, value: T, now = Date.now()): T {
    this.map.delete(key)
    this.map.set(key, { stamp, at: now, value })
    while (this.map.size > this.maxEntries) this.map.delete(this.map.keys().next().value as string)
    return value
  }

  /** get-or-compute */
  memo(key: string, stamp: string | number, compute: () => T): T {
    const hit = this.get(key, stamp)
    if (hit !== undefined) return hit
    return this.set(key, stamp, compute())
  }

  clear(): void {
    this.map.clear()
  }
  get size(): number {
    return this.map.size
  }
}

import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Db } from '../../db/driver'
import type { Change, PullResult, PushResult, RemoteChange } from './protocol'

/**
 * The store of the Admin system's embedded sync server: the same append-only change log as server/sync-server.mjs,
 * kept in its own SQLite file (<data folder>/sync-hub/hub.db) so a push is one small transaction (crash / power-cut safe)
 * and a restart loses nothing. The Admin's own SyncService talks to it in-process (HubTransport); clients over HTTP
 * (LanServer). Every terminal, the Admin included, is just a device that pushes and pulls.
 *
 * `epoch` identifies this particular store. Cursors are "<epoch>:<seq>"; a cursor from another store (or a legacy plain
 * number) restarts at 0, and terminals re-send everything when they meet a new epoch, so a lost / replaced hub heals itself.
 */
export interface HubDevice {
  device: string
  code: string
  name: string
  address: string
  firstSeen: number
  lastPushAt: number | null
  lastPullAt: number | null
  pushed: number
  cursor: number
}

interface Waiter {
  device: string
  done: (changed: boolean) => void
}

const MAX_PULL_BYTES = 8 * 1024 * 1024

export class SyncHub {
  private db: Db
  readonly epoch: string
  /** true when this store was created by this constructor call (nothing in it yet) */
  readonly fresh: boolean
  private waiters = new Set<Waiter>()
  private listeners = new Set<(device: string) => void>()
  private closed = false

  constructor(readonly file: string, readonly adminDevice: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
    try {
      this.db = SyncHub.open(file)
    } catch (e) {
      // unreadable store: set it aside and start a new one (terminals re-send everything on the new epoch)
      if (file === ':memory:' || !existsSync(file)) throw e
      renameSync(file, `${file}.damaged-${Date.now()}`)
      this.db = SyncHub.open(file)
    }
    let epoch = this.db.value<string>("SELECT value FROM hub_meta WHERE key = 'epoch'")
    this.fresh = !epoch
    if (!epoch) {
      epoch = randomUUID().replace(/-/g, '').slice(0, 12)
      this.db.run("INSERT INTO hub_meta(key,value) VALUES ('epoch',?)", epoch)
    }
    this.epoch = epoch
  }

  private static open(file: string): Db {
    const db = new Db(file)
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS hub_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS hub_changes (
          seq INTEGER PRIMARY KEY AUTOINCREMENT, device TEXT NOT NULL, qid INTEGER NOT NULL,
          json TEXT NOT NULL, received_at INTEGER NOT NULL, UNIQUE (device, qid)
        );
        CREATE TABLE IF NOT EXISTS hub_devices (
          device TEXT PRIMARY KEY, code TEXT NOT NULL DEFAULT '', name TEXT NOT NULL DEFAULT '', address TEXT NOT NULL DEFAULT '',
          first_seen INTEGER NOT NULL, last_push_at INTEGER, last_pull_at INTEGER, pushed INTEGER NOT NULL DEFAULT 0, cursor INTEGER NOT NULL DEFAULT 0
        );`)
      db.value('SELECT COUNT(*) FROM hub_meta')
      return db
    } catch (e) {
      try { db.close() } catch { /* ignore */ }
      throw e
    }
  }

  seq(): number {
    return this.db.value<number>('SELECT COALESCE(MAX(seq),0) FROM hub_changes') ?? 0
  }

  private since(cursor: string | null | undefined): number {
    if (!cursor) return 0
    const i = cursor.indexOf(':')
    if (i < 0 || cursor.slice(0, i) !== this.epoch) return 0
    const n = Number(cursor.slice(i + 1))
    return Number.isFinite(n) && n > 0 ? Math.min(n, this.seq()) : 0
  }

  private touch(device: string, patch: { code?: string; name?: string; address?: string; push?: number; pullCursor?: number }): void {
    const now = Date.now()
    this.db.run('INSERT OR IGNORE INTO hub_devices(device,first_seen) VALUES (?,?)', device, now)
    if (patch.push !== undefined) {
      this.db.run('UPDATE hub_devices SET code = ?, name = ?, last_push_at = ?, pushed = pushed + ? WHERE device = ?', patch.code ?? '', patch.name ?? '', now, patch.push, device)
    }
    if (patch.pullCursor !== undefined) {
      this.db.run('UPDATE hub_devices SET last_pull_at = ?, cursor = ? WHERE device = ?', now, patch.pullCursor, device)
      // a terminal that has only received so far is still shown by its name
      if (patch.code) this.db.run('UPDATE hub_devices SET code = ?, name = ? WHERE device = ?', patch.code, patch.name ?? '', device)
    }
    if (patch.address) this.db.run('UPDATE hub_devices SET address = ? WHERE device = ?', patch.address, device)
  }

  /** Durably store a batch (idempotent by (device, qid)). `admin` marks changes that come from the Admin system itself. */
  push(
    dev: { uuid: string; code?: string; name?: string }, changes: unknown[], opts: { admin?: boolean; address?: string } = {}
  ): PushResult & { seq: number } {
    const accepted: number[] = []
    const rejected: { qid: number; error: string }[] = []
    let stored = 0
    this.db.transaction(() => {
      const now = Date.now()
      for (const raw of changes) {
        const c = raw as Partial<Change> | null
        if (!c || c.device !== dev.uuid || !Number.isInteger(c.qid) || typeof c.entity !== 'string' || typeof c.payload !== 'object' || c.payload === null) {
          rejected.push({ qid: Number.isInteger(c?.qid) ? (c!.qid as number) : -1, error: 'malformed change' })
          continue
        }
        // only the hub decides who is the Admin: a client cannot claim it
        const clean: RemoteChange = { ...(c as Change) }
        delete clean.seq
        if (opts.admin) clean.fromAdmin = true
        else delete clean.fromAdmin
        stored += this.db.run('INSERT OR IGNORE INTO hub_changes(device,qid,json,received_at) VALUES (?,?,?,?)', dev.uuid, c.qid as number, JSON.stringify(clean), now).changes
        accepted.push(c.qid as number)
      }
      this.touch(dev.uuid, { code: dev.code, name: dev.name, push: accepted.length, address: opts.address })
    })
    if (stored) this.notify(dev.uuid)
    return { accepted, rejected, seq: this.seq() }
  }

  /** Changes of every OTHER device after `cursor`, as stored JSON strings (the HTTP layer forwards them without re-encoding). */
  pullRaw(device: string, cursor: string | null, limit: number, who: { address?: string; code?: string; name?: string } = {}): { items: string[]; cursor: string; more: boolean } {
    const since = this.since(cursor)
    const lim = Math.min(1000, Math.max(1, Math.floor(limit) || 200))
    const rows = this.db.all<{ seq: number; json: string }>('SELECT seq, json FROM hub_changes WHERE seq > ? AND device <> ? ORDER BY seq LIMIT ?', since, device, lim + 1)
    const items: string[] = []
    let bytes = 0
    let last = since
    let more = false
    for (const r of rows) {
      if (items.length >= lim || (items.length > 0 && bytes + r.json.length > MAX_PULL_BYTES)) {
        more = true
        break
      }
      items.push(r.json)
      bytes += r.json.length
      last = r.seq
    }
    if (!more) last = Math.max(last, this.seq()) // skip over the caller's own trailing changes
    if (device) this.touch(device, { pullCursor: last, ...who })
    return { items, cursor: `${this.epoch}:${last}`, more }
  }

  pull(device: string, cursor: string | null, limit: number): PullResult {
    const r = this.pullRaw(device, cursor, limit)
    return { changes: r.items.map((j) => JSON.parse(j) as RemoteChange), cursor: r.cursor, more: r.more }
  }

  hasNews(device: string, cursor: string | null): boolean {
    if (cursor && this.since(cursor) === 0 && !cursor.startsWith(this.epoch + ':')) return true // foreign cursor: the caller must re-read
    return !!this.db.get('SELECT 1 FROM hub_changes WHERE seq > ? AND device <> ? LIMIT 1', this.since(cursor), device)
  }

  /** Long-poll support: resolves true as soon as another device pushed something, false after `ms`. `cancel` resolves false now. */
  wait(device: string, cursor: string | null, ms: number): { promise: Promise<boolean>; cancel: () => void } {
    if (this.closed || this.hasNews(device, cursor)) return { promise: Promise.resolve(!this.closed), cancel: () => undefined }
    let finish: (changed: boolean) => void = () => undefined
    const promise = new Promise<boolean>((resolve) => {
      const w: Waiter = {
        device,
        done: (changed) => {
          clearTimeout(timer)
          this.waiters.delete(w)
          resolve(changed)
        }
      }
      const timer = setTimeout(() => w.done(false), ms)
      timer.unref?.()
      this.waiters.add(w)
      finish = w.done
    })
    return { promise, cancel: () => finish(false) }
  }

  /** Called after every push that stored something new, with the pushing device. Returns unsubscribe. */
  onPush(listener: (device: string) => void): () => void {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }

  private notify(from: string): void {
    for (const w of [...this.waiters]) if (w.device !== from) w.done(true)
    for (const l of [...this.listeners]) {
      try {
        l(from)
      } catch {
        /* a listener must never break a push */
      }
    }
  }

  /** Let every long-poll go (server stopping). */
  releaseWaiters(): void {
    for (const w of [...this.waiters]) w.done(false)
  }

  devices(): HubDevice[] {
    return this.db
      .all<{ device: string; code: string; name: string; address: string; first_seen: number; last_push_at: number | null; last_pull_at: number | null; pushed: number; cursor: number }>(
        'SELECT * FROM hub_devices ORDER BY first_seen'
      )
      .map((d) => ({ device: d.device, code: d.code, name: d.name, address: d.address, firstSeen: d.first_seen, lastPushAt: d.last_push_at, lastPullAt: d.last_pull_at, pushed: d.pushed, cursor: d.cursor }))
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.releaseWaiters()
    this.listeners.clear()
    try {
      this.db.close()
    } catch {
      /* already closed */
    }
  }
}

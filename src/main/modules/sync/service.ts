import { z } from 'zod'
import type { App } from '../../core/app'
import type { Snapshot } from '../../core/snapshot'
import { AppError } from '@shared/ipc'
import { applyChange } from './apply'
import { collectLocalMovements, enrichPayload, resyncAll } from './collector'
import { makeTransport, type TransportConfig } from './transports'
import type { Change, RemoteChange, SyncTransport } from './protocol'

export interface SyncConfig extends TransportConfig {
  enabled: boolean
  intervalSec: number
}

export interface SyncOptions {
  transportFactory?: (c: TransportConfig) => SyncTransport
  batchSize?: number
  maxAttempts?: number
  backoffBaseMs?: number
  backoffMaxMs?: number
  now?: () => number
}

export interface SyncReport {
  ok: boolean
  skipped?: string
  pushed: number
  pushFailed: number
  received: number
  applied: number
  deferred: number
  error?: string
}

const MAX_DEFERRED_ATTEMPTS = 25
const RETAIN_SENT_MS = 14 * 24 * 3600_000

export class SyncService {
  private running = false
  private timer: NodeJS.Timeout | undefined
  private opts: Required<Omit<SyncOptions, 'transportFactory'>> & { transportFactory: (c: TransportConfig) => SyncTransport }

  constructor(private app: App, opts: SyncOptions = {}) {
    this.opts = {
      transportFactory: opts.transportFactory ?? makeTransport,
      batchSize: opts.batchSize ?? 50,
      maxAttempts: opts.maxAttempts ?? 10,
      backoffBaseMs: opts.backoffBaseMs ?? 5_000,
      backoffMaxMs: opts.backoffMaxMs ?? 15 * 60_000,
      now: opts.now ?? Date.now
    }
  }

  // ---------------- state helpers ----------------
  private st(key: string): string | undefined {
    return this.app.db.value<string>('SELECT value FROM sync_state WHERE key = ?', key)
  }
  private setSt(key: string, value: string): void {
    this.app.db.run('INSERT INTO sync_state(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value)
  }
  device(): { uuid: string; code: string; name: string } {
    const p = this.app.db.get<{ uuid: string; code: string; name: string }>('SELECT uuid, code, name FROM pos_terminals WHERE is_local = 1')
    if (!p) throw new AppError('INTERNAL', 'No local POS terminal configured (run first setup)')
    return p
  }

  // ---------------- config ----------------
  getConfig(): SyncConfig {
    const a = this.app
    return {
      enabled: a.setting('sync.enabled', '0') === '1',
      transport: a.setting('sync.transport', 'http') === 'folder' ? 'folder' : 'http',
      url: a.setting('sync.url', ''),
      folder: a.setting('sync.folder', ''),
      key: a.setting('sync.key', ''),
      intervalSec: Math.max(5, Number(a.setting('sync.interval', '60')) || 60)
    }
  }
  /** Config safe to show in the UI (API key never leaves the main process). */
  publicConfig(): Omit<SyncConfig, 'key'> & { hasKey: boolean } {
    const { key, ...rest } = this.getConfig()
    return { ...rest, hasKey: !!key }
  }
  saveConfig(input: unknown): Omit<SyncConfig, 'key'> & { hasKey: boolean } {
    const r = z
      .object({
        enabled: z.boolean().optional(),
        transport: z.enum(['http', 'folder']).optional(),
        url: z.string().max(500).optional(),
        folder: z.string().max(500).optional(),
        key: z.string().max(500).optional(),
        intervalSec: z.number().int().min(5).max(86400).optional()
      })
      .safeParse(input ?? {})
    if (!r.success) throw new AppError('VALIDATION', r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
    const s = r.data
    if (s.url && !/^https?:\/\//i.test(s.url.trim())) throw new AppError('VALIDATION', 'Server URL must start with http:// or https://')
    const before = this.publicConfig()
    this.app.db.transaction(() => {
      if (s.enabled !== undefined) this.app.setSetting('sync.enabled', s.enabled ? '1' : '0')
      if (s.transport) this.app.setSetting('sync.transport', s.transport)
      if (s.url !== undefined) this.app.setSetting('sync.url', s.url.trim())
      if (s.folder !== undefined) this.app.setSetting('sync.folder', s.folder.trim())
      if (s.key !== undefined && s.key !== '') this.app.setSetting('sync.key', s.key)
      if (s.intervalSec !== undefined) this.app.setSetting('sync.interval', String(s.intervalSec))
      this.app.audit({ entity: 'sync_config', action: 'update', old: before, new: this.publicConfig() })
      // first time on: hand the existing data to the other terminals once
      if (s.enabled && !this.st('bootstrapped')) {
        resyncAll(this.app)
        this.setSt('bootstrapped', '1')
      }
    })
    this.restartTimer()
    return this.publicConfig()
  }

  transport(): SyncTransport {
    return this.opts.transportFactory(this.getConfig())
  }

  async testConnection(): Promise<{ ok: boolean; detail?: string; error?: string }> {
    try {
      const r = await this.transport().ping()
      return { ok: true, detail: r.detail }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  }

  // ---------------- status ----------------
  /** What the top-bar pill needs, cheaply (it is polled): with sync off there is nothing to count. */
  badge(): { enabled: boolean; pending: number; lastSyncAt: number | null; lastError: boolean } {
    if (this.app.setting('sync.enabled', '0') !== '1') return { enabled: false, pending: 0, lastSyncAt: null, lastError: false }
    return {
      enabled: true,
      pending: this.app.db.value<number>("SELECT COUNT(*) FROM sync_queue WHERE status = 'pending'") ?? 0,
      lastSyncAt: this.st('last_sync_at') ? Number(this.st('last_sync_at')) : null,
      lastError: !!this.st('last_error')
    }
  }

  status() {
    const db = this.app.db
    const count = (status: string) => db.value<number>('SELECT COUNT(*) FROM sync_queue WHERE status = ?', status) ?? 0
    const cfg = this.publicConfig()
    return {
      enabled: cfg.enabled,
      transport: cfg.transport,
      configured: cfg.transport === 'folder' ? !!cfg.folder : !!cfg.url && cfg.hasKey,
      online: this.st('online') === undefined ? null : this.st('online') === '1',
      pending: count('pending'),
      failed: count('failed'),
      rejected: count('conflict'),
      deferred: db.value<number>('SELECT COUNT(*) FROM sync_deferred') ?? 0,
      openConflicts: db.value<number>('SELECT COUNT(*) FROM sync_conflicts WHERE acknowledged = 0') ?? 0,
      lastSyncAt: this.st('last_sync_at') ? Number(this.st('last_sync_at')) : null,
      lastPushAt: this.st('last_push_at') ? Number(this.st('last_push_at')) : null,
      lastPullAt: this.st('last_pull_at') ? Number(this.st('last_pull_at')) : null,
      lastError: this.st('last_error') || null,
      backoffUntil: this.st('backoff_until') ? Number(this.st('backoff_until')) : null,
      cursor: this.st('cursor') ?? null,
      running: this.running,
      device: this.device()
    }
  }

  listConflicts(includeAcknowledged = false, limit = 200) {
    return this.app.db.all(
      `SELECT * FROM sync_conflicts ${includeAcknowledged ? '' : 'WHERE acknowledged = 0'} ORDER BY id DESC LIMIT ?`, limit
    )
  }
  ackConflicts(ids?: number[]): number {
    if (!ids) return this.app.db.run('UPDATE sync_conflicts SET acknowledged = 1 WHERE acknowledged = 0').changes
    let n = 0
    for (const id of ids) n += this.app.db.run('UPDATE sync_conflicts SET acknowledged = 1 WHERE id = ?', id).changes
    return n
  }
  listQueue(status?: string, limit = 100) {
    return this.app.db.all(
      `SELECT id, entity, entity_uuid, op, status, attempts, last_error, created_at, sent_at, next_attempt_at FROM sync_queue
       ${status ? 'WHERE status = ?' : ''} ORDER BY id DESC LIMIT ?`,
      ...(status ? [status, limit] : [limit])
    )
  }
  listDevices() {
    const me = this.device()
    const rows = this.app.db.all<{ device: string; code: string; name: string; first_seen: number; last_seen: number; last_qid: number; changes_in: number }>(
      'SELECT * FROM sync_devices ORDER BY last_seen DESC'
    )
    return [{ device: me.uuid, code: me.code, name: me.name, local: true, lastSeen: null as number | null, changesIn: 0 }].concat(
      rows.map((r) => ({ device: r.device, code: r.code, name: r.name, local: false, lastSeen: r.last_seen, changesIn: r.changes_in }))
    )
  }
  /** Give failed / rejected items another chance. */
  retryFailed(): number {
    this.setSt('backoff_until', '0')
    return this.app.db.run("UPDATE sync_queue SET status = 'pending', attempts = 0, next_attempt_at = NULL, last_error = NULL WHERE status IN ('failed','conflict')").changes
  }
  resyncAll(): { queued: number } {
    const r = resyncAll(this.app)
    this.app.audit({ entity: 'sync', action: 'resync_all', new: r })
    return r
  }

  // ---------------- one full cycle ----------------
  /** Push pending changes, pull + apply remote ones, retry parked ones. Never throws; never overlaps itself. */
  async syncNow(opts: { force?: boolean } = {}): Promise<SyncReport> {
    const rep: SyncReport = { ok: true, pushed: 0, pushFailed: 0, received: 0, applied: 0, deferred: 0 }
    if (this.running) return { ...rep, ok: false, skipped: 'already running' }
    const cfg = this.getConfig()
    if (!cfg.enabled) return { ...rep, ok: false, skipped: 'sync is disabled' }
    const backoff = Number(this.st('backoff_until') ?? 0)
    if (!opts.force && backoff > this.opts.now()) return { ...rep, ok: false, skipped: 'backing off' }
    this.running = true
    try {
      const t = this.transport()
      const dev = this.device()
      collectLocalMovements(this.app)
      await this.pushAll(t, dev, rep)
      if (rep.ok) await this.pullAll(t, dev, rep)
      this.retryDeferred(rep)
      if (rep.ok) {
        this.setSt('last_sync_at', String(this.opts.now()))
        this.setSt('last_error', '')
        this.app.db.run("DELETE FROM sync_queue WHERE status = 'sent' AND sent_at < ?", this.opts.now() - RETAIN_SENT_MS)
      }
    } catch (e) {
      rep.ok = false
      rep.error = (e as Error).message
      this.setSt('last_error', rep.error)
    } finally {
      this.running = false
    }
    return rep
  }

  private async pushAll(t: SyncTransport, dev: { uuid: string; code: string; name: string }, rep: SyncReport): Promise<void> {
    const db = this.app.db
    for (let guard = 0; guard < 1000; guard++) {
      const rows = db.all<{ id: number; entity: string; entity_uuid: string; op: 'upsert' | 'delete'; payload_json: string; created_at: number; attempts: number }>(
        "SELECT id, entity, entity_uuid, op, payload_json, created_at, attempts FROM sync_queue WHERE status = 'pending' ORDER BY id LIMIT ?",
        this.opts.batchSize
      )
      if (!rows.length) return
      const changes: Change[] = []
      for (const r of rows) {
        try {
          changes.push({
            device: dev.uuid, deviceCode: dev.code, deviceName: dev.name, qid: r.id, entity: r.entity, entityUuid: r.entity_uuid,
            op: r.op, createdAt: r.created_at, payload: enrichPayload(db, r.entity, JSON.parse(r.payload_json) as Snapshot)
          })
        } catch (e) {
          db.run("UPDATE sync_queue SET status = 'failed', attempts = attempts + 1, last_error = ? WHERE id = ?", `Cannot build payload: ${(e as Error).message}`, r.id)
          rep.pushFailed++
        }
      }
      if (!changes.length) continue
      try {
        const res = await t.push(dev, changes)
        const now = this.opts.now()
        db.transaction(() => {
          for (const qid of res.accepted) db.run("UPDATE sync_queue SET status = 'sent', sent_at = ?, last_error = NULL WHERE id = ?", now, qid)
          for (const rj of res.rejected) db.run("UPDATE sync_queue SET status = 'conflict', last_error = ? WHERE id = ?", rj.error, rj.qid)
          this.setSt('online', '1')
          this.setSt('backoff_until', '0')
          this.setSt('last_push_at', String(now))
        })
        rep.pushed += res.accepted.length
        rep.pushFailed += res.rejected.length
        // anything the remote neither accepted nor rejected would loop forever: treat as a failed attempt
        const handled = new Set([...res.accepted, ...res.rejected.map((r) => r.qid)])
        const missing = changes.filter((c) => !handled.has(c.qid))
        if (missing.length) {
          const msg = `Remote did not acknowledge ${missing.length} change(s)`
          this.pushFailure(missing.map((c) => c.qid), msg)
          rep.ok = false
          rep.error = msg
          return
        }
      } catch (e) {
        this.pushFailure(changes.map((c) => c.qid), (e as Error).message)
        rep.ok = false
        rep.error = (e as Error).message
        return
      }
    }
  }

  private pushFailure(qids: number[], message: string): void {
    const db = this.app.db
    const now = this.opts.now()
    let maxAttempts = 0
    db.transaction(() => {
      for (const qid of qids) {
        const row = db.get<{ attempts: number }>('SELECT attempts FROM sync_queue WHERE id = ?', qid)
        if (!row) continue
        const attempts = row.attempts + 1
        maxAttempts = Math.max(maxAttempts, attempts)
        const delay = Math.min(this.opts.backoffBaseMs * 2 ** (attempts - 1), this.opts.backoffMaxMs)
        db.run(
          'UPDATE sync_queue SET attempts = ?, last_error = ?, next_attempt_at = ?, status = ? WHERE id = ?',
          attempts, message, now + delay, attempts >= this.opts.maxAttempts ? 'failed' : 'pending', qid
        )
      }
      this.setSt('online', '0')
      this.setSt('last_error', message)
      this.setSt('backoff_until', String(now + Math.min(this.opts.backoffBaseMs * 2 ** Math.max(0, maxAttempts - 1), this.opts.backoffMaxMs)))
    })
  }

  private async pullAll(t: SyncTransport, dev: { uuid: string }, rep: SyncReport): Promise<void> {
    for (let guard = 0; guard < 1000; guard++) {
      const cursor = this.st('cursor') ?? null
      let res
      try {
        res = await t.pull(dev, cursor, 200)
      } catch (e) {
        this.setSt('online', '0')
        this.setSt('last_error', (e as Error).message)
        rep.ok = false
        rep.error = (e as Error).message
        return
      }
      this.setSt('online', '1')
      for (const ch of res.changes) {
        rep.received++
        const r = this.processInbound(ch)
        if (r === 'applied') rep.applied++
        if (r === 'deferred') rep.deferred++
      }
      this.setSt('cursor', res.cursor)
      this.setSt('last_pull_at', String(this.opts.now()))
      if (!res.more || (!res.changes.length && res.cursor === cursor)) return
    }
  }

  /** Apply one inbound change exactly once (inbox), recording devices, conflicts and deferrals. */
  processInbound(ch: RemoteChange): 'applied' | 'skipped' | 'deferred' | 'duplicate' | 'error' {
    const db = this.app.db
    const me = this.device().uuid
    if (ch.device === me) return 'skipped'
    if (db.get('SELECT 1 FROM sync_inbox WHERE device = ? AND qid = ?', ch.device, ch.qid)) return 'duplicate'
    this.touchDevice(ch)
    try {
      const res = applyChange(this.app, ch)
      if (res.status === 'deferred') {
        db.run('INSERT OR IGNORE INTO sync_deferred(device,qid,change_json,missing) VALUES (?,?,?,?)', ch.device, ch.qid, JSON.stringify(ch), res.missing)
        return 'deferred'
      }
      db.run('INSERT OR IGNORE INTO sync_inbox(device,qid) VALUES (?,?)', ch.device, ch.qid)
      return res.status === 'applied' ? 'applied' : 'skipped'
    } catch (e) {
      db.transaction(() => {
        db.run(
          'INSERT INTO sync_conflicts(kind,entity,entity_uuid,device,remote_json,resolution) VALUES (?,?,?,?,?,?)',
          'apply_error', ch.entity, ch.entityUuid ?? '', ch.device, JSON.stringify(ch.payload?.row ?? null), `Could not apply: ${(e as Error).message}`
        )
        db.run('INSERT OR IGNORE INTO sync_inbox(device,qid) VALUES (?,?)', ch.device, ch.qid)
      })
      return 'error'
    }
  }

  private touchDevice(ch: RemoteChange): void {
    this.app.db.run(
      `INSERT INTO sync_devices(device,code,name,first_seen,last_seen,last_qid,changes_in) VALUES (?,?,?,?,?,?,1)
       ON CONFLICT(device) DO UPDATE SET code = excluded.code, name = excluded.name, last_seen = excluded.last_seen,
         last_qid = MAX(last_qid, excluded.last_qid), changes_in = changes_in + 1`,
      ch.device, ch.deviceCode ?? '', ch.deviceName ?? '', this.opts.now(), this.opts.now(), ch.qid
    )
  }

  /** Re-attempt parked changes until a pass makes no progress. */
  retryDeferred(rep?: SyncReport): void {
    const db = this.app.db
    for (let pass = 0; pass < 50; pass++) {
      const rows = db.all<{ id: number; device: string; qid: number; change_json: string }>('SELECT id, device, qid, change_json FROM sync_deferred ORDER BY id')
      let progress = 0
      for (const r of rows) {
        const ch = JSON.parse(r.change_json) as RemoteChange
        try {
          const res = applyChange(this.app, ch)
          if (res.status === 'deferred') continue
          db.transaction(() => {
            db.run('DELETE FROM sync_deferred WHERE id = ?', r.id)
            db.run('INSERT OR IGNORE INTO sync_inbox(device,qid) VALUES (?,?)', r.device, r.qid)
          })
          progress++
          if (rep && res.status === 'applied') rep.applied++
        } catch (e) {
          db.transaction(() => {
            db.run('INSERT INTO sync_conflicts(kind,entity,entity_uuid,device,remote_json,resolution) VALUES (?,?,?,?,?,?)',
              'apply_error', ch.entity, ch.entityUuid ?? '', ch.device, JSON.stringify(ch.payload?.row ?? null), `Could not apply: ${(e as Error).message}`)
            db.run('DELETE FROM sync_deferred WHERE id = ?', r.id)
            db.run('INSERT OR IGNORE INTO sync_inbox(device,qid) VALUES (?,?)', r.device, r.qid)
          })
          progress++
        }
      }
      if (!progress) break
    }
    // age the leftovers; give up (and show in the conflicts list) after many cycles
    db.run('UPDATE sync_deferred SET attempts = attempts + 1')
    for (const r of db.all<{ id: number; device: string; qid: number; change_json: string; missing: string }>('SELECT * FROM sync_deferred WHERE attempts >= ?', MAX_DEFERRED_ATTEMPTS)) {
      const ch = JSON.parse(r.change_json) as RemoteChange
      db.transaction(() => {
        db.run('INSERT INTO sync_conflicts(kind,entity,entity_uuid,device,remote_json,resolution) VALUES (?,?,?,?,?,?)',
          'unresolved_ref', ch.entity, ch.entityUuid ?? '', ch.device, JSON.stringify(ch.payload?.row ?? null), `Referenced record never arrived: ${r.missing}`)
        db.run('DELETE FROM sync_deferred WHERE id = ?', r.id)
        db.run('INSERT OR IGNORE INTO sync_inbox(device,qid) VALUES (?,?)', r.device, r.qid)
      })
    }
    if (rep) rep.deferred = db.value<number>('SELECT COUNT(*) FROM sync_deferred') ?? 0
  }

  // ---------------- timer ----------------
  start(): void {
    this.restartTimer()
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }
  private restartTimer(): void {
    this.stop()
    if (process.env.VITEST) return // tests drive syncNow() explicitly
    const cfg = this.getConfig()
    if (!cfg.enabled) return
    this.timer = setInterval(() => void this.syncNow().catch(() => undefined), cfg.intervalSec * 1000)
    this.timer.unref?.()
    setTimeout(() => void this.syncNow().catch(() => undefined), 3000).unref?.()
  }
}

import { join } from 'node:path'
import { z } from 'zod'
import type { App } from '../../core/app'
import type { Snapshot } from '../../core/snapshot'
import { AppError } from '@shared/ipc'
import { applyChange } from './apply'
import { enforceProfile } from './apply/authority'
import { childrenFor, collectLocalMovements, enrichPayload, resyncAll } from './collector'
import { HttpTransport, HubTransport, SyncAuthError, SyncIdentityError, makeTransport, type TransportConfig } from './transports'
import type { Change, RemoteChange, SyncTransport } from './protocol'
import { SyncHub } from './hub'
import { DEFAULT_LAN_PORT, LanServer, newPairingCode, normalizeCode } from './lanServer'
import { DISCOVERY_PORT, DiscoveryResponder, discoverAdmins, lanAddresses, type FoundAdmin, type LanAddress } from './discovery'
import { LOCAL_SETTINGS, SHARED_SETTINGS, collectShared, enforceShared, forgetAdminValues, sharedDirty, sharedDrift } from './shared'

/**
 * How this computer takes part in sync (setting `sync.role`):
 *   standalone : not linked. (The older "sync server URL / shared folder" setup still works in this role when sync.enabled = 1.)
 *   admin      : THE Admin system. Runs the sync server inside this process (hub.ts + lanServer.ts), is the authority for
 *                catalog, prices, shop profile and shop-wide settings.
 *   client     : a counter linked to the Admin system over the LAN (address + pairing code).
 */
export type SyncRole = 'standalone' | 'admin' | 'client'

export interface SyncConfig extends TransportConfig {
  role: SyncRole
  enabled: boolean
  intervalSec: number
  /** admin: TCP port the embedded server listens on */
  port: number
}

export type PublicSyncConfig = Omit<SyncConfig, 'key' | 'lan'> & { hasKey: boolean; /** client: "host:port" of the Admin system */ address: string }

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

export interface LanInfo {
  role: SyncRole
  /** admin: configured port / whether clients can connect / why not (plain language) */
  port: number
  listening: boolean
  problem: string | null
  addresses: LanAddress[]
  discovery: boolean
  clients: { device: string; code: string; name: string; address: string; lastSeenAt: number | null; connected: boolean }[]
  /** client: who we are linked to */
  adminAddress: string
  adminName: string
  adminCode: string
}

const MAX_DEFERRED_ATTEMPTS = 25
const RETAIN_SENT_MS = 14 * 24 * 3600_000
/** LAN roles: retry a lost connection after 1, 2, 4 ... seconds, never slower than this */
const LAN_RETRY_MAX_MS = 15_000
/** LAN client: how long one long-poll waits for news from the Admin */
const LONG_POLL_S = 25
/** entities for which the Admin sends its own copy back after a client edited them (see processInbound) */
const ADMIN_ECHO = new Set(['categories', 'brands', 'products'])

/** "192.168.1.10", "192.168.1.10:8787", "http://admin-pc:8787/" -> "http://host:port" */
export function normalizeAddress(input: string): string {
  let s = input.trim().replace(/^[a-z]+:\/\//i, '').replace(/[/?#].*$/, '').replace(/\s+/g, '')
  if (!s) throw new AppError('VALIDATION', 'Type the address shown on the Admin system, for example 192.168.1.10')
  let port = DEFAULT_LAN_PORT
  const m = /^(.*):(\d{1,5})$/.exec(s)
  if (m) {
    s = m[1]
    port = Number(m[2])
  }
  if (!/^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(s) || port < 1 || port > 65535) {
    throw new AppError('VALIDATION', 'That does not look like a network address. Use the numbers shown on the Admin system, for example 192.168.1.10')
  }
  return `http://${s}:${port}`
}

const addressOf = (url: string): string => {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

export class SyncService {
  private running = false
  private timer: NodeJS.Timeout | undefined
  private opts: Required<Omit<SyncOptions, 'transportFactory'>> & { transportFactory: (c: TransportConfig) => SyncTransport }

  // ---- LAN (admin / client) state ----
  private hub: SyncHub | null = null
  private server: LanServer | null = null
  private responder = new DiscoveryResponder()
  private lanTask: Promise<unknown> = Promise.resolve()
  private lanRetry: NodeJS.Timeout | undefined
  private lanProblem: string | null = null
  private requestedPort: number | null = null
  private gen = 0
  private sleeper: { resolve: () => void; wakeable: boolean } | null = null
  private wakePending = false
  private pollAbort: AbortController | null = null
  private offChange: (() => void) | null = null
  private offHub: (() => void) | null = null
  private changeTimer: NodeJS.Timeout | undefined
  private errorKind: 'auth' | 'identity' | 'network' | null = null
  private resend = false
  private mem: Record<string, number> = {}
  private lastAged = 0
  private lastDiscover = 0
  private stopped = false
  /** tests: ask these addresses instead of broadcasting */
  discoveryTargets: string[] | undefined

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
  /** Writes only when the value really changes: an idle cycle must not touch the database (every write wakes the live-refresh bus). */
  private setSt(key: string, value: string): void {
    if (this.st(key) === value) return
    this.app.db.run('INSERT INTO sync_state(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value)
  }
  /** Timestamps shown in the status card: kept in memory, saved when something happened (or once a minute) in the LAN roles. */
  private stamp(key: string, activity: boolean): void {
    const now = this.opts.now()
    this.mem[key] = now
    if (!this.isLan() || activity || now - Number(this.st(key) ?? 0) > 60_000) this.setSt(key, String(now))
  }
  private stamped(key: string): number | null {
    const v = this.mem[key] ?? Number(this.st(key) ?? 0)
    return v ? v : null
  }
  device(): { uuid: string; code: string; name: string } {
    const p = this.app.db.get<{ uuid: string; code: string; name: string }>('SELECT uuid, code, name FROM pos_terminals WHERE is_local = 1')
    if (!p) throw new AppError('INTERNAL', 'No local POS terminal configured (run first setup)')
    return p
  }

  // ---------------- config ----------------
  getRole(): SyncRole {
    const r = this.app.setting('sync.role', 'standalone')
    return r === 'admin' || r === 'client' ? r : 'standalone'
  }
  private isLan(): boolean {
    return this.getRole() !== 'standalone'
  }
  getConfig(): SyncConfig {
    const a = this.app
    const role = this.getRole()
    return {
      role,
      enabled: role !== 'standalone' || a.setting('sync.enabled', '0') === '1',
      transport: role === 'client' ? 'http' : a.setting('sync.transport', 'http') === 'folder' ? 'folder' : 'http',
      url: a.setting('sync.url', ''),
      folder: a.setting('sync.folder', ''),
      key: a.setting('sync.key', ''),
      intervalSec: Math.max(5, Number(a.setting('sync.interval', '60')) || 60),
      port: Math.min(65535, Math.max(0, Number(a.setting('sync.port', String(DEFAULT_LAN_PORT))) || 0)),
      lan: role === 'client'
    }
  }
  /** Config safe to show in the UI (the key / pairing code is not included; see pairingCode()). */
  publicConfig(): PublicSyncConfig {
    const { key, lan: _lan, ...rest } = this.getConfig()
    return { ...rest, hasKey: !!key, address: addressOf(rest.url) }
  }
  saveConfig(input: unknown): PublicSyncConfig {
    const r = z
      .object({
        role: z.enum(['standalone', 'admin', 'client']).optional(),
        /** admin: port to listen on (0 = any free port, used by tests) */
        port: z.number().int().min(0).max(65535).optional(),
        /** client: address of the Admin system ("192.168.1.10" or "192.168.1.10:8787") */
        address: z.string().max(300).optional(),
        /** client: the code shown on the Admin system */
        pairingCode: z.string().max(100).optional(),
        /** admin: replace the pairing code (clients must type the new one) */
        newPairingCode: z.boolean().optional(),
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
    const prevRole = this.getRole()
    const role = s.role ?? prevRole
    const adminUrl = s.address !== undefined && s.address.trim() ? normalizeAddress(s.address) : undefined
    const code = s.pairingCode !== undefined ? normalizeCode(s.pairingCode) : ''
    if (role === 'client' && (s.role || s.address !== undefined || s.pairingCode !== undefined)) {
      if (!adminUrl && (prevRole !== 'client' || !this.app.setting('sync.url', ''))) throw new AppError('VALIDATION', 'Type the address shown on the Admin system')
      if (!code && (prevRole !== 'client' || !this.app.setting('sync.key', ''))) throw new AppError('VALIDATION', 'Type the pairing code shown on the Admin system')
      if (s.pairingCode !== undefined && s.pairingCode.trim() && code.length < 6) throw new AppError('VALIDATION', 'The pairing code is too short. It looks like ABCD-EFGH on the Admin system.')
    }
    if (role === 'admin' && s.role) this.device() // fails with a clear message before first setup
    const before = this.publicConfig()
    this.app.db.transaction(() => {
      if (s.role) {
        this.app.setSetting('sync.role', role)
        if (role !== 'standalone') this.app.setSetting('sync.enabled', '1')
        else if (prevRole !== 'standalone' && s.enabled === undefined) this.app.setSetting('sync.enabled', '0')
        if (role === 'client') this.app.setSetting('sync.transport', 'http')
        if (role !== 'client') forgetAdminValues(this.app)
      }
      if (role === 'admin') {
        const cur = this.app.setting('sync.key', '')
        if (s.newPairingCode || (s.role && (prevRole !== 'admin' || !cur))) this.app.setSetting('sync.key', newPairingCode())
        if (s.port !== undefined) this.app.setSetting('sync.port', String(s.port))
      }
      if (role === 'client') {
        if (adminUrl) this.app.setSetting('sync.url', adminUrl)
        if (code) this.app.setSetting('sync.key', code)
      }
      if (s.enabled !== undefined && role === 'standalone') this.app.setSetting('sync.enabled', s.enabled ? '1' : '0')
      if (s.transport && role !== 'client') this.app.setSetting('sync.transport', s.transport)
      if (s.url !== undefined && !adminUrl) this.app.setSetting('sync.url', s.url.trim())
      if (s.folder !== undefined) this.app.setSetting('sync.folder', s.folder.trim())
      if (s.key !== undefined && s.key !== '') this.app.setSetting('sync.key', s.key)
      if (s.intervalSec !== undefined) this.app.setSetting('sync.interval', String(s.intervalSec))
      this.app.audit({ entity: 'sync_config', action: 'update', old: before, new: this.publicConfig() })
      // first time on (older server / folder setup): hand the existing data to the other terminals once.
      // The LAN roles do this when they meet the Admin's store for the first time (hub epoch), see ensureHub / pullAll.
      if (role === 'standalone' && s.enabled && !this.st('bootstrapped')) {
        resyncAll(this.app)
        this.setSt('bootstrapped', '1')
      }
    })
    this.errorKind = null
    this.setSt('backoff_until', '0')
    this.applyRole()
    return this.publicConfig()
  }

  transport(): SyncTransport {
    if (this.getRole() === 'admin') return new HubTransport(this.ensureHub())
    return this.opts.transportFactory(this.getConfig())
  }

  /**
   * "Test connection". With `address` / `pairingCode` it tests what the owner has typed before anything is saved.
   * Always answers with a sentence the owner can act on; never throws for network problems.
   */
  async testConnection(input?: unknown): Promise<{ ok: boolean; detail?: string; error?: string; warning?: string; kind?: string }> {
    const a = z.object({ address: z.string().max(300).optional(), pairingCode: z.string().max(100).optional() }).safeParse(input ?? {})
    const typed = a.success ? a.data : {}
    const role = this.getRole()
    try {
      if (role === 'admin' && !typed.address) {
        await this.lanReady()
        const info = this.lanInfo()
        if (!info.listening) return { ok: false, error: info.problem ?? 'Sharing is not running yet. Wait a few seconds and try again.', kind: 'listen' }
        const t = new HttpTransport(`http://127.0.0.1:${this.server?.state.port ?? info.port}`, this.app.setting('sync.key', ''), { lan: true, timeoutMs: 3000 })
        await t.ping()
        const where = info.addresses.map((x) => x.address).join(' or ') || 'no network address yet (plug in the LAN cable)'
        return { ok: true, detail: `Sharing is on. The Client system should use the address ${where}${info.port !== DEFAULT_LAN_PORT ? `, port ${this.server?.state.port ?? info.port}` : ''}.` }
      }
      if (role === 'client' || typed.address) {
        const cfg = this.getConfig()
        const url = typed.address?.trim() ? normalizeAddress(typed.address) : cfg.url
        const key = typed.pairingCode?.trim() ? normalizeCode(typed.pairingCode) : cfg.key
        const t = new HttpTransport(url, key, { lan: true, timeoutMs: 5000 })
        const h = await t.health().catch((e: Error) => e)
        if (h instanceof Error) return { ok: false, error: h.message, kind: 'network' }
        if (h.app !== 'velmayil-pos' || h.role !== 'admin') {
          return { ok: false, error: `Something answered at ${addressOf(url)}, but it is not a Velmayil POS Admin system. Check the address and port.`, kind: 'network' }
        }
        if (!key) return { ok: false, error: `Found the Admin system ${h.code ?? ''} at ${addressOf(url)}. Now type the pairing code shown on it.`, kind: 'auth' }
        const p = await t.ping()
        const me = this.device()
        if (p.device === me.uuid) throw new SyncIdentityError('This computer has the same terminal identity as the Admin system (its data was copied or restored from the Admin). It needs its own identity before the two can be linked.')
        if (role === 'client' && !typed.address) this.rememberAdmin(p)
        return {
          ok: true,
          detail: `Connected to the Admin system ${[p.code, p.name].filter(Boolean).join(' - ')}.`,
          warning: p.code && p.code === me.code ? this.sameCodeWarning(me.code) : undefined
        }
      }
      const r = await this.transport().ping()
      return { ok: true, detail: r.detail }
    } catch (e) {
      return { ok: false, error: (e as Error).message, kind: e instanceof SyncAuthError ? 'auth' : e instanceof SyncIdentityError ? 'identity' : 'network' }
    }
  }

  private sameCodeWarning(code: string): string {
    return `Both computers use the terminal code ${code}. Change it on this one (Settings > Terminals, for example to POS-02) so that bill numbers cannot clash.`
  }
  private rememberAdmin(p: { code?: string; name?: string }): void {
    this.setSt('admin_code', p.code ?? '')
    this.setSt('admin_name', p.name ?? '')
  }

  /** Client: look for Admin systems on the LAN (a second or two). Empty list = nobody answered; type the address by hand. */
  async discover(): Promise<(FoundAdmin & { label: string })[]> {
    const found = await discoverAdmins({ port: this.discoveryPort(), targets: this.discoveryTargets, timeoutMs: 1500 })
    const me = this.device().uuid
    // an Admin with several network cards answers on each of them: one entry per Admin (any of its addresses works)
    const seen = new Set<string>()
    return found
      .filter((f) => f.device !== me && !seen.has(`${f.device}:${f.port}`) && !!seen.add(`${f.device}:${f.port}`))
      .map((f) => ({ ...f, label: `${f.address}${f.port === DEFAULT_LAN_PORT ? '' : ':' + f.port}` }))
  }
  private discoveryPort(): number {
    const n = Number(this.app.setting('sync.discovery_port', String(DISCOVERY_PORT)))
    return Number.isInteger(n) && n >= 0 && n <= 65535 ? n : DISCOVERY_PORT
  }

  // ---------------- Admin system: embedded server ----------------
  private ensureHub(): SyncHub {
    if (this.hub) return this.hub
    const file = this.app.db.path === ':memory:' ? ':memory:' : join(this.app.userDataDir, 'sync-hub', 'hub.db')
    const hub = new SyncHub(file, this.device().uuid)
    this.hub = hub
    // a store this terminal has not fed yet (first time as Admin, store lost, database restored): give it everything once
    if (this.st('hub_epoch') !== hub.epoch) {
      this.app.db.transaction(() => {
        resyncAll(this.app)
        this.setSt('hub_epoch', hub.epoch)
        this.setSt('bootstrapped', '1')
      })
    }
    return hub
  }

  /** Start / stop the embedded server to match the role. Listening happens in the background; see lanReady(). */
  private applyLan(): void {
    if (this.lanRetry) clearTimeout(this.lanRetry)
    this.lanRetry = undefined
    const cfg = this.getConfig()
    if (cfg.role !== 'admin' || this.stopped) {
      this.stopLan()
      return
    }
    const hub = this.ensureHub()
    const identity = () => {
      const d = this.device()
      return { name: d.name, code: d.code }
    }
    this.server ??= new LanServer(hub, { key: () => this.app.setting('sync.key', ''), identity })
    const server = this.server
    if (server.state.listening && this.requestedPort === cfg.port) return
    this.requestedPort = cfg.port
    this.lanTask = this.lanTask
      .catch(() => undefined)
      .then(() => server.start(cfg.port))
      .then(async (st) => {
        if (this.server !== server) return
        this.lanProblem = st.error
        if (st.listening && st.port) {
          const port = st.port
          const dp = await this.responder.start(this.discoveryPort(), () => (this.server === server ? { port, device: hub.adminDevice, ...identity() } : null))
          if (dp == null) console.error('sync: LAN discovery is not available (UDP port busy); clients can still type the address')
        } else if (st.errorCode === 'EADDRINUSE' && !process.env.VITEST) {
          // often the previous copy of the app still closing: try again quietly
          this.lanRetry = setTimeout(() => {
            if (!this.stopped && this.getRole() === 'admin') {
              this.requestedPort = null
              try {
                this.applyLan()
              } catch {
                /* reported through lanProblem */
              }
            }
          }, 10_000)
          this.lanRetry.unref?.()
        }
      })
      .catch((e: Error) => {
        this.lanProblem = `Sharing could not start: ${e.message}`
      })
  }

  private stopLan(): void {
    this.responder.stop()
    const server = this.server
    const hub = this.hub
    this.server = null
    this.hub = null
    this.requestedPort = null
    this.lanProblem = null
    if (server) this.lanTask = this.lanTask.catch(() => undefined).then(() => server.stop())
    hub?.close()
  }

  /** Resolves when the embedded server has finished starting (or failing to start). */
  async lanReady(): Promise<LanInfo> {
    await this.lanTask.catch(() => undefined)
    return this.lanInfo()
  }

  /** The actual port clients connect to (differs from the configured one only when that is 0 = "any free port"). */
  lanPort(): number | null {
    return this.server?.state.port ?? null
  }
  discoveryListeningPort(): number | null {
    return this.responder.port
  }

  /** The code the owner types on the client. Only handed to users who may configure sync. */
  pairingCode(): string {
    return this.getRole() === 'admin' ? this.app.setting('sync.key', '') : ''
  }

  lanInfo(): LanInfo {
    const cfg = this.getConfig()
    const now = Date.now()
    const me = this.hub?.adminDevice
    const clients = cfg.role === 'admin' && this.hub
      ? this.hub.devices().filter((d) => d.device !== me).map((d) => {
          const lastSeenAt = Math.max(d.lastPullAt ?? 0, d.lastPushAt ?? 0) || null
          return { device: d.device, code: d.code, name: d.name, address: d.address, lastSeenAt, connected: !!lastSeenAt && now - lastSeenAt < 70_000 }
        })
      : []
    return {
      role: cfg.role,
      port: this.server?.state.port ?? cfg.port,
      listening: !!this.server?.state.listening,
      problem: cfg.role === 'admin' ? this.server?.state.error ?? this.lanProblem : null,
      addresses: cfg.role === 'admin' ? lanAddresses() : [],
      discovery: this.responder.port != null,
      clients,
      adminAddress: cfg.role === 'client' ? addressOf(cfg.url) : '',
      adminName: cfg.role === 'client' ? this.st('admin_name') ?? '' : '',
      adminCode: cfg.role === 'client' ? this.st('admin_code') ?? '' : ''
    }
  }

  /** Things the owner should fix, in plain language. */
  private warnings(lan: LanInfo): string[] {
    const out: string[] = []
    const me = this.device()
    if (lan.role === 'admin') {
      if (lan.clients.some((c) => c.code && c.code === me.code)) {
        out.push(`A Client system uses the same terminal code as this computer (${me.code}). Change it on the Client (Settings > Terminals, for example to POS-02) so that bill numbers cannot clash.`)
      }
      if (lan.listening && !lan.addresses.length) out.push('This computer has no network address yet. Plug in the LAN cable; Windows can take up to a minute to give the cable connection an address.')
    }
    if (lan.role === 'client' && lan.adminCode && lan.adminCode === me.code) out.push(this.sameCodeWarning(me.code))
    return out
  }

  // ---------------- status ----------------
  /** What the top-bar pill needs, cheaply (it is polled): with sync off there is nothing to count. */
  badge(): { enabled: boolean; pending: number; lastSyncAt: number | null; lastError: boolean } {
    if (!this.getConfig().enabled) return { enabled: false, pending: 0, lastSyncAt: null, lastError: false }
    return {
      enabled: true,
      pending: this.app.db.value<number>("SELECT COUNT(*) FROM sync_queue WHERE status = 'pending'") ?? 0,
      lastSyncAt: this.stamped('last_sync_at'),
      lastError: !!this.st('last_error')
    }
  }

  status() {
    const db = this.app.db
    const count = (status: string) => db.value<number>('SELECT COUNT(*) FROM sync_queue WHERE status = ?', status) ?? 0
    const cfg = this.publicConfig()
    const lan = this.lanInfo()
    return {
      enabled: cfg.enabled,
      role: cfg.role,
      transport: cfg.transport,
      configured: cfg.role === 'admin' ? true : cfg.transport === 'folder' ? !!cfg.folder : !!cfg.url && cfg.hasKey,
      online: this.st('online') === undefined ? null : this.st('online') === '1',
      pending: count('pending'),
      failed: count('failed'),
      rejected: count('conflict'),
      deferred: db.value<number>('SELECT COUNT(*) FROM sync_deferred') ?? 0,
      openConflicts: db.value<number>('SELECT COUNT(*) FROM sync_conflicts WHERE acknowledged = 0') ?? 0,
      lastSyncAt: this.stamped('last_sync_at'),
      lastPushAt: this.stamped('last_push_at'),
      lastPullAt: this.stamped('last_pull_at'),
      lastError: this.st('last_error') || null,
      errorKind: this.st('last_error') ? this.errorKind : null,
      backoffUntil: this.st('backoff_until') ? Number(this.st('backoff_until')) : null,
      cursor: this.st('cursor') ?? null,
      running: this.running,
      device: this.device(),
      lan,
      warnings: this.warnings(lan),
      sharedSettings: SHARED_SETTINGS.map((x) => x.label),
      localSettings: LOCAL_SETTINGS
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
    const n = this.app.db.run("UPDATE sync_queue SET status = 'pending', attempts = 0, next_attempt_at = NULL, last_error = NULL WHERE status IN ('failed','conflict')").changes
    this.wake()
    return n
  }
  resyncAll(): { queued: number } {
    const r = resyncAll(this.app)
    this.app.audit({ entity: 'sync', action: 'resync_all', new: r })
    this.wake()
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
    let visible = false
    try {
      const t = this.transport()
      const dev = this.device()
      // core only queues changes while sync.enabled = 1; the LAN roles own that flag
      if (cfg.role !== 'standalone' && this.app.setting('sync.enabled', '0') !== '1') this.app.setSetting('sync.enabled', '1')
      collectLocalMovements(this.app)
      if (cfg.role === 'admin') collectShared(this.app)
      if (cfg.role === 'client' && enforceShared(this.app).length) visible = true
      await this.pushAll(t, dev, rep)
      if (rep.ok) await this.pullAll(t, dev, rep)
      if (rep.ok && this.resend) {
        this.resend = false
        await this.pushAll(t, dev, rep) // a store we had not met before: everything was queued again, send it now
      }
      this.retryDeferred(rep)
      if (cfg.role !== 'standalone' && enforceProfile(this.app, cfg.role)) visible = true
      if (rep.ok) {
        this.errorKind = null
        this.stamp('last_sync_at', rep.pushed + rep.received > 0)
        this.setSt('last_error', '')
        this.app.db.run("DELETE FROM sync_queue WHERE status = 'sent' AND sent_at < ?", this.opts.now() - RETAIN_SENT_MS)
      }
    } catch (e) {
      rep.ok = false
      rep.error = (e as Error).message
      this.noteError(e)
      try {
        this.setSt('last_error', rep.error)
      } catch {
        /* database closed while a request was in flight (app shutting down) */
      }
    } finally {
      this.running = false
    }
    // open screens re-read at once instead of waiting for the 1 s change watcher
    if ((rep.applied > 0 || visible) && !this.stopped) {
      try {
        this.app.emitChange('sync')
      } catch {
        /* closing */
      }
    }
    return rep
  }

  private noteError(e: unknown): void {
    this.errorKind = e instanceof SyncAuthError ? 'auth' : e instanceof SyncIdentityError ? 'identity' : 'network'
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
        this.mem.last_push_at = now
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
        if (guard % 4 === 3) await new Promise<void>((r) => setImmediate(r)) // long uploads: let billing calls in between
      } catch (e) {
        this.noteError(e)
        if (this.isLan()) this.lanOffline((e as Error).message)
        else this.pushFailure(changes.map((c) => c.qid), (e as Error).message)
        rep.ok = false
        rep.error = (e as Error).message
        return
      }
    }
  }

  /**
   * LAN roles: the cable is out / the other laptop is off. Nothing is counted against the queued changes (they must all
   * still flow when the cable returns, however long that takes) and repeated failures write nothing.
   */
  private lanOffline(message: string): void {
    this.setSt('online', '0')
    this.setSt('last_error', message)
    this.setSt('backoff_until', '0')
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
    const role = this.getRole()
    for (let guard = 0; guard < 1000; guard++) {
      const cursor = this.st('cursor') ?? null
      let res
      try {
        res = await t.pull(dev, cursor, 200)
      } catch (e) {
        this.noteError(e)
        this.setSt('online', '0')
        this.setSt('last_error', (e as Error).message)
        rep.ok = false
        rep.error = (e as Error).message
        return
      }
      this.setSt('online', '1')
      if (role === 'client') {
        // "<epoch>:<seq>": a store this terminal has never fed (first link, or the Admin's store was replaced). Queue what
        // this terminal has BEFORE applying what the store sends, so nothing received is sent straight back.
        const i = res.cursor.indexOf(':')
        const epoch = i > 0 ? res.cursor.slice(0, i) : ''
        if (epoch && this.st('hub_epoch') !== epoch) {
          // Exception: a laptop that was just filled from the Admin's export file ("Set up another laptop", modules/transfer)
          // holds nothing the Admin lacks: its sync bookkeeping is empty and it is marked as bootstrapped. Uploading the
          // whole shop back would be pure waste. Anything it created since then is in the queue and goes out normally.
          const db = this.app.db
          const seeded = this.st('hub_epoch') === undefined && this.st('bootstrapped') === '1' &&
            !db.get('SELECT 1 FROM sync_queue LIMIT 1') && !db.get('SELECT 1 FROM sync_inbox LIMIT 1') &&
            !db.get('SELECT 1 FROM stock_movements WHERE id > ? LIMIT 1', Number(this.st('moves_cursor') ?? 0))
          db.transaction(() => {
            if (!seeded) resyncAll(this.app)
            this.setSt('hub_epoch', epoch)
            this.setSt('bootstrapped', '1')
          })
          this.resend = !seeded
        }
      }
      let n = 0
      for (const ch of res.changes) {
        rep.received++
        const r = this.processInbound(ch)
        if (r === 'applied') rep.applied++
        if (r === 'deferred') rep.deferred++
        // a big catch-up must not freeze the counter: hand the process back to billing every few records
        if (++n % 20 === 0) await new Promise<void>((resolve) => setImmediate(resolve))
      }
      this.setSt('cursor', res.cursor)
      this.stamp('last_pull_at', res.changes.length > 0)
      if (!res.more || (!res.changes.length && res.cursor === cursor)) return
    }
  }

  private localId(table: string, uuid: string): number | undefined {
    const db = this.app.db
    return (
      db.value<number>(`SELECT id FROM ${table} WHERE uuid = ?`, uuid) ??
      db.value<number>('SELECT local_id FROM sync_aliases WHERE alias_uuid = ? AND table_name = ?', uuid, table)
    )
  }

  /** Apply one inbound change exactly once (inbox), recording devices, conflicts and deferrals. */
  processInbound(ch: RemoteChange): 'applied' | 'skipped' | 'deferred' | 'duplicate' | 'error' {
    const db = this.app.db
    const me = this.device().uuid
    if (ch.device === me) return 'skipped'
    if (db.get('SELECT 1 FROM sync_inbox WHERE device = ? AND qid = ?', ch.device, ch.qid)) return 'duplicate'
    this.touchDevice(ch)
    try {
      // Admin system: a catalog record that already exists here and is edited on a client. Whatever the outcome (the
      // client's edit taken over, or refused because the Admin's copy is newer), the Admin's resulting copy goes back out,
      // and clients take the Admin's copy unconditionally - so every counter ends up with exactly what the Admin has.
      const echoId = this.getRole() === 'admin' && ch.op === 'upsert' && ADMIN_ECHO.has(ch.entity) && ch.entityUuid ? this.localId(ch.entity, ch.entityUuid) : undefined
      const res = applyChange(this.app, ch)
      if (res.status === 'deferred') {
        db.run('INSERT OR IGNORE INTO sync_deferred(device,qid,change_json,missing) VALUES (?,?,?,?)', ch.device, ch.qid, JSON.stringify(ch), res.missing)
        return 'deferred'
      }
      db.run('INSERT OR IGNORE INTO sync_inbox(device,qid) VALUES (?,?)', ch.device, ch.qid)
      if (echoId && (res.status === 'applied' || res.lostRemote)) {
        try {
          this.app.enqueueSnapshot(ch.entity, echoId, childrenFor(db, ch.entity))
          this.wakePending = true
        } catch {
          /* the row went away meanwhile: nothing to send back */
        }
      }
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
    if (!db.get('SELECT 1 FROM sync_deferred LIMIT 1')) {
      if (rep) rep.deferred = 0
      return
    }
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
    // age the leftovers; give up (and show in the conflicts list) after many cycles. The LAN roles run a cycle on every
    // change, so there a "cycle" for this purpose is at most one per minute.
    const now = this.opts.now()
    if (!this.isLan() || now - this.lastAged >= 60_000) {
      this.lastAged = now
      db.run('UPDATE sync_deferred SET attempts = attempts + 1')
    }
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

  // ---------------- background work ----------------
  start(): void {
    this.stopped = false
    this.applyRole()
  }

  /** Stop everything this service runs in the background (app closing). */
  stop(): void {
    this.stopped = true
    this.stopBackground()
    if (this.lanRetry) clearTimeout(this.lanRetry)
    this.lanRetry = undefined
    this.stopLan()
  }

  private applyRole(): void {
    this.stopBackground()
    try {
      this.applyLan()
    } catch (e) {
      this.lanProblem = `Sharing could not start: ${(e as Error).message}`
    }
    if (!process.env.VITEST) this.startBackground() // tests drive syncNow() explicitly, or call startBackground() themselves
  }

  stopBackground(): void {
    this.gen++
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    if (this.changeTimer) clearTimeout(this.changeTimer)
    this.changeTimer = undefined
    this.offChange?.()
    this.offChange = null
    this.offHub?.()
    this.offHub = null
    this.pollAbort?.abort()
    this.pollAbort = null
    this.sleeper?.resolve()
  }

  /**
   * Standalone (server URL / shared folder): a cycle every `sync.interval` seconds, as before.
   * Admin / Client: event driven. A cycle runs when something changed locally (push), when the other side has news
   * (Admin: its store was written; Client: the long-poll returned) and after a lost connection (1, 2, 4 ... 15 s).
   * Nothing here runs on the UI path: billing never waits for the network.
   */
  startBackground(): void {
    this.stopBackground()
    this.stopped = false
    const cfg = this.getConfig()
    if (!cfg.enabled) return
    if (cfg.role === 'standalone') {
      this.timer = setInterval(() => void this.syncNow().catch(() => undefined), cfg.intervalSec * 1000)
      this.timer.unref?.()
      setTimeout(() => void this.syncNow().catch(() => undefined), 3000).unref?.()
      return
    }
    const gen = this.gen
    this.offChange = this.app.onChange(() => this.onLocalChange(gen))
    if (cfg.role === 'admin') {
      try {
        const me = this.device().uuid
        this.offHub = this.ensureHub().onPush((from) => {
          if (from !== me) this.wake()
        })
      } catch {
        /* no terminal yet (before first setup) */
      }
    }
    void this.loop(gen, cfg.role)
  }

  /** Something was written locally: if it is something to send, start a cycle now (coalesced). */
  private onLocalChange(gen: number): void {
    if (this.changeTimer || gen !== this.gen) return
    this.changeTimer = setTimeout(() => {
      this.changeTimer = undefined
      if (gen !== this.gen) return
      try {
        if (this.hasLocalWork()) this.wake()
      } catch {
        /* database closing */
      }
    }, 150)
    this.changeTimer.unref?.()
  }

  private hasLocalWork(): boolean {
    const db = this.app.db
    if (db.get("SELECT 1 FROM sync_queue WHERE status = 'pending' LIMIT 1")) return true
    const cursor = Number(this.st('moves_cursor') ?? 0)
    if (db.get('SELECT 1 FROM stock_movements WHERE id > ? LIMIT 1', cursor)) return true
    const role = this.getRole()
    return role === 'admin' ? sharedDirty(this.app) : role === 'client' ? sharedDrift(this.app) : false
  }

  /** Ask the background loop for a cycle now (no-op when it is not running or is waiting out a lost connection). */
  wake(): void {
    this.wakePending = true
    if (this.sleeper?.wakeable) this.sleeper.resolve()
  }

  private pause(ms: number, wakeable: boolean): Promise<void> {
    return new Promise((resolve) => {
      const s = {
        wakeable,
        resolve: () => {
          clearTimeout(timer)
          if (this.sleeper === s) this.sleeper = null
          resolve()
        }
      }
      const timer = setTimeout(s.resolve, ms)
      timer.unref?.()
      this.sleeper = s
    })
  }

  private async loop(gen: number, role: SyncRole): Promise<void> {
    let fails = 0
    let announced = false
    while (gen === this.gen) {
      let rep: SyncReport
      try {
        this.wakePending = false
        rep = await this.syncNow({ force: true })
      } catch (e) {
        rep = { ok: false, pushed: 0, pushFailed: 0, received: 0, applied: 0, deferred: 0, error: (e as Error).message }
      }
      if (gen !== this.gen) return
      try {
        if (rep.skipped === 'already running') {
          await this.pause(300, false)
        } else if (rep.ok) {
          if (role === 'client' && (fails > 0 || !announced)) await this.refreshPeer()
          announced = true
          fails = 0
          if (!this.wakePending) await this.idle(gen, role)
        } else {
          fails++
          if (role === 'client' && this.errorKind === 'network' && fails >= 2 && (await this.rediscover(gen))) continue
          // a wrong pairing code will not fix itself: ask rarely; a lost cable: look again soon
          await this.pause(this.errorKind === 'network' ? Math.min(LAN_RETRY_MAX_MS, 1000 * 2 ** Math.min(fails - 1, 6)) : 30_000, false)
        }
      } catch {
        if (gen !== this.gen) return
        await this.pause(2000, false)
      }
    }
  }

  /** Wait until there is a reason for another cycle. */
  private async idle(gen: number, role: SyncRole): Promise<void> {
    if (role !== 'client') {
      await this.pause(30_000, true) // Admin: woken by local changes and by clients pushing; 30 s is only a safety net
      return
    }
    const t = this.transport()
    if (!t.wait) {
      await this.pause(this.getConfig().intervalSec * 1000, true)
      return
    }
    const ctl = new AbortController()
    this.pollAbort = ctl
    const started = Date.now()
    const woken = this.pause((LONG_POLL_S + 15) * 1000, true).then(() => 'woken' as const)
    const res = await Promise.race([t.wait(this.device(), this.st('cursor') ?? null, LONG_POLL_S, ctl.signal).catch(() => 'error' as const), woken])
    ctl.abort()
    if (this.pollAbort === ctl) this.pollAbort = null
    this.sleeper?.resolve()
    if (gen !== this.gen) return
    if (res === 'unsupported') await this.pause(Math.min(this.getConfig().intervalSec, 10) * 1000, true)
    else if (res === 'error' && Date.now() - started < 1000) await this.pause(1500, false) // the next cycle decides whether we are offline
  }

  private async refreshPeer(): Promise<void> {
    try {
      const t = this.transport()
      if (t instanceof HttpTransport) this.rememberAdmin(await t.ping())
    } catch {
      /* shown by the next cycle */
    }
  }

  /**
   * Client: the Admin stopped answering at the saved address. Its address may simply have changed (a cable link without
   * a router gets a new one now and then), so look for it on the LAN and, if an Admin there accepts our pairing code,
   * remember the new address. Returns true when the address was updated.
   */
  private async rediscover(gen: number): Promise<boolean> {
    const now = Date.now()
    if (now - this.lastDiscover < 20_000 || (process.env.VITEST && !this.discoveryTargets)) return false
    this.lastDiscover = now
    const cfg = this.getConfig()
    const found = await discoverAdmins({ port: this.discoveryPort(), targets: this.discoveryTargets, timeoutMs: 1200 })
    for (const f of found) {
      if (gen !== this.gen) return false
      const url = `http://${f.address}:${f.port}`
      if (url === cfg.url) continue
      try {
        const p = await new HttpTransport(url, cfg.key, { lan: true, timeoutMs: 3000 }).ping()
        if (p.role !== 'admin' || gen !== this.gen) continue
        this.app.setSetting('sync.url', url)
        this.app.audit({ entity: 'sync_config', action: 'admin_address_found', old: { url: cfg.url }, new: { url } })
        return true
      } catch {
        /* another shop's Admin, or a different pairing code: not ours */
      }
    }
    return false
  }
}

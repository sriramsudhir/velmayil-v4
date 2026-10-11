import { randomUUID } from 'node:crypto'
import { Db } from '../db/driver'
import { runMigrations } from '../db/migrate'
import { AppError, type SessionInfo } from '@shared/ipc'
import { hasPermission, type Permission } from '@shared/permissions'
import { snapshotRow, type ChildSpec } from './snapshot'
import { findVariantByCode, findVariantByScan, getVariant, searchVariants } from './lookup'

export type Method = (args: any, app: App) => unknown | Promise<unknown>
export type ServiceMethods = Record<string, Method>

export interface AuditEntry {
  entity: string
  entityId?: string | number | null
  action: string
  old?: unknown
  new?: unknown
  note?: string
}

export interface StockMove {
  variantId: number
  delta: number
  type: string
  locationId?: number
  refType?: string
  refId?: string | number
  unitCost?: number
  note?: string
  /** Allow balance to go below zero (e.g. POS with the allow-negative setting). Default: follow setting. */
  allowNegative?: boolean
}

/**
 * Application context shared by every module. Created once in main (and in tests).
 *  - app.db            : database (use app.db.transaction for multi-step writes)
 *  - app.expose(...)   : publish IPC-callable service methods (renderer: api.call('name','method',args))
 *  - app.provide/get   : typed singleton registry for cross-module use in the main process
 *  - app.audit/sync/stock/nextNumber/settings : core primitives (do not re-implement)
 */
export class App {
  readonly db: Db
  readonly userDataDir: string
  session: SessionInfo | null = null
  private exposed = new Map<string, ServiceMethods>()
  private singletons = new Map<string, unknown>()

  constructor(opts: { dbPath: string; userDataDir: string }) {
    this.userDataDir = opts.userDataDir
    this.db = new Db(opts.dbPath)
    runMigrations(this.db)
  }

  // ---------- service registry ----------
  expose(name: string, methods: ServiceMethods): void {
    if (this.exposed.has(name)) throw new Error(`Service "${name}" already exposed`)
    this.exposed.set(name, methods)
  }
  provide<T>(name: string, instance: T): T {
    if (this.singletons.has(name)) throw new Error(`Singleton "${name}" already provided`)
    this.singletons.set(name, instance)
    return instance
  }
  get<T>(name: string): T {
    const s = this.singletons.get(name)
    if (!s) throw new Error(`Service "${name}" is not registered`)
    return s as T
  }
  has(name: string): boolean {
    return this.singletons.has(name)
  }

  /** Dispatch used by IPC and tests. Auth: services opt out via PUBLIC_METHODS. */
  async call(service: string, method: string, args?: unknown): Promise<unknown> {
    const svc = this.exposed.get(service)
    const fn = svc?.[method]
    if (!fn) throw new AppError('NOT_FOUND', `Unknown service method ${service}.${method}`)
    if (!isPublic(service, method)) this.requireSession()
    const before = this.totalChanges()
    const out = await fn(args ?? {}, this)
    if (this.totalChanges() !== before) this.emitChange(service, method)
    return out
  }

  // ---------- live data bus ----------
  private listeners = new Set<(e: ChangeEvent) => void>()
  private seenChanges = 0
  private watcher: ReturnType<typeof setInterval> | null = null

  private totalChanges(): number {
    try {
      return this.db.value<number>('SELECT total_changes()') ?? 0
    } catch {
      return 0 // closed database
    }
  }

  /** Subscribe to committed data changes (any service call that wrote, explicit emitChange, or out-of-band writes). Returns unsubscribe. */
  onChange(listener: (e: ChangeEvent) => void): () => void {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }

  /** Announce that data changed. `entity` is the service name ('catalog', 'inventory'...) or 'sync' for inbound sync applies. */
  emitChange(entity: string, method = '*'): void {
    this.seenChanges = this.totalChanges()
    const e: ChangeEvent = { service: entity, method, ts: Date.now() }
    for (const l of [...this.listeners]) {
      try {
        l(e)
      } catch (err) {
        console.error('onChange listener failed', err)
      }
    }
  }

  /**
   * Detect writes made outside App.call (inbound sync apply, background jobs) by watching SQLite total_changes().
   * Emits {service:'sync'} which every live view treats as "refresh everything".
   */
  startChangeWatcher(intervalMs = 1000): void {
    if (this.watcher) return
    this.seenChanges = this.totalChanges()
    this.watcher = setInterval(() => {
      if (this.totalChanges() !== this.seenChanges) this.emitChange('sync')
    }, intervalMs)
    this.watcher.unref?.()
  }

  // ---------- session / permissions ----------
  requireSession(): SessionInfo {
    if (!this.session) throw new AppError('UNAUTHENTICATED', 'Please sign in')
    return this.session
  }
  can(p: Permission): boolean {
    return !!this.session && hasPermission(this.session.permissions, p)
  }
  requirePermission(p: Permission): SessionInfo {
    const s = this.requireSession()
    if (!hasPermission(s.permissions, p)) throw new AppError('FORBIDDEN', `Permission required: ${p}`)
    return s
  }
  localPos(): { id: number; code: string; name: string } {
    const p = this.db.get<{ id: number; code: string; name: string }>('SELECT id, code, name FROM pos_terminals WHERE is_local = 1')
    if (!p) throw new AppError('INTERNAL', 'No local POS terminal configured (run first setup)')
    return p
  }
  defaultLocationId(): number {
    const id = this.db.value<number>('SELECT id FROM locations WHERE is_default = 1 AND active = 1')
    if (!id) throw new AppError('INTERNAL', 'No default stock location (run first setup)')
    return id
  }

  // ---------- core primitives ----------
  uuid(): string {
    return randomUUID()
  }

  audit(e: AuditEntry): void {
    const s = this.session
    const pos = this.db.get<{ id: number; code: string }>('SELECT id, code FROM pos_terminals WHERE is_local = 1')
    this.db.run(
      `INSERT INTO audit_log(user_id,user_name,pos_id,pos_code,entity,entity_id,action,old_json,new_json,note) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      s?.userId ?? null, s?.name ?? null, pos?.id ?? null, pos?.code ?? null,
      e.entity, e.entityId == null ? null : String(e.entityId), e.action,
      e.old === undefined ? null : JSON.stringify(e.old), e.new === undefined ? null : JSON.stringify(e.new), e.note ?? null
    )
  }

  /** True while resyncAll is re-queueing everything (bypasses the sync-off gate). */
  forceEnqueue = false

  /**
   * Rows are only queued once sync is enabled or was ever bootstrapped; while it has never been on, the queue
   * would grow ~3 KB per sale for nothing because enabling sync runs resyncAll (which re-queues everything).
   */
  private syncWanted(): boolean {
    if (this.db.value<string>("SELECT value FROM settings WHERE key = 'sync.enabled'") === '1') return true
    try {
      return this.db.value<string>("SELECT value FROM sync_state WHERE key = 'bootstrapped'") === '1'
    } catch {
      return false
    }
  }

  /** True when enqueueSync would store rows (lets bulk producers skip building snapshots while sync is off). */
  syncActive(): boolean {
    return this.forceEnqueue || this.syncWanted()
  }

  /** Queue a change for optional cloud/multi-POS sync. Call inside the same transaction as the change. */
  enqueueSync(entity: string, entityUuid: string, op: 'upsert' | 'delete', payload: unknown): void {
    if (!this.forceEnqueue && !this.syncWanted()) return
    const pos = this.db.value<number>('SELECT id FROM pos_terminals WHERE is_local = 1')
    this.db.run(
      'INSERT INTO sync_queue(entity,entity_uuid,op,payload_json,pos_id) VALUES (?,?,?,?,?)',
      entity, entityUuid, op, JSON.stringify(payload), pos ?? null
    )
  }

  /** Queue a portable snapshot (row + children, FKs resolved to uuids) for sync. Call inside the writing transaction. */
  enqueueSnapshot(table: string, id: number | string, children: ChildSpec[] = [], op: 'upsert' | 'delete' = 'upsert'): void {
    const snap = snapshotRow(this.db, table, id, children)
    this.enqueueSync(table, snap.uuid, op, snap)
  }

  readonly lookup = {
    byCode: (code: string) => findVariantByCode(this.db, code),
    /** scanner input: exact code first, then reader spelling variants (see lookup.ts) */
    byScan: (code: string) => findVariantByScan(this.db, code),
    byId: (variantId: number) => getVariant(this.db, variantId),
    search: (text: string, limit?: number) => searchVariants(this.db, text, limit)
  }

  setting(key: string, fallback: string): string
  setting(key: string): string | undefined
  setting(key: string, fallback?: string): string | undefined {
    return this.db.value<string>('SELECT value FROM settings WHERE key = ?', key) ?? fallback
  }
  setSetting(key: string, value: string): void {
    this.db.run(
      `INSERT INTO settings(key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
      key, value, Date.now()
    )
  }

  /**
   * Sequential document number, e.g. nextNumber('INV') -> "INV-2026-000125". Atomic (call inside a transaction).
   * `series` is the sequence key; `prefix` defaults to the series. Include the POS code in the series if numbers
   * must be unique across terminals (e.g. series 'INV-P02').
   */
  nextNumber(series: string, opts: { prefix?: string; width?: number; now?: number } = {}): string {
    const year = new Date(opts.now ?? Date.now()).getFullYear()
    const row = this.db.get<{ next_no: number }>('SELECT next_no FROM invoice_sequences WHERE series = ? AND year = ?', series, year)
    const n = row?.next_no ?? 1
    if (row) this.db.run('UPDATE invoice_sequences SET next_no = next_no + 1 WHERE series = ? AND year = ?', series, year)
    else this.db.run('INSERT INTO invoice_sequences(series,year,next_no) VALUES (?,?,2)', series, year)
    return `${opts.prefix ?? series}-${year}-${String(n).padStart(opts.width ?? 6, '0')}`
  }

  /**
   * THE only way stock quantities change. Updates stock_levels and appends to stock_movements atomically.
   * Throws INSUFFICIENT_STOCK when it would go negative (unless allowed). Returns the new balance.
   */
  moveStock(m: StockMove): number {
    return this.db.transaction(() => {
      if (!Number.isInteger(m.delta) || m.delta === 0) throw new AppError('VALIDATION', 'Stock delta must be a non-zero integer')
      const loc = m.locationId ?? this.defaultLocationId()
      const cur = this.db.value<number>('SELECT qty FROM stock_levels WHERE variant_id = ? AND location_id = ?', m.variantId, loc) ?? 0
      const next = cur + m.delta
      const allowNeg = m.allowNegative ?? this.setting('inventory.allow_negative', '0') === '1'
      if (next < 0 && !allowNeg) {
        const name = this.db.value<string>(
          `SELECT p.name || CASE WHEN v.name<>'' THEN ' - '||v.name ELSE '' END FROM product_variants v JOIN products p ON p.id=v.product_id WHERE v.id=?`,
          m.variantId
        )
        throw new AppError('INSUFFICIENT_STOCK', `Insufficient stock for ${name ?? 'item'} (available ${cur}, needed ${-m.delta})`, {
          variantId: m.variantId, available: cur, needed: -m.delta
        })
      }
      this.db.run(
        `INSERT INTO stock_levels(variant_id,location_id,qty) VALUES (?,?,?) ON CONFLICT(variant_id,location_id) DO UPDATE SET qty = excluded.qty`,
        m.variantId, loc, next
      )
      this.db.run(
        `INSERT INTO stock_movements(uuid,variant_id,location_id,qty_delta,balance_after,type,ref_type,ref_id,unit_cost,note,user_id,pos_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        this.uuid(), m.variantId, loc, m.delta, next, m.type, m.refType ?? null, m.refId == null ? null : String(m.refId),
        m.unitCost ?? null, m.note ?? null, this.session?.userId ?? null,
        this.db.value<number>('SELECT id FROM pos_terminals WHERE is_local = 1') ?? null
      )
      return next
    })
  }

  close(): void {
    if (this.watcher) clearInterval(this.watcher)
    this.watcher = null
    this.listeners.clear()
    this.db.close()
  }
}

export interface ChangeEvent {
  service: string
  method: string
  ts: number
}

/**
 * Coalesce bursts of change events: `sink` receives one batch (deduplicated by service, latest ts) at most once per `ms`.
 * Returns a stop function that unsubscribes and cancels any pending flush.
 */
export function coalesceChanges(app: App, ms: number, sink: (events: ChangeEvent[]) => void): () => void {
  let pending = new Map<string, ChangeEvent>()
  let timer: ReturnType<typeof setTimeout> | null = null
  const off = app.onChange((e) => {
    pending.set(`${e.service}.${e.method}`, e)
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      const batch = [...pending.values()]
      pending = new Map()
      sink(batch)
    }, ms)
  })
  return () => {
    off()
    if (timer) clearTimeout(timer)
    timer = null
  }
}

/** Methods callable without a signed-in session (login screen, first-run setup status). */
const PUBLIC = new Set([
  'auth.login', 'auth.current', 'auth.logout', 'setup.status', 'setup.complete', 'app.info',
  // "Import everything" on a brand-new installation: each of these refuses unless no user exists yet or the caller is an Owner (modules/transfer)
  'transfer.target', 'transfer.pickFile', 'transfer.inspect', 'transfer.import'
])
const isPublic = (service: string, method: string) => PUBLIC.has(`${service}.${method}`)

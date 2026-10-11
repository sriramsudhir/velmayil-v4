import { createHash } from 'node:crypto'
import type { App } from '../../core/app'
import type { Snapshot } from '../../core/snapshot'
import type { SyncPayload } from './protocol'

/**
 * Shop-wide configuration: decided once on the Admin system, the same on every counter.
 *
 * It travels ONE way, Admin -> Client, through the ordinary change queue (entities `settings` and `print_templates`,
 * payload.meta.shared = true). Nothing has to call anything when a setting is saved: before every sync cycle the Admin
 * compares the current values with what it last sent (`collectShared`) and queues the differences. A Client applies them
 * (`applyShared`, only when the embedded server stamped the change as coming from the Admin) and puts the Admin's value
 * back if a shared setting is changed locally (`enforceShared`): two counters must never disagree about tax or billing.
 *
 * To share another key, add it here. Everything not listed is per machine and is never sent.
 */
export const SHARED_SETTINGS: { key: string; label: string }[] = [
  // pricing / tax / billing behaviour
  { key: 'billing.prices_include_tax', label: 'Selling prices include GST' },
  { key: 'pos.prices_include_tax', label: 'Selling prices include GST (older key)' },
  { key: 'catalog.default_tax_bp', label: 'Default GST rate for new products' },
  { key: 'pos.round_off', label: 'Round bill totals to the nearest rupee' },
  { key: 'pos.require_shift', label: 'Require an open cash shift before billing' },
  { key: 'billing.invoice_prefix', label: 'Invoice number prefix' },
  { key: 'billing.return_prefix', label: 'Sales return number prefix' },
  { key: 'billing.invoice_width', label: 'Invoice number digits' },
  { key: 'billing.series_per_pos', label: 'Separate invoice series for every terminal' },
  { key: 'billing.upi_id', label: 'Shop UPI id for the payment QR' },
  { key: 'reprint_profile_policy', label: 'Reprints use shop details from' },
  // stock rules
  { key: 'inventory.allow_negative', label: 'Allow selling below zero stock' },
  { key: 'inventory.cost_method', label: 'Product cost after a purchase' },
  // barcode / SKU numbering rules (the running counters stay per machine, see LOCAL_SETTINGS)
  { key: 'catalog.barcode_mode', label: 'Barcode numbering: mode' },
  { key: 'catalog.barcode_prefix', label: 'Barcode numbering: prefix' },
  { key: 'catalog.barcode_width', label: 'Barcode numbering: digits' },
  { key: 'catalog.barcode_strict', label: 'Strict barcode checking' },
  { key: 'catalog.sku_prefix', label: 'SKU prefix' },
  // shop security policy
  { key: 'security.autolock_minutes', label: 'Auto-lock after idle minutes' },
  { key: 'security.password_min_length', label: 'Minimum password length' },
  { key: 'security.password_require_digit', label: 'Passwords must contain a digit' }
]

/** Documented for humans (and the settings screen): what deliberately stays on each machine. */
export const LOCAL_SETTINGS: { pattern: string; why: string }[] = [
  { pattern: 'sync.*', why: 'how this computer is linked (role, address, pairing code)' },
  { pattern: 'backup.*', why: 'backup folders and schedule of this computer' },
  { pattern: 'setup.*', why: 'first-run state of this installation' },
  { pattern: 'profile.pending_sync', why: 'internal flag' },
  { pattern: 'catalog.barcode_seq, catalog.sku_seq', why: 'running counters (each machine continues from the highest number it knows)' },
  { pattern: 'printer_profiles (table)', why: 'which Windows printer, paper calibration and print darkness' },
  { pattern: 'pos_terminals / locations / invoice_sequences (tables)', why: 'terminal identity, stock locations and bill-number counters' },
  { pattern: 'browser storage', why: 'receipt printer choice, auto-print, pay mode, scanner tuning and devices, sound, theme, last user name' },
  { pattern: 'users / roles (tables)', why: 'sign-in names, passwords and PINs never leave a computer' }
]

const SHARED_KEYS = new Set(SHARED_SETTINGS.map((s) => s.key))
const SENT_KEY = 'shared_sent' // admin: signature of what was last queued
const ADMIN_KEY = 'shared_admin' // client: the Admin's values (what enforceShared restores)
const KIND_RE = /^[A-Za-z0-9_]{1,40}$/

const sha = (s: string): string => createHash('sha1').update(s).digest('hex')

function state(app: App, key: string): Record<string, string> {
  try {
    const j: unknown = JSON.parse(app.db.value<string>('SELECT value FROM sync_state WHERE key = ?', key) ?? '{}')
    return j && typeof j === 'object' ? (j as Record<string, string>) : {}
  } catch {
    return {}
  }
}
function setState(app: App, key: string, value: Record<string, string>): void {
  app.db.run('INSERT INTO sync_state(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value))
}

interface Item {
  id: string
  sig: string
  entity: 'settings' | 'print_templates'
  uuid: string
  row: Record<string, unknown>
}

function currentItems(app: App): Item[] {
  const out: Item[] = []
  const rows = app.db.all<{ key: string; value: string; updated_at: number }>(
    `SELECT key, value, updated_at FROM settings WHERE key IN (${SHARED_SETTINGS.map(() => '?').join(',')})`, ...SHARED_SETTINGS.map((s) => s.key)
  )
  for (const r of rows) out.push({ id: 's:' + r.key, sig: `${r.updated_at}|${r.value}`, entity: 'settings', uuid: r.key, row: { key: r.key, value: r.value, updated_at: r.updated_at } })
  // print_templates: receipts, invoices, labels, report headers. The live one per kind is the default row.
  for (const t of app.db.all<{ kind: string; name: string; config_json: string; updated_at: number }>('SELECT kind, name, config_json, updated_at FROM print_templates WHERE is_default = 1')) {
    out.push({ id: 't:' + t.kind, sig: sha(t.config_json), entity: 'print_templates', uuid: t.kind, row: { kind: t.kind, name: t.name, config_json: t.config_json, is_default: 1, updated_at: t.updated_at } })
  }
  return out
}

/** Admin: is there shared configuration that has not been queued yet? (cheap; used to decide whether to start a cycle) */
export function sharedDirty(app: App): boolean {
  const sent = state(app, SENT_KEY)
  return currentItems(app).some((i) => sent[i.id] !== i.sig)
}

/** Admin: queue every shared setting / template that changed since it was last sent. Returns how many were queued. */
export function collectShared(app: App): number {
  const sent = state(app, SENT_KEY)
  const changed = currentItems(app).filter((i) => sent[i.id] !== i.sig)
  if (!changed.length) return 0
  app.db.transaction(() => {
    for (const i of changed) {
      const payload: SyncPayload = { table: i.entity, uuid: i.uuid, row: i.row, refs: {}, meta: { shared: true } }
      app.enqueueSync(i.entity, i.uuid, 'upsert', payload)
      sent[i.id] = i.sig
    }
    setState(app, SENT_KEY, sent)
  })
  return changed.length
}

/** Forget what was sent, so the next cycle sends all shared configuration again (resync / a new embedded store). */
export function resetSharedSent(app: App): void {
  app.db.run('DELETE FROM sync_state WHERE key = ?', SENT_KEY)
}

function writeSetting(app: App, key: string, value: string, updatedAt: number): boolean {
  const cur = app.db.get<{ value: string; updated_at: number }>('SELECT value, updated_at FROM settings WHERE key = ?', key)
  if (cur && cur.value === value && cur.updated_at === updatedAt) return false
  // the Admin's timestamp is kept: some settings are resolved by "whichever key was written last"
  app.db.run('INSERT INTO settings(key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at', key, value, updatedAt)
  return true
}

function writeTemplate(app: App, kind: string, name: string, configJson: string, updatedAt: number): boolean {
  const cur = app.db.get<{ id: number; config_json: string }>('SELECT id, config_json FROM print_templates WHERE kind = ? AND is_default = 1', kind)
  if (cur) {
    if (cur.config_json === configJson) return false
    app.db.run('UPDATE print_templates SET config_json = ?, updated_at = ? WHERE id = ?', configJson, updatedAt, cur.id)
    return true
  }
  app.db.run(
    `INSERT INTO print_templates(kind,name,config_json,is_default,updated_at) VALUES (?,?,?,1,?)
     ON CONFLICT(kind,name) DO UPDATE SET config_json = excluded.config_json, is_default = 1, updated_at = excluded.updated_at`,
    kind, name || 'Default', configJson, updatedAt
  )
  return true
}

/**
 * Client: apply one shared setting / template from the Admin. The caller has already checked that this terminal is a
 * Client and that the change really came from the Admin system. Unknown keys are ignored (an older or newer Admin).
 */
export function applyShared(app: App, entity: string, snap: Snapshot): 'applied' | 'skipped' {
  const row = snap.row ?? {}
  const admin = state(app, ADMIN_KEY)
  const at = Number(row.updated_at) || Date.now()
  let changed = false
  if (entity === 'settings') {
    const key = String(row.key ?? '')
    if (!SHARED_KEYS.has(key) || typeof row.value !== 'string' || row.value.length > 4000) return 'skipped'
    changed = writeSetting(app, key, row.value, at)
    admin['s:' + key] = JSON.stringify([row.value, at])
  } else if (entity === 'print_templates') {
    const kind = String(row.kind ?? '')
    const cfg = row.config_json
    if (!KIND_RE.test(kind) || typeof cfg !== 'string') return 'skipped'
    try {
      JSON.parse(cfg)
    } catch {
      return 'skipped'
    }
    changed = writeTemplate(app, kind, String(row.name ?? 'Default'), cfg, at)
    admin['t:' + kind] = JSON.stringify([cfg, at, String(row.name ?? 'Default')])
  } else return 'skipped'
  setState(app, ADMIN_KEY, admin)
  return changed ? 'applied' : 'skipped'
}

function drift(app: App): { id: string; value: string; at: number; name: string }[] {
  const admin = state(app, ADMIN_KEY)
  const out: { id: string; value: string; at: number; name: string }[] = []
  for (const [id, packed] of Object.entries(admin)) {
    let value: string, at: number, name: string
    try {
      const j = JSON.parse(packed) as [string, number, string?]
      value = j[0]
      at = j[1]
      name = j[2] ?? 'Default'
    } catch {
      continue
    }
    const local = id.startsWith('s:')
      ? app.db.value<string>('SELECT value FROM settings WHERE key = ?', id.slice(2))
      : app.db.value<string>('SELECT config_json FROM print_templates WHERE kind = ? AND is_default = 1', id.slice(2))
    if (local !== value) out.push({ id, value, at, name })
  }
  return out
}

/** Client: has a shared setting been changed on this machine? */
export function sharedDrift(app: App): boolean {
  return drift(app).length > 0
}

/** Client: put the Admin's value back wherever a shared setting / template was changed locally. Returns what was restored. */
export function enforceShared(app: App): string[] {
  const d = drift(app)
  if (!d.length) return []
  app.db.transaction(() => {
    for (const x of d) {
      if (x.id.startsWith('s:')) writeSetting(app, x.id.slice(2), x.value, x.at)
      else writeTemplate(app, x.id.slice(2), x.name, x.value, x.at)
    }
    app.audit({ entity: 'sync', action: 'shared_settings_restored', new: d.map((x) => x.id.slice(2)), note: 'Shop-wide settings are controlled by the Admin system' })
  })
  return d.map((x) => x.id.slice(2))
}

/** A terminal that stops being a Client keeps its current values but is no longer held to the Admin's. */
export function forgetAdminValues(app: App): void {
  app.db.run('DELETE FROM sync_state WHERE key = ?', ADMIN_KEY)
}

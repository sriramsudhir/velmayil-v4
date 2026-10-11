import { z } from 'zod'
import { AppError } from '@shared/ipc'
import type { App } from './app'

/**
 * Registry of known application settings (key -> type, default, validation).
 * Other modules may register their own keys at register() time via registerSettingDef(), which makes them editable
 * through the `settings` service and seeds their default on startup.
 */
export interface SettingDef {
  key: string
  default: string
  label: string
  group: string
  kind: 'bool' | 'int' | 'enum' | 'text'
  options?: string[]
  min?: number
  max?: number
  maxLength?: number
}

const defs = new Map<string, SettingDef>()

export function registerSettingDef(d: SettingDef): void {
  defs.set(d.key, d)
}
export const settingDefs = (): SettingDef[] => [...defs.values()]
export const settingDef = (key: string): SettingDef | undefined => defs.get(key)

const bool = (key: string, def: '0' | '1', label: string, group: string): SettingDef => ({ key, default: def, label, group, kind: 'bool' })

for (const d of [
  bool('inventory.allow_negative', '0', 'Allow selling below zero stock', 'Inventory'),
  bool('billing.prices_include_tax', '1', 'Selling prices include GST', 'Billing'),
  { key: 'reprint_profile_policy', default: 'original', label: 'Reprints use shop details from', group: 'Billing', kind: 'enum', options: ['original', 'current'] },
  { key: 'billing.invoice_prefix', default: 'INV', label: 'Invoice number prefix', group: 'Billing', kind: 'text', maxLength: 8 },
  { key: 'billing.return_prefix', default: 'RET', label: 'Sales return number prefix', group: 'Billing', kind: 'text', maxLength: 8 },
  { key: 'billing.invoice_width', default: '6', label: 'Invoice number digits', group: 'Billing', kind: 'int', min: 3, max: 10 },
  bool('billing.series_per_pos', '1', 'Separate invoice series for every POS terminal', 'Billing'),
  bool('pos.round_off', '1', 'Round bill totals to the nearest rupee', 'Billing'),
  bool('pos.require_shift', '0', 'Require an open cash shift before billing', 'Billing'),
  { key: 'security.autolock_minutes', default: '10', label: 'Auto-lock after idle minutes (0 = never)', group: 'Security', kind: 'int', min: 0, max: 1440 },
  bool('sync.enabled', '0', 'Enable multi-POS / cloud sync', 'Sync')
] as SettingDef[])
  registerSettingDef(d)

/*
 * NOT registered here on purpose: the product barcode numbering keys
 *   catalog.barcode_mode   'sequence' (default: <prefix><running number>) | 'ean13' (internal EAN-13 with check digit)
 *   catalog.barcode_prefix sequence: 1-8 chars A-Z/0-9, default '200'; ean13: 200-299
 *   catalog.barcode_width  digits of the running number in sequence mode, 4-10, default 6
 *   catalog.barcode_seq    last running number issued (counter)
 * Mode, prefix and width are only valid as a combination (see modules/catalog/barcode.ts checkNumbering), so they are edited
 * through `catalog.saveSettings` / Products > Barcode numbering, never through the generic one-key-at-a-time `settings` service.
 */
const PREFIX_RE = /^[A-Za-z0-9][A-Za-z0-9-]*$/

export function validateSetting(key: string, raw: unknown): string {
  const d = defs.get(key)
  if (!d) throw new AppError('VALIDATION', `Unknown setting "${key}"`)
  const s = typeof raw === 'boolean' ? (raw ? '1' : '0') : String(raw ?? '').trim()
  let schema: z.ZodType<string>
  switch (d.kind) {
    case 'bool':
      schema = z.enum(['0', '1'])
      break
    case 'int':
      schema = z
        .string()
        .regex(/^\d+$/, 'Must be a whole number')
        .refine((v) => Number(v) >= (d.min ?? 0) && Number(v) <= (d.max ?? 1_000_000), `Must be between ${d.min ?? 0} and ${d.max ?? 1_000_000}`)
      break
    case 'enum':
      schema = z.enum(d.options as [string, ...string[]])
      break
    default:
      schema = z.string().max(d.maxLength ?? 200)
  }
  let out = schema.parse(s)
  if (key.endsWith('_prefix')) {
    out = z.string().min(1).max(d.maxLength ?? 8).regex(PREFIX_RE, 'Letters, digits and dashes only').parse(out).toUpperCase()
  }
  return out
}

/** Insert every missing setting with its default. Never overwrites an existing value. Safe to call on every startup. */
export function ensureDefaultSettings(app: App): number {
  return app.db.transaction(() => {
    let n = 0
    for (const d of defs.values()) {
      const r = app.db.run('INSERT OR IGNORE INTO settings(key,value,updated_at) VALUES (?,?,?)', d.key, d.default, Date.now())
      n += r.changes
    }
    return n
  })
}

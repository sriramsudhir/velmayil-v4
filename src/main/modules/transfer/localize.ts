import { randomUUID } from 'node:crypto'
import type { Db } from '../../db/driver'
import { quoteIdent, tableNames } from '../backup/engine'
import type { Summary } from './container'

/**
 * What is NOT shared between two laptops. Everything else in the database travels as it is, table by table, with no
 * list of tables or columns to maintain (new tables / columns of later versions are carried automatically).
 *
 * MACHINE-SPECIFIC (the importing laptop keeps its own value, or starts empty):
 *  - terminal identity: the pos_terminals row with is_local = 1 (uuid, code, name)
 *  - settings: every key starting with one of MACHINE_SETTING_PREFIXES, and the keys in MACHINE_SETTING_KEYS
 *  - sync bookkeeping: every table whose name starts with "sync_" (queue, inbox, cursors, peers, conflicts ...)
 *    except sync_aliases (facts about the data, valid on any copy of it)
 *  - tables in MACHINE_TABLES (parked bills of the other counter, its print-job history)
 *  - backups (list of backup files on this disk): never exported, never replaced
 */
export const MACHINE_SETTING_PREFIXES = ['sync.', 'local.', 'device.']
export const MACHINE_SETTING_KEYS = ['backup.folder', 'backup.copy_folder', 'backup.last_error', 'profile.pending_sync']
export const MACHINE_TABLES = ['held_carts', 'print_log']
/** Never part of an import (restore keeps them too). */
export const TARGET_OWNED_TABLES = ['backups', 'schema_migrations']

export const isMachineSetting = (key: string): boolean =>
  MACHINE_SETTING_KEYS.includes(key) || MACHINE_SETTING_PREFIXES.some((p) => key.startsWith(p))
export const isSyncBookkeeping = (table: string): boolean => table.startsWith('sync_') && table !== 'sync_aliases'

const MACHINE_SETTING_SQL =
  `(key IN (${MACHINE_SETTING_KEYS.map((k) => `'${k}'`).join(',')}) OR ` + MACHINE_SETTING_PREFIXES.map((p) => `key LIKE '${p}%'`).join(' OR ') + ')'

/** Run `fn` with every trigger dropped (append-only guards would refuse the clean-up) and put them back afterwards. */
function withoutTriggers<T>(db: Db, fn: () => T): T {
  return db.transaction(() => {
    const triggers = db.all<{ name: string; sql: string }>("SELECT name, sql FROM sqlite_master WHERE type='trigger' AND sql IS NOT NULL")
    for (const t of triggers) db.exec(`DROP TRIGGER ${quoteIdent(t.name)}`)
    const out = fn()
    for (const t of triggers) db.exec(t.sql)
    return out
  })
}

/**
 * Remove everything machine-specific from a snapshot. Runs on the exported copy (so secrets such as the sync key and
 * bulky queues never leave the laptop) and again on the importing side (a file is never trusted to be clean).
 */
export function scrubMachineData(db: Db): void {
  withoutTriggers(db, () => {
    const tables = tableNames(db.raw)
    for (const t of tables) {
      if (isSyncBookkeeping(t) || MACHINE_TABLES.includes(t) || t === 'backups') db.exec(`DELETE FROM ${quoteIdent(t)}`)
    }
    db.exec(`DELETE FROM settings WHERE ${MACHINE_SETTING_SQL}`)
    db.exec(`DELETE FROM sqlite_sequence WHERE name = 'backups' OR name IN (${MACHINE_TABLES.map((t) => `'${t}'`).join(',')}) OR (name LIKE 'sync!_%' ESCAPE '!' AND name <> 'sync_aliases')`)
  })
}

// ---------------------------------------------------------------------------------------------------------------------
export interface TargetState {
  /** this laptop's own terminal, if first-time setup was done */
  terminal: { uuid: string; code: string; name: string } | null
  machineSettings: { key: string; value: string; updated_at: number }[]
  invoiceSequences: { series: string; year: number; next_no: number }[]
  /** highest sync_queue id this laptop ever used: never reused, other terminals remember (device, id) pairs */
  queueHighWater: number
}

export function readTargetState(db: Db): TargetState {
  return {
    terminal: db.get<{ uuid: string; code: string; name: string }>('SELECT uuid, code, name FROM pos_terminals WHERE is_local = 1') ?? null,
    machineSettings: db.all<{ key: string; value: string; updated_at: number }>(`SELECT key, value, updated_at FROM settings WHERE ${MACHINE_SETTING_SQL}`),
    invoiceSequences: db.all<{ series: string; year: number; next_no: number }>('SELECT series, year, next_no FROM invoice_sequences'),
    queueHighWater: Math.max(
      Number(db.value<number>("SELECT seq FROM sqlite_sequence WHERE name = 'sync_queue'") ?? 0),
      Number(db.value<number>('SELECT COALESCE(MAX(id),0) FROM sync_queue') ?? 0)
    )
  }
}

/** Bill numbers are built from the trailing number of the terminal code ("POS-02" -> series INV-02; number 1 -> plain INV). */
const seriesKey = (code: string): string => {
  const d = code.match(/(\d+)\s*$/)?.[1]
  return d != null ? String(Number(d)) : code.replace(/[^A-Za-z0-9]/g, '').toUpperCase()
}

/** `wanted` if no other terminal has that code or the same bill-number series, otherwise the first free POS-NN. */
export function pickTerminalCode(wanted: string | null, taken: string[]): string {
  const codes = new Set(taken.map((c) => c.toUpperCase()))
  const keys = new Set(taken.map(seriesKey))
  if (wanted && !codes.has(wanted.toUpperCase()) && !keys.has(seriesKey(wanted))) return wanted
  for (let n = 2; n < 10000; n++) {
    const c = `POS-${String(n).padStart(2, '0')}`
    if (!codes.has(c) && !keys.has(String(n))) return c
  }
  throw new Error('No free terminal code')
}

export interface LocalizeResult {
  terminal: { uuid: string; code: string; name: string }
  /** the terminal the file was exported from */
  source: { uuid: string; code: string; name: string } | null
  /** this laptop had no terminal identity before (first-time setup was not done) or was given a fresh one */
  identityCreated: boolean
  /** this laptop's terminal code had to change because the other laptop uses it */
  codeChangedFrom: string | null
}

/**
 * Turn a scrubbed copy of the SOURCE laptop's database into the database of THIS laptop:
 * own terminal identity, own machine settings, own bill-number counters, empty sync bookkeeping.
 * `freshIdentity` forces a new terminal uuid (used when this laptop wrongly shares the source's identity).
 */
export function localizeForTarget(db: Db, target: TargetState, opts: { freshIdentity?: boolean; now?: number } = {}): LocalizeResult {
  const now = opts.now ?? Date.now()
  return withoutTriggers(db, () => {
    const source = db.get<{ uuid: string; code: string; name: string }>('SELECT uuid, code, name FROM pos_terminals WHERE is_local = 1') ?? null
    db.exec('UPDATE pos_terminals SET is_local = 0')

    // ---- terminal identity
    const mine = opts.freshIdentity ? null : target.terminal
    let terminal: { uuid: string; code: string; name: string }
    let codeChangedFrom: string | null = null
    const known = mine ? db.get<{ uuid: string; code: string; name: string }>('SELECT uuid, code, name FROM pos_terminals WHERE uuid = ?', mine.uuid) : undefined
    if (known) {
      // the other laptop already knows this one (they synced before, or the file comes from this very laptop)
      db.run('UPDATE pos_terminals SET is_local = 1, active = 1 WHERE uuid = ?', known.uuid)
      terminal = known
    } else {
      const others = db.all<{ code: string; name: string }>('SELECT code, name FROM pos_terminals')
      const wanted = target.terminal?.code ?? null
      const code = pickTerminalCode(wanted, others.map((o) => o.code))
      if (wanted && code !== wanted) codeChangedFrom = wanted
      const num = code.match(/(\d+)\s*$/)?.[1]
      const names = new Set(others.map((o) => o.name.toLowerCase()))
      let name = target.terminal?.name ?? ''
      if (!name || names.has(name.toLowerCase())) name = num ? `Counter ${Number(num)}` : code
      terminal = { uuid: mine?.uuid ?? randomUUID(), code, name }
      const cols = db.all<{ name: string }>('PRAGMA table_info(pos_terminals)').map((c) => c.name)
      if (cols.includes('updated_at')) db.run('INSERT INTO pos_terminals(uuid,code,name,is_local,active,updated_at) VALUES (?,?,?,1,1,?)', terminal.uuid, code, name, now)
      else db.run('INSERT INTO pos_terminals(uuid,code,name,is_local,active) VALUES (?,?,?,1,1)', terminal.uuid, code, name)
    }

    // ---- machine settings of this laptop (the file's were removed by scrubMachineData)
    for (const s of target.machineSettings) {
      db.run('INSERT INTO settings(key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at', s.key, s.value, s.updated_at)
    }

    // ---- document counters never go backwards on this laptop (numbers it already issued are not issued again)
    for (const q of target.invoiceSequences) {
      db.run(
        'INSERT INTO invoice_sequences(series,year,next_no) VALUES (?,?,?) ON CONFLICT(series,year) DO UPDATE SET next_no = MAX(next_no, excluded.next_no)',
        q.series, q.year, q.next_no
      )
    }

    // ---- sync: empty bookkeeping, but queue ids continue after the ones this laptop already used, the imported data
    //      counts as "already handed over" (the source laptop sends its own data) and its stock movements are not re-sent
    db.exec("DELETE FROM sqlite_sequence WHERE name = 'sync_queue'")
    if (target.queueHighWater > 0) db.run("INSERT INTO sqlite_sequence(name,seq) VALUES ('sync_queue',?)", target.queueHighWater)
    const lastMove = Number(db.value<number>('SELECT COALESCE(MAX(id),0) FROM stock_movements') ?? 0)
    db.run("INSERT INTO sync_state(key,value) VALUES ('bootstrapped','1') ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    db.run("INSERT INTO sync_state(key,value) VALUES ('moves_cursor',?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", String(lastMove))

    return { terminal, source, identityCreated: !mine, codeChangedFrom }
  })
}

// ---------------------------------------------------------------------------------------------------------------------
/** [key, label shown to the owner, query]. The same queries run on the file and on the database after the import. */
export const SUMMARY_FIELDS: [string, string, string][] = [
  ['products', 'Products', 'SELECT COUNT(*) FROM products'],
  ['variants', 'Items (variants)', 'SELECT COUNT(*) FROM product_variants'],
  ['categories', 'Categories', 'SELECT COUNT(*) FROM categories'],
  ['brands', 'Brands', 'SELECT COUNT(*) FROM brands'],
  ['barcodes', 'Barcodes', 'SELECT (SELECT COUNT(*) FROM product_variants WHERE barcode IS NOT NULL) + (SELECT COUNT(*) FROM variant_barcodes)'],
  ['priceTotal', 'Sum of all selling prices (paise)', 'SELECT COALESCE(SUM(price),0) FROM product_variants'],
  ['stockTotal', 'Total stock quantity', 'SELECT COALESCE(SUM(qty),0) FROM stock_levels'],
  ['unitCodes', 'Unit codes (label numbers)', 'SELECT COUNT(*) FROM product_units'],
  ['unitPrefixes', 'Products with unit codes', 'SELECT COUNT(*) FROM products WHERE track_units = 1'],
  ['unitLastNumbers', 'Sum of last label numbers', 'SELECT COALESCE(SUM(last_seq),0) FROM unit_sequences'],
  ['customers', 'Customers', 'SELECT COUNT(*) FROM customers'],
  ['suppliers', 'Suppliers', 'SELECT COUNT(*) FROM suppliers'],
  ['sales', 'Bills', 'SELECT COUNT(*) FROM sales'],
  ['users', 'Users', 'SELECT COUNT(*) FROM users'],
  ['roles', 'Roles', 'SELECT COUNT(*) FROM roles'],
  ['settings', 'Shared settings', `SELECT COUNT(*) FROM settings WHERE NOT ${MACHINE_SETTING_SQL}`],
  ['templates', 'Print / label templates', 'SELECT COUNT(*) FROM print_templates'],
  ['printers', 'Printer profiles', 'SELECT COUNT(*) FROM printer_profiles'],
  ['profileVersions', 'Shop profile versions', 'SELECT COUNT(*) FROM business_profile_versions'],
  ['logos', 'Logos', 'SELECT COUNT(*) FROM logo_assets']
]

/** A table / column that does not exist in an older file simply counts as 0. */
export function summarize(db: Db): Summary {
  const out: Summary = {}
  for (const [key, , sql] of SUMMARY_FIELDS) {
    try {
      out[key] = Number(db.value<number>(sql) ?? 0)
    } catch {
      out[key] = 0
    }
  }
  return out
}

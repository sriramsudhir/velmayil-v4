import { describe, it, expect, afterEach } from 'vitest'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { actAs, createTestApp } from '../helpers'
import { CAT, cashSale, availCodes, pipe, statusOf, trackedProduct, plainProduct, U } from '../units/helpers'
import type { App } from '../../src/main/core/app'
import { hashPassword } from '../../src/main/core/crypto'
import { Db } from '../../src/main/db/driver'
import { allMigrations, runMigrations } from '../../src/main/db/migrate'
import { describeFile, sha256File } from '../../src/main/modules/backup/engine'
import type { BackupService } from '../../src/main/modules/backup/service'
import { checkPayload, readHeader, writeContainer, type TransferHeader } from '../../src/main/modules/transfer/container'
import { isMachineSetting, pickTerminalCode, summarize } from '../../src/main/modules/transfer/localize'
import type { ExportResult, ImportResult, InspectResult, TransferService } from '../../src/main/modules/transfer/service'

const ADMIN_PW = 'Admin#1234'
const CASHIER_PW = 'Cash#9876x'

const apps: App[] = []
const dirs: string[] = []
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}
function mk(opts: { seed?: boolean } = {}): { app: App; svc: TransferService; dir: string } {
  const dir = tmp('vxf-')
  const app = createTestApp({ dbPath: join(dir, 'live.db'), userDataDir: dir, seed: opts.seed })
  apps.push(app)
  return { app, svc: app.get<TransferService>('transfer'), dir }
}
afterEach(() => {
  for (const a of apps.splice(0)) try { a.db.close() } catch { /* closed */ }
  for (const d of dirs.splice(0)) try { rmSync(d, { recursive: true, force: true }) } catch { /* windows locks */ }
})

/** A shop that has been running for a while: catalog, unit codes, stock, a bill, users, settings, templates, logo, sync state. */
async function populatedSource() {
  const s = mk()
  const { app } = s
  app.db.run("UPDATE users SET password_hash = ? WHERE username = 'admin'", hashPassword(ADMIN_PW))
  const cashierRole = app.db.value<number>("SELECT id FROM roles WHERE name = 'Cashier'")!
  app.db.run('INSERT INTO users(uuid,username,name,role_id,password_hash) VALUES (?,?,?,?,?)', app.uuid(), 'ravi', 'Ravi', cashierRole, hashPassword(CASHIER_PW))
  app.db.run("INSERT INTO roles(name,permissions,max_discount_bp,is_system) VALUES ('Stock keeper','[\"inventory.view\",\"inventory.adjust\"]',0,0)")

  const cat = app.db.run('INSERT INTO categories(uuid,name) VALUES (?,?)', app.uuid(), 'Sparklers').lastId
  const brand = app.db.run('INSERT INTO brands(uuid,name) VALUES (?,?)', app.uuid(), 'Standard').lastId
  const spk = await trackedProduct(app, { name: 'Sparkler Box', prefix: 'SPK', qty: 5, price: 12500, barcode: '8901234000014' })
  const rkt = await trackedProduct(app, { name: 'Rocket Pack', prefix: 'RKT', qty: 3, price: 30000 })
  const plain = await plainProduct(app, { name: 'Match Box', qty: 40, price: 500 })
  app.db.run('UPDATE products SET category_id = ?, brand_id = ? WHERE id = ?', cat, brand, spk.productId)
  app.db.run('INSERT INTO variant_barcodes(barcode,variant_id) VALUES (?,?)', 'ALIAS-777', plain.variantId)
  app.db.run('INSERT INTO customers(uuid,name,phone) VALUES (?,?,?)', app.uuid(), 'Kumar', '9000000001')
  // more label numbers were issued later (so the sequence is ahead of the opening stock) and one unit was sold
  await U(app, 'markVoid', { codes: ['RKT-0003'], reason: 'damaged in the shop' })
  await cashSale(app, [{ variantId: spk.variantId, qty: 1, unitCodes: [availCodes(app, spk.variantId)[0]] }, { variantId: plain.variantId, qty: 2 }])

  // shared settings
  app.setSetting('billing.invoice_prefix', 'VM')
  app.setSetting('inventory.allow_negative', '1')
  app.setSetting('billing.upi_id', 'shop@upi')
  // machine-specific settings of the SOURCE laptop
  app.setSetting('sync.enabled', '1')
  app.setSetting('sync.url', 'http://192.168.1.10:8787')
  app.setSetting('sync.key', 'SOURCE-SECRET-KEY')
  app.setSetting('sync.role', 'host')
  app.setSetting('backup.folder', join(s.dir, 'source-backups'))
  app.setSetting('backup.copy_folder', 'E:\\SourceUsb')
  app.setSetting('backup.retention', '30')

  app.db.run("INSERT INTO print_templates(kind,name,config_json,is_default) VALUES ('label_barcode','Shelf 50x25','{\"w\":50,\"h\":25}',1)")
  app.db.run("INSERT INTO printer_profiles(name,device_name,kind,calibration_json,is_default) VALUES ('Label printer','TSC TE244','label','{\"darkness\":7}',1)")
  const logo = app.db.run(
    'INSERT INTO logo_assets(sha256,mime,width_px,height_px,bytes,size_bytes) VALUES (?,?,?,?,?,?)', 'a'.repeat(64), 'image/png', 4, 4, Buffer.from([1, 2, 3, 4, 250, 251]), 6
  ).lastId
  app.db.run('UPDATE business_profile_versions SET is_active = 0')
  app.db.run(
    `INSERT INTO business_profile_versions(uuid,version,shop_name,display_name,address,phone,gstin,logo_asset_id,is_active)
     VALUES (?,?,?,?,?,?,?,?,1)`, app.uuid(), 2, 'Velan Crackers', 'Velan Crackers', '5 Car Street', '9876500000', '33ABCDE1234F1Z5', logo
  )
  app.db.run('INSERT INTO held_carts(uuid,pos_id,user_id,label,cart_json) VALUES (?,?,?,?,?)', app.uuid(), app.localPos().id, app.session!.userId, 'parked', '{}')
  app.db.run("INSERT INTO sync_state(key,value) VALUES ('cursor','4711')")
  expect(app.db.value<number>('SELECT COUNT(*) FROM sync_queue')).toBeGreaterThan(0) // the source has unsent changes
  return { ...s, spk, rkt, plain }
}

/** Everything that must be THE SAME on both laptops (ids included: it is the same database). */
const shared = (app: App) => ({
  categories: app.db.all('SELECT * FROM categories ORDER BY id'),
  brands: app.db.all('SELECT * FROM brands ORDER BY id'),
  products: app.db.all('SELECT * FROM products ORDER BY id'),
  variants: app.db.all('SELECT * FROM product_variants ORDER BY id'),
  aliases: app.db.all('SELECT * FROM variant_barcodes ORDER BY barcode'),
  stock: app.db.all('SELECT * FROM stock_levels ORDER BY variant_id, location_id'),
  moves: app.db.all('SELECT * FROM stock_movements ORDER BY id'),
  units: app.db.all('SELECT * FROM product_units ORDER BY id'),
  unitSeq: app.db.all('SELECT * FROM unit_sequences ORDER BY prefix'),
  customers: app.db.all('SELECT * FROM customers ORDER BY id'),
  users: app.db.all('SELECT id, uuid, username, name, role_id, password_hash, pin_hash, active FROM users ORDER BY id'),
  roles: app.db.all('SELECT * FROM roles ORDER BY id'),
  sales: app.db.all('SELECT * FROM sales ORDER BY id'),
  saleItems: app.db.all('SELECT * FROM sale_items ORDER BY id'),
  templates: app.db.all('SELECT * FROM print_templates ORDER BY id'),
  printers: app.db.all('SELECT * FROM printer_profiles ORDER BY id'),
  profile: app.db.all('SELECT * FROM business_profile_versions ORDER BY id'),
  logos: app.db.all('SELECT * FROM logo_assets ORDER BY id'),
  locations: app.db.all('SELECT * FROM locations ORDER BY id'),
  settings: app.db.all<{ key: string; value: string }>('SELECT key, value FROM settings ORDER BY key').filter((r) => !isMachineSetting(r.key))
})
/** Everything a failed import must leave exactly as it was. */
const everything = (app: App) => ({
  ...shared(app),
  allSettings: app.db.all('SELECT key, value FROM settings ORDER BY key'),
  terminals: app.db.all('SELECT * FROM pos_terminals ORDER BY id'),
  queue: app.db.all('SELECT id, entity, entity_uuid, status FROM sync_queue ORDER BY id'),
  syncState: app.db.all('SELECT * FROM sync_state ORDER BY key'),
  sequences: app.db.all('SELECT * FROM invoice_sequences ORDER BY series, year'),
  held: app.db.all('SELECT * FROM held_carts ORDER BY id')
})
const localTerminal = (app: App) => app.db.get<{ id: number; uuid: string; code: string; name: string }>('SELECT id, uuid, code, name FROM pos_terminals WHERE is_local = 1')!
const setting = (app: App, key: string) => app.db.value<string>('SELECT value FROM settings WHERE key = ?', key)

async function exportFrom(s: { svc: TransferService }, dir = tmp('vxf-usb-')): Promise<string> {
  const r = await s.svc.export({ path: dir })
  expect(existsSync(r.path!)).toBe(true)
  return r.path!
}

/** Re-pack a transfer file after changing its payload, with a header that is consistent again (so only one check can refuse it). */
function repack(file: string, change: (payload: string) => void, dest: string): void {
  const payload = dest + '.payload'
  const header = checkPayload(file, payload)
  change(payload)
  const info = describeFile(payload)
  const h: TransferHeader = { ...header, schemaVersion: info.schemaVersion, schemaCount: info.schemaCount, tables: info.tables, payload: { sizeBytes: statSync(payload).size, sha256: sha256File(payload) } }
  writeContainer(payload, dest, h)
  rmSync(payload, { force: true })
}

describe('export everything', () => {
  it('writes ONE checksummed, versioned file that describes its content and holds no machine secrets', async () => {
    const src = await populatedSource()
    const usb = tmp('vxf-usb-')
    const r = (await src.app.call('transfer', 'export', { path: usb })) as ExportResult
    expect(readdirSync(usb)).toEqual([r.path!.split(/[\\/]/).pop()]) // exactly one file, no sidecar, no leftovers
    expect(r.path).toMatch(/Velmayil-everything-POS-01-\d{8}-\d{4}\.vmove$/)

    const { header } = readHeader(r.path!)
    expect(header.format).toBe(1)
    expect(header.schemaVersion).toBe(Math.max(...allMigrations().map((m) => m.version)))
    expect(header.source).toMatchObject({ posCode: 'POS-01', shopName: 'Velan Crackers', deviceUuid: localTerminal(src.app).uuid })
    expect(header.payload.sha256).toBe(r.sha256)
    expect(header.summary).toMatchObject({ products: 3, variants: 3, unitCodes: 8, users: 2, customers: 1, sales: 1, stockTotal: 5 + 3 + 40 - 1 - 1 - 2 })
    expect(r.summary!.find((x) => x.key === 'products')).toMatchObject({ label: 'Products', inFile: 3 })

    // the payload is a real database without the source's queue, sync key, parked bills or backup list
    const payload = join(usb, 'payload.db')
    checkPayload(r.path!, payload)
    const db = new DatabaseSync(payload, { readOnly: true })
    const n = (sql: string) => Number(Object.values(db.prepare(sql).get() as object)[0])
    expect(n('SELECT COUNT(*) FROM sync_queue')).toBe(0)
    expect(n('SELECT COUNT(*) FROM sync_state')).toBe(0)
    expect(n('SELECT COUNT(*) FROM held_carts')).toBe(0)
    expect(n("SELECT COUNT(*) FROM settings WHERE key LIKE 'sync.%' OR key IN ('backup.folder','backup.copy_folder')")).toBe(0)
    expect(n('SELECT COUNT(*) FROM product_units')).toBe(8)
    db.close()
    expect(readFileSync(r.path!).includes(Buffer.from('SOURCE-SECRET-KEY'))).toBe(false)

    // the source itself is untouched by exporting (its queue and settings are still there)
    expect(src.app.db.value<number>('SELECT COUNT(*) FROM sync_queue')).toBeGreaterThan(0)
    expect(setting(src.app, 'sync.key')).toBe('SOURCE-SECRET-KEY')
    expect(src.app.db.value<number>("SELECT COUNT(*) FROM audit_log WHERE entity='transfer' AND action='export'")).toBe(1)
    expect(readdirSync(join(src.dir, 'transfer-tmp'))).toEqual([])
  })

  it('needs an Owner: a Manager (who may take backups) and a Cashier are refused', async () => {
    const src = await populatedSource()
    actAs(src.app, 'Manager')
    await expect(src.app.call('transfer', 'export', { path: tmp('vxf-usb-') })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(src.app.call('transfer', 'import', { path: 'x', confirm: 'REPLACE' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    actAs(src.app, 'Cashier')
    await expect(src.app.call('transfer', 'export', {})).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(src.app.call('transfer', 'inspect', { path: 'x' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})

describe('import everything into a brand-new installation (first-time setup not done)', () => {
  it('makes the second laptop the same as the first, with its own terminal identity', async () => {
    const src = await populatedSource()
    const file = await exportFrom(src)
    const want = shared(src.app)
    const srcTerminal = localTerminal(src.app)

    const dst = mk({ seed: false })
    expect(dst.app.session).toBeNull()
    expect(await dst.app.call('setup', 'status')).toEqual({ complete: false })

    // no user exists yet, so the import screens work without signing in
    const look = (await dst.app.call('transfer', 'inspect', { path: file })) as InspectResult
    expect(look).toMatchObject({ ok: true, problems: [], sameDevice: false, target: { setupComplete: false, products: 0, sales: 0, terminal: null } })
    expect(look.file!.source).toMatchObject({ posCode: 'POS-01', shopName: 'Velan Crackers' })
    await expect(dst.app.call('transfer', 'import', { path: file, confirm: 'yes' })).rejects.toThrow(/REPLACE/)
    expect(dst.app.db.value<number>('SELECT COUNT(*) FROM users')).toBe(0)

    const r = (await dst.app.call('transfer', 'import', { path: file, confirm: 'REPLACE' })) as ImportResult
    expect(r.verified).toBe(true)
    expect(r.summary.length).toBeGreaterThan(10)
    expect(r.summary.every((x) => x.ok && x.inFile === x.now)).toBe(true)
    expect(r.summary.find((x) => x.key === 'unitCodes')).toMatchObject({ inFile: 8, now: 8 })
    expect(r.summary.find((x) => x.key === 'stockTotal')).toMatchObject({ inFile: 44, now: 44 })
    expect(r.printers).toEqual(['TSC TE244'])
    expect(existsSync(r.safetyBackupPath)).toBe(true)

    // same catalog, prices, barcodes, stock, unit codes + sequences, customers, users, roles, templates, profile, logo, shared settings
    expect(shared(dst.app)).toEqual(want)
    expect(setting(dst.app, 'billing.invoice_prefix')).toBe('VM')
    expect(setting(dst.app, 'backup.retention')).toBe('30')
    expect(await dst.app.call('setup', 'status')).toEqual({ complete: true })

    // own identity: a new uuid and a code that gives its bills their own number series; the source is known as another terminal
    const me = localTerminal(dst.app)
    expect(me.uuid).not.toBe(srcTerminal.uuid)
    expect(me).toMatchObject({ code: 'POS-02', name: 'Counter 2' })
    expect(r.terminal).toMatchObject({ uuid: me.uuid, code: 'POS-02' })
    expect(r.identityCreated).toBe(true)
    expect(dst.app.db.get('SELECT code, is_local FROM pos_terminals WHERE uuid = ?', srcTerminal.uuid)).toEqual({ code: 'POS-01', is_local: 0 })
    expect(dst.app.db.value<number>('SELECT COUNT(*) FROM pos_terminals WHERE is_local = 1')).toBe(1)

    // machine-specific things were NOT copied
    expect(setting(dst.app, 'sync.key')).toBeUndefined()
    expect(setting(dst.app, 'sync.url')).toBeUndefined()
    expect(setting(dst.app, 'sync.role')).toBeUndefined()
    expect(setting(dst.app, 'sync.enabled')).toBe('0') // the default: sync is off until it is set up on this laptop
    expect(setting(dst.app, 'backup.folder')).toBeUndefined()
    expect(setting(dst.app, 'backup.copy_folder')).toBeUndefined()
    expect(dst.app.get<BackupService>('backup').getSettings().folder).toBe(join(dst.dir, 'backups'))
    expect(dst.app.db.value<number>('SELECT COUNT(*) FROM held_carts')).toBe(0)

    // sync bookkeeping: nothing of the source's queue or cursor; the imported data counts as already handed over
    expect(dst.app.db.value<number>('SELECT COUNT(*) FROM sync_queue')).toBe(0)
    expect(dst.app.db.value<string>("SELECT value FROM sync_state WHERE key = 'cursor'")).toBeUndefined()
    expect(dst.app.db.value<string>("SELECT value FROM sync_state WHERE key = 'bootstrapped'")).toBe('1')
    expect(Number(dst.app.db.value<string>("SELECT value FROM sync_state WHERE key = 'moves_cursor'"))).toBe(dst.app.db.value<number>('SELECT MAX(id) FROM stock_movements'))

    // users sign in with the passwords they have on the first laptop
    expect(dst.app.session).toBeNull()
    await expect(dst.app.call('auth', 'login', { username: 'ravi', password: 'wrong-password' })).rejects.toMatchObject({ code: 'UNAUTHENTICATED' })
    const cashier = (await dst.app.call('auth', 'login', { username: 'ravi', password: CASHIER_PW })) as { session?: { role: string }; role?: string }
    expect(JSON.stringify(cashier)).toContain('Cashier')
    await dst.app.call('auth', 'logout')
    await dst.app.call('auth', 'login', { username: 'admin', password: ADMIN_PW })
    expect(dst.app.session).toMatchObject({ username: 'admin', role: 'Owner', posCode: 'POS-02', posId: me.id })

    // and the features work: the next label number continues (never reissued), stock is consistent, a sale gets this terminal's series
    const adj = (await dst.app.call('inventory', 'adjust', { variantId: src.spk.variantId, delta: 2, reason: 'found' })) as { unitCodes: string[] }
    expect(adj.unitCodes).toEqual(['SPK-0006', 'SPK-0007'])
    const rk = (await dst.app.call('inventory', 'adjust', { variantId: src.rkt.variantId, delta: 1, reason: 'found' })) as { unitCodes: string[] }
    expect(rk.unitCodes).toEqual(['RKT-0004']) // RKT-0003 was written off on the first laptop: its number is not issued again
    expect(dst.app.db.value<number>("SELECT last_seq FROM unit_sequences WHERE prefix = 'SPK'")).toBe(7)
    expect(dst.app.db.value<number>("SELECT COUNT(*) FROM product_units WHERE code IN (SELECT code FROM product_units GROUP BY code HAVING COUNT(*) > 1)")).toBe(0)
    const sale = (await cashSale(dst.app, [{ variantId: src.plain.variantId, qty: 1 }])) as { invoiceNo: string }
    expect(sale.invoiceNo).toMatch(/^VM-02-\d{4}-000001$/)
    expect(dst.app.db.value<number>('SELECT pos_id FROM sales ORDER BY id DESC LIMIT 1')).toBe(me.id)
    // only what THIS laptop did after the import is queued for sync, under its own identity
    const queued = dst.app.db.all<{ pos_id: number; entity: string }>('SELECT pos_id, entity FROM sync_queue')
    expect(queued.length).toBeGreaterThan(0)
    expect(queued.every((q) => q.pos_id === me.id)).toBe(true)
    expect(queued.filter((q) => q.entity === 'sales')).toHaveLength(1)
    const ledger = (await dst.app.call('inventory', 'verifyLedger')) as { ok: boolean }
    expect(ledger.ok).toBe(true)
  })

  it('a second import of the same file is repeatable (same data, same identity kept)', async () => {
    const src = await populatedSource()
    const file = await exportFrom(src)
    const dst = mk({ seed: false })
    const first = dst.svc.import({ path: file })
    const second = dst.svc.import({ path: file })
    expect(second.terminal).toEqual(first.terminal)
    expect(second.identityCreated).toBe(false)
    expect(second.verified).toBe(true)
    expect(shared(dst.app)).toEqual(shared(src.app))
    expect(dst.app.db.value<number>('SELECT COUNT(*) FROM pos_terminals')).toBe(2)
  })
})

describe('after the import the two laptops are separate terminals of one shop', () => {
  it('later bills travel between them through sync and are not mistaken for its own', async () => {
    const src = await populatedSource()
    const file = await exportFrom(src)
    const sinceSrc = src.app.db.value<number>('SELECT MAX(id) FROM sync_queue')!
    const dst = mk({ seed: false })
    dst.svc.import({ path: file })
    await dst.app.call('auth', 'login', { username: 'admin', password: ADMIN_PW })

    // first laptop sells a coded unit after the export -> arrives on the second one
    const code = availCodes(src.app, src.spk.variantId)[0]
    const a = (await cashSale(src.app, [{ variantId: src.spk.variantId, qty: 1, unitCodes: [code] }])) as { invoiceNo: string }
    const inbound = pipe(src.app, dst.app, sinceSrc)
    expect(inbound.statuses).toContain('sales:applied')
    expect(dst.app.db.value<number>('SELECT COUNT(*) FROM sales WHERE invoice_no = ?', a.invoiceNo)).toBe(1)
    expect(statusOf(dst.app, code)).toBe('sold')

    // second laptop sells -> arrives on the first one under the second laptop's identity and its own bill series
    const b = (await cashSale(dst.app, [{ variantId: src.plain.variantId, qty: 3 }])) as { invoiceNo: string }
    expect(b.invoiceNo).not.toBe(a.invoiceNo)
    const outbound = pipe(dst.app, src.app, 0)
    expect(outbound.statuses).toContain('sales:applied')
    const got = src.app.db.get<{ uuid: string; code: string; is_local: number }>(
      'SELECT t.uuid, t.code, t.is_local FROM sales s JOIN pos_terminals t ON t.id = s.pos_id WHERE s.invoice_no = ?', b.invoiceNo
    )
    expect(got).toEqual({ uuid: localTerminal(dst.app).uuid, code: 'POS-02', is_local: 0 })
    expect(src.app.db.value<number>('SELECT COUNT(*) FROM sales')).toBe(dst.app.db.value<number>('SELECT COUNT(*) FROM sales'))
    expect(src.app.db.value<number>('SELECT COUNT(*) FROM sync_conflicts')).toBe(0)
    expect(dst.app.db.value<number>('SELECT COUNT(*) FROM sync_conflicts')).toBe(0)
  })
})

describe('import everything into a laptop that is already in use', () => {
  async function usedTarget() {
    const t = mk()
    const { app } = t
    app.db.run('UPDATE pos_terminals SET code = ?, name = ? WHERE is_local = 1', 'POS-07', 'Back counter')
    app.session = { ...app.session!, posCode: 'POS-07' }
    const p = await plainProduct(app, { name: 'Old local item', qty: 9, price: 700 })
    await trackedProduct(app, { name: 'Old tracked', prefix: 'SPK', qty: 2, price: 100 }) // same prefix as the source, other numbers
    await cashSale(app, [{ variantId: p.variantId, qty: 1 }])
    await cashSale(app, [{ variantId: p.variantId, qty: 1 }])
    app.setSetting('sync.enabled', '1')
    app.setSetting('sync.url', 'http://192.168.1.20:8787')
    app.setSetting('sync.key', 'TARGET-KEY')
    app.setSetting('sync.role', 'client')
    app.setSetting('backup.folder', join(t.dir, 'my-backups'))
    app.setSetting('billing.invoice_prefix', 'OLD')
    return t
  }

  it('replaces the data, keeps this laptop\'s identity, machine settings, bill counters and queue numbering', async () => {
    const src = await populatedSource()
    const file = await exportFrom(src)
    const want = shared(src.app)
    const dst = await usedTarget()
    const before = localTerminal(dst.app)
    const queueTop = dst.app.db.value<number>('SELECT MAX(id) FROM sync_queue')!
    expect(queueTop).toBeGreaterThan(0)
    const myNextBill = dst.app.db.value<number>("SELECT next_no FROM invoice_sequences WHERE series = 'INV-07'")!
    expect(myNextBill).toBe(3)

    // the screen warns about existing bills and the server insists on the extra confirmation
    const look = (await dst.app.call('transfer', 'inspect', { path: file })) as InspectResult
    expect(look.target).toMatchObject({ setupComplete: true, sales: 2, products: 2 })
    await expect(dst.app.call('transfer', 'import', { path: file, confirm: 'REPLACE' })).rejects.toThrow(/already has 2 bill/)
    expect(dst.app.db.value<number>('SELECT COUNT(*) FROM products')).toBe(2)

    const r = (await dst.app.call('transfer', 'import', { path: file, confirm: 'REPLACE', replaceSales: true })) as ImportResult
    expect(r.verified).toBe(true)
    expect(shared(dst.app)).toEqual(want) // incl. unit sequences: exactly the source's, the old local SPK numbers are gone with their units
    expect(dst.app.db.value<number>("SELECT COUNT(*) FROM products WHERE name LIKE 'Old %'")).toBe(0)

    // identity kept (same uuid, code, name), distinct from the source
    const me = localTerminal(dst.app)
    expect(me).toMatchObject({ uuid: before.uuid, code: 'POS-07', name: 'Back counter' })
    expect(r).toMatchObject({ identityCreated: false, codeChangedFrom: null })
    expect(me.uuid).not.toBe(localTerminal(src.app).uuid)
    expect(dst.app.db.value<number>('SELECT COUNT(*) FROM pos_terminals')).toBe(2)

    // this laptop's machine settings survive; the source's never arrive
    expect(setting(dst.app, 'sync.url')).toBe('http://192.168.1.20:8787')
    expect(setting(dst.app, 'sync.key')).toBe('TARGET-KEY')
    expect(setting(dst.app, 'sync.role')).toBe('client')
    expect(setting(dst.app, 'sync.enabled')).toBe('1')
    expect(setting(dst.app, 'backup.folder')).toBe(join(dst.dir, 'my-backups'))
    expect(setting(dst.app, 'backup.copy_folder')).toBeUndefined()
    expect(setting(dst.app, 'billing.invoice_prefix')).toBe('VM') // shared setting: the source's

    // the old queue is gone (its rows described data that no longer exists) but its numbers are never used again
    expect(dst.app.db.value<number>('SELECT COUNT(*) FROM sync_queue')).toBe(0)
    expect(dst.app.session).toBeNull()
    await dst.app.call('auth', 'login', { username: 'admin', password: ADMIN_PW })
    const sale = (await cashSale(dst.app, [{ variantId: src.plain.variantId, qty: 1 }])) as { invoiceNo: string }
    expect(dst.app.db.value<number>('SELECT MIN(id) FROM sync_queue')).toBeGreaterThan(queueTop)
    // ... and bill numbers continue after the ones this laptop already issued
    expect(sale.invoiceNo).toMatch(/^VM-07-\d{4}-000001$/) // new prefix => new series for this terminal
    expect(dst.app.db.value<number>("SELECT next_no FROM invoice_sequences WHERE series = 'INV-07'")).toBe(myNextBill)

    // the previous data of this laptop is in the automatic safety backup
    const safety = new DatabaseSync(r.safetyBackupPath, { readOnly: true })
    expect((safety.prepare("SELECT COUNT(*) c FROM products WHERE name LIKE 'Old %'").get() as { c: number }).c).toBe(2)
    expect((safety.prepare('SELECT COUNT(*) c FROM sales').get() as { c: number }).c).toBe(2)
    safety.close()
    expect(dst.app.db.value<number>("SELECT COUNT(*) FROM backups WHERE kind = 'safety'")).toBe(1)
    expect(dst.app.db.value<number>("SELECT COUNT(*) FROM audit_log WHERE entity='backup' AND action='transfer_import'")).toBe(1)
    // append-only guards are back
    expect(() => dst.app.db.run('DELETE FROM stock_movements')).toThrow(/append-only/)
  })

  it('two laptops that both call themselves POS-01: the importing one becomes POS-02', async () => {
    const src = await populatedSource()
    const file = await exportFrom(src)
    const dst = mk() // seeded: POS-01 / Counter 1, like the source
    const before = localTerminal(dst.app)
    const r = dst.svc.import({ path: file })
    expect(r).toMatchObject({ codeChangedFrom: 'POS-01', identityCreated: false, terminal: { uuid: before.uuid, code: 'POS-02', name: 'Counter 2' } })
    expect(dst.app.db.all<{ code: string }>('SELECT code FROM pos_terminals ORDER BY code').map((x) => x.code)).toEqual(['POS-01', 'POS-02'])
  })

  it('a laptop that carries the SOURCE identity (set up earlier by restoring a backup) gets its own identity', async () => {
    const src = await populatedSource()
    const file = await exportFrom(src)
    const dst = mk()
    const srcId = localTerminal(src.app)
    dst.app.db.run('UPDATE pos_terminals SET uuid = ? WHERE is_local = 1', srcId.uuid)
    expect(dst.svc.inspect(file).sameDevice).toBe(true)
    const r = dst.svc.import({ path: file })
    expect(r.identityCreated).toBe(true)
    expect(localTerminal(dst.app).uuid).not.toBe(srcId.uuid)
    expect(localTerminal(dst.app).code).toBe('POS-02')

    // importing a file back into the very laptop that exported it keeps the identity when the owner says so
    const again = await exportFrom(src)
    const back = src.svc.import({ path: again, sameLaptop: true })
    expect(back.identityCreated).toBe(false)
    expect(localTerminal(src.app)).toMatchObject({ uuid: srcId.uuid, code: 'POS-01' })
    expect(src.app.db.value<number>('SELECT COUNT(*) FROM pos_terminals')).toBe(1)
  })

  it('refuses a damaged or edited file and leaves this laptop exactly as it was', async () => {
    const src = await populatedSource()
    const file = await exportFrom(src)
    const dst = await usedTarget()
    const before = everything(dst.app)
    const session = dst.app.session
    const bytes = readFileSync(file)

    const cases: [string, Buffer, RegExp][] = []
    const flipped = Buffer.from(bytes); flipped[Math.floor(bytes.length / 2)] ^= 0xff
    cases.push(['byte flipped in the data', flipped, /damaged or was changed/])
    const header = Buffer.from(bytes); header[40] ^= 0x01
    cases.push(['byte flipped in the description', header, /damaged or was changed|cannot be read/])
    cases.push(['cut off', bytes.subarray(0, bytes.length - 4096), /incomplete or damaged/])
    cases.push(['not a transfer file', Buffer.from('PK\u0003\u0004 some other file, long enough to hold a header ............................'), /not a Velmayil/])
    // someone edits a price inside and leaves the checksum alone
    const edited = Buffer.from(bytes)
    const at = edited.indexOf(Buffer.from('Sparkler Box'))
    expect(at).toBeGreaterThan(0)
    edited.write('Sparkler Bux', at)
    cases.push(['content edited', edited, /damaged or was changed/])

    for (const [name, buf, why] of cases) {
      const bad = join(tmp('vxf-bad-'), 'bad.vmove')
      writeFileSync(bad, buf)
      const look = dst.svc.inspect(bad)
      expect(look.ok, name).toBe(false)
      expect(look.problems.join(' '), name).toMatch(why)
      await expect(dst.app.call('transfer', 'import', { path: bad, confirm: 'REPLACE', replaceSales: true }), name).rejects.toThrow(why)
      expect(everything(dst.app), name).toEqual(before)
      expect(dst.app.session, name).toBe(session)
    }
    await expect(dst.app.call('transfer', 'import', { path: join(dst.dir, 'missing.vmove'), confirm: 'REPLACE', replaceSales: true })).rejects.toThrow(/not found/)
    expect(everything(dst.app)).toEqual(before)
    expect(dst.app.db.value<number>("SELECT COUNT(*) FROM backups WHERE kind = 'safety'")).toBe(0) // refused before anything started
    expect(dst.app.db.value<number>("SELECT COUNT(*) FROM audit_log WHERE entity='transfer' AND action='import_refused'")).toBe(cases.length + 1)
    expect(readdirSync(join(dst.dir, 'transfer-tmp'))).toEqual([])
    // the good file still imports afterwards
    expect(dst.svc.import({ path: file }).verified).toBe(true)
  })

  it('refuses a file from a newer version of the app (target unchanged)', async () => {
    const src = await populatedSource()
    const file = await exportFrom(src)
    const newer = join(tmp('vxf-new-'), 'newer.vmove')
    repack(file, (payload) => {
      const d = new DatabaseSync(payload)
      d.exec("INSERT INTO schema_migrations(version,name,applied_at) VALUES (99999,'from_the_future',1); ALTER TABLE products ADD COLUMN hologram TEXT")
      d.close()
    }, newer)
    const dst = await usedTarget()
    const before = everything(dst.app)
    const look = dst.svc.inspect(newer)
    expect(look.ok).toBe(false)
    expect(look.problems[0]).toMatch(/newer version of the app.*Update the app on this laptop first/)
    expect(() => dst.svc.import({ path: newer })).toThrow(/newer version of the app/)
    expect(everything(dst.app)).toEqual(before)
  })

  it('is all-or-nothing: a failure after the data was replaced rolls everything back', async () => {
    const src = await populatedSource()
    const file = await exportFrom(src)
    const dst = await usedTarget()
    const before = everything(dst.app)
    const triggers = dst.app.db.value<number>("SELECT COUNT(*) FROM sqlite_master WHERE type='trigger'")
    dst.svc.failBeforeCommit = () => { throw new Error('power cut') }
    expect(() => dst.svc.import({ path: file })).toThrow(/power cut/)
    dst.svc.failBeforeCommit = undefined
    expect(everything(dst.app)).toEqual(before)
    expect(dst.app.session).not.toBeNull()
    expect(dst.app.db.value<number>("SELECT COUNT(*) FROM sqlite_master WHERE type='trigger'")).toBe(triggers)
    expect(dst.app.db.value<number>('PRAGMA foreign_keys')).toBe(1)
    // the backup engine's own injected failure in the middle of the table replacement
    const backup = dst.app.get<BackupService>('backup')
    backup.failAtTable = 'sales'
    expect(() => dst.svc.import({ path: file })).toThrow(/Injected failure/)
    backup.failAtTable = undefined
    expect(everything(dst.app)).toEqual(before)
    expect(dst.svc.import({ path: file }).verified).toBe(true)
  })
})

describe('older files and helpers', () => {
  it('a file from an older version (before unit codes existed) is brought up to date during the import', async () => {
    // build a genuine old-schema database: only the migrations up to 800
    const dir = tmp('vxf-old-')
    const oldPath = join(dir, 'old.db')
    const old = new Db(oldPath)
    runMigrations(old, allMigrations().filter((m) => m.version <= 800))
    expect(old.all<{ name: string }>('PRAGMA table_info(products)').some((c) => c.name === 'track_units')).toBe(false)
    old.run("INSERT INTO roles(name,permissions,is_system) VALUES ('Owner','[\"*\"]',1)")
    old.run("INSERT INTO users(uuid,username,name,role_id,password_hash) VALUES ('u-1','boss','Boss',1,?)", hashPassword(ADMIN_PW))
    old.run("INSERT INTO pos_terminals(uuid,code,name,is_local) VALUES ('old-terminal','POS-01','Counter 1',1)")
    old.run("INSERT INTO locations(uuid,name,is_default) VALUES ('loc-1','Main Store',1)")
    old.run("INSERT INTO business_profile_versions(uuid,version,shop_name,display_name,is_active) VALUES ('bp-1',1,'Old Shop','Old Shop',1)")
    old.run("INSERT INTO products(uuid,name) VALUES ('p-1','Old product')")
    old.run("INSERT INTO product_variants(uuid,product_id,sku,price) VALUES ('v-1',1,'OLD1',4200)")
    old.run('INSERT INTO stock_levels(variant_id,location_id,qty) VALUES (1,1,12)')
    old.run("INSERT INTO settings(key,value) VALUES ('setup.complete','1'), ('billing.invoice_prefix','OLD'), ('sync.key','OLD-KEY')")
    const summary = summarize(old)
    old.exec('PRAGMA journal_mode = DELETE')
    old.close()
    const info = describeFile(oldPath)
    expect(info.schemaVersion).toBe(800)
    const file = join(dir, 'old.vmove')
    writeContainer(oldPath, file, {
      format: 1, kind: 'everything', app: 'velmayil-pos', appVersion: '1.0.3', createdAt: 1_700_000_000_000,
      source: { deviceUuid: 'old-terminal', posCode: 'POS-01', posName: 'Counter 1', shopName: 'Old Shop' },
      schemaVersion: info.schemaVersion, schemaCount: info.schemaCount, payload: { sizeBytes: statSync(oldPath).size, sha256: sha256File(oldPath) },
      tables: info.tables, summary
    })

    const dst = mk({ seed: false })
    expect(dst.svc.inspect(file)).toMatchObject({ ok: true, file: { olderVersion: true, schemaVersion: 800 } })
    const r = dst.svc.import({ path: file })
    expect(r.migrationsRun).toContain(900)
    expect(r.verified).toBe(true)
    expect(dst.app.db.get('SELECT name, track_units, unit_prefix FROM products')).toEqual({ name: 'Old product', track_units: 0, unit_prefix: null })
    expect(dst.app.db.value<number>('SELECT price FROM product_variants')).toBe(4200)
    expect(dst.app.db.value<number>('SELECT qty FROM stock_levels')).toBe(12)
    expect(setting(dst.app, 'sync.key')).toBeUndefined()
    expect(setting(dst.app, 'inventory.allow_negative')).toBe('0') // defaults of settings the old version did not have
    expect(localTerminal(dst.app)).toMatchObject({ code: 'POS-02' })
    await dst.app.call('auth', 'login', { username: 'boss', password: ADMIN_PW })
    // the live schema is still the current one and fully usable
    const p = await CAT(dst.app, 'save', { name: 'New after import', variants: [{ name: '', price: 100, mrp: 100, cost: 50, openingStock: 1 }] })
    expect(p.id).toBe(2)
  })

  it('an export made before first-time setup is refused, and so is a file without users', async () => {
    const empty = mk({ seed: false })
    await expect(empty.svc.export({ path: tmp('vxf-usb-') })).rejects.toThrow(/first-time setup/)
    const src = await populatedSource()
    const file = await exportFrom(src)
    const nousers = join(tmp('vxf-nu-'), 'nousers.vmove')
    repack(file, (payload) => {
      const d = new DatabaseSync(payload)
      d.exec('PRAGMA foreign_keys = OFF; DROP TRIGGER IF EXISTS trg_users_no_delete; DELETE FROM users')
      d.close()
    }, nousers)
    const dst = mk()
    const before = everything(dst.app)
    expect(() => dst.svc.import({ path: nousers })).toThrow(/cannot be imported/)
    expect(everything(dst.app)).toEqual(before)
  })

  it('terminal codes: keeps a free code, avoids a code or bill-number series that is taken', () => {
    expect(pickTerminalCode('POS-07', ['POS-01'])).toBe('POS-07')
    expect(pickTerminalCode('POS-01', ['POS-01'])).toBe('POS-02')
    expect(pickTerminalCode(null, ['POS-01', 'POS-02'])).toBe('POS-03')
    expect(pickTerminalCode('SHOP-1', ['POS-01'])).toBe('POS-02') // both would number their bills in the plain series
    expect(pickTerminalCode('pos-01', ['POS-01', 'TILL2'])).toBe('POS-03')
    expect(isMachineSetting('sync.role')).toBe(true)
    expect(isMachineSetting('backup.folder')).toBe(true)
    expect(isMachineSetting('backup.retention')).toBe(false)
    expect(isMachineSetting('catalog.barcode_seq')).toBe(false)
  })

  it('the copy-on-USB scenario: the file can be copied and still verifies', async () => {
    const src = await populatedSource()
    const file = await exportFrom(src)
    const copy = join(tmp('vxf-copy-'), 'copied.vmove')
    copyFileSync(file, copy)
    expect(checkPayload(copy).payload.sha256).toBe(readHeader(file).header.payload.sha256)
  })
})

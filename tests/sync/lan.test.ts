import { describe, it, expect, afterEach } from 'vitest'
import net from 'node:net'
import http from 'node:http'
import {
  PRODUCT_CHILDREN, activeShopName, addProduct, addProfileVersion, cleanup, makePos, reopenPos, sqlSale, stockOf, type Pos
} from './harness'
import { discoverAdmins } from '../../src/main/modules/sync/discovery'
import { SHARED_SETTINGS } from '../../src/main/modules/sync/shared'
import type { SyncTransport } from '../../src/main/modules/sync/protocol'

/**
 * Admin system + Client system as two app instances (own SQLite files), linked through the server embedded in the
 * Admin's sync module over real HTTP on 127.0.0.1. Follows tests/sync/harness.ts: fixtures write rows + enqueueSnapshot
 * exactly like the producers do; cycles are either driven explicitly (syncNow) or by the real background loops.
 */
const live: Pos[] = []
afterEach(async () => {
  for (const p of live.splice(0)) {
    p.sync.stop()
    await p.sync.lanReady().catch(() => undefined)
  }
  await cleanup()
})

const track = (p: Pos): Pos => (live.push(p), p)
const count = (p: Pos, sql: string, ...a: (string | number)[]) => p.app.db.value<number>(sql, ...a) ?? 0
const priceOf = (p: Pos, sku: string) => p.app.db.value<number>('SELECT price FROM product_variants WHERE sku = ?', sku)
const setting = (p: Pos, key: string) => p.app.db.value<string>('SELECT value FROM settings WHERE key = ?', key)

async function until(what: string, fn: () => boolean, ms = 6000): Promise<number> {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (fn()) return Date.now() - t0
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`timed out after ${ms} ms waiting for: ${what}`)
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port
      s.close(() => resolve(port))
    })
  })
}

async function makeAdmin(port = 0): Promise<{ admin: Pos; port: number; code: string }> {
  const admin = track(makePos('POS-01'))
  admin.app.setSetting('sync.discovery_port', '0') // any free UDP port: tests must not fight over the real one
  admin.sync.saveConfig({ role: 'admin', port })
  const lan = await admin.sync.lanReady()
  expect(lan.problem).toBeNull()
  expect(lan.listening).toBe(true)
  return { admin, port: lan.port, code: admin.sync.pairingCode() }
}

function makeClient(port: number, code: string, posCode = 'POS-02'): Pos {
  const client = track(makePos(posCode))
  client.sync.saveConfig({ role: 'client', address: `127.0.0.1:${port}`, pairingCode: code })
  return client
}

async function pair(): Promise<{ admin: Pos; client: Pos; port: number; code: string }> {
  const a = await makeAdmin()
  return { ...a, client: makeClient(a.port, a.code) }
}

/** explicit cycles, both directions, until quiet */
async function settle(poss: Pos[], rounds = 3): Promise<void> {
  for (let r = 0; r < rounds; r++) for (const p of poss) expect((await p.sync.syncNow({ force: true })).error).toBeUndefined()
}

function setPrice(p: Pos, sku: string, price: number, updatedAt = Date.now()): void {
  p.app.db.transaction(() => {
    const v = p.app.db.get<{ id: number; product_id: number }>('SELECT id, product_id FROM product_variants WHERE sku = ?', sku)!
    p.app.db.run('UPDATE product_variants SET price = ?, updated_at = ? WHERE id = ?', price, updatedAt, v.id)
    p.app.db.run('UPDATE products SET updated_at = ? WHERE id = ?', updatedAt, v.product_id)
    p.app.enqueueSnapshot('products', v.product_id, PRODUCT_CHILDREN)
  })
  p.app.emitChange('catalog', 'save') // what App.call does after a service method that wrote
}

describe('roles', () => {
  it('stores the role under sync.role with the agreed values and keeps the pairing code out of the public config', async () => {
    const { admin, client, code } = await pair()
    expect(setting(admin, 'sync.role')).toBe('admin')
    expect(setting(client, 'sync.role')).toBe('client')
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/)
    expect(JSON.stringify(admin.sync.publicConfig())).not.toContain(code)
    expect(JSON.stringify(admin.sync.status())).not.toContain(code)
    expect(admin.sync.status().role).toBe('admin')
    expect(client.sync.publicConfig()).toMatchObject({ role: 'client', enabled: true, hasKey: true })
    expect(client.sync.pairingCode()).toBe('') // only the Admin shows a code

    client.sync.saveConfig({ role: 'standalone' })
    expect(setting(client, 'sync.role')).toBe('standalone')
    expect(client.sync.getConfig().enabled).toBe(false)
    expect((await client.sync.syncNow({ force: true })).skipped).toBe('sync is disabled')
  })

  it('client setup needs only an address and the code; bad input is explained', async () => {
    const { port, code } = await makeAdmin()
    const c = track(makePos('POS-02'))
    expect(() => c.sync.saveConfig({ role: 'client' })).toThrow(/address shown on the Admin/)
    expect(() => c.sync.saveConfig({ role: 'client', address: '127.0.0.1' })).toThrow(/pairing code/)
    expect(() => c.sync.saveConfig({ role: 'client', address: 'not an address!', pairingCode: code })).toThrow(/does not look like a network address/)
    // typed the way people type: lower case, spaces instead of the dash, with http:// in front
    c.sync.saveConfig({ role: 'client', address: ` http://127.0.0.1:${port}/ `, pairingCode: code.toLowerCase().replace('-', ' ') })
    expect(c.sync.publicConfig().address).toBe(`127.0.0.1:${port}`)
    const t = await c.sync.testConnection()
    expect(t.ok).toBe(true)
    expect(t.detail).toMatch(/Connected to the Admin system POS-01/)
  })
})

describe('admin -> client propagation', () => {
  it('a price change on the Admin reaches the Client (explicit cycles)', async () => {
    const { admin, client } = await pair()
    addProduct(admin.app, { name: 'Sparkler', sku: 'SPK', price: 10000, qty: 12, barcode: '200000001' })
    await settle([admin, client])
    expect(priceOf(client, 'SPK')).toBe(10000)
    expect(stockOf(client.app, 'SPK')).toBe(12)

    setPrice(admin, 'SPK', 12500)
    await settle([admin, client], 1)
    expect(priceOf(client, 'SPK')).toBe(12500)
    // what the billing screen uses for the next scan / search is the database, not a cache
    expect(client.app.lookup.byCode('200000001')?.price).toBe(12500)
    // an ordinary update is not a "conflict" on a terminal that never edited the record
    expect(count(client, 'SELECT COUNT(*) FROM sync_conflicts')).toBe(0)
    expect(count(admin, 'SELECT COUNT(*) FROM sync_conflicts')).toBe(0)
  })

  it('with the background loops running, a price change shows on the Client within a few seconds and open screens are told', async () => {
    const { admin, client } = await pair()
    addProduct(admin.app, { name: 'Rocket', sku: 'RKT', price: 5000, qty: 3 })
    const events: string[] = []
    client.app.onChange((e) => events.push(e.service))
    admin.sync.startBackground()
    client.sync.startBackground()
    await until('first catalog copy on the client', () => priceOf(client, 'RKT') === 5000)

    events.length = 0
    setPrice(admin, 'RKT', 5500)
    const ms = await until('new price on the client', () => priceOf(client, 'RKT') === 5500, 5000)
    expect(ms).toBeLessThan(3000)
    await until('live-refresh event on the client', () => events.includes('sync'), 1000) // useLiveRefresh treats 'sync' as "reload"

    // and the other way: a bill made on the Client reaches the Admin without anyone pressing a button
    const v = client.app.db.value<number>("SELECT id FROM product_variants WHERE sku = 'RKT'")!
    sqlSale(client.app, v, 1)
    client.app.emitChange('pos', 'completeSale')
    await until('the sale on the admin', () => count(admin, 'SELECT COUNT(*) FROM sales') === 1 && stockOf(admin.app, 'RKT') === 2)
  })

  it('the real catalog module: a spreadsheet price edit on the Admin arrives on the Client', async () => {
    const { admin, client } = await pair()
    if (!admin.app.has('catalog')) return console.warn('SKIPPED: catalog module not registered')
    admin.sync.startBackground()
    client.sync.startBackground()
    await admin.app.call('catalog', 'save', { name: 'Flower Pot', taxRateBp: 1800, variants: [{ sku: 'FP1', price: 9000, openingStock: 4 }] })
    await until('product on the client', () => priceOf(client, 'FP1') === 9000)
    const variantId = admin.app.db.value<number>("SELECT id FROM product_variants WHERE sku = 'FP1'")!
    await admin.app.call('catalog', 'bulkUpdate', { rows: [{ variantId, patch: { price: 9900 } }] })
    const ms = await until('new price on the client', () => priceOf(client, 'FP1') === 9900, 5000)
    expect(ms).toBeLessThan(3000)
  })

  it('shop-wide settings and print templates go Admin -> Client; per-machine settings do not', async () => {
    const { admin, client } = await pair()
    await settle([admin, client])
    // shared: billing behaviour, barcode numbering, a receipt template
    admin.app.setSetting('pos.round_off', '0')
    admin.app.setSetting('billing.invoice_prefix', 'VM')
    admin.app.setSetting('catalog.barcode_prefix', '777')
    admin.app.setSetting('catalog.barcode_width', '5')
    admin.app.db.run(
      `INSERT INTO print_templates(kind,name,config_json,is_default,updated_at) VALUES ('receipt80','Default',?,1,?)
       ON CONFLICT(kind,name) DO UPDATE SET config_json = excluded.config_json, is_default = 1, updated_at = excluded.updated_at`,
      JSON.stringify({ footerText: 'Thank you, visit again' }), Date.now()
    )
    // per machine: must stay where they were set
    admin.app.setSetting('backup.folder', 'D:\\AdminBackups')
    admin.app.setSetting('catalog.barcode_seq', '4321')
    admin.app.setSetting('sync.interval', '99')
    admin.app.db.run("INSERT INTO printer_profiles(name,device_name,kind) VALUES ('Admin thermal','EPSON TM-T82 on ADMIN','receipt80')")
    const before = { backup: setting(client, 'backup.folder'), seq: setting(client, 'catalog.barcode_seq'), interval: setting(client, 'sync.interval') }

    await settle([admin, client])
    expect(setting(client, 'pos.round_off')).toBe('0')
    expect(setting(client, 'billing.invoice_prefix')).toBe('VM')
    expect(setting(client, 'catalog.barcode_prefix')).toBe('777')
    expect(setting(client, 'catalog.barcode_width')).toBe('5')
    expect(client.app.db.value<string>("SELECT config_json FROM print_templates WHERE kind = 'receipt80' AND is_default = 1")).toContain('visit again')

    expect(setting(client, 'backup.folder')).toBe(before.backup)
    expect(setting(client, 'backup.folder')).not.toBe('D:\\AdminBackups')
    expect(setting(client, 'catalog.barcode_seq')).toBe(before.seq)
    expect(setting(client, 'sync.interval')).toBe(before.interval)
    expect(setting(client, 'sync.role')).toBe('client')
    expect(count(client, "SELECT COUNT(*) FROM printer_profiles WHERE name = 'Admin thermal'")).toBe(0)
    // nothing per-machine was even put on the wire
    const sent = admin.app.db.all<{ entity_uuid: string }>("SELECT entity_uuid FROM sync_queue WHERE entity = 'settings'").map((r) => r.entity_uuid)
    expect(sent.length).toBeGreaterThan(0)
    const shared = new Set(SHARED_SETTINGS.map((s) => s.key))
    expect(sent.every((k) => shared.has(k))).toBe(true)
    expect(sent.some((k) => /^(sync|backup|setup)\./.test(k) || k.endsWith('_seq'))).toBe(false)

    // the Admin decides: a shared setting changed on the Client is put back, and never travels to the Admin
    client.app.setSetting('pos.round_off', '1')
    client.app.setSetting('backup.folder', 'E:\\ClientBackups') // per machine: the Client keeps its own
    await settle([client, admin])
    expect(setting(client, 'pos.round_off')).toBe('0')
    expect(setting(admin, 'pos.round_off')).toBe('0')
    expect(setting(client, 'backup.folder')).toBe('E:\\ClientBackups')
    expect(setting(admin, 'backup.folder')).toBe('D:\\AdminBackups')
    expect(count(client, "SELECT COUNT(*) FROM audit_log WHERE action = 'shared_settings_restored'")).toBe(1)

    // an unchanged cycle sends nothing again
    const q = count(admin, "SELECT COUNT(*) FROM sync_queue WHERE entity IN ('settings','print_templates')")
    await settle([admin, client])
    expect(count(admin, "SELECT COUNT(*) FROM sync_queue WHERE entity IN ('settings','print_templates')")).toBe(q)
  })

  it('shared settings are not accepted from anyone but the Admin system', async () => {
    const { admin, client } = await pair()
    await settle([admin, client])
    const was = setting(admin, 'pos.round_off')
    // a client forges a "shared setting" change (and even claims to be the Admin): the Admin ignores it, other clients too
    client.app.enqueueSync('settings', 'pos.round_off', 'upsert', { table: 'settings', uuid: 'pos.round_off', row: { key: 'pos.round_off', value: 'X', updated_at: Date.now() }, refs: {}, meta: { shared: true } })
    const third = makeClient(admin.sync.lanPort()!, admin.sync.pairingCode(), 'POS-03')
    await settle([client, admin, third])
    expect(setting(admin, 'pos.round_off')).toBe(was)
    expect(setting(third, 'pos.round_off')).not.toBe('X')
  })
})

describe('authority', () => {
  it('a price edited on the Client goes to the Admin (newest wins there); the Admin\'s copy always wins on the Client, whatever the clocks say', async () => {
    const { admin, client } = await pair()
    addProduct(admin.app, { name: 'Chakkar', sku: 'CHK', price: 2000, updatedAt: 1_000_000 })
    await settle([admin, client])

    // 1. client edits later than the admin's copy: allowed, reaches the admin
    setPrice(client, 'CHK', 2200, 2_000_000)
    await settle([client, admin, client])
    expect(priceOf(admin, 'CHK')).toBe(2200)
    expect(priceOf(client, 'CHK')).toBe(2200)

    // 2. the client's clock is far ahead; the admin then changes the price. The admin still wins on the client.
    setPrice(client, 'CHK', 2300, Date.now() + 365 * 24 * 3600_000)
    await settle([client, admin, client])
    expect(priceOf(admin, 'CHK')).toBe(2300)
    setPrice(admin, 'CHK', 2500) // "now" is older than the client's future timestamp
    await settle([admin, client])
    expect(priceOf(client, 'CHK')).toBe(2500)
    expect(priceOf(admin, 'CHK')).toBe(2500)

    // 3. the client's clock is behind: its edit loses on the admin, and the admin sends its copy back so they agree again
    setPrice(admin, 'CHK', 2600, Date.now() + 2 * 365 * 24 * 3600_000)
    await settle([admin, client])
    setPrice(client, 'CHK', 1111, 5_000_000)
    expect(priceOf(client, 'CHK')).toBe(1111)
    await settle([client, admin, client])
    expect(priceOf(admin, 'CHK')).toBe(2600)
    expect(priceOf(client, 'CHK')).toBe(2600)
    expect(count(admin, "SELECT COUNT(*) FROM sync_conflicts WHERE kind = 'lww_lost_remote'")).toBeGreaterThan(0)
    expect(count(client, "SELECT COUNT(*) FROM sync_conflicts WHERE kind = 'lww_lost_local'")).toBeGreaterThan(0) // the cashier's edit is listed as replaced
  })

  it('a Client set up later does not replace the shop name of the Admin', async () => {
    const admin = track(makePos('POS-01', { sameProfile: false }))
    admin.app.setSetting('sync.discovery_port', '0')
    admin.app.db.exec('DROP TRIGGER IF EXISTS trg_bpv_immutable')
    admin.app.db.run("UPDATE business_profile_versions SET shop_name = 'Velmayil Crackers', display_name = 'Velmayil Crackers', created_at = 1000")
    admin.sync.saveConfig({ role: 'admin', port: 0 })
    const lan = await admin.sync.lanReady()
    const client = track(makePos('POS-02', { sameProfile: false }))
    client.app.db.exec('DROP TRIGGER IF EXISTS trg_bpv_immutable')
    client.app.db.run("UPDATE business_profile_versions SET shop_name = 'typed in a hurry', display_name = 'typed in a hurry', created_at = 9000") // newer than the admin's
    client.sync.saveConfig({ role: 'client', address: `127.0.0.1:${lan.port}`, pairingCode: admin.sync.pairingCode() })
    await settle([admin, client, admin, client])
    expect(activeShopName(admin.app)).toBe('Velmayil Crackers')
    expect(activeShopName(client.app)).toBe('Velmayil Crackers')
    expect(count(admin, 'SELECT COUNT(*) FROM business_profile_versions WHERE is_active = 1')).toBe(1)
    expect(count(client, 'SELECT COUNT(*) FROM business_profile_versions WHERE is_active = 1')).toBe(1)

    // a later change of the shop details on the Admin is adopted by the Client
    addProfileVersion(admin.app, { shopName: 'Velmayil Crackers & Sweets' })
    await settle([admin, client])
    expect(activeShopName(client.app)).toBe('Velmayil Crackers & Sweets')
    // one typed on the Client is kept as history but does not take over either machine
    addProfileVersion(client.app, { shopName: 'changed at the counter' })
    await settle([client, admin, client])
    expect(activeShopName(admin.app)).toBe('Velmayil Crackers & Sweets')
    expect(activeShopName(client.app)).toBe('Velmayil Crackers & Sweets')
  })
})

describe('never blocks billing: disconnects', () => {
  it('disconnect, keep working on both sides, reconnect: everything catches up and nothing is given up on', async () => {
    const port = await freePort()
    const { admin, code } = await makeAdmin(port)
    const client = makeClient(port, code)
    const a = addProduct(admin.app, { name: 'Bijili', sku: 'BJ', price: 100, qty: 50 })
    await settle([admin, client])
    expect(stockOf(client.app, 'BJ')).toBe(50)

    // --- cable pulled: the Admin's server is no longer reachable
    const server = (admin.sync as unknown as { server: { stop(): Promise<void>; start(p: number): Promise<unknown> } }).server
    await server.stop()
    const t0 = Date.now()
    const r = await client.sync.syncNow({ force: true })
    expect(Date.now() - t0).toBeLessThan(10_000) // bounded by the timeouts, never hangs
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/Admin/)
    expect(r.error).not.toMatch(/ECONNREFUSED|fetch failed|at .*\.ts/)
    let st = client.sync.status()
    expect(st.online).toBe(false)
    expect(st.errorKind).toBe('network')

    // billing goes on, on both laptops
    const cv = client.app.db.value<number>("SELECT id FROM product_variants WHERE sku = 'BJ'")!
    const s1 = sqlSale(client.app, cv, 3)
    const s2 = sqlSale(client.app, cv, 2)
    sqlSale(admin.app, a.variantId, 5)
    setPrice(admin, 'BJ', 150)
    admin.app.setSetting('pos.round_off', '0')
    expect(stockOf(client.app, 'BJ')).toBe(45)
    expect((await admin.sync.syncNow({ force: true })).ok).toBe(true) // the Admin's own cycle never needs the network

    // many failed attempts while the cable is out: nothing is marked as failed, nothing is dropped
    for (let i = 0; i < 15; i++) expect((await client.sync.syncNow({ force: true })).ok).toBe(false)
    st = client.sync.status()
    expect(st.failed).toBe(0)
    expect(st.pending).toBeGreaterThan(0)
    expect(st.backoffUntil ?? 0).toBeLessThanOrEqual(Date.now())
    expect(priceOf(client, 'BJ')).toBe(100) // still the old price: it could not know yet

    // --- cable back
    await server.start(port)
    await settle([client, admin, client])
    st = client.sync.status()
    expect(st.pending).toBe(0)
    expect(st.online).toBe(true)
    expect(st.lastError).toBeNull()
    expect(priceOf(client, 'BJ')).toBe(150)
    expect(setting(client, 'pos.round_off')).toBe('0')
    for (const p of [admin, client]) {
      expect(count(p, 'SELECT COUNT(*) FROM sales')).toBe(3)
      expect(stockOf(p.app, 'BJ')).toBe(40)
    }
    expect(count(admin, 'SELECT COUNT(*) FROM sales WHERE uuid IN (?,?)', s1.uuid, s2.uuid)).toBe(2)
  })

  it('with the background loops: the Client reconnects by itself after the cable returns', async () => {
    const port = await freePort()
    const { admin, code } = await makeAdmin(port)
    const client = makeClient(port, code)
    addProduct(admin.app, { name: 'Atom', sku: 'ATM', price: 700, qty: 9 })
    admin.sync.startBackground()
    client.sync.startBackground()
    await until('first copy', () => priceOf(client, 'ATM') === 700)

    const server = (admin.sync as unknown as { server: { stop(): Promise<void>; start(p: number): Promise<unknown> } }).server
    await server.stop()
    await until('client notices it is offline', () => client.sync.status().online === false, 8000)
    setPrice(admin, 'ATM', 800)
    const v = client.app.db.value<number>("SELECT id FROM product_variants WHERE sku = 'ATM'")!
    sqlSale(client.app, v, 4)
    client.app.emitChange('pos', 'completeSale')
    await new Promise((r) => setTimeout(r, 300))
    expect(priceOf(client, 'ATM')).toBe(700)

    await server.start(port)
    await until('price after reconnect', () => priceOf(client, 'ATM') === 800, 20_000)
    await until('sale after reconnect', () => count(admin, 'SELECT COUNT(*) FROM sales') === 1 && stockOf(admin.app, 'ATM') === 5, 10_000)
    expect(client.sync.status().online).toBe(true)
  }, 45_000)

  it('cable pulled in the middle of a transfer: replies that never arrive cause no duplicates and no gaps', async () => {
    const { admin, client } = await pair()
    const a = addProduct(admin.app, { name: 'Lakshmi', sku: 'LK', price: 300, qty: 20 })
    for (let i = 0; i < 30; i++) addProduct(admin.app, { name: `Item ${i}`, sku: `IT${i}`, price: 100 + i, qty: 1 })
    await admin.sync.syncNow({ force: true })

    // the client's requests reach the Admin, but the answers are lost (twice for push, once for pull)
    const real = client.sync.transport.bind(client.sync)
    let lose = { push: 2, pull: 1 }
    client.sync.transport = (): SyncTransport => {
      const t = real()
      return {
        kind: t.kind,
        ping: () => t.ping(),
        push: async (d, c) => {
          const r = await t.push(d, c)
          if (lose.push-- > 0) throw new Error('connection lost')
          return r
        },
        pull: async (d, c, l) => {
          const r = await t.pull(d, c, l)
          if (lose.pull-- > 0) throw new Error('connection lost')
          return r
        }
      }
    }
    sqlSale(client.app, addProduct(client.app, { name: 'Client only', sku: 'CO', price: 50, qty: 5 }).variantId, 2)
    let fails = 0
    for (let i = 0; i < 8; i++) if (!(await client.sync.syncNow({ force: true })).ok) fails++
    expect(fails).toBeGreaterThanOrEqual(3)
    lose = { push: 0, pull: 0 }
    await settle([client, admin, client])

    for (const p of [admin, client]) {
      expect(count(p, 'SELECT COUNT(*) FROM products')).toBe(32)
      expect(count(p, 'SELECT COUNT(*) FROM product_variants')).toBe(32)
      expect(count(p, 'SELECT COUNT(*) FROM sales')).toBe(1)
      expect(count(p, 'SELECT COUNT(*) FROM sale_items')).toBe(1)
      expect(stockOf(p.app, 'CO')).toBe(3)
      expect(stockOf(p.app, 'LK')).toBe(20)
      // ledger == balance on both machines
      expect(count(p, 'SELECT COUNT(*) FROM stock_levels l WHERE l.qty <> (SELECT COALESCE(SUM(m.qty_delta),0) FROM stock_movements m WHERE m.variant_id = l.variant_id AND m.location_id = l.location_id)')).toBe(0)
    }
    expect(a.variantId).toBeGreaterThan(0)
  })

  it('the Admin laptop is switched off and on again: its store survives and the Client carries on', async () => {
    const port = await freePort()
    let { admin, code } = await makeAdmin(port)
    const client = makeClient(port, code)
    addProduct(admin.app, { name: 'Persist', sku: 'PER', price: 400, qty: 6 })
    await settle([admin, client])
    const cursor = client.sync.status().cursor

    // power off
    admin.sync.stop()
    await admin.sync.lanReady()
    const cv = client.app.db.value<number>("SELECT id FROM product_variants WHERE sku = 'PER'")!
    sqlSale(client.app, cv, 1)
    expect((await client.sync.syncNow({ force: true })).ok).toBe(false)

    // power on: same database file, same data folder
    admin = track(reopenPos(admin))
    const lan = await admin.sync.lanReady()
    expect(lan.listening).toBe(true)
    expect(lan.port).toBe(port)
    expect(admin.sync.pairingCode()).toBe(code) // the owner does not have to pair again
    const queuedBefore = count(admin, 'SELECT COUNT(*) FROM sync_queue')

    // a brand-new client joining now still gets the full history from the persisted store
    const late = makeClient(port, code, 'POS-03')
    await settle([client, admin, late, client])
    expect(count(admin, 'SELECT COUNT(*) FROM sales')).toBe(1)
    expect(stockOf(admin.app, 'PER')).toBe(5)
    expect(stockOf(late.app, 'PER')).toBe(5)
    expect(priceOf(late, 'PER')).toBe(400)
    // same store as before the restart: the Admin did not have to queue everything again, the Client kept its place
    expect(count(admin, "SELECT COUNT(*) FROM sync_queue WHERE entity = 'products'")).toBe(1)
    expect(queuedBefore).toBeGreaterThan(0)
    expect(client.sync.status().cursor!.split(':')[0]).toBe(cursor!.split(':')[0])
  })
})

describe('pairing code', () => {
  it('a wrong pairing code is rejected: nothing goes either way, the message says what to do, the right code fixes it', async () => {
    const { admin, port, code } = await makeAdmin()
    addProduct(admin.app, { name: 'Secret', sku: 'SEC', price: 999 })
    await admin.sync.syncNow({ force: true })
    const wrong = code === 'AAAA-AAAA' ? 'BBBB-BBBB' : 'AAAA-AAAA'
    const client = makeClient(port, wrong)
    addProduct(client.app, { name: 'Intruder', sku: 'INT', price: 1 })

    const r = await client.sync.syncNow({ force: true })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/pairing code is not correct/)
    const st = client.sync.status()
    expect(st.errorKind).toBe('auth')
    expect(st.pending).toBeGreaterThan(0) // kept for later, not lost
    const t = await client.sync.testConnection()
    expect(t).toMatchObject({ ok: false, kind: 'auth' })
    expect(t.error).toMatch(/pairing code/)
    await admin.sync.syncNow({ force: true })
    expect(count(admin, "SELECT COUNT(*) FROM product_variants WHERE sku = 'INT'")).toBe(0)
    expect(count(client, "SELECT COUNT(*) FROM product_variants WHERE sku = 'SEC'")).toBe(0)
    expect(admin.sync.lanInfo().clients).toHaveLength(0)

    // straight at the wire: no code / wrong code -> 401 on every data route; /health tells nothing secret
    const base = `http://127.0.0.1:${port}`
    for (const path of ['/status', '/pull?since=0&device=x', '/wait?since=0&device=x&wait=0']) {
      expect((await fetch(base + path)).status).toBe(401)
      expect((await fetch(base + path, { headers: { Authorization: `Bearer ${wrong}` } })).status).toBe(401)
    }
    expect((await fetch(base + '/push', { method: 'POST', body: '{}', headers: { Authorization: 'Bearer nope' } })).status).toBe(401)
    const health = await (await fetch(base + '/health')).text()
    expect(health).toContain('velmayil-pos')
    expect(health).not.toContain(code)

    // "Test connection" with what is typed, before saving
    expect((await client.sync.testConnection({ address: `127.0.0.1:${port}`, pairingCode: code })).ok).toBe(true)
    client.sync.saveConfig({ pairingCode: code })
    await settle([client, admin, client])
    expect(count(admin, "SELECT COUNT(*) FROM product_variants WHERE sku = 'INT'")).toBe(1)
    expect(priceOf(client, 'SEC')).toBe(999)
    expect(client.sync.status().lastError).toBeNull()
  })

  it('a new pairing code on the Admin locks out the old one at once', async () => {
    const { admin, client, code } = await pair()
    await settle([admin, client])
    admin.sync.saveConfig({ newPairingCode: true })
    const fresh = admin.sync.pairingCode()
    expect(fresh).not.toBe(code)
    expect((await client.sync.syncNow({ force: true })).error).toMatch(/pairing code/)
    client.sync.saveConfig({ pairingCode: fresh })
    expect((await client.sync.syncNow({ force: true })).ok).toBe(true)
  })

  it('repeated wrong codes from one address are slowed down', async () => {
    const { port } = await makeAdmin()
    let last = 0
    for (let i = 0; i < 40; i++) last = (await fetch(`http://127.0.0.1:${port}/status`, { headers: { Authorization: 'Bearer GUESS' + i } })).status
    expect(last).toBe(429)
  })
})

describe('plain-language problems', () => {
  it('port already in use: the owner is told in words, the POS keeps working, a free port fixes it', async () => {
    const blocker = net.createServer()
    const busy = await new Promise<number>((resolve) => blocker.listen(0, '0.0.0.0', () => resolve((blocker.address() as net.AddressInfo).port)))
    try {
      const admin = track(makePos('POS-01'))
      admin.app.setSetting('sync.discovery_port', '0')
      admin.sync.saveConfig({ role: 'admin', port: busy })
      const lan = await admin.sync.lanReady()
      expect(lan.listening).toBe(false)
      expect(lan.problem).toMatch(new RegExp(`Port ${busy} is already being used by another program`))
      expect(lan.problem).not.toMatch(/EADDRINUSE|Error:|\bat\b .*:\d+/)
      const t = await admin.sync.testConnection()
      expect(t.ok).toBe(false)
      expect(t.error).toMatch(/already being used/)
      // the Admin itself is not held up: its own changes are stored for the client meanwhile
      addProduct(admin.app, { name: 'Still works', sku: 'SW', price: 10 })
      expect((await admin.sync.syncNow({ force: true })).ok).toBe(true)
      expect(admin.sync.status().pending).toBe(0)

      admin.sync.saveConfig({ port: 0 })
      const ok = await admin.sync.lanReady()
      expect(ok.listening).toBe(true)
      expect(ok.problem).toBeNull()
      const client = makeClient(ok.port, admin.sync.pairingCode())
      await settle([client])
      expect(priceOf(client, 'SW')).toBe(10)
    } finally {
      await new Promise((r) => blocker.close(r))
    }
  })

  it('test connection explains: nothing there, not a Velmayil Admin, a copy of the Admin, the same terminal code', async () => {
    const { admin, port, code } = await makeAdmin()
    const dead = await freePort()
    const c = track(makePos('POS-01')) // same code as the Admin, as after two default installs
    const none = await c.sync.testConnection({ address: `127.0.0.1:${dead}`, pairingCode: code })
    expect(none.ok).toBe(false)
    expect(none.error).toMatch(/Velmayil v3 is not accepting connections there|Cannot reach the Admin system|No answer from the Admin system/)
    expect(none.error).not.toMatch(/ECONNREFUSED|fetch failed/)

    const other = http.createServer((_q, res) => res.end('{}'))
    const otherPort = await new Promise<number>((resolve) => other.listen(0, '127.0.0.1', () => resolve((other.address() as net.AddressInfo).port)))
    try {
      const r = await c.sync.testConnection({ address: `127.0.0.1:${otherPort}`, pairingCode: code })
      expect(r.ok).toBe(false)
      expect(r.error).toMatch(/not a Velmayil v3 Admin system/)
    } finally {
      other.closeAllConnections()
      await new Promise((r) => other.close(r))
    }

    const ok = await c.sync.testConnection({ address: `127.0.0.1:${port}`, pairingCode: code })
    expect(ok.ok).toBe(true)
    expect(ok.warning).toMatch(/Both computers use the terminal code POS-01/)

    // a laptop whose database is a copy of the Admin's (same terminal identity) is told so instead of silently receiving nothing
    c.app.db.run('UPDATE pos_terminals SET uuid = ? WHERE is_local = 1', admin.sync.device().uuid)
    const same = await c.sync.testConnection({ address: `127.0.0.1:${port}`, pairingCode: code })
    expect(same).toMatchObject({ ok: false, kind: 'identity' })
    c.sync.saveConfig({ role: 'client', address: `127.0.0.1:${port}`, pairingCode: code })
    const r = await c.sync.syncNow({ force: true })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/same terminal identity/)
    expect(c.sync.status().errorKind).toBe('identity')
  })

  it('the Admin shows its addresses and which clients are connected', async () => {
    const { admin, client } = await pair()
    await settle([client])
    const lan = admin.sync.lanInfo()
    expect(lan.listening).toBe(true)
    expect(lan.clients).toHaveLength(1)
    expect(lan.clients[0]).toMatchObject({ code: 'POS-02', connected: true, address: '127.0.0.1' })
    for (const a of lan.addresses) expect(a.address).toMatch(/^\d+\.\d+\.\d+\.\d+$/)
    expect(client.sync.lanInfo()).toMatchObject({ role: 'client', adminCode: '', clients: [] })
    await client.sync.testConnection()
    expect(client.sync.lanInfo().adminCode).toBe('POS-01')
  })
})

describe('finding the Admin on the LAN', () => {
  it('the Admin answers a discovery question with its port, never with the pairing code', async () => {
    const { admin, port, code } = await makeAdmin()
    const dport = admin.sync.discoveryListeningPort()!
    expect(dport).toBeGreaterThan(0)
    const found = await discoverAdmins({ port: dport, targets: ['127.0.0.1'], timeoutMs: 600 })
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ address: '127.0.0.1', port, code: 'POS-01' })
    expect(JSON.stringify(found)).not.toContain(code)

    const c = track(makePos('POS-02'))
    c.app.setSetting('sync.discovery_port', String(dport))
    c.sync.discoveryTargets = ['127.0.0.1']
    const list = await c.sync.discover()
    expect(list[0].label).toBe(`127.0.0.1:${port}`)
    // nobody there: an empty list after the timeout, not an error
    admin.sync.stop()
    expect(await discoverAdmins({ port: dport, targets: ['127.0.0.1'], timeoutMs: 400 })).toEqual([])
  })

  it('when the Admin moves to another address / port, the Client finds it again by itself', async () => {
    const { admin, port, code } = await makeAdmin()
    addProduct(admin.app, { name: 'Moved', sku: 'MV', price: 321 })
    await admin.sync.syncNow({ force: true })
    const stale = await freePort()
    const client = track(makePos('POS-02'))
    client.app.setSetting('sync.discovery_port', String(admin.sync.discoveryListeningPort()))
    client.sync.discoveryTargets = ['127.0.0.1']
    client.sync.saveConfig({ role: 'client', address: `127.0.0.1:${stale}`, pairingCode: code })
    client.sync.startBackground()
    await until('client found the admin and synced', () => priceOf(client, 'MV') === 321, 20_000)
    expect(client.sync.publicConfig().address).toBe(`127.0.0.1:${port}`)
  }, 30_000)
})

describe('quiet when nothing happens', () => {
  it('an idle link writes nothing to either database (no needless screen refreshes), and repeated failures write nothing either', async () => {
    const port = await freePort()
    const { admin, code } = await makeAdmin(port)
    const client = makeClient(port, code)
    addProduct(admin.app, { name: 'Quiet', sku: 'QT', price: 10, qty: 1 })
    await settle([admin, client, admin, client])
    const changes = (p: Pos) => p.app.db.value<number>('SELECT total_changes()')!
    const a0 = changes(admin)
    const c0 = changes(client)
    await settle([admin, client, admin, client])
    expect(changes(admin)).toBe(a0)
    expect(changes(client)).toBe(c0)

    const server = (admin.sync as unknown as { server: { stop(): Promise<void> } }).server
    await server.stop()
    await client.sync.syncNow({ force: true }) // the first failures record "offline" + the reason (connection dropped, then refused)
    await client.sync.syncNow({ force: true })
    const c1 = changes(client)
    for (let i = 0; i < 5; i++) await client.sync.syncNow({ force: true })
    expect(changes(client)).toBe(c1)
  })

  it('the long-poll answers at once when the Admin has news and stays silent otherwise', async () => {
    const { admin, client, port, code } = await pair()
    await settle([admin, client])
    const dev = client.sync.device().uuid
    const cursor = encodeURIComponent(client.sync.status().cursor!)
    const ask = (wait: number) => fetch(`http://127.0.0.1:${port}/wait?since=${cursor}&device=${dev}&wait=${wait}`, { headers: { Authorization: `Bearer ${code}` } }).then((r) => r.json() as Promise<{ changed: boolean }>)
    const t0 = Date.now()
    expect((await ask(1)).changed).toBe(false)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900)
    const pending = ask(20)
    setTimeout(() => { addProduct(admin.app, { name: 'News', sku: 'NW', price: 1 }); void admin.sync.syncNow({ force: true }) }, 200)
    const t1 = Date.now()
    expect((await pending).changed).toBe(true)
    expect(Date.now() - t1).toBeLessThan(3000)
  })
})

describe('second laptop filled from the Admin\'s export file', () => {
  it('does not upload the whole shop back on the first link; what it creates afterwards still flows', async () => {
    const { admin, port, code } = await makeAdmin()
    const a = addProduct(admin.app, { name: 'Copied', sku: 'CP', price: 800, qty: 7 })
    await admin.sync.syncNow({ force: true })

    // state after modules/transfer import: same rows (same uuids) as the Admin, own terminal identity, empty sync bookkeeping, bootstrapped
    const client = track(makePos('POS-02'))
    const p = admin.app.db.get<{ uuid: string; name: string; updated_at: number }>('SELECT uuid, name, updated_at FROM products WHERE id = ?', a.productId)!
    const v = admin.app.db.get<{ uuid: string; sku: string; price: number; updated_at: number }>('SELECT uuid, sku, price, updated_at FROM product_variants WHERE id = ?', a.variantId)!
    const pid = client.app.db.run('INSERT INTO products(uuid,name,updated_at) VALUES (?,?,?)', p.uuid, p.name, p.updated_at).lastId
    client.app.db.run('INSERT INTO product_variants(uuid,product_id,sku,price,updated_at) VALUES (?,?,?,?,?)', v.uuid, pid, v.sku, v.price, v.updated_at)
    client.app.db.run("INSERT INTO sync_state(key,value) VALUES ('bootstrapped','1')")
    client.sync.saveConfig({ role: 'client', address: `127.0.0.1:${port}`, pairingCode: code })

    await settle([client, admin, client])
    expect(count(client, 'SELECT COUNT(*) FROM sync_queue')).toBe(0) // nothing was sent back
    expect(admin.sync.lanInfo().clients[0]?.code).toBe('POS-02')
    expect(count(client, 'SELECT COUNT(*) FROM products')).toBe(1) // the Admin's copy matched the imported one, no duplicate
    expect(stockOf(client.app, 'CP')).toBe(7)

    setPrice(admin, 'CP', 850)
    const cv = client.app.db.value<number>("SELECT id FROM product_variants WHERE sku = 'CP'")!
    sqlSale(client.app, cv, 2)
    await settle([admin, client, admin])
    expect(priceOf(client, 'CP')).toBe(850)
    expect(count(admin, 'SELECT COUNT(*) FROM sales')).toBe(1)
    expect(stockOf(admin.app, 'CP')).toBe(5)
    expect(stockOf(client.app, 'CP')).toBe(5)
  })
})

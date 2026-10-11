import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  FAKE_LOGO, KEY, activeShopName, addProduct, addProfileVersion, cleanup, editProduct, makePos, movementSum, reopenPos, settle,
  sqlSale, startServer, stockOf, useFolder, useHttp
} from './harness'
import type { RemoteChange } from '../../src/main/modules/sync/protocol'

afterEach(cleanup)

const count = (p: { app: import('../../src/main/core/app').App }, sql: string, ...a: (string | number)[]) => p.app.db.value<number>(sql, ...a) ?? 0

describe('sync over HTTP (reference server)', () => {
  it('catalog created on POS-1 appears on POS-2 (with barcode alias and opening stock)', async () => {
    const srv = await startServer()
    const p1 = makePos('POS-01')
    const p2 = makePos('POS-02')
    useHttp(p1, srv.url)
    useHttp(p2, srv.url)
    addProduct(p1.app, { name: 'Sparkler 10cm', sku: 'SPK10', price: 2500, qty: 40, barcode: '890100', alias: 'ALIAS-SPK' })
    await settle([p1, p2])

    const v = p2.app.lookup.byCode('ALIAS-SPK')
    expect(v?.productName).toBe('Sparkler 10cm')
    expect(p2.app.lookup.byCode('890100')?.sku).toBe('SPK10')
    expect(stockOf(p2.app, 'SPK10')).toBe(40)
    expect(stockOf(p1.app, 'SPK10')).toBe(40)
    expect(p1.sync.status().pending).toBe(0)
  })

  it('profile (shop name + logo) change on POS-1 reaches POS-2 and getActive returns it', async () => {
    const srv = await startServer()
    const p1 = makePos('POS-01')
    const p2 = makePos('POS-02')
    useHttp(p1, srv.url)
    useHttp(p2, srv.url)
    await settle([p1, p2])
    addProfileVersion(p1.app, { shopName: 'Sri Velmayil Crackers', logo: FAKE_LOGO })
    await settle([p1, p2])

    expect(activeShopName(p2.app)).toBe('Sri Velmayil Crackers')
    expect(p2.app.get<{ getActive(): { shopName: string; logoAssetId: number | null } }>('businessProfile').getActive().shopName).toBe('Sri Velmayil Crackers')
    const logo = p2.app.get<{ getActive(): { logoAssetId: number | null } }>('businessProfile').getActive().logoAssetId
    expect(logo).not.toBeNull()
    expect(Buffer.from(p2.app.db.value<Uint8Array>('SELECT bytes FROM logo_assets WHERE id = ?', logo!)!).equals(FAKE_LOGO)).toBe(true)
    // history kept: v1 still there, exactly one active
    expect(count(p2, 'SELECT COUNT(*) FROM business_profile_versions')).toBe(2)
    expect(count(p2, 'SELECT COUNT(*) FROM business_profile_versions WHERE is_active = 1')).toBe(1)
  })

  it('sale on POS-2 appears on POS-1 with items/payments, and stock converges on both', async () => {
    const srv = await startServer()
    const p1 = makePos('POS-01')
    const p2 = makePos('POS-02')
    useHttp(p1, srv.url)
    useHttp(p2, srv.url)
    const a = addProduct(p1.app, { name: 'Rocket', sku: 'RKT', price: 5000, qty: 10 })
    await settle([p1, p2])
    const v2 = p2.app.db.value<number>("SELECT id FROM product_variants WHERE sku = 'RKT'")!
    const s2 = sqlSale(p2.app, v2, 3)
    sqlSale(p1.app, a.variantId, 2) // concurrent sale on POS-1
    await settle([p1, p2])

    const remote = p1.app.db.get<{ id: number; total: number; pos_id: number }>('SELECT id, total, pos_id FROM sales WHERE uuid = ?', s2.uuid)!
    expect(remote.total).toBe(15000)
    expect(count(p1, 'SELECT COUNT(*) FROM sale_items WHERE sale_id = ?', remote.id)).toBe(1)
    expect(count(p1, "SELECT SUM(amount) FROM sale_payments WHERE sale_id = ?", remote.id)).toBe(15000)
    expect(p1.app.db.value<string>('SELECT code FROM pos_terminals WHERE id = ?', remote.pos_id)).toBe('POS-02')
    expect(count(p1, 'SELECT COUNT(*) FROM sales')).toBe(2)
    expect(count(p2, 'SELECT COUNT(*) FROM sales')).toBe(2)
    // 10 - 3 - 2 on both, and level == sum of movements on both
    expect(stockOf(p1.app, 'RKT')).toBe(5)
    expect(stockOf(p2.app, 'RKT')).toBe(5)
    expect(movementSum(p1.app, 'RKT')).toBe(5)
    expect(movementSum(p2.app, 'RKT')).toBe(5)
    expect(count(p1, 'SELECT SUM(total) FROM sales')).toBe(25000)
  })

  it('offline: queue grows, backoff is applied, billing is unaffected, reconnect delivers everything', async () => {
    const dead = await startServer()
    const deadUrl = dead.url
    await dead.close()
    const live = await startServer()
    const p1 = makePos('POS-01')
    const p2 = makePos('POS-02')
    useHttp(p1, deadUrl)
    useHttp(p2, live.url)
    const a = addProduct(p1.app, { name: 'Offline item', sku: 'OFF1', price: 100, qty: 5 })
    const r = await p1.sync.syncNow({ force: true })
    expect(r.ok).toBe(false)
    let st = p1.sync.status()
    expect(st.online).toBe(false)
    expect(st.pending).toBeGreaterThan(0)
    expect(st.lastError).toBeTruthy()
    expect(st.backoffUntil).toBeGreaterThan(Date.now())
    expect(count(p1, "SELECT MIN(attempts) FROM sync_queue WHERE status = 'pending'")).toBeGreaterThanOrEqual(1)
    expect((await p1.sync.syncNow()).skipped).toBe('backing off') // timer-driven cycles respect backoff

    // keep selling while offline
    sqlSale(p1.app, a.variantId, 2)
    expect(stockOf(p1.app, 'OFF1')).toBe(3)
    const queued = p1.sync.status().pending

    p1.sync.saveConfig({ url: live.url }) // connectivity is back
    const r2 = await p1.sync.syncNow({ force: true })
    expect(r2.ok).toBe(true)
    await settle([p2])
    st = p1.sync.status()
    expect(st.pending).toBe(0)
    expect(st.online).toBe(true)
    expect(queued).toBeGreaterThan(0)
    expect(stockOf(p2.app, 'OFF1')).toBe(3)
    expect(count(p2, 'SELECT COUNT(*) FROM sales')).toBe(1)
  })

  it('conflicting edits resolve deterministically (LWW, tie-break) and are logged', async () => {
    const srv = await startServer()
    const p1 = makePos('POS-01')
    const p2 = makePos('POS-02')
    useHttp(p1, srv.url)
    useHttp(p2, srv.url)
    const a = addProduct(p1.app, { name: 'Base', sku: 'CF1', updatedAt: 1000 })
    await settle([p1, p2])
    const id2 = p2.app.db.value<number>("SELECT id FROM products WHERE name = 'Base'")!

    editProduct(p1.app, a.productId, 'Edit-A', 5000)
    editProduct(p2.app, id2, 'Edit-B', 6000)
    await settle([p1, p2])
    expect(p1.app.db.value<string>('SELECT name FROM products WHERE id = ?', a.productId)).toBe('Edit-B')
    expect(p2.app.db.value<string>('SELECT name FROM products WHERE id = ?', id2)).toBe('Edit-B')
    expect(count(p1, "SELECT COUNT(*) FROM sync_conflicts WHERE kind = 'lww_lost_local'")).toBe(1)
    expect(count(p2, "SELECT COUNT(*) FROM sync_conflicts WHERE kind = 'lww_lost_remote'")).toBe(1)

    // identical timestamps: still the same winner on both sides
    editProduct(p1.app, a.productId, 'AAA', 9000)
    editProduct(p2.app, id2, 'ZZZ', 9000)
    await settle([p1, p2])
    const n1 = p1.app.db.value<string>('SELECT name FROM products WHERE id = ?', a.productId)
    const n2 = p2.app.db.value<string>('SELECT name FROM products WHERE id = ?', id2)
    expect(n1).toBe(n2)
    expect(['AAA', 'ZZZ']).toContain(n1)
  })

  it('same category created offline on both terminals converges to one record; products follow the alias', async () => {
    const srv = await startServer()
    const p1 = makePos('POS-01')
    const p2 = makePos('POS-02')
    useHttp(p1, srv.url)
    useHttp(p2, srv.url)
    await settle([p1, p2])
    const c1 = p1.app.db.run("INSERT INTO categories(uuid,name,updated_at) VALUES (?, 'Toys', 100)", p1.app.uuid()).lastId
    p1.app.enqueueSnapshot('categories', c1)
    const c2 = p2.app.db.run("INSERT INTO categories(uuid,name,updated_at) VALUES (?, 'toys', 200)", p2.app.uuid()).lastId
    p2.app.enqueueSnapshot('categories', c2)
    await settle([p1, p2])
    expect(count(p1, 'SELECT COUNT(*) FROM categories')).toBe(1)
    expect(count(p2, 'SELECT COUNT(*) FROM categories')).toBe(1)
    expect(p1.app.db.value<string>('SELECT name FROM categories')).toBe(p2.app.db.value<string>('SELECT name FROM categories'))
    expect(count(p1, "SELECT COUNT(*) FROM sync_conflicts WHERE kind = 'duplicate_key'")).toBeGreaterThanOrEqual(1)

    const prod = addProduct(p1.app, { name: 'Toy car', sku: 'TC1' })
    p1.app.db.run('UPDATE products SET category_id = ?, updated_at = ? WHERE id = ?', c1, Date.now() + 1, prod.productId)
    p1.app.enqueueSnapshot('products', prod.productId, [])
    await settle([p1, p2])
    expect(p2.app.db.value<number>("SELECT category_id FROM products WHERE name = 'Toy car'")).toBe(c2)
  })

  it('duplicate delivery is idempotent (replaying the whole server log changes nothing)', async () => {
    const srv = await startServer()
    const p1 = makePos('POS-01')
    const p2 = makePos('POS-02')
    useHttp(p1, srv.url)
    useHttp(p2, srv.url)
    const a = addProduct(p1.app, { name: 'Dup', sku: 'DUP', price: 100, qty: 10 })
    sqlSale(p1.app, a.variantId, 4)
    await settle([p1, p2])
    const before = { stock: stockOf(p2.app, 'DUP'), moves: count(p2, 'SELECT COUNT(*) FROM stock_movements'), sales: count(p2, 'SELECT COUNT(*) FROM sales') }
    expect(before.stock).toBe(6)

    // 1) same changes handed over again
    const log = srv.handle.state().changes as RemoteChange[]
    for (const ch of log) if (ch.device !== p2.sync.device().uuid) expect(['duplicate', 'skipped']).toContain(p2.sync.processInbound(ch))
    // 2) cursor reset -> full replay from the server
    p2.app.db.run("DELETE FROM sync_state WHERE key = 'cursor'")
    await p2.sync.syncNow({ force: true })
    // 3) double push of the same queue ids is deduplicated by the server
    const seq = srv.handle.state().seq
    p1.app.db.run("UPDATE sync_queue SET status = 'pending'")
    await p1.sync.syncNow({ force: true })
    expect(srv.handle.state().seq).toBe(seq)
    await settle([p1, p2])

    expect(stockOf(p2.app, 'DUP')).toBe(before.stock)
    expect(stockOf(p1.app, 'DUP')).toBe(6)
    expect(count(p2, 'SELECT COUNT(*) FROM stock_movements')).toBe(before.moves)
    expect(count(p2, 'SELECT COUNT(*) FROM sales')).toBe(before.sales)
  })

  it('no echo loop: applied remote changes are never queued back; the server log stops growing', async () => {
    const srv = await startServer()
    const p1 = makePos('POS-01')
    const p2 = makePos('POS-02')
    useHttp(p1, srv.url)
    useHttp(p2, srv.url)
    const a = addProduct(p1.app, { name: 'Echo', sku: 'ECH', price: 100, qty: 10 })
    sqlSale(p1.app, a.variantId, 1)
    addProfileVersion(p1.app, { shopName: 'Echo Shop', logo: FAKE_LOGO })
    await settle([p1, p2], 4)
    const seq = srv.handle.state().seq
    expect(seq).toBeGreaterThan(0)
    await settle([p1, p2], 4)
    expect(srv.handle.state().seq).toBe(seq)
    // p2 only ever queued its own bootstrap data; nothing about the entities it received
    expect(count(p2, "SELECT COUNT(*) FROM sync_queue WHERE entity IN ('products','sales','categories') AND status = 'pending'")).toBe(0)
    const fromP2 = (srv.handle.state().changes as RemoteChange[]).filter((c) => c.device === p2.sync.device().uuid && ['products', 'sales', 'stock_movements'].includes(c.entity))
    expect(fromP2).toHaveLength(0)
    expect(p1.sync.status().pending).toBe(0)
    expect(p2.sync.status().pending).toBe(0)
  })

  it('invoice numbers do not collide; a forced duplicate number is kept with a suffix and logged', async () => {
    const srv = await startServer()
    const p1 = makePos('POS-01')
    const p2 = makePos('POS-02')
    useHttp(p1, srv.url)
    useHttp(p2, srv.url)
    const a = addProduct(p1.app, { name: 'Inv', sku: 'INV1', price: 100, qty: 50 })
    await settle([p1, p2])
    const v2 = p2.app.db.value<number>("SELECT id FROM product_variants WHERE sku = 'INV1'")!
    const s1 = sqlSale(p1.app, a.variantId, 1)
    const s2 = sqlSale(p2.app, v2, 1)
    expect(s1.invoiceNo).not.toBe(s2.invoiceNo)
    const dup1 = sqlSale(p1.app, a.variantId, 1, { invoiceNo: 'INV-2026-000777' })
    const dup2 = sqlSale(p2.app, v2, 1, { invoiceNo: 'INV-2026-000777' })
    await settle([p1, p2])
    expect(count(p1, 'SELECT COUNT(*) FROM sales')).toBe(4)
    expect(count(p2, 'SELECT COUNT(*) FROM sales')).toBe(4)
    expect(count(p1, "SELECT COUNT(*) FROM sales WHERE invoice_no LIKE 'INV-2026-000777%'")).toBe(2)
    expect(count(p1, "SELECT COUNT(*) FROM sync_conflicts WHERE kind = 'number_collision'") + count(p2, "SELECT COUNT(*) FROM sync_conflicts WHERE kind = 'number_collision'")).toBeGreaterThanOrEqual(2)
    expect(dup1.uuid).not.toBe(dup2.uuid)
    expect(stockOf(p1.app, 'INV1')).toBe(46)
    expect(stockOf(p2.app, 'INV1')).toBe(46)
  })

  it('out-of-order delivery: a sale arriving before its product is parked and applied once the product lands', async () => {
    const srv = await startServer()
    const p1 = makePos('POS-01')
    const p2 = makePos('POS-02')
    useHttp(p1, srv.url)
    const a = addProduct(p1.app, { name: 'Late', sku: 'LATE', price: 100, qty: 5 })
    const s = sqlSale(p1.app, a.variantId, 2)
    await p1.sync.syncNow({ force: true })
    const log = (srv.handle.state().changes as RemoteChange[]).filter((c) => c.device === p1.sync.device().uuid)
    const sale = log.find((c) => c.entity === 'sales')!
    const prod = log.find((c) => c.entity === 'products')!
    expect(p2.sync.processInbound(sale)).toBe('deferred')
    expect(count(p2, 'SELECT COUNT(*) FROM sync_deferred')).toBe(1)
    expect(count(p2, 'SELECT COUNT(*) FROM sales')).toBe(0)
    expect(p2.sync.processInbound(prod)).toBe('applied')
    p2.sync.retryDeferred()
    expect(count(p2, 'SELECT COUNT(*) FROM sync_deferred')).toBe(0)
    expect(count(p2, 'SELECT COUNT(*) FROM sales WHERE uuid = ?', s.uuid)).toBe(1)
  })

  it('three terminals converge', async () => {
    const srv = await startServer()
    const ps = [makePos('POS-01'), makePos('POS-02'), makePos('POS-03')]
    ps.forEach((p) => useHttp(p, srv.url))
    const a = addProduct(ps[0].app, { name: 'Tri', sku: 'TRI', price: 100, qty: 30 })
    await settle(ps)
    for (const [i, p] of ps.entries()) {
      const vid = p.app.db.value<number>("SELECT id FROM product_variants WHERE sku = 'TRI'")!
      sqlSale(p.app, vid, i + 1)
    }
    addProfileVersion(ps[2].app, { shopName: 'Tri Shop', createdAt: Date.now() + 5000 })
    await settle(ps, 4)
    for (const p of ps) {
      expect(stockOf(p.app, 'TRI')).toBe(30 - 6)
      expect(count(p, 'SELECT COUNT(*) FROM sales')).toBe(3)
      expect(activeShopName(p.app)).toBe('Tri Shop')
    }
    expect(a.variantId).toBeGreaterThan(0)
    expect(ps[0].sync.listDevices().length).toBe(3)
  })

  it('crash-resume: queue survives an app restart on the same DB file and is delivered once', async () => {
    const srv = await startServer()
    let p1 = makePos('POS-01')
    const p2 = makePos('POS-02')
    useHttp(p1, srv.url)
    useHttp(p2, srv.url)
    const a = addProduct(p1.app, { name: 'Crash', sku: 'CRS', price: 100, qty: 9 })
    sqlSale(p1.app, a.variantId, 4)

    // simulate dying right after the server stored the batch but before the client marked it sent
    const dev = p1.sync.device()
    const rows = p1.app.db.all<{ id: number; entity: string; entity_uuid: string; op: 'upsert'; payload_json: string; created_at: number }>(
      "SELECT * FROM sync_queue WHERE status = 'pending' ORDER BY id LIMIT 2"
    )
    await p1.sync.transport().push(dev, rows.map((r) => ({
      device: dev.uuid, deviceCode: dev.code, deviceName: dev.name, qid: r.id, entity: r.entity, entityUuid: r.entity_uuid, op: r.op,
      createdAt: r.created_at, payload: JSON.parse(r.payload_json)
    })))
    const seqAfterPartial = srv.handle.state().seq
    const pendingBefore = p1.sync.status().pending
    expect(pendingBefore).toBeGreaterThan(2)

    p1 = reopenPos(p1) // process restart
    expect(p1.sync.status().pending).toBe(pendingBefore)
    const r = await p1.sync.syncNow({ force: true })
    expect(r.ok).toBe(true)
    expect(p1.sync.status().pending).toBe(0)
    // the 2 re-sent items were deduplicated by (device, qid)
    const total = (srv.handle.state().changes as RemoteChange[]).filter((c) => c.device === dev.uuid)
    expect(new Set(total.map((c) => c.qid)).size).toBe(total.length)
    expect(srv.handle.state().seq).toBeGreaterThan(seqAfterPartial)
    await settle([p2])
    expect(stockOf(p2.app, 'CRS')).toBe(5)
    expect(count(p2, 'SELECT COUNT(*) FROM sales')).toBe(1)
  })

  it('receiver crash-resume: re-opened terminal keeps its cursor + inbox and does not double-apply', async () => {
    const srv = await startServer()
    const p1 = makePos('POS-01')
    let p2 = makePos('POS-02')
    useHttp(p1, srv.url)
    useHttp(p2, srv.url)
    const a = addProduct(p1.app, { name: 'RC', sku: 'RC1', price: 100, qty: 10 })
    sqlSale(p1.app, a.variantId, 3)
    await settle([p1, p2])
    expect(stockOf(p2.app, 'RC1')).toBe(7)
    p2 = reopenPos(p2)
    await settle([p1, p2])
    expect(stockOf(p2.app, 'RC1')).toBe(7)
    expect(count(p2, 'SELECT COUNT(*) FROM stock_movements')).toBe(2)
  })

  it('server rejects a wrong API key; status reports the error, nothing is lost', async () => {
    const srv = await startServer()
    const p1 = makePos('POS-01')
    useHttp(p1, srv.url, 'wrong-key')
    addProduct(p1.app, { name: 'Auth', sku: 'AUTH' })
    const r = await p1.sync.syncNow({ force: true })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/API key/)
    expect((await p1.sync.testConnection()).ok).toBe(false)
    expect(p1.sync.status().pending).toBeGreaterThan(0)
    p1.sync.saveConfig({ key: KEY })
    expect((await p1.sync.testConnection()).ok).toBe(true)
    expect((await p1.sync.syncNow({ force: true })).ok).toBe(true)
    expect(p1.sync.status().pending).toBe(0)
  })

  it('server persists to a JSON file and a restarted server serves the same log', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vsrv-'))
    const file = join(dir, 'store.json')
    const s1 = await startServer({ file })
    const p1 = makePos('POS-01')
    const p2 = makePos('POS-02')
    useHttp(p1, s1.url)
    addProduct(p1.app, { name: 'Persist', sku: 'PER', qty: 3 })
    await p1.sync.syncNow({ force: true })
    await s1.close()
    const s2 = await startServer({ file })
    useHttp(p2, s2.url)
    await settle([p2])
    expect(stockOf(p2.app, 'PER')).toBe(3)
  })

  it('failed items stop retrying after maxAttempts and can be retried manually', async () => {
    const dead = await startServer()
    const url = dead.url
    await dead.close()
    const p1 = makePos('POS-01')
    useHttp(p1, url)
    addProduct(p1.app, { name: 'Fail', sku: 'FL' })
    for (let i = 0; i < 12; i++) await p1.sync.syncNow({ force: true })
    expect(p1.sync.status().failed).toBeGreaterThan(0)
    expect(p1.sync.status().pending).toBe(0)
    const live = await startServer()
    p1.sync.saveConfig({ url: live.url })
    expect(p1.sync.retryFailed()).toBeGreaterThan(0)
    expect((await p1.sync.syncNow({ force: true })).ok).toBe(true)
    expect(p1.sync.status().pending + p1.sync.status().failed).toBe(0)
  })

  it('joining terminal gets everything via resyncAll (catalog, stock, sales, profile)', async () => {
    const srv = await startServer()
    const p1 = makePos('POS-01')
    // history exists before sync is ever enabled
    const a = addProduct(p1.app, { name: 'History', sku: 'HIS', price: 500, qty: 20 })
    sqlSale(p1.app, a.variantId, 5)
    addProfileVersion(p1.app, { shopName: 'Old Shop Renamed', logo: FAKE_LOGO })
    useHttp(p1, srv.url) // first enable bootstraps the queue
    const p2 = makePos('POS-02')
    useHttp(p2, srv.url)
    await settle([p1, p2], 4)
    expect(stockOf(p2.app, 'HIS')).toBe(15)
    expect(count(p2, 'SELECT COUNT(*) FROM sales')).toBe(1)
    expect(activeShopName(p2.app)).toBe('Old Shop Renamed')
  })

  it('profile v-number clash on two terminals keeps both versions and elects the same active one', async () => {
    const srv = await startServer()
    const p1 = makePos('POS-01', { sameProfile: false })
    const p2 = makePos('POS-02', { sameProfile: false })
    useHttp(p1, srv.url)
    useHttp(p2, srv.url)
    addProfileVersion(p1.app, { shopName: 'Name From One', createdAt: Date.now() + 5000 })
    addProfileVersion(p2.app, { shopName: 'Name From Two', createdAt: Date.now() + 6000 })
    await settle([p1, p2], 4)
    expect(activeShopName(p1.app)).toBe('Name From Two')
    expect(activeShopName(p2.app)).toBe('Name From Two')
    expect(count(p1, 'SELECT COUNT(*) FROM business_profile_versions WHERE is_active = 1')).toBe(1)
    expect(count(p1, 'SELECT COUNT(*) FROM business_profile_versions WHERE shop_name = ?', 'Name From One')).toBe(1)
    // a sale made on p1 before the switch still pins its own profile version
    expect(count(p1, 'SELECT COUNT(*) FROM business_profile_versions')).toBe(4)
  })
})

describe('sync over a shared folder (no server)', () => {
  it('two terminals converge through a folder, including stock and profile', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'vfold-'))
    const p1 = makePos('POS-01')
    const p2 = makePos('POS-02')
    useFolder(p1, folder)
    useFolder(p2, folder)
    const a = addProduct(p1.app, { name: 'Folder item', sku: 'FLD', price: 100, qty: 12 })
    addProfileVersion(p1.app, { shopName: 'Folder Shop', logo: FAKE_LOGO })
    await settle([p1, p2])
    const v2 = p2.app.db.value<number>("SELECT id FROM product_variants WHERE sku = 'FLD'")!
    sqlSale(p2.app, v2, 5)
    sqlSale(p1.app, a.variantId, 1)
    await settle([p1, p2])
    expect(stockOf(p1.app, 'FLD')).toBe(6)
    expect(stockOf(p2.app, 'FLD')).toBe(6)
    expect(activeShopName(p2.app)).toBe('Folder Shop')
    expect(count(p1, 'SELECT COUNT(*) FROM sales')).toBe(2)
    // another round changes nothing
    await settle([p1, p2])
    expect(stockOf(p2.app, 'FLD')).toBe(6)
    expect((await p1.sync.testConnection()).ok).toBe(true)
  })
})

describe('real modules (skipped when a dependency is not ready)', () => {
  const ready = (p: { app: import('../../src/main/core/app').App }) => p.app.has('catalog') && p.app.has('pos') && p.app.has('businessProfile')

  it('catalog.save on POS-1 -> pos.completeSale on POS-2 -> reports on POS-1; businessProfile.save syncs', async () => {
    const srv = await startServer()
    const p1 = makePos('POS-01')
    const p2 = makePos('POS-02')
    if (!ready(p1)) {
      console.warn('SKIPPED real-modules scenario: catalog/pos/businessProfile not registered')
      return
    }
    useHttp(p1, srv.url)
    useHttp(p2, srv.url)
    const saved = (await p1.app.call('catalog', 'save', {
      name: 'Real Rocket', taxRateBp: 1800, variants: [{ sku: 'REAL1', price: 11800, openingStock: 20 }]
    })) as { id: number }
    expect(saved.id).toBeGreaterThan(0)
    await settle([p1, p2])
    const v2 = p2.app.db.value<number>("SELECT id FROM product_variants WHERE sku = 'REAL1'")!
    expect(v2).toBeGreaterThan(0)
    expect(stockOf(p2.app, 'REAL1')).toBe(20)

    await p2.app.call('pos', 'openShift', { openingCash: 0 }).catch(() => undefined)
    const sale = (await p2.app.call('pos', 'completeSale', { lines: [{ variantId: v2, qty: 4 }], payments: [{ method: 'cash', amount: 47200 }] })) as { saleId: number; invoiceNo: string }
    await p1.app.call('pos', 'openShift', { openingCash: 0 }).catch(() => undefined)
    const v1 = p1.app.db.value<number>("SELECT id FROM product_variants WHERE sku = 'REAL1'")!
    const sale1 = (await p1.app.call('pos', 'completeSale', { lines: [{ variantId: v1, qty: 1 }], payments: [{ method: 'cash', amount: 11800 }] })) as { invoiceNo: string }
    expect(sale1.invoiceNo).not.toBe(sale.invoiceNo)

    await p1.app.call('businessProfile', 'save', { shopName: 'Real Renamed Shop', displayName: 'Real Renamed Shop' })
    await settle([p1, p2], 4)
    expect(count(p1, 'SELECT COUNT(*) FROM sales')).toBe(2)
    expect(count(p2, 'SELECT COUNT(*) FROM sales')).toBe(2)
    expect(stockOf(p1.app, 'REAL1')).toBe(15)
    expect(stockOf(p2.app, 'REAL1')).toBe(15)
    expect(((await p2.app.call('businessProfile', 'getActive')) as { shopName: string }).shopName).toBe('Real Renamed Shop')
    // sale pins the profile version it was made under, on both terminals
    const pinned = p1.app.db.value<string>('SELECT b.shop_name FROM sales s JOIN business_profile_versions b ON b.id = s.profile_version_id WHERE s.invoice_no = ?', sale.invoiceNo)
    expect(pinned).toBe('Test Shop')
  })
})

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestApp } from '../helpers'
import { App } from '../../src/main/core/app'
import { registerAllModules } from '../../src/main/core/modules'
import { createSyncServer, type SyncServerHandle } from '../../server/sync-server.mjs'
import type { SyncService } from '../../src/main/modules/sync/service'
import type { ChildSpec } from '../../src/main/core/snapshot'

export const KEY = 'test-key-123'
export const SHARED_PROFILE_UUID = '00000000-0000-4000-8000-0000000000aa'

export interface Pos {
  app: App
  sync: SyncService
  dir: string
  dbPath: string
  code: string
}

export interface TestServer { handle: SyncServerHandle; url: string; port: number; close: () => Promise<void> }

const dirs: string[] = []
const apps: App[] = []
const servers: TestServer[] = []

export async function startServer(opts: { port?: number; file?: string; key?: string } = {}): Promise<TestServer> {
  const handle = createSyncServer({ apiKey: opts.key ?? KEY, file: opts.file })
  const { port, url } = await handle.listen(opts.port ?? 0)
  const s: TestServer = { handle, url, port, close: () => handle.close() }
  servers.push(s)
  return s
}

/**
 * A terminal with its own SQLite file, a distinct pos_terminals uuid/code and (by default) the same initial shop
 * profile as the other terminals (as after "join this shop"). `sameProfile: false` keeps the random per-terminal v1.
 */
export function makePos(code: string, opts: { sameProfile?: boolean; dir?: string; seed?: boolean } = {}): Pos {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), `vsync-${code}-`))
  if (!opts.dir) dirs.push(dir)
  const dbPath = join(dir, 'pos.db')
  const app = createTestApp({ dbPath, userDataDir: dir, seed: opts.seed, queueSync: false })
  apps.push(app)
  if (opts.seed !== false) {
    app.db.run('UPDATE pos_terminals SET code = ?, name = ? WHERE is_local = 1', code, `Counter ${code}`)
    app.session = { ...app.session!, posCode: code }
    if (opts.sameProfile !== false) {
      // test-only: make v1 identical across terminals (immutability trigger dropped on this test DB)
      app.db.exec('DROP TRIGGER IF EXISTS trg_bpv_immutable')
      app.db.run('UPDATE business_profile_versions SET uuid = ?, created_at = 1000 WHERE version = 1', SHARED_PROFILE_UUID)
    }
  }
  return { app, sync: app.get<SyncService>('sync'), dir, dbPath, code }
}

/** Re-open the same DB file in a fresh App (process restart / crash recovery). */
export function reopenPos(p: Pos): Pos {
  try { p.app.db.close() } catch { /* already closed */ }
  const app = new App({ dbPath: p.dbPath, userDataDir: p.dir })
  apps.push(app)
  registerAllModules(app)
  const u = app.db.get<{ id: number; username: string; name: string }>("SELECT id, username, name FROM users WHERE username = 'admin'")!
  app.session = { userId: u.id, username: u.username, name: u.name, role: 'Owner', permissions: ['*'], posId: app.localPos().id, posCode: app.localPos().code }
  return { ...p, app, sync: app.get<SyncService>('sync') }
}

export function useHttp(p: Pos, url: string, key = KEY): void {
  p.sync.saveConfig({ enabled: true, transport: 'http', url, key })
}
export function useFolder(p: Pos, folder: string): void {
  p.sync.saveConfig({ enabled: true, transport: 'folder', folder })
}

/** Run full sync cycles over all terminals until nothing moves (max `rounds`). */
export async function settle(poss: Pos[], rounds = 3): Promise<void> {
  for (let r = 0; r < rounds; r++) for (const p of poss) await p.sync.syncNow({ force: true })
}

export async function cleanup(): Promise<void> {
  for (const s of servers.splice(0)) await s.close().catch(() => undefined)
  for (const a of apps.splice(0)) try { a.db.close() } catch { /* closed */ }
  for (const d of dirs.splice(0)) try { rmSync(d, { recursive: true, force: true }) } catch { /* windows */ }
}

// ---------------------------------------------------------------------------------------------------------------------
// fixtures (direct SQL + app.enqueueSnapshot, exactly what producers do)
export const PRODUCT_CHILDREN: ChildSpec[] = [{ table: 'product_variants', fk: 'product_id', children: [{ table: 'variant_barcodes', fk: 'variant_id' }] }]

export function addProduct(app: App, o: { name: string; sku: string; price?: number; qty?: number; barcode?: string; alias?: string; updatedAt?: number }): { productId: number; variantId: number; productUuid: string; variantUuid: string } {
  return app.db.transaction(() => {
    const pu = app.uuid()
    const vu = app.uuid()
    const at = o.updatedAt ?? Date.now()
    const p = app.db.run('INSERT INTO products(uuid,name,updated_at) VALUES (?,?,?)', pu, o.name, at)
    const v = app.db.run('INSERT INTO product_variants(uuid,product_id,sku,barcode,price,updated_at) VALUES (?,?,?,?,?,?)', vu, p.lastId, o.sku, o.barcode ?? null, o.price ?? 1000, at)
    if (o.alias) app.db.run('INSERT INTO variant_barcodes(barcode,variant_id) VALUES (?,?)', o.alias, v.lastId)
    app.enqueueSnapshot('products', p.lastId, PRODUCT_CHILDREN)
    if (o.qty) app.moveStock({ variantId: v.lastId, delta: o.qty, type: 'opening' })
    return { productId: p.lastId, variantId: v.lastId, productUuid: pu, variantUuid: vu }
  })
}

export function editProduct(app: App, productId: number, name: string, updatedAt: number): void {
  app.db.transaction(() => {
    app.db.run('UPDATE products SET name = ?, updated_at = ? WHERE id = ?', name, updatedAt, productId)
    app.enqueueSnapshot('products', productId, PRODUCT_CHILDREN)
  })
}

/** A completed cash sale exactly like pos.completeSale writes it (header + lines + payment + stock + queue). */
export function sqlSale(app: App, variantId: number, qty: number, o: { invoiceNo?: string } = {}): { saleId: number; invoiceNo: string; uuid: string } {
  return app.db.transaction(() => {
    const pos = app.localPos()
    const v = app.db.get<{ price: number; sku: string; product_id: number }>('SELECT price, sku, product_id FROM product_variants WHERE id = ?', variantId)!
    const name = app.db.value<string>('SELECT name FROM products WHERE id = ?', v.product_id)!
    const invoiceNo = o.invoiceNo ?? app.nextNumber(`INV-${pos.code}`)
    const total = v.price * qty
    const uuid = app.uuid()
    const profile = app.db.value<number>('SELECT id FROM business_profile_versions WHERE is_active = 1')!
    const s = app.db.run(
      `INSERT INTO sales(uuid,invoice_no,pos_id,user_id,subtotal,total,paid,profile_version_id) VALUES (?,?,?,?,?,?,?,?)`,
      uuid, invoiceNo, pos.id, app.session!.userId, total, total, total, profile
    )
    app.db.run('INSERT INTO sale_items(sale_id,variant_id,name,sku,qty,unit_price,line_total) VALUES (?,?,?,?,?,?,?)', s.lastId, variantId, name, v.sku, qty, v.price, total)
    app.db.run("INSERT INTO sale_payments(sale_id,method,amount) VALUES (?,'cash',?)", s.lastId, total)
    app.moveStock({ variantId, delta: -qty, type: 'sale', refType: 'sale', refId: s.lastId })
    app.enqueueSnapshot('sales', s.lastId, [{ table: 'sale_items', fk: 'sale_id' }, { table: 'sale_payments', fk: 'sale_id' }])
    return { saleId: s.lastId, invoiceNo, uuid }
  })
}

export const stockOf = (app: App, sku: string): number =>
  app.db.value<number>('SELECT COALESCE(SUM(l.qty),0) FROM stock_levels l JOIN product_variants v ON v.id = l.variant_id WHERE v.sku = ?', sku) ?? 0
export const movementSum = (app: App, sku: string): number =>
  app.db.value<number>('SELECT COALESCE(SUM(m.qty_delta),0) FROM stock_movements m JOIN product_variants v ON v.id = m.variant_id WHERE v.sku = ?', sku) ?? 0
export const activeShopName = (app: App): string => app.db.value<string>('SELECT shop_name FROM business_profile_versions WHERE is_active = 1')!

/** Minimal valid-looking logo (bytes are opaque to sync). */
export const FAKE_LOGO = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63fcffff3f0300060103ee3f1b6a0000000049454e44ae426082', 'hex')

export function addProfileVersion(app: App, o: { shopName: string; logo?: Buffer; createdAt?: number }): number {
  return app.db.transaction(() => {
    let assetId: number | null = null
    let sha = ''
    if (o.logo) {
      sha = `sha-${o.logo.length}-${o.logo.subarray(0, 16).toString('hex')}-${o.shopName}`
      assetId = app.db.get<{ id: number }>('SELECT id FROM logo_assets WHERE sha256 = ?', sha)?.id ?? app.db.run(
        'INSERT INTO logo_assets(sha256,mime,width_px,height_px,bytes,size_bytes) VALUES (?,?,?,?,?,?)', sha, 'image/png', 1, 1, o.logo, o.logo.length
      ).lastId
    }
    const next = (app.db.value<number>('SELECT MAX(version) FROM business_profile_versions') ?? 0) + 1
    app.db.run('UPDATE business_profile_versions SET is_active = 0 WHERE is_active = 1')
    const id = app.db.run(
      `INSERT INTO business_profile_versions(uuid,version,shop_name,display_name,logo_asset_id,logo_sha256,is_active,created_at,created_by,pos_id)
       VALUES (?,?,?,?,?,?,1,?,?,?)`,
      app.uuid(), next, o.shopName, o.shopName, assetId, sha, o.createdAt ?? Date.now(), app.session!.userId, app.localPos().id
    ).lastId
    app.enqueueSnapshot('business_profile_versions', id)
    return id
  })
}

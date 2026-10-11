/**
 * Reusable realistic dataset for performance work.
 *
 *   seedDatabase({ dir, products: 20000, sales: 50000, customers: 5000, days: 90 })
 *
 * Uses the REAL migrations, module registration and the real `setup.complete` service (so the owner, roles, POS terminal,
 * location and shop profile are exactly what the first-run wizard creates). The bulk rows (catalogue, customers, sales,
 * stock movements) are inserted with prepared statements inside a few big transactions: running 50k sales through
 * `pos.completeSale` would take minutes and is not what is being measured.
 *
 * CLI (from the repo root):
 *   PERF_SEED_DIR=C:/tmp/velmayil-perf npx vitest run tests/perf/seed.cli.test.ts      (cross-env NODE_OPTIONS=--experimental-sqlite on Node < 24)
 * Then launch the built app against it:  VELMAYIL_DATA_DIR=<dir> electron . --user-data-dir=<dir>/chromium
 * Login: owner / perf-pass-1
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { App } from '../../src/main/core/app'
import { registerAllModules } from '../../src/main/core/modules'
import { ensureDefaultSettings } from '../../src/main/core/settings'

export interface SeedOptions {
  dir: string
  products?: number
  sales?: number
  customers?: number
  days?: number
  /** keep the App open and return it (tests) instead of closing it (CLI) */
  keepOpen?: boolean
  now?: number
}
export const PERF_USER = 'owner'
export const PERF_PASSWORD = 'perf-pass-1'

// tiny deterministic PRNG so every run builds the same data
function rng(seed: number) {
  let s = seed >>> 0
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296)
}

const CATS = ['Sparklers', 'Flower Pots', 'Rockets', 'Ground Chakkars', 'Bijili Crackers', 'Atom Bombs', 'Gift Boxes', 'Sky Shots', 'Fancy Fountains', 'Kids Special', 'Matches', 'Candles', 'Garlands', 'Pencils', 'Twinklers']
const BRANDS = ['Standard', 'Sony', 'Ayyan', 'Anil', 'Cock', 'Vadivel', 'Sri Kaliswari', 'Coronation', 'Trichy Star', 'Mega']
const WORDS = ['Super', 'Royal', 'Golden', 'Silver', 'Magic', 'Rainbow', 'Thunder', 'Star', 'Moon', 'Colour', 'Mega', 'Mini', 'Jumbo', 'Special', 'Deluxe']
const NOUNS = ['Sparkler', 'Pot', 'Rocket', 'Chakkar', 'Fountain', 'Shot', 'Bomb', 'Crackle', 'Peacock', 'Whistle', 'Showers', 'Twinkle']
const FIRST = ['Arun', 'Bala', 'Chitra', 'Deepa', 'Eswari', 'Ganesh', 'Hari', 'Indira', 'Jegan', 'Kavitha', 'Lakshmi', 'Murugan', 'Nithya', 'Pandian', 'Revathi', 'Saravanan', 'Thilaga', 'Uma', 'Vijay', 'Yuvan']
const LAST = ['Kumar', 'Raj', 'Devi', 'Selvam', 'Mani', 'Pillai', 'Nadar', 'Rao', 'Babu', 'Prakash']

export async function seedDatabase(opt: SeedOptions): Promise<App> {
  const o = {
    products: opt.products ?? 20000,
    nSales: opt.sales ?? 50000,
    nCust: opt.customers ?? 5000,
    days: opt.days ?? 90,
    now: opt.now ?? Date.now(),
    keepOpen: !!opt.keepOpen
  }
  const rand = rng(12345)
  const pick = <T,>(a: T[]): T => a[Math.floor(rand() * a.length)]
  const now = o.now
  mkdirSync(opt.dir, { recursive: true })
  const app = new App({ dbPath: join(opt.dir, 'velmayil.db'), userDataDir: opt.dir })
  registerAllModules(app)
  ensureDefaultSettings(app)
  const db = app.db
  if (db.value<string>("SELECT value FROM settings WHERE key='setup.complete'") !== '1') {
    // real first-run provisioning (owner, roles, POS terminal, location, profile v1)
    await app.call('setup', 'complete', {
      shop: { shopName: 'Perf Test Fireworks', displayName: 'Perf Fireworks', address: '1 Main Road', city: 'Sivakasi', state: 'Tamil Nadu', phone: '9876543210', gstin: '33ABCDE1234F1Z5' },
      owner: { username: PERF_USER, name: 'Owner', password: PERF_PASSWORD },
      pos: { code: 'POS-01', name: 'Counter 1' },
      locationName: 'Main Store'
    })
  }
  const userId = db.value<number>('SELECT id FROM users LIMIT 1')!
  const posId = db.value<number>('SELECT id FROM pos_terminals WHERE is_local=1')!
  const locId = db.value<number>('SELECT id FROM locations WHERE is_default=1')!
  const profId = db.value<number>('SELECT id FROM business_profile_versions WHERE is_active=1')!
  const t0 = Date.now()

  db.transaction(() => {
    // categories / brands / suppliers
    const catIds: number[] = CATS.map((n) => db.run('INSERT INTO categories(uuid,name) VALUES (?,?)', randomUUID(), n).lastId)
    const brandIds: number[] = BRANDS.map((n) => db.run('INSERT INTO brands(uuid,name) VALUES (?,?)', randomUUID(), n).lastId)
    for (let i = 0; i < 40; i++) db.run('INSERT INTO suppliers(uuid,name,phone) VALUES (?,?,?)', randomUUID(), `Supplier ${i + 1} Traders`, `98${String(40000000 + i).padStart(8, '0')}`)

    // customers
    const ci = db.raw.prepare('INSERT INTO customers(uuid,name,phone,created_at) VALUES (?,?,?,?)')
    for (let i = 0; i < o.nCust; i++) ci.run(randomUUID(), `${pick(FIRST)} ${pick(LAST)} ${i}`, `9${String(100000000 + i * 7).padStart(9, '0')}`, now - Math.floor(rand() * o.days * 86400000))

    // products + variants (+ 1 extra variant for every 10th product) + stock + opening movements
    const pi = db.raw.prepare('INSERT INTO products(uuid,name,category_id,brand_id,hsn,tax_rate_bp,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
    const vi = db.raw.prepare('INSERT INTO product_variants(uuid,product_id,name,sku,barcode,mrp,price,cost,reorder_level,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    const si = db.raw.prepare('INSERT INTO stock_levels(variant_id,location_id,qty) VALUES (?,?,?)')
    const mi = db.raw.prepare('INSERT INTO stock_movements(uuid,variant_id,location_id,qty_delta,balance_after,type,ref_type,ref_id,unit_cost,user_id,pos_id,ts) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    let vcount = 0
    for (let p = 0; p < o.products; p++) {
      const price = (20 + Math.floor(rand() * 2000)) * 100
      const pr = pi.run(randomUUID(), `${pick(WORDS)} ${pick(NOUNS)} ${pick(WORDS)} ${p}`, pick(catIds), pick(brandIds), '36041000', pick([500, 1200, 1800, 2800]), now - 100 * 86400000, now - Math.floor(rand() * 30 * 86400000))
      const nVar = p % 10 === 0 ? 2 : 1
      for (let k = 0; k < nVar; k++) {
        const vr = vi.run(randomUUID(), Number(pr.lastInsertRowid), nVar === 2 ? `Pack ${k + 1}` : '', `SKU${String(p).padStart(6, '0')}${k}`, `89${String(10000000000 + p * 2 + k).padStart(11, '0')}`.slice(0, 13), Math.round(price * 1.1), price, Math.round(price * 0.7), 10, now - 100 * 86400000, now - 86400000)
        const vid = Number(vr.lastInsertRowid)
        const qty = Math.floor(rand() * 400)
        si.run(vid, locId, qty)
        mi.run(randomUUID(), vid, locId, qty + 50, qty + 50, 'opening', null, null, Math.round(price * 0.7), userId, posId, now - 95 * 86400000)
        vcount++
      }
    }
    // some historic purchase / sale-style movements so the ledger has depth
    const maxVar = vcount
    for (let i = 0; i < 40000; i++) {
      const vid = 1 + Math.floor(rand() * maxVar)
      const d = (i % 2 ? -1 : 1) * (1 + Math.floor(rand() * 5))
      mi.run(randomUUID(), vid, locId, d, 100, i % 2 ? 'sale' : 'purchase', null, null, null, userId, posId, now - Math.floor(rand() * o.days * 86400000))
    }
  })

  // sales + items + payments
  const variants = db.all<{ id: number; product_id: number; sku: string; barcode: string; mrp: number; price: number; cost: number; name: string; category_id: number; brand_id: number; tax: number }>(
    `SELECT v.id, v.product_id, v.sku, v.barcode, v.mrp, v.price, v.cost, p.name, p.category_id, p.brand_id, p.tax_rate_bp tax FROM product_variants v JOIN products p ON p.id=v.product_id`
  )
  const custCount = o.nCust
  const year = new Date(now).getFullYear()
  db.transaction(() => {
    const shift = db.run('INSERT INTO shifts(uuid,pos_id,user_id,opened_at,closed_at,opening_cash,closing_cash,expected_cash) VALUES (?,?,?,?,?,?,?,?)', randomUUID(), posId, userId, now - o.days * 86400000, now - 1000, 100000, 100000, 100000).lastId
    const si = db.raw.prepare(
      `INSERT INTO sales(uuid,invoice_no,pos_id,shift_id,user_id,customer_id,status,subtotal,discount,tax,round_off,total,paid,change_given,profile_version_id,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    const ii = db.raw.prepare(
      `INSERT INTO sale_items(sale_id,variant_id,name,sku,barcode,hsn,category_id,brand_id,qty,unit_price,mrp,cost,discount,tax_rate_bp,tax_amount,line_total) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    const pay = db.raw.prepare('INSERT INTO sale_payments(sale_id,method,amount) VALUES (?,?,?)')
    const dayMs = 86400000
    for (let n = 0; n < o.nSales; n++) {
      const day = Math.floor((n / o.nSales) * o.days)
      const ts = now - (o.days - day) * dayMs + Math.floor(rand() * 10 * 3600000) + 9 * 3600000 - dayMs / 2
      const lines = 1 + Math.floor(rand() * 5)
      let sub = 0
      let tax = 0
      const picked = Array.from({ length: lines }, () => variants[Math.floor(rand() * variants.length)])
      const rows = picked.map((v) => {
        const qty = 1 + Math.floor(rand() * 4)
        const lt = v.price * qty
        const t = Math.round((lt * v.tax) / (10000 + v.tax))
        sub += lt
        tax += t
        return { v, qty, lt, t }
      })
      const status = rand() < 0.01 ? 'voided' : 'completed'
      const r = si.run(randomUUID(), `INV-${year}-${String(n + 1).padStart(6, '0')}`, posId, shift, userId, rand() < 0.4 ? 1 + Math.floor(rand() * custCount) : null, status, sub - tax, 0, tax, 0, sub, sub, 0, profId, ts)
      const sid = Number(r.lastInsertRowid)
      for (const x of rows) ii.run(sid, x.v.id, x.v.name, x.v.sku, x.v.barcode, '36041000', x.v.category_id, x.v.brand_id, x.qty, x.v.price, x.v.mrp, x.v.cost, 0, x.v.tax, x.t, x.lt)
      pay.run(sid, pick(['cash', 'cash', 'upi', 'card']), sub)
    }
    // audit + sync queue depth (a busy shop accumulates these)
    const ai = db.raw.prepare('INSERT INTO audit_log(user_id,user_name,entity,entity_id,action,ts) VALUES (?,?,?,?,?,?)')
    for (let i = 0; i < 20000; i++) ai.run(userId, 'Owner', 'sale', String(i), pick(['sale.complete', 'product.update', 'stock.adjust']), now - Math.floor(rand() * o.days * dayMs))
    const qi = db.raw.prepare("INSERT INTO sync_queue(entity,entity_uuid,op,payload_json,pos_id,status) VALUES (?,?,?,?,?,'sent')")
    for (let i = 0; i < 30000; i++) qi.run('sales', randomUUID(), 'upsert', '{"x":1}', posId)
  })
  // the bill-number counter continues after the seeded invoices (so pos.completeSale works on the seeded database)
  db.run('INSERT OR REPLACE INTO invoice_sequences(series,year,next_no) VALUES (?,?,?)', 'INV', year, o.nSales + 1)
  db.exec('ANALYZE')
  console.log(`[perf-seed] ${o.products} products, ${o.nCust} customers, ${o.nSales} sales seeded in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  if (!o.keepOpen) app.close()
  return app
}

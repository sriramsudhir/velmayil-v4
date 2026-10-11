import type { App } from '../../src/main/core/app'

/** Local-time epoch ms (reports use LOCAL day boundaries). m is 1-based. */
export const local = (y: number, m: number, d: number, h = 0, mi = 0, s = 0, ms = 0): number => new Date(y, m - 1, d, h, mi, s, ms).getTime()

export interface V {
  id: number; productId: number; sku: string; name: string; price: number; cost: number; rateBp: number; hsn: string
  categoryId: number; brandId: number; unit: string
}

export interface Catalog {
  variants: Record<string, V>
  categories: Record<string, number>
  brands: Record<string, number>
  pos2: number
  users: { A: number; B: number; C: number; admin: number }
  customers: { ravi: number; meena: number }
}

/** Categories, brands, 7 products/variants (GST 5/12/18/28), 2 POS, 3 cashiers, 2 customers. */
export function seedCatalog(app: App): Catalog {
  const db = app.db
  const u = () => app.uuid()
  const cat = (n: string) => db.run('INSERT INTO categories(uuid,name) VALUES (?,?)', u(), n).lastId
  const brand = (n: string) => db.run('INSERT INTO brands(uuid,name) VALUES (?,?)', u(), n).lastId
  const categories = { Sparklers: cat('Sparklers'), Crackers: cat('Crackers') }
  const brands = { Standard: brand('Standard'), Cock: brand('Cock') }
  const old = local(2026, 1, 1)
  const variants: Record<string, V> = {}
  const add = (sku: string, name: string, c: keyof typeof categories, b: keyof typeof brands, hsn: string, rateBp: number, price: number, cost: number, reorder: number, qty: number) => {
    const pid = db.run(
      'INSERT INTO products(uuid,name,category_id,brand_id,hsn,tax_rate_bp,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
      u(), name, categories[c], brands[b], hsn, rateBp, old, old
    ).lastId
    const vid = db.run(
      'INSERT INTO product_variants(uuid,product_id,name,sku,mrp,price,cost,reorder_level,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      u(), pid, '', sku, price, price, cost, reorder, old, old
    ).lastId
    db.run('INSERT INTO stock_levels(variant_id,location_id,qty) VALUES (?,?,?)', vid, app.defaultLocationId(), qty)
    variants[sku] = { id: vid, productId: pid, sku, name, price, cost, rateBp, hsn, categoryId: categories[c], brandId: brands[b], unit: 'pcs' }
  }
  add('V1', 'Sparkler Box', 'Sparklers', 'Standard', '3604', 1800, 11800, 6000, 10, 5)
  add('V2', 'Flower Pot', 'Crackers', 'Cock', '3604', 2800, 12800, 7000, 5, 20)
  add('V3', 'Notebook', 'Sparklers', 'Standard', '4820', 500, 10500, 6000, 10, 8)
  add('V4', 'Cotton Tee', 'Crackers', 'Cock', '6109', 1200, 11200, 5000, 3, 0)
  add('V5', 'Gift Hamper', 'Crackers', 'Standard', '9503', 1800, 9999, 5000, 0, 100)
  add('DEAD1', 'Unsold Item', 'Crackers', 'Standard', '9503', 1800, 2000, 1000, 0, 3)
  add('OLD1', 'Old Seller', 'Sparklers', 'Standard', '3604', 1800, 4000, 2500, 0, 4)

  const pos2 = db.run('INSERT INTO pos_terminals(uuid,code,name,is_local) VALUES (?,?,?,0)', u(), 'POS-02', 'Counter 2').lastId
  const roleId = db.value<number>("SELECT id FROM roles WHERE name='Cashier'")!
  const user = (un: string, name: string) => db.run('INSERT INTO users(uuid,username,name,role_id,password_hash) VALUES (?,?,?,?,?)', u(), un, name, roleId, 'x:x').lastId
  const users = { A: user('anbu', 'Anbu'), B: user('bala', 'Bala'), C: user('chitra', 'Chitra'), admin: db.value<number>("SELECT id FROM users WHERE username='admin'")! }
  const cust = (n: string, phone: string, gstin = '') => db.run('INSERT INTO customers(uuid,name,phone,gstin) VALUES (?,?,?,?)', u(), n, phone, gstin).lastId
  const customers = { ravi: cust('Ravi', '9000000001', '33AAAAA0000A1Z5'), meena: cust('Meena, "M" Traders\nUnit 2 ராஜா', '9000000002') }
  return { variants, categories, brands, pos2, users, customers }
}

export interface LineSpec { v: V; qty: number; discount?: number; overridden?: boolean }
export interface SaleSpec {
  no: string; ts: number; posId: number; userId: number; customerId?: number | null; shiftId?: number | null
  lines: LineSpec[]; pays: { method: string; amount: number }[]; change?: number
  status?: string; voidedAt?: number; voidReason?: string; voidedBy?: number
}
export interface SaleOut { id: number; total: number; subtotal: number; discount: number; tax: number; roundOff: number; lineIds: number[]; lines: { v: V; qty: number; lineTotal: number; tax: number; discount: number }[] }

/** Prices are tax-INCLUSIVE; line_total = qty*price - discount; tax = line_total * r / (1+r); bill total rounded to whole rupees. */
export function makeInserter(app: App) {
  const raw = app.db.raw
  const sale = raw.prepare(
    `INSERT INTO sales(uuid,invoice_no,pos_id,shift_id,user_id,customer_id,status,subtotal,discount,tax,round_off,total,paid,change_given,prices_include_tax,profile_version_id,void_reason,voided_by,voided_at,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,1,?,?,?,?)`
  )
  const item = raw.prepare(
    `INSERT INTO sale_items(sale_id,variant_id,name,sku,hsn,category_id,brand_id,qty,unit_price,mrp,cost,discount,tax_rate_bp,tax_amount,line_total,price_overridden)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  )
  const pay = raw.prepare('INSERT INTO sale_payments(sale_id,method,amount) VALUES (?,?,?)')
  const ret = raw.prepare(
    `INSERT INTO sale_returns(uuid,return_no,sale_id,pos_id,user_id,shift_id,subtotal,tax,total,refund_method,reason,profile_version_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?)`
  )
  const retItem = raw.prepare('INSERT INTO sale_return_items(return_id,sale_item_id,variant_id,qty,unit_price,tax_amount,line_total) VALUES (?,?,?,?,?,?,?)')
  let seq = 0
  const uuid = () => `u-${++seq}-${Math.random().toString(36).slice(2, 10)}`

  const insertSale = (s: SaleSpec): SaleOut => {
    let subtotal = 0, discount = 0, tax = 0, exact = 0
    const calc = s.lines.map((l) => {
      const gross = l.qty * l.v.price
      const d = l.discount ?? 0
      const lt = gross - d
      const t = Math.round((lt * l.v.rateBp) / (10000 + l.v.rateBp))
      subtotal += gross; discount += d; tax += t; exact += lt
      return { l, gross, d, lt, t }
    })
    const total = Math.round(exact / 100) * 100
    const roundOff = total - exact
    // payments are stored NET of change (SUM = total); sales.paid is the tendered amount
    const paid = s.pays.reduce((a, p) => a + p.amount, 0) + (s.change ?? 0)
    const void_ = s.status === 'voided'
    const r = sale.run(
      uuid(), s.no, s.posId, s.shiftId ?? null, s.userId, s.customerId ?? null, s.status ?? 'completed', subtotal, discount, tax, roundOff, total, paid, s.change ?? 0,
      void_ ? s.voidReason ?? 'void' : null, void_ ? s.voidedBy ?? s.userId : null, void_ ? s.voidedAt ?? s.ts : null, s.ts
    )
    const id = Number(r.lastInsertRowid)
    const lineIds: number[] = []
    for (const c of calc) {
      const i = item.run(id, c.l.v.id, c.l.v.name, c.l.v.sku, c.l.v.hsn, c.l.v.categoryId, c.l.v.brandId, c.l.qty, c.l.v.price, c.l.v.price, c.l.v.cost, c.d, c.l.v.rateBp, c.t, c.lt, c.l.overridden ? 1 : 0)
      lineIds.push(Number(i.lastInsertRowid))
    }
    for (const p of s.pays) pay.run(id, p.method, p.amount)
    return { id, total, subtotal, discount, tax, roundOff, lineIds, lines: calc.map((c) => ({ v: c.l.v, qty: c.l.qty, lineTotal: c.lt, tax: c.t, discount: c.d })) }
  }

  /** Return `qty` units of an existing sale line; amounts pro-rated from the original line. */
  const insertReturn = (o: { no: string; ts: number; saleId: number; posId: number; userId: number; shiftId?: number | null; method: string; reason?: string; lines: { sale: SaleOut; lineIdx: number; qty: number }[] }) => {
    let total = 0, tax = 0
    const parts = o.lines.map((l) => {
      const src = l.sale.lines[l.lineIdx]
      const lt = Math.round((src.lineTotal * l.qty) / src.qty)
      const t = Math.round((src.tax * l.qty) / src.qty)
      total += lt; tax += t
      return { itemId: l.sale.lineIds[l.lineIdx], v: src.v, qty: l.qty, lt, t }
    })
    const r = ret.run(uuid(), o.no, o.saleId, o.posId, o.userId, o.shiftId ?? null, total - tax, tax, total, o.method, o.reason ?? '', o.ts)
    const id = Number(r.lastInsertRowid)
    for (const p of parts) retItem.run(id, p.itemId, p.v.id, p.qty, p.v.price, p.t, p.lt)
    return { id, total, tax }
  }
  return { insertSale, insertReturn }
}

/** Deterministic PRNG */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface Oracle {
  bills: number; subtotal: number; discount: number; tax: number; roundOff: number; total: number
  retCount: number; retTotal: number; retTax: number
  voidCount: number; voidTotal: number
  received: Record<string, number>; change: number; refunds: Record<string, number>
  byDay: Record<string, { bills: number; total: number; ret: number }>
  byVariant: Record<string, { qty: number; total: number; tax: number; cost: number }>
  byRate: Record<number, { taxable: number; tax: number }>
  byUser: Record<number, { bills: number; total: number }>
  byPos: Record<number, { bills: number; total: number }>
  profit: number
}

const dayKey = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * Bulk generator: `days` local days ending on (endY,endM,endD), `perDay` sales/day across 2 POS, 3 cashiers, mixed payments,
 * ~4% returns, ~2% voids. Returns an independent JS-computed oracle.
 */
export function generate(app: App, cat: Catalog, o: { endY: number; endM: number; endD: number; days: number; perDay: number; seed: number }): Oracle {
  const rnd = rng(o.seed)
  const { insertSale, insertReturn } = makeInserter(app)
  const vs = ['V1', 'V2', 'V3', 'V4', 'V5'].map((k) => cat.variants[k])
  const cashiers = [cat.users.A, cat.users.B, cat.users.C]
  const posIds = [app.localPos().id, cat.pos2]
  const custs = [null, null, null, cat.customers.ravi, cat.customers.meena]
  const orc: Oracle = {
    bills: 0, subtotal: 0, discount: 0, tax: 0, roundOff: 0, total: 0, retCount: 0, retTotal: 0, retTax: 0, voidCount: 0, voidTotal: 0,
    received: {}, change: 0, refunds: {}, byDay: {}, byVariant: {}, byRate: {}, byUser: {}, byPos: {}, profit: 0
  }
  const add = (m: Record<string, number>, k: string, v: number) => { m[k] = (m[k] ?? 0) + v }
  const day = (k: string) => (orc.byDay[k] ??= { bills: 0, total: 0, ret: 0 })
  let n = 0
  app.db.transaction(() => {
    for (let di = o.days - 1; di >= 0; di--) {
      for (let k = 0; k < o.perDay; k++) {
        n++
        const ts = local(o.endY, o.endM, o.endD - di, 8 + Math.floor(rnd() * 14), Math.floor(rnd() * 60), Math.floor(rnd() * 60))
        const nl = 1 + Math.floor(rnd() * 3)
        const lines = Array.from({ length: nl }, () => {
          const v = vs[Math.floor(rnd() * vs.length)]
          const qty = 1 + Math.floor(rnd() * 4)
          const discount = rnd() < 0.15 ? Math.floor((qty * v.price * (0.02 + rnd() * 0.08)) / 100) * 100 : 0
          return { v, qty, discount }
        })
        const exact = lines.reduce((a, l) => a + l.qty * l.v.price - l.discount, 0)
        const total = Math.round(exact / 100) * 100
        const pick = rnd()
        let pays: { method: string; amount: number }[]
        let change = 0
        if (pick < 0.35) { change = Math.floor(rnd() * 3) * 500; pays = [{ method: 'cash', amount: total }] }
        else if (pick < 0.6) pays = [{ method: 'upi', amount: total }]
        else if (pick < 0.75) pays = [{ method: 'card', amount: total }]
        else if (pick < 0.85) pays = [{ method: 'credit', amount: total }]
        else { const c = Math.floor(total / 200) * 100; pays = [{ method: 'cash', amount: c }, { method: 'upi', amount: total - c }] }
        const isVoid = rnd() < 0.02
        const posId = posIds[Math.floor(rnd() * 2)]
        const userId = cashiers[Math.floor(rnd() * 3)]
        const sale = insertSale({
          no: `G-${o.seed}-${n}`, ts, posId, userId, customerId: custs[Math.floor(rnd() * custs.length)], lines, pays, change,
          status: isVoid ? 'voided' : 'completed', voidedAt: ts + 60000, voidReason: 'test void'
        })
        if (isVoid) { orc.voidCount++; orc.voidTotal += sale.total; continue }
        orc.bills++; orc.subtotal += sale.subtotal; orc.discount += sale.discount; orc.tax += sale.tax; orc.roundOff += sale.roundOff; orc.total += sale.total
        for (const p of pays) add(orc.received, p.method, p.amount)
        orc.change += change
        const dk = dayKey(ts)
        day(dk).bills++; day(dk).total += sale.total
        ;(orc.byUser[userId] ??= { bills: 0, total: 0 }).bills++; orc.byUser[userId].total += sale.total
        ;(orc.byPos[posId] ??= { bills: 0, total: 0 }).bills++; orc.byPos[posId].total += sale.total
        for (const l of sale.lines) {
          const bv = (orc.byVariant[l.v.sku] ??= { qty: 0, total: 0, tax: 0, cost: 0 })
          bv.qty += l.qty; bv.total += l.lineTotal; bv.tax += l.tax; bv.cost += l.qty * l.v.cost
          const br = (orc.byRate[l.v.rateBp] ??= { taxable: 0, tax: 0 })
          br.taxable += l.lineTotal - l.tax; br.tax += l.tax
          orc.profit += l.lineTotal - l.tax - l.qty * l.v.cost
        }
        if (rnd() < 0.05) {
          const li = Math.floor(rnd() * sale.lines.length)
          const method = rnd() < 0.7 ? 'cash' : 'upi'
          const rts = ts + 3_600_000 * (1 + Math.floor(rnd() * 3))
          if (dayKey(rts) <= dayKey(local(o.endY, o.endM, o.endD))) {
            const r = insertReturn({ no: `GR-${o.seed}-${n}`, ts: rts, saleId: sale.id, posId, userId, method, lines: [{ sale, lineIdx: li, qty: 1 }] })
            const src = sale.lines[li]
            orc.retCount++; orc.retTotal += r.total; orc.retTax += r.tax
            add(orc.refunds, method, r.total)
            day(dayKey(rts)).ret += r.total
            const bv = orc.byVariant[src.v.sku]
            bv.qty -= 1; bv.total -= r.total; bv.tax -= r.tax; bv.cost -= src.v.cost
            const br = orc.byRate[src.v.rateBp]
            br.taxable -= r.total - r.tax; br.tax -= r.tax
            orc.profit -= r.total - r.tax - src.v.cost
          }
        }
      }
    }
  })
  return orc
}

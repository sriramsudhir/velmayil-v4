import { describe, expect, it } from 'vitest'
import type { ReportResult, ReportRow } from '../../src/shared/reports'
import { local, makeInserter, seedCatalog } from './fixture'
import { reportsApp, run } from './setup'

const RANGE = { from: '2026-05-01', to: '2026-05-02' }
const row = (r: ReportResult, key: string, val: string | number): ReportRow => {
  const x = r.rows.find((q) => q[key] === val)
  if (!x) throw new Error(`row ${key}=${val} not found: ${JSON.stringify(r.rows.map((q) => q[key]))}`)
  return x
}

/**
 * INV-A: 2 x Sparkler Box = 23600, paid UPI 11800 + cash 11800, shift #s.
 * RET-A: 1 unit (11800) refunded "to the original payment method": 5900 cash leaves the drawer (refund_cash), 5900 goes back on UPI.
 * INV-B: 1 x Sparkler Box = 11800 cash, fully refunded "original" -> all 11800 is cash.
 */
function build() {
  const app = reportsApp()
  const cat = seedCatalog(app)
  const { insertSale, insertReturn } = makeInserter(app)
  const pos = app.localPos().id
  const u = cat.users.A
  const s = app.db.run('INSERT INTO shifts(uuid,pos_id,user_id,opened_at,closed_at,opening_cash,closing_cash) VALUES (?,?,?,?,?,?,?)', app.uuid(), pos, u, local(2026, 5, 1, 9), null, 10000, null).lastId
  const A = insertSale({ no: 'INV-A', ts: local(2026, 5, 1, 10), posId: pos, userId: u, shiftId: s, lines: [{ v: cat.variants.V1, qty: 2 }], pays: [{ method: 'upi', amount: 11800 }, { method: 'cash', amount: 11800 }] })
  const B = insertSale({ no: 'INV-B', ts: local(2026, 5, 1, 11), posId: pos, userId: u, shiftId: s, lines: [{ v: cat.variants.V1, qty: 1 }], pays: [{ method: 'cash', amount: 11800 }] })
  const ra = insertReturn({ no: 'RET-A', ts: local(2026, 5, 1, 12), saleId: A.id, posId: pos, userId: u, shiftId: s, method: 'original', lines: [{ sale: A, lineIdx: 0, qty: 1 }] })
  const rb = insertReturn({ no: 'RET-B', ts: local(2026, 5, 1, 13), saleId: B.id, posId: pos, userId: u, shiftId: s, method: 'original', lines: [{ sale: B, lineIdx: 0, qty: 1 }] })
  app.db.run('UPDATE sale_returns SET refund_cash = ? WHERE id = ?', 5900, ra.id)
  app.db.run('UPDATE sale_returns SET refund_cash = ? WHERE id = ?', 11800, rb.id)
  return { app, shiftId: s }
}

describe('refunds to the original payment method', () => {
  it('payment methods: no "original" method; cash part on cash, the rest on the method the bill was paid with', async () => {
    const { app } = build()
    const r = await run(app, 'payment_methods', RANGE)
    expect(r.rows.map((x) => x.method)).toEqual(['cash', 'upi'])
    expect(row(r, 'method', 'cash')).toMatchObject({ received: 23600, refunds: 5900 + 11800, net: 5900 })
    expect(row(r, 'method', 'upi')).toMatchObject({ received: 11800, refunds: 5900, net: 5900 })
    expect(r.totals).toMatchObject({ received: 35400, refunds: 23600, refunds_count: 2, net: 11800 })
    const s = await run(app, 'sales_summary', RANGE)
    expect(r.totals!.net).toBe((s.totals!.total as number) - (s.totals!.returns as number))
  })

  it('shift cash: expected cash drops by the cash that really left the drawer (same figure as the shift-close screen)', async () => {
    const { app, shiftId } = build()
    const r = await run(app, 'shift_cash', RANGE)
    expect(r.rows).toHaveLength(1)
    // opening 10000 + cash sales 23600 - cash refunds (5900 + 11800)
    expect(r.rows[0]).toMatchObject({ shift: `#${shiftId}`, cash_sales: 23600, cash_refunds: 17700, expected: 15900 })
  })
})

describe('report totals rows', () => {
  it('category / brand share adds up to exactly 100 %', async () => {
    const app = reportsApp()
    const cat = seedCatalog(app)
    const { insertSale } = makeInserter(app)
    const pos = app.localPos().id
    // three categories of thirds would round to 3333 + 3333 + 3333 = 9999; here 1/3 vs 2/3 of revenue
    insertSale({ no: 'INV-S', ts: local(2026, 5, 1, 10), posId: pos, userId: cat.users.A, lines: [{ v: cat.variants.V1, qty: 1 }, { v: cat.variants.V2, qty: 1 }, { v: cat.variants.V5, qty: 1 }], pays: [{ method: 'cash', amount: 34600 }] })
    for (const id of ['category_sales', 'brand_sales']) {
      const r = await run(app, id, RANGE)
      expect(r.rows.length).toBeGreaterThan(1)
      expect(r.totals!.share).toBe(10000)
    }
    const empty = await run(app, 'category_sales', { from: '2025-01-01', to: '2025-01-02' })
    expect(empty.rows).toEqual([])
    expect(empty.totals!.share).toBe(0)
  })

  it('tax register: a credit note that also refunds the round-off still adds up (taxable + tax + round-off = value)', async () => {
    const app = reportsApp()
    const cat = seedCatalog(app)
    const { insertSale } = makeInserter(app)
    const pos = app.localPos().id
    // Gift Hamper 9999 -> bill rounded to 10000 (round-off +1)
    const S = insertSale({ no: 'INV-R', ts: local(2026, 5, 1, 10), posId: pos, userId: cat.users.A, lines: [{ v: cat.variants.V5, qty: 1 }], pays: [{ method: 'cash', amount: 10000 }] })
    expect(S.roundOff).toBe(1)
    const ret = app.db.run(
      `INSERT INTO sale_returns(uuid,return_no,sale_id,pos_id,user_id,subtotal,tax,total,refund_method,reason,profile_version_id,created_at,refund_cash) VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?)`,
      app.uuid(), 'RET-R', S.id, pos, cat.users.A, 10000 - S.tax, S.tax, 10000, 'cash', 'full return', local(2026, 5, 1, 12), 10000
    ).lastId
    app.db.run('INSERT INTO sale_return_items(return_id,sale_item_id,variant_id,qty,unit_price,tax_amount,line_total) VALUES (?,?,?,?,?,?,?)', ret, S.lineIds[0], cat.variants.V5.id, 1, 9999, S.tax, 9999)
    const r = await run(app, 'tax_register', RANGE)
    const cn = row(r, 'doc_no', 'RET-R')
    expect(cn).toMatchObject({ type: 'Credit note', total: -10000, round_off: -1 })
    expect((cn.taxable as number) + (cn.cgst as number) + (cn.sgst as number) + (cn.round_off as number)).toBe(cn.total)
    // invoice and its full credit note cancel out completely
    expect(r.totals).toMatchObject({ taxable: 0, round_off: 0, total: 0 })
  })

  it('exports of an empty report do not fail', async () => {
    const app = reportsApp()
    seedCatalog(app)
    const f = { from: '2025-01-01', to: '2025-01-02' }
    for (const id of ['sales_summary', 'sales_detail', 'item_sales', 'payment_methods', 'tax_register', 'shift_cash']) {
      const x = (await app.call('reports', 'exportXlsx', { id, filters: f })) as { bytes: number; base64?: string }
      expect(x.bytes).toBeGreaterThan(0)
      const c = (await app.call('reports', 'exportCsv', { id, filters: f })) as { bytes: number }
      expect(c.bytes).toBeGreaterThan(0)
    }
  })

  it('stock report search treats % and _ as text', async () => {
    const app = reportsApp()
    seedCatalog(app)
    expect((await run(app, 'stock_valuation', { search: '%' })).rows).toEqual([])
    expect((await run(app, 'stock_valuation', { search: '_' })).rows).toEqual([])
    expect((await run(app, 'stock_valuation', { search: 'Sparkler' })).rows.length).toBe(1)
  })
})

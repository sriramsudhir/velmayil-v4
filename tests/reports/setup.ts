import type { App } from '../../src/main/core/app'
import { createTestApp } from '../helpers'
import { register } from '../../src/main/modules/reports'
import type { ReportFilters, ReportResult } from '../../src/shared/reports'
import { local, makeInserter, seedCatalog, type Catalog, type SaleOut } from './fixture'

/** App with ONLY the reports module registered (independent of other agents' work in progress). */
export function reportsApp(): App {
  const app = createTestApp({ modules: false })
  register(app)
  return app
}

export const run = (app: App, id: string, filters: ReportFilters = {}): Promise<ReportResult> =>
  app.call('reports', 'run', { id, filters }) as Promise<ReportResult>

export const RANGE: ReportFilters = { from: '2026-04-10', to: '2026-04-11' }
export const NOW = local(2026, 4, 11, 15, 0)

export interface Mini {
  cat: Catalog
  s: Record<'S0' | 'S1' | 'S2' | 'S3' | 'S4' | 'S5', SaleOut>
  shifts: { s1: number; s2: number; s3: number }
  ret: { id: number }
}

/** Hand-computed scenario; see comments in reports.test.ts for the expected numbers. */
export function buildMini(app: App): Mini {
  const cat = seedCatalog(app)
  const db = app.db
  const { insertSale, insertReturn } = makeInserter(app)
  const pos1 = app.localPos().id
  const { A, B, C, admin } = cat.users
  const v = cat.variants
  const shift = (posId: number, userId: number, opened: number, closed: number | null, opening: number, closing: number | null) =>
    db.run('INSERT INTO shifts(uuid,pos_id,user_id,opened_at,closed_at,opening_cash,closing_cash) VALUES (?,?,?,?,?,?,?)', app.uuid(), posId, userId, opened, closed, opening, closing).lastId
  const s1 = shift(pos1, A, local(2026, 4, 10, 9), local(2026, 4, 10, 20), 50000, 73000)
  const s3 = shift(cat.pos2, B, local(2026, 4, 10, 13), local(2026, 4, 10, 22), 10000, 33600)
  const s2 = shift(pos1, C, local(2026, 4, 11, 8), null, 20000, null)

  const S0 = insertSale({ no: 'INV-0', ts: local(2026, 2, 1, 12), posId: pos1, userId: A, lines: [{ v: v.OLD1, qty: 1 }], pays: [{ method: 'cash', amount: 4000 }] })
  const S1 = insertSale({ no: 'INV-1', ts: local(2026, 4, 10, 10, 15), posId: pos1, userId: A, shiftId: s1, lines: [{ v: v.V1, qty: 2 }], pays: [{ method: 'cash', amount: 23600 }], change: 1400 })
  const S2 = insertSale({
    no: 'INV-2', ts: local(2026, 4, 10, 10, 45), posId: pos1, userId: A, shiftId: s1, customerId: cat.customers.ravi,
    lines: [{ v: v.V2, qty: 1, overridden: true }, { v: v.V3, qty: 2, discount: 1000 }], pays: [{ method: 'upi', amount: 20000 }, { method: 'card', amount: 12800 }]
  })
  const S3 = insertSale({
    no: 'INV-3', ts: local(2026, 4, 10, 14, 5), posId: cat.pos2, userId: B, shiftId: s3, customerId: cat.customers.ravi,
    lines: [{ v: v.V5, qty: 1 }, { v: v.V4, qty: 3 }], pays: [{ method: 'credit', amount: 20000 }, { method: 'cash', amount: 23600 }]
  })
  const S4 = insertSale({ no: 'INV-4', ts: local(2026, 4, 11, 9), posId: pos1, userId: C, shiftId: s2, lines: [{ v: v.V1, qty: 1 }], pays: [{ method: 'cash', amount: 11800 }] })
  const S5 = insertSale({
    no: 'INV-5', ts: local(2026, 4, 11, 11), posId: pos1, userId: C, shiftId: s2, lines: [{ v: v.V2, qty: 2 }], pays: [{ method: 'cash', amount: 25600 }],
    status: 'voided', voidedAt: local(2026, 4, 11, 11, 30), voidReason: 'wrong item', voidedBy: admin
  })
  const R1 = insertReturn({ no: 'RET-1', ts: local(2026, 4, 11, 12), saleId: S1.id, posId: pos1, userId: C, shiftId: s2, method: 'cash', reason: 'damaged', lines: [{ sale: S1, lineIdx: 0, qty: 1 }] })

  // approval for the discounted bill
  db.run('INSERT INTO approvals(action,entity,entity_id,requested_by,approved_by,reason) VALUES (?,?,?,?,?,?)', 'discount', 'sale', String(S2.id), A, admin, 'festival')

  // stock ledger for V1
  const mv = (variant: number, delta: number, bal: number, type: string, ts: number, ref?: string) =>
    db.run(
      'INSERT INTO stock_movements(uuid,variant_id,location_id,qty_delta,balance_after,type,ref_type,ref_id,unit_cost,ts) VALUES (?,?,?,?,?,?,?,?,?,?)',
      app.uuid(), variant, app.defaultLocationId(), delta, bal, type, ref ? 'sale' : null, ref ?? null, 6000, ts
    )
  mv(v.V1.id, 10, 10, 'opening', local(2026, 3, 1, 9))
  mv(v.V1.id, -2, 8, 'sale', local(2026, 4, 10, 10, 15), 'INV-1')
  mv(v.V1.id, -1, 7, 'sale', local(2026, 4, 11, 9), 'INV-4')
  mv(v.V1.id, 1, 8, 'sale_return', local(2026, 4, 11, 12), 'RET-1')

  // purchases / payables
  const sup = (n: string) => db.run('INSERT INTO suppliers(uuid,name,phone) VALUES (?,?,?)', app.uuid(), n, '').lastId
  const sri = sup('Sri Traders'), kumar = sup('Kumar & Sons'), idle = sup('Idle Supplier')
  void idle
  const loc = app.defaultLocationId()
  const pur = (no: string, sid: number, ts: number, status: string, subtotal: number, tax: number, total: number, paid: number) =>
    db.run('INSERT INTO purchases(uuid,number,supplier_id,supplier_invoice_no,location_id,status,subtotal,tax,total,paid,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)', app.uuid(), no, sid, 'SI-' + no, loc, status, subtotal, tax, total, paid, ts)
  pur('PO-1', sri, local(2026, 4, 5, 11), 'received', 84746, 15254, 100000, 40000)
  pur('PO-2', kumar, local(2026, 4, 8, 11), 'received', 42373, 7627, 50000, 50000)
  pur('PO-3', sri, local(2026, 4, 9, 11), 'cancelled', 1, 1, 99999, 0)
  db.run('INSERT INTO supplier_returns(uuid,number,supplier_id,location_id,total,created_at) VALUES (?,?,?,?,?,?)', app.uuid(), 'SR-1', sri, loc, 5000, local(2026, 4, 9, 12))

  // audit rows
  const aud = (ts: number, user: number, name: string, entity: string, action: string, note: string) =>
    db.run('INSERT INTO audit_log(ts,user_id,user_name,pos_id,pos_code,entity,entity_id,action,note) VALUES (?,?,?,?,?,?,?,?,?)', ts, user, name, pos1, 'POS-01', entity, '1', action, note)
  aud(local(2026, 4, 10, 9), A, 'Anbu', 'sale', 'create', 'bill one')
  aud(local(2026, 4, 11, 11, 30), admin, 'Admin', 'sale', 'void', 'wrong item')
  aud(local(2026, 4, 11, 13), admin, 'Admin', 'user', 'update', 'role change')

  return { cat, s: { S0, S1, S2, S3, S4, S5 }, shifts: { s1, s2, s3 }, ret: { id: R1.id } }
}

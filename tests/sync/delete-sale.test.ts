/** Permanent "delete order" across terminals: the bill disappears everywhere, stock is restored exactly once, nothing comes back. */
import { describe, it, expect, afterEach } from 'vitest'
import { addProduct, cleanup, makePos, movementSum, settle, startServer, stockOf, useHttp, type Pos } from './harness'
import { enrichPayload } from '../../src/main/modules/sync/collector'
import type { Change } from '../../src/main/modules/sync/protocol'
import type { Snapshot } from '../../src/main/core/snapshot'

afterEach(cleanup)

const c = <T = any>(p: Pos, s: string, m: string, a?: unknown) => p.app.call(s, m, a) as Promise<T>
const count = (p: Pos, sql: string, ...a: (string | number)[]) => p.app.db.value<number>(sql, ...a) ?? 0
const saleRows = (p: Pos) => ['sales', 'sale_items', 'sale_payments', 'sale_returns', 'sale_return_items'].map((t) => count(p, `SELECT COUNT(*) FROM ${t}`))
const variantOf = (p: Pos, sku: string) => p.app.db.value<number>('SELECT id FROM product_variants WHERE sku = ?', sku)!
const ledgerOk = async (p: Pos) => ((await c(p, 'inventory', 'verifyLedger')) as { ok: boolean }).ok

async function twoPos(): Promise<[Pos, Pos]> {
  const srv = await startServer()
  const p1 = makePos('POS-01')
  const p2 = makePos('POS-02')
  useHttp(p1, srv.url)
  useHttp(p2, srv.url)
  return [p1, p2]
}

/** This terminal's queued changes exactly as the transport would deliver them. */
function outbox(p: Pos): Change[] {
  const dev = p.sync.device()
  return p.app.db
    .all<{ id: number; entity: string; entity_uuid: string; op: 'upsert' | 'delete'; payload_json: string; created_at: number }>('SELECT * FROM sync_queue ORDER BY id')
    .map((r) => ({
      device: dev.uuid, deviceCode: dev.code, deviceName: dev.name, qid: r.id, entity: r.entity, entityUuid: r.entity_uuid, op: r.op, createdAt: r.created_at,
      payload: enrichPayload(p.app.db, r.entity, JSON.parse(r.payload_json) as Snapshot)
    }))
}

describe('delete order: multi-POS sync', () => {
  it('a bill deleted on POS-1 disappears on POS-2; stock is restored once on both; a resync never brings it back', async () => {
    const [p1, p2] = await twoPos()
    addProduct(p1.app, { name: 'Rocket', sku: 'RKT', price: 5000, qty: 20 })
    await settle([p1, p2])
    const keep = await c(p1, 'pos', 'completeSale', { lines: [{ variantId: variantOf(p1, 'RKT'), qty: 1 }], payments: [{ method: 'cash', amount: 5000 }] })
    const s = await c(p1, 'pos', 'completeSale', { lines: [{ variantId: variantOf(p1, 'RKT'), qty: 3 }], payments: [{ method: 'cash', amount: 15000 }] })
    const uuid = p1.app.db.value<string>('SELECT uuid FROM sales WHERE id = ?', s.saleId)!
    await settle([p1, p2])
    for (const p of [p1, p2]) {
      expect(count(p, 'SELECT COUNT(*) FROM sales')).toBe(2)
      expect(stockOf(p.app, 'RKT')).toBe(16)
    }
    const remoteId = p2.app.db.value<number>('SELECT id FROM sales WHERE uuid = ?', uuid)!

    await c(p1, 'pos', 'deleteSale', { saleId: s.saleId, reason: 'billed twice' })
    expect(stockOf(p1.app, 'RKT')).toBe(19)
    expect(count(p2, 'SELECT COUNT(*) FROM sales')).toBe(2) // not synced yet
    await settle([p1, p2])

    for (const p of [p1, p2]) {
      expect(saleRows(p)).toEqual([1, 1, 1, 0, 0])
      expect(p.app.db.value('SELECT invoice_no FROM sales')).toBe(keep.invoiceNo)
      expect(stockOf(p.app, 'RKT')).toBe(19)
      expect(movementSum(p.app, 'RKT')).toBe(19)
      expect(await ledgerOk(p)).toBe(true)
      expect(p.app.db.get<any>('SELECT * FROM deleted_sales WHERE uuid = ?', uuid)).toMatchObject({ invoice_no: s.invoiceNo, total: 15000, reason: 'billed twice', deleted_by_name: 'Admin' })
      expect(p.sync.status()).toMatchObject({ pending: 0, failed: 0, deferred: 0, openConflicts: 0 })
      expect(((await c(p, 'dashboard', 'summary', {})) as any).today).toMatchObject({ bills: 1, sales: 5000 })
    }
    // POS-2 keeps a trace that says where it was deleted
    const a = p2.app.db.get<any>("SELECT * FROM audit_log WHERE entity='sale' AND action='delete'")!
    expect(a.entity_id).toBe(String(remoteId))
    expect(a.note).toContain('POS-01')
    expect(JSON.parse(a.new_json)).toMatchObject({ reason: 'billed twice', via: 'sync' })
    expect(p2.app.db.value('SELECT deleted_by FROM deleted_sales WHERE uuid = ?', uuid)).toBeNull()

    // "send everything again" from either terminal: the bill stays gone, stock does not move
    p2.sync.resyncAll()
    p1.sync.resyncAll()
    await settle([p1, p2], 4)
    for (const p of [p1, p2]) {
      expect(saleRows(p)).toEqual([1, 1, 1, 0, 0])
      expect(stockOf(p.app, 'RKT')).toBe(19)
      expect(count(p, 'SELECT COUNT(*) FROM deleted_sales')).toBe(1)
      expect(p.sync.status()).toMatchObject({ pending: 0, deferred: 0, openConflicts: 0 })
    }
  })

  it('the owner deletes, on POS-2, a bill made on POS-1 (with a partial return): both terminals converge', async () => {
    const [p1, p2] = await twoPos()
    addProduct(p1.app, { name: 'Sparkler', sku: 'SPK', price: 2000, qty: 30 })
    await settle([p1, p2])
    const s = await c(p1, 'pos', 'completeSale', { lines: [{ variantId: variantOf(p1, 'SPK'), qty: 6 }], payments: [{ method: 'cash', amount: 12000 }] })
    const item = (await c(p1, 'pos', 'getSale', { id: s.saleId })).items[0]
    await c(p1, 'pos', 'createReturn', { saleId: s.saleId, items: [{ saleItemId: item.id, qty: 2, restock: true }], reason: 'two back' })
    await settle([p1, p2], 4)
    for (const p of [p1, p2]) {
      expect(saleRows(p)).toEqual([1, 1, 1, 1, 1])
      expect(stockOf(p.app, 'SPK')).toBe(26)
    }

    const remote = p2.app.db.value<number>('SELECT id FROM sales WHERE invoice_no = ?', s.invoiceNo)!
    const out = await c(p2, 'pos', 'deleteSale', { saleId: remote, reason: 'wrong bill' })
    expect(out.stockRestored).toBe(4) // 6 sold - 2 already returned
    await settle([p1, p2], 4)
    for (const p of [p1, p2]) {
      expect(saleRows(p)).toEqual([0, 0, 0, 0, 0])
      expect(stockOf(p.app, 'SPK')).toBe(30)
      expect(movementSum(p.app, 'SPK')).toBe(30)
      expect(await ledgerOk(p)).toBe(true)
      expect(count(p, 'SELECT COUNT(*) FROM deleted_sales')).toBe(1)
      expect(p.sync.status()).toMatchObject({ pending: 0, deferred: 0, openConflicts: 0 })
    }
    // the terminal that made the bill no longer offers it, and a new bill gets a fresh number
    await expect(c(p1, 'pos', 'getSale', { id: s.saleId })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    const next = await c(p1, 'pos', 'completeSale', { lines: [{ variantId: variantOf(p1, 'SPK'), qty: 1 }], payments: [{ method: 'cash', amount: 2000 }] })
    expect(next.invoiceNo).not.toBe(s.invoiceNo)
  })

  it('a void bill deleted on POS-1: POS-2 drops it without any stock change', async () => {
    const [p1, p2] = await twoPos()
    addProduct(p1.app, { name: 'Chakkar', sku: 'CHK', price: 3000, qty: 10 })
    await settle([p1, p2])
    const s = await c(p1, 'pos', 'completeSale', { lines: [{ variantId: variantOf(p1, 'CHK'), qty: 4 }], payments: [{ method: 'cash', amount: 12000 }] })
    await c(p1, 'pos', 'voidSale', { saleId: s.saleId, reason: 'customer left' })
    await settle([p1, p2])
    expect(p2.app.db.value('SELECT status FROM sales')).toBe('void')
    expect(stockOf(p2.app, 'CHK')).toBe(10)
    await c(p1, 'pos', 'deleteSale', { saleId: s.saleId, reason: 'tidy up' })
    await settle([p1, p2])
    for (const p of [p1, p2]) {
      expect(saleRows(p)).toEqual([0, 0, 0, 0, 0])
      expect(stockOf(p.app, 'CHK')).toBe(10)
      expect(movementSum(p.app, 'CHK')).toBe(10)
    }
  })

  it('unit-coded bill: the units are back in stock and sellable on the other terminal too', async () => {
    const [p1, p2] = await twoPos()
    const prod = await c(p1, 'catalog', 'save', {
      name: 'Gift Box', trackUnits: true, unitPrefix: 'GFT', variants: [{ name: '', sku: 'GFT1', price: 9000, mrp: 9000, cost: 4000, openingStock: 4 }]
    })
    const v1 = prod.variants[0].id as number
    await settle([p1, p2], 4)
    const s = await c(p1, 'pos', 'completeSale', { lines: [{ variantId: v1, qty: 2, unitCodes: ['GFT-0001', 'GFT-0002'] }], payments: [{ method: 'cash', amount: 18000 }] })
    await settle([p1, p2], 4)
    const unit = (p: Pos, code: string) => p.app.db.get<any>('SELECT status, sale_id, sale_item_id FROM product_units WHERE code = ?', code)
    expect(unit(p2, 'GFT-0001')).toMatchObject({ status: 'sold' })
    expect(unit(p2, 'GFT-0001').sale_id).not.toBeNull()
    expect(stockOf(p2.app, 'GFT1')).toBe(2)

    await c(p1, 'pos', 'deleteSale', { saleId: s.saleId, reason: 'test bill' })
    await settle([p1, p2], 4)
    for (const p of [p1, p2]) {
      expect(saleRows(p)).toEqual([0, 0, 0, 0, 0])
      for (const code of ['GFT-0001', 'GFT-0002']) expect(unit(p, code)).toEqual({ status: 'in_stock', sale_id: null, sale_item_id: null })
      expect(stockOf(p.app, 'GFT1')).toBe(4)
      expect(await ledgerOk(p)).toBe(true) // stock == in-stock units
      expect(p.app.db.all('PRAGMA foreign_key_check')).toEqual([])
      expect(p.sync.status()).toMatchObject({ pending: 0, deferred: 0, openConflicts: 0 })
    }
    // sold again on POS-2
    const again = await c(p2, 'pos', 'completeSale', { lines: [{ variantId: variantOf(p2, 'GFT1'), qty: 1, unitCodes: ['GFT-0001'] }], payments: [{ method: 'cash', amount: 9000 }] })
    await settle([p1, p2], 4)
    for (const p of [p1, p2]) {
      expect(unit(p, 'GFT-0001').status).toBe('sold')
      expect(stockOf(p.app, 'GFT1')).toBe(3)
      expect(await ledgerOk(p)).toBe(true)
    }
    expect(again.invoiceNo).not.toBe(s.invoiceNo)
  })

  it('tombstone: a delete that arrives BEFORE the bill (or its return / unit snapshots) keeps all of them out', async () => {
    const [p1, p2] = await twoPos()
    const prod = await c(p1, 'catalog', 'save', {
      name: 'Gift Box', trackUnits: true, unitPrefix: 'GFT', variants: [{ name: '', sku: 'GFT1', price: 9000, mrp: 9000, cost: 4000, openingStock: 3 }]
    })
    addProduct(p1.app, { name: 'Rocket', sku: 'RKT', price: 5000, qty: 10 })
    await settle([p1, p2], 4)
    const mark = count(p1, 'SELECT COALESCE(MAX(id),0) FROM sync_queue')
    // POS-1 works offline: a bill, a return on it, then the bill is deleted
    p1.sync.saveConfig({ enabled: false })
    const s = await c(p1, 'pos', 'completeSale', {
      lines: [{ variantId: prod.variants[0].id, qty: 2, unitCodes: ['GFT-0001', 'GFT-0002'] }, { variantId: variantOf(p1, 'RKT'), qty: 4 }], payments: [{ method: 'cash', amount: 38000 }]
    })
    const uuid = p1.app.db.value<string>('SELECT uuid FROM sales WHERE id = ?', s.saleId)!
    const lines = (await c(p1, 'pos', 'getSale', { id: s.saleId })).items
    // payloads as they looked while the bill still existed (what a slow transport could deliver late)
    const early = outbox(p1).filter((x) => x.qid > mark)
    await c(p1, 'pos', 'createReturn', { saleId: s.saleId, items: [{ saleItemId: lines[1].id, qty: 1 }], reason: 'one back' })
    const withReturn = outbox(p1).filter((x) => x.qid > mark)
    await c(p1, 'pos', 'deleteSale', { saleId: s.saleId, reason: 'offline mistake' })
    const all = outbox(p1).filter((x) => x.qid > mark)
    const del = all.find((x) => x.entity === 'sales' && x.op === 'delete')!
    expect(del.entityUuid).toBe(uuid)

    // POS-2 receives the delete first ...
    expect(p2.sync.processInbound(del)).toBe('applied')
    expect(count(p2, 'SELECT COUNT(*) FROM deleted_sales WHERE uuid = ?', uuid)).toBe(1)
    // ... then the late copies of the bill, its units and its return
    const sale = early.find((x) => x.entity === 'sales' && x.op === 'upsert')!
    expect(p2.sync.processInbound(sale)).toBe('skipped')
    const ret = withReturn.find((x) => x.entity === 'sale_returns')!
    expect(p2.sync.processInbound(ret)).toBe('skipped')
    for (const u of early.filter((x) => x.entity === 'product_units')) {
      expect(u.payload.row.status).toBe('sold')
      expect(['applied', 'skipped']).toContain(p2.sync.processInbound(u))
    }
    expect(saleRows(p2)).toEqual([0, 0, 0, 0, 0])
    expect(count(p2, 'SELECT COUNT(*) FROM sync_deferred')).toBe(0)
    expect(p2.app.db.all<any>("SELECT status, sale_id FROM product_units WHERE code IN ('GFT-0001','GFT-0002')")).toEqual([{ status: 'in_stock', sale_id: null }, { status: 'in_stock', sale_id: null }])
    // a second delivery of the delete is a no-op
    expect(p2.sync.processInbound({ ...del, qid: del.qid + 100000 })).toBe('skipped')

    // back online: the normal sync delivers everything (again); both terminals end up identical
    useHttp(p1, p2.sync.getConfig().url)
    await settle([p1, p2], 4)
    for (const p of [p1, p2]) {
      expect(saleRows(p)).toEqual([0, 0, 0, 0, 0])
      expect(stockOf(p.app, 'GFT1')).toBe(3)
      expect(stockOf(p.app, 'RKT')).toBe(10)
      expect(movementSum(p.app, 'RKT')).toBe(10)
      expect(await ledgerOk(p)).toBe(true)
      expect(p.sync.status()).toMatchObject({ pending: 0, deferred: 0 })
    }
    expect(count(p2, "SELECT COUNT(*) FROM sync_conflicts WHERE kind IN ('apply_error','unresolved_ref')")).toBe(0)
  })
})

import { describe, it, expect } from 'vitest'
import { createTestApp } from './helpers'
import { formatINR, pctOf } from '../src/shared/money'

describe('foundation', () => {
  it('migrates and seeds', () => {
    const app = createTestApp()
    expect(app.db.value<number>('SELECT COUNT(*) FROM schema_migrations')).toBeGreaterThanOrEqual(1)
    expect(app.localPos().code).toBe('POS-01')
  })
  it('moveStock keeps ledger and levels in sync, blocks negative', () => {
    const app = createTestApp()
    const p = app.db.run("INSERT INTO products(uuid,name) VALUES ('p1','Sparkler')")
    const v = app.db.run("INSERT INTO product_variants(uuid,product_id,sku,price) VALUES ('v1',?, 'SKU1', 10000)", p.lastId)
    expect(app.moveStock({ variantId: v.lastId, delta: 10, type: 'opening' })).toBe(10)
    expect(() => app.moveStock({ variantId: v.lastId, delta: -11, type: 'sale' })).toThrow(/Insufficient/)
    expect(app.moveStock({ variantId: v.lastId, delta: -4, type: 'sale' })).toBe(6)
    expect(app.db.value('SELECT SUM(qty_delta) FROM stock_movements')).toBe(6)
  })
  it('transactions roll back (nested too)', () => {
    const app = createTestApp()
    expect(() =>
      app.db.transaction(() => {
        app.setSetting('a', '1')
        app.db.transaction(() => {
          app.setSetting('b', '1')
        })
        throw new Error('boom')
      })
    ).toThrow('boom')
    expect(app.setting('a')).toBeUndefined()
  })
  it('numbering is sequential', () => {
    const app = createTestApp()
    expect(app.nextNumber('INV', { now: Date.UTC(2026, 9, 5) })).toBe('INV-2026-000001')
    expect(app.nextNumber('INV', { now: Date.UTC(2026, 9, 5) })).toBe('INV-2026-000002')
  })
  it('money', () => {
    expect(formatINR(12345678)).toBe('₹1,23,456.78')
    expect(pctOf(10000, 1800)).toBe(1800)
  })
  it('rpc dispatch requires session', async () => {
    const app = createTestApp()
    expect(((await app.call('app', 'info')) as { name: string }).name).toBe('Velmayil POS')
    app.session = null
    await expect(app.call('catalog', 'nothing')).rejects.toThrow()
  })
})

describe('lookup + snapshot', () => {
  it('finds variants by barcode/alias/sku and snapshots with uuid refs', () => {
    const app = createTestApp()
    const p = app.db.run("INSERT INTO products(uuid,name,tax_rate_bp) VALUES ('p-1','Rocket',1800)")
    const v = app.db.run("INSERT INTO product_variants(uuid,product_id,sku,barcode,price) VALUES ('v-1',?, 'RK1','8901234567890', 5000)", p.lastId)
    app.db.run("INSERT INTO variant_barcodes(barcode,variant_id) VALUES ('ALIAS1',?)", v.lastId)
    expect(app.lookup.byCode('8901234567890')?.productName).toBe('Rocket')
    expect(app.lookup.byCode('ALIAS1')?.variantId).toBe(v.lastId)
    expect(app.lookup.byCode('rk1')?.sku).toBe('RK1')
    expect(app.lookup.byCode('nope')).toBeUndefined()
    app.enqueueSnapshot('product_variants', v.lastId)
    const q = app.db.get<{ payload_json: string; entity: string }>('SELECT * FROM sync_queue')!
    const snap = JSON.parse(q.payload_json)
    expect(q.entity).toBe('product_variants')
    expect(snap.refs.product_id).toEqual({ table: 'products', uuid: 'p-1' })
  })
})

import { describe, it, expect } from 'vitest'
import { createTestApp } from '../helpers'
import type { App } from '../../src/main/core/app'

function mkVariant(app: App, n: string, extra: { barcode?: string; tax?: number } = {}): number {
  const p = app.db.run('INSERT INTO products(uuid,name,tax_rate_bp) VALUES (?,?,?)', `p-${n}`, `Prod ${n}`, extra.tax ?? 1800)
  return app.db.run('INSERT INTO product_variants(uuid,product_id,sku,barcode,price) VALUES (?,?,?,?,?)', `v-${n}`, p.lastId, `SKU-${n}`, extra.barcode ?? null, 1000).lastId
}

function mkSale(app: App, qty = 5): { saleId: number; itemId: number; variantId: number } {
  const variantId = mkVariant(app, `s${Math.random()}`)
  const prof = app.db.value<number>('SELECT id FROM business_profile_versions WHERE is_active=1')!
  const sale = app.db.run(
    'INSERT INTO sales(uuid,invoice_no,pos_id,user_id,subtotal,total,profile_version_id) VALUES (?,?,?,?,?,?,?)',
    app.uuid(), `INV-${Math.random()}`, app.session!.posId, app.session!.userId, 5000, 5000, prof
  )
  const item = app.db.run(
    'INSERT INTO sale_items(sale_id,variant_id,name,sku,qty,unit_price,line_total) VALUES (?,?,?,?,?,?,?)',
    sale.lastId, variantId, 'x', 'x', qty, 1000, 1000 * qty
  )
  return { saleId: sale.lastId, itemId: item.lastId, variantId }
}

describe('schema triggers', () => {
  it('stock_movements and audit_log are append-only', () => {
    const app = createTestApp()
    const v = mkVariant(app, '1')
    app.moveStock({ variantId: v, delta: 5, type: 'opening' })
    app.audit({ entity: 'x', action: 'y' })
    expect(() => app.db.run('UPDATE stock_movements SET qty_delta = 99')).toThrow(/append-only/)
    expect(() => app.db.run('DELETE FROM stock_movements')).toThrow(/append-only/)
    expect(() => app.db.run("UPDATE audit_log SET action = 'z'")).toThrow(/append-only/)
    expect(() => app.db.run('DELETE FROM audit_log')).toThrow(/append-only/)
    expect(() => app.db.run("INSERT INTO stock_movements(uuid,variant_id,location_id,qty_delta,balance_after,type) VALUES ('u',?,?,0,0,'x')", v, app.defaultLocationId())).toThrow(/non-zero/)
  })

  it('business profile versions are immutable except the is_active flip; never deleted', () => {
    const app = createTestApp()
    const id = app.db.value<number>('SELECT id FROM business_profile_versions WHERE is_active=1')!
    expect(() => app.db.run("UPDATE business_profile_versions SET shop_name='Hacked' WHERE id=?", id)).toThrow(/immutable/)
    expect(() => app.db.run("UPDATE business_profile_versions SET gstin='x' WHERE id=?", id)).toThrow(/immutable/)
    expect(() => app.db.run('DELETE FROM business_profile_versions WHERE id=?', id)).toThrow(/cannot be deleted/)
    app.db.transaction(() => {
      app.db.run('UPDATE business_profile_versions SET is_active=0 WHERE id=?', id)
      app.db.run(
        "INSERT INTO business_profile_versions(uuid,version,shop_name,display_name,is_active) VALUES ('bp2',2,'New','New',1)"
      )
    })
    expect(app.db.value('SELECT shop_name FROM business_profile_versions WHERE id=?', id)).toBe('Test Shop')
    // only one active version at a time
    expect(() => app.db.run("INSERT INTO business_profile_versions(uuid,version,shop_name,display_name,is_active) VALUES ('bp3',3,'N','N',1)")).toThrow()
  })

  it('logo assets are immutable', () => {
    const app = createTestApp()
    const l = app.db.run("INSERT INTO logo_assets(sha256,mime,width_px,height_px,bytes,size_bytes) VALUES ('h','image/png',1,1,x'00',1)")
    expect(() => app.db.run("UPDATE logo_assets SET bytes=x'01' WHERE id=?", l.lastId)).toThrow(/immutable/)
  })

  it('issued sales keep identity and money; void/payment fields can change; no deletes', () => {
    const app = createTestApp()
    const { saleId, itemId } = mkSale(app)
    expect(() => app.db.run('UPDATE sales SET total=1 WHERE id=?', saleId)).toThrow(/immutable/)
    expect(() => app.db.run("UPDATE sales SET invoice_no='X' WHERE id=?", saleId)).toThrow(/immutable/)
    expect(() => app.db.run('UPDATE sales SET profile_version_id=NULL WHERE id=?', saleId)).toThrow()
    expect(() => app.db.run('UPDATE sale_items SET qty=1 WHERE id=?', itemId)).toThrow(/immutable/)
    expect(() => app.db.run('DELETE FROM sales WHERE id=?', saleId)).toThrow(/cannot be deleted/)
    expect(() => app.db.run('DELETE FROM sale_items WHERE id=?', itemId)).toThrow(/cannot be deleted/)
    expect(app.db.run("UPDATE sales SET status='void', void_reason='oops', voided_at=1 WHERE id=?", saleId).changes).toBe(1)
  })

  it('return quantity cannot exceed the quantity sold (cumulative)', () => {
    const app = createTestApp()
    const { saleId, itemId, variantId } = mkSale(app, 5)
    const prof = app.db.value<number>('SELECT id FROM business_profile_versions WHERE is_active=1')!
    const ret = (n: string) =>
      app.db.run('INSERT INTO sale_returns(uuid,return_no,sale_id,pos_id,user_id,subtotal,total,profile_version_id) VALUES (?,?,?,?,?,0,0,?)', app.uuid(), n, saleId, 1, 1, prof).lastId
    const line = (rid: number, qty: number) =>
      app.db.run('INSERT INTO sale_return_items(return_id,sale_item_id,variant_id,qty,unit_price,line_total) VALUES (?,?,?,?,1000,?)', rid, itemId, variantId, qty, qty * 1000)
    const r1 = ret('R1')
    line(r1, 3)
    expect(() => line(ret('R2'), 3)).toThrow(/exceeds/)
    line(ret('R3'), 2)
    expect(() => line(r1, 1)).toThrow(/exceeds/)
    expect(() => line(r1, 0)).toThrow()
  })

  it('catalog guards: tax range, negative money, barcode namespace', () => {
    const app = createTestApp()
    expect(() => mkVariant(app, 't', { tax: 10001 })).toThrow(/tax_rate_bp/)
    const v1 = mkVariant(app, 'b1', { barcode: '111' })
    const v2 = mkVariant(app, 'b2')
    expect(() => app.db.run('UPDATE product_variants SET price=-1 WHERE id=?', v1)).toThrow(/negative/)
    expect(() => app.db.run("INSERT INTO variant_barcodes(barcode,variant_id) VALUES ('111',?)", v2)).toThrow(/already used/)
    app.db.run("INSERT INTO variant_barcodes(barcode,variant_id) VALUES ('ALIAS',?)", v2)
    expect(() => app.db.run("UPDATE product_variants SET barcode='ALIAS' WHERE id=?", v1)).toThrow(/alias/)
  })

  it('one local terminal and one default location', () => {
    const app = createTestApp()
    expect(() => app.db.run("INSERT INTO pos_terminals(uuid,code,name,is_local) VALUES ('x','POS-9','n',1)")).toThrow()
    expect(() => app.db.run("INSERT INTO locations(uuid,name,is_default) VALUES ('y','Second',1)")).toThrow()
    app.db.run("INSERT INTO locations(uuid,name,is_default) VALUES ('y','Second',0)")
  })
})

describe('foreign keys', () => {
  it('are enforced', () => {
    const app = createTestApp()
    expect(() => app.db.run("INSERT INTO product_variants(uuid,product_id,sku) VALUES ('v',999,'S')")).toThrow(/FOREIGN KEY/)
    expect(() => app.db.run("INSERT INTO users(uuid,username,name,role_id,password_hash) VALUES ('u','u','u',999,'x')")).toThrow(/FOREIGN KEY/)
    expect(app.db.all('PRAGMA foreign_key_check')).toEqual([])
  })
})

describe('transactions', () => {
  it('commit, rollback, nested rollback of inner only, and depth recovery', () => {
    const app = createTestApp()
    app.db.transaction(() => {
      app.setSetting('t.a', '1')
      expect(() =>
        app.db.transaction(() => {
          app.setSetting('t.b', '1')
          throw new Error('inner')
        })
      ).toThrow('inner')
      app.setSetting('t.c', '1')
    })
    expect(app.setting('t.a')).toBe('1')
    expect(app.setting('t.b')).toBeUndefined()
    expect(app.setting('t.c')).toBe('1')
    expect(app.db.inTransaction).toBe(false)

    expect(() =>
      app.db.transaction(() => {
        app.setSetting('t.d', '1')
        app.db.transaction(() => app.setSetting('t.e', '1'))
        throw new Error('outer')
      })
    ).toThrow('outer')
    expect(app.setting('t.d')).toBeUndefined()
    expect(app.setting('t.e')).toBeUndefined()
    // connection is usable afterwards
    app.db.transaction(() => app.setSetting('t.f', '1'))
    expect(app.setting('t.f')).toBe('1')
  })

  it('a failed moveStock inside a larger transaction rolls the whole unit back', () => {
    const app = createTestApp()
    const v = mkVariant(app, 'tx')
    app.moveStock({ variantId: v, delta: 3, type: 'opening' })
    expect(() =>
      app.db.transaction(() => {
        app.moveStock({ variantId: v, delta: -2, type: 'sale' })
        app.audit({ entity: 'sale', action: 'x' })
        app.moveStock({ variantId: v, delta: -5, type: 'sale' })
      })
    ).toThrow(/Insufficient/)
    expect(app.db.value('SELECT qty FROM stock_levels WHERE variant_id=?', v)).toBe(3)
    expect(app.db.value("SELECT COUNT(*) FROM audit_log WHERE entity='sale'")).toBe(0)
    expect(app.db.value('SELECT COUNT(*) FROM stock_movements')).toBe(1)
  })

  it('rejects async callbacks instead of committing early', () => {
    const app = createTestApp()
    expect(() => app.db.transaction((async () => 1) as unknown as () => number)).toThrow(/synchronous/)
    expect(app.db.inTransaction).toBe(false)
  })
})

describe('moveStock ledger consistency (randomized)', () => {
  it('stock_levels always equals SUM(stock_movements) and balance_after chains', () => {
    const app = createTestApp()
    const loc2 = app.db.run("INSERT INTO locations(uuid,name) VALUES ('l2','Godown')").lastId
    const locs = [app.defaultLocationId(), loc2]
    const variants = [mkVariant(app, 'r1'), mkVariant(app, 'r2'), mkVariant(app, 'r3')]
    let seed = 20261005
    const rnd = (n: number) => ((seed = (seed * 1664525 + 1013904223) >>> 0) % n)
    let rejected = 0
    for (let i = 0; i < 600; i++) {
      const variantId = variants[rnd(variants.length)]
      const locationId = locs[rnd(locs.length)]
      const delta = (rnd(2) ? 1 : -1) * (1 + rnd(12))
      try {
        // occasionally wrap in an outer transaction that fails afterwards
        if (rnd(7) === 0) {
          app.db.transaction(() => {
            app.moveStock({ variantId, locationId, delta, type: 'adjustment' })
            throw new Error('abort')
          })
        } else app.moveStock({ variantId, locationId, delta, type: 'adjustment' })
      } catch (e) {
        if (/Insufficient/.test((e as Error).message)) rejected++
      }
    }
    expect(rejected).toBeGreaterThan(0)
    const bad = app.db.all(
      `SELECT l.variant_id, l.location_id, l.qty, (SELECT COALESCE(SUM(qty_delta),0) FROM stock_movements m WHERE m.variant_id=l.variant_id AND m.location_id=l.location_id) s
       FROM stock_levels l WHERE l.qty <> s OR l.qty < 0`
    )
    expect(bad).toEqual([])
    for (const v of variants)
      for (const l of locs) {
        const rows = app.db.all<{ qty_delta: number; balance_after: number }>('SELECT qty_delta, balance_after FROM stock_movements WHERE variant_id=? AND location_id=? ORDER BY id', v, l)
        let run = 0
        for (const r of rows) {
          run += r.qty_delta
          expect(r.balance_after).toBe(run)
        }
      }
    expect(app.db.value('SELECT COUNT(*) FROM stock_movements')).toBeGreaterThan(100)
  })

  it('allowNegative lets balances go below zero and stays consistent', () => {
    const app = createTestApp()
    const v = mkVariant(app, 'neg')
    expect(app.moveStock({ variantId: v, delta: -3, type: 'sale', allowNegative: true })).toBe(-3)
    app.setSetting('inventory.allow_negative', '1')
    expect(app.moveStock({ variantId: v, delta: -1, type: 'sale' })).toBe(-4)
    expect(() => app.moveStock({ variantId: v, delta: 0, type: 'x' })).toThrow(/non-zero/)
    expect(() => app.moveStock({ variantId: v, delta: 1.5, type: 'x' })).toThrow(/integer/)
  })
})

import { describe, expect, it } from 'vitest'
import { makeLocation, makeSupplier, makeVariant, newApp, qtyAt, totalStock } from './fixtures'

/** deterministic PRNG so failures are reproducible */
function rng(seed: number) {
  let s = seed
  return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296)
}

describe('ledger invariants', () => {
  it('stock_levels == SUM(ledger) after random operation sequences (all operation kinds)', async () => {
    const app = newApp()
    const loc2 = makeLocation(app, 'Godown')
    const main = app.defaultLocationId()
    const sup = makeSupplier(app)
    const vs = [makeVariant(app, { qty: 30 }), makeVariant(app, { qty: 10 }), makeVariant(app, { qty: 0 }), makeVariant(app, { qty: 5 })]
    const r = rng(42)
    const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)]
    let ok = 0
    let failed = 0
    for (let i = 0; i < 150; i++) {
      const v = pick(vs)
      const n = 1 + Math.floor(r() * 12)
      const op = Math.floor(r() * 7)
      try {
        if (op === 0) await app.call('inventory', 'adjust', { variantId: v, delta: -n, reason: 'damage' })
        else if (op === 1) await app.call('inventory', 'adjust', { variantId: v, delta: n, reason: 'found' })
        else if (op === 2) await app.call('purchases', 'create', { supplierId: sup, items: [{ variantId: v, qty: n, unitCost: 100 + n }] })
        else if (op === 3) await app.call('purchases', 'returnCreate', { supplierId: sup, items: [{ variantId: v, qty: n }] })
        else if (op === 4) {
          const [a, b] = r() > 0.5 ? [main, loc2] : [loc2, main]
          await app.call('inventory', 'transferCreate', { fromLocationId: a, toLocationId: b, items: [{ variantId: v, qty: n }] })
        } else if (op === 5) {
          const c: any = await app.call('inventory', 'countCreate', { locationId: pick([main, loc2]) })
          await app.call('inventory', 'countSet', { countId: c.id, entries: [{ variantId: v, countedQty: Math.floor(r() * 40) }] })
          await app.call('inventory', 'countApply', { countId: c.id })
        } else app.moveStock({ variantId: v, delta: -n, type: 'sale', locationId: pick([main, loc2]) })
        ok++
      } catch (e) {
        failed++
        expect((e as any).code).toBe('INSUFFICIENT_STOCK') // only legitimate rejection
      }
      if (i % 25 === 0) expect((await app.call('inventory', 'verifyLedger')) as any).toMatchObject({ ok: true })
    }
    expect(ok).toBeGreaterThan(40)
    const rep: any = await app.call('inventory', 'verifyLedger')
    expect(rep.ok).toBe(true)
    expect(rep.mismatches).toEqual([])
    for (const v of vs) {
      const sum = app.db.value<number>('SELECT COALESCE(SUM(qty_delta),0) FROM stock_movements WHERE variant_id=?', v)
      expect(totalStock(app, v)).toBe(sum)
      expect(qtyAt(app, v)).toBeGreaterThanOrEqual(0)
      expect(qtyAt(app, v, loc2)).toBeGreaterThanOrEqual(0)
    }
    void failed
  })

  it('verifyLedger detects injected corruption', async () => {
    const app = newApp()
    const v = makeVariant(app, { qty: 10 })
    const w = makeVariant(app, { qty: 4 })
    expect(((await app.call('inventory', 'verifyLedger')) as any).ok).toBe(true)
    app.db.run('UPDATE stock_levels SET qty = qty + 3 WHERE variant_id = ?', v) // level drifts from ledger
    app.db.run('INSERT INTO stock_levels(variant_id,location_id,qty) VALUES (?,?,?)', w, makeLocation(app, 'Ghost'), 9) // level with no ledger
    const rep: any = await app.call('inventory', 'verifyLedger')
    expect(rep.ok).toBe(false)
    expect(rep.mismatches).toHaveLength(2)
    expect(rep.mismatches.find((m: any) => m.variantId === v)).toMatchObject({ level: 13, ledger: 10, difference: 3 })
    expect(rep.mismatches.find((m: any) => m.variantId === w)).toMatchObject({ level: 9, ledger: 0 })
    // a tampered ledger row is caught too
    const app2 = newApp()
    const x = makeVariant(app2, { qty: 10 })
    expect(() => app2.db.run('UPDATE stock_movements SET qty_delta = 11 WHERE variant_id = ?', x)).toThrow(/append-only/) // DB guard
    app2.db.exec('DROP TRIGGER trg_stock_movements_no_update') // simulate external tampering
    app2.db.run('UPDATE stock_movements SET qty_delta = 11 WHERE variant_id = ?', x)
    expect(((await app2.call('inventory', 'verifyLedger')) as any).ok).toBe(false)
  })
})

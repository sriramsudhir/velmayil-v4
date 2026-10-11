import { describe, it, expect, afterEach } from 'vitest'
import { addProduct, cleanup, makePos, settle, sqlSale, startServer, stockOf, useHttp } from '../sync/harness'

afterEach(cleanup)

/** The test helpers pre-mark sync as bootstrapped; undo that to get the real default of a shop that never enabled sync. */
function neverEnabled(p: { app: import('../../src/main/core/app').App }): void {
  p.app.db.run("DELETE FROM sync_state WHERE key = 'bootstrapped'")
  p.app.db.run('DELETE FROM sync_queue')
}

describe('sync queue is not filled while sync was never enabled', () => {
  it('sales made while sync is off queue nothing, yet enabling sync later delivers everything to the remote POS', async () => {
    const srv = await startServer()
    const p1 = makePos('POS-01')
    neverEnabled(p1)
    const a = addProduct(p1.app, { name: 'Offline Item', sku: 'OFF1', price: 700, qty: 30 })
    sqlSale(p1.app, a.variantId, 3)
    sqlSale(p1.app, a.variantId, 2)
    expect(p1.app.db.value<number>('SELECT COUNT(*) FROM sync_queue')).toBe(0)

    useHttp(p1, srv.url) // first enable -> resyncAll bootstraps
    expect(p1.app.db.value<number>('SELECT COUNT(*) FROM sync_queue')).toBeGreaterThan(0)
    const p2 = makePos('POS-02')
    useHttp(p2, srv.url)
    await settle([p1, p2], 4)

    expect(p2.app.db.value<number>('SELECT COUNT(*) FROM sales')).toBe(2)
    expect(p2.app.db.value<number>('SELECT COUNT(*) FROM sale_items')).toBe(2)
    expect(stockOf(p2.app, 'OFF1')).toBe(25)
  })

  it('after the first bootstrap, disabling sync keeps queueing so nothing is lost', async () => {
    const srv = await startServer()
    const p1 = makePos('POS-01')
    neverEnabled(p1)
    useHttp(p1, srv.url)
    p1.sync.saveConfig({ enabled: false })
    const a = addProduct(p1.app, { name: 'Later', sku: 'LAT1', price: 100, qty: 5 })
    sqlSale(p1.app, a.variantId, 1)
    expect(p1.app.db.value<number>('SELECT COUNT(*) FROM sync_queue')).toBeGreaterThan(0)
  })
})

/** pos.deleteSale across module seams: auth approvals, the sync-off gate, backup / restore. */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestApp, actAs } from '../helpers'
import { hashPassword } from '../../src/main/core/crypto'
import type { App } from '../../src/main/core/app'
import type { BackupService } from '../../src/main/modules/backup/service'
import { addProduct, cleanup, makePos, settle, startServer, stockOf, useHttp } from '../sync/harness'

const apps: App[] = []
const dirs: string[] = []
afterEach(async () => {
  await cleanup()
  for (const a of apps.splice(0)) try { a.db.close() } catch { /* closed */ }
  for (const d of dirs.splice(0)) try { rmSync(d, { recursive: true, force: true }) } catch { /* windows locks */ }
})

function shop(file = false): { app: App; variantId: number } {
  const dir = mkdtempSync(join(tmpdir(), 'vdel-'))
  dirs.push(dir)
  const app = createTestApp(file ? { dbPath: join(dir, 'live.db'), userDataDir: dir } : { userDataDir: dir })
  apps.push(app)
  const p = app.db.run('INSERT INTO products(uuid,name,tax_rate_bp,hsn) VALUES (?,?,?,?)', app.uuid(), 'Rocket', 0, '3604')
  const variantId = app.db.run('INSERT INTO product_variants(uuid,product_id,sku,barcode,price,mrp,cost) VALUES (?,?,?,?,?,?,?)', app.uuid(), p.lastId, 'RKT', 'BC-RKT', 10000, 10000, 5000).lastId
  app.moveStock({ variantId, delta: 20, type: 'opening' })
  return { app, variantId }
}
const stock = (app: App, v: number) => app.db.value<number>('SELECT qty FROM stock_levels WHERE variant_id = ?', v)

describe('delete order: pos <-> auth.verifyApprover', () => {
  it('a role with pos.delete but no approvals.grant -> APPROVAL_REQUIRED -> manager approves through auth -> the bill is deleted; the approval fits only that bill', async () => {
    const { app, variantId } = shop()
    const call = <T = any>(svc: string, method: string, args?: unknown) => app.call(svc, method, args) as Promise<T>
    const sale = await call('pos', 'completeSale', { lines: [{ variantId, qty: 2 }], payments: [{ method: 'cash', amount: 20000 }] })
    const other = await call('pos', 'completeSale', { lines: [{ variantId, qty: 1 }], payments: [{ method: 'cash', amount: 10000 }] })
    app.db.run('INSERT INTO users(uuid,username,name,role_id,password_hash) VALUES (?,?,?,(SELECT id FROM roles WHERE name=?),?)', app.uuid(), 'mgr', 'mgr', 'Manager', hashPassword('Passw0rd!x'))
    app.db.run('INSERT INTO users(uuid,username,name,role_id,password_hash) VALUES (?,?,?,(SELECT id FROM roles WHERE name=?),?)', app.uuid(), 'cash2', 'cash2', 'Cashier', hashPassword('Passw0rd!x'))
    actAs(app, 'Cashier')
    app.session = { ...app.session!, permissions: ['pos.sell', 'pos.delete', 'pos.reprint'] }
    await expect(call('pos', 'deleteSale', { saleId: sale.saleId, reason: 'test bill' })).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' })

    // exactly what <ApprovalDialog action="pos.delete" entity="sale" entityId={id}> sends
    await expect(call('auth', 'verifyApprover', { username: 'cash2', password: 'Passw0rd!x', action: 'pos.delete', entity: 'sale', entityId: sale.saleId })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const ok = await call('auth', 'verifyApprover', { username: 'mgr', password: 'Passw0rd!x', action: 'pos.delete', entity: 'sale', entityId: sale.saleId, detail: { invoiceNo: sale.invoiceNo } })
    await expect(call('pos', 'deleteSale', { saleId: other.saleId, reason: 'test bill', approval: { approvalId: ok.approvalId } })).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' })
    // an approval given for a void does not delete
    const forVoid = await call('auth', 'verifyApprover', { username: 'mgr', password: 'Passw0rd!x', action: 'pos.void', entity: 'sale', entityId: sale.saleId })
    await expect(call('pos', 'deleteSale', { saleId: sale.saleId, reason: 'test bill', approval: { approvalId: forVoid.approvalId } })).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' })

    const r = await call('pos', 'deleteSale', { saleId: sale.saleId, reason: 'test bill', approval: { approvalId: ok.approvalId } })
    expect(r).toMatchObject({ ok: true, invoiceNo: sale.invoiceNo, stockRestored: 2 })
    expect(app.db.value('SELECT COUNT(*) FROM sales')).toBe(1)
    expect(stock(app, variantId)).toBe(19)
    const mgrId = app.db.value("SELECT id FROM users WHERE username='mgr'")
    expect(JSON.parse(app.db.value<string>("SELECT new_json FROM audit_log WHERE entity='sale' AND action='delete'")!)).toMatchObject({ approvedBy: mgrId, deletedBy: 'Cashier User' })
    // the audit log (audit.view) shows the delete with the reason
    app.session = { ...app.session!, permissions: ['*'] }
    const log = await call<{ rows: any[]; total: number }>('audit', 'search', { entity: 'sale', action: 'delete', text: 'test bill' })
    expect(log.total).toBe(1)
    expect(log.rows[0]).toMatchObject({ entity_id: String(sale.saleId), note: 'test bill' })
  })
})

describe('delete order while sync was never enabled', () => {
  it('queues nothing, but the tombstone is sent when sync is switched on later (a terminal that restored an old copy drops the bill)', async () => {
    const srv = await startServer()
    const p1 = makePos('POS-01')
    p1.app.db.run("DELETE FROM sync_state WHERE key = 'bootstrapped'")
    p1.app.db.run('DELETE FROM sync_queue')
    const a = addProduct(p1.app, { name: 'Offline Item', sku: 'OFF1', price: 700, qty: 30 })
    const keep = (await p1.app.call('pos', 'completeSale', { lines: [{ variantId: a.variantId, qty: 1 }], payments: [{ method: 'cash', amount: 700 }] })) as any
    const gone = (await p1.app.call('pos', 'completeSale', { lines: [{ variantId: a.variantId, qty: 5 }], payments: [{ method: 'cash', amount: 3500 }] })) as any
    await p1.app.call('pos', 'deleteSale', { saleId: gone.saleId, reason: 'test bill' })
    expect(p1.app.db.value<number>('SELECT COUNT(*) FROM sync_queue')).toBe(0)
    expect(p1.app.db.value<number>('SELECT COUNT(*) FROM deleted_sales')).toBe(1)
    expect(stockOf(p1.app, 'OFF1')).toBe(29)

    useHttp(p1, srv.url) // first enable -> resyncAll bootstraps, including the tombstone
    expect(p1.app.db.value<number>("SELECT COUNT(*) FROM sync_queue WHERE entity='sales' AND op='delete'")).toBe(1)
    const p2 = makePos('POS-02')
    useHttp(p2, srv.url)
    await settle([p1, p2], 4)
    expect(p2.app.db.all<any>('SELECT invoice_no FROM sales')).toEqual([{ invoice_no: keep.invoiceNo }])
    expect(p2.app.db.value<number>('SELECT COUNT(*) FROM deleted_sales')).toBe(1)
    expect(stockOf(p2.app, 'OFF1')).toBe(29)
  })
})

describe('delete order and backup / restore', () => {
  it('a backup taken after the delete restores without the bill (tombstone kept); one taken before brings the bill back whole', async () => {
    const { app, variantId } = shop(true)
    const svc = app.get<BackupService>('backup')
    const sale = (await app.call('pos', 'completeSale', { lines: [{ variantId, qty: 3 }], payments: [{ method: 'cash', amount: 30000 }] })) as any
    const before = svc.create({ kind: 'manual' })
    await app.call('pos', 'deleteSale', { saleId: sale.saleId, reason: 'test bill' })
    const after = svc.create({ kind: 'manual' })
    expect(after.verified).toBe(true)
    expect(after.manifest.tables).toMatchObject({ sales: 0, sale_items: 0, sale_payments: 0, deleted_sales: 1 })

    svc.restore({ id: before.id })
    expect(app.db.value('SELECT COUNT(*) FROM sales')).toBe(1)
    expect(app.db.value('SELECT COUNT(*) FROM sale_items')).toBe(1)
    expect(app.db.value('SELECT COUNT(*) FROM deleted_sales')).toBe(0)
    expect(stock(app, variantId)).toBe(17)
    // the guard triggers are back in force after the restore, and the bill can be deleted again
    expect(() => app.db.run('DELETE FROM sales WHERE id = ?', sale.saleId)).toThrow(/cannot be deleted/)
    await app.call('pos', 'deleteSale', { saleId: sale.saleId, reason: 'test bill again' })
    expect(stock(app, variantId)).toBe(20)

    svc.restore({ id: after.id })
    expect(app.db.value('SELECT COUNT(*) FROM sales')).toBe(0)
    expect(app.db.get<any>('SELECT invoice_no, reason FROM deleted_sales')).toEqual({ invoice_no: sale.invoiceNo, reason: 'test bill' })
    expect(stock(app, variantId)).toBe(20)
    expect(await app.call('inventory', 'verifyLedger')).toMatchObject({ ok: true })
  })
})

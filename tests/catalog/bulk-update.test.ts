import { describe, expect, it, beforeEach } from 'vitest'
import { createTestApp, actAs } from '../helpers'
import type { App } from '../../src/main/core/app'

let app: App
const save = (name: string, extra: Record<string, unknown> = {}, v: Record<string, unknown> = {}) =>
  app.call('catalog', 'save', { name, taxRateBp: 1800, variants: [{ mrp: 20000, price: 15000, cost: 9000, barcode: undefined, autoBarcode: true, ...v }], ...extra }) as Promise<any>

beforeEach(() => {
  app = createTestApp()
})

describe('catalog.bulkUpdate', () => {
  it('updates many rows in one transaction, audits price/tax, enqueues sync snapshots', async () => {
    const a = await save('Alpha')
    const b = await save('Beta')
    const syncBefore = app.db.value<number>('SELECT COUNT(*) FROM sync_queue')!
    const r: any = await app.call('catalog', 'bulkUpdate', {
      rows: [
        { variantId: a.variants[0].id, patch: { price: 16000, cost: 9500 } },
        { variantId: b.variants[0].id, patch: { taxRateBp: 500, hsn: '3604', name: 'Beta Renamed' } }
      ]
    })
    expect(r.updated).toBe(2)
    const pa: any = await app.call('catalog', 'get', { id: a.id })
    expect(pa.variants[0].price).toBe(16000)
    const pb: any = await app.call('catalog', 'get', { id: b.id })
    expect(pb.taxRateBp).toBe(500)
    expect(pb.name).toBe('Beta Renamed')
    const price = app.db.get<any>(`SELECT old_json, new_json FROM audit_log WHERE action='price_change' AND entity_id=?`, String(a.variants[0].id))!
    expect(JSON.parse(price.old_json).price).toBe(15000)
    expect(JSON.parse(price.new_json).price).toBe(16000)
    expect(app.db.value<number>(`SELECT COUNT(*) FROM audit_log WHERE action='tax_change'`)).toBe(1)
    expect(app.db.value<number>('SELECT COUNT(*) FROM sync_queue')! - syncBefore).toBe(2) // one snapshot per product
  })

  it('is atomic: one invalid row saves nothing and returns per-row errors', async () => {
    const a = await save('Alpha')
    const b = await save('Beta')
    const dup = b.variants[0].barcode as string
    const auditBefore = app.db.value<number>('SELECT COUNT(*) FROM audit_log')!
    const syncBefore = app.db.value<number>('SELECT COUNT(*) FROM sync_queue')!
    let err: any
    try {
      await app.call('catalog', 'bulkUpdate', {
        rows: [
          { variantId: a.variants[0].id, patch: { price: 17000 } },
          { variantId: a.variants[0].id, key: 'x', patch: { barcode: dup } },
          { variantId: b.variants[0].id, patch: { price: -5 } }
        ]
      })
    } catch (e) {
      err = e
    }
    expect(err?.code).toBe('VALIDATION')
    const fields = err.details.rowErrors.map((e: any) => e.field)
    expect(fields).toEqual(expect.arrayContaining(['barcode', 'price']))
    expect(((await app.call('catalog', 'get', { id: a.id })) as any).variants[0].price).toBe(15000)
    expect(app.db.value<number>('SELECT COUNT(*) FROM audit_log')).toBe(auditBefore)
    expect(app.db.value<number>('SELECT COUNT(*) FROM sync_queue')).toBe(syncBefore)
  })

  it('requires catalog.edit', async () => {
    const a = await save('Alpha')
    actAs(app, 'Cashier')
    await expect(app.call('catalog', 'bulkUpdate', { rows: [{ variantId: a.variants[0].id, patch: { price: 1 } }] })).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('price edit keeps the barcode and POS scan charges the new price', async () => {
    const a = await save('Alpha')
    const code = a.variants[0].barcode as string
    expect(code).toBeTruthy()
    await app.call('catalog', 'bulkUpdate', { rows: [{ variantId: a.variants[0].id, patch: { price: 12345, mrp: 20000 } }] })
    const after: any = await app.call('catalog', 'get', { id: a.id })
    expect(after.variants[0].barcode).toBe(code)
    const scan: any = await app.call('pos', 'scan', { code })
    expect(scan.price).toBe(12345)
  })

  it('changing a barcode keeps the old one scannable as an alias', async () => {
    const a = await save('Alpha')
    const old = a.variants[0].barcode as string
    await app.call('catalog', 'bulkUpdate', { rows: [{ variantId: a.variants[0].id, patch: { barcode: '8901234567890' } }] })
    expect(((await app.call('catalog', 'findByCode', { code: old })) as any).variantId).toBe(a.variants[0].id)
    expect(((await app.call('catalog', 'findByCode', { code: '8901234567890' })) as any).variantId).toBe(a.variants[0].id)
  })

  it('creates new products in the same transaction and rolls them back on error', async () => {
    const r: any = await app.call('catalog', 'bulkUpdate', { rows: [{ key: 'n1', patch: { name: 'Fresh', price: 5000, mrp: 6000, cost: 3000, taxRateBp: 1200 } }] })
    expect(r.created).toBe(1)
    const list: any = await app.call('catalog', 'gridList', {})
    expect(list.rows.find((x: any) => x.name === 'Fresh').taxRateBp).toBe(1200)
    const a = await save('Alpha')
    await expect(
      app.call('catalog', 'bulkUpdate', {
        rows: [{ key: 'n2', patch: { name: 'Ghost' } }, { variantId: a.variants[0].id, patch: { price: -1 } }]
      })
    ).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(app.db.value('SELECT 1 FROM products WHERE name = ?', 'Ghost')).toBeUndefined()
  })

  it('gridList returns one row per variant with stock', async () => {
    await save('Alpha', {}, { openingStock: 7 })
    const list: any = await app.call('catalog', 'gridList', {})
    expect(list.rows).toHaveLength(1)
    expect(list.rows[0]).toMatchObject({ name: 'Alpha', stock: 7, price: 15000, active: true })
  })
})

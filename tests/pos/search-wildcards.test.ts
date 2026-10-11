import { describe, it, expect, beforeEach } from 'vitest'
import { createTestApp, actAs } from '../helpers'
import type { App } from '../../src/main/core/app'

let app: App
const call = <T = any>(method: string, args?: unknown) => app.call('pos', method, args) as Promise<T>

beforeEach(() => {
  app = createTestApp()
  actAs(app, 'Owner')
  for (const [name, phone] of [['100% Crackers', '9000000001'], ['A_B Traders', '9000000002'], ['AXB Traders', '9000000003']])
    app.db.run('INSERT INTO customers(uuid,name,phone) VALUES (?,?,?)', app.uuid(), name, phone)
})

describe('customer / invoice search treats % and _ as text (DEF-4)', () => {
  it('finds a customer whose name contains %', async () => {
    const r = await call('listCustomers', { search: '100%' })
    expect(r.rows.map((c: any) => c.name)).toEqual(['100% Crackers'])
  })

  it('_ is not a single-character wildcard', async () => {
    const r = await call('listCustomers', { search: 'A_B' })
    expect(r.rows.map((c: any) => c.name)).toEqual(['A_B Traders'])
  })

  it('a lone % does not match everything, in customers or sales', async () => {
    expect((await call('listCustomers', { search: '%' })).rows.map((c: any) => c.name)).toEqual(['100% Crackers'])
    expect((await call('listSales', { search: '%' })).rows).toEqual([])
  })
})

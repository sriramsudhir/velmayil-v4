import { describe, it, expect } from 'vitest'
import { createTestApp, actAs } from '../helpers'
import { registerSettingDef } from '../../src/main/core/settings'

const set = (app: ReturnType<typeof createTestApp>, key: string, value: unknown) => app.call('settings', 'set', { key, value })

describe('settings service', () => {
  it('getAll returns defaults and definitions', async () => {
    const app = createTestApp()
    const r = (await app.call('settings', 'getAll')) as { values: Record<string, string>; defs: { key: string }[] }
    expect(r.values['inventory.allow_negative']).toBe('0')
    expect(r.defs.map((d) => d.key)).toContain('reprint_profile_policy')
  })

  it('every setting the services read can be changed from Settings (cost method, password policy)', async () => {
    const app = createTestApp()
    const r = (await app.call('settings', 'getAll')) as { values: Record<string, string>; defs: { key: string; kind: string; group: string }[] }
    const keys = r.defs.map((d) => d.key)
    expect(keys).toEqual(expect.arrayContaining(['inventory.cost_method', 'security.password_min_length', 'security.password_require_digit']))
    expect(r.values).toMatchObject({ 'inventory.cost_method': 'last', 'security.password_min_length': '8', 'security.password_require_digit': '0' })

    expect(await set(app, 'inventory.cost_method', 'weighted')).toEqual({ key: 'inventory.cost_method', value: 'weighted' })
    await expect(set(app, 'inventory.cost_method', 'fifo')).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(set(app, 'security.password_min_length', 2)).rejects.toMatchObject({ code: 'VALIDATION' })
    await set(app, 'security.password_min_length', 10)
    await set(app, 'security.password_require_digit', true)

    // the purchase really uses the chosen cost method
    const p = app.db.run("INSERT INTO products(uuid,name) VALUES ('cm-p','Cost item')").lastId
    const v = app.db.run("INSERT INTO product_variants(uuid,product_id,sku,cost) VALUES ('cm-v',?,'CM1',1000)", p).lastId
    app.moveStock({ variantId: v, delta: 10, type: 'opening' })
    await app.call('purchases', 'create', { items: [{ variantId: v, qty: 10, unitCost: 2000, taxRateBp: 0 }] })
    expect(app.db.value('SELECT cost FROM product_variants WHERE id=?', v)).toBe(1500)
    // ...and the password policy is enforced with the new values
    const role = app.db.value<number>("SELECT id FROM roles WHERE name='Cashier'")!
    await expect(app.call('auth', 'createUser', { username: 'kumar', name: 'Kumar', roleId: role, password: 'abcdefgh1' })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(app.call('auth', 'createUser', { username: 'kumar', name: 'Kumar', roleId: role, password: 'abcdefghijk' })).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(await app.call('auth', 'createUser', { username: 'kumar', name: 'Kumar', roleId: role, password: 'abcdefghij1' })).toMatchObject({ username: 'kumar' })
  })

  it('set validates by type, whitelists keys and audits changes', async () => {
    const app = createTestApp()
    expect(await set(app, 'inventory.allow_negative', true)).toEqual({ key: 'inventory.allow_negative', value: '1' })
    expect(app.setting('inventory.allow_negative')).toBe('1')
    await set(app, 'security.autolock_minutes', 25)
    expect(app.setting('security.autolock_minutes')).toBe('25')
    await set(app, 'reprint_profile_policy', 'current')
    await set(app, 'billing.invoice_prefix', 'bill-a')
    expect(app.setting('billing.invoice_prefix')).toBe('BILL-A')

    for (const [k, v] of [
      ['security.autolock_minutes', '-5'], ['security.autolock_minutes', 'abc'], ['security.autolock_minutes', '99999'],
      ['inventory.allow_negative', 'maybe'], ['reprint_profile_policy', 'whatever'], ['billing.invoice_prefix', 'no spaces'],
      ['billing.invoice_width', '2'], ['not.a.setting', '1']
    ])
      await expect(set(app, k, v), `${k}=${v}`).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(app.setting('security.autolock_minutes')).toBe('25')
    expect(app.db.value("SELECT COUNT(*) FROM audit_log WHERE action='setting.update'")).toBe(4)
    await set(app, 'security.autolock_minutes', 25) // unchanged: no extra audit row
    expect(app.db.value("SELECT COUNT(*) FROM audit_log WHERE action='setting.update'")).toBe(4)
  })

  it('setMany is atomic', async () => {
    const app = createTestApp()
    await expect(app.call('settings', 'setMany', { values: { 'sync.enabled': '1', 'security.autolock_minutes': 'x' } })).rejects.toThrow()
    expect(app.setting('sync.enabled')).toBe('0')
    await app.call('settings', 'setMany', { values: { 'sync.enabled': '1', 'security.autolock_minutes': '5' } })
    expect(app.setting('sync.enabled')).toBe('1')
  })

  it('other modules can register keys', async () => {
    const app = createTestApp()
    registerSettingDef({ key: 'test.custom', default: 'a', label: 'Custom', group: 'Test', kind: 'enum', options: ['a', 'b'] })
    await set(app, 'test.custom', 'b')
    expect(app.setting('test.custom')).toBe('b')
    await expect(set(app, 'test.custom', 'c')).rejects.toMatchObject({ code: 'VALIDATION' })
  })

  it('requires settings.edit for writes and diagnostics but not for reading', async () => {
    const app = createTestApp()
    actAs(app, 'Cashier')
    await expect(set(app, 'sync.enabled', '1')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(app.call('db', 'integrityCheck')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(app.call('settings', 'addLocation', { name: 'X' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(app.call('settings', 'getAll')).resolves.toBeTruthy()
    app.session = null
    await expect(app.call('settings', 'getAll')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' })
  })
})

describe('terminals', () => {
  it('lists, renames, enforces unique codes, protects the local terminal', async () => {
    const app = createTestApp()
    const list = () => app.call('settings', 'listTerminals') as Promise<{ id: number; code: string; name: string; isLocal: boolean; active: boolean }[]>
    const local = (await list())[0]
    expect(local).toMatchObject({ code: 'POS-01', isLocal: true })
    const second = (await app.call('settings', 'addTerminal', { code: 'pos-02', name: 'Counter 2' })) as { id: number; code: string }
    expect(second.code).toBe('POS-02')
    await expect(app.call('settings', 'addTerminal', { code: 'POS-02', name: 'dup' })).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(app.call('settings', 'updateTerminal', { id: second.id, code: 'POS-01' })).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(app.call('settings', 'updateTerminal', { id: local.id, active: false })).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(app.call('settings', 'addTerminal', { code: 'bad code!', name: 'x' })).rejects.toMatchObject({ code: 'VALIDATION' })
    const r = (await app.call('settings', 'updateTerminal', { id: local.id, name: 'Front Counter', code: 'FRONT' })) as { name: string; code: string }
    expect(r).toMatchObject({ name: 'Front Counter', code: 'FRONT' })
    expect(app.localPos().code).toBe('FRONT')
    expect(app.session?.posCode).toBe('FRONT')
    await app.call('settings', 'updateTerminal', { id: second.id, active: false })
    expect((await list()).find((t) => t.id === second.id)?.active).toBe(false)
  })
})

describe('locations', () => {
  it('add, rename, default switch, deactivate rules', async () => {
    const app = createTestApp()
    type L = { id: number; name: string; isDefault: boolean; active: boolean }
    const main = ((await app.call('settings', 'listLocations')) as L[])[0]
    const g = (await app.call('settings', 'addLocation', { name: 'Godown' })) as L
    await expect(app.call('settings', 'addLocation', { name: 'godown' })).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(app.call('settings', 'renameLocation', { id: g.id, name: 'MAIN STORE' })).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(((await app.call('settings', 'renameLocation', { id: g.id, name: 'Warehouse' })) as L).name).toBe('Warehouse')

    await expect(app.call('settings', 'setLocationActive', { id: main.id, active: false })).rejects.toMatchObject({ code: 'CONFLICT' }) // default
    const p = app.db.run("INSERT INTO products(uuid,name) VALUES ('pp','P')").lastId
    const v = app.db.run("INSERT INTO product_variants(uuid,product_id,sku) VALUES ('vv',?,'S1')", p).lastId
    app.moveStock({ variantId: v, locationId: g.id, delta: 4, type: 'opening' })
    await expect(app.call('settings', 'setLocationActive', { id: g.id, active: false })).rejects.toMatchObject({ code: 'CONFLICT' }) // has stock

    await app.call('settings', 'setDefaultLocation', { id: g.id })
    expect(app.defaultLocationId()).toBe(g.id)
    expect(app.db.value('SELECT COUNT(*) FROM locations WHERE is_default=1')).toBe(1)
    app.moveStock({ variantId: v, locationId: g.id, delta: -4, type: 'adjustment' })
    await expect(app.call('settings', 'setLocationActive', { id: g.id, active: false })).rejects.toMatchObject({ code: 'CONFLICT' }) // now default
    const off = (await app.call('settings', 'setLocationActive', { id: main.id, active: false })) as L
    expect(off.active).toBe(false)
    await expect(app.call('settings', 'setDefaultLocation', { id: main.id })).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(app.call('settings', 'renameLocation', { id: 9999, name: 'x' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(app.db.value("SELECT COUNT(*) FROM sync_queue WHERE entity='locations'")).toBeGreaterThan(0)
  })
})

describe('db health', () => {
  it('integrityCheck passes on a healthy database and flags a ledger mismatch', async () => {
    const app = createTestApp()
    const p = app.db.run("INSERT INTO products(uuid,name) VALUES ('pp','P')").lastId
    const v = app.db.run("INSERT INTO product_variants(uuid,product_id,sku) VALUES ('vv',?,'S1')", p).lastId
    app.moveStock({ variantId: v, delta: 10, type: 'opening' })
    const ok = (await app.call('db', 'integrityCheck')) as { ok: boolean; integrity: string[]; stockMismatches: unknown[] }
    expect(ok).toMatchObject({ ok: true, integrity: ['ok'], stockMismatches: [] })

    app.db.run('UPDATE stock_levels SET qty = 99 WHERE variant_id = ?', v) // someone bypassed moveStock
    const bad = (await app.call('db', 'integrityCheck')) as { ok: boolean; stockMismatches: { level: number; ledger: number }[] }
    expect(bad.ok).toBe(false)
    expect(bad.stockMismatches[0]).toMatchObject({ level: 99, ledger: 10 })
  })

  it('stats reports tables and schema version', async () => {
    const app = createTestApp()
    const s = (await app.call('db', 'stats')) as { schemaVersion: number; tables: { name: string; rows: number }[]; sizeBytes: number }
    expect(s.schemaVersion).toBeGreaterThanOrEqual(2)
    expect(s.sizeBytes).toBeGreaterThan(0)
    expect(s.tables.find((t) => t.name === 'roles')!.rows).toBe(3)
  })
})

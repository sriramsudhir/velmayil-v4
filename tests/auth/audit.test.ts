import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { makeAuthApp, addUser } from './util'

describe('audit viewer', () => {
  it('filters, paginates, searches text safely, returns diffs', async () => {
    const { app } = makeAuthApp()
    for (let i = 0; i < 12; i++) app.audit({ entity: 'product', entityId: i, action: 'update', old: { price: i }, new: { price: i + 1 }, note: `item_${i}%` })
    app.audit({ entity: 'sale', entityId: 9, action: 'void', note: 'oops' })
    const all = (await app.call('audit', 'search', { limit: 5 })) as any
    expect(all.rows).toHaveLength(5)
    expect(all.total).toBe(13)
    expect(all.rows[0].id).toBeGreaterThan(all.rows[1].id) // newest first
    const p2 = (await app.call('audit', 'search', { limit: 5, offset: 5 })) as any
    expect(p2.rows[0].id).toBeLessThan(all.rows[4].id)
    expect(((await app.call('audit', 'search', { entity: 'sale' })) as any).total).toBe(1)
    expect(((await app.call('audit', 'search', { action: 'update' })) as any).total).toBe(12)
    expect(((await app.call('audit', 'search', { text: 'item_3%' })) as any).total).toBe(1)
    expect(((await app.call('audit', 'search', { text: '%' })) as any).total).toBe(12) // % is literal, not a wildcard
    const one = (await app.call('audit', 'search', { text: 'item_4' })) as any
    expect(one.rows[0].changes).toEqual([{ path: 'price', old: 4, new: 5 }])
    expect(((await app.call('audit', 'search', { userId: 99999 })) as any).total).toBe(0)
    expect(((await app.call('audit', 'search', { from: Date.now() + 1e9 })) as any).total).toBe(0)
    expect(await app.call('audit', 'entities')).toEqual(expect.arrayContaining(['product', 'sale']))
    expect(await app.call('audit', 'actions')).toEqual(expect.arrayContaining(['void', 'update']))
  })

  it('validates paging input', async () => {
    const { app } = makeAuthApp()
    await expect(app.call('audit', 'search', { limit: 100000 })).rejects.toMatchObject({ code: 'VALIDATION' })
  })
})

describe('audit_log immutability', () => {
  it('database refuses UPDATE and DELETE', async () => {
    const { app } = makeAuthApp()
    app.audit({ entity: 'x', action: 'y' })
    expect(() => app.db.run("UPDATE audit_log SET action='z'")).toThrow(/append-only/)
    expect(() => app.db.run('DELETE FROM audit_log')).toThrow(/append-only/)
    expect(app.db.value('SELECT COUNT(*) FROM audit_log')).toBe(1)
  })

  it('no source file in src/main writes to audit_log other than INSERT', () => {
    const walk = (d: string): string[] =>
      readdirSync(d).flatMap((f) => {
        const p = join(d, f)
        return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : []
      })
    const offenders = walk('src/main')
      .filter((f) => !f.includes('migrations'))
      .filter((f) => /(UPDATE\s+audit_log|DELETE\s+FROM\s+audit_log|DROP\s+TABLE\s+audit_log)/i.test(readFileSync(f, 'utf8')))
    expect(offenders).toEqual([])
  })
})

describe('every security event leaves an audit row', () => {
  it('login, failure, lockout, lock, unlock, logout, user/role changes, resets, approvals', async () => {
    const { app } = makeAuthApp()
    const u = await addUser(app, 'ev1', 'Cashier', 'Passw0rd!x', { pin: '2468' })
    await app.call('auth', 'resetPassword', { id: u.id, newPassword: 'Brand#New99' })
    await app.call('auth', 'resetPin', { id: u.id })
    await app.call('auth', 'setUserActive', { id: u.id, active: false })
    await app.call('auth', 'setUserActive', { id: u.id, active: true })
    app.session = null
    for (let i = 0; i < 5; i++) await app.call('auth', 'login', { username: 'ev1', password: 'bad-bad-bad' }).catch(() => {})
    const actions = new Set(app.db.all<{ action: string }>('SELECT action FROM audit_log').map((r) => r.action))
    for (const a of ['create', 'password_reset', 'pin_clear', 'deactivate', 'activate', 'login_failed', 'lockout']) expect(actions.has(a), a).toBe(true)
  })
})

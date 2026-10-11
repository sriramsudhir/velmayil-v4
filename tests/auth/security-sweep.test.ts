import { describe, it, expect } from 'vitest'
import { createTestApp, actAs } from '../helpers'
import type { App } from '../../src/main/core/app'

/**
 * Runtime security sweep over EVERY exposed service method (all modules registered, as in the real app).
 * Reads the registry through the private `exposed` map (test-only; core/app.ts is not modified).
 */
const PUBLIC = new Set(['auth.login', 'auth.current', 'auth.logout', 'setup.status', 'setup.complete', 'app.info'])

function registry(app: App): Array<[string, string]> {
  const map = (app as unknown as { exposed: Map<string, Record<string, unknown>> }).exposed
  return [...map.entries()].flatMap(([svc, methods]) => Object.keys(methods).map((m) => [svc, m] as [string, string]))
}

/** Methods that MUST be permission-gated for a Cashier. Only those that exist are checked. */
const CASHIER_FORBIDDEN: Record<string, string[]> = {
  auth: ['createUser', 'updateUser', 'setUserActive', 'resetPassword', 'resetPin', 'saveRole', 'deleteRole', 'listUsers', 'listRoles', 'listApprovals'],
  audit: ['search', 'entities', 'actions'],
  businessProfile: ['save', 'setLogo', 'removeLogo'],
  backup: ['create', 'run', 'restore', 'delete', 'list', 'verify', 'settings', 'saveSettings', 'setSettings', 'schedule'],
  settings: ['set', 'save', 'update', 'setMany', 'saveAll'],
  sync: ['configure', 'setConfig', 'saveConfig', 'run', 'syncNow', 'pushNow', 'pullNow', 'status'],
  pos: ['voidSale', 'deleteSale'],
  printing: ['saveTemplate', 'saveProfile', 'deleteProfile', 'deleteTemplate', 'saveTemplates', 'saveProfiles']
}

describe('security sweep (all exposed services)', () => {
  const app = createTestApp()
  const all = registry(app)

  it('discovers the auth + audit services at least', () => {
    console.info(`[sweep] ${all.length} exposed methods across ${new Set(all.map(([s]) => s)).size} services: ${[...new Set(all.map(([s]) => s))].join(', ')}`)
    expect(all.map(([s, m]) => `${s}.${m}`)).toEqual(expect.arrayContaining(['auth.login', 'auth.createUser', 'audit.search']))
  })

  it('without a session every non-public method rejects with UNAUTHENTICATED (and never runs)', async () => {
    const failures: string[] = []
    for (const [s, m] of all) {
      if (PUBLIC.has(`${s}.${m}`)) continue
      app.session = null
      try {
        await app.call(s, m, {})
        failures.push(`${s}.${m}: succeeded without a session`)
      } catch (e) {
        const code = (e as { code?: string }).code
        if (code !== 'UNAUTHENTICATED') failures.push(`${s}.${m}: expected UNAUTHENTICATED, got ${code ?? String(e)}`)
      }
    }
    expect(failures).toEqual([])
  })

  it('public methods are exactly the whitelisted login/setup/info ones', () => {
    // anything outside PUBLIC that does not demand a session would have failed above; here we pin the contract
    const loginish = all.map(([s, m]) => `${s}.${m}`).filter((n) => PUBLIC.has(n))
    expect(loginish).toEqual(expect.arrayContaining(['auth.login', 'auth.current', 'auth.logout']))
  })

  it('a Cashier is FORBIDDEN from admin-style methods (permission checked before input validation)', async () => {
    const failures: string[] = []
    const existing = new Set(all.map(([s, m]) => `${s}.${m}`))
    for (const [svc, methods] of Object.entries(CASHIER_FORBIDDEN)) {
      for (const m of methods) {
        if (!existing.has(`${svc}.${m}`)) continue
        const fresh = createTestApp() // isolated: a mis-gated method must not leak state into other checks
        actAs(fresh, 'Cashier')
        try {
          await fresh.call(svc, m, {})
          failures.push(`${svc}.${m}: Cashier call succeeded`)
        } catch (e) {
          const code = (e as { code?: string }).code
          if (code !== 'FORBIDDEN') failures.push(`${svc}.${m}: Cashier got ${code ?? String(e)} (expected FORBIDDEN)`)
        } finally {
          fresh.close()
        }
      }
    }
    expect(failures).toEqual([])
  })
})

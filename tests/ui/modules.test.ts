import { describe, expect, it } from 'vitest'
import { findModuleProblems, type ModuleDef } from '@/lib/module'

// Smoke test: every renderer module's index.tsx must load, and route paths / module ids must be unique across modules.
const mods = import.meta.glob('../../src/renderer/modules/*/index.tsx', { eager: true }) as Record<string, { module?: ModuleDef }>

describe('renderer module registry', () => {
  const list = Object.entries(mods)
  it('discovers modules and each exports `module`', () => {
    expect(list.length).toBeGreaterThan(5)
    for (const [file, m] of list) expect(m.module, `${file} must export \`module\``).toBeTruthy()
  })
  it('has no duplicate module ids or route paths', () => {
    const defs = list.map(([, m]) => m.module!).filter(Boolean)
    expect(findModuleProblems(defs)).toEqual([])
  })
  it('every nav item has a matching route', () => {
    const defs = list.map(([, m]) => m.module!).filter(Boolean)
    const paths = new Set(defs.flatMap((d) => d.routes.map((r) => r.path)))
    const missing = defs.flatMap((d) => (d.nav ?? []).filter((n) => !paths.has(n.path)).map((n) => `${d.id}: ${n.path}`))
    expect(missing).toEqual([])
  })
  it('dashboard is registered under Insights', () => {
    const d = list.map(([, m]) => m.module!).find((m) => m.id === 'dashboard')!
    expect(d.nav?.[0].group).toBe('Insights')
    expect(d.routes[0].path).toBe('/dashboard')
  })
})

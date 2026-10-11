import type { ReactElement } from 'react'
import type { Permission } from '@shared/permissions'

export interface NavItem {
  path: string
  label: string
  group?: 'Sell' | 'Stock' | 'Insights' | 'Admin'
  icon?: string // emoji or short glyph
  permission?: Permission
  order?: number
}
export interface RouteDef {
  path: string
  element: ReactElement
}
/** Every renderer module exports `module: ModuleDef` from src/renderer/modules/<name>/index.tsx */
export interface ModuleDef {
  id: string
  nav?: NavItem[]
  routes: RouteDef[]
}

const mods = import.meta.glob('../modules/*/index.tsx', { eager: true }) as Record<string, { module: ModuleDef }>
export const allModules = (): ModuleDef[] => Object.values(mods).map((m) => m.module).filter(Boolean)

/** Developer aid: returns human-readable problems (duplicate module ids / route paths / nav paths with no route). */
export function findModuleProblems(list: ModuleDef[] = allModules()): string[] {
  const out: string[] = []
  const ids = new Map<string, number>()
  const paths = new Map<string, string>()
  for (const m of list) {
    ids.set(m.id, (ids.get(m.id) ?? 0) + 1)
    for (const r of m.routes) {
      const prev = paths.get(r.path)
      if (prev) out.push(`Duplicate route "${r.path}" in modules "${prev}" and "${m.id}"`)
      else paths.set(r.path, m.id)
    }
  }
  for (const [id, n] of ids) if (n > 1) out.push(`Duplicate module id "${id}" (${n}x)`)
  return out
}

import { lazy } from 'react'
import type { ModuleDef } from '@/lib/module'

// Lazy route component: the catalog screens load on first visit, not at startup.
const Page = lazy(() => import('./CatalogPage').then((m) => ({ default: m.CatalogPage })))

export const module: ModuleDef = {
  id: 'catalog',
  nav: [{ path: '/products', label: 'Products', group: 'Stock', icon: '📦', permission: 'catalog.view' }],
  routes: [{ path: '/products', element: <Page /> }]
}

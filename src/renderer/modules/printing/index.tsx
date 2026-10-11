import { lazy } from 'react'
import type { ModuleDef } from '@/lib/module'

export { PrintPreview } from './PrintPreview'

// Lazy route component: the printing screens load on first visit, not at startup.
const Page = lazy(() => import('./PrintingPage').then((m) => ({ default: m.PrintingPage })))

export const module: ModuleDef = {
  id: 'printing',
  nav: [{ path: '/printing', label: 'Printing & Labels', group: 'Admin', icon: '🖨️', permission: 'printing.view' }],
  routes: [{ path: '/printing', element: <Page /> }]
}

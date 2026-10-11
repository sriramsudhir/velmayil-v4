import { lazy } from 'react'
import type { ModuleDef } from '@/lib/module'

// Lazy route components: the POS screen (and its CSS) load on first visit, not at startup.
const PosPage = lazy(() => import('./PosScreen').then((m) => ({ default: m.PosPage })))
const SalesHistory = lazy(() => import('./SalesHistory').then((m) => ({ default: m.SalesHistory })))

export const module: ModuleDef = {
  id: 'pos',
  nav: [
    { path: '/pos', label: 'Billing (POS)', group: 'Sell', icon: '🧾', permission: 'pos.sell', order: 10 },
    { path: '/pos/history', label: 'Sales history', group: 'Sell', icon: '📜', permission: 'pos.reprint', order: 20 }
  ],
  routes: [
    { path: '/pos', element: <PosPage /> },
    { path: '/pos/history', element: <SalesHistory /> }
  ]
}

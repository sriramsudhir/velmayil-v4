import { lazy } from 'react'
import type { ModuleDef } from '@/lib/module'

const ReportsPage = lazy(() => import('./ReportsPage'))

export const module: ModuleDef = {
  id: 'reports',
  nav: [{ path: '/reports', label: 'Reports', group: 'Insights', icon: '📊', permission: 'reports.view' }],
  routes: [
    { path: '/reports', element: <ReportsPage /> },
    { path: '/reports/:id', element: <ReportsPage /> }
  ]
}

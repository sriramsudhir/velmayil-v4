import { lazy } from 'react'
import type { ModuleDef } from '@/lib/module'

// Route components are lazy: the shell and login paint without downloading/parsing every page of every module.
const Dashboard = lazy(() => import('./DashboardPage'))

export const module: ModuleDef = {
  id: 'dashboard',
  nav: [{ path: '/dashboard', label: 'Dashboard', group: 'Insights', icon: '🏠', order: 1 }],
  routes: [{ path: '/dashboard', element: <Dashboard /> }]
}

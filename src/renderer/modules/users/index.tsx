import { lazy } from 'react'
import type { ModuleDef } from '@/lib/module'

const Page = lazy(() => import('./UsersPage'))

export const module: ModuleDef = {
  id: 'users',
  nav: [{ path: '/users', label: 'Users & Security', group: 'Admin', icon: '🔐', permission: 'users.view' }],
  routes: [{ path: '/users', element: <Page /> }]
}

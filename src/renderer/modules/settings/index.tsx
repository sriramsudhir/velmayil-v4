import { lazy } from 'react'
import type { ModuleDef } from '@/lib/module'

const Page = lazy(() => import('./SettingsPage'))

export const module: ModuleDef = {
  id: 'settings',
  nav: [{ path: '/settings', label: 'Settings', group: 'Admin', icon: '⚙️', permission: 'settings.edit' }],
  routes: [{ path: '/settings', element: <Page /> }]
}

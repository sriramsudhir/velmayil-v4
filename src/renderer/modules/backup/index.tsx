import { lazy } from 'react'
import type { ModuleDef } from '@/lib/module'

const Page = lazy(() => import('./BackupPage'))

export const module: ModuleDef = {
  id: 'backup',
  nav: [{ path: '/backup', label: 'Backup & Sync', group: 'Admin', icon: '💾', permission: 'backup.manage' }],
  routes: [{ path: '/backup', element: <Page /> }]
}

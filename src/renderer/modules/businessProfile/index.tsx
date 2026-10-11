import { lazy } from 'react'
import type { ModuleDef } from '@/lib/module'

const ShopProfilePage = lazy(() => import('./ShopProfilePage').then((m) => ({ default: m.ShopProfilePage })))

export const module: ModuleDef = {
  id: 'businessProfile',
  nav: [{ path: '/settings/shop', label: 'Shop Profile', group: 'Admin', icon: '🏪', permission: 'profile.view' }],
  routes: [{ path: '/settings/shop', element: <ShopProfilePage /> }]
}

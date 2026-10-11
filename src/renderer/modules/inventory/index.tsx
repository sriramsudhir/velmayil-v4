import { lazy } from 'react'
import type { ModuleDef } from '@/lib/module'

// Lazy route components (named exports re-shaped to default): inventory screens load on first visit, not at startup.
const StockPage = lazy(() => import('./Stock').then((m) => ({ default: m.StockPage })))
const LowStockPage = lazy(() => import('./Stock').then((m) => ({ default: m.LowStockPage })))
const AdjustmentsPage = lazy(() => import('./Stock').then((m) => ({ default: m.AdjustmentsPage })))
const PurchasesPage = lazy(() => import('./Purchases').then((m) => ({ default: m.PurchasesPage })))
const PurchaseEntryPage = lazy(() => import('./Purchases').then((m) => ({ default: m.PurchaseEntryPage })))
const SuppliersPage = lazy(() => import('./Suppliers').then((m) => ({ default: m.SuppliersPage })))
const SupplierReturnsPage = lazy(() => import('./Suppliers').then((m) => ({ default: m.SupplierReturnsPage })))
const CountsPage = lazy(() => import('./Counts').then((m) => ({ default: m.CountsPage })))
const CountSheetPage = lazy(() => import('./Counts').then((m) => ({ default: m.CountSheetPage })))
const TransfersPage = lazy(() => import('./Transfers').then((m) => ({ default: m.TransfersPage })))

export const module: ModuleDef = {
  id: 'inventory',
  nav: [
    { path: '/inventory', label: 'Stock', group: 'Stock', icon: '🏬', permission: 'inventory.view', order: 10 },
    { path: '/inventory/low-stock', label: 'Low stock', group: 'Stock', icon: '⚠️', permission: 'inventory.view', order: 11 },
    { path: '/inventory/purchases', label: 'Purchases', group: 'Stock', icon: '🧾', permission: 'purchases.view', order: 12 },
    { path: '/inventory/suppliers', label: 'Suppliers', group: 'Stock', icon: '🚚', permission: 'purchases.view', order: 13 },
    { path: '/inventory/returns', label: 'Supplier returns', group: 'Stock', icon: '↩️', permission: 'purchases.view', order: 14 },
    { path: '/inventory/adjustments', label: 'Adjustments', group: 'Stock', icon: '✏️', permission: 'inventory.view', order: 15 },
    { path: '/inventory/counts', label: 'Stock counts', group: 'Stock', icon: '📋', permission: 'inventory.view', order: 16 },
    { path: '/inventory/transfers', label: 'Transfers', group: 'Stock', icon: '🔀', permission: 'inventory.view', order: 17 }
  ],
  routes: [
    { path: '/inventory', element: <StockPage /> },
    { path: '/inventory/low-stock', element: <LowStockPage /> },
    { path: '/inventory/purchases', element: <PurchasesPage /> },
    { path: '/inventory/purchases/new', element: <PurchaseEntryPage /> },
    { path: '/inventory/suppliers', element: <SuppliersPage /> },
    { path: '/inventory/returns', element: <SupplierReturnsPage /> },
    { path: '/inventory/adjustments', element: <AdjustmentsPage /> },
    { path: '/inventory/counts', element: <CountsPage /> },
    { path: '/inventory/counts/:id', element: <CountSheetPage /> },
    { path: '/inventory/transfers', element: <TransfersPage /> }
  ]
}

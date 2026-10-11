/** Canonical permission keys. Roles store a list of these. '*' = everything. */
export const PERMISSIONS = {
  'pos.sell': 'Create sales at POS',
  'pos.discount': 'Apply line/bill discounts',
  'pos.discount.unlimited': 'Discount above role limit without approval',
  'pos.price_override': 'Override selling price',
  'pos.hold': 'Hold / resume bills',
  'pos.void': 'Void a completed sale',
  'pos.delete': 'Permanently delete a sale / invoice',
  'pos.return': 'Process sales returns / refunds',
  'pos.reprint': 'Reprint invoices',
  'pos.shift': 'Open / close cash shift',
  'catalog.view': 'View products',
  'catalog.edit': 'Create / edit products',
  'catalog.delete': 'Delete / deactivate products',
  'catalog.import': 'Import / export catalog',
  'inventory.view': 'View stock',
  'inventory.adjust': 'Stock adjustments / counts / transfers',
  'purchases.view': 'View purchases & suppliers',
  'purchases.edit': 'Create purchases / supplier returns',
  'reports.view': 'View reports',
  'reports.export': 'Export reports',
  'reports.profit': 'View cost / profit data',
  'profile.view': 'View shop profile',
  'profile.edit': 'Edit shop name, logo and business info',
  'printing.view': 'Use printing',
  'printing.templates': 'Edit print templates / printer profiles',
  'users.view': 'View users',
  'users.manage': 'Manage users, roles, permissions',
  'audit.view': 'View audit log',
  'approvals.grant': 'Approve restricted actions',
  'settings.edit': 'Edit application settings',
  'backup.manage': 'Backup / restore',
  'sync.manage': 'Configure and run sync'
} as const
export type Permission = keyof typeof PERMISSIONS

export const DEFAULT_ROLES: Record<string, Permission[] | ['*']> = {
  Owner: ['*'],
  Manager: [
    'pos.sell', 'pos.discount', 'pos.discount.unlimited', 'pos.price_override', 'pos.hold', 'pos.void', 'pos.delete', 'pos.return',
    'pos.reprint', 'pos.shift', 'catalog.view', 'catalog.edit', 'catalog.delete', 'catalog.import', 'inventory.view',
    'inventory.adjust', 'purchases.view', 'purchases.edit', 'reports.view', 'reports.export', 'reports.profit',
    'profile.view', 'printing.view', 'users.view', 'audit.view', 'approvals.grant', 'backup.manage'
  ],
  Cashier: ['pos.sell', 'pos.discount', 'pos.hold', 'pos.reprint', 'pos.shift', 'catalog.view', 'inventory.view', 'profile.view', 'printing.view']
}

export const hasPermission = (granted: readonly string[], needed: Permission): boolean =>
  granted.includes('*') || granted.includes(needed)

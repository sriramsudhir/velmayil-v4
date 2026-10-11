// One-time scaffolding: renderer module stubs. Safe to delete after agents take ownership.
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'

const mods = [
  ['dashboard', 'Dashboard', '/dashboard', 'Insights', '🏠', null],
  ['pos', 'Billing (POS)', '/pos', 'Sell', '🧾', 'pos.sell'],
  ['catalog', 'Products', '/products', 'Stock', '📦', 'catalog.view'],
  ['inventory', 'Inventory & Purchases', '/inventory', 'Stock', '🏬', 'inventory.view'],
  ['reports', 'Reports', '/reports', 'Insights', '📊', 'reports.view'],
  ['printing', 'Printing & Labels', '/printing', 'Admin', '🖨️', 'printing.view'],
  ['businessProfile', 'Shop Profile', '/settings/shop', 'Admin', '🏪', 'profile.view'],
  ['settings', 'Settings', '/settings', 'Admin', '⚙️', 'settings.edit'],
  ['users', 'Users & Security', '/users', 'Admin', '🔐', 'users.view'],
  ['backup', 'Backup & Sync', '/backup', 'Admin', '💾', 'backup.manage']
]
for (const [id, label, path, group, icon, perm] of mods) {
  const dir = `src/renderer/modules/${id}`
  mkdirSync(dir, { recursive: true })
  const f = `${dir}/index.tsx`
  if (existsSync(f)) continue
  writeFileSync(
    f,
    `import type { ModuleDef } from '@/lib/module'
import { PageHeader, EmptyState } from '@/ui'

function Page() {
  return (
    <div className="page">
      <PageHeader title="${label}" />
      <EmptyState title="${label} is not built yet" />
    </div>
  )
}

export const module: ModuleDef = {
  id: '${id}',
  nav: [{ path: '${path}', label: '${label}', group: '${group}', icon: '${icon}'${perm ? `, permission: '${perm}'` : ''} }],
  routes: [{ path: '${path}', element: <Page /> }]
}
`
  )
}
mkdirSync('src/renderer/modules/setup', { recursive: true })
mkdirSync('src/renderer/modules/auth', { recursive: true })
writeFileSync(
  'src/renderer/modules/setup/SetupWizard.tsx',
  `import { Button, Card } from '@/ui'

// Owned by Agent 1. First-run setup: admin user, shop profile, POS terminal, default location.
export default function SetupWizard({ onDone }: { onDone: () => void }) {
  return (
    <div className="center-screen"><div className="center-card"><Card title="First-time setup"><p>Setup wizard not built yet.</p><Button onClick={onDone}>Continue</Button></Card></div></div>
  )
}
`
)
writeFileSync(
  'src/renderer/modules/auth/LoginPage.tsx',
  `import { Button, Card } from '@/ui'

// Owned by Agent 7. Username/password (and optional PIN) sign-in.
export default function LoginPage({ onDone }: { onDone: () => void }) {
  return (
    <div className="center-screen"><div className="center-card"><Card title="Sign in"><p>Login not built yet.</p><Button onClick={onDone}>Continue</Button></Card></div></div>
  )
}
`
)
writeFileSync(
  'src/renderer/modules/auth/index.tsx',
  `import type { ModuleDef } from '@/lib/module'
export const module: ModuleDef = { id: 'auth', routes: [] }
`
)
writeFileSync(
  'src/renderer/modules/setup/index.tsx',
  `import type { ModuleDef } from '@/lib/module'
export const module: ModuleDef = { id: 'setup', routes: [] }
`
)
console.log('stubs written')

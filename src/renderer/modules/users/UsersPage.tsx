import { useState } from 'react'
import { useSession } from '@/lib/session'
import { Button, EmptyState, PageHeader, Tabs } from '@/ui'
import { MyAccountDialog } from '@/modules/auth/MyAccount'
import { UsersTab } from './UsersTab'
import { RolesTab } from './RolesTab'
import { AuditTab } from './AuditTab'

function Page() {
  const { can } = useSession()
  const [tab, setTab] = useState('users')
  const [mine, setMine] = useState(false)
  const items = [
    { key: 'users', label: 'Users' },
    { key: 'roles', label: 'Roles & Permissions' },
    ...(can('audit.view') ? [{ key: 'audit', label: 'Audit Log' }] : [])
  ]
  return (
    <div className="page">
      <PageHeader title="Users & Security" subtitle="Staff accounts, roles, permissions and the audit trail" actions={<Button onClick={() => setMine(true)}>My account</Button>} />
      <Tabs items={items} value={tab} onChange={setTab} />
      <div style={{ marginTop: 16 }}>
        {tab === 'users' && <UsersTab canManage={can('users.manage')} />}
        {tab === 'roles' && <RolesTab canManage={can('users.manage')} />}
        {tab === 'audit' && (can('audit.view') ? <AuditTab /> : <EmptyState title="You do not have access to the audit log" />)}
      </div>
      <MyAccountDialog open={mine} onClose={() => setMine(false)} />
    </div>
  )
}

export default Page

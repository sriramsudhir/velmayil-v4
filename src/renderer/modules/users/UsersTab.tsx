import { useState } from 'react'
import { call, errMsg } from '@/lib/api'
import { useSession } from '@/lib/session'
import { Badge, Button, ConfirmDialog, EmptyState, ErrorState, Field, FormGrid, Input, Modal, Select, Spinner, Table, Toggle, formatDateTime, useAsync, useToast } from '@/ui'
import type { Column } from '@/ui'

export interface UserRow {
  id: number; username: string; name: string; role_id: number; role: string; active: number; has_pin: number
  locked_until: number | null; must_change_password: number; last_login_at: number | null; created_at: number
}
export interface RoleRow { id: number; name: string; permissions: string[]; maxDiscountBp: number; isSystem: boolean; users: number }

function UserDialog({ user, roles, onClose, onSaved }: { user: UserRow | null; roles: RoleRow[]; onClose: () => void; onSaved: () => void }) {
  const toast = useToast()
  const editing = !!user
  const [username, setUsername] = useState(user?.username ?? '')
  const [name, setName] = useState(user?.name ?? '')
  const [roleId, setRoleId] = useState(user?.role_id ?? roles.find((r) => r.name === 'Cashier')?.id ?? roles[0]?.id ?? 0)
  const [password, setPassword] = useState('')
  const [pin, setPin] = useState('')
  const [must, setMust] = useState(true)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  async function save() {
    setBusy(true); setErr('')
    try {
      if (editing) await call('auth', 'updateUser', { id: user.id, name, roleId })
      else await call('auth', 'createUser', { username, name, roleId, password, pin: pin || undefined, mustChangePassword: must })
      toast(editing ? 'User updated' : 'User created', 'good')
      onSaved()
    } catch (e) { setErr(errMsg(e)) } finally { setBusy(false) }
  }
  return (
    <Modal title={editing ? `Edit ${user.username}` : 'New user'} open onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save} disabled={busy || !name.trim() || (!editing && (!username || !password))}>{busy ? 'Saving…' : 'Save'}</Button></>}>
      <div style={{ display: 'grid', gap: 10 }}>
        <FormGrid cols={2}>
          <Field label="Username"><Input value={username} onChange={(e) => setUsername(e.target.value)} disabled={editing} autoComplete="off" spellCheck={false} /></Field>
          <Field label="Full name"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
        </FormGrid>
        <Field label="Role">
          <Select value={roleId} onChange={(e) => setRoleId(Number(e.target.value))}>
            {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </Select>
        </Field>
        {!editing && (
          <>
            <FormGrid cols={2}>
              <Field label="Temporary password" hint="Min 8 characters"><Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" /></Field>
              <Field label="Quick PIN (optional)" hint="4-6 digits"><Input inputMode="numeric" maxLength={6} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} /></Field>
            </FormGrid>
            <Toggle checked={must} onChange={setMust} label="Must change password at first sign-in" />
          </>
        )}
        {err && <div role="alert" className="field-error">{err}</div>}
      </div>
    </Modal>
  )
}

function ResetDialog({ user, onClose, onSaved }: { user: UserRow; onClose: () => void; onSaved: () => void }) {
  const toast = useToast()
  const [pw, setPw] = useState('')
  const [must, setMust] = useState(true)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  async function go() {
    setBusy(true); setErr('')
    try {
      await call('auth', 'resetPassword', { id: user.id, newPassword: pw, mustChange: must })
      toast(`Password reset for ${user.username}`, 'good')
      onSaved()
    } catch (e) { setErr(errMsg(e)) } finally { setBusy(false) }
  }
  return (
    <Modal title={`Reset password: ${user.username}`} open onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={go} disabled={busy || !pw}>Reset password</Button></>}>
      <div style={{ display: 'grid', gap: 10 }}>
        <Field label="New temporary password"><Input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" /></Field>
        <Toggle checked={must} onChange={setMust} label="Must change at next sign-in" />
        <p className="muted">This also clears any lock-out. The reset is recorded in the audit log.</p>
        {err && <div role="alert" className="field-error">{err}</div>}
      </div>
    </Modal>
  )
}

export function UsersTab({ canManage }: { canManage: boolean }) {
  const toast = useToast()
  const { session, refresh: refreshSession } = useSession()
  const users = useAsync(() => call<UserRow[]>('auth', 'listUsers'), [])
  const roles = useAsync(() => call<RoleRow[]>('auth', 'listRoles'), [])
  const [edit, setEdit] = useState<UserRow | 'new' | null>(null)
  const [reset, setReset] = useState<UserRow | null>(null)
  const [toggle, setToggle] = useState<UserRow | null>(null)

  if (users.loading || roles.loading) return <Spinner />
  if (users.error || roles.error) return <ErrorState message={users.error ?? roles.error ?? ''} onRetry={() => { users.reload(); roles.reload() }} />
  const refresh = () => { users.reload(); roles.reload(); setEdit(null); setReset(null); void refreshSession() }

  async function doToggle(u: UserRow) {
    try {
      await call('auth', 'setUserActive', { id: u.id, active: !u.active })
      toast(u.active ? `${u.username} deactivated` : `${u.username} reactivated`, 'good')
      users.reload()
    } catch (e) { toast(errMsg(e), 'bad') }
    setToggle(null)
  }

  const columns: Column<UserRow>[] = [
    { key: 'username', header: 'Username', render: (u) => <strong>{u.username}</strong> },
    { key: 'name', header: 'Name' },
    { key: 'role', header: 'Role' },
    {
      key: 'status', header: 'Status', render: (u) => (
        !u.active ? <Badge tone="bad">Disabled</Badge>
          : u.locked_until && u.locked_until > Date.now() ? <Badge tone="warn">Locked</Badge>
            : <Badge tone="good">Active</Badge>
      )
    },
    { key: 'pin', header: 'PIN', render: (u) => (u.has_pin ? 'Yes' : '-') },
    { key: 'last', header: 'Last sign-in', render: (u) => (u.last_login_at ? formatDateTime(u.last_login_at) : 'Never') }
  ]
  if (canManage) {
    columns.push({
      key: 'actions', header: '', align: 'right', render: (u) => (
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <Button onClick={() => setEdit(u)}>Edit</Button>
          <Button onClick={() => setReset(u)}>Reset password</Button>
          <Button variant={u.active ? 'danger' : 'default'} onClick={() => (u.active ? setToggle(u) : void doToggle(u))} disabled={u.id === session?.userId && !!u.active}>
            {u.active ? 'Deactivate' : 'Reactivate'}
          </Button>
        </div>
      )
    })
  }

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {canManage && <div className="row"><Button variant="primary" onClick={() => setEdit('new')}>+ New user</Button></div>}
      <Table columns={columns} rows={users.data ?? []} rowKey={(u) => u.id} empty={<EmptyState title="No users" />} />
      {edit && <UserDialog user={edit === 'new' ? null : edit} roles={roles.data ?? []} onClose={() => setEdit(null)} onSaved={refresh} />}
      {reset && <ResetDialog user={reset} onClose={() => setReset(null)} onSaved={refresh} />}
      <ConfirmDialog open={!!toggle} tone="danger" title="Deactivate user"
        message={toggle ? `${toggle.name} (${toggle.username}) will no longer be able to sign in. Their history is kept. Users are never deleted.` : ''}
        confirmLabel="Deactivate" onConfirm={() => toggle && void doToggle(toggle)} onCancel={() => setToggle(null)} />
    </div>
  )
}

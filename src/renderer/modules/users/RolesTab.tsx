import { useEffect, useMemo, useState } from 'react'
import { call, errMsg } from '@/lib/api'
import { useSession } from '@/lib/session'
import { Badge, Button, Card, Checkbox, ConfirmDialog, ErrorState, Field, Input, Spinner, useAsync, useToast } from '@/ui'
import type { RoleRow } from './UsersTab'

interface Perm { key: string; label: string; group: string }
const GROUP_LABEL: Record<string, string> = {
  pos: 'Point of sale', catalog: 'Catalogue', inventory: 'Inventory', purchases: 'Purchases', reports: 'Reports', profile: 'Shop profile',
  printing: 'Printing', users: 'Users & security', audit: 'Audit', approvals: 'Approvals', settings: 'Settings', backup: 'Backup', sync: 'Sync'
}

export function RolesTab({ canManage }: { canManage: boolean }) {
  const toast = useToast()
  const { refresh: refreshSession } = useSession()
  const roles = useAsync(() => call<RoleRow[]>('auth', 'listRoles'), [])
  const catalog = useAsync(() => call<Perm[]>('auth', 'permissionCatalog'), [])
  const [sel, setSel] = useState<number | 'new' | null>(null)
  const [name, setName] = useState('')
  const [perms, setPerms] = useState<Set<string>>(new Set())
  const [discPct, setDiscPct] = useState('100')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmDel, setConfirmDel] = useState(false)

  const current = useMemo(() => (typeof sel === 'number' ? roles.data?.find((r) => r.id === sel) : undefined), [sel, roles.data])
  useEffect(() => {
    if (sel === null && roles.data?.length) setSel(roles.data[0].id)
  }, [sel, roles.data])
  useEffect(() => {
    setErr('')
    if (sel === 'new') { setName(''); setPerms(new Set()); setDiscPct('0') }
    else if (current) { setName(current.name); setPerms(new Set(current.permissions)); setDiscPct(String(current.maxDiscountBp / 100)) }
  }, [sel, current])

  if (roles.loading || catalog.loading) return <Spinner />
  if (roles.error || catalog.error) return <ErrorState message={roles.error ?? catalog.error ?? ''} onRetry={() => { roles.reload(); catalog.reload() }} />

  const fullAccess = perms.has('*')
  const readOnly = !canManage || current?.name === 'Owner'
  const groups = [...new Set((catalog.data ?? []).map((p) => p.group))]

  async function save() {
    const pct = discPct.trim() === '' ? NaN : Number(discPct)
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) { setErr('Max discount must be a number from 0 to 100'); return }
    setBusy(true); setErr('')
    try {
      const saved = await call<RoleRow>('auth', 'saveRole', {
        id: typeof sel === 'number' ? sel : undefined, name, permissions: [...perms], maxDiscountBp: Math.round(pct * 100)
      })
      toast('Role saved', 'good')
      roles.reload()
      setSel(saved.id)
      void refreshSession() // the role just edited may be the one this user holds: menu and buttons follow immediately
    } catch (e) { setErr(errMsg(e)) } finally { setBusy(false) }
  }
  async function del() {
    setConfirmDel(false)
    try {
      await call('auth', 'deleteRole', { id: current!.id })
      toast('Role deleted', 'good')
      setSel(null)
      roles.reload()
    } catch (e) { setErr(errMsg(e)) }
  }
  const toggle = (k: string, on: boolean) => setPerms((p) => { const n = new Set(p); on ? n.add(k) : n.delete(k); return n })

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(180px, 240px) 1fr', gap: 16, alignItems: 'start' }}>
      <Card title="Roles" actions={canManage && <Button onClick={() => setSel('new')}>+ New</Button>}>
        <div style={{ display: 'grid', gap: 4 }}>
          {(roles.data ?? []).map((r) => (
            <Button key={r.id} variant={sel === r.id ? 'primary' : 'ghost'} onClick={() => setSel(r.id)} style={{ textAlign: 'left', display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              <span>{r.name}</span><span className="muted">{r.users} user{r.users === 1 ? '' : 's'}</span>
            </Button>
          ))}
        </div>
      </Card>
      <Card title={sel === 'new' ? 'New role' : current?.name ?? 'Role'} actions={current?.isSystem ? <Badge>System role</Badge> : undefined}>
        <div style={{ display: 'grid', gap: 12 }}>
          <div className="grid2">
            <Field label="Role name"><Input value={name} onChange={(e) => setName(e.target.value)} disabled={readOnly || !!current?.isSystem} /></Field>
            <Field label="Max discount (%)" hint="Cashiers above this need manager approval"><Input inputMode="decimal" value={discPct} onChange={(e) => setDiscPct(e.target.value)} disabled={readOnly} /></Field>
          </div>
          {fullAccess
            ? <p><Badge tone="good">Full access</Badge> This role can do everything and cannot be restricted.</p>
            : groups.map((g) => (
              <fieldset key={g} style={{ border: '1px solid var(--line)', borderRadius: 8, padding: '8px 12px' }}>
                <legend className="field-label">{GROUP_LABEL[g] ?? g}</legend>
                <div className="grid2">
                  {(catalog.data ?? []).filter((p) => p.group === g).map((p) => (
                    <Checkbox key={p.key} label={<span>{p.label} <span className="muted">({p.key})</span></span>} checked={perms.has(p.key)} disabled={readOnly} onChange={(e) => toggle(p.key, e.target.checked)} />
                  ))}
                </div>
              </fieldset>
            ))}
          {err && <div role="alert" className="field-error">{err}</div>}
          {!readOnly && (
            <div className="row">
              <Button variant="primary" onClick={save} disabled={busy || name.trim().length < 2}>{busy ? 'Saving…' : 'Save role'}</Button>
              {current && !current.isSystem && <Button variant="danger" onClick={() => setConfirmDel(true)}>Delete role</Button>}
            </div>
          )}
          {current?.isSystem && <p className="muted">System roles can be edited but not renamed or deleted. Permission changes are recorded in the audit log.</p>}
        </div>
      </Card>
      <ConfirmDialog open={confirmDel} tone="danger" title="Delete role" message={`Delete the role "${current?.name}"? This cannot be undone.`} confirmLabel="Delete" onConfirm={del} onCancel={() => setConfirmDel(false)} />
    </div>
  )
}

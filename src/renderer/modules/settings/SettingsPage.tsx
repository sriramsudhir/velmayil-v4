import { useState } from 'react'
import { call, errMsg } from '@/lib/api'
import { ScannerSettings } from './ScannerSettings'
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, Modal, PageHeader, Select, Spinner, Table, useAsync, useToast } from '@/ui'

interface Def { key: string; label: string; group: string; kind: 'bool' | 'int' | 'enum' | 'text'; options?: string[]; min?: number; max?: number }
interface Terminal { id: number; code: string; name: string; isLocal: boolean; active: boolean }
interface Location { id: number; name: string; isDefault: boolean; active: boolean; stockQty: number }
interface Health {
  ok: boolean
  integrity: string[]
  foreignKeyViolations: { table: string; rowid: number; parent: string }[]
  stockMismatches: { variantId: number; locationId: number; level: number; ledger: number }[]
}
interface Stats { path: string; sizeBytes: number; walMode: string; schemaVersion: number; migrations: number; tables: { name: string; rows: number }[] }

const OPTION_LABELS: Record<string, string> = {
  original: 'Original shop details (as on the first bill)', current: 'Current shop details',
  last: 'Last purchase cost', weighted: 'Weighted average of stock on hand and the new purchase'
}

function General() {
  const toast = useToast()
  const { data, loading, error, reload } = useAsync(() => call<{ values: Record<string, string>; defs: Def[] }>('settings', 'getAll'), [])
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [errs, setErrs] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  if (loading && !data) return <Spinner />
  if (error || !data) return <ErrorState message={error ?? 'Could not load settings'} onRetry={reload} />
  const val = (k: string) => draft[k] ?? data.values[k]
  const dirty = Object.keys(draft).filter((k) => draft[k] !== data.values[k])
  const groups = [...new Set(data.defs.map((d) => d.group))]

  const save = async () => {
    setSaving(true)
    const e: Record<string, string> = {}
    try {
      for (const k of dirty) {
        try { await call('settings', 'set', { key: k, value: draft[k] }) } catch (x) { e[k] = errMsg(x) }
      }
    } finally { setSaving(false) }
    setErrs(e)
    if (Object.keys(e).length) toast('Some settings were not saved', 'bad')
    else toast('Settings saved', 'good')
    setDraft((d) => Object.fromEntries(Object.entries(d).filter(([k]) => e[k])))
    reload()
  }

  return (
    <form onSubmit={(ev) => { ev.preventDefault(); if (dirty.length && !saving) void save() }} style={{ display: 'grid', gap: 12 }}>
      {groups.map((g) => (
        <Card key={g} title={g}>
          <div style={{ display: 'grid', gap: 10 }}>
            {data.defs.filter((d) => d.group === g).map((d) => (
              <Field key={d.key} label={d.label} error={errs[d.key]}>
                {d.kind === 'bool' ? (
                  <Select value={val(d.key)} onChange={(e) => setDraft({ ...draft, [d.key]: e.target.value })}>
                    <option value="1">Yes</option><option value="0">No</option>
                  </Select>
                ) : d.kind === 'enum' ? (
                  <Select value={val(d.key)} onChange={(e) => setDraft({ ...draft, [d.key]: e.target.value })}>
                    {d.options!.map((o) => <option key={o} value={o}>{OPTION_LABELS[o] ?? o}</option>)}
                  </Select>
                ) : (
                  <Input type={/(^|\.)(key|secret|password|token)$/i.test(d.key) ? 'password' : undefined} autoComplete="off" value={val(d.key)} inputMode={d.kind === 'int' ? 'numeric' : undefined} onChange={(e) => setDraft({ ...draft, [d.key]: e.target.value })} />
                )}
              </Field>
            ))}
          </div>
        </Card>
      ))}
      <div className="row">
        <Button type="submit" variant="primary" disabled={!dirty.length || saving}>{saving ? 'Saving...' : 'Save changes'}</Button>
        <Button type="button" disabled={!dirty.length || saving} onClick={() => { setDraft({}); setErrs({}) }}>Discard</Button>
      </div>
    </form>
  )
}

function Terminals() {
  const toast = useToast()
  const { data, loading, error, reload } = useAsync(() => call<Terminal[]>('settings', 'listTerminals'), [])
  const [edit, setEdit] = useState<{ id?: number; code: string; name: string } | null>(null)
  const [err, setErr] = useState('')
  const save = async () => {
    if (!edit) return
    try {
      if (edit.id) await call('settings', 'updateTerminal', { id: edit.id, code: edit.code, name: edit.name })
      else await call('settings', 'addTerminal', { code: edit.code, name: edit.name })
      setEdit(null); setErr(''); toast('Terminal saved', 'good'); reload()
    } catch (e) { setErr(errMsg(e)) }
  }
  const toggle = async (t: Terminal) => {
    try { await call('settings', 'updateTerminal', { id: t.id, active: !t.active }); reload() } catch (e) { toast(errMsg(e), 'bad') }
  }
  if (loading && !data) return <Spinner />
  if (error || !data) return <ErrorState message={error ?? 'Could not load terminals'} onRetry={reload} />
  return (
    <Card title="POS terminals" actions={<Button onClick={() => { setErr(''); setEdit({ code: '', name: '' }) }}>Add terminal</Button>}>
      <Table
        rows={data}
        rowKey={(t) => t.id}
        empty={<EmptyState title="No terminals" />}
        columns={[
          { key: 'code', header: 'Code' },
          { key: 'name', header: 'Name' },
          { key: 'isLocal', header: 'This computer', render: (t) => (t.isLocal ? <Badge tone="good">This computer</Badge> : '') },
          { key: 'active', header: 'Status', render: (t) => (t.active ? <Badge tone="good">Active</Badge> : <Badge tone="warn">Inactive</Badge>) },
          {
            key: 'actions', header: '', align: 'right',
            render: (t) => (
              <span className="row" style={{ justifyContent: 'flex-end' }}>
                <Button onClick={() => { setErr(''); setEdit({ id: t.id, code: t.code, name: t.name }) }}>Edit</Button>
                {!t.isLocal && <Button variant="ghost" onClick={() => void toggle(t)}>{t.active ? 'Deactivate' : 'Activate'}</Button>}
              </span>
            )
          }
        ]}
      />
      <Modal title={edit?.id ? 'Edit terminal' : 'Add terminal'} open={!!edit} onClose={() => setEdit(null)} footer={<><Button onClick={() => setEdit(null)}>Cancel</Button><Button variant="primary" onClick={() => void save()}>Save</Button></>}>
        {edit && (
          <form onSubmit={(e) => { e.preventDefault(); void save() }} style={{ display: 'grid', gap: 10 }}>
            <Field label="Code" hint="Letters, digits, dashes. Part of bill numbers if each terminal has its own series.">
              <Input autoFocus value={edit.code} onChange={(e) => setEdit({ ...edit, code: e.target.value.toUpperCase() })} maxLength={16} />
            </Field>
            <Field label="Name"><Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} maxLength={60} /></Field>
            {err && <div className="field-error" role="alert">{err}</div>}
          </form>
        )}
      </Modal>
    </Card>
  )
}

function Locations() {
  const toast = useToast()
  const { data, loading, error, reload } = useAsync(() => call<Location[]>('settings', 'listLocations'), [])
  const [edit, setEdit] = useState<{ id?: number; name: string } | null>(null)
  const [err, setErr] = useState('')
  const act = async (method: string, args: unknown, msg: string) => {
    try { await call('settings', method, args); toast(msg, 'good'); reload() } catch (e) { toast(errMsg(e), 'bad') }
  }
  const save = async () => {
    if (!edit) return
    try {
      if (edit.id) await call('settings', 'renameLocation', { id: edit.id, name: edit.name })
      else await call('settings', 'addLocation', { name: edit.name })
      setEdit(null); setErr(''); toast('Location saved', 'good'); reload()
    } catch (e) { setErr(errMsg(e)) }
  }
  if (loading && !data) return <Spinner />
  if (error || !data) return <ErrorState message={error ?? 'Could not load locations'} onRetry={reload} />
  return (
    <Card title="Stock locations" actions={<Button onClick={() => { setErr(''); setEdit({ name: '' }) }}>Add location</Button>}>
      <Table
        rows={data}
        rowKey={(l) => l.id}
        empty={<EmptyState title="No locations" />}
        columns={[
          { key: 'name', header: 'Name' },
          { key: 'stockQty', header: 'Units in stock', align: 'right' },
          { key: 'isDefault', header: 'Default', render: (l) => (l.isDefault ? <Badge tone="good">Default</Badge> : '') },
          { key: 'active', header: 'Status', render: (l) => (l.active ? <Badge tone="good">Active</Badge> : <Badge tone="warn">Inactive</Badge>) },
          {
            key: 'actions', header: '', align: 'right',
            render: (l) => (
              <span className="row" style={{ justifyContent: 'flex-end' }}>
                <Button onClick={() => { setErr(''); setEdit({ id: l.id, name: l.name }) }}>Rename</Button>
                {!l.isDefault && l.active && <Button onClick={() => void act('setDefaultLocation', { id: l.id }, 'Default location changed')}>Make default</Button>}
                {!l.isDefault && <Button variant="ghost" onClick={() => void act('setLocationActive', { id: l.id, active: !l.active }, l.active ? 'Location deactivated' : 'Location activated')}>{l.active ? 'Deactivate' : 'Activate'}</Button>}
              </span>
            )
          }
        ]}
      />
      <Modal title={edit?.id ? 'Rename location' : 'Add location'} open={!!edit} onClose={() => setEdit(null)} footer={<><Button onClick={() => setEdit(null)}>Cancel</Button><Button variant="primary" onClick={() => void save()}>Save</Button></>}>
        {edit && (
          <form onSubmit={(e) => { e.preventDefault(); void save() }} style={{ display: 'grid', gap: 10 }}>
            <Field label="Name"><Input autoFocus value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} maxLength={60} /></Field>
            {err && <div className="field-error" role="alert">{err}</div>}
          </form>
        )}
      </Modal>
    </Card>
  )
}

const fmtBytes = (n: number) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`)

function Database() {
  const stats = useAsync(() => call<Stats>('db', 'stats'), [])
  const [health, setHealth] = useState<Health | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const run = async () => {
    setBusy(true); setErr('')
    try { setHealth(await call<Health>('db', 'integrityCheck')); stats.reload() } catch (e) { setErr(errMsg(e)) } finally { setBusy(false) }
  }
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <Card title="Database health" actions={<Button variant="primary" onClick={() => void run()} disabled={busy}>{busy ? 'Checking...' : 'Run health check'}</Button>}>
        {err && <ErrorState message={err} />}
        {!health && !err && <p className="muted">Checks file integrity, record links and that stock levels match the stock ledger.</p>}
        {health && (
          <div style={{ display: 'grid', gap: 6 }}>
            <div>{health.ok ? <Badge tone="good">All checks passed</Badge> : <Badge tone="bad">Problems found</Badge>}</div>
            {!(health.integrity.length === 1 && health.integrity[0] === 'ok') && <div className="field-error">Integrity: {health.integrity.slice(0, 5).join('; ')}</div>}
            {health.foreignKeyViolations.length > 0 && <div className="field-error">{health.foreignKeyViolations.length} broken record link(s), first in table {health.foreignKeyViolations[0].table}</div>}
            {health.stockMismatches.length > 0 && <div className="field-error">{health.stockMismatches.length} stock level(s) do not match the stock ledger</div>}
          </div>
        )}
      </Card>
      <Card title="Database">
        {stats.loading && !stats.data ? <Spinner /> : stats.error || !stats.data ? <ErrorState message={stats.error ?? 'Unavailable'} onRetry={stats.reload} /> : (
          <>
            <p className="muted">{stats.data.path} - {fmtBytes(stats.data.sizeBytes)} - journal {stats.data.walMode} - schema v{stats.data.schemaVersion}</p>
            <Table rows={stats.data.tables} rowKey={(t) => t.name} columns={[{ key: 'name', header: 'Table' }, { key: 'rows', header: 'Rows', align: 'right' }]} />
          </>
        )}
      </Card>
    </div>
  )
}

const TABS = [['general', 'General'], ['terminals', 'Terminals'], ['locations', 'Locations'], ['scanner', 'Scanner'], ['database', 'Database']] as const

function Page() {
  const [tab, setTab] = useState<(typeof TABS)[number][0]>('general')
  return (
    <div className="page">
      <PageHeader title="Settings" subtitle="Billing, inventory, security, terminals and database health" />
      <div className="row" role="tablist" style={{ marginBottom: 12 }}>
        {TABS.map(([k, label]) => (
          <Button key={k} role="tab" aria-selected={tab === k} variant={tab === k ? 'primary' : 'default'} onClick={() => setTab(k)}>{label}</Button>
        ))}
      </div>
      {tab === 'general' && <General />}
      {tab === 'terminals' && <Terminals />}
      {tab === 'locations' && <Locations />}
      {tab === 'scanner' && <ScannerSettings />}
      {tab === 'database' && <Database />}
    </div>
  )
}

export default Page

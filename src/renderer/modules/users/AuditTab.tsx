import { useState } from 'react'
import { call } from '@/lib/api'
import { Button, EmptyState, ErrorState, Field, Input, Modal, Select, Spinner, Table, endOfDayIST, formatDateTime, startOfDayIST, useAsync } from '@/ui'
import type { Column } from '@/ui'
import type { UserRow } from './UsersTab'

interface Diff { path: string; old: unknown; new: unknown }
interface AuditRow {
  id: number; ts: number; user_id: number | null; user_name: string | null; pos_code: string | null
  entity: string; entity_id: string | null; action: string; note: string | null; changes: Diff[]
}
interface Result { rows: AuditRow[]; total: number; limit: number; offset: number }

const show = (v: unknown) => (v === undefined ? '(none)' : typeof v === 'string' ? v : JSON.stringify(v))
const PAGE = 50

export function AuditTab() {
  const [f, setF] = useState({ from: '', to: '', userId: '', entity: '', action: '', text: '' })
  const [applied, setApplied] = useState(f)
  const [offset, setOffset] = useState(0)
  const [detail, setDetail] = useState<AuditRow | null>(null)
  const users = useAsync(() => call<UserRow[]>('auth', 'listUsers'), [])
  const entities = useAsync(() => call<string[]>('audit', 'entities'), [])
  const actions = useAsync(() => call<string[]>('audit', 'actions'), [])
  const res = useAsync(
    () => call<Result>('audit', 'search', {
      from: applied.from ? startOfDayIST(applied.from) : undefined, to: applied.to ? endOfDayIST(applied.to) : undefined,
      userId: applied.userId ? Number(applied.userId) : undefined, entity: applied.entity || undefined, action: applied.action || undefined,
      text: applied.text || undefined, limit: PAGE, offset
    }),
    [applied, offset]
  )
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value })
  const apply = () => { setOffset(0); setApplied(f) }

  const columns: Column<AuditRow>[] = [
    { key: 'ts', header: 'When', render: (r) => formatDateTime(r.ts) },
    { key: 'user', header: 'User', render: (r) => r.user_name ?? '-' },
    { key: 'entity', header: 'Entity', render: (r) => `${r.entity}${r.entity_id ? ' #' + r.entity_id : ''}` },
    { key: 'action', header: 'Action' },
    { key: 'note', header: 'Note', render: (r) => r.note ?? '' },
    { key: 'chg', header: 'Changes', render: (r) => (r.changes.length ? `${r.changes.length} field(s)` : '') }
  ]
  const total = res.data?.total ?? 0

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <form className="row" onSubmit={(e) => { e.preventDefault(); apply() }} style={{ alignItems: 'flex-end' }}>
        <Field label="From"><Input type="date" value={f.from} onChange={set('from')} /></Field>
        <Field label="To"><Input type="date" value={f.to} onChange={set('to')} /></Field>
        <Field label="User">
          <Select value={f.userId} onChange={set('userId')}><option value="">All</option>{(users.data ?? []).map((u) => <option key={u.id} value={u.id}>{u.username}</option>)}</Select>
        </Field>
        <Field label="Entity"><Select value={f.entity} onChange={set('entity')}><option value="">All</option>{(entities.data ?? []).map((x) => <option key={x}>{x}</option>)}</Select></Field>
        <Field label="Action"><Select value={f.action} onChange={set('action')}><option value="">All</option>{(actions.data ?? []).map((x) => <option key={x}>{x}</option>)}</Select></Field>
        <Field label="Search"><Input value={f.text} onChange={set('text')} placeholder="note, user, id…" /></Field>
        <Button type="submit" variant="primary">Search</Button>
        <Button type="button" onClick={() => { const e = { from: '', to: '', userId: '', entity: '', action: '', text: '' }; setF(e); setApplied(e); setOffset(0) }}>Clear</Button>
      </form>
      {res.loading ? <Spinner /> : res.error ? <ErrorState message={res.error} onRetry={res.reload} /> : (
        <>
          <Table columns={columns} rows={res.data?.rows ?? []} rowKey={(r) => r.id} onRowClick={setDetail} empty={<EmptyState title="No audit entries match" />} />
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className="muted">{total ? `${offset + 1}-${Math.min(offset + PAGE, total)} of ${total}` : '0 entries'}</span>
            <div className="row">
              <Button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Previous</Button>
              <Button disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>Next</Button>
            </div>
          </div>
        </>
      )}
      <Modal open={!!detail} title={detail ? `${detail.entity} · ${detail.action}` : ''} onClose={() => setDetail(null)} wide footer={<Button onClick={() => setDetail(null)}>Close</Button>}>
        {detail && (
          <div style={{ display: 'grid', gap: 8 }}>
            <div className="muted">{formatDateTime(detail.ts)} · {detail.user_name ?? 'system'} · {detail.pos_code ?? ''}</div>
            {detail.note && <p>{detail.note}</p>}
            {detail.changes.length ? (
              <Table columns={[
                { key: 'path', header: 'Field' },
                { key: 'old', header: 'Before', render: (d: Diff) => <code>{show(d.old)}</code> },
                { key: 'new', header: 'After', render: (d: Diff) => <code>{show(d.new)}</code> }
              ]} rows={detail.changes} rowKey={(d) => d.path} />
            ) : <p className="muted">No field changes recorded.</p>}
          </div>
        )}
      </Modal>
    </div>
  )
}

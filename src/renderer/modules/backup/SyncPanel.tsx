import { useState } from 'react'
import { call, errMsg } from '@/lib/api'
import { useSession } from '@/lib/session'
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, Select, Spinner, Table, useAsync, useInterval, useToast } from '@/ui'
import { ago, fmtTime } from './format'

interface Status {
  enabled: boolean; transport: 'http' | 'folder'; configured: boolean; online: boolean | null
  pending: number; failed: number; rejected: number; deferred: number; openConflicts: number
  lastSyncAt: number | null; lastError: string | null; backoffUntil: number | null; running: boolean
  device: { uuid: string; code: string; name: string }
}
interface Config { enabled: boolean; transport: 'http' | 'folder'; url: string; folder: string; hasKey: boolean; intervalSec: number }
interface Conflict { id: number; ts: number; kind: string; entity: string; entity_uuid: string; device: string; resolution: string; acknowledged: number }
interface Device { device: string; code: string; name: string; local: boolean; lastSeen: number | null; changesIn: number }

const KIND: Record<string, string> = {
  lww_lost_local: 'Your edit was replaced by a newer one', lww_lost_remote: 'A newer local edit was kept',
  duplicate_key: 'Same record created twice (merged)', number_collision: 'Duplicate document number (kept both)',
  apply_error: 'Could not apply a change', unresolved_ref: 'Related record never arrived', version_collision: 'Profile version clash'
}

export function SyncBadge() {
  const { data } = useAsync(() => call<Status>('sync', 'getStatus').catch(() => null), [])
  if (!data || !data.enabled) return null
  return <Badge tone={data.pending ? 'warn' : 'good'}>{data.pending ? `${data.pending} waiting to sync` : 'In sync'}</Badge>
}

export function SyncPanel() {
  const toast = useToast()
  const { can } = useSession()
  const canConfigure = can('sync.manage')
  const st = useAsync(() => call<Status>('sync', 'getStatus'), [])
  const cfg = useAsync(() => call<Config>('sync', 'getConfig'), [])
  const conflicts = useAsync(() => call<Conflict[]>('sync', 'listConflicts', {}), [])
  const devices = useAsync(() => call<Device[]>('sync', 'listDevices'), [])
  const [draft, setDraft] = useState<Partial<Config> & { key?: string }>({})
  const [busy, setBusy] = useState<string | null>(null)

  // live status while the tab is open: paused while the window is hidden, never overlapping
  useInterval(st.reload, 10_000)

  if ((st.loading && !st.data) || (cfg.loading && !cfg.data)) return <Spinner />
  if (st.error || !st.data) return <ErrorState message={st.error ?? 'Could not load sync status'} onRetry={st.reload} />
  if (cfg.error || !cfg.data) return <ErrorState message={cfg.error ?? 'Could not load sync settings'} onRetry={cfg.reload} />
  const s = st.data
  const c = { ...cfg.data, ...draft }
  const reloadAll = () => { st.reload(); cfg.reload(); conflicts.reload(); devices.reload() }

  const run = async (key: string, fn: () => Promise<string | void>) => {
    setBusy(key)
    try {
      const msg = await fn()
      if (msg) toast(msg, 'good')
      reloadAll()
    } catch (e) {
      toast(errMsg(e), 'bad')
    } finally {
      setBusy(null)
    }
  }

  const state = !s.enabled ? <Badge>Sync is off</Badge> : s.online === false ? <Badge tone="bad">Offline</Badge> : s.online ? <Badge tone="good">Online</Badge> : <Badge tone="warn">Not connected yet</Badge>

  return (
    <div className="col" style={{ gap: 16 }}>
      <Card title="Sync status" actions={
        <Button variant="primary" disabled={!s.enabled || busy === 'sync' || s.running} onClick={() => run('sync', async () => {
          const r = await call<{ ok: boolean; pushed: number; received: number; error?: string; skipped?: string }>('sync', 'syncNow')
          if (!r.ok) throw new Error(r.error ?? r.skipped ?? 'Sync failed')
          return `Sent ${r.pushed}, received ${r.received}`
        })}>{busy === 'sync' || s.running ? 'Syncing…' : 'Sync now'}</Button>
      }>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
          {state}
          <Badge tone={s.pending ? 'warn' : 'good'}>{s.pending} waiting to send</Badge>
          {s.failed > 0 && <Badge tone="bad">{s.failed} failed</Badge>}
          {s.rejected > 0 && <Badge tone="bad">{s.rejected} rejected</Badge>}
          {s.deferred > 0 && <Badge tone="warn">{s.deferred} waiting for related data</Badge>}
          {s.openConflicts > 0 && <Badge tone="warn">{s.openConflicts} conflicts</Badge>}
        </div>
        <p className="muted">
          This terminal: <strong>{s.device.code}</strong> ({s.device.name}). Last successful sync: <strong>{ago(s.lastSyncAt)}</strong>
          {s.lastSyncAt ? ` (${fmtTime(s.lastSyncAt)})` : ''}. Billing keeps working offline; changes are sent when the connection returns.
        </p>
        {s.lastError && <p role="alert" style={{ color: 'var(--bad)' }}>Last error: {s.lastError}{s.backoffUntil && s.backoffUntil > Date.now() ? ` — retrying automatically after ${fmtTime(s.backoffUntil)}` : ''}</p>}
        {(s.failed > 0 || s.rejected > 0) && <Button onClick={() => run('retry', async () => { await call('sync', 'retryFailed'); return 'Queued for retry' })}>Retry failed items</Button>}
      </Card>

      <Card title="Connection" actions={canConfigure && (
        <span className="row" style={{ gap: 8 }}>
          <Button disabled={busy === 'test'} onClick={() => run('test', async () => {
            if (Object.keys(draft).length) throw new Error('Save the settings first, then test the connection')
            const r = await call<{ ok: boolean; error?: string; detail?: string }>('sync', 'testConnection')
            if (!r.ok) throw new Error(r.error)
            return 'Connection works' + (r.detail ? ` (${r.detail})` : '')
          })}>Test connection</Button>
          <Button variant="primary" disabled={!Object.keys(draft).length} onClick={() => run('save', async () => { await call('sync', 'saveConfig', draft); setDraft({}); return 'Sync settings saved' })}>Save</Button>
        </span>
      )}>
        {!canConfigure && <p className="muted">Only users with the “Configure and run sync” permission can change these settings.</p>}
        <div className="form-grid">
          <label className="check"><input type="checkbox" disabled={!canConfigure} checked={c.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} /> Enable multi-POS sync</label>
          <Field label="How terminals connect">
            <Select disabled={!canConfigure} value={c.transport} onChange={(e) => setDraft({ ...draft, transport: e.target.value as 'http' | 'folder' })}>
              <option value="http">Sync server (URL + key)</option>
              <option value="folder">Shared folder (network share / OneDrive — no server)</option>
            </Select>
          </Field>
          {c.transport === 'http' ? (
            <>
              <Field label="Server URL" hint="e.g. http://192.168.1.10:8787"><Input disabled={!canConfigure} value={c.url} onChange={(e) => setDraft({ ...draft, url: e.target.value })} /></Field>
              <Field label="API key" hint={c.hasKey ? 'A key is saved. Type a new one to replace it.' : 'Required'}><Input type="password" disabled={!canConfigure} value={draft.key ?? ''} autoComplete="off" onChange={(e) => setDraft({ ...draft, key: e.target.value })} /></Field>
            </>
          ) : (
            <Field label="Shared folder" hint="Every terminal must point to the same folder."><Input disabled={!canConfigure} value={c.folder} placeholder="\\SERVER\VelmayilSync" onChange={(e) => setDraft({ ...draft, folder: e.target.value })} /></Field>
          )}
          <Field label="Sync every (seconds)"><Input type="number" min={5} disabled={!canConfigure} value={c.intervalSec} onChange={(e) => setDraft({ ...draft, intervalSec: Number(e.target.value) })} /></Field>
        </div>
        {canConfigure && (
          <p>
            <Button disabled={busy === 'resync'} onClick={() => {
              if (window.confirm('Re-send ALL products, customers, sales and stock history to the other terminals? Safe to repeat, but can take a while.')) {
                void run('resync', async () => { const r = await call<{ queued: number }>('sync', 'resyncAll'); return `Queued ${r.queued} records` })
              }
            }}>Send all existing data to other terminals</Button>
          </p>
        )}
      </Card>

      <Card title="Conflicts" actions={conflicts.data && conflicts.data.length > 0 && <Button onClick={() => run('ack', async () => { await call('sync', 'ackConflicts', {}); return 'Marked as reviewed' })}>Mark all reviewed</Button>}>
        <Table<Conflict>
          rows={conflicts.data ?? []}
          rowKey={(r) => r.id}
          empty={<EmptyState title="No conflicts" hint="When two terminals change the same thing, the newest edit wins and the loser is listed here." />}
          columns={[
            { key: 'ts', header: 'When', render: (r) => fmtTime(r.ts) },
            { key: 'kind', header: 'What happened', render: (r) => KIND[r.kind] ?? r.kind },
            { key: 'entity', header: 'Record', render: (r) => <span title={r.entity_uuid}>{r.entity}</span> },
            { key: 'resolution', header: 'Result' },
            { key: 'a', header: '', align: 'right', render: (r) => <Button variant="ghost" onClick={() => run(`a${r.id}`, async () => { await call('sync', 'ackConflicts', { ids: [r.id] }) })}>Reviewed</Button> }
          ]}
        />
      </Card>

      <Card title="Terminals">
        <Table<Device>
          rows={devices.data ?? []}
          rowKey={(d) => d.device}
          columns={[
            { key: 'code', header: 'Terminal', render: (d) => <>{d.code} {d.local && <Badge tone="good">this PC</Badge>}</> },
            { key: 'name', header: 'Name' },
            { key: 'lastSeen', header: 'Last heard from', render: (d) => (d.local ? 'now' : ago(d.lastSeen)) },
            { key: 'changesIn', header: 'Changes received', align: 'right', render: (d) => (d.local ? '—' : d.changesIn) }
          ]}
        />
      </Card>
    </div>
  )
}

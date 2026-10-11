import { useEffect, useState, type CSSProperties } from 'react'
import { call, errMsg } from '@/lib/api'
import { useSession } from '@/lib/session'
import { useLiveRefresh } from '@/lib/live'
import { Badge, Button, Card, EmptyState, ErrorState, Field, InlineAlert, Input, RadioGroup, Select, Spinner, Table, useAsync, useInterval, useToast } from '@/ui'
import { ago, fmtTime } from './format'

type Role = 'standalone' | 'admin' | 'client'
interface LanAddress { name: string; address: string; linkLocal: boolean }
interface LanClient { device: string; code: string; name: string; address: string; lastSeenAt: number | null; connected: boolean }
interface Lan {
  role: Role; port: number; listening: boolean; problem: string | null; addresses: LanAddress[]; discovery: boolean
  clients: LanClient[]; adminAddress: string; adminName: string; adminCode: string
}
interface Status {
  enabled: boolean; role: Role; transport: 'http' | 'folder'; configured: boolean; online: boolean | null
  pending: number; failed: number; rejected: number; deferred: number; openConflicts: number
  lastSyncAt: number | null; lastError: string | null; errorKind: 'auth' | 'identity' | 'network' | null; backoffUntil: number | null; running: boolean
  device: { uuid: string; code: string; name: string }
  lan: Lan; warnings: string[]; sharedSettings: string[]; localSettings: { pattern: string; why: string }[]
}
interface Config { role: Role; enabled: boolean; transport: 'http' | 'folder'; url: string; folder: string; hasKey: boolean; intervalSec: number; port: number; address: string }
interface Conflict { id: number; ts: number; kind: string; entity: string; entity_uuid: string; device: string; resolution: string; acknowledged: number }
interface Device { device: string; code: string; name: string; local: boolean; lastSeen: number | null; changesIn: number }
interface Found { address: string; port: number; name: string; code: string; host: string; label: string }
interface TestResult { ok: boolean; detail?: string; error?: string; warning?: string }

const DEFAULT_PORT = 8787
const KIND: Record<string, string> = {
  lww_lost_local: 'Your edit was replaced by a newer one', lww_lost_remote: 'A newer local edit was kept',
  duplicate_key: 'Same record created twice (merged)', number_collision: 'Duplicate document number (kept both)',
  apply_error: 'Could not apply a change', unresolved_ref: 'Related record never arrived', version_collision: 'Profile version clash'
}
const ROLE_LABEL: Record<Role, string> = { standalone: 'Not linked', admin: 'Admin system', client: 'Client system' }
const big: CSSProperties = { fontSize: 26, fontWeight: 700, letterSpacing: 2, fontFamily: 'ui-monospace, Consolas, monospace', userSelect: 'all' }

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
  const [busy, setBusy] = useState<string | null>(null)
  const [role, setRole] = useState<Role | null>(null) // what is selected on screen (null = what is saved)

  // live status while the tab is open: paused while the window is hidden, never overlapping
  useInterval(st.reload, 5_000)
  useLiveRefresh(['sync'], () => { conflicts.reload(); devices.reload() })

  if ((st.loading && !st.data) || (cfg.loading && !cfg.data)) return <Spinner />
  if (st.error || !st.data) return <ErrorState message={st.error ?? 'Could not load sync status'} onRetry={st.reload} />
  if (cfg.error || !cfg.data) return <ErrorState message={cfg.error ?? 'Could not load sync settings'} onRetry={cfg.reload} />
  const s = st.data
  const c = cfg.data
  const shown = role ?? c.role
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
  const save = (key: string, patch: Record<string, unknown>, done: string) => run(key, async () => { await call('sync', 'saveConfig', patch); setRole(null); return done })

  const linked = s.role === 'admin'
    ? (s.lan.listening ? <Badge tone="good">Sharing is on</Badge> : <Badge tone="bad">Sharing is not running</Badge>)
    : !s.enabled ? <Badge>Not linked</Badge>
    : s.online === false ? <Badge tone="bad">{s.role === 'client' ? 'Admin system not reachable' : 'Offline'}</Badge>
    : s.online ? <Badge tone="good">{s.role === 'client' ? 'Connected to the Admin system' : 'Online'}</Badge>
    : <Badge tone="warn">Not connected yet</Badge>

  return (
    <div className="col" style={{ gap: 16 }}>
      <Card title="Link two computers">
        <p className="muted" style={{ marginTop: 0 }}>
          Join the two computers with a LAN cable (no internet needed). One of them is the <strong>Admin system</strong>: products, prices and shop settings
          changed there appear on the other within a few seconds. Billing works on both even when the cable is unplugged; everything catches up when it is back.
        </p>
        <RadioGroup<Role>
          name="sync-role" label="This computer is" inline={false} value={shown}
          onChange={(v) => canConfigure && setRole(v)}
          options={[
            { value: 'admin', label: <span><strong>This is the Admin system</strong> <span className="muted">— the main computer; prices and settings are decided here</span></span>, disabled: !canConfigure },
            { value: 'client', label: <span><strong>This is a Client system</strong> <span className="muted">— a second counter that follows the Admin system</span></span>, disabled: !canConfigure },
            { value: 'standalone', label: <span><strong>Not linked</strong> <span className="muted">— a single computer on its own</span></span>, disabled: !canConfigure }
          ]}
        />
        {!canConfigure && <p className="muted">Only users with the “Configure and run sync” permission can change this.</p>}
        <div style={{ marginTop: 12 }}>
          {shown === 'admin' && <AdminSetup status={s} config={c} canConfigure={canConfigure} busy={busy} run={run} save={save} />}
          {shown === 'client' && <ClientSetup status={s} config={c} canConfigure={canConfigure} busy={busy} run={run} save={save} />}
          {shown === 'standalone' && (
            <>
              {c.role !== 'standalone' && canConfigure && (
                <InlineAlert tone="warn" title={`This computer is currently the ${ROLE_LABEL[c.role]}.`} action={
                  <Button variant="danger" disabled={busy === 'role'} onClick={() => {
                    if (window.confirm(c.role === 'admin'
                      ? 'Stop being the Admin system? The Client system will no longer receive price and settings changes from this computer.'
                      : 'Unlink this computer from the Admin system? It keeps all its data but stops receiving changes.')) void save('role', { role: 'standalone' }, 'This computer is no longer linked')
                  }}>Unlink this computer</Button>
                }>Unlinking keeps every bill, product and setting that is on this computer.</InlineAlert>
              )}
              <LegacySetup status={s} config={c} canConfigure={canConfigure} busy={busy} run={run} />
            </>
          )}
        </div>
      </Card>

      {s.warnings.map((w) => <InlineAlert key={w} tone="warn" title="Please check">{w}</InlineAlert>)}

      <Card title="Sync status" actions={
        <Button variant="primary" disabled={!s.enabled || busy === 'sync' || s.running} onClick={() => run('sync', async () => {
          const r = await call<{ ok: boolean; pushed: number; received: number; error?: string; skipped?: string }>('sync', 'syncNow')
          if (!r.ok) throw new Error(r.error ?? r.skipped ?? 'Sync failed')
          return `Sent ${r.pushed}, received ${r.received}`
        })}>{busy === 'sync' || s.running ? 'Syncing…' : 'Sync now'}</Button>
      }>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
          <Badge tone={s.role === 'standalone' ? 'neutral' : 'info'}>{ROLE_LABEL[s.role]}</Badge>
          {linked}
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
        {s.lastError && (
          <p role="alert" style={{ color: 'var(--bad)' }}>
            {s.lastError}
            {s.role !== 'standalone'
              ? (s.errorKind === 'network' ? ' Trying again by itself every few seconds.' : '')
              : s.backoffUntil && s.backoffUntil > Date.now() ? ` — retrying automatically after ${fmtTime(s.backoffUntil)}` : ''}
          </p>
        )}
        {(s.failed > 0 || s.rejected > 0) && <Button onClick={() => run('retry', async () => { await call('sync', 'retryFailed'); return 'Queued for retry' })}>Retry failed items</Button>}
        {canConfigure && s.enabled && (
          <p>
            <Button disabled={busy === 'resync'} onClick={() => {
              if (window.confirm('Re-send ALL products, customers, sales and stock history to the other computer? Safe to repeat, but can take a while.')) {
                void run('resync', async () => { const r = await call<{ queued: number }>('sync', 'resyncAll'); return `Queued ${r.queued} records` })
              }
            }}>Send all existing data again</Button>
          </p>
        )}
      </Card>

      {s.role !== 'standalone' && (
        <Card title="What is shared and what stays on each computer">
          <p style={{ marginTop: 0 }}>
            <strong>Decided on the Admin system, the same on every computer:</strong> products, prices, categories, brands, shop details and logo,
            receipt / invoice / label templates, and these settings: {s.sharedSettings.join('; ')}.
            {s.role === 'client' && ' If one of them is changed on this computer, the Admin system’s value is put back.'}
          </p>
          <p><strong>Flows both ways:</strong> bills, returns, purchases, stock changes, customers, suppliers.</p>
          <p style={{ marginBottom: 4 }}><strong>Stays on each computer:</strong></p>
          <ul style={{ marginTop: 0 }}>{s.localSettings.map((l) => <li key={l.pattern}><span className="muted">{l.why}</span></li>)}</ul>
        </Card>
      )}

      <Card title="Conflicts" actions={conflicts.data && conflicts.data.length > 0 && <Button onClick={() => run('ack', async () => { await call('sync', 'ackConflicts', {}); return 'Marked as reviewed' })}>Mark all reviewed</Button>}>
        <Table<Conflict>
          rows={conflicts.data ?? []}
          rowKey={(r) => r.id}
          empty={<EmptyState title="No conflicts" hint="When both computers change the same thing, one edit wins and the other is listed here." />}
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

interface SetupProps {
  status: Status; config: Config; canConfigure: boolean; busy: string | null
  run: (key: string, fn: () => Promise<string | void>) => Promise<void>
  save: (key: string, patch: Record<string, unknown>, done: string) => Promise<void>
}

// ---------------------------------------------------------------------------------------------------------------------
function AdminSetup({ status: s, config: c, canConfigure, busy, run, save }: SetupProps) {
  const isAdmin = c.role === 'admin'
  const [port, setPort] = useState(String(c.port || DEFAULT_PORT))
  const code = useAsync(() => (isAdmin && canConfigure ? call<{ code: string }>('sync', 'getPairingCode') : Promise.resolve({ code: '' })), [isAdmin, canConfigure, s.lan.listening])
  useEffect(() => { setPort(String(c.port || DEFAULT_PORT)) }, [c.port])
  const portNo = Number(port)
  const portOk = Number.isInteger(portNo) && portNo >= 1024 && portNo <= 65535

  if (!isAdmin) {
    return (
      <>
        <p>
          Choose this on the main computer. Velmayil v4 will then share its data over the LAN cable by itself; there is nothing else to install or start.
          {c.role === 'client' && ' This computer is currently a Client system; it will stop following the other computer.'}
        </p>
        <InlineAlert tone="info" title="Windows may ask for permission">
          The first time, Windows Firewall can show “Allow Velmayil v4 to communicate on these networks?”. Tick <strong>both</strong> Private and Public
          networks and choose <strong>Allow access</strong>, otherwise the other computer cannot connect.
        </InlineAlert>
        <Button variant="primary" disabled={!canConfigure || busy === 'role'} onClick={() => save('role', { role: 'admin' }, 'This computer is now the Admin system')}>Make this the Admin system</Button>
      </>
    )
  }
  const lan = s.lan
  const cabled = lan.addresses
  return (
    <>
      {lan.problem
        ? <InlineAlert tone="bad" title="The other computer cannot connect yet">{lan.problem}</InlineAlert>
        : !lan.listening
          ? <InlineAlert tone="warn" title="Starting…">Sharing is being switched on.</InlineAlert>
          : cabled.length === 0
            ? <InlineAlert tone="warn" title="No network connection yet">Plug the LAN cable into both computers. Windows can take up to a minute to give the connection an address; it will appear here.</InlineAlert>
            : <InlineAlert tone="good" title="Sharing is on">On the Client system, open Backup &amp; Sync, choose “This is a Client system” and type the two things below.</InlineAlert>}

      <div className="form-grid">
        <div>
          <div className="muted">Address of this computer</div>
          {cabled.length === 0 && <div style={big}>—</div>}
          {cabled.map((a) => (
            <div key={a.address}>
              <span style={big}>{a.address}{lan.port !== DEFAULT_PORT ? `:${lan.port}` : ''}</span>{' '}
              <span className="muted">{a.name}{a.linkLocal ? ' (direct cable)' : ''}</span>
            </div>
          ))}
          {cabled.length > 1 && <p className="muted">More than one address is shown because this computer has more than one network connection. Use the one of the cable that joins the two computers (usually “Ethernet”); “Find the Admin system” on the Client picks the right one by itself.</p>}
        </div>
        <div>
          <div className="muted">Pairing code</div>
          <div style={big}>{canConfigure ? code.data?.code || '…' : 'hidden'}</div>
          {canConfigure && (
            <Button variant="ghost" disabled={busy === 'code'} onClick={() => {
              if (window.confirm('Make a new pairing code? The Client system stops syncing until the new code is typed there.')) void save('code', { newPairingCode: true }, 'New pairing code created').then(code.reload)
            }}>Make a new code</Button>
          )}
        </div>
      </div>

      <h4 style={{ marginBottom: 4 }}>Client systems</h4>
      {lan.clients.length === 0
        ? (
          <p className="muted">
            None has connected yet. If the Client says it cannot reach this computer: check the cable, then on <em>this</em> computer open Windows Security →
            Firewall &amp; network protection → “Allow an app through firewall” and make sure <strong>Velmayil v4</strong> is ticked for both Private and Public.
          </p>
          )
        : (
          <ul style={{ marginTop: 0 }}>
            {lan.clients.map((cl) => (
              <li key={cl.device}>
                <strong>{cl.code || 'Client'}</strong> {cl.name && `(${cl.name})`} {cl.address && <span className="muted">at {cl.address}</span>}{' '}
                {cl.connected ? <Badge tone="good">connected</Badge> : <Badge tone="warn">last seen {ago(cl.lastSeenAt)}</Badge>}
              </li>
            ))}
          </ul>
          )}

      {canConfigure && (
        <details>
          <summary className="muted">Advanced: port number</summary>
          <div className="row" style={{ gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <Field label="Port" hint={`Normally ${DEFAULT_PORT}. Change it only if this screen says the port is already in use.`} error={portOk ? undefined : 'A number from 1024 to 65535'}>
              <Input type="number" min={1024} max={65535} value={port} onChange={(e) => setPort(e.target.value)} style={{ width: 120 }} />
            </Field>
            <Button disabled={!portOk || portNo === c.port || busy === 'port'} onClick={() => save('port', { port: portNo }, 'Port changed. Use the same number on the Client system.')}>Use this port</Button>
            <Button disabled={busy === 'test'} onClick={() => run('test', async () => {
              const r = await call<TestResult>('sync', 'testConnection')
              if (!r.ok) throw new Error(r.error)
              return r.detail
            })}>Check sharing</Button>
          </div>
        </details>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------------------------------------------------
function ClientSetup({ status: s, config: c, canConfigure, busy, run, save }: SetupProps) {
  const isClient = c.role === 'client'
  const [address, setAddress] = useState(isClient ? c.address.replace(new RegExp(`:${DEFAULT_PORT}$`), '') : '')
  const [code, setCode] = useState('')
  const [found, setFound] = useState<Found[] | null>(null)
  const [result, setResult] = useState<TestResult | null>(null)
  const [working, setWorking] = useState<'find' | 'test' | null>(null)
  const typed = { address: address.trim(), ...(code.trim() ? { pairingCode: code.trim() } : {}) }
  const ready = !!address.trim() && (!!code.trim() || (isClient && c.hasKey))

  const find = async () => {
    setWorking('find'); setResult(null)
    try {
      const list = await call<Found[]>('sync', 'discover')
      setFound(list)
      if (list.length === 1) setAddress(list[0].label)
    } catch (e) {
      setFound([]); setResult({ ok: false, error: errMsg(e) })
    } finally {
      setWorking(null)
    }
  }
  const test = async () => {
    setWorking('test'); setResult(null)
    try {
      setResult(await call<TestResult>('sync', 'testConnection', typed))
    } catch (e) {
      setResult({ ok: false, error: errMsg(e) })
    } finally {
      setWorking(null)
    }
  }

  return (
    <>
      {isClient
        ? (s.online
            ? <InlineAlert tone="good" title={`Connected to the Admin system${s.lan.adminCode ? ` ${s.lan.adminCode}` : ''}`}>Prices and settings changed there appear here within a few seconds. Address: {s.lan.adminAddress}</InlineAlert>
            : s.online === false
              ? <InlineAlert tone={s.errorKind === 'network' ? 'warn' : 'bad'} title="Not connected to the Admin system">{s.lastError ?? 'Trying to connect…'} You can keep billing; it reconnects by itself.</InlineAlert>
              : <InlineAlert tone="info" title="Connecting…">Looking for the Admin system at {s.lan.adminAddress}.</InlineAlert>)
        : <p>Choose this on the second computer. You need the <strong>address</strong> and the <strong>pairing code</strong> shown on the Admin system (Backup &amp; Sync on that computer).{c.role === 'admin' && ' This computer is currently the Admin system; it will stop sharing.'}</p>}

      <div className="form-grid">
        <Field label="Address of the Admin system" hint="The numbers shown on the Admin system, for example 192.168.1.10">
          <Input disabled={!canConfigure} value={address} placeholder="192.168.1.10" autoComplete="off" spellCheck={false} onChange={(e) => { setAddress(e.target.value); setResult(null) }} />
        </Field>
        <Field label="Pairing code" hint={isClient && c.hasKey ? 'A code is saved. Type a new one only if the Admin system made a new code.' : 'Shown on the Admin system, looks like ABCD-EFGH'}>
          <Input disabled={!canConfigure} value={code} placeholder="ABCD-EFGH" autoComplete="off" spellCheck={false} style={{ textTransform: 'uppercase', letterSpacing: 1 }} onChange={(e) => { setCode(e.target.value); setResult(null) }} />
        </Field>
      </div>

      {found && found.length === 0 && (
        <InlineAlert tone="warn" title="No Admin system answered">
          Check that the cable is plugged in at both ends, that Velmayil v4 is open on the other computer and set as the Admin system, and that Windows Firewall
          there allows Velmayil v4. You can also type the address shown on the Admin system by hand.
        </InlineAlert>
      )}
      {found && found.length > 1 && (
        <Field label="Admin systems found">
          <Select value={address} onChange={(e) => setAddress(e.target.value)}>
            <option value="">Choose…</option>
            {found.map((f) => <option key={f.label} value={f.label}>{f.code} {f.name} — {f.label}{f.host ? ` (${f.host})` : ''}</option>)}
          </Select>
        </Field>
      )}
      {found && found.length === 1 && <InlineAlert tone="good" title="Found the Admin system">{found[0].code} {found[0].name} at {found[0].label}{found[0].host ? ` (computer name ${found[0].host})` : ''}. Now type its pairing code.</InlineAlert>}
      {result && (result.ok
        ? <InlineAlert tone={result.warning ? 'warn' : 'good'} title={result.detail ?? 'Connection works'}>{result.warning}</InlineAlert>
        : <InlineAlert tone="bad" title="Could not connect">{result.error}</InlineAlert>)}

      {canConfigure && (
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <Button disabled={working !== null} onClick={find}>{working === 'find' ? 'Looking…' : 'Find the Admin system'}</Button>
          <Button disabled={!address.trim() || working !== null} onClick={test}>{working === 'test' ? 'Testing…' : 'Test connection'}</Button>
          <Button variant="primary" disabled={!ready || busy === 'role'} onClick={() => {
            if (c.role === 'admin' && !window.confirm('This computer is the Admin system now. Make it a Client system instead?')) return
            void run('role', async () => {
              const r = await call<TestResult>('sync', 'testConnection', typed)
              setResult(r)
              if (!r.ok && !window.confirm(`${r.error}\n\nSave anyway? This computer will keep trying to connect.`)) return
              await call('sync', 'saveConfig', { role: 'client', ...typed })
              setCode('')
              return r.ok ? 'Linked to the Admin system' : 'Saved. Will connect when the Admin system can be reached.'
            })
          }}>{isClient ? 'Save' : 'Link to the Admin system'}</Button>
        </div>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------------------------------------------------
/** The older ways to connect several terminals (a separately run sync server, or a shared folder). */
function LegacySetup({ status: s, config: cfg, canConfigure, busy, run }: Omit<SetupProps, 'save'>) {
  const [draft, setDraft] = useState<Partial<Config> & { key?: string }>({})
  const c = { ...cfg, ...draft }
  if (cfg.role !== 'standalone') return null
  return (
    <details open={s.enabled}>
      <summary className="muted">Advanced: other ways to connect (separate sync server or shared folder)</summary>
      <div className="form-grid" style={{ marginTop: 8 }}>
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
        <span className="row" style={{ gap: 8 }}>
          <Button disabled={busy === 'test'} onClick={() => run('test', async () => {
            if (Object.keys(draft).length) throw new Error('Save the settings first, then test the connection')
            const r = await call<TestResult>('sync', 'testConnection')
            if (!r.ok) throw new Error(r.error)
            return 'Connection works' + (r.detail ? ` (${r.detail})` : '')
          })}>Test connection</Button>
          <Button variant="primary" disabled={!Object.keys(draft).length} onClick={() => run('save', async () => { await call('sync', 'saveConfig', draft); setDraft({}); return 'Sync settings saved' })}>Save</Button>
        </span>
      )}
    </details>
  )
}

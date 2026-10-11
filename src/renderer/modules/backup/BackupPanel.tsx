import { useState } from 'react'
import { call, errMsg } from '@/lib/api'
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, Modal, Spinner, Table, useAsync, useConfirm, useToast } from '@/ui'
import { fmtSize, fmtTime } from './format'

export interface BackupRow {
  id: number; path: string; sizeBytes: number; kind: string; verified: boolean; verifiedAt: number | null
  createdAt: number; exists: boolean; note: string | null
}
interface Settings { autoEnabled: boolean; intervalHours: number; retention: number; folder: string; copyFolder: string; onClose: boolean }
interface Status {
  settings: Settings; defaultFolder: string; lastBackupAt: number | null; due: boolean; lastError: string | null
  backups: BackupRow[]; untracked: { path: string; createdAt: number | null; sizeBytes: number | null }[]
}

const KIND: Record<string, string> = { manual: 'Manual', auto: 'Automatic', safety: 'Safety (pre-restore)', close: 'On exit' }
const CONFIRM_WORD = 'RESTORE'

export function BackupPanel() {
  const toast = useToast()
  const confirm = useConfirm()
  const { data, loading, error, reload } = useAsync(() => call<Status>('backup', 'status'), [])
  const [busy, setBusy] = useState<string | null>(null)
  const [restoreTarget, setRestoreTarget] = useState<{ id?: number; path?: string; label: string } | null>(null)
  const [draft, setDraft] = useState<Partial<Settings>>({})
  const [manualPath, setManualPath] = useState('')

  if (loading && !data) return <Spinner />
  if (error || !data) return <ErrorState message={error ?? 'Could not load backups'} onRetry={reload} />
  const s = { ...data.settings, ...draft }
  const dirty = Object.keys(draft).length > 0

  const run = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    if (busy) return // one backup action at a time (a double click must not start two)
    setBusy(key)
    try {
      await fn()
      toast(ok, 'good')
      reload()
    } catch (e) {
      toast(errMsg(e), 'bad')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="col" style={{ gap: 16 }}>
      <Card
        title="Backups"
        actions={<Button variant="primary" disabled={!!busy} onClick={() => run('create', () => call('backup', 'create', {}), 'Backup created and verified')}>{busy === 'create' ? 'Backing up…' : 'Back up now'}</Button>}
      >
        <p className="muted">
          Last successful backup: <strong>{fmtTime(data.lastBackupAt)}</strong>{' '}
          {data.due && s.autoEnabled && <Badge tone="warn">Overdue</Badge>}
          {!s.autoEnabled && <Badge tone="warn">Automatic backups are off</Badge>}
        </p>
        {data.lastError && <p role="alert" style={{ color: 'var(--bad)' }}>Last automatic backup failed: {data.lastError}</p>}
        <Table<BackupRow>
          rows={data.backups}
          rowKey={(b) => b.id}
          empty={<EmptyState title="No backups yet" hint="Press “Back up now” to create the first one." />}
          columns={[
            { key: 'createdAt', header: 'Created', render: (b) => fmtTime(b.createdAt) },
            { key: 'kind', header: 'Type', render: (b) => KIND[b.kind] ?? b.kind },
            { key: 'sizeBytes', header: 'Size', align: 'right', render: (b) => fmtSize(b.sizeBytes) },
            {
              key: 'verified', header: 'Status',
              render: (b) => !b.exists ? <Badge tone="bad">File missing</Badge> : b.verified ? <Badge tone="good">Verified {b.verifiedAt ? fmtTime(b.verifiedAt) : ''}</Badge> : <Badge tone="warn">Not verified</Badge>
            },
            { key: 'path', header: 'File', render: (b) => <span className="muted" title={b.path} style={{ wordBreak: 'break-all' }}>{b.path}</span> },
            {
              key: 'actions', header: '', align: 'right',
              render: (b) => (
                <span className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                  <Button disabled={!b.exists || busy === `v${b.id}`} onClick={() => run(`v${b.id}`, async () => {
                    const r = await call<{ ok: boolean; problems: string[] }>('backup', 'verify', { id: b.id })
                    if (!r.ok) throw new Error('Verification FAILED: ' + r.problems.join('; '))
                  }, 'Backup verified: integrity, checksum and row counts match')}>Verify</Button>
                  <Button variant="danger" disabled={!b.exists} onClick={() => setRestoreTarget({ id: b.id, label: `${KIND[b.kind] ?? b.kind} backup from ${fmtTime(b.createdAt)}` })}>Restore…</Button>
                  <Button variant="ghost" disabled={!!busy} onClick={async () => {
                    if (await confirm({ title: 'Delete backup', message: `Delete the ${(KIND[b.kind] ?? b.kind).toLowerCase()} backup from ${fmtTime(b.createdAt)} permanently? The file is removed from the disk.`, confirmLabel: 'Delete', tone: 'danger' })) void run(`d${b.id}`, () => call('backup', 'delete', { id: b.id }), 'Backup deleted')
                  }}>Delete</Button>
                </span>
              )
            }
          ]}
        />
      </Card>

      <Card title="Schedule & locations" actions={<>
        {dirty && <Button disabled={!!busy} onClick={() => setDraft({})}>Discard</Button>}
        <Button variant="primary" disabled={!dirty || !!busy} onClick={() => {
          for (const [label, v] of [['Back up every (hours)', s.intervalHours], ['Backups to keep', s.retention]] as const) {
            if (!Number.isInteger(v) || v < 1) { toast(`${label}: enter a whole number of at least 1`, 'bad'); return }
          }
          void run('save', async () => { await call('backup', 'saveSettings', draft); setDraft({}) }, 'Backup settings saved')
        }}>Save settings</Button>
      </>}>
        <div className="form-grid">
          <label className="check"><input type="checkbox" checked={s.autoEnabled} onChange={(e) => setDraft({ ...draft, autoEnabled: e.target.checked })} /> Automatic backups</label>
          <Field label="Back up every (hours)"><Input type="number" min={1} value={Number.isFinite(s.intervalHours) ? s.intervalHours : ''} onChange={(e) => setDraft({ ...draft, intervalHours: e.target.value === '' ? NaN : Number(e.target.value) })} /></Field>
          <Field label="Keep the newest automatic backups" hint="Older automatic backups are deleted. Manual and safety backups are kept."><Input type="number" min={1} value={Number.isFinite(s.retention) ? s.retention : ''} onChange={(e) => setDraft({ ...draft, retention: e.target.value === '' ? NaN : Number(e.target.value) })} /></Field>
          <Field label="Backup folder" hint={`Default: ${data.defaultFolder}`}><Input value={s.folder} onChange={(e) => setDraft({ ...draft, folder: e.target.value })} /></Field>
          <Field label="Second copy folder (optional)" hint="A USB drive, network share or OneDrive folder. Every backup is copied here too."><Input value={s.copyFolder} placeholder="E:\VelmayilBackups" onChange={(e) => setDraft({ ...draft, copyFolder: e.target.value })} /></Field>
          <label className="check"><input type="checkbox" checked={s.onClose} onChange={(e) => setDraft({ ...draft, onClose: e.target.checked })} /> Also back up when the app closes</label>
        </div>
      </Card>

      <Card title="Restore from a file">
        <p className="muted">Use this after re-installing or moving to a new computer. Paste the full path of a <code>.vbak</code> file (its <code>.vbak.json</code> manifest must be next to it).</p>
        <div className="row" style={{ gap: 8 }}>
          <Input style={{ flex: 1 }} placeholder="C:\Backups\velmayil-POS-01-20260101-120000-manual.vbak" value={manualPath} onChange={(e) => setManualPath(e.target.value)} />
          <Button variant="danger" disabled={!manualPath.trim()} onClick={() => setRestoreTarget({ path: manualPath.trim(), label: manualPath.trim() })}>Restore…</Button>
        </div>
        {data.untracked.length > 0 && (
          <>
            <h4>Backup files found in the folder that are not in the list</h4>
            <Table
              rows={data.untracked}
              rowKey={(u) => u.path}
              columns={[
                { key: 'path', header: 'File' },
                { key: 'createdAt', header: 'Created', render: (u) => fmtTime(u.createdAt) },
                { key: 'sizeBytes', header: 'Size', align: 'right', render: (u) => fmtSize(u.sizeBytes) },
                { key: 'a', header: '', align: 'right', render: (u) => <Button variant="danger" onClick={() => setRestoreTarget({ path: u.path, label: u.path })}>Restore…</Button> }
              ]}
            />
          </>
        )}
      </Card>

      {restoreTarget && <RestoreWizard target={restoreTarget} onClose={() => setRestoreTarget(null)} onDone={() => { setRestoreTarget(null); reload() }} />}
    </div>
  )
}

function RestoreWizard({ target, onClose, onDone }: { target: { id?: number; path?: string; label: string }; onClose: () => void; onDone: () => void }) {
  const [step, setStep] = useState<'check' | 'warn' | 'done'>('check')
  const [verify, setVerify] = useState<{ ok: boolean; problems: string[] } | null>(null)
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [result, setResult] = useState<{ safetyBackupPath: string; reloginRequired: boolean } | null>(null)

  const doVerify = async () => {
    setBusy(true); setErr(null)
    try {
      setVerify(await call<{ ok: boolean; problems: string[] }>('backup', 'verify', { id: target.id, path: target.path }))
    } catch (e) { setErr(errMsg(e)) } finally { setBusy(false) }
  }
  const doRestore = async () => {
    setBusy(true); setErr(null)
    try {
      setResult(await call('backup', 'restore', { id: target.id, path: target.path, confirm: typed }))
      setStep('done')
    } catch (e) { setErr(errMsg(e)) } finally { setBusy(false) }
  }

  return (
    <Modal title="Restore backup" open onClose={busy ? () => undefined : (step === 'done' ? () => { onDone(); window.location.reload() } : onClose)} wide
      footer={
        step === 'check' ? (<>
          <Button onClick={onClose}>Cancel</Button>
          {!verify && <Button variant="primary" disabled={busy} onClick={doVerify}>{busy ? 'Checking…' : '1. Check this backup'}</Button>}
          {verify?.ok && <Button variant="primary" onClick={() => setStep('warn')}>Continue</Button>}
        </>) : step === 'warn' ? (<>
          <Button onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="danger" disabled={busy || typed !== CONFIRM_WORD} onClick={doRestore}>{busy ? 'Restoring…' : 'Replace my data with this backup'}</Button>
        </>) : (<Button variant="primary" onClick={() => { onDone(); window.location.reload() }}>Close</Button>)
      }>
      <p><strong>{target.label}</strong></p>
      {step === 'check' && (
        <>
          <p>First the backup is checked: checksum, database integrity, relationships and row counts. Nothing is changed yet.</p>
          {verify && (verify.ok
            ? <p><Badge tone="good">Backup is intact</Badge></p>
            : <div role="alert"><Badge tone="bad">This backup is damaged or unsupported and cannot be restored</Badge><ul>{verify.problems.map((p) => <li key={p}>{p}</li>)}</ul></div>)}
        </>
      )}
      {step === 'warn' && (
        <>
          <div role="alert" style={{ border: '2px solid var(--bad)', borderRadius: 8, padding: 12, background: 'var(--bad-bg)' }}>
            <strong>WARNING: this replaces ALL current data on this computer.</strong>
            <ul>
              <li>Every sale, product, stock level and setting made after this backup will be gone from the live database.</li>
              <li>A safety backup of the current data is taken automatically first, so this can be undone.</li>
              <li>You may be signed out afterwards. Other terminals are not changed; sync may re-send newer data.</li>
              <li>Close other windows and do not switch the computer off during the restore.</li>
            </ul>
          </div>
          <Field label={`Type ${CONFIRM_WORD} to confirm`}><Input value={typed} autoFocus onChange={(e) => setTyped(e.target.value)} placeholder={CONFIRM_WORD} /></Field>
        </>
      )}
      {step === 'done' && result && (
        <>
          <p><Badge tone="good">Restore complete</Badge></p>
          <p className="muted">Your previous data was saved to:<br /><code>{result.safetyBackupPath}</code></p>
          <p>{result.reloginRequired ? 'The application reloads now and you will be asked to sign in again.' : 'The application reloads now so every screen shows the restored data.'}</p>
        </>
      )}
      {err && <p role="alert" style={{ color: 'var(--bad)' }}>{err}</p>}
    </Modal>
  )
}

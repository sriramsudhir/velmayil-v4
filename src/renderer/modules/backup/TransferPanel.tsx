import { useState } from 'react'
import { call, errMsg } from '@/lib/api'
import { Badge, Button, Card, Field, Input, Modal } from '@/ui'
import { fmtSize, fmtTime } from './format'

// "Export everything" on one laptop, "Import everything" on the other (main: modules/transfer).

interface SummaryRow { key: string; label: string; inFile: number; now?: number; ok?: boolean }
interface Terminal { uuid: string; code: string; name: string }
interface ExportResult { cancelled?: boolean; path?: string; sizeBytes?: number; createdAt?: number; summary?: SummaryRow[] }
interface Inspect {
  ok: boolean
  problems: string[]
  path: string
  file?: { sizeBytes: number; createdAt: number; appVersion: string; schemaVersion: number; source: { posCode: string; posName: string; shopName: string }; summary: SummaryRow[]; olderVersion: boolean }
  target: { setupComplete: boolean; shopName: string; terminal: Terminal | null; products: number; sales: number; users: number }
  sameDevice: boolean
}
interface ImportResult {
  source: { posCode: string; posName: string; shopName: string }
  terminal: Terminal
  identityCreated: boolean
  codeChangedFrom: string | null
  safetyBackupPath: string
  migrationsRun: number[]
  summary: SummaryRow[]
  verified: boolean
  printers: string[]
}

const CONFIRM_WORD = 'REPLACE'
/** The numbers an owner recognises; the technical ones stay available under "Show all". */
const MAIN_KEYS = ['products', 'variants', 'unitCodes', 'customers', 'users', 'settings', 'stockTotal']
const num = (n: number | undefined): string => (n == null ? '-' : n.toLocaleString('en-IN'))

function Counts({ rows, compare }: { rows: SummaryRow[]; compare?: boolean }) {
  const [all, setAll] = useState(false)
  const bad = rows.filter((r) => compare && r.ok === false)
  const view = all ? rows : rows.filter((r) => MAIN_KEYS.includes(r.key) || (compare && r.ok === false))
  return (
    <>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>What</th>
              <th style={{ textAlign: 'right' }}>In the file</th>
              {compare && <th style={{ textAlign: 'right' }}>On this laptop now</th>}
              {compare && <th>Check</th>}
            </tr>
          </thead>
          <tbody>
            {view.map((r) => (
              <tr key={r.key}>
                <td>{r.label}</td>
                <td style={{ textAlign: 'right' }}>{num(r.inFile)}</td>
                {compare && <td style={{ textAlign: 'right' }}>{num(r.now)}</td>}
                {compare && <td>{r.ok ? <Badge tone="good">Same</Badge> : <Badge tone="bad">Different</Badge>}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {compare && bad.length > 0 && <p role="alert" style={{ color: 'var(--bad)' }}>{bad.length} number(s) do not match the file. Do not start billing on this laptop; export again on the other laptop and import once more.</p>}
      <p><Button variant="ghost" size="sm" onClick={() => setAll(!all)}>{all ? 'Show fewer' : 'Show all numbers'}</Button></p>
    </>
  )
}

export function TransferPanel() {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [exported, setExported] = useState<ExportResult | null>(null)
  const [importing, setImporting] = useState(false)

  const doExport = async () => {
    if (busy) return
    setBusy(true); setErr(null)
    try {
      const r = await call<ExportResult>('transfer', 'export', {})
      if (!r.cancelled) setExported(r)
    } catch (e) { setErr(errMsg(e)) } finally { setBusy(false) }
  }

  return (
    <div className="col" style={{ gap: 16 }}>
      <Card title="Set up another laptop the same as this one">
        <p>Two steps. Nothing is sent over the internet: you carry one file on a USB drive.</p>
        <ol>
          <li><strong>On the laptop that has everything:</strong> press <em>Export everything</em> and save the file to a USB drive.</li>
          <li><strong>On the other laptop:</strong> install the app, plug in the USB drive, press <em>Import everything</em> and choose that file.</li>
        </ol>
        <p className="muted">
          The file holds all products, prices, categories, brands, barcodes, unit codes and their next numbers, stock, customers, bills,
          settings, print and label templates, shop profile and logo, users and roles. Each laptop keeps its own counter name, its own
          sync and backup-folder settings and its own scanner set-up.
        </p>
      </Card>

      <Card title="1. Export everything (on the laptop that has everything)" actions={<Button variant="primary" loading={busy} onClick={doExport}>{busy ? 'Exporting…' : 'Export everything'}</Button>}>
        <p className="muted">Makes one file. This laptop is not changed. Keep the file safe: it contains your whole shop, including the users' (scrambled) passwords.</p>
        {err && <p role="alert" style={{ color: 'var(--bad)' }}>{err}</p>}
        {exported?.path && (
          <>
            <p><Badge tone="good">File saved and checked</Badge></p>
            <p><code style={{ wordBreak: 'break-all' }}>{exported.path}</code> ({fmtSize(exported.sizeBytes)}, {fmtTime(exported.createdAt)})</p>
            <Counts rows={exported.summary ?? []} />
            <p>Now take this file to the other laptop and use <em>Import everything</em> there.</p>
          </>
        )}
      </Card>

      <Card title="2. Import everything (on the other laptop)" actions={<Button variant="danger" onClick={() => setImporting(true)}>Import everything…</Button>}>
        <p className="muted">
          Replaces <strong>all data on this laptop</strong> with the data in the file. A safety backup of this laptop is taken first.
          Only do this on the laptop you are setting up, never on the laptop that has your real data.
        </p>
      </Card>

      {importing && <ImportEverything onClose={() => setImporting(false)} onDone={() => window.location.reload()} />}
    </div>
  )
}

/** The import wizard. Also used by the first-time setup screen (no user is signed in there). */
export function ImportEverything({ onClose, onDone, firstRun }: { onClose: () => void; onDone: () => void; firstRun?: boolean }) {
  const [step, setStep] = useState<'pick' | 'review' | 'confirm' | 'done'>('pick')
  const [path, setPath] = useState('')
  const [typeIt, setTypeIt] = useState(false)
  const [info, setInfo] = useState<Inspect | null>(null)
  const [typed, setTyped] = useState('')
  const [replaceSales, setReplaceSales] = useState(false)
  const [sameLaptop, setSameLaptop] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [result, setResult] = useState<ImportResult | null>(null)

  const inspect = async (p: string) => {
    setBusy(true); setErr(null)
    try {
      const r = await call<Inspect>('transfer', 'inspect', { path: p })
      setPath(p); setInfo(r); setStep('review')
    } catch (e) { setErr(errMsg(e)) } finally { setBusy(false) }
  }
  const choose = async () => {
    setErr(null)
    try {
      const r = await call<{ path?: string; cancelled?: boolean; unavailable?: boolean }>('transfer', 'pickFile')
      if (r.unavailable) setTypeIt(true)
      else if (r.path) await inspect(r.path)
    } catch (e) { setErr(errMsg(e)) }
  }
  const run = async () => {
    setBusy(true); setErr(null)
    try {
      setResult(await call<ImportResult>('transfer', 'import', { path, confirm: typed.trim().toUpperCase(), replaceSales, sameLaptop: sameLaptop ?? undefined }))
      setStep('done')
    } catch (e) { setErr(errMsg(e)) } finally { setBusy(false) }
  }

  const t = info?.target
  const hasData = !!t && (t.products > 0 || t.sales > 0)
  const canRun = typed.trim().toUpperCase() === CONFIRM_WORD && (!t?.sales || replaceSales) && (!info?.sameDevice || sameLaptop !== null)

  return (
    <Modal title="Import everything from another laptop" open wide onClose={busy ? () => undefined : step === 'done' ? onDone : onClose}
      footer={
        step === 'pick' ? <Button onClick={onClose}>Cancel</Button>
        : step === 'review' ? (<>
          <Button onClick={onClose}>Cancel</Button>
          <Button onClick={() => { setInfo(null); setStep('pick') }}>Choose another file</Button>
          {info?.ok && <Button variant="primary" onClick={() => setStep('confirm')}>Continue</Button>}
        </>)
        : step === 'confirm' ? (<>
          <Button onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="danger" loading={busy} disabled={!canRun} onClick={run}>{busy ? 'Importing… do not switch off' : 'Replace this laptop\u2019s data'}</Button>
        </>)
        : <Button variant="primary" onClick={onDone}>Sign in</Button>
      }>
      {step === 'pick' && (
        <>
          <p>Plug in the USB drive with the file you made with <em>Export everything</em> on the other laptop (its name ends with <code>.vmove</code>).</p>
          <p><Button variant="primary" loading={busy} onClick={choose}>Choose the file…</Button></p>
          {typeIt && (
            <Field label="Full path of the file">
              <Input value={path} placeholder="E:\Velmayil-everything-POS-01-20260101-1200.vmove" onChange={(e) => setPath(e.target.value)} />
            </Field>
          )}
          {typeIt && <p><Button disabled={!path.trim() || busy} onClick={() => inspect(path.trim())}>Check this file</Button></p>}
          <p className="muted">Nothing is changed until you confirm on the next screens.</p>
        </>
      )}

      {step === 'review' && info && (
        <>
          <p className="muted" style={{ wordBreak: 'break-all' }}>{info.path}</p>
          {!info.ok && (
            <div role="alert">
              <p><Badge tone="bad">This file cannot be imported</Badge></p>
              <ul>{info.problems.map((p) => <li key={p}>{p}</li>)}</ul>
            </div>
          )}
          {info.file && info.ok && (
            <>
              <p><Badge tone="good">The file is complete and undamaged</Badge></p>
              <p>
                From <strong>{info.file.source.shopName || 'the shop'}</strong>, counter <strong>{info.file.source.posCode}</strong> ({info.file.source.posName}),
                exported {fmtTime(info.file.createdAt)}, {fmtSize(info.file.sizeBytes)}.
              </p>
              {info.file.olderVersion && <p className="muted">The file comes from an older version of the app ({info.file.appVersion}). Its data is brought up to date during the import.</p>}
              <Counts rows={info.file.summary} />
            </>
          )}
        </>
      )}

      {step === 'confirm' && info && t && (
        <>
          <div role="alert" style={{ border: '2px solid var(--bad)', borderRadius: 8, padding: 12, background: 'var(--bad-bg)' }}>
            <strong>{hasData ? 'WARNING: everything on this laptop will be replaced.' : 'This laptop will be filled with the data from the file.'}</strong>
            <ul>
              {hasData && <li>This laptop now has <strong>{num(t.products)} product(s)</strong> and <strong>{num(t.sales)} bill(s)</strong>{t.shopName ? <> of “{t.shopName}”</> : null}. After the import they are gone from here and the data of “{info.file?.source.shopName}” is here instead.</li>}
              {t.sales > 0 && <li><strong>Bills made on this laptop that are not on the other laptop will be lost.</strong> If this is the laptop with your real sales, press Cancel: you are on the wrong laptop.</li>}
              <li>The other laptop is not changed.</li>
              {t.setupComplete && <li>A safety backup of this laptop is taken automatically first, so this can be undone under Backup &amp; Restore.</li>}
              <li>If anything goes wrong, nothing is changed. Do not switch the laptop off while it runs.</li>
              <li>Afterwards you sign in with the user names and passwords of the other laptop.</li>
            </ul>
          </div>
          {info.sameDevice && (
            <Field label="This file was exported by a counter with the same identity as this laptop. Is this the very laptop the file was exported from?">
              <div className="col" style={{ gap: 4 }}>
                <label className="check"><input type="radio" name="same" checked={sameLaptop === false} onChange={() => setSameLaptop(false)} /> No, this is a different laptop (give it its own counter identity)</label>
                <label className="check"><input type="radio" name="same" checked={sameLaptop === true} onChange={() => setSameLaptop(true)} /> Yes, it is the same laptop</label>
              </div>
            </Field>
          )}
          {t.sales > 0 && (
            <label className="check" style={{ margin: '8px 0' }}>
              <input type="checkbox" checked={replaceSales} onChange={(e) => setReplaceSales(e.target.checked)} /> I understand that the {num(t.sales)} bill(s) on this laptop will be replaced
            </label>
          )}
          <Field label={`Type ${CONFIRM_WORD} to confirm`}><Input value={typed} autoFocus onChange={(e) => setTyped(e.target.value)} placeholder={CONFIRM_WORD} /></Field>
        </>
      )}

      {step === 'done' && result && (
        <>
          <p>{result.verified ? <Badge tone="good">Import complete and checked</Badge> : <Badge tone="bad">Import finished, but some numbers differ</Badge>}</p>
          <Counts rows={result.summary} compare />
          <p>
            This laptop is counter <strong>{result.terminal.code}</strong> ({result.terminal.name}).
            {result.codeChangedFrom && <> It was {result.codeChangedFrom} before; the other laptop uses that code, and every counter needs its own so bill numbers never clash.</>}
            {' '}You can rename it under Settings.
          </p>
          <ul>
            <li>Sign in with the user names and passwords of the other laptop.</li>
            <li>
              Printers: the printer set-up was copied{result.printers.length ? <> (it expects: {result.printers.join(', ')})</> : null}. If this laptop has a different printer, choose it under Printing &gt; Printers and print a test page.
            </li>
            <li>Scanner set-up, sync between counters and the backup folder are per laptop: set them here if you use them.</li>
            {!firstRun && <li className="muted" style={{ wordBreak: 'break-all' }}>The previous data of this laptop was saved to {result.safetyBackupPath}</li>}
          </ul>
        </>
      )}
      {err && <p role="alert" style={{ color: 'var(--bad)' }}>{err}</p>}
    </Modal>
  )
}

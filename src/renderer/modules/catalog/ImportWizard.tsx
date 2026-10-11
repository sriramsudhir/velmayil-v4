import { useState } from 'react'
import { Badge, Button, Modal, Select, Table, useToast } from '@/ui'
import { call, errMsg } from '@/lib/api'
import { downloadBase64, fileToBase64, type ImportPreview } from './types'

const FIELD_LABELS: [string, string, boolean][] = [
  ['name', 'Name', true], ['variant', 'Variant', false], ['sku', 'SKU', false], ['barcode', 'Barcode', false], ['aliases', 'Alias barcodes', false],
  ['category', 'Category (A > B)', false], ['brand', 'Brand', false], ['hsn', 'HSN', false], ['gst', 'GST %', false], ['unit', 'Unit', false],
  ['mrp', 'MRP', false], ['price', 'Price', false], ['cost', 'Cost', false], ['reorder', 'Reorder level', false],
  ['opening', 'Opening stock (new items)', false], ['active', 'Active', false], ['trackStock', 'Track stock', false], ['description', 'Description', false]
]

type Step = 'upload' | 'map' | 'preview' | 'done'
type FileArg = { bytesBase64: string; filename: string }

export function ImportWizard({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const toast = useToast()
  const [step, setStep] = useState<Step>('upload')
  const [file, setFile] = useState<FileArg | null>(null)
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [mapping, setMapping] = useState<Record<string, number | null>>({})
  const [mode, setMode] = useState<'all_or_nothing' | 'skip_bad_rows'>('all_or_nothing')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ created: number; updated: number; unchanged: number; skipped: number } | null>(null)

  const close = () => {
    setStep('upload'); setFile(null); setPreview(null); setMapping({}); setError(null); setResult(null); setMode('all_or_nothing')
    onClose()
  }

  const run = async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true); setError(null)
    try { return await fn() } catch (e) { setError(errMsg(e)); return undefined } finally { setBusy(false) }
  }

  const onFile = async (f: File | undefined) => {
    if (!f) return
    const arg = { bytesBase64: await fileToBase64(f), filename: f.name }
    setFile(arg)
    const p = await run(() => call<ImportPreview>('catalog', 'importPreview', arg))
    if (p) { setPreview(p); setMapping(p.mapping); setStep('map') }
  }

  const doPreview = async () => {
    if (!file) return
    const p = await run(() => call<ImportPreview>('catalog', 'importPreview', { ...file, mapping }))
    if (p) { setPreview(p); setStep('preview') }
  }

  const commit = async () => {
    if (!file) return
    const r = await run(() => call<{ created: number; updated: number; unchanged: number; skipped: number }>('catalog', 'importCommit', { ...file, mapping, mode }))
    if (r) { setResult(r); setStep('done'); onDone(); toast('Import complete', 'good') }
  }

  const template = async (format: 'csv' | 'xlsx') => {
    const r = await run(() => call<{ path?: string; cancelled?: boolean; bytesBase64?: string; filename: string; mime: string }>('catalog', 'templateFile', { format }))
    if (r && !r.cancelled) { downloadBase64(r); toast(r.path ? `Template saved to ${r.path}` : 'Template ready', 'good') }
  }

  const c = preview?.counts
  return (
    <Modal wide open={open} onClose={close} title={`Import products — ${{ upload: '1. Choose file', map: '2. Match columns', preview: '3. Review', done: '4. Done' }[step]}`}
      footer={
        <>
          {step !== 'done' && <Button onClick={close}>Cancel</Button>}
          {step === 'map' && <Button variant="primary" disabled={busy || mapping.name == null} onClick={() => void doPreview()}>Validate rows →</Button>}
          {step === 'preview' && <Button onClick={() => setStep('map')}>← Back</Button>}
          {step === 'preview' && (
            <Button variant="primary" disabled={busy || !preview?.canCommit || (mode === 'all_or_nothing' && (c?.invalid ?? 0) > 0)} onClick={() => void commit()}>
              {busy ? 'Importing…' : `Import ${mode === 'skip_bad_rows' ? (c?.total ?? 0) - (c?.invalid ?? 0) : c?.total ?? 0} rows`}
            </Button>
          )}
          {step === 'done' && <Button variant="primary" onClick={close}>Close</Button>}
        </>
      }
    >
      {error && <div className="field-error" role="alert" style={{ marginBottom: 8 }}>{error}</div>}
      {step === 'upload' && (
        <div>
          <p>Upload a <strong>.csv</strong> or <strong>.xlsx</strong> file. Items are matched by SKU, then barcode; existing items are updated, new ones created. Nothing is saved until you confirm.</p>
          <input type="file" accept=".csv,.xlsx,text/csv" onChange={(e) => void onFile(e.target.files?.[0])} disabled={busy} />
          <p className="muted" style={{ marginTop: 12 }}>Need a starting point?</p>
          <div className="row">
            <Button onClick={() => void template('xlsx')}>Download Excel template</Button>
            <Button onClick={() => void template('csv')}>Download CSV template</Button>
          </div>
        </div>
      )}
      {step === 'map' && preview && (
        <div>
          <p className="muted">File: {preview.filename} — {preview.counts.total} rows. We matched the columns automatically; fix anything that is wrong.</p>
          <div className="grid3">
            {FIELD_LABELS.map(([key, label, required]) => (
              <label key={key} className="field">
                <span className="field-label">{label}{required && ' *'}</span>
                <Select value={mapping[key] ?? ''} onChange={(e) => setMapping({ ...mapping, [key]: e.target.value === '' ? null : Number(e.target.value) })}>
                  <option value="">— skip —</option>
                  {preview.headers.map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
                </Select>
              </label>
            ))}
          </div>
          {preview.sample.length > 0 && (
            <div className="table-wrap" style={{ marginTop: 8, maxHeight: 140, overflow: 'auto' }}>
              <table className="table">
                <thead><tr>{preview.headers.map((h, i) => <th key={i}>{h}</th>)}</tr></thead>
                <tbody>{preview.sample.map((r, i) => <tr key={i}>{r.map((x, j) => <td key={j}>{x}</td>)}</tr>)}</tbody>
              </table>
            </div>
          )}
        </div>
      )}
      {step === 'preview' && preview && c && (
        <div>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
            <Badge tone="good">{c.creates} to create</Badge>
            <Badge>{c.updates} to update</Badge>
            <Badge>{c.unchanged} unchanged</Badge>
            <Badge tone={c.invalid ? 'bad' : 'neutral'}>{c.invalid} with errors</Badge>
            <Badge tone={c.warnings ? 'warn' : 'neutral'}>{c.warnings} with warnings</Badge>
            {c.newCategories > 0 && <Badge>{c.newCategories} new categories</Badge>}
            {c.newBrands > 0 && <Badge>{c.newBrands} new brands</Badge>}
          </div>
          {c.invalid > 0 && (
            <div className="row" style={{ gap: 16, marginBottom: 8 }}>
              <label><input type="radio" checked={mode === 'all_or_nothing'} onChange={() => setMode('all_or_nothing')} /> All or nothing (fix errors first)</label>
              <label><input type="radio" checked={mode === 'skip_bad_rows'} onChange={() => setMode('skip_bad_rows')} /> Skip rows with errors</label>
            </div>
          )}
          <Table
            rows={preview.issues} rowKey={(r) => r.rowNo} empty={<p className="muted">No problems found. Ready to import.</p>}
            columns={[
              { key: 'rowNo', header: 'Row', width: '56px' },
              { key: 'name', header: 'Name' },
              { key: 'sku', header: 'SKU' },
              { key: 'errors', header: 'Problems', render: (r) => <span>{r.errors.map((e, i) => <div key={i} style={{ color: 'var(--bad, #b00020)' }}>✕ {e}</div>)}{r.warnings.map((w, i) => <div key={i} style={{ color: 'var(--warn, #9a6700)' }}>⚠ {w}</div>)}</span> }
            ]}
          />
          {preview.issuesTruncated && <p className="muted">Showing the first 1,000 rows with problems.</p>}
        </div>
      )}
      {step === 'done' && result && (
        <p>
          Import finished: <strong>{result.created}</strong> created, <strong>{result.updated}</strong> updated, {result.unchanged} unchanged
          {result.skipped > 0 && <>, <strong>{result.skipped}</strong> skipped because of errors</>}.
        </p>
      )}
    </Modal>
  )
}

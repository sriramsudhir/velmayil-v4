import { useState } from 'react'
import { call } from '@/lib/api'
import { Button, Card, Field, InlineAlert, Select, useApiAction, useAsync } from '@/ui'
import { PrintPreview } from './PrintPreview'
import { PAPER_FOR_PRINTER_KIND, PRINTER_KIND_LABEL, type Paper, type PrinterProfile, type PrintResult } from './shared'

const PAPERS: { paper: Paper; label: string }[] = [
  { paper: '58', label: '58 mm receipt' },
  { paper: '80', label: '80 mm receipt' },
  { paper: 'A4', label: 'A4' },
  { paper: 'A5', label: 'A5' },
  { paper: 'label', label: 'Label' }
]

export function TestPrintTab() {
  const { run, loading } = useApiAction()
  const profiles = useAsync(() => call<PrinterProfile[]>('printing', 'listPrinterProfiles'), [])
  const [printerId, setPrinterId] = useState<number | ''>('')
  const [shown, setShown] = useState<{ paper: Paper; html: string; widthMm: number } | null>(null)
  const [result, setResult] = useState<{ paper: Paper; r: PrintResult } | null>(null)

  const preview = async (paper: Paper) => {
    const r = await run(() => call<{ html: string; widthMm: number }>('printing', 'testPrint', { paper, dryRun: true }))
    if (r) setShown({ paper, html: r.html, widthMm: r.widthMm })
  }
  const print = async (paper: Paper) => {
    const r = await run(() => call<PrintResult & { html: string; widthMm: number }>('printing', 'testPrint', { paper, ...(printerId ? { printerProfileId: printerId } : {}) }))
    if (r) { setResult({ paper, r }); setShown({ paper, html: r.html, widthMm: r.widthMm }) }
  }
  const list = profiles.data ?? []

  return (
    <div className="grid2" style={{ gridTemplateColumns: 'minmax(300px, 380px) 1fr', alignItems: 'start' }}>
      <Card title="Test print">
        <p className="muted" style={{ marginBottom: 10 }}>Prints your logo, shop name and address with a millimetre ruler, a darkness sample and a sample barcode. Use it to check paper size, margins, darkness and that barcodes scan, then adjust the printer under Printers.</p>
        <Field label="Printer profile">
          <Select value={printerId} onChange={(e) => setPrinterId(e.target.value ? Number(e.target.value) : '')}>
            <option value="">Default printer for the paper type</option>
            {list.map((p) => <option key={p.id} value={p.id}>{p.name} ({PRINTER_KIND_LABEL[p.kind]})</option>)}
          </Select>
        </Field>
        {printerId !== '' && (() => { const p = list.find((x) => x.id === printerId); return p ? <p className="muted">Uses paper type: {PRINTER_KIND_LABEL[p.kind]} ({PAPER_FOR_PRINTER_KIND[p.kind]})</p> : null })()}
        <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
          {PAPERS.map((p) => (
            <div key={p.paper} className="row">
              <Button variant="primary" onClick={() => void print(p.paper)} disabled={loading} style={{ flex: 1 }}>Print test: {p.label}</Button>
              <Button onClick={() => void preview(p.paper)} disabled={loading}>Preview</Button>
            </div>
          ))}
        </div>
        {result && (
          <div style={{ marginTop: 12 }}>
            {!result.r.ok ? <InlineAlert tone="bad" title="Test print failed">{result.r.error}. Check that the printer is switched on and has paper, or choose another printer profile.</InlineAlert>
              : result.r.warning ? <InlineAlert tone="warn" title="Printed on another printer">{result.r.warning}</InlineAlert>
              : <InlineAlert tone="good">Test page sent to the printer ({result.paper}).</InlineAlert>}
          </div>
        )}
      </Card>
      <Card title={shown ? `Test page: ${shown.paper}` : 'Preview'}>
        {shown ? <PrintPreview html={shown.html} widthMm={shown.widthMm} scale={shown.widthMm > 120 ? 0.6 : 1} maxHeight="75vh" /> : <p className="muted">Pick a paper size to preview its test page.</p>}
      </Card>
    </div>
  )
}

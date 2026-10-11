import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { call } from '@/lib/api'
import { useSession } from '@/lib/session'
import { Badge, Button, Card, EmptyState, ErrorState, Field, FormGrid, InlineAlert, Input, NumberInput, Select, Spinner, Toggle, useApiAction, useAsync, useConfirm, useDirtyGuard } from '@/ui'
import { PrintPreview } from './PrintPreview'
import type { PrintLook } from './previewDoc'
import { isInvoice, isLabel, isReport, REPORT_PREVIEW, type Config, type Paper, type PrintResult, type Rendered, type TemplateKind, type TemplateMeta, type TemplateRow } from './shared'

type Kind = 'num' | 'bool' | 'enum' | 'text' | 'area'
interface Spec { key: string; label: string; type: Kind; options?: [string, string][]; step?: number; min?: number; max?: number; hint?: string; only?: (k: TemplateKind) => boolean }
interface Group { title: string; specs: Spec[]; only?: (k: TemplateKind) => boolean }

const receipt = (k: TemplateKind) => k === 'receipt58' || k === 'receipt80'
const doc = (k: TemplateKind) => isInvoice(k)
const ALIGN: [string, string][] = [['left', 'Left'], ['center', 'Centre'], ['right', 'Right']]

const GROUPS: Group[] = [
  {
    title: 'Page & margins',
    specs: [
      { key: 'paperWidthMm', label: 'Paper width (mm)', type: 'num', step: 1, min: 20, max: 500 },
      { key: 'paperHeightMm', label: 'Paper height (mm, 0 = auto)', type: 'num', step: 1, min: 0, max: 1000, only: (k) => !receipt(k) },
      { key: 'marginTopMm', label: 'Top margin (mm)', type: 'num', step: 0.5, min: 0, max: 40 },
      { key: 'marginRightMm', label: 'Right margin (mm)', type: 'num', step: 0.5, min: 0, max: 40 },
      { key: 'marginBottomMm', label: 'Bottom margin (mm)', type: 'num', step: 0.5, min: 0, max: 40 },
      { key: 'marginLeftMm', label: 'Left margin (mm)', type: 'num', step: 0.5, min: 0, max: 40 },
      { key: 'landscape', label: 'Landscape', type: 'bool', only: isReport }
    ]
  },
  {
    title: 'Text & spacing',
    specs: [
      { key: 'fontSizePt', label: 'Font size (pt)', type: 'num', step: 0.5, min: 4, max: 40 },
      { key: 'lineHeight', label: 'Line spacing', type: 'num', step: 0.05, min: 0.9, max: 3 },
      { key: 'spacingMm', label: 'Section spacing (mm)', type: 'num', step: 0.5, min: 0, max: 20 },
      { key: 'fontFamily', label: 'Font', type: 'enum', options: [['sans', 'Sans-serif'], ['mono', 'Monospace'], ['serif', 'Serif']] }
    ]
  },
  {
    title: 'Logo',
    specs: [
      { key: 'logoEnabled', label: 'Print the logo', type: 'bool' },
      { key: 'logoWidthMm', label: 'Logo width (mm, 0 = follow Shop Profile)', type: 'num', step: 1, min: 0, max: 150, hint: 'Height follows the picture, so the logo is never stretched.' },
      { key: 'logoHeightMm', label: 'Logo height (mm, 0 = automatic)', type: 'num', step: 1, min: 0, max: 150 },
      { key: 'logoPosition', label: 'Logo position', type: 'enum', options: [['profile', 'As in Shop Profile'], ['top', 'Above the name'], ['inline-left', 'Left of the name'], ['inline-right', 'Right of the name']] },
      { key: 'logoAlign', label: 'Logo alignment', type: 'enum', options: [['profile', 'As in Shop Profile'], ...ALIGN] }
    ]
  },
  {
    title: 'Shop block',
    specs: [
      { key: 'showShopName', label: 'Shop name', type: 'bool' },
      { key: 'shopNameSizePt', label: 'Shop name size (pt)', type: 'num', step: 0.5, min: 4, max: 60 },
      { key: 'shopNameAlign', label: 'Shop name alignment', type: 'enum', options: ALIGN },
      { key: 'shopNameBold', label: 'Bold shop name', type: 'bool' },
      { key: 'showLegalName', label: 'Legal name', type: 'bool', only: (k) => !isLabel(k) && !isReport(k) },
      { key: 'showAddress', label: 'Address', type: 'bool', only: (k) => !isLabel(k) },
      { key: 'showPhone', label: 'Phone', type: 'bool', only: (k) => !isLabel(k) },
      { key: 'showEmail', label: 'Email', type: 'bool', only: doc },
      { key: 'showWebsite', label: 'Website', type: 'bool', only: doc },
      { key: 'showGstin', label: 'GSTIN', type: 'bool', only: (k) => !isLabel(k) },
      { key: 'showPan', label: 'PAN', type: 'bool', only: doc }
    ]
  },
  {
    title: 'Document body',
    only: doc,
    specs: [
      { key: 'showCustomer', label: 'Customer', type: 'bool' },
      { key: 'showCashier', label: 'Cashier', type: 'bool' },
      { key: 'showPos', label: 'Counter / POS name', type: 'bool' },
      { key: 'showHsn', label: 'HSN column', type: 'bool', only: (k) => k === 'invoiceA4' },
      { key: 'showDiscount', label: 'Discount', type: 'bool' },
      { key: 'showTaxSummary', label: 'Tax summary', type: 'bool' },
      { key: 'showPayment', label: 'Payment details', type: 'bool' },
      { key: 'showFooter', label: 'Footer', type: 'bool' },
      { key: 'footerText', label: 'Footer text (blank = Shop Profile footer)', type: 'area' },
      { key: 'terms', label: 'Terms & conditions', type: 'area', only: (k) => k === 'invoiceA4' || k === 'invoiceA5' }
    ]
  },
  {
    title: 'UPI QR code',
    only: (k) => k === 'receipt80',
    specs: [
      { key: 'qrEnabled', label: 'Print UPI QR code', type: 'bool' },
      { key: 'upiId', label: 'UPI ID', type: 'text', hint: 'The payee name on the QR is your shop display name.' },
      { key: 'upiLabel', label: 'Caption under the QR', type: 'text' }
    ]
  },
  {
    title: 'Label contents',
    only: isLabel,
    specs: [
      { key: 'showMrp', label: 'MRP', type: 'bool' },
      { key: 'showPrice', label: 'Selling price', type: 'bool' },
      { key: 'showSku', label: 'SKU', type: 'bool' },
      { key: 'showProductName', label: 'Product name', type: 'bool' },
      { key: 'showVariant', label: 'Variant', type: 'bool' },
      { key: 'showBarcodeText', label: 'Barcode number text', type: 'bool' },
      { key: 'nameMaxLines', label: 'Product name max lines', type: 'num', step: 1, min: 1, max: 4 },
      { key: 'labelWidthMm', label: 'Label width on a sheet (mm, 0 = paper)', type: 'num', step: 1, min: 0, max: 500 },
      { key: 'labelHeightMm', label: 'Label height on a sheet (mm, 0 = paper)', type: 'num', step: 1, min: 0, max: 500 },
      { key: 'sheetCols', label: 'Sheet columns (0 = one label per page)', type: 'num', step: 1, min: 0, max: 10 },
      { key: 'sheetRows', label: 'Sheet rows', type: 'num', step: 1, min: 0, max: 40 },
      { key: 'barcodeHeightMm', label: 'Barcode height (mm)', type: 'num', step: 0.5, min: 3, max: 40, hint: 'At least 6 mm scans reliably. The width is set automatically in whole printer dots.' },
      { key: 'barcodeFormat', label: 'Barcode type', type: 'enum', options: [['auto', 'Automatic (recommended)'], ['CODE128', 'Always Code 128'], ['EAN13', 'EAN-13 when possible']], hint: 'Automatic prints EAN-13, UPC-A or EAN-8 for a complete number with a correct check digit, and Code 128 for every other code.' }
    ]
  },
  {
    title: 'Report header',
    only: isReport,
    specs: [
      { key: 'showReportTitle', label: 'Report title', type: 'bool' },
      { key: 'showPeriod', label: 'Period line', type: 'bool' }
    ]
  }
]

function Control({ spec, value, onChange }: { spec: Spec; value: string | number | boolean | undefined; onChange: (v: string | number | boolean) => void }) {
  if (spec.type === 'bool') return <Toggle checked={!!value} onChange={onChange} label={spec.label} />
  return (
    <Field label={spec.label} hint={spec.hint}>
      {spec.type === 'num' ? (
        <NumberInput value={typeof value === 'number' ? value : 0} onChange={(n) => onChange(n ?? 0)} min={spec.min} max={spec.max} step={spec.step} decimals={spec.step && spec.step < 1 ? 2 : 0} />
      ) : spec.type === 'enum' ? (
        <Select value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}>
          {spec.options!.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </Select>
      ) : spec.type === 'area' ? (
        <textarea className="input" rows={3} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <Input value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />
      )}
    </Field>
  )
}

export function TemplatesTab() {
  const { can } = useSession()
  const confirm = useConfirm()
  const { run, loading: busy } = useApiAction()
  const canEdit = can('printing.templates')
  const meta = useAsync(() => call<TemplateMeta[]>('printing', 'templateMeta'), [])
  const [kind, setKind] = useState<TemplateKind>('receipt58')
  const [saved, setSaved] = useState<Config | null>(null)
  const [cfg, setCfg] = useState<Config | null>(null)
  const [sample, setSample] = useState(false)
  const [preview, setPreview] = useState<Rendered | null>(null)
  const [previewErr, setPreviewErr] = useState<string | null>(null)
  const [result, setResult] = useState<PrintResult | null>(null)
  const seq = useRef(0)

  const load = useCallback(async (k: TemplateKind) => {
    const t = await call<TemplateRow>('printing', 'getTemplate', { kind: k })
    setSaved(t.config)
    setCfg(t.config)
  }, [])
  useEffect(() => { void load(kind).catch(() => {}) }, [kind, load])

  const dirty = !!saved && !!cfg && JSON.stringify(saved) !== JSON.stringify(cfg)
  useDirtyGuard(dirty)

  // live preview: real current profile + real latest sale (or sample data when asked)
  useEffect(() => {
    if (!cfg) return
    const mine = ++seq.current
    const timer = setTimeout(async () => {
      try {
        let r: Rendered
        if (isInvoice(kind)) r = await call<Rendered>('printing', 'renderInvoiceHtml', { template: kind, sample, preview: true, config: cfg })
        else if (isLabel(kind)) r = await call<Rendered>('printing', 'renderLabelHtml', { template: kind, sample, config: cfg })
        else r = await call<Rendered>('printing', 'renderReportHtml', { template: kind, title: 'Report title', subtitle: 'Period: 01/04/2026 - 30/04/2026', ...REPORT_PREVIEW, config: cfg })
        if (mine === seq.current) { setPreview(r); setPreviewErr(null) }
      } catch (e) {
        if (mine === seq.current) { setPreview(null); setPreviewErr(e instanceof Error ? e.message : String(e)) }
      }
    }, 250)
    return () => clearTimeout(timer)
  }, [cfg, kind, sample])

  const kinds = meta.data ?? []
  const current = kinds.find((k) => k.kind === kind)
  const paper: Paper = current?.paper ?? 'A4'
  // print darkness of the printer this paper goes to, so the preview is drawn the way the job is sent
  const look = useAsync(() => call<PrintLook>('printing', 'printLook', { paper }).catch(() => null), [paper])
  const groups = useMemo(() => GROUPS.filter((g) => !g.only || g.only(kind)).map((g) => ({ ...g, specs: g.specs.filter((s) => !s.only || s.only(kind)) })), [kind])

  const switchKind = async (k: TemplateKind) => {
    if (dirty && !(await confirm({ title: 'Discard changes?', message: 'You have unsaved template changes.', confirmLabel: 'Discard', tone: 'danger' }))) return
    setPreview(null)
    setResult(null)
    setKind(k)
  }

  if (meta.loading && !meta.data) return <Spinner />
  if (meta.error) return <ErrorState message={meta.error} onRetry={meta.reload} />

  const save = () => run(async () => { const t = await call<TemplateRow>('printing', 'saveTemplate', { kind, config: cfg }); setSaved(t.config); setCfg(t.config) }, { success: 'Template saved' })
  const reset = async () => {
    if (!(await confirm({ title: 'Reset to defaults?', message: `All options of the ${current?.label ?? 'template'} go back to their defaults.`, confirmLabel: 'Reset', tone: 'danger' }))) return
    await run(async () => { const t = await call<TemplateRow>('printing', 'resetTemplate', { kind }); setSaved(t.config); setCfg(t.config) }, { success: 'Template reset' })
  }
  const printNow = async () => {
    if (!preview) return
    const r = await run(() => call<PrintResult>('printing', 'print', { html: preview.html, paper, widthMm: preview.widthMm, heightMm: preview.heightMm, docRef: preview.docRef, showDialog: false }))
    if (r) setResult(r)
  }
  const pdf = async () => {
    if (!preview) return
    const r = await run(() => call<{ path: string }>('printing', 'exportPdf', { html: preview.html, paper, widthMm: preview.widthMm, heightMm: preview.heightMm, name: kind }), { success: 'PDF saved' })
    if (r) setResult({ ok: true, error: `Saved to ${r.path}` })
  }

  return (
    <div className="grid2" style={{ gridTemplateColumns: 'minmax(320px, 1fr) minmax(320px, 1fr)', alignItems: 'start' }}>
      <div>
        <Card title="Template">
          <Field label="Document">
            <Select value={kind} onChange={(e) => void switchKind(e.target.value as TemplateKind)}>
              {kinds.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}
            </Select>
          </Field>
          {!canEdit && <InlineAlert tone="info">You can preview templates. Changing them needs the "Edit print templates" permission.</InlineAlert>}
          <p className="muted" style={{ marginTop: 8 }}>Shop name, logo, address and GSTIN always come from the Shop Profile. Each paper size has its own layout. Print darkness is set per printer, under Printers.</p>
        </Card>
        {!cfg ? <Spinner /> : groups.map((g) => (
          <Card key={g.title} title={g.title}>
            <FormGrid cols={2}>
              {g.specs.map((s) => <Control key={s.key} spec={s} value={cfg[s.key]} onChange={(v) => canEdit && setCfg({ ...cfg, [s.key]: v })} />)}
            </FormGrid>
          </Card>
        ))}
        <div className="row" style={{ position: 'sticky', bottom: 0, background: 'var(--bg, #fff)', padding: '8px 0' }}>
          <Button variant="primary" onClick={save} disabled={!canEdit || !dirty || busy}>Save template</Button>
          <Button onClick={() => saved && setCfg(saved)} disabled={!dirty}>Undo changes</Button>
          <Button variant="danger" onClick={reset} disabled={!canEdit || busy}>Reset to defaults</Button>
          {dirty && <Badge tone="warn">Unsaved changes</Badge>}
        </div>
      </div>

      <div style={{ position: 'sticky', top: 0 }}>
        <Card
          title="Live preview"
          actions={<div className="row"><Toggle checked={sample} onChange={setSample} label="Use sample data" /></div>}
        >
          {previewErr ? (
            <EmptyState title="Nothing to preview yet" hint={previewErr} action={<Button onClick={() => setSample(true)}>Use sample data</Button>} />
          ) : !preview ? <Spinner /> : (
            <>
              <p className="muted" style={{ marginBottom: 8 }}>
                {sample ? 'Sample lines with your real shop profile.' : preview.docRef ? `Real data: ${preview.docRef}, with the current shop profile.` : 'Real data from your catalogue.'}
                {' '}Paper {preview.widthMm} mm{preview.heightMm ? ` x ${preview.heightMm} mm` : ''}.
              </p>
              {(preview.warnings ?? []).map((w) => <div key={w} style={{ marginBottom: 8 }}><InlineAlert tone="warn" title="Check the barcode">{w}</InlineAlert></div>)}
              <PrintPreview html={preview.html} widthMm={preview.widthMm} heightMm={preview.heightMm} scale={preview.widthMm > 120 ? 0.62 : 1} maxHeight="70vh" look={look.data} />
              <div className="row" style={{ marginTop: 10 }}>
                <Button onClick={printNow} disabled={busy}>Print this preview</Button>
                <Button onClick={pdf} disabled={busy}>Save PDF</Button>
              </div>
              {result && (
                <div style={{ marginTop: 8 }}>
                  {!result.ok ? <InlineAlert tone="bad" title="Printing failed">{result.error}. Try again, choose another printer under Printers, or use Save PDF.</InlineAlert>
                    : result.warning ? <InlineAlert tone="warn" title="Printed on another printer">{result.warning}</InlineAlert>
                    : <InlineAlert tone="good">{result.error ?? 'Sent to the printer.'}</InlineAlert>}
                </div>
              )}
            </>
          )}
        </Card>
      </div>
    </div>
  )
}

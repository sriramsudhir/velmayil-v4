import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Field, InlineAlert, Input, Modal, Select, Spinner, useToast } from '@/ui'
import { call, errMsg } from '@/lib/api'
import { useSession } from '@/lib/session'
import {
  choiceFromConfig, CUSTOM_LABEL_ID, CUSTOM_LIMITS, DEFAULT_LABEL_OPTIONS, DEFAULT_LABEL_PRESET, LABEL_PRESETS, labelConfigFor, pageSizeOf, resolveLabelSize,
  type LabelChoice, type LabelOptions
} from '@shared/labelSizes'
import { PrintPreview } from './PrintPreview'
import type { PrintResult, Rendered, TemplateRow } from './shared'

const STORE = 'pos.labelPrint.v1'
interface Saved { choice: LabelChoice; options: LabelOptions }

const readSaved = (userId: number | undefined): Saved | null => {
  try {
    const raw = localStorage.getItem(`${STORE}.${userId ?? 0}`)
    if (!raw) return null
    const s = JSON.parse(raw) as Saved
    if (!s?.choice?.presetId) return null
    return { choice: s.choice, options: { ...DEFAULT_LABEL_OPTIONS, ...s.options } }
  } catch {
    return null
  }
}
const writeSaved = (userId: number | undefined, s: Saved) => {
  try {
    localStorage.setItem(`${STORE}.${userId ?? 0}`, JSON.stringify(s))
  } catch {
    /* storage unavailable: the choice just is not remembered */
  }
}

const OPTION_LABELS: [keyof LabelOptions, string][] = [
  ['showShopName', 'Shop name'], ['showLogo', 'Shop logo'], ['showProductName', 'Product name'], ['showVariant', 'Variant'],
  ['showMrp', 'MRP'], ['showPrice', 'Selling price'], ['showBarcodeText', 'Barcode number']
]

/**
 * "Print barcode label": asks the label size + copies, shows a live, accurate preview (real product, real shop profile,
 * barcode, MRP, price) and prints / saves a PDF. Printing problems never lose anything: the barcode is already saved.
 */
export function LabelPrintDialog({ open, onClose, variantIds, initialCopies = 1, heading, barcode, unitCodes, unitVariantId, onPrinted }: {
  open: boolean
  onClose: () => void
  variantIds: number[]
  initialCopies?: number
  heading?: string
  /** Shown above the preview (the barcode that was just generated). */
  barcode?: string
  /** Unit labels: print one Code 128 label per unique unit code (PREFIX-NNNN) instead of the product barcode. */
  unitCodes?: string[]
  /** Product (variant) all `unitCodes` belong to; omitted = the server looks each code up. */
  unitVariantId?: number
  /** Called after the labels were sent to the printer successfully. */
  onPrinted?: () => void
}) {
  const toast = useToast()
  const { session } = useSession()
  const userId = session?.userId
  const [choice, setChoice] = useState<LabelChoice>({ presetId: DEFAULT_LABEL_PRESET })
  const [options, setOptions] = useState<LabelOptions>(DEFAULT_LABEL_OPTIONS)
  const [copies, setCopies] = useState(String(initialCopies))
  const [ready, setReady] = useState(false)
  const [preview, setPreview] = useState<Rendered | null>(null)
  const [previewErr, setPreviewErr] = useState<string | null>(null)
  const [busy, setBusy] = useState<null | 'print' | 'pdf'>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  /** Barcode problems found in the WHOLE job (the preview only shows the first label); printing waits for "Print anyway". */
  const [jobWarnings, setJobWarnings] = useState<string[] | null>(null)
  const seq = useRef(0)

  // initial choice: this user's last choice, else the shop's label template
  useEffect(() => {
    if (!open) return
    setReady(false)
    setFailure(null)
    setNotice(null)
    setJobWarnings(null)
    setCopies(String(initialCopies))
    const saved = readSaved(userId)
    if (saved) {
      setChoice(saved.choice)
      setOptions(saved.options)
      setReady(true)
      return
    }
    call<TemplateRow>('printing', 'getTemplate', { kind: 'label_barcode' })
      .then((t) => {
        const c = choiceFromConfig(t.config)
        setChoice(c.choice)
        setOptions(c.options)
      })
      .catch(() => undefined)
      .finally(() => setReady(true))
  }, [open, userId, initialCopies])

  useEffect(() => { setJobWarnings(null) }, [choice, options, copies])
  const size = useMemo(() => resolveLabelSize(choice), [choice])
  const page = pageSizeOf(size)
  const config = useMemo(() => labelConfigFor(size, options), [size, options])
  const n = Math.max(1, Math.min(500, Math.floor(Number(copies) || 1)))
  const unitMode = !!unitCodes && unitCodes.length > 0
  const itemCount = unitMode ? unitCodes!.length : variantIds.length
  const total = n * itemCount
  const unitReq = (codes: string[], copiesEach: number) => ({ unitCodes: codes, ...(unitVariantId != null ? { variantId: unitVariantId } : {}), copies: copiesEach })
  // the server renders at most 2000 labels per call: split bigger jobs into runs
  const runSize = Math.max(1, Math.floor(2000 / n))
  const customBad =
    choice.presetId === CUSTOM_LABEL_ID &&
    (!(Number(choice.customWidthMm) >= CUSTOM_LIMITS.minWidthMm && Number(choice.customWidthMm) <= CUSTOM_LIMITS.maxWidthMm) ||
      !(Number(choice.customHeightMm) >= CUSTOM_LIMITS.minHeightMm && Number(choice.customHeightMm) <= CUSTOM_LIMITS.maxHeightMm))
      ? `Custom size must be ${CUSTOM_LIMITS.minWidthMm}-${CUSTOM_LIMITS.maxWidthMm} mm wide and ${CUSTOM_LIMITS.minHeightMm}-${CUSTOM_LIMITS.maxHeightMm} mm high`
      : null

  // live preview from the real product (first one), shop profile and logo
  useEffect(() => {
    if (!open || !ready || customBad || (!variantIds.length && !unitMode)) return
    const mine = ++seq.current
    const t = setTimeout(async () => {
      try {
        const perPage = size.sheet ? size.sheet.cols * size.sheet.rows : 1
        const r = await call<Rendered>('printing', 'renderLabelHtml', unitMode
          ? { template: 'label_barcode', ...unitReq(unitCodes!.slice(0, perPage), Math.min(n, perPage)), config }
          : { template: 'label_barcode', variantIds: [{ variantId: variantIds[0], copies: Math.min(n, perPage) }], config })
        if (mine === seq.current) { setPreview(r); setPreviewErr(null) }
      } catch (e) {
        if (mine === seq.current) { setPreview(null); setPreviewErr(errMsg(e)) }
      }
    }, 150)
    return () => clearTimeout(t)
  }, [open, ready, customBad, variantIds, unitCodes, unitVariantId, config, n, size])

  const renderRuns = async (): Promise<Rendered[]> => {
    if (!unitMode) return [await call<Rendered>('printing', 'renderLabelHtml', { template: 'label_barcode', variantIds: variantIds.map((variantId) => ({ variantId, copies: n })), config })]
    const runs: Rendered[] = []
    for (let i = 0; i < unitCodes!.length; i += runSize) runs.push(await call<Rendered>('printing', 'renderLabelHtml', { template: 'label_barcode', ...unitReq(unitCodes!.slice(i, i + runSize), n), config }))
    return runs
  }

  const remember = async () => {
    writeSaved(userId, { choice, options })
    // keep Printing > Templates consistent (needs the template permission: best effort)
    try {
      await call('printing', 'saveTemplate', { kind: 'label_barcode', config })
    } catch {
      /* cashiers cannot edit templates: the per-user choice is still remembered */
    }
  }

  const doPrint = async (anyway = false) => {
    if (customBad) return
    setBusy('print')
    setFailure(null)
    setNotice(null)
    try {
      const runs = await renderRuns()
      // a code that does not fit this label would print without bars: say so and let the user choose first
      const found = [...new Set(runs.flatMap((r) => r.warnings ?? []))]
      if (found.length && !anyway) {
        setJobWarnings(found)
        return
      }
      setJobWarnings(null)
      let res: PrintResult = { ok: true }
      let warning: string | undefined
      for (const r of runs) {
        res = await call<PrintResult>('printing', 'print', {
          html: r.html, paper: size.sheet ? 'A4' : 'label', widthMm: page.widthMm, heightMm: page.heightMm, docRef: `${unitMode ? 'unit-labels' : 'labels'}-${total}`
        })
        if (!res.ok) break
        warning = res.warning ?? warning
      }
      void remember()
      if (res.ok) {
        toast(warning ?? `${total} label${total === 1 ? '' : 's'} sent to the printer`, warning ? 'info' : 'good')
        onPrinted?.()
        onClose()
      } else setFailure(res.error || 'Printing failed')
    } catch (e) {
      setFailure(errMsg(e))
    } finally {
      setBusy(null)
    }
  }

  const doPdf = async () => {
    if (customBad) return
    setBusy('pdf')
    setNotice(null)
    try {
      const r = (await renderRuns())[0]
      const out = await call<{ path: string }>('printing', 'exportPdf', {
        html: r.html, path: `labels-${size.id}.pdf`, paper: size.sheet ? 'A4' : 'label', widthMm: page.widthMm, heightMm: page.heightMm, name: `labels-${size.id}`
      })
      void remember()
      setNotice(`PDF saved to ${out.path}`)
      toast('Label PDF saved', 'good')
    } catch (e) {
      setNotice(null)
      setFailure(`Could not save the PDF: ${errMsg(e)}`)
    } finally {
      setBusy(null)
    }
  }

  const pxW = page.widthMm * (96 / 25.4)
  const scale = Math.max(0.35, Math.min(3, 400 / pxW))
  const setOpt = (k: keyof LabelOptions, v: boolean) => setOptions((o) => ({ ...o, [k]: v }))

  return (
    <Modal
      wide open={open} onClose={onClose} title={unitMode ? 'Print unit labels' : 'Print barcode label'}
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          <Button disabled={!!busy || !!customBad || !preview} onClick={() => void doPdf()}>{busy === 'pdf' ? 'Saving…' : 'Save PDF'}</Button>
          <Button variant="primary" disabled={!!busy || !!customBad || !preview} onClick={() => void doPrint()}>{busy === 'print' ? 'Printing…' : `Print ${total} label${total === 1 ? '' : 's'}`}</Button>
        </>
      }
    >
      {heading && <InlineAlert tone="good">{heading}</InlineAlert>}
      {failure && (
        <div style={{ marginTop: 8 }}>
          <InlineAlert
            tone="bad" title="Could not print the labels"
            action={<span className="row"><Button size="sm" disabled={!!busy} onClick={() => void doPrint()}>Retry</Button><Button size="sm" disabled={!!busy} onClick={() => void doPdf()}>Save PDF</Button></span>}
          >
            {failure}. Your {unitMode ? 'unit codes are' : 'barcode is'} already saved, nothing was lost. Check the label printer under Printing &gt; Printers, then Retry, or save a PDF.
          </InlineAlert>
        </div>
      )}
      {notice && <div style={{ marginTop: 8 }}><InlineAlert tone="good">{notice}</InlineAlert></div>}
      {jobWarnings && (
        <div style={{ marginTop: 8 }} data-testid="label-job-warnings">
          <InlineAlert tone="warn" title="Some barcodes do not fit this label" action={<Button size="sm" disabled={!!busy} onClick={() => void doPrint(true)}>Print anyway</Button>}>
            {jobWarnings.map((w) => <div key={w}>{w}</div>)}
          </InlineAlert>
        </div>
      )}
      <div className="grid2" style={{ gridTemplateColumns: 'minmax(260px, 340px) 1fr', alignItems: 'start', marginTop: 12 }}>
        <div>
          <Field label="Label size">
            <Select value={choice.presetId} onChange={(e) => setChoice((c) => ({ ...c, presetId: e.target.value, customWidthMm: c.customWidthMm ?? size.widthMm, customHeightMm: c.customHeightMm ?? size.heightMm }))}>
              {LABEL_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              <option value={CUSTOM_LABEL_ID}>Custom size…</option>
            </Select>
          </Field>
          {choice.presetId === CUSTOM_LABEL_ID && (
            <div className="row" style={{ gap: 8, alignItems: 'flex-end' }}>
              <Field label="Width (mm)"><Input type="number" min={CUSTOM_LIMITS.minWidthMm} max={CUSTOM_LIMITS.maxWidthMm} step="1" value={choice.customWidthMm ?? ''} onChange={(e) => setChoice((c) => ({ ...c, customWidthMm: e.target.value === '' ? undefined : Number(e.target.value) }))} /></Field>
              <Field label="Height (mm)"><Input type="number" min={CUSTOM_LIMITS.minHeightMm} max={CUSTOM_LIMITS.maxHeightMm} step="1" value={choice.customHeightMm ?? ''} onChange={(e) => setChoice((c) => ({ ...c, customHeightMm: e.target.value === '' ? undefined : Number(e.target.value) }))} /></Field>
            </div>
          )}
          {customBad && <div className="field-error" role="alert">{customBad}</div>}
          <Field label={unitMode ? `Copies of each unit label (${unitCodes!.length} unit${unitCodes!.length === 1 ? '' : 's'})` : variantIds.length > 1 ? `Copies per product (${variantIds.length} products)` : 'Number of copies'} hint={total > 2000 ? 'At most 2000 labels are printed at a time' : undefined}>
            <Input type="number" min={1} max={500} value={copies} onChange={(e) => setCopies(e.target.value)} />
          </Field>
          <fieldset style={{ border: 0, padding: 0, margin: '8px 0 0' }}>
            <legend className="muted" style={{ padding: 0, marginBottom: 4 }}>Show on label</legend>
            {OPTION_LABELS.map(([k, label]) => (
              <label key={k} style={{ display: 'block', marginBottom: 2 }}>
                <input type="checkbox" checked={options[k]} onChange={(e) => setOpt(k, e.target.checked)} /> {label}
              </label>
            ))}
          </fieldset>
          <p className="muted" style={{ marginTop: 8 }}>
            Page: {page.widthMm} x {page.heightMm} mm{size.sheet ? ` (${size.sheet.cols * size.sheet.rows} labels per sheet)` : ''}. Your choice is remembered.
          </p>
          <p className="muted" style={{ marginTop: 4 }}>
            The label size must match the size set in the printer's Windows driver. If labels do not scan, check the printer's resolution and darkness under Printing &gt; Printers.
          </p>
        </div>
        <div>
          {unitMode && <div style={{ marginBottom: 6 }} data-testid="label-unit-codes">Unit codes: <strong>{unitCodes!.length <= 3 ? unitCodes!.join(', ') : `${unitCodes![0]} … ${unitCodes![unitCodes!.length - 1]} (${unitCodes!.length})`}</strong></div>}
          {barcode && <div style={{ marginBottom: 6 }}>Barcode: <strong data-testid="label-barcode" style={{ letterSpacing: '.08em' }}>{barcode}</strong></div>}
          {previewErr ? (
            <InlineAlert tone="bad" title="Cannot preview this label">{previewErr}</InlineAlert>
          ) : !preview || !ready ? (
            <Spinner label="Preparing preview…" />
          ) : (
            <>
              {!jobWarnings && (preview.warnings ?? []).map((w) => <div key={w} style={{ marginBottom: 8 }} data-testid="label-warning"><InlineAlert tone="warn" title="Check the barcode">{w}</InlineAlert></div>)}
              <PrintPreview html={preview.html} widthMm={preview.widthMm} heightMm={preview.heightMm} scale={scale} maxHeight="55vh" title="Label preview" />
            </>
          )}
        </div>
      </div>
    </Modal>
  )
}

export default LabelPrintDialog

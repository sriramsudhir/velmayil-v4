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
import {
  MAX_LABELS_PER_RUN, chunk, codeRangeText, shortfallExtra, shortfallLines, shortfallsOf, splitPlans, type IssuedLabels, type LabelPlan, type Shortfall
} from './labelJob'

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
 * "Print barcode label": asks the label size + number of labels, shows a live, accurate preview (real product, real shop profile,
 * barcode, MRP, price) and prints / saves a PDF.
 *
 * Product mode (`variantIds`): every label of a stock-tracked product gets its OWN number (same 4-digit prefix, the 6-digit suffix
 * counts up by one per label, see shared/scanList.ts). The numbers are issued by `units.issueLabels` in one database transaction at the moment
 * Print / Save PDF is pressed and are never issued again; a failed print is retried with the SAME numbers. Asking for more labels
 * than there are unlabelled pieces in stock is refused until the user confirms receiving the extra pieces into stock.
 * Products that do not track stock keep the shared product barcode.
 *
 * Unit mode (`unitCodes`, or "Reprint a damaged label"): prints EXISTING numbers again (`units.reprintLabels`); never a new one.
 */
export function LabelPrintDialog({ open, onClose, variantIds, initialCopies = 1, heading, barcode, unitCodes, unitVariantId, onPrinted }: {
  open: boolean
  onClose: () => void
  variantIds: number[]
  initialCopies?: number
  heading?: string
  /** Shown above the preview (the barcode that was just generated). */
  barcode?: string
  /** Unit labels: print one Code 128 label per EXISTING unit code / label number (a reprint; no new number is created). */
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
  /** which button asked last (the stock question is answered for that action) */
  const lastAction = useRef<'print' | 'pdf'>('print')
  /** product mode: what printing will do per variant (unique numbers or shared barcode), loaded when the dialog opens */
  const [plans, setPlans] = useState<LabelPlan[] | null>(null)
  const [planErr, setPlanErr] = useState<string | null>(null)
  /** product mode: the numbers issued for THIS job. Once set they are printed as they are (retry / PDF never issue again). */
  const [issued, setIssued] = useState<IssuedLabels[] | null>(null)
  /** product mode: more labels asked for than unlabelled pieces in stock; waits for the user's decision */
  const [shortfall, setShortfall] = useState<Shortfall[] | null>(null)
  /** "Reprint a damaged label": existing numbers typed / scanned here are printed again instead of new ones */
  const [reprint, setReprint] = useState<string[]>([])
  const [reprintText, setReprintText] = useState('')
  const [reprintErr, setReprintErr] = useState<string | null>(null)

  // initial choice: this user's last choice, else the shop's label template
  useEffect(() => {
    if (!open) return
    setReady(false)
    setFailure(null)
    setNotice(null)
    setJobWarnings(null)
    setIssued(null)
    setShortfall(null)
    setReprint([])
    setReprintText('')
    setReprintErr(null)
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

  useEffect(() => { setJobWarnings(null); setShortfall(null) }, [choice, options, copies])

  // product mode: ask the server what each product's labels will carry (nothing is reserved by this)
  const variantKey = variantIds.join(',')
  useEffect(() => {
    if (!open || !variantIds.length) { setPlans(null); setPlanErr(null); return }
    let live = true
    setPlans(null)
    setPlanErr(null)
    void (async () => {
      try {
        const out: LabelPlan[] = []
        for (const variantId of variantIds) out.push(await call<LabelPlan>('units', 'labelPlan', { variantId }))
        if (live) setPlans(out)
      } catch (e) {
        if (live) setPlanErr(errMsg(e))
      }
    })()
    return () => { live = false }
  }, [open, variantKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const size = useMemo(() => resolveLabelSize(choice), [choice])
  const page = pageSizeOf(size)
  const config = useMemo(() => labelConfigFor(size, options), [size, options])
  const n = Math.max(1, Math.min(500, Math.floor(Number(copies) || 1)))
  const reprinting = reprint.length > 0
  const existingCodes = unitCodes && unitCodes.length > 0 ? unitCodes : reprint
  const unitMode = existingCodes.length > 0
  const itemCount = unitMode ? existingCodes.length : variantIds.length
  const total = n * itemCount
  const unitReq = (codes: string[], copiesEach: number) => ({ unitCodes: codes, ...(unitVariantId != null && !reprinting ? { variantId: unitVariantId } : {}), copies: copiesEach })
  const split = useMemo(() => splitPlans(variantIds, plans), [variantKey, plans]) // eslint-disable-line react-hooks/exhaustive-deps
  const firstPlan = plans?.find((p) => p.variantId === variantIds[0]) ?? null
  const blocked = !unitMode ? plans?.find((p) => p.mode === 'unique' && p.blocked)?.blocked ?? null : null
  const canReceive = !!plans?.some((p) => p.canReceive)
  /** product mode waits for the plans: without them it is not known whether a label needs its own number */
  const planning = !unitMode && variantIds.length > 0 && !plans
  const issuedCodes = (issued ?? []).flatMap((i) => i.codes)
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
    if (!open || !ready || customBad || (!variantIds.length && !unitMode) || planning) return
    const mine = ++seq.current
    const t = setTimeout(async () => {
      try {
        const perPage = size.sheet ? size.sheet.cols * size.sheet.rows : 1
        let req: Record<string, unknown>
        if (unitMode) req = { template: 'label_barcode', ...unitReq(existingCodes.slice(0, perPage), Math.min(n, perPage)), config }
        else if (firstPlan?.mode === 'unique') {
          // the numbers this job will carry: the ones already issued, else a preview of the next ones (nothing is reserved)
          const mineIssued = issued?.find((i) => i.variantId === variantIds[0])?.codes
          const codes = mineIssued ?? (await call<LabelPlan>('units', 'labelPlan', { variantId: variantIds[0], count: Math.min(n, perPage, 60) })).previewCodes
          if (!codes.length) throw new Error(firstPlan.blocked ?? 'No label number is available for this product')
          req = { template: 'label_barcode', unitCodes: codes.slice(0, Math.min(n, perPage)), variantId: variantIds[0], copies: 1, config }
        } else req = { template: 'label_barcode', variantIds: [{ variantId: variantIds[0], copies: Math.min(n, perPage) }], config }
        const r = await call<Rendered>('printing', 'renderLabelHtml', req)
        if (mine === seq.current) { setPreview(r); setPreviewErr(null) }
      } catch (e) {
        if (mine === seq.current) { setPreview(null); setPreviewErr(errMsg(e)) }
      }
    }, 150)
    return () => clearTimeout(t)
  }, [open, ready, customBad, variantKey, existingCodes.join(','), unitVariantId, config, n, size, planning, firstPlan?.mode, issued]) // eslint-disable-line react-hooks/exhaustive-deps

  /** Barcode problems of the job, found BEFORE any number is issued (one sample label per product). */
  const precheck = async (): Promise<string[]> => {
    if (unitMode || issued) return []
    const found: string[] = []
    for (const p of plans ?? []) {
      if (p.mode !== 'unique' || !p.previewCodes.length) continue
      const r = await call<Rendered>('printing', 'renderLabelHtml', { template: 'label_barcode', unitCodes: [p.previewCodes[0]], variantId: p.variantId, copies: 1, config })
      found.push(...(r.warnings ?? []))
    }
    return [...new Set(found)]
  }

  /**
   * The pages of this job. Product mode issues the label numbers here (once: a retry / the PDF reuse them).
   * Returns null when the server asks for a decision first (more labels than unlabelled stock).
   */
  const renderRuns = async (receiveExtra = false): Promise<Rendered[] | null> => {
    const runs: Rendered[] = []
    if (unitMode) {
      // existing numbers: recorded as printed, never a new number
      await call('units', 'reprintLabels', { codes: existingCodes })
      for (let i = 0; i < existingCodes.length; i += runSize) runs.push(await call<Rendered>('printing', 'renderLabelHtml', { template: 'label_barcode', ...unitReq(existingCodes.slice(i, i + runSize), n), config }))
      return runs
    }
    let mine = issued
    if (!mine && split.unique.length) {
      try {
        mine = (await call<{ items: IssuedLabels[] }>('units', 'issueLabels', { items: split.unique.map((variantId) => ({ variantId, count: n })), receiveExtra })).items
      } catch (e) {
        const short = shortfallsOf(e)
        if (!short) throw e
        setShortfall(short)
        return null
      }
      setIssued(mine)
      setShortfall(null)
    }
    // one label per number (the server finds each number's product)
    for (const codes of chunk((mine ?? []).flatMap((i) => i.codes), MAX_LABELS_PER_RUN))
      runs.push(await call<Rendered>('printing', 'renderLabelHtml', { template: 'label_barcode', unitCodes: codes, copies: 1, config }))
    if (split.shared.length)
      runs.push(await call<Rendered>('printing', 'renderLabelHtml', { template: 'label_barcode', variantIds: split.shared.map((variantId) => ({ variantId, copies: n })), config }))
    return runs
  }

  const addReprint = async () => {
    const code = reprintText.trim().toUpperCase()
    if (!code) return
    setReprintErr(null)
    try {
      const r = await call<{ unit: { code: string; status: string } } | null>('units', 'resolve', { code })
      if (!r) return setReprintErr(`Label number ${code} does not exist. A reprint never creates a new number.`)
      if (r.unit.status === 'void') return setReprintErr(`Label number ${r.unit.code} is void and cannot be printed again.`)
      setReprint((cur) => (cur.includes(r.unit.code) ? cur : [...cur, r.unit.code]))
      setReprintText('')
      setCopies('1')
    } catch (e) {
      setReprintErr(errMsg(e))
    }
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

  const doPrint = async (anyway = false, receiveExtra = false) => {
    if (customBad) return
    lastAction.current = 'print'
    setBusy('print')
    setFailure(null)
    setNotice(null)
    try {
      // a code that does not fit this label would print without bars: say so and let the user choose BEFORE numbers are issued
      const early = anyway ? [] : await precheck()
      if (early.length) {
        setJobWarnings(early)
        return
      }
      const runs = await renderRuns(receiveExtra)
      if (!runs) return
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
          html: r.html, paper: size.sheet ? 'A4' : 'label', widthMm: page.widthMm, heightMm: page.heightMm, docRef: `${unitMode || split.unique.length ? 'unit-labels' : 'labels'}-${total}`
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

  const doPdf = async (receiveExtra = false) => {
    if (customBad) return
    lastAction.current = 'pdf'
    setBusy('pdf')
    setNotice(null)
    try {
      const runs = await renderRuns(receiveExtra)
      if (!runs) return
      const paths: string[] = []
      for (const [i, r] of runs.entries()) {
        // unit mode keeps its one file; a product job with several runs saves one file per run so no label is left out
        if (i > 0 && unitMode) break
        const name = `labels-${size.id}${i ? `-${i + 1}` : ''}`
        const out = await call<{ path: string }>('printing', 'exportPdf', {
          html: r.html, path: `${name}.pdf`, paper: size.sheet ? 'A4' : 'label', widthMm: page.widthMm, heightMm: page.heightMm, name
        })
        paths.push(out.path)
      }
      void remember()
      setNotice(`PDF saved to ${paths.join(', ')}`)
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
      wide open={open} onClose={onClose} title={reprinting ? 'Reprint barcode label' : unitMode ? 'Print unit labels' : 'Print barcode label'}
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          <Button disabled={!!busy || !!customBad || !preview || !!blocked || !!planErr} onClick={() => void doPdf()}>{busy === 'pdf' ? 'Saving…' : 'Save PDF'}</Button>
          <Button variant="primary" data-testid="label-print" disabled={!!busy || !!customBad || !preview || !!blocked || !!planErr} onClick={() => void doPrint()}>{busy === 'print' ? 'Printing…' : `${reprinting ? 'Reprint' : 'Print'} ${total} label${total === 1 ? '' : 's'}`}</Button>
        </>
      }
    >
      {heading && <InlineAlert tone="good">{heading}</InlineAlert>}
      {blocked && <div style={{ marginTop: 8 }} data-testid="label-blocked"><InlineAlert tone="bad" title="Labels cannot be printed on this computer">{blocked} A damaged label can still be reprinted here.</InlineAlert></div>}
      {planErr && <div style={{ marginTop: 8 }}><InlineAlert tone="bad" title="Cannot prepare the labels">{planErr}</InlineAlert></div>}
      {shortfall && (
        <div style={{ marginTop: 8 }} data-testid="label-shortfall">
          <InlineAlert
            tone="warn" title="More labels than pieces in stock"
            action={canReceive
              ? <Button size="sm" disabled={!!busy} data-testid="label-receive-extra" onClick={() => void (lastAction.current === 'pdf' ? doPdf(true) : doPrint(false, true))}>Add {shortfallExtra(shortfall)} to stock and {lastAction.current === 'pdf' ? 'save the PDF' : 'print'}</Button>
              : undefined}
          >
            {shortfallLines(shortfall).map((l) => <div key={l}>{l}</div>)}
            <div>
              Every label number belongs to one piece in stock, so nothing was printed and stock was not changed. Lower the number of labels
              {canReceive ? `, or add the ${shortfallExtra(shortfall)} extra piece${shortfallExtra(shortfall) === 1 ? '' : 's'} to stock now (a stock adjustment "found" is recorded).` : ', or ask someone who may adjust stock to receive the extra pieces first.'}
            </div>
          </InlineAlert>
        </div>
      )}
      {issued && issuedCodes.length > 0 && (
        <div style={{ marginTop: 8 }} data-testid="label-issued">
          <InlineAlert tone="info" title="These label numbers are now reserved for this job">
            {issued.length === 1 ? codeRangeText(issuedCodes) : `${issuedCodes.length} numbers for ${issued.length} products`}. They are never given out again. If the printer fails, press Retry here (the same numbers are printed); later they can only be printed with "Reprint a damaged label".
          </InlineAlert>
        </div>
      )}
      {failure && (
        <div style={{ marginTop: 8 }}>
          <InlineAlert
            tone="bad" title="Could not print the labels"
            action={<span className="row"><Button size="sm" disabled={!!busy} onClick={() => void doPrint()}>Retry</Button><Button size="sm" disabled={!!busy} onClick={() => void doPdf()}>Save PDF</Button></span>}
          >
            {failure}. Your {unitMode || issued ? 'label numbers are' : 'barcode is'} already saved, nothing was lost. Check the label printer under Printing &gt; Printers, then Retry, or save a PDF.
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
          <Field
            label={unitMode ? `Copies of each label (${existingCodes.length} number${existingCodes.length === 1 ? '' : 's'})` : variantIds.length > 1 ? `Labels per product (${variantIds.length} products)` : 'Number of labels'}
            hint={total > 2000 ? 'At most 2000 labels are printed at a time' : !unitMode && split.unique.length ? 'Each label gets its own number' : undefined}
          >
            <Input type="number" min={1} max={500} value={copies} disabled={!!issued} onChange={(e) => setCopies(e.target.value)} data-testid="label-copies" />
          </Field>
          {!unitMode && firstPlan?.mode === 'unique' && variantIds.length === 1 && (
            <p className="muted" style={{ margin: '4px 0 0' }} data-testid="label-plan">
              {firstPlan.unlabelled} of {Math.max(0, firstPlan.stock)} piece{firstPlan.stock === 1 ? '' : 's'} in stock {firstPlan.unlabelled === 1 ? 'has' : 'have'} no label of {firstPlan.unlabelled === 1 ? 'its' : 'their'} own yet.
            </p>
          )}
          {!(unitCodes && unitCodes.length > 0) && (
            <fieldset style={{ border: 0, padding: 0, margin: '10px 0 0' }} data-testid="label-reprint">
              <legend className="muted" style={{ padding: 0, marginBottom: 4 }}>Reprint a damaged label (no new number)</legend>
              <div className="row" style={{ gap: 6 }}>
                <Input aria-label="Label number to reprint" placeholder="Type or scan the label number" value={reprintText} disabled={!!issued}
                  onChange={(e) => setReprintText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void addReprint() } }} />
                <Button type="button" disabled={!reprintText.trim() || !!issued} onClick={() => void addReprint()}>Reprint</Button>
              </div>
              {reprintErr && <div className="field-error" role="alert">{reprintErr}</div>}
              {reprinting && (
                <div style={{ marginTop: 4 }}>
                  Reprinting <strong>{reprint.join(', ')}</strong>. <button type="button" className="btn btn-ghost" onClick={() => { setReprint([]); setCopies(String(initialCopies)) }}>Back to new labels</button>
                </div>
              )}
            </fieldset>
          )}
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
          {unitMode && <div style={{ marginBottom: 6 }} data-testid="label-unit-codes">Unit codes: <strong>{existingCodes.length <= 3 ? existingCodes.join(', ') : `${existingCodes[0]} … ${existingCodes[existingCodes.length - 1]} (${existingCodes.length})`}</strong></div>}
          {!unitMode && firstPlan?.mode === 'unique' && !issued && <div style={{ marginBottom: 6 }} className="muted">The preview shows the next label number{n === 1 ? '' : 's'}. Numbers are given out when you print.</div>}
          {barcode && !unitMode && <div style={{ marginBottom: 6 }}>{firstPlan?.mode === 'unique' ? 'Product barcode' : 'Barcode'}: <strong data-testid="label-barcode" style={{ letterSpacing: '.08em' }}>{barcode}</strong></div>}
          {previewErr ? (
            <InlineAlert tone="bad" title="Cannot preview this label">{previewErr}</InlineAlert>
          ) : !preview || !ready || planning ? (
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

import { useEffect, useMemo, useRef, useState } from 'react'
import { call, errMsg } from '@/lib/api'
import { Button, Card, EmptyState, Field, InlineAlert, NumberInput, Select, SearchInput, Table, useApiAction, useToast, formatMoney } from '@/ui'
import { beepError, beepOk } from '@/ui/sound'
import { createUnitList, isUnitCodeText, notFoundMessage } from '@/modules/inventory/unitScan'
import { LabelPrintDialog } from './LabelPrintDialog'
import { PrintPreview } from './PrintPreview'
import type { PrintResult, Rendered, Variant } from './shared'

interface Row { variantId: number; name: string; sku: string; copies: number }

/** Pick products/variants + copies, preview and print barcode / product labels. */
export function LabelsTab() {
  const { run, loading } = useApiAction()
  const [template, setTemplate] = useState<'label_barcode' | 'label_product'>('label_barcode')
  const [found, setFound] = useState<Variant[]>([])
  const [rows, setRows] = useState<Row[]>([])
  const [preview, setPreview] = useState<Rendered | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [result, setResult] = useState<PrintResult | null>(null)
  const seq = useRef(0)

  const search = async (text: string) => {
    if (!text.trim()) return setFound([])
    const r = await run(() => call<Variant[]>('printing', 'searchVariants', { text, limit: 20 }), { silent: true })
    setFound(r ?? [])
  }
  const add = (v: Variant) => setRows((cur) => (cur.some((r) => r.variantId === v.variantId) ? cur.map((r) => (r.variantId === v.variantId ? { ...r, copies: r.copies + 1 } : r)) : [...cur, { variantId: v.variantId, name: v.displayName, sku: v.sku, copies: 1 }]))

  useEffect(() => {
    const mine = ++seq.current
    const t = setTimeout(async () => {
      try {
        const r = await call<Rendered>('printing', 'renderLabelHtml', { template, variantIds: rows.map((x) => ({ variantId: x.variantId, copies: x.copies })) })
        if (mine === seq.current) { setPreview(r); setErr(null) }
      } catch (e) {
        if (mine === seq.current) { setPreview(null); setErr(e instanceof Error ? e.message : String(e)) }
      }
    }, 250)
    return () => clearTimeout(t)
  }, [rows, template])

  const total = rows.reduce((s, r) => s + r.copies, 0)
  const print = async () => {
    if (!preview || !rows.length) return
    const r = await run(() => call<PrintResult>('printing', 'print', { html: preview.html, paper: 'label', widthMm: preview.widthMm, heightMm: preview.heightMm, docRef: `labels-${total}` }))
    if (r) setResult(r)
  }

  return (
    <>
    <UnitQueueCard />
    <div className="grid2" style={{ gridTemplateColumns: 'minmax(340px, 1fr) minmax(300px, 1fr)', alignItems: 'start' }}>
      <div>
        <Card title="1. Choose products">
          <Field label="Label type">
            <Select value={template} onChange={(e) => setTemplate(e.target.value as typeof template)}>
              <option value="label_barcode">Barcode label (shop, product, barcode, MRP, price)</option>
              <option value="label_product">Product label (logo, product, large price, barcode)</option>
            </Select>
          </Field>
          <SearchInput onSearch={(t) => void search(t)} placeholder="Search by name, SKU or barcode…" />
          {found.length > 0 && (
            <div style={{ marginTop: 8, maxHeight: 220, overflow: 'auto', border: '1px solid var(--line, #ddd)', borderRadius: 8 }}>
              {found.map((v) => (
                <button key={v.variantId} className="btn btn-ghost" style={{ display: 'flex', width: '100%', justifyContent: 'space-between', textAlign: 'left' }} onClick={() => add(v)}>
                  <span>{v.displayName} <span className="muted">{v.sku}</span></span>
                  <span>{formatMoney(v.price)}</span>
                </button>
              ))}
            </div>
          )}
        </Card>
        <Card title={`2. Copies (${total} label${total === 1 ? '' : 's'})`} actions={rows.length > 0 && <Button size="sm" onClick={() => setRows([])}>Clear</Button>}>
          <Table
            rows={rows}
            rowKey={(r) => r.variantId}
            empty={<EmptyState title="No products selected" hint="Search above and click a product to add it. With nothing selected the preview shows your newest product." />}
            columns={[
              { key: 'name', header: 'Product', render: (r) => <span>{r.name} <span className="muted">{r.sku}</span></span> },
              { key: 'copies', header: 'Copies', width: '110px', render: (r) => <NumberInput value={r.copies} min={1} max={500} onChange={(n) => setRows(rows.map((x) => (x.variantId === r.variantId ? { ...x, copies: Math.max(1, n ?? 1) } : x)))} /> },
              { key: 'rm', header: '', align: 'right', render: (r) => <Button size="sm" variant="ghost" onClick={() => setRows(rows.filter((x) => x.variantId !== r.variantId))}>Remove</Button> }
            ]}
          />
          <div className="row" style={{ marginTop: 10 }}>
            <Button variant="primary" onClick={print} disabled={!rows.length || !preview || loading}>Print labels</Button>
          </div>
          {result && <div style={{ marginTop: 8 }}>{!result.ok ? <InlineAlert tone="bad" title="Printing failed">{result.error}. Press Print labels to try again, or check the label printer under Printers.</InlineAlert> : result.warning ? <InlineAlert tone="warn" title="Printed on another printer">{result.warning}</InlineAlert> : <InlineAlert tone="good">Labels sent to the label printer.</InlineAlert>}</div>}
        </Card>
      </div>
      <Card title="Preview">
        {!err && (preview?.warnings ?? []).map((w) => <div key={w} style={{ marginBottom: 8 }}><InlineAlert tone="warn" title="Check the barcode">{w}</InlineAlert></div>)}
        {err ? <EmptyState title="No label to preview" hint={err} /> : preview ? <PrintPreview html={preview.html} widthMm={preview.widthMm + 8} scale={1.4} maxHeight="70vh" /> : null}
      </Card>
    </div>
    </>
  )
}

interface QueuedUnit { code: string; name: string; variantId: number }

/**
 * Label print queue for UNIT labels (PREFIX-NNNN, Code 128). Scan or type a unit code to queue it; the queue is an ACTIVE LIST:
 * a code that is already queued is not added again (duplicate warning), an unknown code gets a clear "not found" message.
 */
function UnitQueueCard() {
  const toast = useToast()
  const list = useMemo(() => createUnitList('the label print queue'), [])
  const [queue, setQueue] = useState<QueuedUnit[]>([])
  const [text, setText] = useState('')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [dialog, setDialog] = useState(false)

  const submit = async () => {
    const code = text.trim()
    if (!code) return
    setText('')
    if (!isUnitCodeText(code)) {
      beepError()
      return setMsg({ ok: false, text: `"${code}" is not a unit code. Unit codes look like SPK-0001.` })
    }
    if (list.claim(code) === 'duplicate') {
      beepError()
      return setMsg({ ok: false, text: list.duplicateText(code) })
    }
    try {
      const r = await call<{ unit: { code: string; status: string; variantId: number }; variant: { displayName: string } } | null>('units', 'resolve', { code })
      if (!r) {
        list.release(code)
        beepError()
        return setMsg({ ok: false, text: notFoundMessage(code) })
      }
      if (r.unit.status === 'void') {
        list.release(code)
        beepError()
        return setMsg({ ok: false, text: `Unit ${r.unit.code} is void and cannot be labelled.` })
      }
      list.bind(r.unit.code, r.unit.variantId)
      setQueue((q) => [...q, { code: r.unit.code, name: r.variant.displayName, variantId: r.unit.variantId }])
      beepOk()
      setMsg({ ok: true, text: `${r.unit.code} added to the print queue (${r.variant.displayName}).` })
    } catch (e) {
      list.release(code)
      beepError()
      setMsg({ ok: false, text: errMsg(e) })
    }
  }

  return (
    <Card title={`Unit labels queue (${queue.length})`} actions={queue.length > 0 && <Button size="sm" onClick={() => { list.clear(); setQueue([]); setMsg(null) }}>Clear</Button>}>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <input className="input" style={{ maxWidth: 300 }} aria-label="Scan unit code" data-testid="unit-queue-input" data-scanbox="true" placeholder="Scan a unit code (SPK-0001) and press Enter" value={text}
          onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Tab') { if (text.trim()) e.preventDefault(); void submit() } }} />
        <Button variant="primary" disabled={!queue.length} onClick={() => setDialog(true)}>Print unit labels…</Button>
        {msg && <span role="status" data-testid="unit-queue-msg" data-ok={msg.ok ? '1' : '0'} style={msg.ok ? undefined : { color: 'var(--bad, #c0392b)' }}>{msg.text}</span>}
      </div>
      {queue.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }} data-testid="unit-queue-list">
          {queue.map((u) => (
            <span key={u.code} className="badge" title={u.name}>{u.code} <button type="button" className="btn btn-ghost" aria-label={`Remove ${u.code}`} onClick={() => { list.release(u.code); setQueue((q) => q.filter((x) => x.code !== u.code)); toast(`${u.code} removed from the queue`, 'info') }}>✕</button></span>
          ))}
        </div>
      )}
      <LabelPrintDialog open={dialog} onClose={() => setDialog(false)} variantIds={[]} unitCodes={queue.map((u) => u.code)} unitVariantId={new Set(queue.map((u) => u.variantId)).size === 1 ? queue[0].variantId : undefined} />
    </Card>
  )
}

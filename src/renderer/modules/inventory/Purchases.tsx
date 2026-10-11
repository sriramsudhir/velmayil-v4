import { useEffect, useMemo, useState } from 'react'
import { LabelPrintDialog } from '@/modules/printing/LabelPrintDialog'
import { createUnitList } from './unitScan'
import { useLocation, useNavigate } from 'react-router-dom'
import { call, errMsg } from '@/lib/api'
import { useLiveRefresh } from '@/lib/live'
import { useSession } from '@/lib/session'
import { formatINR, pctOf } from '@shared/money'
import { Badge, Button, Card, ErrorState, Field, Input, Modal, PageHeader, Select, Spinner, Table, TextArea, useAsync, useToast } from '@/ui'
import { Pager, ProductPicker, fmtDate, paiseToText, rupeesToPaise, useDebounced, type Loc, type Page, type Picked } from './common'
import type { Supplier } from './Suppliers'

interface PRow { id: number; number: string; supplierName: string | null; supplierInvoiceNo: string; status: string; total: number; paid: number; due: number; createdAt: number; locationName: string }
interface PDetail extends PRow {
  subtotal: number; tax: number; note: string; cancelReason: string | null; userName: string | null
  items: { id: number; displayName: string; sku: string; qty: number; unitCost: number; taxRateBp: number; total: number }[]
  payments: { id: number; amount: number; method: string; createdAt: number }[]
}

export function PurchasesPage() {
  const nav = useNavigate()
  const toast = useToast()
  const { can } = useSession()
  const [search, setSearch] = useState('')
  const [unpaid, setUnpaid] = useState(false)
  const [offset, setOffset] = useState(0)
  const [view, setView] = useState<number | null>(null)
  const dsearch = useDebounced(search)
  const { data, loading, error, reload } = useAsync(() => call<Page<PRow>>('purchases', 'list', { search: dsearch || undefined, unpaidOnly: unpaid, limit: 50, offset }), [dsearch, unpaid, offset])
  useLiveRefresh(['inventory', 'catalog', 'pos', 'purchases'], reload)
  const detail = useAsync(() => (view ? call<PDetail>('purchases', 'get', { id: view }) : Promise.resolve(undefined)), [view])
  const [payAmt, setPayAmt] = useState('')
  const [cancelReason, setCancelReason] = useState('')
  const [cancelling, setCancelling] = useState(false)
  const [acting, setActing] = useState(false)
  // what was typed for one purchase must not be waiting in the box when another purchase is opened
  useEffect(() => { setPayAmt(''); setCancelReason(''); setCancelling(false) }, [view])

  const pay = async () => {
    const amount = rupeesToPaise(payAmt)
    if (acting || !view || !amount) return // Enter pressed twice must not record the payment twice
    setActing(true)
    try { await call('purchases', 'recordPayment', { purchaseId: view, amount }); setPayAmt(''); toast('Payment recorded', 'good'); detail.reload(); reload() } catch (e) { toast(errMsg(e), 'bad') } finally { setActing(false) }
  }
  const cancel = async () => {
    if (acting || !view) return
    setActing(true)
    try { await call('purchases', 'cancel', { id: view, reason: cancelReason }); toast('Purchase cancelled and stock reversed', 'good'); setCancelling(false); setCancelReason(''); detail.reload(); reload() } catch (e) { toast(errMsg(e), 'bad') } finally { setActing(false) }
  }
  // never show (or act on) the previously opened purchase while the next one is still loading
  const d = detail.data && detail.data.id === view ? detail.data : undefined
  return (
    <div className="page">
      <PageHeader title="Purchases" actions={can('purchases.edit') ? <Button variant="primary" onClick={() => nav('/inventory/purchases/new')}>New purchase</Button> : undefined} />
      <div className="toolbar" style={{ marginBottom: 12, gap: 12 }}>
        <Input autoFocus placeholder="Search number, supplier, invoice…" value={search} onChange={(e) => { setSearch(e.target.value); setOffset(0) }} style={{ maxWidth: 300 }} aria-label="Search purchases" />
        <label className="check"><input type="checkbox" checked={unpaid} onChange={(e) => { setUnpaid(e.target.checked); setOffset(0) }} /> Unpaid only</label>
      </div>
      {error ? <ErrorState message={error} onRetry={reload} /> : loading && !data ? <Spinner /> : (
        <>
          <Table rows={data?.rows ?? []} rowKey={(r) => r.id} onRowClick={(r) => setView(r.id)} columns={[
            { key: 'number', header: 'Purchase' },
            { key: 'createdAt', header: 'Date', render: (r) => fmtDate(r.createdAt) },
            { key: 'supplierName', header: 'Supplier', render: (r) => r.supplierName ?? '—' },
            { key: 'supplierInvoiceNo', header: 'Supplier invoice' },
            { key: 'total', header: 'Total', align: 'right', render: (r) => <span className="num">{formatINR(r.total)}</span> },
            { key: 'due', header: 'Due', align: 'right', render: (r) => <span className="num">{r.status === 'cancelled' ? '' : formatINR(r.due)}</span> },
            { key: 'status', header: 'Status', render: (r) => <Badge tone={r.status === 'cancelled' ? 'bad' : r.due > 0 ? 'warn' : 'good'}>{r.status === 'cancelled' ? 'cancelled' : r.due > 0 ? 'due' : 'paid'}</Badge> }
          ]} />
          <Pager total={data?.total ?? 0} limit={50} offset={offset} onChange={setOffset} />
        </>
      )}
      <Modal wide title={d ? `Purchase ${d.number}` : 'Purchase'} open={!!view} onClose={() => { setView(null); setCancelling(false) }} footer={<Button onClick={() => setView(null)}>Close</Button>}>
        {!d ? (detail.error && !detail.loading ? <ErrorState message={detail.error} onRetry={detail.reload} /> : <Spinner />) : (
          <>
            <p className="muted">{fmtDate(d.createdAt)} · {d.supplierName ?? 'No supplier'}{d.supplierInvoiceNo ? ` · invoice ${d.supplierInvoiceNo}` : ''} · {d.locationName}{d.userName ? ` · by ${d.userName}` : ''}</p>
            {d.status === 'cancelled' && <p role="status"><Badge tone="bad">Cancelled</Badge> {d.cancelReason}</p>}
            <Table rows={d.items} rowKey={(i) => i.id} columns={[
              { key: 'displayName', header: 'Product', render: (i) => <>{i.displayName} <span className="muted">{i.sku}</span></> },
              { key: 'qty', header: 'Qty', align: 'right' },
              { key: 'unitCost', header: 'Unit cost', align: 'right', render: (i) => formatINR(i.unitCost) },
              { key: 'taxRateBp', header: 'GST', align: 'right', render: (i) => `${i.taxRateBp / 100}%` },
              { key: 'total', header: 'Total', align: 'right', render: (i) => formatINR(i.total) }
            ]} />
            <p style={{ textAlign: 'right', marginTop: 8 }}>Subtotal {formatINR(d.subtotal)} · GST {formatINR(d.tax)} · <strong>Total {formatINR(d.total)}</strong> · Paid {formatINR(d.paid)} · <strong>Due {formatINR(d.due)}</strong></p>
            {can('purchases.edit') && d.status !== 'cancelled' && (
              <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
                {d.due > 0 && <>
                  <Input style={{ width: 140 }} placeholder="Payment ₹" value={payAmt} onChange={(e) => setPayAmt(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void pay()} aria-label="Payment amount" />
                  <Button disabled={acting || !rupeesToPaise(payAmt)} onClick={pay}>Record payment</Button>
                </>}
                <span className="toolbar-spacer" />
                {cancelling ? <>
                  <Input style={{ width: 240 }} autoFocus placeholder="Reason for cancelling" value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} aria-label="Cancel reason" />
                  <Button variant="danger" disabled={acting || !cancelReason.trim()} onClick={cancel}>Confirm cancel</Button>
                </> : <Button variant="danger" onClick={() => setCancelling(true)}>Cancel purchase</Button>}
              </div>
            )}
          </>
        )}
      </Modal>
    </div>
  )
}

// ------------------------------------------------------------------ purchase entry
interface Line { variantId: number; displayName: string; sku: string; qty: number; cost: string; taxBp: number }

export function PurchaseEntryPage() {
  const nav = useNavigate()
  const toast = useToast()
  const preset = (useLocation().state as { lines?: { variantId: number; displayName: string; sku: string; qty: number; cost: number; taxRateBp: number }[] } | null)?.lines
  const suppliers = useAsync(() => call<Page<Supplier>>('purchases', 'supplierList', { limit: 500 }), [])
  const locs = useAsync(() => call<Loc[]>('inventory', 'locations'), [])
  const [supplierId, setSupplierId] = useState('')
  const [invoiceNo, setInvoiceNo] = useState('')
  const [locationId, setLocationId] = useState('')
  const [note, setNote] = useState('')
  const [paid, setPaid] = useState('')
  const [lines, setLines] = useState<Line[]>(() => (preset ?? []).map((l) => ({ variantId: l.variantId, displayName: l.displayName, sku: l.sku, qty: l.qty, cost: paiseToText(l.cost), taxBp: l.taxRateBp })))
  const [busy, setBusy] = useState(false)
  // ACTIVE LIST of this goods-receiving screen (scanned unit codes)
  const units = useMemo(() => createUnitList('this purchase'), [])
  const [received, setReceived] = useState<{ number: string; made: { variantId: number; name: string; codes: string[] }[] } | null>(null)
  const [labelsFor, setLabelsFor] = useState<{ codes: string[]; variantId?: number } | null>(null)

  useEffect(() => { window.history.replaceState({}, '') }, [])

  const add = (p: Picked) =>
    setLines((ls) => ls.some((l) => l.variantId === p.variantId)
      ? ls.map((l) => l.variantId === p.variantId ? { ...l, qty: l.qty + 1 } : l)
      : [...ls, { variantId: p.variantId, displayName: p.displayName, sku: p.sku, qty: 1, cost: paiseToText(p.cost), taxBp: p.taxRateBp }])
  const upd = (id: number, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.variantId === id ? { ...l, ...patch } : l)))

  const calc = lines.map((l) => { const base = l.qty * rupeesToPaise(l.cost); const tax = pctOf(base, l.taxBp); return { base, tax, total: base + tax } })
  const subtotal = calc.reduce((s, c) => s + c.base, 0)
  const tax = calc.reduce((s, c) => s + c.tax, 0)
  const total = subtotal + tax
  const paidP = rupeesToPaise(paid)
  const valid = lines.length > 0 && lines.every((l) => l.qty > 0 && rupeesToPaise(l.cost) > 0) && paidP <= total

  const save = async () => {
    if (busy || !valid) return
    setBusy(true)
    try {
      const r = await call<{ number: string; costChanges: unknown[]; items?: { variantId: number; qty: number; unitCodes?: string[] }[] }>('purchases', 'create', {
        supplierId: supplierId ? Number(supplierId) : undefined, supplierInvoiceNo: invoiceNo || undefined,
        locationId: locationId ? Number(locationId) : undefined, note: note || undefined, paid: paidP || undefined,
        items: lines.map((l) => ({ variantId: l.variantId, qty: l.qty, unitCost: rupeesToPaise(l.cost), taxRateBp: l.taxBp }))
      })
      toast(`Purchase ${r.number} saved. Stock received.`, 'good')
      units.clear()
      // tracked products got a unique code per unit: show them with a "Print labels" button before leaving
      const made = (r.items ?? []).filter((it) => it.unitCodes && it.unitCodes.length).map((it) => ({ variantId: it.variantId, name: lines.find((l) => l.variantId === it.variantId)?.displayName ?? `#${it.variantId}`, codes: it.unitCodes! }))
      if (made.length) setReceived({ number: r.number, made })
      else nav('/inventory/purchases')
    } catch (e) { toast(errMsg(e), 'bad') } finally { setBusy(false) }
  }

  return (
    <div className="page" onKeyDown={(e) => { if (e.key === 'Enter' && e.ctrlKey && valid && !busy) void save() }}>
      <PageHeader title="New purchase" subtitle="Receive goods from a supplier · Ctrl+Enter to save" actions={<><Button onClick={() => nav('/inventory/purchases')}>Cancel</Button><Button variant="primary" disabled={!valid || busy} onClick={save}>Save &amp; receive stock</Button></>} />
      <Card>
        <div className="form-grid">
          <Field label="Supplier">
            <Select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}><option value="">— none —</option>{suppliers.data?.rows.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>
          </Field>
          <Field label="Supplier invoice no."><Input value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} /></Field>
          {(locs.data?.length ?? 0) > 1 && <Field label="Receive into"><Select value={locationId} onChange={(e) => setLocationId(e.target.value)}><option value="">Default location</option>{locs.data?.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select></Field>}
        </div>
      </Card>
      <div className="toolbar" style={{ margin: '12px 0' }}><ProductPicker autoFocus placeholder="Scan barcode or search product to add…" onPick={add} unitList={units}
        onKnownUnit={(u) => `${u.code} is already a known unit (${u.status.replace('_', ' ')}), so it is not received again. New units of tracked products get their codes automatically when you save.`} /></div>
      <Table rows={lines} rowKey={(l) => l.variantId} empty={<Card><p className="muted">Scan or search to add products.</p></Card>} columns={[
        { key: 'displayName', header: 'Product', render: (l) => <>{l.displayName} <span className="muted">{l.sku}</span></> },
        { key: 'qty', header: 'Qty', align: 'right', render: (l) => <Input type="number" min={1} style={{ width: 80, textAlign: 'right' }} value={l.qty} aria-label={`Quantity ${l.displayName}`} onChange={(e) => upd(l.variantId, { qty: Math.max(0, Math.floor(Number(e.target.value))) })} /> },
        { key: 'cost', header: 'Unit cost ₹ (excl. GST)', align: 'right', render: (l) => <Input style={{ width: 110, textAlign: 'right' }} inputMode="decimal" value={l.cost} aria-label={`Unit cost ${l.displayName}`} onChange={(e) => upd(l.variantId, { cost: e.target.value })} /> },
        { key: 'taxBp', header: 'GST %', align: 'right', render: (l) => <Input type="number" min={0} step={0.5} style={{ width: 80, textAlign: 'right' }} value={l.taxBp / 100} aria-label={`GST ${l.displayName}`} onChange={(e) => upd(l.variantId, { taxBp: Math.max(0, Math.round(Number(e.target.value) * 100)) })} /> },
        { key: 'total', header: 'Line total', align: 'right', render: (l) => <span className="num">{formatINR(calc[lines.indexOf(l)]?.total ?? 0)}</span> },
        { key: 'rm', header: '', render: (l) => <Button variant="ghost" aria-label={`Remove ${l.displayName}`} onClick={() => setLines((ls) => ls.filter((x) => x.variantId !== l.variantId))}>✕</Button> }
      ]} />
      {lines.length > 0 && !lines.every((l) => l.qty > 0 && rupeesToPaise(l.cost) > 0) && (
        <p className="field-error" role="alert" style={{ margin: '8px 0' }}>Enter a quantity and a unit cost (more than 0) for every product before saving.</p>
      )}
      <Card>
        <div className="form-grid">
          <Field label="Note"><TextArea rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
          <Field label="Paid now ₹" error={paidP > total ? 'More than the total' : undefined}><Input inputMode="decimal" value={paid} onChange={(e) => setPaid(e.target.value)} /></Field>
        </div>
        <p style={{ textAlign: 'right', marginTop: 8 }}>Subtotal {formatINR(subtotal)} · GST {formatINR(tax)} · <strong>Total {formatINR(total)}</strong> · Due {formatINR(Math.max(0, total - paidP))}</p>
      </Card>
      <Modal wide open={!!received} onClose={() => nav('/inventory/purchases')} title={received ? `Purchase ${received.number}: unit codes issued` : 'Unit codes'}
        footer={<><Button onClick={() => nav('/inventory/purchases')}>Done</Button>
          <Button variant="primary" data-testid="print-received-labels" onClick={() => received && setLabelsFor({ codes: received.made.flatMap((m) => m.codes), variantId: received.made.length === 1 ? received.made[0].variantId : undefined })}>Print labels</Button></>}>
        {received?.made.map((m) => (
          <p key={m.variantId} data-testid="received-codes"><strong>{m.name}</strong>: {m.codes.length <= 6 ? m.codes.join(', ') : `${m.codes[0]} to ${m.codes[m.codes.length - 1]}`} <span className="muted">({m.codes.length} unit{m.codes.length === 1 ? '' : 's'})</span></p>
        ))}
        <p className="muted">Stick one label on each unit. The code is scanned when selling, counting and transferring.</p>
      </Modal>
      <LabelPrintDialog open={labelsFor !== null} onClose={() => setLabelsFor(null)} variantIds={[]} unitCodes={labelsFor?.codes ?? []} unitVariantId={labelsFor?.variantId} />

    </div>
  )
}

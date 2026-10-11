import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Badge, Button, ErrorState, Field, Input, Modal, PageHeader, Select, Spinner, Table, useAsync, useToast } from '@/ui'
import { call, errMsg, ApiError } from '@/lib/api'
import { useSession } from '@/lib/session'
import { useLiveRefresh } from '@/lib/live'
import { formatINR } from '@shared/money'
import { ApprovalDialog } from '@/modules/auth/ApprovalDialog'
import { PrintActions } from './parts'
import { DeleteSaleDialog, TrashIcon, type DeletableSale } from './DeleteSaleDialog'
import './pos.css'

interface SaleRow {
  id: number; invoiceNo: string; createdAt: number; status: 'completed' | 'void'; total: number; paid: number
  customerName: string; customerPhone: string; cashierName: string; itemCount: number; returnedTotal: number
}
interface SaleItem { id: number; name: string; sku: string; qty: number; unitPrice: number; discount: number; taxAmount: number; lineTotal: number; returnedQty: number; returnableQty: number
  /** tracked per unit: codes sold on this line, and which of them are already returned (units backend) */
  unitCodes?: string[]; returnedUnitCodes?: string[] }
interface SaleDoc {
  id: number; invoiceNo: string; createdAt: number; status: 'completed' | 'void'; subtotal: number; discount: number; tax: number; roundOff: number
  total: number; paid: number; changeGiven: number; voidReason: string | null; customerName: string; customerPhone: string; cashierName: string; posName: string
  items: SaleItem[]; payments: { method: string; amount: number; reference: string | null }[]
  returns: { id: number; returnNo: string; total: number; createdAt: number; reason: string; refundMethod: string }[]
}

const dayStart = (d: string) => (d ? new Date(`${d}T00:00:00`).getTime() : undefined)
const dayEnd = (d: string) => (d ? new Date(`${d}T23:59:59.999`).getTime() : undefined)

export function SalesHistory() {
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [page, setPage] = useState(0)
  const { can } = useSession()
  // /pos/history?sale=<id> opens that bill (the dashboard's "Recent sales" rows link here)
  const [params, setParams] = useSearchParams()
  const linked = Number(params.get('sale'))
  const [openId, setOpenId] = useState<number | null>(Number.isInteger(linked) && linked > 0 ? linked : null)
  const [deleting, setDeleting] = useState<DeletableSale | null>(null)
  const closeDetail = () => { setOpenId(null); if (params.has('sale')) setParams({}, { replace: true }) }
  const canDelete = can('pos.delete')
  const limit = 25
  const { data, loading, error, reload } = useAsync(
    () => call<{ rows: SaleRow[]; total: number }>('pos', 'listSales', { search: search || undefined, status: status || undefined, from: dayStart(from), to: dayEnd(to), limit, offset: page * limit }),
    [search, status, from, to, page]
  )
  useLiveRefresh(['pos'], reload)
  return (
    <div className="page">
      <PageHeader title="Sales history" subtitle="Reprint, return, void or delete bills" actions={<Link to="/pos"><Button>Back to billing</Button></Link>} />
      <div className="row" style={{ marginBottom: 12 }}>
        <Input style={{ width: 260 }} placeholder="Invoice no, customer name or phone" value={search} onChange={(e) => { setSearch(e.target.value); setPage(0) }} aria-label="Search sales" />
        <Select style={{ width: 150 }} value={status} onChange={(e) => { setStatus(e.target.value); setPage(0) }} aria-label="Status">
          <option value="">All statuses</option><option value="completed">Completed</option><option value="void">Void</option>
        </Select>
        <Input type="date" style={{ width: 160 }} value={from} onChange={(e) => { setFrom(e.target.value); setPage(0) }} aria-label="From date" />
        <Input type="date" style={{ width: 160 }} value={to} onChange={(e) => { setTo(e.target.value); setPage(0) }} aria-label="To date" />
      </div>
      {error ? <ErrorState message={error} onRetry={reload} /> : loading && !data ? <Spinner /> : (
        <>
          <Table
            rows={data?.rows ?? []} rowKey={(r) => r.id} onRowClick={(r) => setOpenId(r.id)}
            columns={[
              { key: 'invoiceNo', header: 'Invoice' },
              { key: 'createdAt', header: 'Date', render: (r) => new Date(r.createdAt).toLocaleString() },
              { key: 'customerName', header: 'Customer', render: (r) => r.customerName || <span className="muted">Walk-in</span> },
              { key: 'cashierName', header: 'Cashier' },
              { key: 'itemCount', header: 'Items', align: 'right' },
              { key: 'total', header: 'Total', align: 'right', render: (r) => formatINR(r.total) },
              { key: 'returnedTotal', header: 'Returned', align: 'right', render: (r) => (r.returnedTotal ? formatINR(r.returnedTotal) : '') },
              { key: 'status', header: 'Status', render: (r) => <Badge tone={r.status === 'void' ? 'bad' : r.returnedTotal ? 'warn' : 'good'}>{r.status === 'void' ? 'Void' : r.returnedTotal ? 'Returned' : 'Completed'}</Badge> },
              ...(canDelete ? [{
                key: 'actions', header: '', align: 'right' as const, width: '48px', render: (r: SaleRow) => (
                  <Button variant="ghost" size="sm" className="del-sale-icon" title="Delete this invoice" aria-label={`Delete invoice ${r.invoiceNo}`}
                    onClick={(e) => { e.stopPropagation(); setDeleting(r) }} onKeyDown={(e) => e.stopPropagation()}>
                    <TrashIcon />
                  </Button>
                )
              }] : [])
            ]}
          />
          <div className="row" style={{ marginTop: 10, justifyContent: 'space-between' }}>
            <span className="muted">{data?.total ?? 0} sales</span>
            <span className="row">
              <Button disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</Button>
              <Button disabled={(page + 1) * limit >= (data?.total ?? 0)} onClick={() => setPage(page + 1)}>Next</Button>
            </span>
          </div>
        </>
      )}
      {openId != null && <SaleDetail id={openId} onClose={closeDetail} onChanged={reload} onDeleted={() => { closeDetail(); reload() }} />}
      {deleting && <DeleteSaleDialog sale={deleting} onClose={() => setDeleting(null)} onDeleted={() => { setDeleting(null); reload() }} />}
    </div>
  )
}

function SaleDetail({ id, onClose, onChanged, onDeleted }: { id: number; onClose: () => void; onChanged: () => void; onDeleted: () => void }) {
  const { can } = useSession()
  const { data: sale, loading, error, reload } = useAsync(() => call<SaleDoc>('pos', 'getSale', { id }), [id])
  const [returning, setReturning] = useState(false)
  const [voiding, setVoiding] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [lastReturn, setLastReturn] = useState<{ returnId: number; returnNo: string } | null>(null)
  const refresh = () => { reload(); onChanged() }

  return (
    <Modal title={sale ? `Invoice ${sale.invoiceNo}` : 'Sale'} open onClose={onClose} wide
      footer={sale && (
        <>
          {can('pos.return') && sale.status === 'completed' && sale.items.some((i) => i.returnableQty > 0) && <Button onClick={() => setReturning(true)}>Return items…</Button>}
          {can('pos.void') && sale.status === 'completed' && sale.returns.length === 0 && <Button variant="danger" onClick={() => setVoiding(true)}>Void sale…</Button>}
          {can('pos.delete') && <Button variant="danger" onClick={() => setDeleting(true)} aria-label={`Delete invoice ${sale.invoiceNo}`}><TrashIcon /> Delete…</Button>}
          <Button onClick={onClose}>Close</Button>
        </>
      )}>
      {error ? <ErrorState message={error} onRetry={reload} /> : loading || !sale ? <Spinner /> : (
        <>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div>
              <div>{new Date(sale.createdAt).toLocaleString()} · {sale.posName} · {sale.cashierName}</div>
              <div className="muted">{sale.customerName ? `${sale.customerName} ${sale.customerPhone}` : 'Walk-in customer'}</div>
            </div>
            <Badge tone={sale.status === 'void' ? 'bad' : 'good'}>{sale.status === 'void' ? 'Void' : 'Completed'}</Badge>
          </div>
          {sale.status === 'void' && <p className="pos-bad">Voided: {sale.voidReason}</p>}
          <Table
            rows={sale.items} rowKey={(r) => r.id}
            columns={[
              { key: 'name', header: 'Item', render: (r) => <><strong>{r.name}</strong> <span className="muted">{r.sku}</span>{r.unitCodes?.length ? <div className="muted" data-testid="sale-unit-codes">{r.unitCodes.join(', ')}</div> : null}</> },
              { key: 'qty', header: 'Qty', align: 'right' },
              { key: 'unitPrice', header: 'Price', align: 'right', render: (r) => formatINR(r.unitPrice) },
              { key: 'discount', header: 'Disc', align: 'right', render: (r) => (r.discount ? formatINR(r.discount) : '') },
              { key: 'lineTotal', header: 'Total', align: 'right', render: (r) => formatINR(r.lineTotal) },
              { key: 'returnedQty', header: 'Returned', align: 'right', render: (r) => (r.returnedQty ? r.returnedQty : '') }
            ]}
          />
          <div className="pos-panel pos-totals" style={{ marginTop: 10 }}>
            <div><span>Subtotal</span><span>{formatINR(sale.subtotal)}</span></div>
            <div><span>Discount</span><span>−{formatINR(sale.discount)}</span></div>
            <div><span>GST</span><span>{formatINR(sale.tax)}</span></div>
            <div><span>Round off</span><span>{formatINR(sale.roundOff)}</span></div>
            <div><strong>Total</strong><strong>{formatINR(sale.total)}</strong></div>
            <div className="muted"><span>Paid by {sale.payments.map((p) => `${p.method.toUpperCase()} ${formatINR(p.amount)}`).join(', ') || '—'}</span><span>Change {formatINR(sale.changeGiven)}</span></div>
          </div>
          {sale.returns.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <strong>Returns</strong>
              {sale.returns.map((r) => (
                <div key={r.id} className="row" style={{ justifyContent: 'space-between', padding: '4px 0' }}>
                  <span>{r.returnNo} · {new Date(r.createdAt).toLocaleDateString()} · {r.reason}</span>
                  <span className="row"><strong>{formatINR(r.total)}</strong>{can('pos.reprint') && <PrintActions printRef={{ returnId: r.id }} invoiceNo={r.returnNo} />}</span>
                </div>
              ))}
            </div>
          )}
          {lastReturn && <p className="pos-good">Return {lastReturn.returnNo} saved.</p>}
          {can('pos.reprint') && <div style={{ marginTop: 12 }}><div className="field-label" style={{ fontWeight: 600, fontSize: 12, color: 'var(--muted)' }}>Reprint</div><PrintActions printRef={{ saleId: sale.id }} invoiceNo={sale.invoiceNo} /></div>}
          {returning && <ReturnDialog sale={sale} onClose={() => setReturning(false)} onDone={(r) => { setReturning(false); setLastReturn(r); refresh() }} />}
          {voiding && <VoidDialog sale={sale} onClose={() => setVoiding(false)} onDone={() => { setVoiding(false); refresh() }} />}
          {deleting && (
            <DeleteSaleDialog
              sale={{ id: sale.id, invoiceNo: sale.invoiceNo, total: sale.total, createdAt: sale.createdAt, customerName: sale.customerName, status: sale.status, returnedTotal: sale.returns.reduce((t, r) => t + r.total, 0) }}
              onClose={() => setDeleting(false)} onDeleted={() => { setDeleting(false); onDeleted() }}
            />
          )}
        </>
      )}
    </Modal>
  )
}

const newId = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`)

function ReturnDialog({ sale, onClose, onDone }: { sale: SaleDoc; onClose: () => void; onDone: (r: { returnId: number; returnNo: string }) => void }) {
  const toast = useToast()
  const [qty, setQty] = useState<Record<number, number>>({})
  const [restock, setRestock] = useState<Record<number, boolean>>({})
  const [units, setUnits] = useState<Record<number, string[]>>({}) // tracked lines: the unit codes being returned
  const [method, setMethod] = useState<'cash' | 'original'>('cash')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const requestId = useRef(newId())
  const items = sale.items.filter((i) => i.returnableQty > 0)
  const tracked = (i: SaleItem) => !!i.unitCodes?.length
  const returnedQty = (i: SaleItem) => (tracked(i) ? (units[i.id]?.length ?? 0) : (qty[i.id] ?? 0))
  const chosen = items.filter((i) => returnedQty(i) > 0)
  // indicative refund (the server computes the authoritative amount)
  const estimate = chosen.reduce((a, i) => a + Math.round((i.lineTotal * returnedQty(i)) / i.qty), 0)
  useEffect(() => { requestId.current = newId() }, [qty, restock, units, method, reason])
  const returnable = (i: SaleItem) => (i.unitCodes ?? []).filter((c) => !(i.returnedUnitCodes ?? []).includes(c))
  const toggleUnit = (i: SaleItem, c: string, on: boolean) => setUnits((u) => {
    const cur = u[i.id] ?? []
    return { ...u, [i.id]: on ? [...cur.filter((x) => x !== c), c] : cur.filter((x) => x !== c) }
  })

  const submit = async () => {
    if (busy) return
    setBusy(true); setErr(null)
    try {
      const r = await call<{ returnId: number; returnNo: string; total: number }>('pos', 'createReturn', {
        requestId: requestId.current, saleId: sale.id, refundMethod: method, reason,
        items: chosen.map((i) => ({ saleItemId: i.id, qty: returnedQty(i), restock: restock[i.id] ?? true, ...(tracked(i) ? { unitCodes: units[i.id] } : {}) }))
      })
      toast(`Return ${r.returnNo} saved · refund ${formatINR(r.total)}`, 'good')
      onDone(r)
    } catch (e) { setErr(errMsg(e)) } finally { setBusy(false) }
  }
  return (
    <Modal title={`Return against ${sale.invoiceNo}`} open onClose={() => !busy && onClose()} wide
      footer={<><Button onClick={onClose} disabled={busy}>Cancel</Button><Button variant="primary" disabled={busy || !chosen.length || !reason.trim()} onClick={submit}>Refund about {formatINR(estimate)}</Button></>}>
      <Table
        rows={items} rowKey={(r) => r.id}
        columns={[
          { key: 'name', header: 'Item' },
          { key: 'returnableQty', header: 'Can return', align: 'right', render: (r) => `${r.returnableQty} of ${r.qty}` },
          { key: 'q', header: 'Return qty', align: 'right', render: (r) => tracked(r) ? (
            <div data-testid="return-units" style={{ textAlign: 'left' }}>
              <div className="muted" style={{ fontSize: 12 }}>Which units are coming back?</div>
              {returnable(r).map((c) => (
                <label key={c} className="row" style={{ gap: 6 }}>
                  <input type="checkbox" checked={(units[r.id] ?? []).includes(c)} onChange={(e) => toggleUnit(r, c, e.target.checked)} aria-label={`Return unit ${c}`} /> <code>{c}</code>
                </label>
              ))}
            </div>
          ) : (
            <input className="input pos-num" style={{ width: 70 }} inputMode="numeric" value={qty[r.id] ?? 0} aria-label={`Return quantity for ${r.name}`}
              onFocus={(e) => e.target.select()}
              onChange={(e) => setQty({ ...qty, [r.id]: Math.min(r.returnableQty, Math.max(0, Number(e.target.value.replace(/\D/g, '')) || 0)) })} />
          ) },
          { key: 'r', header: 'Back to stock', render: (r) => <input type="checkbox" checked={restock[r.id] ?? true} onChange={(e) => setRestock({ ...restock, [r.id]: e.target.checked })} aria-label={`Restock ${r.name}`} /> }
        ]}
      />
      <div className="grid2" style={{ marginTop: 12 }}>
        <Field label="Refund method">
          <Select value={method} onChange={(e) => setMethod(e.target.value as 'cash' | 'original')}>
            <option value="cash">Cash from drawer</option><option value="original">Original payment method(s)</option>
          </Select>
        </Field>
        <Field label="Reason (required)"><Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} /></Field>
      </div>
      {err && <p className="pos-bad" role="alert">{err}</p>}
    </Modal>
  )
}

function VoidDialog({ sale, onClose, onDone }: { sale: SaleDoc; onClose: () => void; onDone: () => void }) {
  const toast = useToast()
  const [reason, setReason] = useState('')
  const [needApproval, setNeedApproval] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const submit = async (approvalId?: number) => {
    if (busy) return
    setBusy(true); setErr(null)
    try {
      await call('pos', 'voidSale', { saleId: sale.id, reason, approval: approvalId ? { approvalId } : undefined })
      toast(`${sale.invoiceNo} voided`, 'good')
      onDone()
    } catch (e) {
      if (e instanceof ApiError && e.code === 'APPROVAL_REQUIRED') setNeedApproval(true)
      setErr(errMsg(e))
    } finally { setBusy(false) }
  }
  return (
    <Modal title={`Void ${sale.invoiceNo}`} open onClose={() => !busy && onClose()}
      footer={<><Button onClick={onClose} disabled={busy}>Cancel</Button><Button variant="danger" disabled={busy || reason.trim().length < 3} onClick={() => void submit()}>Void sale</Button></>}>
      <p>This cancels the whole bill, returns all items to stock and takes the cash back out of the drawer. It cannot be undone.</p>
      <Field label="Reason (required)"><Input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} /></Field>
      {needApproval && (
        <ApprovalDialog
          action="pos.void" entity="sale" entityId={sale.id} title="Manager approval required"
          description={`Voiding ${sale.invoiceNo} needs a manager's approval.`}
          onCancel={() => setNeedApproval(false)}
          onApproved={(r) => { setNeedApproval(false); void submit(r.approvalId) }}
        />
      )}
      {err && <p className="pos-bad" role="alert">{err}</p>}
    </Modal>
  )
}

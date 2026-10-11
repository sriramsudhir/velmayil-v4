import { useCallback, useEffect, useMemo, useState } from 'react'
import { Navigate, useNavigate, useParams } from 'react-router-dom'
import type { ReportColumn, ReportExportResult, ReportFilters, ReportMeta, ReportOptions, ReportResult, ReportRow } from '@shared/reports'
import { call } from '@/lib/api'
import { useSession } from '@/lib/session'
import {
  Badge, Button, Card, EmptyState, ErrorState, Field, Input, Modal, PageHeader, Pagination, Select, Spinner, formatDateTime, formatMoney,
  friendlyError, useToast
} from '@/ui'
import { cellText, downloadBase64 } from './fmt'

const PRESETS: { value: string; label: string }[] = [
  { value: 'today', label: 'Today' }, { value: 'yesterday', label: 'Yesterday' }, { value: 'this_week', label: 'This week' },
  { value: 'last_7', label: 'Last 7 days' }, { value: 'last_30', label: 'Last 30 days' }, { value: 'this_month', label: 'This month' },
  { value: 'last_month', label: 'Last month' }, { value: 'this_fy', label: 'This financial year' }, { value: 'last_fy', label: 'Last financial year' },
  { value: 'custom', label: 'Custom range…' }
]
const GROUP_BY: Record<string, { value: string; label: string }[]> = {
  sales_summary: [{ value: 'day', label: 'By day' }, { value: 'hour', label: 'By hour' }, { value: 'month', label: 'By month' }],
  profit: [{ value: 'day', label: 'By day' }, { value: 'product', label: 'By product' }, { value: 'category', label: 'By category' }, { value: 'brand', label: 'By brand' }]
}
const GROUP_ORDER = ['Sales', 'Tax', 'Purchases', 'Inventory', 'People', 'Admin']
const PAGE = 200

type PagedResult = ReportResult & { totalRows: number; offset: number }
interface Draft { preset: string; from: string; to: string; values: Record<string, string> }
const blank = (): Draft => ({ preset: 'this_month', from: '', to: '', values: {} })

function toFilters(d: Draft, meta: ReportMeta): ReportFilters {
  const f: Record<string, unknown> = {}
  if (!meta.asOf) {
    if (d.preset === 'custom') { if (d.from) f.from = d.from; if (d.to) f.to = d.to; if (!d.from && !d.to) f.preset = 'this_month' }
    else f.preset = d.preset
  }
  for (const [k, v] of Object.entries(d.values)) {
    if (v === '' || !meta.filters.includes(k as keyof ReportFilters)) continue
    f[k] = ['posId', 'userId', 'categoryId', 'brandId', 'customerId', 'supplierId', 'productId', 'variantId', 'days'].includes(k) ? Number(v) : k === 'inStockOnly' ? v === '1' : v
  }
  return f as ReportFilters
}

export default function ReportsPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { can } = useSession()
  const [metas, setMetas] = useState<ReportMeta[] | null>(null)
  const [options, setOptions] = useState<ReportOptions | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    Promise.all([call<ReportMeta[]>('reports', 'list'), call<ReportOptions>('reports', 'options')])
      .then(([m, o]) => live && (setMetas(m), setOptions(o)))
      .catch((e) => live && setLoadError(friendlyError(e)))
    return () => { live = false }
  }, [])

  const grouped = useMemo(() => {
    const g = new Map<string, ReportMeta[]>()
    for (const m of metas ?? []) g.set(m.group, [...(g.get(m.group) ?? []), m])
    return GROUP_ORDER.filter((k) => g.has(k)).map((k) => ({ group: k, items: g.get(k)! }))
  }, [metas])

  if (loadError) return <div className="page"><PageHeader title="Reports" /><ErrorState message={loadError} onRetry={() => location.reload()} /></div>
  if (!metas || !options) return <div className="page"><PageHeader title="Reports" /><Spinner /></div>
  if (!id && metas.length) return <Navigate to={`/reports/${metas[0].id}`} replace />
  const meta = metas.find((m) => m.id === id)

  return (
    <div className="page">
      <PageHeader title={meta?.title ?? 'Reports'} subtitle={meta?.description ?? 'Choose a report'} />
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(190px, 230px) 1fr', gap: 16, alignItems: 'start' }}>
        <nav className="col no-print" aria-label="Reports" style={{ position: 'sticky', top: 8 }}>
          {grouped.map((g) => (
            <div key={g.group} className="col" style={{ gap: 2, marginBottom: 12 }}>
              <strong className="muted" style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '.04em' }}>{g.group}</strong>
              {g.items.map((m) => (
                <button key={m.id} type="button" className={`menu-item ${m.id === id ? 'active' : ''}`} aria-current={m.id === id ? 'page' : undefined}
                  style={{ textAlign: 'left', fontWeight: m.id === id ? 600 : 400 }} onClick={() => navigate(`/reports/${m.id}`)}>
                  {m.title}{m.needsProfit && <span title="Needs cost/profit permission"> *</span>}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div style={{ minWidth: 0 }}>
          {meta
            ? <ReportView key={meta.id} meta={meta} options={options} canExport={can('reports.export')} />
            : <EmptyState title="Pick a report" hint="Sales, tax, purchases, stock and customers are listed on the left." />}
        </div>
      </div>
    </div>
  )
}

function ReportView({ meta, options, canExport }: { meta: ReportMeta; options: ReportOptions; canExport: boolean }) {
  const toast = useToast()
  const [draft, setDraft] = useState<Draft>(() => {
    const d = blank()
    if (GROUP_BY[meta.id]) d.values.groupBy = 'day'
    return d
  })
  const [applied, setApplied] = useState<ReportFilters>(() => toFilters(draft, meta))
  const [result, setResult] = useState<PagedResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const [busy, setBusy] = useState<string | null>(null)
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null)
  const [page, setPage] = useState(1)
  const [saleId, setSaleId] = useState<number | null>(null)

  useEffect(() => {
    let live = true
    setLoading(true)
    setError(null)
    // The server keeps the full result cached and sends one sorted page at a time (a 20k-row listing is ~4 MB as one IPC message).
    call<PagedResult>('reports', 'runPage', { id: meta.id, filters: applied, offset: (page - 1) * PAGE, limit: PAGE, sort })
      .then((r) => { if (live) setResult(r) })
      .catch((e) => live && setError(friendlyError(e)))
      .finally(() => live && setLoading(false))
    return () => { live = false }
  }, [meta.id, applied, tick, page, sort])

  const set = (k: string, v: string) => setDraft((d) => ({ ...d, values: { ...d.values, [k]: v } }))
  const has = (k: keyof ReportFilters) => meta.filters.includes(k)
  const apply = () => {
    if (draft.preset === 'custom' && draft.from && draft.to && draft.from > draft.to) { toast('From date is after To date', 'bad'); return }
    setApplied(toFilters(draft, meta))
    setPage(1)
    setSort(null)
    setTick((t) => t + 1)
  }

  const doExport = async (kind: 'exportXlsx' | 'exportCsv' | 'exportPdf') => {
    setBusy(kind)
    try {
      const x = await call<ReportExportResult>('reports', kind, { id: meta.id, filters: applied })
      if (x.base64) downloadBase64(x.base64, x.filename, x.mime)
      toast(`Exported ${x.filename}`, 'good')
    } catch (e) {
      toast(friendlyError(e), 'bad')
    } finally {
      setBusy(null)
    }
  }
  const doPrint = async () => {
    setBusy('print')
    try {
      const { html } = await call<{ html: string }>('reports', 'renderHtml', { id: meta.id, filters: applied })
      let answered = false
      try {
        const res = await call<{ ok: boolean; error?: string }>('printing', 'print', { html, paper: 'A4' })
        answered = true
        if (res?.ok) toast('Sent to printer', 'good')
        else toast(res?.error ? `Printing failed: ${res.error}` : 'Printing failed. Check the printer and try again.', 'bad')
      } catch {
        /* printing service unavailable: fall back to the browser print dialog */
      }
      if (!answered) window.print()
    } catch (e) {
      toast(friendlyError(e), 'bad')
    } finally {
      setBusy(null)
    }
  }

  const onRow = (r: ReportRow) => { if (typeof r._saleId === 'number') setSaleId(r._saleId) }
  const drill = !!result?.rows.some((r) => typeof r._saleId === 'number')

  return (
    <div className="col" style={{ gap: 12 }}>
      <Card>
        <div className="toolbar no-print" style={{ alignItems: 'flex-end' }}>
          {!meta.asOf && (
            <>
              <Field label="Period">
                <Select value={draft.preset} onChange={(e) => setDraft({ ...draft, preset: e.target.value })}>
                  {PRESETS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                </Select>
              </Field>
              {draft.preset === 'custom' && (
                <>
                  <Field label="From"><Input type="date" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} /></Field>
                  <Field label="To"><Input type="date" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} /></Field>
                </>
              )}
            </>
          )}
          {GROUP_BY[meta.id] && has('groupBy') && (
            <Field label="Group by">
              <Select value={draft.values.groupBy ?? 'day'} onChange={(e) => set('groupBy', e.target.value)}>
                {GROUP_BY[meta.id].map((g) => <option key={g.value} value={g.value}>{g.label}</option>)}
              </Select>
            </Field>
          )}
          {has('posId') && <Pick label="POS" value={draft.values.posId} onChange={(v) => set('posId', v)} items={options.pos} all="All POS" />}
          {has('userId') && <Pick label="Cashier / user" value={draft.values.userId} onChange={(v) => set('userId', v)} items={options.cashiers} all="Everyone" />}
          {has('categoryId') && <Pick label="Category" value={draft.values.categoryId} onChange={(v) => set('categoryId', v)} items={options.categories} all="All categories" />}
          {has('brandId') && <Pick label="Brand" value={draft.values.brandId} onChange={(v) => set('brandId', v)} items={options.brands} all="All brands" />}
          {has('customerId') && <Pick label="Customer" value={draft.values.customerId} onChange={(v) => set('customerId', v)} items={options.customers} all="All customers" />}
          {has('supplierId') && <Pick label="Supplier" value={draft.values.supplierId} onChange={(v) => set('supplierId', v)} items={options.suppliers} all="All suppliers" />}
          {has('paymentMethod') && (
            <Field label="Payment">
              <Select value={draft.values.paymentMethod ?? ''} onChange={(e) => set('paymentMethod', e.target.value)}>
                <option value="">All methods</option>
                {options.paymentMethods.map((m) => <option key={m} value={m}>{m.toUpperCase()}</option>)}
              </Select>
            </Field>
          )}
          {has('days') && <Field label="No sales for (days)"><Input type="number" min={1} value={draft.values.days ?? '90'} onChange={(e) => set('days', e.target.value)} style={{ width: 100 }} /></Field>}
          {has('entity') && <Field label="Entity"><Input value={draft.values.entity ?? ''} onChange={(e) => set('entity', e.target.value)} placeholder="e.g. sale" style={{ width: 120 }} /></Field>}
          {has('action') && <Field label={meta.id === 'stock_ledger' ? 'Movement type' : 'Action'}><Input value={draft.values.action ?? ''} onChange={(e) => set('action', e.target.value)} placeholder={meta.id === 'stock_ledger' ? 'e.g. sale' : 'e.g. void'} style={{ width: 120 }} /></Field>}
          {has('search') && <Field label="Search"><Input value={draft.values.search ?? ''} onChange={(e) => set('search', e.target.value)} onKeyDown={(e) => e.key === 'Enter' && apply()} style={{ width: 160 }} /></Field>}
          {has('inStockOnly') && (
            <label className="row" style={{ gap: 6, alignItems: 'center' }}>
              <input type="checkbox" checked={draft.values.inStockOnly === '1'} onChange={(e) => set('inStockOnly', e.target.checked ? '1' : '')} /> In stock only
            </label>
          )}
          <Button variant="primary" onClick={apply} disabled={loading}>Run report</Button>
          <span className="toolbar-spacer" />
          <Button onClick={doPrint} disabled={!result || !!busy} loading={busy === 'print'}>Print</Button>
          {canExport && (
            <>
              <Button onClick={() => doExport('exportXlsx')} disabled={!result || !!busy} loading={busy === 'exportXlsx'}>Excel</Button>
              <Button onClick={() => doExport('exportCsv')} disabled={!result || !!busy} loading={busy === 'exportCsv'}>CSV</Button>
              <Button onClick={() => doExport('exportPdf')} disabled={!result || !!busy} loading={busy === 'exportPdf'}>PDF</Button>
            </>
          )}
        </div>
      </Card>

      {error ? <ErrorState message={error} onRetry={() => setTick((t) => t + 1)} />
        : loading && !result ? <Spinner label="Running report…" />
        : result && (
          <Card
            title={<span>{result.title}{result.subtitle ? ` - ${result.subtitle}` : ''} <span className="muted" style={{ fontWeight: 400, fontSize: 13 }}>{result.period ? `(${result.period.label}${result.period.label.includes(result.period.from) ? '' : `: ${result.period.from} to ${result.period.to}`})` : `(as of ${formatDateTime(result.generatedAt)})`}</span></span>}
            actions={<span className="row" style={{ gap: 8 }}>{loading && <Spinner label="Refreshing…" />}<Badge>{result.totalRows} rows</Badge>{result.truncated && <Badge tone="warn">Truncated - narrow the filters</Badge>}</span>}
          >
            {result.totalRows === 0
              ? <EmptyState title="No data for these filters" hint="Try a wider period or clear some filters." />
              : (
                <>
                  <ResultTable result={result} rows={result.rows} sort={sort} onSort={(k) => { setPage(1); setSort((s) => (s?.key !== k ? { key: k, dir: 1 } : s.dir === 1 ? { key: k, dir: -1 } : null)) }} onRow={drill ? onRow : undefined} />
                  {result.totalRows > PAGE && <Pagination page={page} pageSize={PAGE} total={result.totalRows} onPage={setPage} />}
                </>
              )}
            {result.notes?.map((n) => <p key={n} className="muted" style={{ fontSize: 12, margin: '8px 0 0' }}>{n}</p>)}
            {drill && <p className="muted no-print" style={{ fontSize: 12, margin: '4px 0 0' }}>Click an invoice row to see its details.</p>}
          </Card>
        )}

      <SaleDialog saleId={saleId} onClose={() => setSaleId(null)} />
    </div>
  )
}

function Pick({ label, value, onChange, items, all }: { label: string; value?: string; onChange: (v: string) => void; items: { id: number; name: string }[]; all: string }) {
  return (
    <Field label={label}>
      <Select value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
        <option value="">{all}</option>
        {items.map((i) => <option key={i.id} value={i.id}>{i.name.length > 40 ? `${i.name.slice(0, 40)}…` : i.name}</option>)}
      </Select>
    </Field>
  )
}

function ResultTable({ result, rows, sort, onSort, onRow }: { result: ReportResult; rows: ReportRow[]; sort: { key: string; dir: 1 | -1 } | null; onSort: (k: string) => void; onRow?: (r: ReportRow) => void }) {
  const th = (c: ReportColumn) => {
    const active = sort?.key === c.key
    return (
      <th key={c.key} scope="col" aria-sort={active ? (sort!.dir === 1 ? 'ascending' : 'descending') : 'none'} style={{ textAlign: c.align ?? (c.type === 'text' ? 'left' : 'right'), whiteSpace: 'nowrap' }}>
        <button type="button" className="th-sort" onClick={() => onSort(c.key)} style={{ justifyContent: c.type === 'text' ? 'flex-start' : 'flex-end' }}>
          {c.header}<span className="sort-ind" aria-hidden="true">{active ? (sort!.dir === 1 ? '▲' : '▼') : '↕'}</span>
        </button>
      </th>
    )
  }
  return (
    <div className="table-wrap" style={{ maxHeight: '65vh' }}>
      <table className="table table-dense">
        <thead><tr>{result.columns.map(th)}</tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className={onRow && typeof r._saleId === 'number' ? 'clickable' : ''} onClick={onRow ? () => onRow(r) : undefined}>
              {result.columns.map((c) => (
                <td key={c.key} className={c.type === 'text' ? undefined : 'num'} style={{ textAlign: c.align ?? (c.type === 'text' ? 'left' : 'right') }}>{cellText(c, r[c.key])}</td>
              ))}
            </tr>
          ))}
        </tbody>
        {result.totals && (
          <tfoot>
            <tr style={{ fontWeight: 700, position: 'sticky', bottom: 0, background: 'var(--panel-2)' }}>
              {result.columns.map((c) => (
                <td key={c.key} className={c.type === 'text' ? undefined : 'num'} style={{ textAlign: c.align ?? (c.type === 'text' ? 'left' : 'right'), borderTop: '2px solid var(--line)' }}>{cellText(c, result.totals![c.key])}</td>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  )
}

interface SaleDetail {
  invoiceNo: string; createdAt: number; status: string; subtotal: number; discount: number; tax: number; roundOff: number; total: number
  customerName: string; cashierName: string; posName: string; voidReason?: string | null; returnedTotal: number
  items: { id: number; name: string; qty: number; unitPrice: number; discount: number; taxAmount: number; lineTotal: number; returnedQty: number }[]
  payments: { id: number; method: string; amount: number }[]
  returns: { id: number; returnNo: string; total: number; refundMethod: string; createdAt: number }[]
}

/** Invoice detail dialog (data from pos.getSale). */
function SaleDialog({ saleId, onClose }: { saleId: number | null; onClose: () => void }) {
  const [sale, setSale] = useState<SaleDetail | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const close = useCallback(() => { setSale(null); setErr(null); onClose() }, [onClose])
  useEffect(() => {
    if (saleId == null) return
    let live = true
    setSale(null); setErr(null)
    call<SaleDetail>('pos', 'getSale', { id: saleId }).then((s) => live && setSale(s)).catch((e) => live && setErr(friendlyError(e)))
    return () => { live = false }
  }, [saleId])
  return (
    <Modal title={sale ? `Invoice ${sale.invoiceNo}` : 'Invoice'} open={saleId != null} onClose={close} wide footer={<Button onClick={close}>Close</Button>}>
      {err ? <ErrorState message={err} /> : !sale ? <Spinner /> : (
        <div className="col" style={{ gap: 10 }}>
          <div className="row" style={{ gap: 16, flexWrap: 'wrap' }}>
            <span>{formatDateTime(sale.createdAt)}</span><span>Cashier: {sale.cashierName}</span><span>{sale.posName}</span>
            <span>Customer: {sale.customerName || 'Walk-in'}</span>
            {sale.status !== 'completed' && <Badge tone="bad">{sale.status}{sale.voidReason ? `: ${sale.voidReason}` : ''}</Badge>}
          </div>
          <div className="table-wrap">
            <table className="table table-dense">
              <thead><tr><th>Item</th><th style={{ textAlign: 'right' }}>Qty</th><th style={{ textAlign: 'right' }}>Price</th><th style={{ textAlign: 'right' }}>Discount</th><th style={{ textAlign: 'right' }}>Tax</th><th style={{ textAlign: 'right' }}>Total</th></tr></thead>
              <tbody>
                {sale.items.map((i) => (
                  <tr key={i.id}>
                    <td>{i.name}{i.returnedQty > 0 && <span className="muted"> (returned {i.returnedQty})</span>}</td>
                    <td className="num" style={{ textAlign: 'right' }}>{i.qty}</td>
                    <td className="num" style={{ textAlign: 'right' }}>{formatMoney(i.unitPrice, { symbol: false })}</td>
                    <td className="num" style={{ textAlign: 'right' }}>{formatMoney(i.discount, { symbol: false })}</td>
                    <td className="num" style={{ textAlign: 'right' }}>{formatMoney(i.taxAmount, { symbol: false })}</td>
                    <td className="num" style={{ textAlign: 'right' }}>{formatMoney(i.lineTotal, { symbol: false })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="row" style={{ gap: 16, flexWrap: 'wrap', justifyContent: 'space-between' }}>
            <div className="col" style={{ gap: 2 }}>
              {sale.payments.map((p) => <span key={p.id}>{p.method.toUpperCase()}: {formatMoney(p.amount)}</span>)}
              {sale.returns.map((r) => <span key={r.id} className="muted">Return {r.returnNo}: {formatMoney(r.total)} ({r.refundMethod})</span>)}
            </div>
            <div className="col" style={{ gap: 2, textAlign: 'right' }}>
              <span>Subtotal {formatMoney(sale.subtotal)}</span>
              <span>Discount {formatMoney(sale.discount)}</span>
              <span>Tax {formatMoney(sale.tax)}</span>
              <span>Round-off {formatMoney(sale.roundOff)}</span>
              <strong>Total {formatMoney(sale.total)}</strong>
            </div>
          </div>
        </div>
      )}
    </Modal>
  )
}

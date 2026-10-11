import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { call, errMsg } from '@/lib/api'
import { useLiveRefresh } from '@/lib/live'
import { useSession } from '@/lib/session'
import { formatINR } from '@shared/money'
import { Badge, Button, Card, ErrorState, Input, PageHeader, Select, Spinner, Table, useAsync, useToast } from '@/ui'
import { Pager, ProductPicker, downloadCsv, fmtDate, useDebounced, type Cat, type Loc, type Page } from './common'
import { AdjustDialog, LedgerDialog, type AdjustTarget } from './dialogs'

export interface StockRow {
  variantId: number; displayName: string; sku: string; barcode: string | null; unit: string; categoryName: string | null
  reorderLevel: number; taxRateBp: number; qty: number; cost: number | null; value: number | null; price: number
  suggestedQty?: number
}
type StockPage = Page<StockRow> & { totalQty: number; totalValue: number | null }

const LIMIT = 50

function qtyBadge(r: StockRow) {
  if (r.qty <= 0) return <Badge tone="bad">Out</Badge>
  if (r.reorderLevel > 0 && r.qty <= r.reorderLevel) return <Badge tone="warn">Low</Badge>
  return null
}

export function StockPage() {
  const { can } = useSession()
  const toast = useToast()
  const [search, setSearch] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [locationId, setLocationId] = useState('')
  const [status, setStatus] = useState('all')
  const [offset, setOffset] = useState(0)
  const [ledger, setLedger] = useState<{ id: number; name: string } | null>(null)
  const [adjust, setAdjust] = useState<AdjustTarget | null>(null)
  const dsearch = useDebounced(search)

  const cats = useAsync(() => call<Cat[]>('inventory', 'categories'), [])
  const locs = useAsync(() => call<Loc[]>('inventory', 'locations'), [])
  const q = { search: dsearch || undefined, categoryId: categoryId ? Number(categoryId) : undefined, locationId: locationId ? Number(locationId) : undefined, status }
  const { data, loading, error, reload } = useAsync(() => call<StockPage>('inventory', 'stock', { ...q, limit: LIMIT, offset }), [dsearch, categoryId, locationId, status, offset])
  useLiveRefresh(['inventory', 'catalog', 'pos', 'purchases'], reload)

  const exportCsv = async () => {
    try {
      const all = await call<StockPage>('inventory', 'stock', { ...q, limit: 10000, offset: 0 })
      const showCost = all.totalValue != null
      downloadCsv(`stock-${new Date().toISOString().slice(0, 10)}.csv`,
        ['Product', 'SKU', 'Barcode', 'Category', 'Unit', 'Qty', 'Reorder level', ...(showCost ? ['Cost (INR)', 'Value (INR)'] : [])],
        all.rows.map((r) => [r.displayName, r.sku, r.barcode, r.categoryName, r.unit, r.qty, r.reorderLevel, ...(showCost ? [((r.cost ?? 0) / 100).toFixed(2), ((r.value ?? 0) / 100).toFixed(2)] : [])]))
    } catch (e) { toast(errMsg(e), 'bad') }
  }
  const reset = (fn: () => void) => { fn(); setOffset(0) }

  return (
    <div className="page">
      <PageHeader title="Stock" subtitle={data ? `${data.total} items · ${data.totalQty} units${data.totalValue != null ? ' · value ' + formatINR(data.totalValue) : ''}` : undefined}
        actions={<Button onClick={exportCsv}>Export CSV</Button>} />
      <div className="toolbar" style={{ marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
        <Input autoFocus placeholder="Search name, SKU, barcode…" value={search} onChange={(e) => reset(() => setSearch(e.target.value))} style={{ maxWidth: 280 }} aria-label="Search stock" />
        <Select value={categoryId} onChange={(e) => reset(() => setCategoryId(e.target.value))} aria-label="Category">
          <option value="">All categories</option>{cats.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
        {(locs.data?.length ?? 0) > 1 && (
          <Select value={locationId} onChange={(e) => reset(() => setLocationId(e.target.value))} aria-label="Location">
            <option value="">All locations</option>{locs.data?.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </Select>
        )}
        <Select value={status} onChange={(e) => reset(() => setStatus(e.target.value))} aria-label="Stock status">
          <option value="all">All stock</option><option value="in">In stock</option><option value="low">Low stock</option><option value="out">Out of stock</option>
        </Select>
      </div>
      {error ? <ErrorState message={error} onRetry={reload} /> : loading && !data ? <Spinner /> : (
        <>
          <Table
            rows={data?.rows ?? []}
            rowKey={(r) => r.variantId}
            onRowClick={(r) => setLedger({ id: r.variantId, name: r.displayName })}
            columns={[
              { key: 'displayName', header: 'Product', render: (r) => <>{r.displayName} {qtyBadge(r)}</> },
              { key: 'sku', header: 'SKU' },
              { key: 'categoryName', header: 'Category', render: (r) => r.categoryName ?? '' },
              { key: 'qty', header: 'On hand', align: 'right', render: (r) => <span className="num">{r.qty} {r.unit}</span> },
              { key: 'reorderLevel', header: 'Reorder at', align: 'right' },
              ...(data?.totalValue != null ? [
                { key: 'cost', header: 'Cost', align: 'right' as const, render: (r: StockRow) => <span className="num">{formatINR(r.cost ?? 0)}</span> },
                { key: 'value', header: 'Value', align: 'right' as const, render: (r: StockRow) => <span className="num">{formatINR(r.value ?? 0)}</span> }
              ] : []),
              { key: 'act', header: '', align: 'right', render: (r) => (
                <span className="row" style={{ gap: 4, justifyContent: 'flex-end' }} onClick={(e) => e.stopPropagation()}>
                  <Button className="btn-sm" onClick={() => setLedger({ id: r.variantId, name: r.displayName })}>Ledger</Button>
                  {can('inventory.adjust') && <Button className="btn-sm" onClick={() => setAdjust({ variantId: r.variantId, displayName: r.displayName, qty: r.qty })}>Adjust</Button>}
                </span>
              ) }
            ]}
          />
          <Pager total={data?.total ?? 0} limit={LIMIT} offset={offset} onChange={setOffset} />
        </>
      )}
      <LedgerDialog variantId={ledger?.id ?? null} title={ledger?.name ?? ''} onClose={() => setLedger(null)} />
      <AdjustDialog target={adjust} locations={locs.data ?? []} locationId={locationId ? Number(locationId) : locs.data?.find((l) => l.isDefault)?.id} onClose={() => setAdjust(null)} onDone={reload} />
    </div>
  )
}

export function LowStockPage() {
  const nav = useNavigate()
  const { can } = useSession()
  const { data, loading, error, reload } = useAsync(() => call<{ rows: StockRow[]; total: number }>('inventory', 'lowStock', { limit: 500 }), [])
  useLiveRefresh(['inventory', 'catalog', 'pos', 'purchases'], reload)
  const [picked, setPicked] = useState<Set<number>>(new Set())
  const toggle = (id: number) => setPicked((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  const rows = data?.rows ?? []
  const createPurchase = () => {
    const chosen = rows.filter((r) => picked.size === 0 || picked.has(r.variantId))
    nav('/inventory/purchases/new', { state: { lines: chosen.map((r) => ({ variantId: r.variantId, displayName: r.displayName, sku: r.sku, qty: r.suggestedQty ?? 1, cost: r.cost ?? 0, taxRateBp: r.taxRateBp })) } })
  }
  return (
    <div className="page">
      <PageHeader title="Low stock" subtitle={data ? `${data.total} items at or below their reorder level` : undefined}
        actions={can('purchases.edit') ? <Button variant="primary" disabled={!rows.length} onClick={createPurchase}>Create purchase{picked.size ? ` (${picked.size})` : ' for all'}</Button> : undefined} />
      {error ? <ErrorState message={error} onRetry={reload} /> : loading && !data ? <Spinner /> : (
        <Table
          rows={rows}
          rowKey={(r) => r.variantId}
          empty={<Card><p>Nothing is below its reorder level.</p></Card>}
          columns={[
            { key: 'sel', header: '', width: '36px', render: (r) => <input type="checkbox" aria-label={`Select ${r.displayName}`} checked={picked.has(r.variantId)} onChange={() => toggle(r.variantId)} /> },
            { key: 'displayName', header: 'Product', render: (r) => <>{r.displayName} {qtyBadge(r)}</> },
            { key: 'sku', header: 'SKU' },
            { key: 'qty', header: 'On hand', align: 'right' },
            { key: 'reorderLevel', header: 'Reorder at', align: 'right' },
            { key: 'suggestedQty', header: 'Suggested order', align: 'right' }
          ]}
        />
      )}
    </div>
  )
}

interface AdjRow { id: number; createdAt: number; qtyDelta: number; reason: string; note: string; displayName: string; sku: string; locationName: string; userName: string | null }

export function AdjustmentsPage() {
  const [offset, setOffset] = useState(0)
  const [target, setTarget] = useState<AdjustTarget | null>(null)
  const { can } = useSession()
  const locs = useAsync(() => call<Loc[]>('inventory', 'locations'), [])
  const { data, loading, error, reload } = useAsync(() => call<Page<AdjRow>>('inventory', 'adjustments', { limit: LIMIT, offset }), [offset])
  return (
    <div className="page">
      <PageHeader title="Stock adjustments" subtitle="Every change needs a reason and is recorded in the ledger and audit log" />
      {can('inventory.adjust') && (
        <div className="toolbar" style={{ marginBottom: 12 }}>
          <ProductPicker autoFocus placeholder="Scan or search a product to adjust…" onPick={(p) => setTarget({ variantId: p.variantId, displayName: p.displayName, qty: p.stock })} />
        </div>
      )}
      {error ? <ErrorState message={error} onRetry={reload} /> : loading && !data ? <Spinner /> : (
        <>
          <Table
            rows={data?.rows ?? []}
            rowKey={(r) => r.id}
            columns={[
              { key: 'createdAt', header: 'When', render: (r) => fmtDate(r.createdAt) },
              { key: 'displayName', header: 'Product', render: (r) => <>{r.displayName} <span className="muted">{r.sku}</span></> },
              { key: 'qtyDelta', header: 'Change', align: 'right', render: (r) => <span className="num">{r.qtyDelta > 0 ? '+' : ''}{r.qtyDelta}</span> },
              { key: 'reason', header: 'Reason', render: (r) => <Badge tone={r.qtyDelta > 0 ? 'good' : 'warn'}>{r.reason}</Badge> },
              { key: 'locationName', header: 'Location' },
              { key: 'note', header: 'Note' },
              { key: 'userName', header: 'By', render: (r) => r.userName ?? '' }
            ]}
          />
          <Pager total={data?.total ?? 0} limit={LIMIT} offset={offset} onChange={setOffset} />
        </>
      )}
      <AdjustDialog target={target} locations={locs.data ?? []} locationId={locs.data?.find((l) => l.isDefault)?.id} onClose={() => setTarget(null)} onDone={reload} />
    </div>
  )
}

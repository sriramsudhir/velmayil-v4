import { useState } from 'react'
import { call, errMsg } from '@/lib/api'
import { useLiveRefresh } from '@/lib/live'
import { useSession } from '@/lib/session'
import { formatINR, pctOf } from '@shared/money'
import { Badge, Button, Card, ErrorState, Field, Input, Modal, PageHeader, Select, Spinner, Table, TextArea, useAsync, useToast } from '@/ui'
import { Pager, ProductPicker, fmtDate, useDebounced, type Page } from './common'

export interface Supplier { id: number; name: string; contactPerson: string; phone: string; email: string; gstin: string; address: string; active: number; balance: number }

const blank = { name: '', contactPerson: '', phone: '', email: '', gstin: '', address: '' }

export function SuppliersPage() {
  const toast = useToast()
  const { can } = useSession()
  const [search, setSearch] = useState('')
  const [inactive, setInactive] = useState(false)
  const [offset, setOffset] = useState(0)
  const dsearch = useDebounced(search)
  const [edit, setEdit] = useState<{ id?: number } & typeof blank | null>(null)
  const [busy, setBusy] = useState(false)
  const { data, loading, error, reload } = useAsync(() => call<Page<Supplier>>('purchases', 'supplierList', { search: dsearch || undefined, includeInactive: inactive, limit: 50, offset }), [dsearch, inactive, offset])
  useLiveRefresh(['inventory', 'catalog', 'pos', 'purchases'], reload)

  const save = async () => {
    if (!edit) return
    setBusy(true)
    try {
      await call('purchases', 'supplierSave', { ...edit, gstin: edit.gstin.trim() })
      toast('Supplier saved', 'good'); setEdit(null); reload()
    } catch (e) { toast(errMsg(e), 'bad') } finally { setBusy(false) }
  }
  const toggle = async (s: Supplier) => {
    try { await call('purchases', 'supplierSetActive', { id: s.id, active: !s.active }); reload() } catch (e) { toast(errMsg(e), 'bad') }
  }
  const canEdit = can('purchases.edit')
  return (
    <div className="page">
      <PageHeader title="Suppliers" subtitle="Balance = purchased - returns - paid" actions={canEdit ? <Button variant="primary" onClick={() => setEdit({ ...blank })}>New supplier</Button> : undefined} />
      <div className="toolbar" style={{ marginBottom: 12, gap: 12 }}>
        <Input autoFocus placeholder="Search suppliers…" value={search} onChange={(e) => { setSearch(e.target.value); setOffset(0) }} style={{ maxWidth: 280 }} aria-label="Search suppliers" />
        <label className="check"><input type="checkbox" checked={inactive} onChange={(e) => setInactive(e.target.checked)} /> Show inactive</label>
      </div>
      {error ? <ErrorState message={error} onRetry={reload} /> : loading && !data ? <Spinner /> : (
        <>
          <Table
            rows={data?.rows ?? []}
            rowKey={(r) => r.id}
            onRowClick={canEdit ? (r) => setEdit({ id: r.id, name: r.name, contactPerson: r.contactPerson, phone: r.phone, email: r.email, gstin: r.gstin, address: r.address }) : undefined}
            columns={[
              { key: 'name', header: 'Supplier', render: (r) => <>{r.name} {!r.active && <Badge>inactive</Badge>}</> },
              { key: 'phone', header: 'Phone' },
              { key: 'gstin', header: 'GSTIN' },
              { key: 'balance', header: 'Payable', align: 'right', render: (r) => <span className="num">{formatINR(r.balance)}</span> },
              { key: 'act', header: '', align: 'right', render: (r) => canEdit ? <Button className="btn-sm" onClick={(e) => { e.stopPropagation(); void toggle(r) }}>{r.active ? 'Deactivate' : 'Activate'}</Button> : null }
            ]}
          />
          <Pager total={data?.total ?? 0} limit={50} offset={offset} onChange={setOffset} />
        </>
      )}
      <Modal title={edit?.id ? 'Edit supplier' : 'New supplier'} open={!!edit} onClose={() => setEdit(null)} footer={<><Button onClick={() => setEdit(null)}>Cancel</Button><Button variant="primary" disabled={busy || !edit?.name.trim()} onClick={save}>Save</Button></>}>
        {edit && (
          <form className="form-grid" onSubmit={(e) => { e.preventDefault(); void save() }}>
            <Field label="Name"><Input autoFocus value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            <Field label="Contact person"><Input value={edit.contactPerson} onChange={(e) => setEdit({ ...edit, contactPerson: e.target.value })} /></Field>
            <Field label="Phone"><Input value={edit.phone} onChange={(e) => setEdit({ ...edit, phone: e.target.value })} /></Field>
            <Field label="Email"><Input value={edit.email} onChange={(e) => setEdit({ ...edit, email: e.target.value })} /></Field>
            <Field label="GSTIN" hint="15 characters, optional"><Input value={edit.gstin} onChange={(e) => setEdit({ ...edit, gstin: e.target.value })} maxLength={15} /></Field>
            <Field label="Address"><TextArea rows={2} value={edit.address} onChange={(e) => setEdit({ ...edit, address: e.target.value })} /></Field>
            <button type="submit" hidden />
          </form>
        )}
      </Modal>
    </div>
  )
}

// ---------------------------------------------------------------- supplier returns
interface RetRow { id: number; number: string; supplierName: string; total: number; qty: number; createdAt: number; note: string }
interface RLine { variantId: number; displayName: string; sku: string; qty: number; unitCost: number; stock: number; taxBp: number }
/** value of a return line the way the purchase was payable: goods at cost + GST */
const lineValue = (l: RLine): number => { const base = l.qty * l.unitCost; return base + pctOf(base, l.taxBp) }

export function SupplierReturnsPage() {
  const toast = useToast()
  const { can } = useSession()
  const suppliers = useAsync(() => call<Page<Supplier>>('purchases', 'supplierList', { limit: 500 }), [])
  const list = useAsync(() => call<Page<RetRow>>('purchases', 'returnList', { limit: 100 }), [])
  const [supplierId, setSupplierId] = useState('')
  const [note, setNote] = useState('')
  const [lines, setLines] = useState<RLine[]>([])
  const [busy, setBusy] = useState(false)
  const total = lines.reduce((s, l) => s + lineValue(l), 0)

  const submit = async () => {
    if (busy) return
    setBusy(true)
    try {
      const r = await call<{ number: string }>('purchases', 'returnCreate', { supplierId: Number(supplierId), note: note || undefined, items: lines.map((l) => ({ variantId: l.variantId, qty: l.qty, unitCost: l.unitCost, taxRateBp: l.taxBp })) })
      toast(`Supplier return ${r.number} saved`, 'good'); setLines([]); setNote(''); list.reload()
    } catch (e) { toast(errMsg(e), 'bad') } finally { setBusy(false) }
  }
  return (
    <div className="page">
      <PageHeader title="Supplier returns" subtitle="Send goods back to a supplier; stock is reduced and the payable falls" />
      {can('purchases.edit') && <ReturnForm {...{ suppliers: suppliers.data?.rows ?? [], supplierId, setSupplierId, note, setNote, lines, setLines, total, busy, submit }} />}
      <h3 style={{ margin: '16px 0 8px' }}>History</h3>
      {list.error ? <ErrorState message={list.error} onRetry={list.reload} /> : list.loading && !list.data ? <Spinner /> : (
        <Table rows={list.data?.rows ?? []} rowKey={(r) => r.id} columns={[
          { key: 'number', header: 'Return' },
          { key: 'createdAt', header: 'When', render: (r) => fmtDate(r.createdAt) },
          { key: 'supplierName', header: 'Supplier' },
          { key: 'qty', header: 'Units', align: 'right' },
          { key: 'total', header: 'Credit (incl. GST)', align: 'right', render: (r) => <span className="num">{formatINR(r.total)}</span> },
          { key: 'note', header: 'Note' }
        ]} />
      )}
    </div>
  )
}

function ReturnForm(p: { suppliers: Supplier[]; supplierId: string; setSupplierId: (s: string) => void; note: string; setNote: (s: string) => void; lines: RLine[]; setLines: React.Dispatch<React.SetStateAction<RLine[]>>; total: number; busy: boolean; submit: () => void }) {
  const add = (v: { variantId: number; displayName: string; sku: string; cost: number | null; stock: number; taxRateBp?: number }) =>
    p.setLines((ls) => ls.some((l) => l.variantId === v.variantId) ? ls : [...ls, { variantId: v.variantId, displayName: v.displayName, sku: v.sku, qty: 1, unitCost: v.cost ?? 0, stock: v.stock, taxBp: v.taxRateBp ?? 0 }])
  const ready = !!p.supplierId && p.lines.length > 0 && p.lines.every((l) => l.qty > 0 && l.qty <= l.stock)
  return (
    <Card title="New supplier return" actions={<><strong style={{ marginRight: 12 }}>{formatINR(p.total)}</strong><Button variant="primary" disabled={!ready || p.busy} onClick={p.submit}>Save return</Button></>}>
      <div className="form-grid" style={{ marginBottom: 12 }}>
        <Field label="Supplier"><Select value={p.supplierId} onChange={(e) => p.setSupplierId(e.target.value)}><option value="">Select…</option>{p.suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
        <Field label="Note"><Input value={p.note} onChange={(e) => p.setNote(e.target.value)} /></Field>
      </div>
      <div className="toolbar" style={{ marginBottom: 8 }}><ProductPicker placeholder="Scan or search product to return…" onPick={add} /></div>
      <Table rows={p.lines} rowKey={(l) => l.variantId} empty={<p className="muted">No products added.</p>} columns={[
        { key: 'displayName', header: 'Product', render: (l) => <>{l.displayName} <span className="muted">{l.sku}</span></> },
        { key: 'stock', header: 'On hand', align: 'right' },
        { key: 'qty', header: 'Qty', align: 'right', render: (l) => <Input type="number" min={1} max={l.stock} style={{ width: 90, textAlign: 'right' }} value={l.qty} aria-label={`Quantity ${l.displayName}`} onChange={(e) => p.setLines((ls) => ls.map((x) => x.variantId === l.variantId ? { ...x, qty: Math.max(0, Math.floor(Number(e.target.value))) } : x))} /> },
        { key: 'unitCost', header: 'Unit cost (excl. GST)', align: 'right', render: (l) => <span className="num">{formatINR(l.unitCost)}</span> },
        { key: 'taxBp', header: 'GST', align: 'right', render: (l) => `${l.taxBp / 100}%` },
        { key: 'value', header: 'Credit (incl. GST)', align: 'right', render: (l) => <span className="num">{formatINR(lineValue(l))}</span> },
        { key: 'rm', header: '', render: (l) => <Button variant="ghost" aria-label="Remove" onClick={() => p.setLines((ls) => ls.filter((x) => x.variantId !== l.variantId))}>✕</Button> }
      ]} />
    </Card>
  )
}

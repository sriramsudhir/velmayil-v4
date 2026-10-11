import { useMemo, useState } from 'react'
import { normalizeUnitCode } from '@shared/scanList'
import { beepError } from '@/ui/sound'
import { createUnitList } from './unitScan'
import { call, errMsg } from '@/lib/api'
import { useSession } from '@/lib/session'
import { Button, Card, ErrorState, Field, Input, PageHeader, Select, Spinner, Table, TextArea, useAsync, useToast } from '@/ui'
import { ProductPicker, fmtDate, type Loc, type Page } from './common'

interface TRow { id: number; number: string; createdAt: number; fromName: string; toName: string; lines: number; qty: number; note: string }
interface Line { variantId: number; displayName: string; sku: string; qty: number; stock: number; tracked: boolean; unitCodes: string[] }

export function TransfersPage() {
  const toast = useToast()
  const { can } = useSession()
  const locs = useAsync(() => call<Loc[]>('inventory', 'locations'), [])
  const list = useAsync(() => call<Page<TRow>>('inventory', 'transferList', { limit: 100 }), [])
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [note, setNote] = useState('')
  const [lines, setLines] = useState<Line[]>([])
  const [busy, setBusy] = useState(false)
  const locations = locs.data ?? []
  const fromId = Number(from || locations.find((l) => l.isDefault)?.id || 0)
  const toId = Number(to || locations.find((l) => l.id !== fromId)?.id || 0)

  // ACTIVE LIST of this transfer: a unit code is added once; scanning it again shows a duplicate warning
  const units = useMemo(() => createUnitList('this transfer list'), [])

  const add = async (p: { variantId: number; displayName: string; sku: string; trackUnits?: boolean }, unitCode?: string) => {
    const tracked = !!p.trackUnits || !!unitCode
    if (tracked && !unitCode) {
      beepError()
      return toast(`${p.displayName} is moved by scanning each unit's code label (like ${p.sku.slice(0, 3)}-0001), not by quantity.`, 'bad')
    }
    let stock = 0
    try {
      const r = await call<{ qtyAtLocation: number } | null>('inventory', 'lookup', { code: p.sku, locationId: fromId })
      stock = r?.qtyAtLocation ?? 0
    } catch { /* ignore */ }
    setLines((ls) => {
      const has = ls.some((l) => l.variantId === p.variantId)
      if (tracked) {
        const code = normalizeUnitCode(unitCode!)
        return has
          ? ls.map((l) => l.variantId === p.variantId ? { ...l, unitCodes: [...l.unitCodes, code], qty: l.unitCodes.length + 1 } : l)
          : [...ls, { variantId: p.variantId, displayName: p.displayName, sku: p.sku, qty: 1, stock, tracked: true, unitCodes: [code] }]
      }
      return has ? ls.map((l) => l.variantId === p.variantId ? { ...l, qty: l.qty + 1 } : l) : [...ls, { variantId: p.variantId, displayName: p.displayName, sku: p.sku, qty: 1, stock, tracked: false, unitCodes: [] }]
    })
  }
  const dropUnit = (l: Line, code: string) => {
    units.release(code)
    setLines((ls) => ls.flatMap((x) => {
      if (x.variantId !== l.variantId) return [x]
      const rest = x.unitCodes.filter((c) => c !== code)
      return rest.length ? [{ ...x, unitCodes: rest, qty: rest.length }] : []
    }))
  }
  const submit = async () => {
    setBusy(true)
    try {
      const r = await call<{ number: string }>('inventory', 'transferCreate', {
        fromLocationId: fromId, toLocationId: toId, note: note || undefined,
        items: lines.map((l) => ({ variantId: l.variantId, qty: l.qty, ...(l.tracked ? { unitCodes: l.unitCodes } : {}) }))
      })
      toast(`Transfer ${r.number} completed`, 'good')
      units.clear()
      setLines([]); setNote(''); list.reload()
    } catch (e) { toast(errMsg(e), 'bad') } finally { setBusy(false) }
  }
  const ready = lines.length > 0 && fromId && toId && fromId !== toId && lines.every((l) => l.qty > 0 && l.qty <= l.stock)

  return (
    <div className="page">
      <PageHeader title="Stock transfers" subtitle="Move stock between locations" />
      {can('inventory.adjust') && (
        locations.length < 2 ? <Card><p className="muted">Add a second stock location to transfer stock between locations.</p></Card> : (
          <Card title="New transfer" actions={<Button variant="primary" disabled={!ready || busy} onClick={submit}>Transfer</Button>}>
            <div className="form-grid" style={{ marginBottom: 12 }}>
              <Field label="From"><Select value={fromId} onChange={(e) => { setFrom(e.target.value); setLines([]); units.clear() }}>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select></Field>
              <Field label="To"><Select value={toId} onChange={(e) => setTo(e.target.value)}>{locations.filter((l) => l.id !== fromId).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select></Field>
              <Field label="Note"><TextArea rows={1} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
            </div>
            <div className="toolbar" style={{ marginBottom: 8 }}><ProductPicker placeholder="Scan or search products to transfer…" onPick={(p, c) => void add(p, c)} unitList={units} onlyAvailableUnits /></div>
            <Table
              rows={lines}
              rowKey={(l) => l.variantId}
              empty={<p className="muted">No products added.</p>}
              columns={[
                { key: 'displayName', header: 'Product', render: (l) => (
                  <>
                    {l.displayName} <span className="muted">{l.sku}</span>
                    {l.tracked && (
                      <div data-testid="transfer-unit-codes" style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4 }}>
                        {l.unitCodes.map((c) => <span key={c} className="badge">{c} <button type="button" className="btn btn-ghost" aria-label={`Remove ${c}`} onClick={() => dropUnit(l, c)}>✕</button></span>)}
                      </div>
                    )}
                  </>
                ) },
                { key: 'stock', header: 'At source', align: 'right' },
                { key: 'qty', header: 'Qty', align: 'right', render: (l) => l.tracked ? <span className="num">{l.qty}</span> : (
                  <Input type="number" min={1} style={{ width: 90, textAlign: 'right' }} value={l.qty} aria-label={`Quantity ${l.displayName}`}
                    onChange={(e) => setLines((ls) => ls.map((x) => x.variantId === l.variantId ? { ...x, qty: Math.max(0, Math.floor(Number(e.target.value))) } : x))} />
                ) },
                { key: 'rm', header: '', render: (l) => <Button variant="ghost" aria-label="Remove" onClick={() => { units.releaseVariant(l.variantId); setLines((ls) => ls.filter((x) => x.variantId !== l.variantId)) }}>✕</Button> }
              ]}
            />
          </Card>
        )
      )}
      <h3 style={{ margin: '16px 0 8px' }}>History</h3>
      {list.error ? <ErrorState message={list.error} onRetry={list.reload} /> : list.loading && !list.data ? <Spinner /> : (
        <Table
          rows={list.data?.rows ?? []}
          rowKey={(r) => r.id}
          columns={[
            { key: 'number', header: 'Transfer' },
            { key: 'createdAt', header: 'When', render: (r) => fmtDate(r.createdAt) },
            { key: 'fromName', header: 'From' },
            { key: 'toName', header: 'To' },
            { key: 'lines', header: 'Lines', align: 'right' },
            { key: 'qty', header: 'Units', align: 'right' },
            { key: 'note', header: 'Note' }
          ]}
        />
      )}
    </div>
  )
}

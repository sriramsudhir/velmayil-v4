import { useState } from 'react'
import { call, errMsg } from '@/lib/api'
import { Badge, Button, Field, Input, Modal, Select, Spinner, Table, TextArea, useAsync, useToast } from '@/ui'
import { Pager, fmtDate, type Loc, type Page } from './common'

export const REASONS = [
  { v: 'damage', label: 'Damage', dir: 'out' },
  { v: 'expiry', label: 'Expiry', dir: 'out' },
  { v: 'theft', label: 'Theft / loss', dir: 'out' },
  { v: 'found', label: 'Found', dir: 'in' },
  { v: 'correction', label: 'Correction', dir: 'both' }
] as const

export interface AdjustTarget { variantId: number; displayName: string; qty?: number }

export function AdjustDialog(p: { target: AdjustTarget | null; locations: Loc[]; locationId?: number; onClose: () => void; onDone: () => void }) {
  // a fresh form every time it opens: the quantity, reason and note of the previous adjustment must never carry over to the next product
  if (!p.target) return null
  return <AdjustForm key={p.target.variantId} {...p} target={p.target} />
}

function AdjustForm({ target, locations, locationId, onClose, onDone }: { target: AdjustTarget; locations: Loc[]; locationId?: number; onClose: () => void; onDone: () => void }) {
  const [dir, setDir] = useState<'in' | 'out'>('out')
  const [qty, setQty] = useState('1')
  const [reason, setReason] = useState<string>('damage')
  const [note, setNote] = useState('')
  const [loc, setLoc] = useState<number | undefined>(locationId)
  const [busy, setBusy] = useState(false)
  const toast = useToast()
  const allowed = REASONS.filter((r) => r.dir === 'both' || r.dir === dir)
  const n = Number(qty.trim().replace(/,/g, ''))
  const valid = qty.trim() !== '' && Number.isInteger(n) && n > 0 && n <= 10_000_000 // "1.5" is not silently saved as 1
  const save = async () => {
    if (busy || !valid) return
    setBusy(true)
    try {
      await call('inventory', 'adjust', { variantId: target.variantId, locationId: loc ?? locationId, delta: dir === 'out' ? -n : n, reason, note: note || undefined })
      toast('Stock adjusted', 'good')
      onDone()
      onClose()
    } catch (e) { toast(errMsg(e), 'bad') } finally { setBusy(false) }
  }
  return (
    <Modal title={`Adjust stock: ${target.displayName}`} open onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!valid || busy} onClick={save}>Save adjustment</Button></>}>
      <div className="form-grid" onKeyDown={(e) => e.key === 'Enter' && e.ctrlKey && valid && save()}>
        <Field label="Direction">
          <Select value={dir} onChange={(e) => { const d = e.target.value as 'in' | 'out'; setDir(d); setReason(REASONS.find((r) => r.dir === 'both' || r.dir === d)!.v) }}>
            <option value="out">Decrease stock</option><option value="in">Increase stock</option>
          </Select>
        </Field>
        <Field label="Quantity" hint={target.qty != null ? `Currently ${target.qty}` : undefined} error={qty.trim() !== '' && !valid ? 'Enter a whole number greater than 0' : undefined}>
          <Input autoFocus type="number" min={1} step={1} value={qty} onChange={(e) => setQty(e.target.value)} />
        </Field>
        <Field label="Reason (required)">
          <Select value={reason} onChange={(e) => setReason(e.target.value)}>{allowed.map((r) => <option key={r.v} value={r.v}>{r.label}</option>)}</Select>
        </Field>
        {locations.length > 1 && (
          <Field label="Location">
            <Select value={loc ?? locationId ?? ''} onChange={(e) => setLoc(Number(e.target.value))}>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select>
          </Field>
        )}
        <Field label="Note"><TextArea rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      </div>
    </Modal>
  )
}

interface LedgerRow { id: number; ts: number; type: string; locationName: string; qtyDelta: number; balanceAfter: number; running: number; refType: string | null; unitCost: number | null; note: string | null; userName: string | null }

const TYPES = ['opening', 'purchase', 'sale', 'sale_return', 'adjustment', 'count', 'transfer_in', 'transfer_out', 'supplier_return', 'void']

export function LedgerDialog({ variantId, title, onClose }: { variantId: number | null; title: string; onClose: () => void }) {
  const [type, setType] = useState('')
  const [offset, setOffset] = useState(0)
  const limit = 50
  const { data, loading, error } = useAsync(
    () => (variantId ? call<Page<LedgerRow> & { variantName: string }>('inventory', 'ledger', { variantId, type: type || undefined, limit, offset }) : Promise.resolve(undefined)),
    [variantId, type, offset]
  )
  if (!variantId) return null
  return (
    <Modal wide title={`Stock ledger: ${title}`} open onClose={onClose} footer={<Button onClick={onClose}>Close</Button>}>
      <div className="toolbar" style={{ marginBottom: 8 }}>
        <Select value={type} onChange={(e) => { setType(e.target.value); setOffset(0) }} aria-label="Movement type">
          <option value="">All movement types</option>
          {TYPES.map((t) => <option key={t} value={t}>{t.replace('_', ' ')}</option>)}
        </Select>
      </div>
      {loading && !data ? <Spinner /> : error ? <p role="alert">{error}</p> : (
        <>
          <Table
            rows={data?.rows ?? []}
            rowKey={(r) => r.id}
            columns={[
              { key: 'ts', header: 'When', render: (r) => fmtDate(r.ts) },
              { key: 'type', header: 'Type', render: (r) => <Badge tone={r.qtyDelta > 0 ? 'good' : 'warn'}>{r.type.replace('_', ' ')}</Badge> },
              { key: 'locationName', header: 'Location' },
              { key: 'qtyDelta', header: 'Change', align: 'right', render: (r) => <span className="num">{r.qtyDelta > 0 ? '+' : ''}{r.qtyDelta}</span> },
              { key: 'running', header: 'Balance', align: 'right', render: (r) => <span className="num">{r.running}</span> },
              { key: 'note', header: 'Note', render: (r) => r.note ?? '' },
              { key: 'userName', header: 'By', render: (r) => r.userName ?? '' }
            ]}
          />
          <Pager total={data?.total ?? 0} limit={limit} offset={offset} onChange={setOffset} />
        </>
      )}
    </Modal>
  )
}

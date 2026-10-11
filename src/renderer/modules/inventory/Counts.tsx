import { useEffect, useMemo, useRef, useState } from 'react'
import { normalizeUnitCode } from '@shared/scanList'
import { beepError, beepOk } from '@/ui/sound'
import { createUnitList, isUnitCodeText, loadStoredCodes, notFoundMessage, storeCodes } from './unitScan'
import { useNavigate, useParams } from 'react-router-dom'
import { call, errMsg } from '@/lib/api'
import { useSession } from '@/lib/session'
import { formatINR } from '@shared/money'
import { Badge, Button, Card, ErrorState, Field, Modal, PageHeader, Select, Spinner, Table, TextArea, useAsync, useToast } from '@/ui'
import { BoxRecorder, noteBoxSubmit, scanBoxKey } from '@/lib/scanInput'
import { loadScannerConfig } from '@/lib/scanner'
import { Pager, fmtDate, useDebounced, type Cat, type Loc, type Page } from './common'

interface CountRow { id: number; number: string; status: string; note: string; createdAt: number; appliedAt: number | null; locationName: string; itemCount: number; countedCount: number; varianceCount: number }

const COUNT_PAGE = 100
const tone = (s: string) => (s === 'applied' ? 'good' : s === 'cancelled' ? 'neutral' : 'warn')

export function CountsPage() {
  const nav = useNavigate()
  const toast = useToast()
  const { can } = useSession()
  const [open, setOpen] = useState(false)
  const [loc, setLoc] = useState('')
  const [cat, setCat] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const locs = useAsync(() => call<Loc[]>('inventory', 'locations'), [])
  const cats = useAsync(() => call<Cat[]>('inventory', 'categories'), [])
  const { data, loading, error, reload } = useAsync(() => call<Page<CountRow>>('inventory', 'countList', { limit: 100 }), [])

  const create = async () => {
    setBusy(true)
    try {
      const r = await call<{ id: number }>('inventory', 'countCreate', { locationId: loc ? Number(loc) : undefined, categoryId: cat ? Number(cat) : undefined, note: note || undefined })
      nav(`/inventory/counts/${r.id}`)
    } catch (e) { toast(errMsg(e), 'bad') } finally { setBusy(false) }
  }
  return (
    <div className="page">
      <PageHeader title="Stock counts" subtitle="Count the shelves, review variances, then apply" actions={can('inventory.adjust') ? <Button variant="primary" onClick={() => setOpen(true)}>New count</Button> : undefined} />
      {error ? <ErrorState message={error} onRetry={reload} /> : loading && !data ? <Spinner /> : (
        <Table
          rows={data?.rows ?? []}
          rowKey={(r) => r.id}
          onRowClick={(r) => nav(`/inventory/counts/${r.id}`)}
          columns={[
            { key: 'number', header: 'Count' },
            { key: 'createdAt', header: 'Started', render: (r) => fmtDate(r.createdAt) },
            { key: 'locationName', header: 'Location' },
            { key: 'status', header: 'Status', render: (r) => <Badge tone={tone(r.status)}>{r.status}</Badge> },
            { key: 'countedCount', header: 'Counted', align: 'right', render: (r) => `${r.countedCount} / ${r.itemCount}` },
            { key: 'varianceCount', header: 'Variances', align: 'right' }
          ]}
        />
      )}
      <Modal title="New stock count" open={open} onClose={() => setOpen(false)} footer={<><Button onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" disabled={busy} onClick={create}>Create count sheet</Button></>}>
        <div className="form-grid">
          <Field label="Location">
            <Select value={loc} onChange={(e) => setLoc(e.target.value)}><option value="">Default location</option>{locs.data?.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select>
          </Field>
          <Field label="Category (optional)" hint="Count only one category">
            <Select value={cat} onChange={(e) => setCat(e.target.value)}><option value="">All categories</option>{cats.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>
          </Field>
          <Field label="Note"><TextArea rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        </div>
      </Modal>
    </div>
  )
}

interface Item { variantId: number; displayName: string; sku: string; barcode: string | null; expectedQty: number; countedQty: number | null; variance: number | null; cost: number | null }
interface CountDetail {
  id: number; number: string; status: string; locationName: string; note: string; createdAt: number; appliedAt: number | null
  items: Item[]; total: number; summary: { items: number; counted: number; uncounted: number; varianceItems: number; surplusQty: number; shortageQty: number; valueImpact: number | null }
}

export function CountSheetPage() {
  const id = Number(useParams().id)
  const toast = useToast()
  const { can } = useSession()
  const [filter, setFilter] = useState<'all' | 'uncounted' | 'variance'>('all')
  const [search, setSearch] = useState('')
  const dsearch = useDebounced(search)
  const [scan, setScan] = useState('')
  const [last, setLast] = useState<{ text: string; ok: boolean } | null>(null)
  const [confirm, setConfirm] = useState<'apply' | 'cancel' | null>(null)
  const [busy, setBusy] = useState(false)
  const scanRef = useRef<HTMLInputElement>(null)
  const [offset, setOffset] = useState(0)
  // a full-catalogue sheet has 20k+ lines: fetch/render one page at a time (every scan re-fetches the current page)
  const { data, loading, error, reload } = useAsync(() => call<CountDetail>('inventory', 'countGet', { id, filter, search: dsearch || undefined, limit: COUNT_PAGE, offset }), [id, filter, dsearch, offset])
  const isOpen = data?.status === 'open'
  const canEdit = isOpen && can('inventory.adjust')

  useEffect(() => { if (canEdit) scanRef.current?.focus() }, [canEdit])

  const rec = useRef(new BoxRecorder())
  // the unit codes already counted on THIS sheet (remembered for the session so a reload does not forget them)
  const units = useMemo(() => createUnitList('this count sheet', loadStoredCodes(`count.${id}`)), [id])
  const doScan = async () => {
    const typed = (scanRef.current?.value ?? scan).trim() // DOM value: a fast reader may outrun a render
    const code = rec.current.take(typed, loadScannerConfig()).code
    noteBoxSubmit()
    if (!code) return
    setScan('')
    const isUnit = isUnitCodeText(code)
    // ACTIVE-LIST RULE for unit codes: not on this count sheet yet -> count it; already scanned -> warn, never count twice
    if (isUnit && units.claim(code) === 'duplicate') {
      beepError()
      setLast({ ok: false, text: units.duplicateText(code) })
      scanRef.current?.focus()
      return
    }
    try {
      const r = await call<{ displayName: string; countedQty: number; expectedQty: number; duplicate?: boolean; unexpected?: boolean; unit?: { code: string; status: string } }>('inventory', 'countScan', { countId: id, code })
      if (isUnit) storeCodes(`count.${id}`, units.list.codes())
      if (r.duplicate) {
        // the server already had this unit on the sheet (e.g. counted on another terminal): same rule, nothing was added
        beepError()
        setLast({ ok: false, text: units.duplicateText(code) })
      } else if (r.unexpected) {
        beepError()
        setLast({ ok: false, text: `${normalizeUnitCode(code)} counted, but it is not expected at this location (${(r.unit?.status ?? 'unknown').replace('_', ' ')}). Check it.` })
      } else {
        setLast({ ok: true, text: `${r.displayName}: counted ${r.countedQty} (expected ${r.expectedQty})${isUnit ? ` · ${normalizeUnitCode(code)}` : ''}` })
        beepOk()
      }
      reload()
    } catch (e) {
      beepError()
      if (isUnit) {
        units.release(code) // it was not counted, so it may be scanned again
        const d = (e as { code?: string; details?: { code?: string } })
        if (d.details?.code === 'UNIT_DUPLICATE') units.claim(code) // the server already has it on the sheet
        setLast({ ok: false, text: d.details?.code === 'UNIT_DUPLICATE' ? units.duplicateText(code) : (d.code === 'NOT_FOUND' && /No product matches/.test(errMsg(e))) || d.details?.code === 'UNIT_NOT_FOUND' ? notFoundMessage(code) : errMsg(e) })
      } else setLast({ ok: false, text: errMsg(e) })
    }
    scanRef.current?.focus()
  }
  const setQty = async (it: Item, raw: string) => {
    const v = raw.trim() === '' ? null : Math.floor(Number(raw))
    if (v !== null && (!Number.isFinite(v) || v < 0)) return toast('Enter a whole number', 'bad')
    if (v === it.countedQty) return
    try { await call('inventory', 'countSet', { countId: id, entries: [{ variantId: it.variantId, countedQty: v }] }); reload() } catch (e) { toast(errMsg(e), 'bad') }
  }
  const run = async () => {
    setBusy(true)
    try {
      if (confirm === 'apply') {
        const r = await call<{ adjusted: number }>('inventory', 'countApply', { countId: id })
        toast(`Count applied: ${r.adjusted} item(s) adjusted`, 'good')
      } else {
        await call('inventory', 'countCancel', { countId: id })
        toast('Count cancelled', 'info')
      }
      setConfirm(null)
      reload()
    } catch (e) { toast(errMsg(e), 'bad'); setConfirm(null) } finally { setBusy(false) }
  }

  if (error) return <div className="page"><ErrorState message={error} onRetry={reload} /></div>
  if (!data) return <div className="page"><Spinner /></div>
  const s = data.summary
  return (
    <div className="page">
      <PageHeader title={`Count ${data.number}`} subtitle={`${data.locationName} · started ${fmtDate(data.createdAt)}${data.appliedAt ? ' · applied ' + fmtDate(data.appliedAt) : ''}`}
        actions={<>
          <Badge tone={tone(data.status)}>{data.status}</Badge>
          {canEdit && <Button variant="danger" onClick={() => setConfirm('cancel')}>Cancel count</Button>}
          {canEdit && <Button variant="primary" onClick={() => setConfirm('apply')}>Review &amp; apply</Button>}
        </>} />
      <Card>
        <div className="row" style={{ gap: 24, flexWrap: 'wrap' }}>
          <span>Counted <strong>{s.counted}</strong> / {s.items}</span>
          <span>Uncounted <strong>{s.uncounted}</strong></span>
          <span>Variances <strong>{s.varianceItems}</strong></span>
          <span>Surplus <strong>+{s.surplusQty}</strong></span>
          <span>Shortage <strong>-{s.shortageQty}</strong></span>
          {s.valueImpact != null && <span>Value impact <strong>{formatINR(s.valueImpact)}</strong></span>}
        </div>
      </Card>
      <div className="toolbar" style={{ margin: '12px 0', gap: 8, flexWrap: 'wrap' }}>
        {canEdit && (
          <input ref={scanRef} className="input" style={{ maxWidth: 300 }} placeholder="Scan barcode (Enter) — adds 1 each scan" value={scan} aria-label="Scan to count"
            data-scanbox="true" onChange={(e) => setScan(e.target.value)}
            onKeyDown={(e) => {
              rec.current.key(e.nativeEvent)
              const act = scanBoxKey(e.nativeEvent, e.currentTarget.value, performance.now(), rec.current.looksFast())
              if (act === 'ignore') e.preventDefault() // 2nd half of a CR+LF terminator
              else if (act === 'submit') { e.preventDefault(); void doScan() }
            }} />
        )}
        <input className="input" style={{ maxWidth: 220 }} placeholder="Filter items…" value={search} onChange={(e) => { setSearch(e.target.value); setOffset(0) }} aria-label="Filter items" />
        <Select value={filter} onChange={(e) => { setFilter(e.target.value as typeof filter); setOffset(0) }} aria-label="Show">
          <option value="all">All items</option><option value="uncounted">Not counted yet</option><option value="variance">Variances only</option>
        </Select>
        {last && <span role="status" data-testid="count-scan-result" data-ok={last.ok ? '1' : '0'} className={last.ok ? 'muted' : ''} style={last.ok ? undefined : { color: 'var(--bad, #c0392b)' }}>{last.text}</span>}
      </div>
      <Table
        rows={data.items}
        rowKey={(r) => r.variantId}
        columns={[
          { key: 'displayName', header: 'Product', render: (r) => <>{r.displayName} <span className="muted">{r.sku}</span></> },
          { key: 'expectedQty', header: 'Expected', align: 'right' },
          { key: 'countedQty', header: 'Counted', align: 'right', render: (r) => canEdit
            ? <input key={`${r.variantId}-${r.countedQty}`} className="input input-sm" style={{ width: 80, textAlign: 'right' }} type="number" min={0} defaultValue={r.countedQty ?? ''} aria-label={`Counted ${r.displayName}`}
                onBlur={(e) => void setQty(r, e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
            : <span className="num">{r.countedQty ?? ''}</span> },
          { key: 'variance', header: 'Variance', align: 'right', render: (r) => r.variance == null ? '' : <span className="num" style={{ color: r.variance < 0 ? 'var(--bad, #c0392b)' : r.variance > 0 ? 'var(--good, #1e8449)' : undefined }}>{r.variance > 0 ? '+' : ''}{r.variance}</span> }
        ]}
      />
      <Pager total={data.total} limit={COUNT_PAGE} offset={offset} onChange={setOffset} />
      <Modal title={confirm === 'apply' ? 'Apply stock count' : 'Cancel stock count'} open={!!confirm} onClose={() => setConfirm(null)}
        footer={<><Button onClick={() => setConfirm(null)}>Back</Button><Button variant={confirm === 'apply' ? 'primary' : 'danger'} disabled={busy} onClick={run}>{confirm === 'apply' ? 'Apply adjustments' : 'Cancel count'}</Button></>}>
        {confirm === 'apply' ? (
          <>
            <p><strong>{s.varianceItems}</strong> item(s) will be adjusted (surplus +{s.surplusQty}, shortage -{s.shortageQty}).{s.valueImpact != null && <> Value impact {formatINR(s.valueImpact)}.</>}</p>
            {s.uncounted > 0 && <p className="muted">{s.uncounted} item(s) were not counted and will be left unchanged.</p>}
            <p className="muted">Once applied the count cannot be edited.</p>
          </>
        ) : <p>This discards the count sheet. Stock is not changed.</p>}
      </Modal>
    </div>
  )
}

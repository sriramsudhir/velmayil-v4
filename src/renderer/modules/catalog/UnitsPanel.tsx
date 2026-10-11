import { useCallback, useEffect, useMemo, useState } from 'react'
import { Badge, Button, Field, InlineAlert, Input, Modal, Select, Spinner, Table, useToast } from '@/ui'
import { call } from '@/lib/api'
import { useLiveRefresh } from '@/lib/live'
import { useSession } from '@/lib/session'
import { MAX_LABEL_SEQ } from '@shared/scanList'
import { LabelPrintDialog } from '@/modules/printing/LabelPrintDialog'
import {
  UNIT_STATUSES, UNIT_STATUS_LABEL, UNIT_STATUS_TONE, capacityText, generateRangeText, selectUnitsForPrint, unitErrorMessage, validateGenerateCount,
  type PrintSelection, type UnitRow, type UnitStatus
} from './unitsModel'

interface Counts { in_stock: number; sold: number; returned: number; void: number }
interface VariantLite { id: number; name: string; sku: string }
interface ListedUnit extends UnitRow { displayName?: string; invoiceNo?: string | null; voidReason?: string | null; createdAt?: number }

const PAGE = 50
const PRINTED_KEY = 'velmayil.unitsPrinted.v1'
const readPrinted = (): Set<string> => {
  try {
    const v = JSON.parse(localStorage.getItem(PRINTED_KEY) ?? '[]') as unknown
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}
const markPrinted = (codes: string[]) => {
  try {
    const s = readPrinted()
    for (const c of codes) s.add(c)
    localStorage.setItem(PRINTED_KEY, JSON.stringify([...s].slice(-20000)))
  } catch {
    /* printed marks are a convenience only */
  }
}

/**
 * "Units" drawer of a tracked product: every unit code with its status, counts, "Generate unit codes" (for stock that has no
 * code yet) and "Print unit labels" (all / in stock / not yet printed / a range) through the normal label size dialog.
 */
export function UnitsPanel({ open, onClose, productId, productName, prefix, variants }: {
  open: boolean
  onClose: () => void
  productId: number
  productName: string
  prefix: string
  variants: VariantLite[]
}) {
  const toast = useToast()
  const { can } = useSession()
  const [variantId, setVariantId] = useState<number>(variants[0]?.id ?? 0)
  const [status, setStatus] = useState<UnitStatus | ''>('')
  const [search, setSearch] = useState('')
  const [q, setQ] = useState('')
  const [offset, setOffset] = useState(0)
  const [data, setData] = useState<{ rows: ListedUnit[]; total: number } | null>(null)
  const [counts, setCounts] = useState<Counts | null>(null)
  const [used, setUsed] = useState(0)
  const [err, setErr] = useState<string | null>(null)
  const [genOpen, setGenOpen] = useState(false)
  const [genCount, setGenCount] = useState('1')
  const [genErr, setGenErr] = useState<string | null>(null)
  const [genBusy, setGenBusy] = useState(false)
  const [generated, setGenerated] = useState<{ codes: string[]; range: string } | null>(null)
  const [printOpen, setPrintOpen] = useState(false)
  const [printMode, setPrintMode] = useState<PrintSelection['mode']>('in_stock')
  const [rangeFrom, setRangeFrom] = useState('1')
  const [rangeTo, setRangeTo] = useState('1')
  const [printCodes, setPrintCodes] = useState<string[] | null>(null)
  const [printBusy, setPrintBusy] = useState(false)

  useEffect(() => { if (open) setVariantId((v) => (variants.some((x) => x.id === v) ? v : variants[0]?.id ?? 0)) }, [open, variants])
  useEffect(() => { const t = setTimeout(() => (setQ(search.trim()), setOffset(0)), 250); return () => clearTimeout(t) }, [search])

  const load = useCallback(async () => {
    if (!open || !variantId) return
    try {
      const [list, c, all] = await Promise.all([
        call<{ rows: ListedUnit[]; total: number }>('units', 'list', { variantId, status: status || undefined, search: q || undefined, limit: PAGE, offset }),
        call<Counts>('units', 'counts', { variantId }),
        call<{ total: number }>('units', 'list', { productId, limit: 1 })
      ])
      setData(list); setCounts(c); setUsed(all.total); setErr(null)
    } catch (e) {
      setErr(unitErrorMessage(e))
    }
  }, [open, variantId, productId, status, q, offset])
  useEffect(() => { void load() }, [load])
  useLiveRefresh(['units', 'inventory', 'pos', 'purchases'], () => void load())

  const canGenerate = can('inventory.adjust')
  const printed = useMemo(() => readPrinted(), [data, printCodes]) // eslint-disable-line react-hooks/exhaustive-deps

  const generate = async () => {
    const v = validateGenerateCount(genCount, used, prefix)
    if (!v.ok) return setGenErr(v.message)
    setGenBusy(true)
    setGenErr(null)
    try {
      const r = await call<{ codes: string[]; prefix: string; firstSeq: number; lastSeq: number }>('units', 'generate', { variantId, count: v.count, reason: 'Generated from the Units tab' })
      setGenerated({ codes: r.codes, range: generateRangeText(r.prefix, r.firstSeq, r.lastSeq) })
      toast(`${r.codes.length} unit code${r.codes.length === 1 ? '' : 's'} generated`, 'good')
      void load()
    } catch (e) {
      setGenErr(unitErrorMessage(e))
    } finally {
      setGenBusy(false)
    }
  }

  const fetchAll = async (): Promise<UnitRow[]> => {
    const rows: ListedUnit[] = []
    for (let off = 0; off < MAX_LABEL_SEQ; off += 500) {
      const r = await call<{ rows: ListedUnit[]; total: number }>('units', 'list', { variantId, limit: 500, offset: off })
      rows.push(...r.rows)
      if (rows.length >= r.total) break
    }
    return rows.sort((a, b) => a.code.localeCompare(b.code)).map((u) => ({ ...u, printedAt: printed.has(u.code) ? 1 : u.labelPrintedAt ?? null }))
  }

  const choosePrint = async () => {
    setPrintBusy(true)
    try {
      const all = await fetchAll()
      const sel: PrintSelection = printMode === 'range' ? { mode: 'range', from: Number(rangeFrom) || 1, to: Number(rangeTo) || 1 } : { mode: printMode }
      const codes = selectUnitsForPrint(all, sel)
      if (!codes.length) { toast('No unit codes match that choice', 'bad'); return }
      setPrintOpen(false)
      setPrintCodes(codes)
    } catch (e) {
      toast(unitErrorMessage(e), 'bad')
    } finally {
      setPrintBusy(false)
    }
  }

  const total = data?.total ?? 0
  return (
    <Modal
      wide open={open} onClose={onClose} title={`Units - ${productName}`}
      footer={<Button onClick={onClose}>Close</Button>}
    >
      <div data-testid="units-panel">
        <p className="muted" style={{ marginTop: 0 }}>{capacityText(prefix, used)}</p>
        {err && <InlineAlert tone="bad">{err}</InlineAlert>}
        <div className="row" style={{ gap: 8, flexWrap: 'wrap', margin: '8px 0' }}>
          {variants.length > 1 && (
            <Select aria-label="Variant" value={variantId} onChange={(e) => { setVariantId(Number(e.target.value)); setOffset(0) }} style={{ width: 'auto' }}>
              {variants.map((v) => <option key={v.id} value={v.id}>{v.name || v.sku}</option>)}
            </Select>
          )}
          {counts && UNIT_STATUSES.map((s) => (
            <button key={s} type="button" className="btn btn-ghost" aria-pressed={status === s} data-testid={`units-count-${s}`}
              onClick={() => { setStatus(status === s ? '' : s); setOffset(0) }}>
              <Badge tone={UNIT_STATUS_TONE[s]}>{UNIT_STATUS_LABEL[s]}</Badge> <strong>{counts[s]}</strong>
            </button>
          ))}
          <span className="toolbar-spacer" />
          {canGenerate && <Button onClick={() => { setGenerated(null); setGenErr(null); setGenOpen(true) }}>Generate unit codes</Button>}
          <Button variant="primary" onClick={() => setPrintOpen(true)} disabled={!counts || counts.in_stock + counts.sold + counts.returned === 0}>Print unit labels</Button>
        </div>
        <div className="row" style={{ gap: 8, margin: '0 0 8px' }}>
          <Input aria-label="Search unit codes" placeholder="Search a unit code…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ maxWidth: 260 }} />
          <Select aria-label="Status" value={status} onChange={(e) => { setStatus(e.target.value as UnitStatus | ''); setOffset(0) }} style={{ width: 'auto' }}>
            <option value="">All statuses</option>
            {UNIT_STATUSES.map((s) => <option key={s} value={s}>{UNIT_STATUS_LABEL[s]}</option>)}
          </Select>
        </div>
        {!data ? <Spinner /> : (
          <Table
            rows={data.rows}
            rowKey={(r) => r.code}
            empty={<p className="muted">No unit codes yet. Turn on tracking with stock, receive a purchase, or use "Generate unit codes".</p>}
            columns={[
              { key: 'code', header: 'Unit code', render: (r) => <strong style={{ letterSpacing: '.04em' }}>{r.code}</strong> },
              { key: 'status', header: 'Status', render: (r) => <Badge tone={UNIT_STATUS_TONE[r.status]}>{UNIT_STATUS_LABEL[r.status]}</Badge> },
              { key: 'invoiceNo', header: 'Sold on bill', render: (r) => r.invoiceNo ?? '' },
              { key: 'voidReason', header: 'Note', render: (r) => r.voidReason ?? '' },
              { key: 'printed', header: 'Label', render: (r) => (printed.has(r.code) || r.labelPrintedAt ? <span className="muted">printed</span> : <span className="muted">—</span>) }
            ]}
          />
        )}
        {total > PAGE && (
          <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
            <span className="muted">{offset + 1}-{Math.min(offset + PAGE, total)} of {total}</span>
            <Button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Prev</Button>
            <Button disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>Next</Button>
          </div>
        )}
      </div>

      <Modal open={genOpen} onClose={() => setGenOpen(false)} title="Generate unit codes"
        footer={<>
          <Button onClick={() => setGenOpen(false)}>{generated ? 'Done' : 'Cancel'}</Button>
          {generated ? <Button variant="primary" onClick={() => { setPrintCodes(generated.codes); setGenOpen(false) }}>Print these labels</Button>
            : <Button variant="primary" disabled={genBusy} onClick={() => void generate()}>{genBusy ? 'Generating…' : 'Generate'}</Button>}
        </>}>
        {generated ? (
          <InlineAlert tone="good" title={`${generated.codes.length} unit code${generated.codes.length === 1 ? '' : 's'} generated`}>
            <span data-testid="generated-range">{generated.range}</span>. Print their labels now, or later from this tab.
          </InlineAlert>
        ) : (
          <>
            <p className="muted" style={{ marginTop: 0 }}>Gives a code to units that are in stock but have none yet. {capacityText(prefix, used)}</p>
            <Field label="How many units?" error={genErr ?? undefined}>
              <Input autoFocus inputMode="numeric" value={genCount} onChange={(e) => setGenCount(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void generate() }} aria-label="Number of units" />
            </Field>
          </>
        )}
      </Modal>

      <Modal open={printOpen} onClose={() => setPrintOpen(false)} title="Print unit labels"
        footer={<><Button onClick={() => setPrintOpen(false)}>Cancel</Button><Button variant="primary" disabled={printBusy} onClick={() => void choosePrint()}>{printBusy ? 'Preparing…' : 'Choose label size…'}</Button></>}>
        <Field label="Which units?">
          <Select aria-label="Which units" value={printMode} onChange={(e) => setPrintMode(e.target.value as PrintSelection['mode'])}>
            <option value="in_stock">In stock only</option>
            <option value="unprinted">Not printed yet</option>
            <option value="all">All (except void)</option>
            <option value="range">A range of numbers</option>
          </Select>
        </Field>
        {printMode === 'range' && (
          <div className="row" style={{ gap: 8 }}>
            <Field label="From number"><Input inputMode="numeric" value={rangeFrom} onChange={(e) => setRangeFrom(e.target.value)} aria-label="Range from" /></Field>
            <Field label="To number"><Input inputMode="numeric" value={rangeTo} onChange={(e) => setRangeTo(e.target.value)} aria-label="Range to" /></Field>
          </div>
        )}
      </Modal>

      <LabelPrintDialog
        open={printCodes !== null}
        onClose={() => { setPrintCodes(null); void load() }}
        onPrinted={() => { if (printCodes) markPrinted(printCodes) }}
        variantIds={[]} unitCodes={printCodes ?? []} unitVariantId={variantId}
        heading={printCodes ? `${printCodes.length} unit label${printCodes.length === 1 ? '' : 's'} ready: ${printCodes[0]}${printCodes.length > 1 ? ` to ${printCodes[printCodes.length - 1]}` : ''}` : undefined}
      />
    </Modal>
  )
}

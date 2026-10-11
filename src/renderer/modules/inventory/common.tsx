import { useEffect, useRef, useState } from 'react'
import { call, errMsg } from '@/lib/api'
import { Button, useToast } from '@/ui'
import { toPaise } from '@shared/money'
import { BoxRecorder, noteBoxSubmit, scanBoxKey } from '@/lib/scanInput'
import { loadScannerConfig, visibleCode } from '@/lib/scanner'
import { beepError, beepOk } from '@/ui/sound'
import { isUnitCodeText, notFoundMessage, type UnitList } from './unitScan'

export interface Page<T> { rows: T[]; total: number }
export interface Loc { id: number; name: string; isDefault: number }
export interface Cat { id: number; name: string }

export interface Picked {
  variantId: number
  displayName: string
  sku: string
  barcode: string | null
  cost: number | null
  taxRateBp: number
  price: number
  stock: number
  trackStock: boolean
  trackUnits?: boolean
}

export const fmtDate = (ts: number | null | undefined): string =>
  ts ? new Date(ts).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''

export function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

/** Parse a rupee text box ("1,250.50") into paise; NaN-safe (returns 0). */
export const rupeesToPaise = (s: string): number => {
  try {
    const n = toPaise(s || '0')
    return Number.isFinite(n) && n >= 0 ? n : 0
  } catch {
    return 0
  }
}
export const paiseToText = (p: number | null | undefined): string => (p ? (p / 100).toFixed(2) : '')

export function downloadCsv(filename: string, header: string[], rows: (string | number | null)[][]): void {
  const esc = (v: string | number | null) => {
    const s = v == null ? '' : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const csv = [header, ...rows].map((r) => r.map(esc).join(',')).join('\r\n')
  const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function Pager({ total, limit, offset, onChange }: { total: number; limit: number; offset: number; onChange: (o: number) => void }) {
  if (total <= limit) return null
  return (
    <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
      <span className="muted">{offset + 1}-{Math.min(offset + limit, total)} of {total}</span>
      <Button disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - limit))}>Prev</Button>
      <Button disabled={offset + limit >= total} onClick={() => onChange(offset + limit)}>Next</Button>
    </div>
  )
}

/**
 * Scan-or-search product picker. Enter on an exact barcode/SKU picks directly; otherwise shows matches
 * (arrow keys + Enter, or click). Used by purchases, returns, transfers, adjustments.
 */
export function ProductPicker({ onPick, placeholder = 'Scan barcode or search product…', autoFocus, unitList, onlyAvailableUnits, onKnownUnit }: {
  /** `unitCode` is set when a unit label (PREFIX-NNNN) was scanned (only with `unitList`). */
  onPick: (p: Picked, unitCode?: string) => void
  placeholder?: string
  autoFocus?: boolean
  /** ACTIVE LIST for unit codes: a scanned unit code is added once; scanning it again shows a duplicate warning. */
  unitList?: UnitList
  /** Reject units that are not on the shelf (sold / void). For transfers. */
  onlyAvailableUnits?: boolean
  /** Return a message to refuse an already-known unit (receiving: it was received before). */
  onKnownUnit?: (unit: { code: string; status: string }) => string | null
}) {
  const [q, setQ] = useState('')
  const [results, setResults] = useState<Picked[]>([])
  const [sel, setSel] = useState(0)
  const toast = useToast()
  const ref = useRef<HTMLInputElement>(null)
  const dq = useDebounced(q, 200)

  useEffect(() => {
    let live = true
    if (dq.trim().length < 2) { setResults([]); return }
    call<Picked[]>('inventory', 'search', { text: dq, limit: 12 }).then((r) => { if (live) { setResults(r); setSel(0) } }).catch(() => {})
    return () => { live = false }
  }, [dq])

  const pick = (p: Picked, unitCode?: string) => { onPick(p, unitCode); setQ(''); setResults([]); ref.current?.focus() }

  const rec = useRef(new BoxRecorder())
  const onKey = async (e: React.KeyboardEvent<HTMLInputElement>) => {
    rec.current.key(e.nativeEvent)
    // a barcode reader types the code into the focused box and ends with Enter (or Tab; CR+LF sends a 2nd terminator): works at any speed
    const act = scanBoxKey(e.nativeEvent, e.currentTarget.value, performance.now(), rec.current.looksFast())
    if (act === 'ignore') { e.preventDefault(); return }
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(s + 1, results.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)) }
    else if (e.key === 'Escape') setResults([])
    else if (act === 'submit') {
      e.preventDefault()
      const typed = e.currentTarget.value.trim() // the DOM value: a 1 ms/key reader may outrun a React render
      const code = rec.current.take(typed, loadScannerConfig()).code
      noteBoxSubmit()
      if (!code) return
      if (unitList && isUnitCodeText(code)) {
        setQ('')
        if (unitList.claim(code) === 'duplicate') {
          beepError()
          toast(unitList.duplicateText(code), 'bad')
          return
        }
        try {
          const r = await call<{ unit: { code: string; status: string }; variant: { sku: string } } | null>('units', 'resolve', { code })
          if (!r) {
            unitList.release(code)
            // an all-digit code has the shape of a label number but may just as well be an ordinary product barcode
            const exact = /^\d+$/.test(code) ? await call<Picked | null>('inventory', 'lookup', { code }) : null
            if (exact) return pick(exact)
            beepError()
            toast(notFoundMessage(code), 'bad')
            return
          }
          if (onlyAvailableUnits && r.unit.status !== 'in_stock' && r.unit.status !== 'returned') {
            unitList.release(code)
            beepError()
            toast(`Unit ${r.unit.code} is ${r.unit.status.replace('_', ' ')} and cannot be used here.`, 'bad')
            return
          }
          const p = await call<Picked | null>('inventory', 'lookup', { code: r.variant.sku })
          if (!p) {
            unitList.release(code)
            beepError()
            toast(notFoundMessage(code), 'bad')
            return
          }
          const note = onKnownUnit?.(r.unit)
          if (note) {
            unitList.release(code)
            beepError()
            toast(note, 'bad')
            return
          }
          unitList.bind(code, p.variantId)
          beepOk()
          return pick(p, r.unit.code)
        } catch (err) {
          unitList.release(code)
          beepError()
          toast(errMsg(err), 'bad')
          return
        }
      }
      try {
        const exact = await call<Picked | null>('inventory', 'lookup', { code })
        if (exact) return pick(exact)
        if (results[sel] && !/^\d{6,}$/.test(code)) return pick(results[sel])
        toast(`No product found for "${visibleCode(code)}"`, 'bad')
      } catch (err) { toast(errMsg(err), 'bad') }
    }
  }

  return (
    <div style={{ position: 'relative', minWidth: 280, flex: 1 }}>
      <input ref={ref} className="input" autoFocus={autoFocus} value={q} placeholder={placeholder} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} aria-label="Find product" data-scanbox="true" />
      {results.length > 0 && (
        <div className="card" style={{ position: 'absolute', zIndex: 20, left: 0, right: 0, top: '100%', maxHeight: 280, overflow: 'auto', padding: 4 }}>
          {results.map((r, i) => (
            <div key={r.variantId} className="menu-item" role="option" aria-selected={i === sel} onMouseDown={() => pick(r)} style={{ cursor: 'pointer', padding: '6px 8px', background: i === sel ? 'var(--accent-soft, rgba(0,0,0,.06))' : undefined, display: 'flex', justifyContent: 'space-between', gap: 12 }}>
              <span>{r.displayName} <span className="muted">{r.sku}</span></span>
              <span className="muted">stock {r.stock}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

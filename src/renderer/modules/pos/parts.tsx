import { useEffect, useRef, useState } from 'react'
import { Button, Select, useToast } from '@/ui'
import type { Discount } from '@shared/billing'
import { listPrinters, printDocument, retryPrint, prefs, savePdf, type PrinterChoice, type PrintRef, type PrintTemplate } from './printAdapter'
import { parseQtyText } from './unitCart'
import './pos.css'

export const rupeesStr = (p: number): string => (p % 100 === 0 ? String(p / 100) : (p / 100).toFixed(2))
/** "123.45" -> 12345; null when not a valid non-negative amount. */
export function parseRupees(s: string): number | null {
  const t = s.replace(/[₹,\s]/g, '')
  if (!/^\d*\.?\d{0,2}$/.test(t) || t === '' || t === '.') return null
  return Math.round(Number(t) * 100)
}

/** Rupee input that commits on blur / Enter (keeps what the cashier typed while editing). */
export function MoneyField({ value, onCommit, disabled, width = 90, title, id }: { value: number; onCommit: (paise: number) => void; disabled?: boolean; width?: number; title?: string; id?: string }) {
  const [text, setText] = useState(rupeesStr(value))
  useEffect(() => setText(rupeesStr(value)), [value])
  const commit = () => {
    const p = parseRupees(text)
    if (p == null) setText(rupeesStr(value))
    else if (p !== value) onCommit(p)
  }
  return (
    <input
      id={id}
      className="input pos-num"
      style={{ width }}
      inputMode="decimal"
      disabled={disabled}
      title={title}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onFocus={(e) => e.target.select()}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); (e.target as HTMLInputElement).blur() } }}
    />
  )
}

/**
 * Quantity of a bill line. The cashier can clear the box and type a new number: the line keeps its quantity until the text
 * is a whole number of at least 1 (an empty box or "0" never becomes quantity 1 behind the cashier's back, "1.5" is refused).
 */
export function QtyField({ value, onCommit, readOnly, onDone, commitOnBlur }: {
  value: number; onCommit: (qty: number) => void; readOnly?: boolean; onDone?: () => void
  /** Commit once, when the cashier leaves the box or presses Enter (a line with unit codes: "12" must not pass through quantity 1 on the way) */
  commitOnBlur?: boolean
}) {
  const [text, setText] = useState(String(value))
  useEffect(() => setText(String(value)), [value])
  return (
    <input
      className="input pos-num" inputMode="numeric" aria-label="Quantity" readOnly={readOnly} value={text}
      onChange={(e) => {
        const t = e.target.value
        if (!/^[\d,\s]*$/.test(t)) return // letters, minus, decimal point: not a quantity
        setText(t)
        const q = parseQtyText(t)
        if (!commitOnBlur && q != null && q !== value) onCommit(q)
      }}
      onBlur={() => {
        const q = parseQtyText(text)
        setText(String(value))
        if (commitOnBlur && q != null && q !== value) onCommit(q)
      }}
      onFocus={(e) => e.target.select()}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur(); onDone?.() } }}
    />
  )
}

const discountText = (d: Discount): string => (!d || d.value === 0 ? '' : d.type === 'amount' ? rupeesStr(d.value) : String(d.value / 100))

/** Discount editor: amount in rupees or percent. */
export function DiscountField({ value, onChange, disabled, width = 70 }: { value: Discount; onChange: (d: Discount) => void; disabled?: boolean; width?: number }) {
  // the chosen unit is kept here: with an empty box there is no discount object to remember "%" in
  const [type, setType] = useState<'amount' | 'percent'>(value?.type ?? 'amount')
  const [text, setText] = useState(discountText(value))
  const vType = value?.type
  const vValue = value?.value ?? 0
  useEffect(() => { if (vType) setType(vType); setText(discountText(vType ? { type: vType, value: vValue } : null)) }, [vType, vValue])
  const commit = (t: string, ty: 'amount' | 'percent') => {
    if (t.trim() === '') return onChange(null)
    let next: Discount
    if (ty === 'amount') {
      const p = parseRupees(t)
      if (p == null) return setText(discountText(value)) // not a number: show the discount that is really applied
      next = p === 0 ? null : { type: 'amount', value: p }
    } else {
      const n = Number(t.replace(/[%\s]/g, ''))
      if (!Number.isFinite(n) || n < 0) return setText(discountText(value))
      const bp = Math.min(10000, Math.round(n * 100))
      next = bp === 0 ? null : { type: 'percent', value: bp }
    }
    setText(discountText(next))
    onChange(next)
  }
  return (
    <span className="pos-disc">
      <input
        className="input pos-num" style={{ width }} inputMode="decimal" disabled={disabled} placeholder="0" value={text}
        onChange={(e) => setText(e.target.value)} onBlur={() => commit(text, type)} onFocus={(e) => e.target.select()}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur() } }}
        aria-label="Discount"
      />
      <select className="input pos-unit" disabled={disabled} value={type} onChange={(e) => { const ty = e.target.value as 'amount' | 'percent'; setType(ty); commit(text, ty) }} aria-label="Discount type">
        <option value="amount">₹</option>
        <option value="percent">%</option>
      </select>
    </span>
  )
}

/**
 * Print / reprint controls with the failure handling required by the contract: a print failure shows
 * "Sale completed. Printing failed." (after a sale) with Retry / Reprint / Save PDF / Select printer and never re-submits anything.
 */
export function PrintActions({ printRef, invoiceNo, afterSale, autoPrint }: { printRef: PrintRef; invoiceNo: string; afterSale?: boolean; autoPrint?: boolean }) {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [last, setLast] = useState<PrintTemplate>(prefs.template())
  const [printers, setPrinters] = useState<PrinterChoice[] | null>(null)
  const [printerId, setPrinterId] = useState<number | undefined>(prefs.printerId())
  const [receipt, setReceipt] = useState<PrintTemplate>(prefs.template() === 'invoiceA4' || prefs.template() === 'invoiceA5' ? 'receipt80' : (prefs.template()))
  const autoDone = useRef(false)
  const failedLog = useRef<number | undefined>(undefined)

  const run = async (t: PrintTemplate, pid = printerId) => {
    if (busy) return
    setBusy(true)
    setLast(t)
    try {
      const r = await printDocument(printRef, t, pid)
      failedLog.current = r.ok ? undefined : r.logId
      if (r.ok) { setError(null); toast(r.warning ?? 'Sent to printer', r.warning ? 'info' : 'good') } else setError(r.error ?? 'Printing failed')
    } catch (e) {
      // never leave the buttons stuck on "Printing…": the sale is saved, the cashier can retry or save a PDF
      setError(e instanceof Error && e.message ? e.message : 'Printing failed')
    } finally {
      setBusy(false)
    }
  }
  /** Retry re-sends the kept failed job when there is one; otherwise it re-renders. */
  const retry = async () => {
    if (failedLog.current == null) return run(last)
    if (busy) return
    setBusy(true)
    try {
      const r = await retryPrint(failedLog.current, printerId)
      failedLog.current = r.ok ? undefined : r.logId ?? failedLog.current
      if (r.ok) { setError(null); toast(r.warning ?? 'Sent to printer', r.warning ? 'info' : 'good') } else setError(r.error ?? 'Printing failed')
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : 'Printing failed')
    } finally {
      setBusy(false)
    }
  }
  useEffect(() => {
    if (autoPrint && !autoDone.current) { autoDone.current = true; void run(receipt) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const pdf = async () => {
    try {
      const r = await savePdf(printRef, last, `${invoiceNo}.pdf`)
      if (r.ok) toast(r.path ? `Saved ${r.path}` : 'PDF saved', 'good')
      else toast(r.error ?? 'Could not save PDF', 'bad')
    } catch (e) { toast(e instanceof Error && e.message ? e.message : 'Could not save PDF', 'bad') }
  }
  const choosePrinter = async () => {
    if (printers != null) return setPrinters(null)
    try { setPrinters(await listPrinters()) } catch { setPrinters([]) }
  }

  return (
    <div className="pos-print">
      <div className="row">
        <Select style={{ width: 110 }} value={receipt} onChange={(e) => { const t = e.target.value as PrintTemplate; setReceipt(t); prefs.setTemplate(t) }} aria-label="Receipt size">
          <option value="receipt58">58 mm</option>
          <option value="receipt80">80 mm</option>
        </Select>
        <Button variant="primary" disabled={busy} onClick={() => run(receipt)}>{busy ? 'Printing…' : 'Print Receipt'}</Button>
        <Button disabled={busy} onClick={() => run('invoiceA4')}>Print A4</Button>
        <Button disabled={busy} onClick={() => run('invoiceA5')}>Print A5</Button>
      </div>
      {error && (
        <div className="pos-print-fail" role="alert">
          <strong>{afterSale ? 'Sale completed. Printing failed.' : 'Printing failed.'}</strong>
          <p>{error}</p>
          <div className="row">
            <Button disabled={busy} onClick={retry}>Retry</Button>
            <Button disabled={busy} onClick={() => run(receipt)}>Reprint</Button>
            <Button onClick={pdf}>Save PDF</Button>
            <Button onClick={choosePrinter}>Select printer</Button>
          </div>
          {printers != null && (
            <div className="row" style={{ marginTop: 8 }}>
              {printers.length === 0 ? (
                <span className="muted">No printer profiles found. Configure printers in Printing settings.</span>
              ) : (
                <Select value={printerId ?? ''} onChange={(e) => { const id = e.target.value ? Number(e.target.value) : undefined; setPrinterId(id); prefs.setPrinterId(id); setPrinters(null); void run(last, id) }}>
                  <option value="">System default printer</option>
                  {printers.map((p) => <option key={p.id} value={p.id}>{p.name}{p.deviceName ? ` (${p.deviceName})` : ''}</option>)}
                </Select>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

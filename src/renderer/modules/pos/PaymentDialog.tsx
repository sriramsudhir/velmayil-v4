import { useEffect, useMemo, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { Button, Input, Modal, Select } from '@/ui'
import { ApprovalDialog } from '@/modules/auth/ApprovalDialog'
import { formatINR } from '@shared/money'
import { quickCashAmounts, settlePayments, upiPayUri } from '@shared/billing'
import { ApiError } from '@/lib/api'
import { parseRupees, rupeesStr } from './parts'
import type { Approval, PayMethod, PayRow } from './types'

type Mode = 'cash' | 'upi' | 'card' | 'other' | 'split' | 'credit'
const MODES: { v: Mode; label: string }[] = [
  { v: 'cash', label: 'Cash' }, { v: 'upi', label: 'UPI' }, { v: 'card', label: 'Card' }, { v: 'other', label: 'Other online' }, { v: 'split', label: 'Mixed / split' }, { v: 'credit', label: 'Credit' }
]
const SPLIT_METHODS: { v: PayMethod; label: string }[] = [
  { v: 'cash', label: 'Cash' }, { v: 'upi', label: 'UPI' }, { v: 'card', label: 'Card' }, { v: 'other', label: 'Other online' }, { v: 'credit', label: 'Credit (on account)' }
]
let rowSeq = 1
const lsGet = (k: string) => { try { return localStorage.getItem(k) } catch { return null } }
const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v) } catch { /* ignore */ } }

/** Rupee input that reports every keystroke (the change/balance display must follow the cashier's typing instantly). */
function AmountInput({ value, onChange, id, width, placeholder, big }: { value: number; onChange: (paise: number) => void; id?: string; width?: number | string; placeholder?: string; big?: boolean }) {
  const [text, setText] = useState(value ? rupeesStr(value) : '')
  useEffect(() => { if ((parseRupees(text) ?? 0) !== value) setText(value ? rupeesStr(value) : '') }, [value]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <input
      id={id} className={`input pos-num${big ? ' pos-cash-input' : ''}`} style={{ width }} inputMode="decimal" autoComplete="off" placeholder={placeholder}
      value={text} onFocus={(e) => e.target.select()} aria-label={big ? 'Cash received' : 'Amount'}
      onChange={(e) => {
        const t = e.target.value
        // digits with at most one decimal point and two decimals: "12.345" used to stay in the box while the amount counted was the previous one
        if (!/^[\d,₹\s]*\.?\d{0,2}$/.test(t)) return
        setText(t)
        onChange(t.trim() === '' ? 0 : (parseRupees(t) ?? value))
      }}
    />
  )
}

export function PaymentDialog({ open, total, hasCustomer, upiId, payeeName, invoiceHint, onClose, onSubmit }: {
  open: boolean
  total: number
  hasCustomer: boolean
  /** shop UPI id (Settings > Billing); enables the on-screen QR in UPI mode */
  upiId?: string
  payeeName?: string
  invoiceHint?: string
  onClose: () => void
  /** Must perform the sale. Throw (ApiError) on failure. The parent keeps the same requestId across retries. */
  onSubmit: (payments: { method: PayMethod; amount: number; reference?: string }[], approval?: Approval) => Promise<void>
}) {
  const [mode, setMode] = useState<Mode>('cash')
  const [cash, setCash] = useState(0) // 0 = nothing typed yet => exact amount
  const [ref, setRef] = useState('')
  const [rows, setRows] = useState<PayRow[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [needApproval, setNeedApproval] = useState(false)
  const [qr, setQr] = useState('')
  const submitting = useRef(false)
  const cashRef = useRef<HTMLDivElement>(null)
  const refInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      const saved = lsGet('pos.payMode') as Mode | null
      setMode(saved && MODES.some((m) => m.v === saved) && saved !== 'credit' && saved !== 'split' ? saved : 'cash')
      setCash(0); setRef('')
      setRows(total > 0 ? [{ id: rowSeq++, method: 'cash', amount: 0, reference: '' }, { id: rowSeq++, method: 'upi', amount: 0, reference: '' }] : [])
      setError(null); setNeedApproval(false); setBusy(false)
      submitting.current = false
    }
  }, [open, total])
  useEffect(() => {
    if (!open) return
    const t = setTimeout(() => {
      if (mode === 'cash') cashRef.current?.querySelector('input')?.focus()
      else if (mode === 'upi' || mode === 'card' || mode === 'other') refInput.current?.focus()
    }, 30)
    return () => clearTimeout(t)
  }, [open, mode])

  const pickMode = (m: Mode) => { setMode(m); setError(null); if (m !== 'split' && m !== 'credit') lsSet('pos.payMode', m) }

  const payments = useMemo<{ method: PayMethod; amount: number; reference?: string }[]>(() => {
    if (total <= 0) return []
    if (mode === 'cash') return [{ method: 'cash', amount: cash > 0 ? cash : total }]
    if (mode === 'split') return rows.filter((r) => r.amount > 0).map((r) => ({ method: r.method, amount: r.amount, reference: r.reference || undefined }))
    return [{ method: mode, amount: total, reference: mode === 'credit' ? undefined : ref.trim() || undefined }] // online / credit: exactly the bill, never more
  }, [mode, cash, rows, ref, total])

  const s = useMemo(() => settlePayments(total, payments), [total, payments])
  const cashTendered = payments.filter((p) => p.method === 'cash').reduce((a, p) => a + p.amount, 0)
  const overNoCash = s.tendered - total > cashTendered
  const creditNoCustomer = payments.some((p) => p.method === 'credit') && !hasCustomer
  const valid = s.balanceDue === 0 && !overNoCash && !creditNoCustomer && (total === 0 || payments.length > 0)
  const received = s.tendered

  const uri = mode === 'upi' && upiId ? upiPayUri({ upiId, payeeName, amount: total, note: invoiceHint }) : ''
  useEffect(() => {
    let live = true
    if (!uri) { setQr(''); return }
    QRCode.toDataURL(uri, { margin: 1, width: 220, errorCorrectionLevel: 'M' }).then((d) => { if (live) setQr(d) }).catch(() => { if (live) setQr('') })
    return () => { live = false }
  }, [uri])

  const updateRow = (id: number, patch: Partial<PayRow>) => setRows((x) => x.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  const fillRow = (id: number) => setRows((x) => {
    const others = x.filter((r) => r.id !== id).reduce((a, r) => a + r.amount, 0)
    return x.map((r) => (r.id === id ? { ...r, amount: Math.max(0, total - others) } : r))
  })

  const confirm = async (approval?: Approval) => {
    if (!valid || submitting.current) return
    submitting.current = true
    setBusy(true)
    setError(null)
    try {
      await onSubmit(payments, approval)
    } catch (e) {
      if (e instanceof ApiError && e.code === 'APPROVAL_REQUIRED') setNeedApproval(true)
      setError(e instanceof Error ? e.message : String(e))
      submitting.current = false
      setBusy(false)
    }
  }

  const quick = mode === 'cash' ? quickCashAmounts(total) : []
  const showChange = s.change > 0
  const showDue = s.balanceDue > 0

  return (
    <Modal
      title="Payment" open={open} onClose={() => !busy && onClose()} wide
      footer={<>
        <Button onClick={onClose} disabled={busy}>Back</Button>
        <Button variant="primary" onClick={() => void confirm()} disabled={!valid || busy}>{busy ? 'Saving…' : `Complete sale (${formatINR(total)})`}</Button>
      </>}
    >
      <div onKeyDown={(e) => {
        // React also delivers keys typed in the manager-approval window here (it is a child of this component although it is
        // drawn as its own dialog): Enter there must submit the approval, not re-send the sale without one.
        if (!e.currentTarget.contains(e.target as Node)) return
        const tag = (e.target as HTMLElement).tagName
        if (e.key === 'Enter' && tag !== 'BUTTON' && tag !== 'SELECT') { e.preventDefault(); void confirm() }
      }}>
        <div className="row" style={{ justifyContent: 'space-between', fontSize: 22, fontWeight: 700, marginBottom: 8 }}>
          <span>Amount due</span><span data-testid="amount-due">{formatINR(total)}</span>
        </div>

        <div className="pos-modes" role="tablist" aria-label="Payment type">
          {MODES.map((m) => (
            <Button key={m.v} role="tab" aria-selected={mode === m.v} variant={mode === m.v ? 'primary' : 'default'} onClick={() => pickMode(m.v)}>{m.label}</Button>
          ))}
        </div>

        {mode === 'cash' && total > 0 && (
          <div ref={cashRef}>
            <label className="pos-cash-label" htmlFor="pay-cash">Cash received from customer (₹)</label>
            <AmountInput id="pay-cash" big value={cash} onChange={setCash} width="100%" placeholder={`${rupeesStr(total)}  (leave empty for exact)`} />
            <div className="pos-quick" aria-label="Quick cash amounts">
              {quick.map((q) => <Button key={q} onClick={() => { setCash(q === total ? 0 : q); setTimeout(() => cashRef.current?.querySelector('input')?.focus(), 0) }}>{q === total ? 'Exact' : formatINR(q, { symbol: false })}</Button>)}
            </div>
          </div>
        )}

        {(mode === 'upi' || mode === 'card' || mode === 'other') && (
          <div className="pos-online">
            <div>
              <p className="muted" style={{ margin: '0 0 6px' }}>Online payment is for the exact bill amount ({formatINR(total)}). No change can be given on online payments.</p>
              <label className="pos-cash-label" htmlFor="pay-ref">{mode === 'upi' ? 'UPI reference / transaction id' : mode === 'card' ? 'Card approval code / last 4 digits' : 'Payment reference'} (optional)</label>
              <Input id="pay-ref" ref={refInput} value={ref} onChange={(e) => setRef(e.target.value)} maxLength={100} placeholder="Reference no." autoComplete="off" />
            </div>
            {mode === 'upi' && (
              <div className="pos-qr" data-testid="upi-qr">
                {qr ? <><img src={qr} alt={`UPI QR for ${formatINR(total)}`} width={170} height={170} /><div className="muted">Scan to pay {formatINR(total)}<br />{upiId}</div></>
                  : <div className="muted">{upiId ? 'Could not draw the QR.' : 'Set the shop UPI id in Settings > Billing to show a payment QR here.'}</div>}
              </div>
            )}
          </div>
        )}

        {mode === 'credit' && <p className="muted">The full amount ({formatINR(total)}) is put on the customer's account.</p>}

        {mode === 'split' && (
          <div>
            <p className="muted" style={{ margin: '0 0 6px' }}>Enter how much was paid by each method. Change is only returned from the cash part.</p>
            {rows.map((r, i) => (
              <div className="pos-payrow" key={r.id}>
                <Select value={r.method} onChange={(e) => updateRow(r.id, { method: e.target.value as PayMethod })} aria-label="Method">
                  {SPLIT_METHODS.map((m) => <option key={m.v} value={m.v}>{m.label}</option>)}
                </Select>
                <span className="row" style={{ flexWrap: 'nowrap' }}>
                  <AmountInput value={r.amount} onChange={(p) => updateRow(r.id, { amount: p })} id={i === 0 ? 'pay-first' : undefined} width={120} placeholder="0" />
                  <Button size="sm" onClick={() => fillRow(r.id)} title="Put the remaining balance here">Rest</Button>
                </span>
                <Input placeholder={r.method === 'cash' ? 'Reference (optional)' : 'Ref / txn id'} value={r.reference} onChange={(e) => updateRow(r.id, { reference: e.target.value })} />
                <Button variant="ghost" aria-label="Remove payment" onClick={() => setRows((x) => x.filter((y) => y.id !== r.id))}>✕</Button>
              </div>
            ))}
            <Button onClick={() => setRows((x) => [...x, { id: rowSeq++, method: 'card', amount: 0, reference: '' }])}>+ Add payment method</Button>
          </div>
        )}

        <div className="pos-panel pos-totals" style={{ marginTop: 12 }}>
          <div><span>Bill total</span><strong>{formatINR(total)}</strong></div>
          <div><span>Received{mode === 'cash' && cash === 0 ? ' (exact)' : ''}</span><strong data-testid="received">{formatINR(received)}</strong></div>
        </div>
        {showChange && (
          <div className="pos-change-big pos-good-bg" role="status" data-testid="change-due">
            <span>Balance to return:</span> <strong>{formatINR(s.change)}</strong>
          </div>
        )}
        {showDue && (
          <div className="pos-change-big pos-bad-bg" role="status" data-testid="balance-due">
            <span>Balance due:</span> <strong>{formatINR(s.balanceDue)}</strong>
          </div>
        )}
        {!showChange && !showDue && total > 0 && <div className="pos-change-ok muted" data-testid="exact">Exact amount: nothing to return</div>}

        {overNoCash && <p className="pos-warn">Only cash can be overpaid (change is given in cash). Reduce the non-cash amount.</p>}
        {creditNoCustomer && <p className="pos-warn">Select a customer (phone) to sell on credit.</p>}
        {needApproval && (
          <ApprovalDialog
            action="pos.discount" entity="sale" title="Manager approval required"
            description="This bill's discount is above your limit. A manager must approve it."
            onCancel={() => setNeedApproval(false)}
            onApproved={(r) => { setNeedApproval(false); void confirm({ approvalId: r.approvalId }) }}
          />
        )}
        {error && <p className="pos-bad" role="alert">{error}</p>}
      </div>
    </Modal>
  )
}

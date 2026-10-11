import { useState, type FormEvent } from 'react'
import { Button, Field, InlineAlert, Input, Modal, useToast } from '@/ui'
import { ApiError, call, errMsg } from '@/lib/api'
import { formatINR } from '@shared/money'
import { ApprovalDialog } from '@/modules/auth/ApprovalDialog'
import './DeleteSaleDialog.css'

/** What the dialog needs to name the bill (rows of pos.listSales, pos.getSale and dashboard.summary().recentSales all fit). */
export interface DeletableSale {
  id: number
  invoiceNo: string
  total: number
  createdAt?: number
  customerName?: string | null
  status?: string
  /** refunds already given against this bill (they are deleted with it) */
  returnedTotal?: number
}

export interface DeleteSaleResult { ok: true; saleId: number; invoiceNo: string; total: number; stockRestored: number }

const MIN_REASON = 3

/** Trash-can glyph for "delete" buttons (inherits the text colour; decorative, so the button needs its own aria-label). */
export const TrashIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <path d="M3 6h18" /><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6" /><path d="M14 11v6" />
  </svg>
)

/**
 * Confirmation for pos.deleteSale (shared by the dashboard and Sales history). Names the bill, says what happens, and needs a
 * reason. A user without approvals.grant is asked for a manager's approval, exactly like voiding.
 *   {target && <DeleteSaleDialog sale={target} onClose={() => setTarget(null)} onDeleted={() => { setTarget(null); reload() }} />}
 */
export function DeleteSaleDialog({ sale, onClose, onDeleted }: { sale: DeletableSale; onClose: () => void; onDeleted: (r: DeleteSaleResult) => void }) {
  const toast = useToast()
  const [reason, setReason] = useState('')
  const [needApproval, setNeedApproval] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const isVoid = sale.status === 'void'
  const ready = reason.trim().length >= MIN_REASON

  const submit = async (approvalId?: number) => {
    if (busy || !ready) return
    setBusy(true); setErr(null)
    try {
      const r = await call<DeleteSaleResult>('pos', 'deleteSale', { saleId: sale.id, reason: reason.trim(), approval: approvalId ? { approvalId } : undefined })
      toast(`Invoice ${r.invoiceNo} deleted${r.stockRestored ? ` · ${r.stockRestored} item${r.stockRestored === 1 ? '' : 's'} back in stock` : ''}`, 'good')
      onDeleted(r)
    } catch (e) {
      if (e instanceof ApiError && e.code === 'APPROVAL_REQUIRED') { setNeedApproval(true); setErr(null) }
      else setErr(errMsg(e))
    } finally { setBusy(false) }
  }
  const onSubmit = (e: FormEvent) => { e.preventDefault(); void submit() }

  return (
    <Modal title={`Delete invoice ${sale.invoiceNo}?`} open onClose={() => !busy && onClose()}
      footer={<>
        <Button onClick={onClose} disabled={busy}>Cancel</Button>
        <Button variant="danger" className="del-sale-confirm" loading={busy} disabled={!ready} onClick={() => void submit()} data-testid="delete-sale-confirm">
          <TrashIcon /> Delete permanently
        </Button>
      </>}>
      <form className="del-sale" onSubmit={onSubmit} data-testid="delete-sale-dialog">
        <dl className="del-sale-facts" aria-label="Invoice to delete">
          <div><dt>Invoice</dt><dd><strong>{sale.invoiceNo}</strong>{isVoid && <span className="badge badge-bad del-sale-tag">Void</span>}</dd></div>
          <div><dt>Amount</dt><dd className="num"><strong>{formatINR(sale.total)}</strong></dd></div>
          <div><dt>Customer</dt><dd>{sale.customerName || 'Walk-in customer'}</dd></div>
          {sale.createdAt != null && <div><dt>Billed on</dt><dd>{new Date(sale.createdAt).toLocaleString()}</dd></div>}
        </dl>
        <InlineAlert tone="bad" title="This invoice will be permanently deleted">
          It disappears from sales history, reports and the dashboard, together with its payments{sale.returnedTotal ? ` and its return notes (${formatINR(sale.returnedTotal)} refunded)` : ''}.{' '}
          {isVoid
            ? 'The bill is already void, so its items are already back in stock.'
            : 'The items still with the customer are returned to stock.'}{' '}
          This cannot be undone and the invoice number is not used again.
        </InlineAlert>
        <Field label="Reason for deleting (required)" hint="Kept in the audit log with a copy of the bill.">
          <Input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="e.g. test bill, billed twice by mistake" />
        </Field>
        {err && <div role="alert" className="field-error del-sale-error">{err}</div>}
        <button type="submit" hidden disabled={!ready || busy} />
      </form>
      {needApproval && (
        <ApprovalDialog
          action="pos.delete" entity="sale" entityId={sale.id} title="Manager approval required" reasonRequired={false}
          description={`Deleting invoice ${sale.invoiceNo} (${formatINR(sale.total)}) needs a manager's approval.`}
          detail={{ invoiceNo: sale.invoiceNo, total: sale.total, reason: reason.trim() }}
          onCancel={() => setNeedApproval(false)}
          onApproved={(r) => { setNeedApproval(false); void submit(r.approvalId) }}
        />
      )}
    </Modal>
  )
}

export default DeleteSaleDialog

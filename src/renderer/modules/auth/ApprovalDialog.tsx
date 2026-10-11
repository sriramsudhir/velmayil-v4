import { useEffect, useState, type FormEvent } from 'react'
import { ApiError, call, errMsg } from '@/lib/api'
import type { Permission } from '@shared/permissions'
import { Button, Field, Input, Modal, TextArea } from '@/ui'
import { fmtCountdown, useCountdown } from './LoginPage'

export interface ApprovalResult { approvalId: number; approvedBy: { id: number; username: string; name: string; role: string } }

export interface ApprovalDialogProps {
  /** Action key stored with the approval, e.g. 'pos.void', 'pos.discount', 'pos.price_override', 'inventory.adjust'. */
  action: string
  onApproved: (r: ApprovalResult & { reason: string }) => void
  onCancel?: () => void
  /** Defaults to true: mount conditionally or pass open={false} to hide. */
  open?: boolean
  title?: string
  /** Text shown above the form describing what is being approved. */
  description?: string
  /** Approver may also qualify by holding this specific permission instead of approvals.grant. */
  permission?: Permission
  entity?: string
  entityId?: string | number
  detail?: unknown
  reasonRequired?: boolean
}

/**
 * Inline manager approval: the approver types their own username + password (or PIN). The requester stays signed in.
 *   <ApprovalDialog action="pos.void" entity="sale" entityId={id} onApproved={({approvalId}) => voidSale(id, approvalId)} onCancel={close} />
 */
export function ApprovalDialog({ action, onApproved, onCancel, open = true, title = 'Manager approval required', description, permission, entity, entityId, detail, reasonRequired = true }: ApprovalDialogProps) {
  const [username, setUsername] = useState('')
  const [secret, setSecret] = useState('')
  const [usePin, setUsePin] = useState(false)
  const [reason, setReason] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [until, setUntil] = useState<number | null>(null)
  const remaining = useCountdown(until)
  useEffect(() => { if (open) { setSecret(''); setErr('') } }, [open])

  async function submit(e?: FormEvent) {
    e?.preventDefault()
    if (busy || remaining > 0) return
    if (!username.trim() || !secret) { setErr('Enter the approver username and ' + (usePin ? 'PIN' : 'password')); return }
    if (reasonRequired && !reason.trim()) { setErr('Enter a reason'); return }
    setBusy(true); setErr('')
    try {
      const r = await call<ApprovalResult>('auth', 'verifyApprover', {
        username: username.trim(), ...(usePin ? { pin: secret } : { password: secret }),
        action, permission, entity, entityId, detail, reason: reason.trim() || undefined
      })
      setSecret('')
      onApproved({ ...r, reason: reason.trim() })
    } catch (e2) {
      setSecret('')
      const d = e2 instanceof ApiError ? (e2.details as { lockedUntil?: number } | undefined) : undefined
      if (d?.lockedUntil) setUntil(d.lockedUntil)
      setErr(errMsg(e2))
    } finally { setBusy(false) }
  }

  return (
    <Modal title={title} open={open} onClose={() => onCancel?.()}
      footer={<><Button onClick={() => onCancel?.()}>Cancel</Button><Button variant="primary" onClick={() => void submit()} disabled={busy || remaining > 0}>{busy ? 'Checking…' : 'Approve'}</Button></>}>
      <form onSubmit={submit} style={{ display: 'grid', gap: 10 }} autoComplete="off">
        {description && <p>{description}</p>}
        <Field label="Approver username"><Input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus spellCheck={false} /></Field>
        <Field label={usePin ? 'Approver PIN' : 'Approver password'}>
          <Input type="password" value={secret} onChange={(e) => setSecret(usePin ? e.target.value.replace(/\D/g, '').slice(0, 6) : e.target.value)} inputMode={usePin ? 'numeric' : undefined} autoComplete="off" />
        </Field>
        <label className="row"><input type="checkbox" checked={usePin} onChange={(e) => { setUsePin(e.target.checked); setSecret('') }} /> Use PIN instead of password</label>
        <Field label={reasonRequired ? 'Reason' : 'Reason (optional)'}><TextArea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} /></Field>
        {remaining > 0 && <div role="alert" className="field-error">Approver locked. Try again in {fmtCountdown(remaining)}.</div>}
        {remaining === 0 && err && <div role="alert" className="field-error">{err}</div>}
        <button type="submit" hidden />
      </form>
    </Modal>
  )
}

export default ApprovalDialog

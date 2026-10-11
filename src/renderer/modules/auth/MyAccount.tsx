import { useState } from 'react'
import { call, errMsg } from '@/lib/api'
import { Button, Field, Input, Modal, useToast } from '@/ui'

/** Change own password (also used as the blocking dialog when a reset forces a change) and set/clear quick PIN. */
export function MyAccountDialog({ open, onClose, forced = false, hasPin = false }: { open: boolean; onClose: () => void; forced?: boolean; hasPin?: boolean }) {
  const toast = useToast()
  const [cur, setCur] = useState('')
  const [next, setNext] = useState('')
  const [again, setAgain] = useState('')
  const [pin, setPin] = useState('')
  const [pinPw, setPinPw] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  async function savePassword() {
    if (next !== again) { setErr('New passwords do not match'); return }
    setBusy(true); setErr('')
    try {
      await call('auth', 'changePassword', { current: cur, next })
      toast('Password changed', 'good')
      setCur(''); setNext(''); setAgain('')
      onClose()
    } catch (e) { setErr(errMsg(e)) } finally { setBusy(false) }
  }
  async function savePin() {
    setBusy(true); setErr('')
    try {
      await call('auth', 'setPin', { password: pinPw, pin })
      toast('PIN saved', 'good')
      setPin(''); setPinPw('')
    } catch (e) { setErr(errMsg(e)) } finally { setBusy(false) }
  }
  async function removePin() {
    setBusy(true); setErr('')
    try {
      await call('auth', 'clearPin', { password: pinPw })
      toast('PIN removed', 'good')
      setPinPw('')
    } catch (e) { setErr(errMsg(e)) } finally { setBusy(false) }
  }

  return (
    <Modal title={forced ? 'Choose a new password' : 'My account'} open={open} onClose={forced ? () => {} : onClose}
      footer={<><Button onClick={onClose} disabled={forced}>Close</Button><Button variant="primary" onClick={savePassword} disabled={busy || !cur || !next}>Change password</Button></>}>
      <div style={{ display: 'grid', gap: 10 }}>
        {forced && <p className="muted">Your password was reset by an administrator. Set a new one to continue.</p>}
        <Field label="Current password"><Input type="password" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" /></Field>
        <Field label="New password" hint="At least 8 characters, different from your username"><Input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" /></Field>
        <Field label="Repeat new password"><Input type="password" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" /></Field>
        {!forced && (
          <fieldset style={{ border: '1px solid var(--line)', borderRadius: 8, padding: 10, display: 'grid', gap: 8 }}>
            <legend className="field-label">Quick PIN (4-6 digits) {hasPin ? '- set' : ''}</legend>
            <p className="muted">Used to unlock the screen or switch cashier. Not accepted for a cold sign-in.</p>
            <Field label="PIN"><Input inputMode="numeric" maxLength={6} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} /></Field>
            <Field label="Confirm with your password"><Input type="password" value={pinPw} onChange={(e) => setPinPw(e.target.value)} autoComplete="current-password" /></Field>
            <div className="row"><Button onClick={savePin} disabled={busy || pin.length < 4 || !pinPw}>Save PIN</Button><Button variant="danger" onClick={removePin} disabled={busy || !pinPw}>Remove PIN</Button></div>
          </fieldset>
        )}
        {err && <div role="alert" className="field-error">{err}</div>}
      </div>
    </Modal>
  )
}

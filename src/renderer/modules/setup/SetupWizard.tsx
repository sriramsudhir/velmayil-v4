import { useRef, useState, type FormEvent } from 'react'
import { Button, Card, Field, Input, TextArea, useToast } from '@/ui'
import { call, errMsg } from '@/lib/api'

// Owned by Agent 1. First-run setup: shop -> owner account -> POS & store location -> review. Logo is added later in Shop Profile.

// Same rules as the shop profile service (businessProfile/schema.ts): whatever passes step 1 here must not be refused at
// "Finish setup", three screens later, with an error about a field that is no longer on screen.
const GSTIN_RE = /^(0[1-9]|[1-2]\d|3[0-8])[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/
const PIN_RE = /^[1-9]\d{5}$/
const PHONE_RE = /^[+()\-\s\d,/]{6,40}$/
const POS_RE = /^[A-Z0-9][A-Z0-9-]{0,15}$/
const USER_RE = /^[a-z0-9._-]{3,32}$/

export interface Form {
  shopName: string; displayName: string; address: string; city: string; state: string; pinCode: string; phone: string; gstin: string
  username: string; ownerName: string; password: string; confirm: string
  posCode: string; posName: string; locationName: string
}
type Errors = Partial<Record<keyof Form, string>>

const INITIAL: Form = {
  shopName: '', displayName: '', address: '', city: '', state: '', pinCode: '', phone: '', gstin: '',
  username: '', ownerName: '', password: '', confirm: '',
  posCode: 'POS-01', posName: 'Counter 1', locationName: 'Main Store'
}

const STEPS = ['Shop', 'Owner account', 'Counter & store', 'Review']

export function validateStep(step: number, f: Form): Errors {
  const e: Errors = {}
  if (step === 0) {
    if (!f.shopName.trim()) e.shopName = 'Shop name is required'
    const g = f.gstin.trim().toUpperCase()
    if (g && !GSTIN_RE.test(g)) e.gstin = 'GSTIN must be 15 characters, e.g. 33ABCDE1234F1Z5'
    const ph = f.phone.trim()
    if (ph && (!PHONE_RE.test(ph) || ph.replace(/\D/g, '').length < 6)) e.phone = 'Enter a valid phone number (digits, spaces, + - ( ) only)'
    if (f.pinCode.trim() && !PIN_RE.test(f.pinCode.trim())) e.pinCode = 'PIN code must be 6 digits'
  }
  if (step === 1) {
    if (!USER_RE.test(f.username.trim().toLowerCase())) e.username = '3-32 letters, digits, dot, dash or underscore'
    if (f.password.length < 6) e.password = 'At least 6 characters'
    if (f.confirm !== f.password) e.confirm = 'Passwords do not match'
  }
  if (step === 2) {
    if (!POS_RE.test(f.posCode.trim().toUpperCase())) e.posCode = 'Letters, digits and dashes only (max 16)'
    if (!f.posName.trim()) e.posName = 'Counter name is required'
    if (!f.locationName.trim()) e.locationName = 'Store location name is required'
  }
  return e
}

export default function SetupWizard({ onDone }: { onDone: () => void }) {
  const toast = useToast()
  const [step, setStep] = useState(0)
  const [f, setF] = useState<Form>(INITIAL)
  const [errors, setErrors] = useState<Errors>({})
  const [busy, setBusy] = useState(false)
  const [serverError, setServerError] = useState('')
  const root = useRef<HTMLFormElement>(null)

  const set = (k: keyof Form) => (ev: { target: { value: string } }) => {
    setF((x) => ({ ...x, [k]: ev.target.value }))
    if (errors[k]) setErrors((x) => ({ ...x, [k]: undefined }))
  }
  const focusFirst = () => setTimeout(() => root.current?.querySelector<HTMLElement>('input,textarea')?.focus(), 0)

  const next = () => {
    const e = validateStep(step, f)
    setErrors(e)
    if (Object.keys(e).length) return
    setStep((s) => s + 1)
    focusFirst()
  }
  const back = () => {
    setStep((s) => Math.max(0, s - 1))
    setServerError('')
    focusFirst()
  }

  const finish = async () => {
    for (const s of [0, 1, 2]) {
      const e = validateStep(s, f)
      if (Object.keys(e).length) {
        setErrors(e)
        setStep(s)
        return
      }
    }
    setBusy(true)
    setServerError('')
    try {
      await call('setup', 'complete', {
        shop: {
          shopName: f.shopName.trim(), displayName: f.displayName.trim() || f.shopName.trim(), address: f.address.trim(),
          city: f.city.trim(), state: f.state.trim(), pinCode: f.pinCode.trim(), phone: f.phone.trim(), gstin: f.gstin.trim().toUpperCase()
        },
        owner: { username: f.username.trim(), name: f.ownerName.trim() || undefined, password: f.password },
        pos: { code: f.posCode.trim().toUpperCase(), name: f.posName.trim() },
        locationName: f.locationName.trim()
      })
      toast('Setup complete. Welcome!', 'good')
      onDone()
    } catch (e) {
      setServerError(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  const submit = (ev: FormEvent) => {
    ev.preventDefault() // Enter advances; the last step finishes
    if (busy) return
    if (step < STEPS.length - 1) next()
    else void finish()
  }

  return (
    <div className="center-screen">
      <div style={{ width: 'min(640px, 94vw)' }}>
        <Card title={`First-time setup  -  step ${step + 1} of ${STEPS.length}: ${STEPS[step]}`}>
          <ol className="row" style={{ listStyle: 'none', padding: 0, margin: '0 0 12px' }} aria-label="Progress">
            {STEPS.map((s, i) => (
              <li key={s} aria-current={i === step ? 'step' : undefined} style={{ fontWeight: i === step ? 700 : 400, opacity: i <= step ? 1 : 0.5 }}>
                {i + 1}. {s}{i < STEPS.length - 1 ? '  >' : ''}
              </li>
            ))}
          </ol>
          <form ref={root} onSubmit={submit} noValidate>
            {step === 0 && (
              <div style={{ display: 'grid', gap: 10 }}>
                <Field label="Shop name *" error={errors.shopName}><Input autoFocus value={f.shopName} onChange={set('shopName')} maxLength={120} /></Field>
                <Field label="Display name" hint="Shown on bills and reports. Defaults to the shop name." error={errors.displayName}><Input value={f.displayName} onChange={set('displayName')} maxLength={60} /></Field>
                <Field label="Address"><TextArea rows={2} value={f.address} onChange={set('address')} maxLength={300} /></Field>
                <div className="grid3">
                  <Field label="City"><Input value={f.city} onChange={set('city')} maxLength={80} /></Field>
                  <Field label="State"><Input value={f.state} onChange={set('state')} maxLength={80} /></Field>
                  <Field label="PIN code" error={errors.pinCode}><Input value={f.pinCode} onChange={set('pinCode')} inputMode="numeric" maxLength={6} /></Field>
                </div>
                <div className="grid2">
                  <Field label="Phone" error={errors.phone}><Input value={f.phone} onChange={set('phone')} inputMode="tel" maxLength={20} /></Field>
                  <Field label="GSTIN" hint="Leave blank if not registered" error={errors.gstin}><Input value={f.gstin} onChange={set('gstin')} maxLength={15} style={{ textTransform: 'uppercase' }} /></Field>
                </div>
              </div>
            )}
            {step === 1 && (
              <div style={{ display: 'grid', gap: 10 }}>
                <p className="muted">This account is the Owner with full access. Keep the password safe.</p>
                <div className="grid2">
                  <Field label="Username *" error={errors.username}><Input autoFocus value={f.username} onChange={set('username')} autoComplete="username" /></Field>
                  <Field label="Your name" error={errors.ownerName}><Input value={f.ownerName} onChange={set('ownerName')} maxLength={80} /></Field>
                </div>
                <div className="grid2">
                  <Field label="Password *" error={errors.password}><Input type="password" value={f.password} onChange={set('password')} autoComplete="new-password" /></Field>
                  <Field label="Confirm password *" error={errors.confirm}><Input type="password" value={f.confirm} onChange={set('confirm')} autoComplete="new-password" /></Field>
                </div>
              </div>
            )}
            {step === 2 && (
              <div style={{ display: 'grid', gap: 10 }}>
                <div className="grid2">
                  <Field label="POS code *" hint="Used in bill numbers for this computer" error={errors.posCode}><Input autoFocus value={f.posCode} onChange={set('posCode')} maxLength={16} style={{ textTransform: 'uppercase' }} /></Field>
                  <Field label="Counter name *" error={errors.posName}><Input value={f.posName} onChange={set('posName')} maxLength={60} /></Field>
                </div>
                <Field label="Store / stock location *" hint="Where your stock is kept. You can add more later in Settings." error={errors.locationName}><Input value={f.locationName} onChange={set('locationName')} maxLength={60} /></Field>
              </div>
            )}
            {step === 3 && (
              <div style={{ display: 'grid', gap: 8 }}>
                <dl style={{ display: 'grid', gridTemplateColumns: '150px 1fr', gap: '4px 12px', margin: 0 }}>
                  <dt className="muted">Shop</dt><dd style={{ margin: 0 }}>{f.displayName.trim() || f.shopName.trim()}{f.displayName.trim() && f.displayName.trim() !== f.shopName.trim() ? ` (${f.shopName.trim()})` : ''}</dd>
                  <dt className="muted">Address</dt><dd style={{ margin: 0 }}>{[f.address, f.city, f.state, f.pinCode].map((x) => x.trim()).filter(Boolean).join(', ') || '-'}</dd>
                  <dt className="muted">Phone / GSTIN</dt><dd style={{ margin: 0 }}>{f.phone.trim() || '-'} / {f.gstin.trim().toUpperCase() || 'Not registered'}</dd>
                  <dt className="muted">Owner login</dt><dd style={{ margin: 0 }}>{f.username.trim().toLowerCase()}</dd>
                  <dt className="muted">Counter</dt><dd style={{ margin: 0 }}>{f.posCode.trim().toUpperCase()} - {f.posName.trim()}</dd>
                  <dt className="muted">Stock location</dt><dd style={{ margin: 0 }}>{f.locationName.trim()}</dd>
                </dl>
                <p className="muted">You can upload your logo and edit these details later in Shop Profile.</p>
                {serverError && <div className="field-error" role="alert">{serverError}</div>}
              </div>
            )}
            <div className="row" style={{ justifyContent: 'space-between', marginTop: 16 }}>
              <Button type="button" onClick={back} disabled={step === 0 || busy}>Back</Button>
              {step < STEPS.length - 1
                ? <Button type="submit" variant="primary">Next</Button>
                : <Button type="submit" variant="primary" disabled={busy}>{busy ? 'Setting up...' : 'Finish setup'}</Button>}
            </div>
          </form>
        </Card>
      </div>
    </div>
  )
}

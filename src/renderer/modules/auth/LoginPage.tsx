import { useEffect, useRef, useState, type FormEvent } from 'react'
import { ApiError, call, errMsg } from '@/lib/api'
import { Button, Card, Field, Input } from '@/ui'

const LAST_USER_KEY = 'velmayil.lastUsername'
const readLast = () => { try { return localStorage.getItem(LAST_USER_KEY) ?? '' } catch { return '' } }
const writeLast = (v: string) => { try { localStorage.setItem(LAST_USER_KEY, v) } catch { /* storage unavailable */ } }

/** Seconds remaining until `until` (epoch ms), ticking every second while > 0. */
export function useCountdown(until: number | null): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!until) return
    const id = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(id)
  }, [until])
  return until ? Math.max(0, Math.ceil((until - now) / 1000)) : 0
}

export const fmtCountdown = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`

/** Username + password sign-in. Remembers the last username only (never the password). */
export default function LoginPage({ onDone }: { onDone: () => void }) {
  const [username, setUsername] = useState(readLast)
  const [password, setPassword] = useState('')
  const [show, setShow] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [lockedUntil, setLockedUntil] = useState<number | null>(null)
  const remaining = useCountdown(lockedUntil)
  const userRef = useRef<HTMLInputElement>(null)
  const passRef = useRef<HTMLInputElement>(null)

  useEffect(() => { (username ? passRef : userRef).current?.focus() }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (lockedUntil && remaining === 0) { setLockedUntil(null); setError('') } }, [remaining, lockedUntil])

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (busy || remaining > 0) return
    if (!username.trim() || !password) { setError('Enter your username and password'); return }
    setBusy(true)
    setError('')
    try {
      await call('auth', 'login', { username: username.trim(), password })
      writeLast(username.trim())
      setPassword('')
      onDone()
    } catch (err) {
      setPassword('')
      setTimeout(() => passRef.current?.focus(), 0) // after the field is enabled again (a disabled input cannot take focus)
      const d = err instanceof ApiError ? (err.details as { lockedUntil?: number; attemptsLeft?: number } | undefined) : undefined
      if (d?.lockedUntil) setLockedUntil(d.lockedUntil)
      setError(d?.attemptsLeft !== undefined ? `${errMsg(err)}. ${d.attemptsLeft} attempt(s) left before lock-out.` : errMsg(err))
    } finally {
      setBusy(false)
    }
  }

  const locked = remaining > 0
  return (
    <div className="center-screen">
      <div className="center-card">
        <Card title="Sign in">
          <form onSubmit={submit} style={{ display: 'grid', gap: 12 }} autoComplete="off">
            <Field label="Username">
              <Input ref={userRef as never} value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" spellCheck={false} disabled={busy} />
            </Field>
            <Field label="Password">
              <div className="row" style={{ flexWrap: 'nowrap' }}>
                <Input ref={passRef as never} type={show ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" disabled={busy} />
                <Button type="button" variant="ghost" onClick={() => setShow((s) => !s)} aria-pressed={show} aria-label={show ? 'Hide password' : 'Show password'}>
                  {show ? 'Hide' : 'Show'}
                </Button>
              </div>
            </Field>
            {locked && (
              <div role="alert" className="field-error">
                Account locked. Try again in <strong>{fmtCountdown(remaining)}</strong>.
              </div>
            )}
            {!locked && error && <div role="alert" className="field-error">{error}</div>}
            <Button type="submit" variant="primary" disabled={busy || locked}>{busy ? 'Signing in…' : 'Sign in'}</Button>
          </form>
        </Card>
      </div>
    </div>
  )
}

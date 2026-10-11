import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { ApiError, UNAUTHENTICATED_EVENT, call, errMsg } from '@/lib/api'
import { useSession } from '@/lib/session'
import { Button, Field, Input } from '@/ui'
import { fmtCountdown, useCountdown } from './LoginPage'
import { MyAccountDialog } from './MyAccount'

export interface AuthState {
  userId: number; username: string; name: string; role: string; locked: boolean; mustChangePassword: boolean; autolockMinutes: number
}

const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'mousemove'] as const

/**
 * Tracks the server-side lock state. Sends a throttled activity heartbeat (auth.touch) and polls auth.current
 * (public, works while locked) so a server-side idle lock is noticed even if the user did nothing.
 */
export function useIdleLock(opts: { heartbeatMs?: number; pollMs?: number } = {}) {
  const { heartbeatMs = 30_000, pollMs = 20_000 } = opts
  const [state, setState] = useState<AuthState | null>(null)
  const lastBeat = useRef(0)

  const refresh = useCallback(async () => {
    try {
      const next = await call<AuthState | null>('auth', 'current')
      // identical answer => same state object => no re-render of the guard (and nothing below it)
      setState((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next))
    } catch { /* keep last known state */ }
  }, [])

  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => {
    // a minimised/hidden window is not polled; coming back re-checks at once so a lock that happened meanwhile shows immediately
    const id = setInterval(() => { if (!document.hidden) void refresh() }, pollMs)
    const wake = () => { if (!document.hidden) void refresh() }
    document.addEventListener('visibilitychange', wake)
    // a service call was just refused: the server locked (or ended) the session, show it now
    const refused = () => { void refresh() }
    window.addEventListener(UNAUTHENTICATED_EVENT, refused)
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', wake); window.removeEventListener(UNAUTHENTICATED_EVENT, refused) }
  }, [refresh, pollMs])

  useEffect(() => {
    if (!state || state.locked) return
    const onActivity = () => {
      const t = Date.now()
      if (t - lastBeat.current < heartbeatMs) return
      lastBeat.current = t
      call<{ locked: boolean }>('auth', 'touch')
        .then((r) => { if (r.locked) void refresh() })
        .catch((e) => { if (e instanceof ApiError && e.code === 'UNAUTHENTICATED') void refresh() })
    }
    for (const ev of ACTIVITY_EVENTS) window.addEventListener(ev, onActivity, { passive: true })
    return () => { for (const ev of ACTIVITY_EVENTS) window.removeEventListener(ev, onActivity) }
  }, [state, heartbeatMs, refresh])

  const lockNow = useCallback(async () => { await call('auth', 'lock'); await refresh() }, [refresh])
  return { state, refresh, lockNow }
}

/** Full-screen overlay. Unlock with the same user's password or PIN, or switch user. Never navigates away. */
export function LockScreen({ state, onUnlocked, onSignedOut }: { state: AuthState; onUnlocked: () => void; onSignedOut: () => void }) {
  const [username, setUsername] = useState(state.username)
  const [secret, setSecret] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [until, setUntil] = useState<number | null>(null)
  const remaining = useCountdown(until)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => { ref.current?.focus() }, [])
  useEffect(() => { if (until && remaining === 0) { setUntil(null); setErr('') } }, [remaining, until])

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (busy || !secret || remaining > 0) return
    setBusy(true); setErr('')
    const isPin = /^\d{4,6}$/.test(secret)
    try {
      await call('auth', 'login', isPin ? { username, pin: secret } : { username, password: secret })
      setSecret('')
      onUnlocked()
    } catch (e2) {
      setSecret('')
      const d = e2 instanceof ApiError ? (e2.details as { lockedUntil?: number } | undefined) : undefined
      if (d?.lockedUntil) setUntil(d.lockedUntil)
      setErr(errMsg(e2))
      setTimeout(() => ref.current?.focus(), 0) // after the field is enabled again
    } finally { setBusy(false) }
  }

  return (
    <div role="dialog" aria-modal="true" aria-label="Screen locked"
      style={{ position: 'fixed', inset: 0, zIndex: 3000, background: 'rgba(20,24,35,.92)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <form onSubmit={submit} className="card" style={{ width: 'min(380px, 92vw)', display: 'grid', gap: 12, margin: 0 }}>
        <div><h3 style={{ margin: 0 }}>Screen locked</h3><p className="muted">Locked after inactivity. Your open bill is kept.</p></div>
        {username !== state.username
          ? <Field label="Username"><Input value={username} onChange={(e) => setUsername(e.target.value)} /></Field>
          : <div><strong>{state.name}</strong> <span className="muted">({state.username})</span></div>}
        <Field label="Password or PIN"><Input ref={ref as never} type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="current-password" disabled={busy} /></Field>
        {remaining > 0 && <div role="alert" className="field-error">Too many attempts. Try again in {fmtCountdown(remaining)}.</div>}
        {remaining === 0 && err && <div role="alert" className="field-error">{err}</div>}
        <Button type="submit" variant="primary" disabled={busy || !secret || remaining > 0}>Unlock</Button>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <Button type="button" variant="ghost" onClick={() => setUsername(username === state.username ? '' : state.username)}>
            {username === state.username ? 'Switch user' : 'Back'}
          </Button>
          <Button type="button" variant="ghost" disabled={busy} onClick={async () => { try { await call('auth', 'logout') } catch (e2) { setErr(errMsg(e2)); return } onSignedOut() }}>Sign out</Button>
        </div>
      </form>
    </div>
  )
}

/**
 * Mount ONCE inside the signed-in shell, wrapping the app content:
 *   <IdleGuard>{routes}</IdleGuard>
 * Renders children always (so POS state survives), adds the LockScreen overlay when the server locks the session,
 * and a blocking "choose a new password" dialog when an admin reset forced a change.
 */
export function IdleGuard({ children }: { children?: ReactNode }) {
  const { refresh: refreshSession } = useSession()
  const { state, refresh } = useIdleLock()
  // the server has no session any more (not merely locked) while this screen still shows the app: go to the sign-in page
  const seen = useRef(false)
  useEffect(() => {
    if (state) seen.current = true
    else if (seen.current) { seen.current = false; void refreshSession() }
  }, [state, refreshSession])
  return (
    <>
      {children}
      {state?.locked && (
        <LockScreen state={state} onUnlocked={() => { void refresh(); void refreshSession() }} onSignedOut={() => { void refresh(); void refreshSession() }} />
      )}
      {state && !state.locked && state.mustChangePassword && (
        <MyAccountDialog open forced onClose={() => { void refresh() }} />
      )}
    </>
  )
}

/** Small button for the shell/POS: <LockButton/> locks the screen immediately. */
export function LockButton({ label = 'Lock' }: { label?: string }) {
  const [busy, setBusy] = useState(false)
  return <Button variant="ghost" disabled={busy} onClick={async () => { setBusy(true); try { await call('auth', 'lock') } finally { setBusy(false) } }}>{label}</Button>
}

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { ApiError, errMsg } from '@/lib/api'
import { useSession } from '@/lib/session'
import { useToast } from './toast'

// ---- generic helpers ----

export function useDebounced<T>(value: T, delay = 250): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), delay)
    return () => clearTimeout(t)
  }, [value, delay])
  return v
}

export function useLocalStorage<T>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key)
      return raw == null ? initial : (JSON.parse(raw) as T)
    } catch { return initial }
  })
  const set = useCallback((n: T) => {
    setV(n)
    try { localStorage.setItem(key, JSON.stringify(n)) } catch { /* ignore */ }
  }, [key])
  return [v, set]
}

/**
 * Run `fn` every `ms` (and optionally when the window regains focus). The latest `fn` is always used.
 * Cheap by construction: nothing runs while the window is hidden/minimised, a run never starts while the previous one
 * (if it returned a promise) is still in flight, and returning to the window refreshes only if the data is older than `ms`.
 */
export function useInterval(fn: () => void | Promise<unknown>, ms: number | null, opts: { onFocus?: boolean } = {}): void {
  const ref = useRef(fn)
  ref.current = fn
  useEffect(() => {
    if (ms == null) return
    let last = Date.now()
    let busy = false
    const run = () => {
      if (busy) return
      last = Date.now()
      const r = ref.current()
      if (r && typeof (r as Promise<unknown>).finally === 'function') {
        busy = true
        void (r as Promise<unknown>).finally(() => { busy = false }).catch(() => undefined)
      }
    }
    const id = setInterval(() => { if (!document.hidden) run() }, ms)
    const onWake = () => { if (!document.hidden && Date.now() - last >= Math.min(ms, 15_000)) run() }
    document.addEventListener('visibilitychange', onWake)
    if (opts.onFocus) window.addEventListener('focus', onWake)
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', onWake); if (opts.onFocus) window.removeEventListener('focus', onWake) }
  }, [ms, opts.onFocus])
}

// ---- keyboard ----

const isTypingTarget = (t: EventTarget | null): boolean => {
  const el = t as HTMLElement | null
  if (!el || !el.tagName) return false
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable
}

/** Normalised combo for an event: "ctrl+shift+k", "alt+1", "f2", "esc", "enter". */
export function comboOf(e: KeyboardEvent): string {
  const parts: string[] = []
  if (e.ctrlKey || e.metaKey) parts.push('ctrl')
  if (e.altKey) parts.push('alt')
  if (e.shiftKey) parts.push('shift')
  let k = e.key.toLowerCase()
  if (k === 'escape') k = 'esc'
  if (k === ' ') k = 'space'
  if (e.altKey && /^Digit\d$/.test(e.code)) k = e.code.slice(5) // Alt+digit may change e.key on some layouts
  parts.push(k)
  return parts.join('+')
}

/**
 * Register keyboard shortcuts. Keys are combos like 'ctrl+k', 'alt+1', 'f2', 'esc'.
 * Plain keys (no ctrl/alt) are ignored while typing in a field, except F-keys and Esc.
 * Return `false` from a handler to let the event continue; otherwise it is preventDefault()ed.
 */
export function useHotkeys(map: Record<string, (e: KeyboardEvent) => void | boolean>, opts: { enabled?: boolean; allowInInputs?: boolean } = {}): void {
  const ref = useRef(map)
  ref.current = map
  const enabled = opts.enabled ?? true
  useEffect(() => {
    if (!enabled) return
    const h = (e: KeyboardEvent) => {
      // Alt + numeric keypad digits compose a character ("Alt codes", used by some barcode readers); never a shortcut, and
      // preventDefault would cancel the character
      if (e.altKey && /^Numpad/.test(e.code)) return
      const combo = comboOf(e)
      const fn = ref.current[combo]
      if (!fn) return
      const modified = combo.includes('ctrl+') || combo.includes('alt+')
      if (!opts.allowInInputs && !modified && isTypingTarget(e.target) && !/^f\d+$/.test(combo) && combo !== 'esc') return
      if (fn(e) !== false) e.preventDefault()
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [enabled, opts.allowInInputs])
}

// ---- focus trap ----
const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'

/** Traps Tab inside `ref` while `active`, focuses the first field on open, restores focus on close. */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    if (!active) return
    const prev = document.activeElement as HTMLElement | null
    const root = ref.current
    if (root) {
      const items = () => Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((x) => x.offsetParent !== null || x === document.activeElement)
      if (!root.contains(document.activeElement)) {
        const first = root.querySelector<HTMLElement>('[autofocus],[data-autofocus],input:not([disabled]),select,textarea') ?? items()[0] ?? root
        first.focus({ preventScroll: true })
      }
      const onKey = (e: KeyboardEvent) => {
        if (e.key !== 'Tab') return
        const list = items()
        if (!list.length) { e.preventDefault(); return }
        const first = list[0], last = list[list.length - 1]
        if (e.shiftKey && (document.activeElement === first || !root.contains(document.activeElement))) { e.preventDefault(); last.focus() }
        else if (!e.shiftKey && (document.activeElement === last || !root.contains(document.activeElement))) { e.preventDefault(); first.focus() }
      }
      root.addEventListener('keydown', onKey)
      return () => { root.removeEventListener('keydown', onKey); prev?.focus?.({ preventScroll: true }) }
    }
    return () => prev?.focus?.({ preventScroll: true })
  }, [ref, active])
}

// ---- errors / API actions ----

/** Friendly, user-facing text for any thrown error. */
export function friendlyError(e: unknown): string {
  if (e instanceof ApiError) {
    const m = e.message && e.message !== e.code ? e.message : ''
    switch (e.code) {
      case 'UNAUTHENTICATED': return 'Your session has ended. Please sign in again.'
      case 'FORBIDDEN': return 'You do not have permission to do that.'
      case 'INSUFFICIENT_STOCK': return m ? `Not enough stock: ${m}` : 'Not enough stock available for this item.'
      case 'APPROVAL_REQUIRED': return m || 'A manager approval is required for this action.'
      case 'NOT_FOUND': return m || 'That record could not be found. It may have been removed.'
      case 'CONFLICT': return m || 'This record was changed elsewhere. Reload and try again.'
      case 'PRINT_FAILED': return m ? `Printing failed: ${m}. Your data is saved.` : 'Printing failed. Your data is saved; check the printer and reprint.'
      case 'VALIDATION': return m || 'Please check the entered values.'
      default: return m || 'Something went wrong. Please try again.'
    }
  }
  return errMsg(e) || 'Something went wrong. Please try again.'
}

/**
 * Standard wrapper for renderer -> service actions: tracks `loading`, toasts friendly errors,
 * and bounces to login on UNAUTHENTICATED.  Resolves to the result, or `undefined` if it failed.
 *   const { run, loading } = useApiAction()
 *   await run(() => call('catalog','save',v), { success: 'Saved' })
 */
export function useApiAction() {
  const toast = useToast()
  const { refresh } = useSession()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const count = useRef(0)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const run = useCallback(async <T,>(fn: () => Promise<T>, opts: { success?: string; silent?: boolean; onError?: (e: unknown) => void } = {}): Promise<T | undefined> => {
    count.current++
    setLoading(true)
    setError(null)
    try {
      const r = await fn()
      if (opts.success) toast(opts.success, 'good')
      return r
    } catch (e) {
      const msg = friendlyError(e)
      if (alive.current) setError(msg)
      if (!opts.silent) toast(msg, 'bad')
      opts.onError?.(e)
      if (e instanceof ApiError && e.code === 'UNAUTHENTICATED') void refresh()
      return undefined
    } finally {
      count.current--
      if (alive.current && count.current === 0) setLoading(false)
    }
  }, [toast, refresh])
  return useMemo(() => ({ run, loading, error }), [run, loading, error])
}

// ---- unsaved changes ----
let dirtyCount = 0
export const hasUnsavedChanges = (): boolean => dirtyCount > 0

/**
 * Mark the current screen as having unsaved edits. Warns on window close/reload, and the Shell's
 * navigation (sidebar, palette) asks for confirmation while any screen is dirty.
 */
export function useDirtyGuard(dirty: boolean): void {
  useEffect(() => {
    if (!dirty) return
    dirtyCount++
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', h)
    return () => { dirtyCount = Math.max(0, dirtyCount - 1); window.removeEventListener('beforeunload', h) }
  }, [dirty])
}

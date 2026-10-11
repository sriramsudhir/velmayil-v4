import { useCallback, useEffect, useState } from 'react'
import { call } from '@/lib/api'

export const DEFAULT_SHOP_NAME = 'Velmayil v3'
/** Other modules may dispatch `window.dispatchEvent(new Event('velmayil:profile-changed'))` after saving the shop profile to refresh the top bar. */
export const PROFILE_CHANGED_EVENT = 'velmayil:profile-changed'

const asDataUri = (r: unknown): string | null => {
  if (!r) return null
  if (typeof r === 'string') return r.startsWith('data:') ? r : null
  const o = r as { dataUri?: unknown; mime?: string; bytes?: unknown }
  if (typeof o.dataUri === 'string') return o.dataUri
  let bytes: Uint8Array | null = null
  if (o.bytes instanceof Uint8Array) bytes = o.bytes
  else if (Array.isArray(o.bytes)) bytes = Uint8Array.from(o.bytes as number[])
  else if (o.bytes && typeof o.bytes === 'object' && Array.isArray((o.bytes as { data?: number[] }).data)) bytes = Uint8Array.from((o.bytes as { data: number[] }).data)
  if (!bytes || !o.mime) return null
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return `data:${o.mime};base64,${btoa(bin)}`
}

/** Shop display name + logo from the single business profile (never hard-coded). */
export function useShopIdentity(): { name: string; logo: string | null; loaded: boolean } {
  const [state, setState] = useState<{ name: string; logo: string | null; loaded: boolean }>({ name: DEFAULT_SHOP_NAME, logo: null, loaded: false })
  const load = useCallback(async () => {
    try {
      const p = await call<{ displayName?: string; shopName?: string; logoAssetId?: number | null; logoDataUri?: string }>('businessProfile', 'getActive')
      const name = (p?.displayName || p?.shopName || '').trim() || DEFAULT_SHOP_NAME
      let logo: string | null = asDataUri(p?.logoDataUri)
      if (!logo && p?.logoAssetId) {
        try { logo = asDataUri(await call('businessProfile', 'getLogo', p.logoAssetId)) } catch { /* logo is optional */ }
      }
      setState({ name, logo, loaded: true })
    } catch {
      setState((s) => ({ ...s, loaded: true }))
    }
  }, [])
  useEffect(() => {
    void load()
    let last = Date.now()
    // re-read on focus only if the last read is older than a minute (focus fires on every alt-tab)
    const onFocus = () => { if (Date.now() - last > 60_000) { last = Date.now(); void load() } }
    const onChanged = () => { last = Date.now(); void load() }
    window.addEventListener(PROFILE_CHANGED_EVENT, onChanged)
    window.addEventListener('focus', onFocus)
    return () => { window.removeEventListener(PROFILE_CHANGED_EVENT, onChanged); window.removeEventListener('focus', onFocus) }
  }, [load])
  return state
}

export interface SyncInfo { online: boolean; pending: number; enabled: boolean; lastSyncAt: number | null; error: boolean }

/** Online/offline + pending-sync indicator. Tolerant of whatever shape sync.status returns. */
export function useSyncStatus(pollMs = 60_000): SyncInfo {
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine)
  const [info, setInfo] = useState<Omit<SyncInfo, 'online'>>({ pending: 0, enabled: false, lastSyncAt: null, error: false })
  useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false)
    window.addEventListener('online', on); window.addEventListener('offline', off)
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off) }
  }, [])
  useEffect(() => {
    let live = true
    let busy = false
    let last = 0
    const poll = async () => {
      if (busy || document.hidden) return // never overlap, never poll a minimised window
      busy = true
      last = Date.now()
      try {
        const s = await call<Record<string, unknown>>('sync', 'badge')
        if (!live || !s) return
        const pending = Number(s.pending ?? 0) || 0
        const next = { pending, enabled: s.enabled === true, lastSyncAt: Number(s.lastSyncAt ?? 0) || null, error: !!s.lastError }
        // keep the same state object when nothing changed so the whole shell does not re-render every minute
        setInfo((i) => (i.pending === next.pending && i.enabled === next.enabled && i.lastSyncAt === next.lastSyncAt && i.error === next.error ? i : next))
      } catch {
        /* status is best-effort */
      } finally {
        busy = false
      }
    }
    const wake = () => { if (!document.hidden && Date.now() - last > 15_000) void poll() }
    void poll()
    const id = setInterval(() => void poll(), pollMs)
    document.addEventListener('visibilitychange', wake)
    window.addEventListener('focus', wake)
    return () => { live = false; clearInterval(id); document.removeEventListener('visibilitychange', wake); window.removeEventListener('focus', wake) }
  }, [pollMs])
  return { online, ...info }
}

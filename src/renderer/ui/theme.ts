import { useCallback, useEffect, useState } from 'react'

export type ThemeMode = 'system' | 'light' | 'dark'
const KEY = 'velmayil.theme'
const listeners = new Set<(m: ThemeMode) => void>()

export function getTheme(): ThemeMode {
  try {
    const v = localStorage.getItem(KEY)
    if (v === 'light' || v === 'dark' || v === 'system') return v
  } catch { /* storage unavailable */ }
  return 'system'
}

/** Apply to <html data-theme>. 'system' removes the attribute so prefers-color-scheme decides. */
export function applyTheme(mode: ThemeMode = getTheme()): void {
  const el = document.documentElement
  if (mode === 'system') el.removeAttribute('data-theme')
  else el.setAttribute('data-theme', mode)
}

export function setTheme(mode: ThemeMode): void {
  try { localStorage.setItem(KEY, mode) } catch { /* ignore */ }
  applyTheme(mode)
  listeners.forEach((l) => l(mode))
}

/** [mode, setMode, cycle] — cycle goes system -> light -> dark. */
export function useTheme(): [ThemeMode, (m: ThemeMode) => void, () => void] {
  const [mode, setMode] = useState<ThemeMode>(getTheme)
  useEffect(() => {
    listeners.add(setMode)
    return () => { listeners.delete(setMode) }
  }, [])
  const cycle = useCallback(() => setTheme(getTheme() === 'system' ? 'light' : getTheme() === 'light' ? 'dark' : 'system'), [])
  return [mode, setTheme, cycle]
}

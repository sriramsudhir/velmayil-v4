import { useEffect, useRef } from 'react'

/** Events from these pseudo-services (inbound sync, out-of-band writes) refresh every live view. */
const GLOBAL = new Set(['sync', '*'])

/**
 * Call `reload` (debounced 150 ms) when a data-change event from any of `services` arrives, or the window regains focus.
 * Example: useLiveRefresh(['catalog', 'pos'], list.reload)
 */
export function useLiveRefresh(services: string[], reload: () => void): void {
  const reloadRef = useRef(reload)
  reloadRef.current = reload
  const key = services.join('|')
  useEffect(() => {
    const wanted = new Set(key ? key.split('|') : [])
    let timer: ReturnType<typeof setTimeout> | null = null
    const fire = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        reloadRef.current()
      }, 150)
    }
    const off = window.velmayil.onChange?.((events) => {
      if (events.some((e) => wanted.has(e.service) || GLOBAL.has(e.service))) fire()
    })
    const onFocus = () => fire()
    window.addEventListener('focus', onFocus)
    return () => {
      off?.()
      window.removeEventListener('focus', onFocus)
      if (timer) clearTimeout(timer)
    }
  }, [key])
}

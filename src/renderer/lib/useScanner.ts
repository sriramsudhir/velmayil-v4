import { useEffect, useRef, useState } from 'react'
import { attachScanner, loadScannerConfig, noteScanDelivered, SCANNER_CONFIG_EVENT, type ScanResult, type ScannerConfig } from './scanner'
import { serialScanner, type SerialStatus } from './serialScanner'
import { hidScanner, type HidStatus } from './hidScanner'

/** Live scanner settings of this terminal (re-read when Settings > Scanner saves them). */
export function useScannerConfig(): ScannerConfig {
  const [cfg, setCfg] = useState<ScannerConfig>(loadScannerConfig)
  useEffect(() => {
    const h = () => setCfg(loadScannerConfig())
    window.addEventListener(SCANNER_CONFIG_EVENT, h)
    return () => window.removeEventListener(SCANNER_CONFIG_EVENT, h)
  }, [])
  return cfg
}

/**
 * Route every barcode scan (keyboard-wedge anywhere on the page, the serial scanner, or a WebHID reader) to `onScan`.
 * `active` = false stops the scan from being delivered (a dialog is open) but the keystrokes are STILL recognised and
 * swallowed, so the reader's Enter cannot press the focused button of the dialog; `onBlocked` then tells the screen.
 */
export function useScanner(onScan: (code: string, scan: ScanResult, target?: EventTarget | null) => void, active = true, onBlocked?: (scan: ScanResult) => void): void {
  const fn = useRef(onScan)
  fn.current = onScan
  const on = useRef(active)
  on.current = active
  const blocked = useRef(onBlocked)
  blocked.current = onBlocked
  useEffect(() => {
    const deliver = (s: ScanResult, t?: EventTarget | null, isBlocked?: boolean) => {
      if (!loadScannerConfig().enabled) return
      noteScanDelivered()
      if (on.current && !isBlocked) fn.current(s.code, s, t)
      else blocked.current?.(s)
    }
    const detach = attachScanner({ config: loadScannerConfig, active: () => on.current, onScan: deliver })
    const offSerial = serialScanner.onScan((s) => deliver(s))
    const offHid = hidScanner.onScan((s) => deliver(s))
    return () => { detach(); offSerial(); offHid() }
  }, [])
}

export function useSerialStatus(): SerialStatus {
  const [s, setS] = useState<SerialStatus>(serialScanner.status)
  useEffect(() => serialScanner.onStatus(setS), [])
  return s
}

export function useHidStatus(): HidStatus {
  const [s, setS] = useState<HidStatus>(hidScanner.status)
  useEffect(() => hidScanner.onStatus(setS), [])
  return s
}

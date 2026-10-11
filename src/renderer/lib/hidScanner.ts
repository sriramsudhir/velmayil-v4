/**
 * Optional WebHID barcode readers (navigator.hid): readers switched to "HID POS" / "USB HID barcode scanner" mode (usage page 0x8C)
 * or to a vendor HID mode do NOT type like a keyboard; they send data in input reports. Electron answers the device chooser in
 * src/main/modules/pos/deviceAccess.ts. Reports are parsed by `parseHidPosReport` (pure, unit-tested) and every scan goes through
 * the same pipeline as a keyboard-wedge scan. One shared connection per window.
 * The parser follows the common vendor layout (length byte, symbology bytes, data, padding, optional "more data" flag) and falls
 * back to the longest run of printable ASCII, but only a real reader can confirm it: see docs/QA_REPORT.md.
 */
import type { ScanResult } from './scanner'

export interface HidReport { text: string; more: boolean }

const printable = (b: number) => (b >= 0x20 && b <= 0x7e) || b === 0x1d

/**
 * One HID POS input report (WITHOUT its report id byte) -> the decoded data.
 *  Layout A (Zebra / Honeywell / Datalogic "HID POS"): [length][symbology x1-4][data x length][padding 00...][more-flag]
 *  Layout B (anything else): the longest run of printable ASCII.
 */
export function parseHidPosReport(b: Uint8Array): HidReport | null {
  if (b.length < 2) return null
  let end = b.length
  let more = false
  while (end > 1 && b[end - 1] < 0x20 && b[end - 1] !== 0x1d) {
    if (end === b.length && b[end - 1] === 1) more = true
    end--
  }
  if (end <= 1) return null
  const n = b[0]
  const start = end - n
  if (n >= 1 && start >= 1) {
    let ok = true
    for (let i = start; i < end; i++) if (!printable(b[i])) { ok = false; break }
    if (ok) return { text: Array.from(b.subarray(start, end), (x) => String.fromCharCode(x)).join(''), more }
  }
  // fallback: longest printable run (ties: the later one, symbology bytes come first)
  let bestS = -1
  let bestL = 0
  let s = -1
  for (let i = 0; i <= end; i++) {
    if (i < end && printable(b[i])) { if (s < 0) s = i } else if (s >= 0) { if (i - s >= bestL) { bestL = i - s; bestS = s } s = -1 }
  }
  if (bestS < 0) return null
  return { text: Array.from(b.subarray(bestS, bestS + bestL), (x) => String.fromCharCode(x)).join(''), more }
}

/** Joins multi-report codes ("more data follows" flag) and removes CR/LF/GS framing. */
export class HidAssembler {
  private buf = ''
  push(report: Uint8Array): string | null {
    const r = parseHidPosReport(report)
    if (!r) return null
    this.buf += r.text
    if (r.more) return null
    return this.flush()
  }
  flush(): string | null {
    const s = this.buf.replace(/[\u0000-\u001f\u007f]/g, '').trim()
    this.buf = ''
    return s || null
  }
  pending(): number {
    return this.buf.length
  }
}

// ---- WebHID plumbing (minimal structural types: the DOM lib may not declare navigator.hid)
interface HidCollection { usagePage?: number; usage?: number }
export interface HidDeviceLike {
  productName?: string
  vendorId: number
  productId: number
  opened: boolean
  collections?: HidCollection[]
  open(): Promise<void>
  close(): Promise<void>
  addEventListener(type: 'inputreport', fn: (e: { reportId: number; data: DataView }) => void): void
  removeEventListener(type: 'inputreport', fn: (e: { reportId: number; data: DataView }) => void): void
}
interface HidLike {
  getDevices(): Promise<HidDeviceLike[]>
  requestDevice(o: { filters: object[] }): Promise<HidDeviceLike[]>
  addEventListener(type: 'disconnect' | 'connect', fn: (e: { device: HidDeviceLike }) => void): void
}
const hid = (): HidLike | null => ((globalThis.navigator as unknown as { hid?: HidLike } | undefined)?.hid ?? null)
export const hidSupported = (): boolean => !!hid()

export interface HidDeviceInfo { name: string; vendorId: number; productId: number; opened: boolean; usagePages: number[]; looksLikeScanner: boolean }
export const hex4 = (n: number) => n.toString(16).toUpperCase().padStart(4, '0')
const describe = (d: HidDeviceLike): HidDeviceInfo => {
  const pages = [...new Set((d.collections ?? []).map((c) => c.usagePage ?? 0))]
  return { name: d.productName || 'HID device', vendorId: d.vendorId, productId: d.productId, opened: d.opened, usagePages: pages, looksLikeScanner: pages.includes(0x8c) || pages.some((p) => p >= 0xff00) }
}

const LS_HID = 'velmayil.hid.devices'
interface Remembered { vendorId: number; productId: number }
function loadRemembered(): Remembered[] {
  try {
    const a = JSON.parse(globalThis.localStorage?.getItem(LS_HID) ?? '[]')
    return Array.isArray(a) ? a.filter((x) => x && typeof x.vendorId === 'number' && typeof x.productId === 'number') : []
  } catch {
    return []
  }
}
function remember(list: Remembered[]): void {
  try {
    const all = [...loadRemembered(), ...list].filter((x, i, arr) => arr.findIndex((y) => y.vendorId === x.vendorId && y.productId === x.productId) === i)
    globalThis.localStorage?.setItem(LS_HID, JSON.stringify(all.slice(-8)))
  } catch {
    /* ignore */
  }
}

export type HidStatus ={ state: 'off' | 'connecting' | 'connected' | 'error'; message?: string; device?: string }

class HidScannerHub {
  status: HidStatus = { state: 'off' }
  private scanListeners = new Set<(s: ScanResult) => void>()
  private statusListeners = new Set<(s: HidStatus) => void>()
  private open = new Map<HidDeviceLike, (e: { reportId: number; data: DataView }) => void>()
  private watching = false

  onScan(fn: (s: ScanResult) => void): () => void {
    this.scanListeners.add(fn)
    return () => this.scanListeners.delete(fn)
  }
  onStatus(fn: (s: HidStatus) => void): () => void {
    this.statusListeners.add(fn)
    fn(this.status)
    return () => this.statusListeners.delete(fn)
  }
  private set(s: HidStatus) {
    this.status = s
    this.statusListeners.forEach((f) => f(s))
  }
  private emit(code: string) {
    const scan: ScanResult = { code, typed: code, length: code.length, durationMs: 0, avgGapMs: 0, maxGapMs: 0, terminator: 'hid', source: 'hid', trace: [] }
    this.scanListeners.forEach((f) => f(scan))
  }

  /** Devices this window may already use (granted earlier), with what they are. */
  async list(): Promise<HidDeviceInfo[]> {
    const h = hid()
    if (!h) return []
    try { return (await h.getDevices()).map(describe) } catch { return [] }
  }

  private async attach(d: HidDeviceLike): Promise<void> {
    if (this.open.has(d)) return
    if (!d.opened) await d.open()
    const asm = new HidAssembler()
    let idle: ReturnType<typeof setTimeout> | null = null
    const fn = (e: { reportId: number; data: DataView }) => {
      const bytes = new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength)
      const code = asm.push(bytes)
      if (idle) clearTimeout(idle)
      if (code) this.emit(code)
      else if (asm.pending()) idle = setTimeout(() => { const c = asm.flush(); if (c) this.emit(c) }, 150)
    }
    d.addEventListener('inputreport', fn)
    this.open.set(d, fn)
    this.set({ state: 'connected', device: d.productName || `${hex4(d.vendorId)}:${hex4(d.productId)}` })
  }

  private watch(h: HidLike): void {
    if (this.watching) return
    this.watching = true
    h.addEventListener('disconnect', (e) => {
      const fn = this.open.get(e.device)
      if (fn) {
        this.open.delete(e.device)
        if (!this.open.size) this.set({ state: 'error', message: 'The HID reader was unplugged.' })
      }
    })
  }

  /** Ask which device (first time) - `filters: []` lists every device Chromium may talk to (keyboards are hidden by design). */
  async connect(): Promise<void> {
    const h = hid()
    if (!h) return this.set({ state: 'error', message: 'This computer/app build does not support HID readers (WebHID unavailable).' })
    this.set({ state: 'connecting' })
    try {
      const picked = await h.requestDevice({ filters: [] })
      if (!picked.length) return this.set({ state: 'off', message: 'No device was chosen.' })
      this.watch(h)
      for (const d of picked) await this.attach(d)
      remember(picked.map((d) => ({ vendorId: d.vendorId, productId: d.productId })))
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      this.set({ state: /no device selected|cancel|NotFound|aborted/i.test(msg) ? 'off' : 'error', message: /no device selected|NotFound/i.test(msg) ? 'No device was chosen.' : msg })
    }
  }

  /**
   * Re-open readers on startup: devices on the HID POS usage page (0x8C), plus devices the owner connected by hand earlier
   * (remembered by VID/PID). NEVER other vendor-page devices: laptops have plenty (touchpad, sensors) and their reports are not scans.
   */
  async autoConnect(): Promise<number> {
    const h = hid()
    if (!h) return 0
    try {
      this.watch(h)
      const remembered = loadRemembered()
      let n = 0
      for (const d of await h.getDevices()) {
        const info = describe(d)
        if (!info.usagePages.includes(0x8c) && !remembered.some((r) => r.vendorId === d.vendorId && r.productId === d.productId)) continue
        try { await this.attach(d); n++ } catch { /* busy or gone */ }
      }
      return n
    } catch {
      return 0
    }
  }

  async disconnect(): Promise<void> {
    for (const [d, fn] of this.open) {
      try { d.removeEventListener('inputreport', fn); await d.close() } catch { /* ignore */ }
    }
    this.open.clear()
    try { globalThis.localStorage?.removeItem(LS_HID) } catch { /* ignore */ }
    this.set({ state: 'off' })
  }
}

export const hidScanner = new HidScannerHub()

/**
 * Optional serial / COM-port barcode scanners via the Web Serial API (navigator.serial). The scanner sends the code
 * followed by CR / LF (or nothing + a pause); every line becomes a ScanResult and goes through the same pipeline as a
 * keyboard-wedge scan. One shared connection per window, so the POS header button and the Settings test page agree.
 * Needs the main-process port picker in src/main/modules/pos/serialPorts.ts. Not verifiable without hardware.
 */
import type { ScanResult } from './scanner'

/** Splits a byte-stream-as-text into scans: CR/LF/NUL/ETX end a code; leftovers flush after `idleMs`. Pure. */
export class SerialLineSplitter {
  private buf = ''
  push(chunk: string): string[] {
    this.buf += chunk
    const parts = this.buf.split(/[\r\n\0\u0003\u0004]+/)
    this.buf = parts.pop() ?? ''
    return parts.map(clean).filter(Boolean)
  }
  /** idle flush: whatever is pending is a complete code (scanner without terminator) */
  flush(): string | null {
    const s = clean(this.buf)
    this.buf = ''
    return s || null
  }
  pending(): number {
    return this.buf.length
  }
}
// strip control characters and STX framing some serial scanners add
const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f]/g, '').trim()

type SerialLike = {
  requestPort(): Promise<SerialPortLike>
  getPorts(): Promise<SerialPortLike[]>
}
interface SerialPortLike {
  open(o: { baudRate: number }): Promise<void>
  close(): Promise<void>
  readable: ReadableStream<Uint8Array> | null
  getInfo?(): { usbVendorId?: number; usbProductId?: number }
}
const serial = (): SerialLike | null => {
  const s = (globalThis.navigator as unknown as { serial?: SerialLike } | undefined)?.serial
  return s ?? null
}
export const serialSupported = (): boolean => !!serial()

export type SerialStatus = { state: 'off' | 'connecting' | 'connected' | 'error'; message?: string; baud?: number }

class SerialScannerHub {
  status: SerialStatus = { state: 'off' }
  private scanListeners = new Set<(s: ScanResult) => void>()
  private statusListeners = new Set<(s: SerialStatus) => void>()
  private port: SerialPortLike | null = null
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  private run = 0

  onScan(fn: (s: ScanResult) => void): () => void {
    this.scanListeners.add(fn)
    return () => this.scanListeners.delete(fn)
  }
  onStatus(fn: (s: SerialStatus) => void): () => void {
    this.statusListeners.add(fn)
    fn(this.status)
    return () => this.statusListeners.delete(fn)
  }
  private set(s: SerialStatus) {
    this.status = s
    this.statusListeners.forEach((f) => f(s))
  }
  private emit(code: string) {
    const scan: ScanResult = { code, typed: code, length: code.length, durationMs: 0, avgGapMs: 0, maxGapMs: 0, terminator: 'serial', source: 'serial', trace: [] }
    this.scanListeners.forEach((f) => f(scan))
  }

  /** Ask the user for a port (first time) or reuse a previously granted one (`reuse`). */
  async connect(baud: number, reuse = false): Promise<void> {
    const s = serial()
    if (!s) return this.set({ state: 'error', message: 'This computer/app build does not support serial scanners (Web Serial unavailable).' })
    await this.disconnect()
    this.set({ state: 'connecting', baud })
    try {
      let port: SerialPortLike | undefined
      if (reuse) port = (await s.getPorts())[0]
      if (!port) {
        if (reuse) return this.set({ state: 'off' })
        port = await s.requestPort()
      }
      await port.open({ baudRate: baud })
      this.port = port
      this.set({ state: 'connected', baud })
      void this.readLoop(port, ++this.run)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      this.set({ state: /no port selected|cancel|NotFound/i.test(msg) ? 'off' : 'error', message: /no port selected|NotFound/i.test(msg) ? 'No port was chosen.' : msg })
    }
  }

  private async readLoop(port: SerialPortLike, id: number): Promise<void> {
    const split = new SerialLineSplitter()
    const dec = new TextDecoder()
    let idle: ReturnType<typeof setTimeout> | null = null
    try {
      while (port.readable && id === this.run) {
        this.reader = port.readable.getReader()
        try {
          for (;;) {
            const { value, done } = await this.reader.read()
            if (done) break
            if (value) {
              for (const code of split.push(dec.decode(value, { stream: true }))) this.emit(code)
              if (idle) clearTimeout(idle)
              if (split.pending()) idle = setTimeout(() => { const c = split.flush(); if (c) this.emit(c) }, 120)
            }
          }
        } finally {
          this.reader.releaseLock()
          this.reader = null
        }
      }
    } catch (e) {
      if (id === this.run) this.set({ state: 'error', message: `Scanner disconnected: ${e instanceof Error ? e.message : String(e)}` })
    } finally {
      if (idle) clearTimeout(idle)
    }
  }

  async disconnect(): Promise<void> {
    this.run++
    try { await this.reader?.cancel() } catch { /* ignore */ }
    try { await this.port?.close() } catch { /* ignore */ }
    this.port = null
    this.reader = null
    if (this.status.state !== 'error') this.set({ state: 'off' })
  }
}

export const serialScanner = new SerialScannerHub()

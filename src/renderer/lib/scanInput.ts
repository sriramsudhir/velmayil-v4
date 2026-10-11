/**
 * Helpers for the "always-ready" scan boxes (billing scan box, stock-count box, product pickers): the PRIMARY path of a
 * keyboard-wedge reader. The reader simply types the code into the focused box and ends with Enter (or Tab), so this works with
 * ANY timing - slow Bluetooth readers, readers the global detector does not recognise, odd key events. The global capture in
 * scanner.ts is only the fallback for when focus is elsewhere.
 */
import { charOf, isStrayTerminator, loadScannerConfig, noteScanDelivered, normalizeBurst, type ScannerConfig } from './scanner'

export type ScanBoxAction = 'submit' | 'ignore' | null

interface KeyLike { key: string; code?: string; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean; shiftKey?: boolean; repeat?: boolean }

/**
 * What a keydown in a scan box means:
 *  - 'submit' : Enter (or Tab when the reader ends codes with Tab) while the box holds a code
 *  - 'ignore' : the second half of a CR+LF terminator right after a scan (must not act as "pay" / "empty submit")
 *  - null     : not ours, handle normally
 */
export function scanBoxKey(e: KeyLike, text: string, now: number = performance.now(), fast = false): ScanBoxAction {
  const has = text.trim().length > 0
  const isEnter = e.key === 'Enter' || e.code === 'NumpadEnter'
  const ctrlLf = !!e.ctrlKey && !e.altKey && /^[jm]$/i.test(e.key)
  if ((isEnter || ctrlLf) && !has && isStrayTerminator(now)) return 'ignore'
  if (ctrlLf && has) return 'submit' // reader sends Ctrl+J (LF) as its terminator
  if (isEnter && !e.ctrlKey && !e.metaKey) return 'submit'
  // Tab only submits machine-fast input: a person typing and tabbing away from the box must still be able to leave it
  if (e.key === 'Tab' && !e.shiftKey && has && fast) {
    const c = loadScannerConfig()
    if ((c.suffix === 'Tab' || c.suffix === 'any') && text.trim().length >= Math.min(c.minLength, 3)) return 'submit'
  }
  return null
}

/** Call after a box submit so a trailing duplicate terminator is recognised as such. */
export function noteBoxSubmit(): void {
  noteScanDelivered()
}

export interface BoxTiming { avgGapMs: number; maxGapMs: number; keys: number }

/**
 * Records the physical keys typed into a scan box so that, when a code is submitted, (1) the reader's speed can be shown
 * ("3 ms/key") and (2) a layout problem can be repaired exactly like the global detector does: Tamil/Hindi/AZERTY keyboard layouts,
 * Shift stuck, Caps Lock. Repair is only applied to machine-fast input (a person typing a Tamil product name is left alone) and only
 * when the box text is exactly what the keys typed (no editing, no paste).
 */
export class BoxRecorder {
  private ts: number[] = []
  private items: { ch: string; code?: string; shift: boolean; caps: boolean }[] = []
  private dirty = false
  /** call for every keydown inside the box */
  key(e: { key: string; code?: string; timeStamp: number; shiftKey?: boolean; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean; repeat?: boolean; getModifierState?: (k: string) => boolean }): void {
    if (this.ts.length && e.timeStamp - this.ts[this.ts.length - 1] > 1500) this.reset()
    if (e.key === 'Enter' || e.key === 'Tab' || e.key === 'Shift' || e.key === 'CapsLock' || e.key === 'Control' || e.key === 'Alt' || e.key === 'NumLock') return
    const ch = charOf({ key: e.key, code: e.code, t: e.timeStamp, shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey })
    if (ch == null || e.repeat) { this.dirty = true; return } // Backspace, arrows, Ctrl+V, held key: the text is no longer just "keys typed"
    this.ts.push(e.timeStamp)
    this.items.push({ ch, code: e.code, shift: !!e.shiftKey, caps: e.getModifierState?.('CapsLock') ?? false })
  }
  reset(): void {
    this.ts = []
    this.items = []
    this.dirty = false
  }
  /** The keys recorded so far arrived at machine speed (a reader, not a person). `maxAvgMs` is lenient: slow Bluetooth readers ~100 ms. */
  looksFast(maxAvgMs = 100): boolean {
    const t = this.ts
    if (t.length < 3) return false
    return (t[t.length - 1] - t[0]) / (t.length - 1) <= maxAvgMs
  }
  /** Consume the recording for a submitted `text`. */
  take(text: string, cfg: Pick<ScannerConfig, 'layout' | 'caseMode' | 'minLength'>): { code: string; timing: BoxTiming | null; repaired: boolean } {
    const { ts, items, dirty } = this
    this.reset()
    let timing: BoxTiming | null = null
    if (ts.length >= 3) {
      const gaps = ts.slice(1).map((x, i) => x - ts[i])
      timing = { avgGapMs: Math.round((gaps.reduce((a, b) => a + b, 0) / gaps.length) * 10) / 10, maxGapMs: Math.round(Math.max(...gaps)), keys: ts.length }
    }
    const trimmed = text.trim()
    const machine = !!timing && timing.avgGapMs <= (cfg.layout === 'us' ? 250 : 100)
    if (!machine || dirty || cfg.layout === 'native' || items.map((i) => i.ch).join('').trim() !== trimmed) return { code: trimmed, timing, repaired: false }
    const code = normalizeBurst(items, cfg).trim()
    return { code: code || trimmed, timing, repaired: code !== trimmed }
  }
}

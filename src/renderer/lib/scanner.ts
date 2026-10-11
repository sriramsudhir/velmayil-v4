/**
 * Barcode scanner support for keyboard-wedge scanners (USB / Bluetooth HID): a scanner "types" the code and a
 * terminator key, much faster than a person. The detector below is a PURE state machine (inject timestamps) so it is
 * unit-testable with simulated key streams; `attachScanner` is the thin DOM glue that routes a detected scan to the
 * app without typing it into whatever field happens to have focus.
 *
 * Two independent paths exist on the billing screen, so a reader works even when one of them cannot recognise it:
 *   1. PRIMARY  - the always-focused scan box accepts typing + Enter/Tab with ANY timing (see lib/scanInput.ts).
 *   2. FALLBACK - this global capture, for when focus is somewhere else (body, bill note, ...): a burst of keys
 *      that is fast enough and ends with the terminator (Enter / Tab) or, for readers that send none, an idle gap.
 *
 * How a scan is told from typing: every character of a scan arrives within the allowed gap of the previous one and the
 * burst ends with the terminator. Human typing is slower, so it is passed through untouched. The first character of a
 * burst cannot be known to be a scan yet, so it is let through and removed again (the field is restored) once the burst
 * is confirmed; the rest are swallowed. If a burst turns out not to be a scan, the swallowed characters are
 * re-inserted ("replay"), so slow typing is never lost. The allowed gap adapts to the reader (rolling median of its
 * slowest gaps), and is generous when focus is not in an editable field (nobody can be typing there).
 */

export type Terminator = 'Enter' | 'Tab' | 'none' | 'any'

export interface ScannerConfig {
  enabled: boolean
  /** max gap between two keys of one scan (ms). USB scanners are ~1-15 ms; Bluetooth ones can be 30-60 ms. */
  maxGapMs: number
  /** shorter bursts are treated as typing (characters of the code, without prefix/suffix) */
  minLength: number
  /** '' = none, 'Enter' | 'Tab' = a key sent before the code, anything else = literal leading characters (e.g. '~' or 'STX') */
  prefix: string
  /** key sent after the code. 'none' = finish after `idleMs` of silence. 'any' = Enter or Tab. */
  suffix: Terminator
  idleMs: number
  /** auto: use the typed characters but repair shifted/AZERTY/non-Latin digits and caps-lock case; us: trust physical keys as a US keyboard; native: use event.key as is */
  layout: 'auto' | 'us' | 'native'
  caseMode: 'auto' | 'upper' | 'lower'
  sound: boolean
  serialBaud: number
  serialAutoConnect: boolean
  /** reconnect a previously allowed HID-POS reader automatically on the billing screen */
  hidAutoConnect: boolean
  /** settings test page / product list: put the scan into the search box instead of the cart */
  scanToSearch: boolean
  /** learn the reader's real speed from its first scans (never makes the limit stricter than maxGapMs) */
  adaptive: boolean
}

export const DEFAULT_SCANNER: ScannerConfig = {
  enabled: true, maxGapMs: 40, minLength: 4, prefix: '', suffix: 'any', idleMs: 90, layout: 'auto', caseMode: 'auto',
  sound: true, serialBaud: 9600, serialAutoConnect: false, hidAutoConnect: true, scanToSearch: false, adaptive: true
}

export function normalizeScannerConfig(raw: unknown): ScannerConfig {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d)
  const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d)
  const d = DEFAULT_SCANNER
  return {
    enabled: bool(o.enabled, d.enabled),
    maxGapMs: num(o.maxGapMs, 10, 300, d.maxGapMs),
    minLength: num(o.minLength, 1, 40, d.minLength),
    prefix: typeof o.prefix === 'string' ? o.prefix.slice(0, 6) : d.prefix,
    suffix: o.suffix === 'Enter' || o.suffix === 'Tab' || o.suffix === 'none' || o.suffix === 'any' ? o.suffix : d.suffix,
    idleMs: num(o.idleMs, 30, 1000, d.idleMs),
    layout: o.layout === 'us' || o.layout === 'native' || o.layout === 'auto' ? o.layout : d.layout,
    caseMode: o.caseMode === 'upper' || o.caseMode === 'lower' || o.caseMode === 'auto' ? o.caseMode : d.caseMode,
    sound: bool(o.sound, d.sound),
    serialBaud: [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200].includes(o.serialBaud as number) ? (o.serialBaud as number) : d.serialBaud,
    serialAutoConnect: bool(o.serialAutoConnect, d.serialAutoConnect),
    hidAutoConnect: bool(o.hidAutoConnect, d.hidAutoConnect),
    scanToSearch: bool(o.scanToSearch, d.scanToSearch),
    adaptive: bool(o.adaptive, d.adaptive)
  }
}

// ------------------------------------------------------------------ config persistence (per terminal; purely a convenience)
const LS_KEY = 'velmayil.scanner'
const LS_LEARN = 'velmayil.scanner.learned'
export const SCANNER_CONFIG_EVENT = 'velmayil:scanner-config'
export function loadScannerConfig(): ScannerConfig {
  try {
    const s = globalThis.localStorage?.getItem(LS_KEY)
    return normalizeScannerConfig(s ? JSON.parse(s) : {})
  } catch {
    return { ...DEFAULT_SCANNER }
  }
}
export function saveScannerConfig(c: ScannerConfig): void {
  try {
    globalThis.localStorage?.setItem(LS_KEY, JSON.stringify(normalizeScannerConfig(c)))
  } catch {
    /* ignore */
  }
  try {
    globalThis.dispatchEvent?.(new Event(SCANNER_CONFIG_EVENT))
  } catch {
    /* ignore */
  }
}
export function loadLearned(): number[] {
  try {
    const a = JSON.parse(globalThis.localStorage?.getItem(LS_LEARN) ?? '[]')
    return Array.isArray(a) ? a.filter((x) => typeof x === 'number' && Number.isFinite(x)).slice(-8) : []
  } catch {
    return []
  }
}
export function saveLearned(a: number[]): void {
  try {
    globalThis.localStorage?.setItem(LS_LEARN, JSON.stringify(a.slice(-8)))
  } catch {
    /* ignore */
  }
}
export function clearLearned(): void {
  try { globalThis.localStorage?.removeItem(LS_LEARN) } catch { /* ignore */ }
}

// ------------------------------------------------------------------ key model
export interface KeyIn {
  key: string
  code?: string
  /** monotonic ms (KeyboardEvent.timeStamp) */
  t: number
  shift?: boolean
  caps?: boolean
  ctrl?: boolean
  alt?: boolean
  meta?: boolean
  /** the character did not come from a keydown (Alt+numpad "Alt codes", IME, unicode packets): it arrived as keypress/input only */
  fromInput?: boolean
}

const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'AltGraph', 'Meta', 'CapsLock', 'NumLock', 'ScrollLock', 'OS', 'Process', 'Dead', 'Unidentified', 'Hyper', 'Super', 'Fn', 'FnLock', 'Symbol', 'SymbolLock', 'Compose', 'KanaMode', 'Convert', 'NonConvert'])
const NUMPAD_OPS: Record<string, string> = { NumpadDecimal: '.', NumpadAdd: '+', NumpadSubtract: '-', NumpadMultiply: '*', NumpadDivide: '/' }
// eslint-disable-next-line no-control-regex
const NON_ASCII = /[^\x00-\x7f]/

/** The character a key event contributes to a code, or null when it is not a data key. */
export function charOf(ev: KeyIn): string | null {
  if (ev.meta) return null
  if (ev.ctrl !== !!ev.alt && (ev.ctrl || ev.alt) && !ev.fromInput) return null // Ctrl+x / Alt+x shortcuts; Ctrl+Alt is AltGr (a real character on many layouts)
  const k = ev.key
  if (k.length === 1) return k
  const c = ev.code ?? ''
  const m = /^Numpad(\d)$/.exec(c)
  if (m) return m[1] // NumLock off: key is 'End', 'ArrowDown' ... but the physical key is the digit
  if (NUMPAD_OPS[c]) return NUMPAD_OPS[c]
  // The reader/driver gave no usable key name (Unidentified), an IME is composing (Process/Dead), but the physical key is known
  if (k === 'Unidentified' || k === 'Process' || k === 'Dead' || k === 'Compose') {
    return usChar(c, !!ev.shift)
  }
  // layouts that produce several UTF-16 units for one key (Tamil / Hindi conjuncts, surrogate pairs): still ONE data key
  if (k.length > 1 && NON_ASCII.test(k)) return k
  return null
}

const SHIFT_DIGITS = ')!@#$%^&*('
const US_PLAIN: Record<string, [string, string]> = {
  Minus: ['-', '_'], Equal: ['=', '+'], BracketLeft: ['[', '{'], BracketRight: [']', '}'], Backslash: ['\\', '|'], Semicolon: [';', ':'],
  Quote: ["'", '"'], Comma: [',', '<'], Period: ['.', '>'], Slash: ['/', '?'], Backquote: ['`', '~'], Space: [' ', ' '], IntlBackslash: ['\\', '|']
}
/** What a US keyboard would type for a physical key (scanners emulate a US layout by default). */
export function usChar(code: string | undefined, shift: boolean): string | null {
  if (!code) return null
  let m = /^Key([A-Z])$/.exec(code)
  if (m) return shift ? m[1] : m[1].toLowerCase()
  m = /^Digit(\d)$/.exec(code)
  if (m) return shift ? SHIFT_DIGITS[Number(m[1])] : m[1]
  m = /^Numpad(\d)$/.exec(code)
  if (m) return m[1]
  if (NUMPAD_OPS[code]) return NUMPAD_OPS[code]
  const p = US_PLAIN[code]
  return p ? (shift ? p[1] : p[0]) : null
}

interface Item { ch: string; code?: string; shift: boolean; caps: boolean; t: number }

/** Turn the physical keys of a finished burst into the barcode text (layout / shift / caps-lock repair). */
export function normalizeBurst(items: { ch: string; code?: string; shift?: boolean; caps?: boolean }[], cfg: Pick<ScannerConfig, 'layout' | 'caseMode'>): string {
  let chars = items.map((i) => i.ch)
  if (cfg.layout === 'us') {
    chars = items.map((i) => usChar(i.code, !!i.shift) ?? i.ch)
  } else if (cfg.layout === 'auto') {
    // AZERTY-like layouts or a stuck Shift: every top-row digit key produced a symbol => the scanner meant digits.
    // Needs 2+ such keys (or nothing but such keys) so a lone real symbol such as the '#' in "AB#" is never "repaired".
    const top = items.map((it, i) => ({ it, i })).filter((x) => /^Digit\d$/.test(x.it.code ?? ''))
    if (top.length > 0 && top.every((x) => !/\d/.test(x.it.ch)) && (top.length >= 2 || top.length === items.length)) for (const x of top) chars[x.i] = (x.it.code as string).slice(5)
    // Non-Latin Windows layouts (Tamil, Hindi, Arabic, Cyrillic ...): the reader sent Latin key positions, the layout turned them into
    // other scripts. The physical key still tells what the reader meant.
    chars = chars.map((c, i) => (NON_ASCII.test(c) ? usChar(items[i].code, !!items[i].shift) ?? c : c))
    // Caps Lock flips the case of letters the scanner sent (it sends Shift explicitly for capitals)
    chars = chars.map((c, i) => (items[i].caps && /[a-z]/i.test(c) && items[i].code?.startsWith('Key') ? (items[i].shift ? c.toUpperCase() : c.toLowerCase()) : c))
  }
  let text = chars.join('')
  if (cfg.caseMode === 'upper') text = text.toUpperCase()
  else if (cfg.caseMode === 'lower') text = text.toLowerCase()
  return text
}

/** Show a scanned string with invisible characters spelled out, so the owner can see what the reader really sent. */
export function visibleCode(s: string): string {
  return [...s].map((c) => {
    const n = c.codePointAt(0) ?? 0
    if (n === 0x1d) return '<GS>'
    if (n === 0x0d) return '<CR>'
    if (n === 0x0a) return '<LF>'
    if (n === 0x09) return '<TAB>'
    if (n === 0x02) return '<STX>'
    if (n === 0x03) return '<ETX>'
    if (n === 0x04) return '<EOT>'
    if (n === 0 ) return '<NUL>'
    if (n < 0x20 || n === 0x7f) return `<0x${n.toString(16).toUpperCase().padStart(2, '0')}>`
    if (n === 0x20) return '␣' // open box for a space
    return c
  }).join('')
}

// ------------------------------------------------------------------ the detector
export interface ScanResult {
  /** normalized code (prefix removed) */
  code: string
  /** what the keys literally typed, before layout/caps repair */
  typed: string
  length: number
  durationMs: number
  avgGapMs: number
  maxGapMs: number
  terminator: 'Enter' | 'Tab' | 'idle' | 'serial' | 'hid'
  /** which path delivered it */
  source?: 'wedge' | 'box' | 'serial' | 'hid'
  trace: { ch: string; code?: string; gapMs: number }[]
}

export interface FeedResult {
  /** swallow this key event (preventDefault) */
  consume: boolean
  scan?: ScanResult
  /** characters that were swallowed but turned out not to be a scan: put them back into the focused field */
  replay?: string
}

const isKeyName = (p: string) => p === 'Enter' || p === 'Tab'
const median = (a: number[]): number => {
  if (!a.length) return 0
  const s = [...a].sort((x, y) => x - y)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
/** A stray second terminator (CR+LF readers send Enter twice, or Enter + Ctrl+J) must not act as a human Enter right after a scan. */
const GUARD_MS = 350

export class ScanDetector {
  private items: Item[] = []
  private prefixKeyT = -1
  private guardUntil = -1
  private taintUntil = -1
  private tainted = false
  private cfg: ScannerConfig
  /** slowest inter-key gap of the last scans (rolling window) - the reader's real speed */
  learned: number[] = []
  onLearn?: (learned: number[]) => void
  constructor(cfg: ScannerConfig = DEFAULT_SCANNER) {
    this.cfg = cfg
  }
  setConfig(cfg: ScannerConfig): void {
    this.cfg = cfg
  }
  /** characters currently buffered (0 = idle) */
  size(): number {
    return this.items.length
  }
  lastTime(): number {
    return this.items.length ? this.items[this.items.length - 1].t : -1
  }
  reset(): void {
    this.items = []
    this.prefixKeyT = -1
  }

  /** The gap limit in force: the configured one, raised (never lowered) to what this reader has shown it needs. */
  effectiveMaxGap(): number {
    const c = this.cfg
    if (!c.adaptive || this.learned.length < 2) return c.maxGapMs
    return Math.min(300, Math.max(c.maxGapMs, Math.ceil(median(this.learned) * 2.5 + 10)))
  }

  private learn(scan: ScanResult): void {
    if (!this.cfg.adaptive || scan.length < 4) return
    this.learned.push(scan.maxGapMs)
    if (this.learned.length > 8) this.learned.shift()
    this.onLearn?.(this.learned)
  }

  private consumedText(): string {
    return this.items.slice(1).map((i) => i.ch).join('')
  }
  private abandon(): FeedResult {
    const replay = this.consumedText()
    this.reset()
    return { consume: false, ...(replay ? { replay } : {}) }
  }
  /** Something proves a person is at the keyboard (auto-repeat, focus change ...): drop the burst, replay what was swallowed. */
  interrupt(): FeedResult {
    return this.abandon()
  }

  private literalPrefix(): string {
    return this.cfg.prefix && !isKeyName(this.cfg.prefix) ? this.cfg.prefix : ''
  }

  private finish(terminator: ScanResult['terminator']): ScanResult | null {
    if (this.tainted) return null // tail of a scan that stalled midway: never a code of its own
    const lp = this.literalPrefix()
    const items = this.items
    const typedAll = items.map((i) => i.ch).join('')
    if (lp && !typedAll.startsWith(lp)) return null
    const data = items.slice(lp.length)
    if (data.length < this.cfg.minLength) return null
    const gaps = items.map((it, i) => (i === 0 ? 0 : it.t - items[i - 1].t))
    const real = gaps.slice(1)
    const dataGaps = gaps.slice(lp.length + 1)
    if (real.some((g) => g > this.effectiveMaxGap())) return null
    return {
      code: normalizeBurst(data, this.cfg),
      typed: data.map((d) => d.ch).join(''),
      length: data.length,
      durationMs: items[items.length - 1].t - items[0].t,
      avgGapMs: real.length ? Math.round((real.reduce((a, b) => a + b, 0) / real.length) * 10) / 10 : 0,
      maxGapMs: dataGaps.length ? Math.max(0, ...dataGaps) : 0,
      terminator,
      source: 'wedge',
      trace: items.map((it, i) => ({ ch: it.ch, code: it.code, gapMs: Math.round(gaps[i] * 10) / 10 }))
    }
  }

  feed(ev: KeyIn): FeedResult {
    const cfg = this.cfg
    if (!cfg.enabled) return { consume: false }
    const isEnter = ev.key === 'Enter' || ev.code === 'NumpadEnter'
    const isTab = ev.key === 'Tab'
    const term: 'Enter' | 'Tab' | null = isEnter ? 'Enter' : isTab ? 'Tab' : null
    // second half of a CR+LF terminator (Enter again, or Ctrl+J / Ctrl+M) right after a scan: swallow it, it is not a person
    if (this.guardUntil >= 0 && ev.t <= this.guardUntil && this.items.length === 0) {
      const ctrlLf = !!ev.ctrl && !ev.alt && /^[jm]$/i.test(ev.key)
      if ((term && !(isKeyName(cfg.prefix) && cfg.prefix === term)) || ctrlLf) return { consume: true }
    }
    if (MODIFIER_KEYS.has(ev.key) && !charOf(ev)) return { consume: false } // Shift / CapsLock between characters: ignore
    if (ev.alt && !ev.ctrl && /^Numpad/.test(ev.code ?? '')) return { consume: false } // Alt+numpad digits of an "Alt code": the character itself arrives later (fromInput)
    let out: FeedResult = { consume: false }
    const gapLimit = this.effectiveMaxGap()
    // too slow since the previous key => whatever was buffered was human typing
    if (this.items.length && ev.t - this.lastTime() > gapLimit) {
      // A burst that was clearly machine-fast and then stalled (a hiccup in the middle of a scan): the keys that follow are the TAIL of
      // that code, not a new code. Do not accept the tail as a scan (it would look up the wrong product).
      if (this.items.length >= 3) this.taintUntil = ev.t + 400
      out = this.abandon()
    }
    if (this.prefixKeyT >= 0 && ev.t - this.prefixKeyT > gapLimit) this.prefixKeyT = -1

    const ch = charOf(ev)

    if (ch != null) {
      // a prefix KEY (Enter/Tab) must have been seen right before the first character
      if (this.items.length === 0 && isKeyName(cfg.prefix) && this.prefixKeyT < 0) return out
      if (this.items.length === 0) this.tainted = ev.t < this.taintUntil
      this.items.push({ ch, code: ev.code, shift: !!ev.shift, caps: !!ev.caps, t: ev.t })
      const lp = this.literalPrefix()
      if (lp && this.items.length <= lp.length && this.items[this.items.length - 1].ch !== lp[this.items.length - 1]) {
        const r = this.abandon()
        return { consume: false, ...(r.replay ? { replay: (out.replay ?? '') + r.replay } : out.replay ? { replay: out.replay } : {}) }
      }
      // first char leaks (we cannot know yet); the rest of a fast burst is swallowed
      return { ...out, consume: this.items.length >= 2 }
    }

    if (term) {
      const prefixIsThis = isKeyName(cfg.prefix) && cfg.prefix === term
      if (this.items.length === 0) {
        if (prefixIsThis) this.prefixKeyT = ev.t
        return out
      }
      const accepts = cfg.suffix === 'any' || cfg.suffix === 'none' || cfg.suffix === term
      if (accepts) {
        const scan = this.finish(term)
        if (scan) {
          this.reset()
          this.learn(scan)
          this.guardUntil = ev.t + GUARD_MS
          if (prefixIsThis) this.prefixKeyT = -1
          return { consume: true, scan }
        }
      }
      const r = this.abandon()
      if (prefixIsThis) this.prefixKeyT = ev.t
      return { consume: false, ...(r.replay ? { replay: (out.replay ?? '') + r.replay } : out.replay ? { replay: out.replay } : {}) }
    }

    // any other key (arrows, Backspace, F-keys, shortcuts...) means a person is at the keyboard
    const r = this.abandon()
    return { consume: false, ...(r.replay ? { replay: (out.replay ?? '') + r.replay } : out.replay ? { replay: out.replay } : {}) }
  }

  /** For scanners without a terminator: call after `idleMs` of silence. Returns the scan, or a replay when it was only typing. */
  flushIdle(now: number): FeedResult | null {
    if (!this.items.length) return null
    if (now - this.lastTime() < this.cfg.idleMs) return null
    if (this.cfg.suffix !== 'none') return this.abandon()
    const scan = this.finish('idle')
    if (scan) {
      this.reset()
      this.learn(scan)
      this.guardUntil = now + GUARD_MS
      return { consume: false, scan }
    }
    return this.abandon()
  }
}

/** Convenience for tests / replays: run a whole key stream through a fresh detector. */
export function runDetector(events: KeyIn[], cfg: Partial<ScannerConfig> = {}, endAt?: number): { scans: ScanResult[]; consumed: boolean[]; replays: string[] } {
  const d = new ScanDetector({ ...DEFAULT_SCANNER, ...cfg })
  const scans: ScanResult[] = []
  const consumed: boolean[] = []
  const replays: string[] = []
  for (const e of events) {
    const r = d.feed(e)
    consumed.push(r.consume)
    if (r.scan) scans.push(r.scan)
    if (r.replay) replays.push(r.replay)
  }
  const last = events[events.length - 1]
  const f = d.flushIdle(endAt ?? (last ? last.t + 10_000 : 0))
  if (f?.scan) scans.push(f.scan)
  if (f?.replay) replays.push(f.replay)
  return { scans, consumed, replays }
}

/** Build the key events a scanner (or a person) would produce for `text`. */
export function simulateKeys(text: string, o: { start?: number; gap?: number; terminator?: 'Enter' | 'Tab' | null; capsLock?: boolean; prefixKey?: 'Enter' | 'Tab'; extraTerminator?: 'Enter' | 'ctrlJ' } = {}): KeyIn[] {
  const out: KeyIn[] = []
  let t = o.start ?? 1000
  const gap = o.gap ?? 5
  if (o.prefixKey) { out.push({ key: o.prefixKey, t }); t += gap }
  for (const c of text) {
    const upper = /[A-Z]/.test(c)
    const shifted = upper || '!@#$%^&*()_+{}|:"<>?~'.includes(c)
    const code = /[A-Za-z]/.test(c) ? `Key${c.toUpperCase()}` : /\d/.test(c) ? `Digit${c}` : undefined
    if (shifted) out.push({ key: 'Shift', t, shift: true })
    const key = o.capsLock && /[A-Za-z]/.test(c) ? (upper ? c.toLowerCase() : c.toUpperCase()) : c
    out.push({ key, code, t, shift: shifted, caps: !!o.capsLock })
    t += gap
  }
  if (o.terminator !== null) out.push({ key: o.terminator ?? 'Enter', t })
  if (o.extraTerminator) {
    t += gap
    out.push(o.extraTerminator === 'ctrlJ' ? { key: 'j', code: 'KeyJ', ctrl: true, t } : { key: 'Enter', t })
  }
  return out
}

// ------------------------------------------------------------------ "Detect my reader": analyse a raw capture
export interface RawEvent extends KeyIn {
  /** 'down' = keydown, 'input' = character that arrived without a keydown (Alt code / IME) */
  kind: 'down' | 'input'
}

export interface Finding { level: 'ok' | 'info' | 'warn'; text: string }
export interface CaptureAnalysis {
  /** a usable barcode was captured */
  ok: boolean
  code: string
  typed: string
  length: number
  prefixKey: '' | 'Enter' | 'Tab'
  prefixChars: string
  suffix: Terminator
  doubleTerminator: boolean
  medianGapMs: number
  maxGapMs: number
  speed: 'very-fast' | 'fast' | 'medium' | 'slow' | 'human'
  speedLabel: string
  /** settings that make this reader work, to be merged into the saved config */
  proposal: Partial<ScannerConfig>
  findings: Finding[]
}

const SPEED_LABEL: Record<CaptureAnalysis['speed'], string> = {
  'very-fast': 'very fast (typical USB reader)', fast: 'fast (USB reader)', medium: 'medium (cheaper USB / some wireless readers)',
  slow: 'slow (Bluetooth / low-power reader)', human: 'as slow as a person typing'
}

const speedOf = (medianGap: number): CaptureAnalysis['speed'] => (medianGap < 8 ? 'very-fast' : medianGap < 25 ? 'fast' : medianGap < 60 ? 'medium' : medianGap < 160 ? 'slow' : 'human')

/**
 * Work out, from the raw keys of ONE scan, how the reader behaves (suffix, prefix, speed, layout trouble) and which
 * settings make it work. Pure: the Settings wizard collects the events and renders the result.
 */
export function analyzeCapture(events: RawEvent[], current: Pick<ScannerConfig, 'layout' | 'caseMode'> = DEFAULT_SCANNER): CaptureAnalysis {
  const findings: Finding[] = []
  const evs = events.filter((e) => !['Shift', 'Control', 'Alt', 'AltGraph', 'Meta', 'CapsLock', 'NumLock', 'ScrollLock'].includes(e.key) && !(e.alt && !e.ctrl && /^Numpad/.test(e.code ?? '')))
  const isEnter = (e: RawEvent) => e.key === 'Enter' || e.code === 'NumpadEnter'
  const isTab = (e: RawEvent) => e.key === 'Tab'
  const isCtrlLf = (e: RawEvent) => !!e.ctrl && /^[jm]$/i.test(e.key)
  const isTermKey = (e: RawEvent) => isEnter(e) || isTab(e) || isCtrlLf(e)

  let lo = 0
  let hi = evs.length
  // trailing terminators
  const tail: RawEvent[] = []
  while (hi > lo && isTermKey(evs[hi - 1])) tail.unshift(evs[--hi])
  // leading terminator keys (Enter/Tab sent before the code)
  let prefixKey: '' | 'Enter' | 'Tab' = ''
  if (hi - lo >= 3 && (isEnter(evs[lo]) || isTab(evs[lo]))) { prefixKey = isEnter(evs[lo]) ? 'Enter' : 'Tab'; lo++ }
  const body = evs.slice(lo, hi)
  const chars = body.map((e) => ({ e, ch: charOf({ ...e, fromInput: e.kind === 'input' }) })).filter((x): x is { e: RawEvent; ch: string } => x.ch != null)

  const empty = (text: string): CaptureAnalysis => ({
    ok: false, code: '', typed: '', length: 0, prefixKey: '', prefixChars: '', suffix: 'Enter', doubleTerminator: false, medianGapMs: 0, maxGapMs: 0, speed: 'human', speedLabel: '',
    proposal: {}, findings: [{ level: 'warn', text }]
  })
  if (!chars.length) return empty(events.length ? 'Keys arrived but none of them was a letter or digit. See "Reader needs a suffix / layout" below.' : 'No key was received from the reader.')

  // literal prefix characters: leading non-alphanumerics that are not mirrored at the end (Code 39 "*...*" is a start/stop pair, not a prefix)
  let prefixChars = ''
  {
    let n = 0
    while (n < chars.length - 3 && n < 3 && /[^0-9A-Za-z]/.test(chars[n].ch) && !/^(Digit|Numpad)\d$/.test(chars[n].e.code ?? '')) n++ // a symbol on a digit key is a layout effect, not a prefix
    const first = chars[0]?.ch
    const mirrored = first === '*' && chars[chars.length - 1]?.ch === '*'
    if (n > 0 && !mirrored && !(NON_ASCII.test(chars[0].ch))) prefixChars = chars.slice(0, n).map((c) => c.ch).join('')
  }
  const dataChars = chars.slice(prefixChars.length)
  const items = dataChars.map((c) => ({ ch: c.ch, code: c.e.code, shift: !!c.e.shift, caps: !!c.e.caps }))
  const layout = NON_ASCII.test(items.map((i) => i.ch).join('')) ? 'us' : current.layout
  const code = normalizeBurst(items, { layout: layout === 'native' ? 'auto' : layout, caseMode: 'auto' })
  const typed = items.map((i) => i.ch).join('')

  // timing
  const times = chars.map((c) => c.e.t)
  const gaps = times.slice(1).map((t, i) => t - times[i])
  const dataGaps = gaps.slice(prefixChars.length)
  const medianGap = Math.round(median(dataGaps) * 10) / 10
  const maxDataGap = dataGaps.length ? Math.max(...dataGaps) : 0
  const tailGap = tail.length ? tail[0].t - times[times.length - 1] : 0
  const prefixGap = prefixKey ? chars[0].e.t - evs[lo - 1].t : 0
  const worst = Math.max(maxDataGap, tailGap, prefixGap, 0)
  const speed = speedOf(medianGap)

  // suffix
  let suffix: Terminator = 'none'
  if (tail.length) suffix = isTab(tail[0]) ? 'Tab' : 'Enter'
  const doubleTerminator = tail.length >= 2
  if (suffix === 'none') findings.push({ level: 'warn', text: 'The reader did not send Enter or Tab after the code. The app will finish the code after a short pause instead (this works, but Enter is more reliable: scan the "Enter suffix" setting barcode from the reader\'s manual).' })
  else findings.push({ level: 'ok', text: `The reader ends each code with the ${suffix} key.` })
  if (doubleTerminator) findings.push({ level: 'info', text: 'The reader sends two terminator keys (CR+LF). The app ignores the second one so it cannot press Pay by accident.' })
  if (prefixKey) findings.push({ level: 'info', text: `The reader presses ${prefixKey} before the code (prefix). Saved as the prefix.` })
  if (prefixChars) findings.push({ level: 'info', text: `The reader adds "${prefixChars}" before the code. Saved as a prefix so it is removed. If this is part of your barcode, set the prefix to None.` })

  // timing findings
  if (speed === 'human') findings.push({ level: 'warn', text: `The characters arrived ${medianGap} ms apart, which is as slow as typing by hand. Was this scanned, or typed? A scan still works on the billing screen through the always-ready scan box.` })
  else findings.push({ level: 'ok', text: `Speed: ${SPEED_LABEL[speed]}, ${medianGap} ms per key (slowest ${Math.round(worst)} ms).` })
  if (tailGap > 60 && tail.length) findings.push({ level: 'info', text: `The reader waits ${Math.round(tailGap)} ms before the ${suffix} key. The allowed gap was widened to cover it.` })

  // keyboard layout / state problems
  const topRow = body.filter((e) => /^Digit\d$/.test(e.code ?? ''))
  const topNonDigit = topRow.filter((e) => !/^\d$/.test(e.key))
  if (topRow.length && topNonDigit.length === topRow.length && topRow.length >= 2) findings.push({ level: 'warn', text: 'The number keys produced symbols (Shift stuck, or a French-style keyboard layout). The app repairs this automatically, but check Windows has the English (US/India) keyboard selected.' })
  const nonAscii = chars.filter((c) => NON_ASCII.test(c.ch))
  if (nonAscii.length) findings.push({ level: 'warn', text: 'Letters arrived in another script (a Tamil / Hindi / other Windows keyboard layout is active). The app reads the physical keys instead ("US keyboard" mode saved), but switching Windows to English (Alt+Shift) is better.' })
  else {
    const mismatched = chars.filter((c) => /^Key[A-Z]$/.test(c.e.code ?? '') && /[A-Za-z]/.test(c.ch) && usChar(c.e.code, true)!.toLowerCase() !== c.ch.toLowerCase())
    if (mismatched.length) {
      findings.push({ level: 'warn', text: 'Some letters came out different from the key pressed (QWERTZ / AZERTY layout active). "US keyboard" mode saved so the physical keys are used.' })
    }
  }
  if (chars.some((c) => c.e.caps && /[A-Za-z]/.test(c.ch))) findings.push({ level: 'info', text: 'Caps Lock is ON. The app corrects the letter case automatically.' })
  if (body.some((e) => /^Numpad\d$/.test(e.code ?? '') && !/^\d$/.test(e.key))) findings.push({ level: 'info', text: 'The reader uses the numeric keypad while Num Lock is OFF. The app reads the digits anyway; turn Num Lock on to be safe.' })
  if (body.some((e) => e.key === 'Unidentified')) findings.push({ level: 'info', text: 'The reader sends keys without a name ("Unidentified"). They are read through the physical key position.' })
  if (events.some((e) => e.kind === 'input')) findings.push({ level: 'info', text: 'The reader sends characters as Alt+number codes. The app reads those too.' })
  if (chars.length >= 2 && chars[0].ch === '*' && chars[chars.length - 1].ch === '*') findings.push({ level: 'info', text: 'The reader sends Code 39 start/stop stars (*). Product lookup ignores them.' })
  if (/^\][A-Za-z][0-9A-Za-z]/.test(code)) findings.push({ level: 'info', text: 'The reader adds an AIM identifier (like ]E0) in front of the code. Product lookup ignores it.' })
  if (code.length < 3) findings.push({ level: 'warn', text: 'The code is very short. Scan a normal product barcode to calibrate.' })

  const maxGapMs = Math.min(250, Math.max(40, Math.ceil(worst * 2 + 15)))
  const proposal: Partial<ScannerConfig> = {
    enabled: true,
    suffix: suffix === 'none' ? 'none' : suffix,
    prefix: prefixKey || prefixChars,
    maxGapMs,
    minLength: Math.max(1, Math.min(4, code.length)),
    layout: nonAscii.length || findings.some((f) => f.text.startsWith('Some letters came out different')) ? 'us' : 'auto',
    ...(suffix === 'none' ? { idleMs: Math.min(400, Math.max(60, Math.round(maxGapMs * 2))) } : {})
  }
  return { ok: code.length >= 1, code, typed, length: code.length, prefixKey, prefixChars, suffix, doubleTerminator, medianGapMs: medianGap, maxGapMs: Math.round(worst), speed, speedLabel: SPEED_LABEL[speed], proposal, findings }
}

// ------------------------------------------------------------------ shared "a scan just happened" memory (double-Enter guard for the scan boxes)
let lastScanAt = -1e9
/** Record that a scan (any path) was just delivered. */
export function noteScanDelivered(now: number = performance.now()): void {
  lastScanAt = now
}
/** True for an Enter/Tab that arrives in the shadow of a scan (the 2nd half of a CR+LF reader): scan boxes must not treat it as a person. */
export function isStrayTerminator(now: number = performance.now()): boolean {
  return now - lastScanAt < GUARD_MS
}

// ------------------------------------------------------------------ DOM glue
type TextEl = HTMLInputElement | HTMLTextAreaElement
const NON_TEXT_INPUT = ['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'file', 'color', 'image', 'hidden']
const isTextField = (el: EventTarget | null): el is TextEl => {
  if (!el || !(el instanceof HTMLElement)) return false
  if (el instanceof HTMLTextAreaElement) return true
  if (el instanceof HTMLInputElement) return !NON_TEXT_INPUT.includes(el.type)
  return false
}
const isRichEditable = (el: EventTarget | null): el is HTMLElement => el instanceof HTMLElement && el.isContentEditable && !isTextField(el)
/** An input marked data-scanbox owns scanning itself (see scanInput.ts): the global capture stays out of its way. */
export const isScanBox = (el: EventTarget | null): boolean => el instanceof HTMLElement && el.hasAttribute('data-scanbox')
export const isEditableTarget = (el: EventTarget | null): boolean => isTextField(el) || isRichEditable(el) || el instanceof HTMLSelectElement
/** A place where a person types text (a select / button / checkbox is not): inside a dialog only these are left alone. */
const isTextEntry = (el: EventTarget | null): boolean => isTextField(el) || isRichEditable(el)

function setNativeValue(el: TextEl, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}
function insertText(el: TextEl, text: string): void {
  try {
    el.setRangeText(text, el.selectionStart ?? el.value.length, el.selectionEnd ?? el.value.length, 'end')
    el.dispatchEvent(new Event('input', { bubbles: true }))
  } catch {
    setNativeValue(el, el.value + text) // type=number etc. do not support selection
  }
}

/** What to put back after the first character of a (confirmed) scan leaked into a field. */
type Snap =
  | { kind: 'text'; el: TextEl; value: string; selStart: number | null; selEnd: number | null }
  | { kind: 'rich'; el: HTMLElement; text: string }
  | { kind: 'select'; el: HTMLSelectElement; index: number }

function takeSnap(t: EventTarget | null): Snap | null {
  if (isTextField(t)) {
    let ss: number | null = null
    let se: number | null = null
    try { ss = t.selectionStart; se = t.selectionEnd } catch { /* number inputs */ }
    return { kind: 'text', el: t, value: t.value, selStart: ss, selEnd: se }
  }
  if (isRichEditable(t)) return { kind: 'rich', el: t, text: t.textContent ?? '' }
  if (t instanceof HTMLSelectElement) return { kind: 'select', el: t, index: t.selectedIndex }
  return null
}
function restoreSnap(s: Snap): void {
  if (s.kind === 'text') {
    if (s.el.value !== s.value) setNativeValue(s.el, s.value)
    try { s.el.setSelectionRange(s.selStart, s.selEnd) } catch { /* not selectable */ }
  } else if (s.kind === 'rich') {
    if ((s.el.textContent ?? '') !== s.text) {
      s.el.textContent = s.text
      s.el.dispatchEvent(new Event('input', { bubbles: true }))
      try { const r = document.createRange(); r.selectNodeContents(s.el); r.collapse(false); const sel = getSelection(); sel?.removeAllRanges(); sel?.addRange(r) } catch { /* ignore */ }
    }
  } else if (s.el.selectedIndex !== s.index) {
    s.el.selectedIndex = s.index
    s.el.dispatchEvent(new Event('change', { bubbles: true }))
  }
}
function replayInto(s: Snap | null, t: EventTarget | null, text: string): Snap | null {
  const el = s?.kind === 'text' ? s.el : isTextField(t) ? t : null
  if (el) {
    insertText(el, text)
    if (s?.kind === 'text' && s.el === el) return { ...s, value: el.value, selStart: el.selectionStart, selEnd: el.selectionEnd } // the new burst starts after the replayed text
    return s
  }
  if (s?.kind === 'rich') { s.el.textContent = (s.el.textContent ?? '') + text; return { kind: 'rich', el: s.el, text: s.el.textContent } }
  return s
}

export interface AttachOptions {
  config: () => ScannerConfig
  /** `blocked` = delivered while `active()` is false (a dialog is open): do not act on it, just tell the user */
  onScan: (scan: ScanResult, target: EventTarget | null, blocked?: boolean) => void
  /**
   * false = a dialog is open. Typing into the dialog's fields is left alone, but a scan with focus on anything else (a button!)
   * is still recognised and swallowed so the reader's Enter cannot press the focused button (e.g. "Clear bill").
   */
  active?: () => boolean
  /** raw event hook for the test page / wizard (every keydown, and orphan characters, before detection) */
  onRaw?: (ev: RawEvent, e: Event) => void
  /** @deprecated use onRaw. Raw keydown hook. */
  onKey?: (e: KeyboardEvent) => void
}

/** Listen on the whole window (capture phase) so scans work whatever has focus. Returns a detach function. */
export function attachScanner(o: AttachOptions): () => void {
  const det = new ScanDetector(o.config())
  det.learned = loadLearned()
  det.onLearn = saveLearned
  let snap: Snap | null = null
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  let lastTarget: EventTarget | null = null
  let pressPending = false // a keydown that will produce a keypress is in flight: its keypress is NOT an orphan character
  const isBlocked = () => !!o.active && !o.active()
  /**
   * The scan box owns the keyboard (any-timing Enter/Tab path) EXCEPT when the detector must see the keys:
   *  - the reader's prefix is Enter/Tab (the prefix key has to be seen to know a scan starts),
   *  - NumLock is off, so the numpad digits do not type into the box at all (they arrive as End/ArrowDown/...),
   *  - a burst is already being tracked (its terminator must reach the detector too).
   */
  const boxOwns = (e: KeyboardEvent, cfg: ScannerConfig) => {
    if (!isScanBox(e.target)) return false
    if (isKeyName(cfg.prefix)) return false
    if (det.size() > 0) return false
    if (/^Numpad/.test(e.code) && e.key.length > 1 && e.key !== 'Enter' && !e.altKey) return false
    return true
  }

  const finishScan = (scan: ScanResult, target: EventTarget | null) => {
    if (snap) restoreSnap(snap) // remove the character(s) that leaked into the field before we knew it was a scan
    snap = null
    noteScanDelivered()
    o.onScan(scan, target, isBlocked())
  }
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = null
    const c = o.config()
    if (c.suffix !== 'none' || det.size() === 0) return
    idleTimer = setTimeout(() => {
      const r = det.flushIdle(performance.now())
      if (r?.replay) snap = replayInto(snap, lastTarget, r.replay)
      if (r?.scan) finishScan(r.scan, lastTarget)
      if (det.size() === 0) snap = null
    }, c.idleMs + 5)
  }
  /**
   * Gap rule: nobody can be typing when focus is not in an editable element, so a slow reader is allowed there (250 ms). The rule is
   * decided by where the BURST STARTED, never by a later key: a person's last typed character in a field must not be glued to the
   * start of the next scan just because focus moved to the page body in between.
   */
  let burstRelaxed = false
  const relaxedFor = (t: EventTarget | null) => !isEditableTarget(t) && o.config().suffix !== 'none'
  const configFor = (relaxed: boolean): ScannerConfig => {
    const cfg = o.config()
    return relaxed ? { ...cfg, maxGapMs: Math.max(cfg.maxGapMs, 250) } : cfg
  }

  const handle = (ev: KeyIn, t: EventTarget | null, cancel: () => void) => {
    // a key on a different element than the burst's own: the burst was somebody typing into that other element
    if (det.size() > 0 && lastTarget !== t) {
      const ir = det.interrupt()
      if (ir.replay) replayInto(snap, lastTarget, ir.replay)
      snap = null
    }
    det.setConfig(configFor(det.size() === 0 ? relaxedFor(t) : burstRelaxed))
    const startsNew = charOf(ev) != null && isEditableTarget(t)
    const pre = startsNew ? takeSnap(t) : null
    const r = det.feed(ev)
    if (det.size() === 1) burstRelaxed = relaxedFor(t) // the first key of a burst decides its gap rule
    if (det.size() === 1 && pre) snap = pre
    lastTarget = t
    if (r.consume) cancel()
    if (r.replay) snap = replayInto(snap, t, r.replay)
    if (r.scan) finishScan(r.scan, t)
    if (det.size() === 0 && !r.scan) snap = null
    armIdle()
    return r
  }

  const onKeyDown = (e: KeyboardEvent) => {
    const raw: RawEvent = { key: e.key, code: e.code, t: e.timeStamp, shift: e.shiftKey, caps: e.getModifierState?.('CapsLock') ?? false, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey, kind: 'down' }
    o.onRaw?.(raw, e)
    o.onKey?.(e)
    pressPending = false
    const cfg = o.config()
    det.setConfig(cfg)
    if (!cfg.enabled) return
    const t = e.target
    if (isBlocked() && isTextEntry(t)) { det.reset(); snap = null; return } // typing inside a dialog: not our business
    if (boxOwns(e, cfg)) { det.reset(); snap = null; return } // the scan box handles Enter/Tab itself, with any timing
    if (t instanceof HTMLInputElement && t.type === 'password') { det.reset(); return }
    // a held key (auto-repeat) is a person, never a reader: drop any burst in progress and give the swallowed keys back
    if (e.repeat) {
      const r = det.interrupt()
      if (r.replay) snap = replayInto(snap, t, r.replay)
      snap = null
      return
    }
    const ev: KeyIn = { key: e.key, code: e.code, t: e.timeStamp, shift: e.shiftKey, caps: raw.caps, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey }
    const r = handle(ev, t, () => { e.preventDefault(); e.stopImmediatePropagation() })
    const ch = charOf(ev)
    pressPending = !r.consume && ch != null && e.key.length === 1
  }

  // Alt+numpad "Alt codes" (and some HID bridges) deliver the character WITHOUT a usable keydown: it only shows up as keypress/input
  const onKeyPress = (e: KeyboardEvent) => {
    if (e.key.length !== 1 || e.ctrlKey || e.metaKey) return
    if (pressPending) { pressPending = false; return } // the normal keypress that follows a keydown we already looked at
    const cfg = o.config()
    det.setConfig(cfg)
    if (!cfg.enabled) return
    const t = e.target
    if ((isBlocked() && isTextEntry(t)) || (isScanBox(t) && det.size() === 0) || (t instanceof HTMLInputElement && t.type === 'password')) return
    const ev: KeyIn = { key: e.key, code: undefined, t: e.timeStamp, shift: false, caps: false, fromInput: true }
    o.onRaw?.({ ...ev, kind: 'input' }, e)
    handle(ev, t, () => { e.preventDefault(); e.stopImmediatePropagation() })
  }

  window.addEventListener('keydown', onKeyDown, true)
  window.addEventListener('keypress', onKeyPress, true)
  return () => {
    window.removeEventListener('keydown', onKeyDown, true)
    window.removeEventListener('keypress', onKeyPress, true)
    if (idleTimer) clearTimeout(idleTimer)
  }
}

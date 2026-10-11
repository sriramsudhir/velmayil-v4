import { describe, expect, it } from 'vitest'
import {
  analyzeCapture, charOf, DEFAULT_SCANNER, isStrayTerminator, noteScanDelivered, normalizeBurst, ScanDetector, simulateKeys, visibleCode,
  type KeyIn, type RawEvent
} from '../../src/renderer/lib/scanner'
import { BoxRecorder, scanBoxKey } from '../../src/renderer/lib/scanInput'
import { HidAssembler, parseHidPosReport } from '../../src/renderer/lib/hidScanner'
import { classifyDevices, parseDeviceJson } from '../../src/main/modules/pos/scannerDevices'

const feedAll = (d: ScanDetector, events: KeyIn[]) => {
  const scans: string[] = []
  const consumed: boolean[] = []
  for (const e of events) {
    const r = d.feed(e)
    consumed.push(r.consume)
    if (r.scan) scans.push(r.scan.code)
  }
  return { scans, consumed }
}
const bytes = (...n: number[]) => Uint8Array.from(n)
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0))

describe('adaptive timing: the limit follows the reader (never stricter than configured)', () => {
  it('learns a slower reader from its first scans and then tolerates its jitter', () => {
    const d = new ScanDetector({ ...DEFAULT_SCANNER })
    // three scans whose slowest gap is 30 ms (below the 40 ms default) teach the detector
    let t = 1000
    for (let i = 0; i < 3; i++) { feedAll(d, simulateKeys('890123456789' + i, { start: t, gap: 30 })); t += 2000 }
    expect(d.learned).toEqual([30, 30, 30])
    expect(d.effectiveMaxGap()).toBe(85)
    // a scan that now contains a 70 ms hiccup is still a scan
    const jitter = simulateKeys('8901234567890', { start: t, gap: 20 })
    jitter.slice(6).forEach((e) => { e.t += 50 })
    expect(feedAll(d, jitter).scans).toEqual(['8901234567890'])
    // a fresh detector (or adaptive off) rejects exactly the same burst
    const fresh = new ScanDetector({ ...DEFAULT_SCANNER })
    // ... and a detector that does not know the reader refuses it AND refuses the tail as a code of its own (wrong product otherwise)
    expect(feedAll(fresh, jitter).scans).toEqual([])
    expect(feedAll(new ScanDetector({ ...DEFAULT_SCANNER, adaptive: false }), jitter).scans).toEqual([])
    const off = new ScanDetector({ ...DEFAULT_SCANNER, adaptive: false })
    for (let i = 0; i < 3; i++) feedAll(off, simulateKeys('890123456789' + i, { start: 1000 + i * 2000, gap: 30 }))
    expect(off.effectiveMaxGap()).toBe(40)
  })
  it('the configured gap is a floor: a very fast reader never makes the detector stricter', () => {
    const d = new ScanDetector({ ...DEFAULT_SCANNER, maxGapMs: 60 })
    for (let i = 0; i < 4; i++) feedAll(d, simulateKeys('890123456789' + i, { start: 1000 + i * 1000, gap: 1 }))
    expect(d.effectiveMaxGap()).toBe(60)
  })
})

describe('CR+LF readers and the second terminator', () => {
  it('Enter+Enter and Enter+Ctrl+J produce ONE scan; the stray key is swallowed, a later human Enter is not', () => {
    for (const extra of ['Enter', 'ctrlJ'] as const) {
      const d = new ScanDetector({ ...DEFAULT_SCANNER })
      const ev = simulateKeys('8901234567890', { gap: 3, extraTerminator: extra })
      const r = feedAll(d, ev)
      expect(r.scans, extra).toEqual(['8901234567890'])
      expect(r.consumed[r.consumed.length - 1], extra).toBe(true) // the stray one never reaches a focused button / the scan box
      const human = d.feed({ key: 'Enter', t: ev[ev.length - 1].t + 600 })
      expect(human.consume).toBe(false)
    }
  })
  it('the shared guard used by the scan boxes', () => {
    noteScanDelivered(5000)
    expect(isStrayTerminator(5100)).toBe(true)
    expect(isStrayTerminator(5600)).toBe(false)
    noteScanDelivered(9000)
    expect(scanBoxKey({ key: 'Enter' }, '', 9100)).toBe('ignore')
    expect(scanBoxKey({ key: 'j', ctrlKey: true }, '', 9100)).toBe('ignore')
    expect(scanBoxKey({ key: 'Enter' }, '', 9800)).toBe('submit') // a person pressing Enter on an empty box later = pay
    expect(scanBoxKey({ key: 'Enter' }, '8901234567890', 9100)).toBe('submit')
    expect(scanBoxKey({ key: 'Tab' }, '8901234567890', 9100, true)).toBe('submit') // default suffix accepts Tab after machine-fast input
    expect(scanBoxKey({ key: 'Tab' }, 'rocket', 9100, false)).toBeNull() // a person tabbing out of the box
    expect(scanBoxKey({ key: 'Tab' }, '', 9100, true)).toBeNull()
    expect(scanBoxKey({ key: 'a' }, 'x', 9100)).toBeNull()
  })
})

describe('odd key events: Unidentified, non-US layouts, Alt codes', () => {
  it('Unidentified keys are read through their physical key', () => {
    const ev: KeyIn[] = '4006381'.split('').map((c, i) => ({ key: 'Unidentified', code: `Digit${c}`, t: 1000 + i * 3 }))
    ev.push({ key: 'Enter', t: 1030 })
    const d = new ScanDetector({ ...DEFAULT_SCANNER })
    expect(feedAll(d, ev).scans).toEqual(['4006381'])
    expect(charOf({ key: 'Unidentified', code: 'KeyA', shift: true, t: 0 })).toBe('A')
    expect(charOf({ key: 'Unidentified', code: 'ShiftLeft', t: 0 })).toBeNull()
    expect(charOf({ key: 'Process', code: 'Digit5', t: 0 })).toBe('5') // IME composing
  })
  it('Tamil / Hindi Windows layout: letters arrive as other scripts but the physical key tells the code', () => {
    const tamil: KeyIn[] = [
      { key: 'அ', code: 'KeyA', t: 1000 }, { key: 'ஆ', code: 'KeyB', t: 1004 }, { key: 'க்ஷ', code: 'KeyX', t: 1008 }, // one key => two code points
      { key: '1', code: 'Digit1', t: 1012 }, { key: '2', code: 'Digit2', t: 1016 }, { key: 'Enter', t: 1020 }
    ]
    const d = new ScanDetector({ ...DEFAULT_SCANNER })
    expect(feedAll(d, tamil).scans).toEqual(['abx12'])
    // capital letters on a Tamil layout keep their Shift
    expect(normalizeBurst([{ ch: 'ஆ', code: 'KeyB', shift: true }, { ch: '1', code: 'Digit1' }], { layout: 'auto', caseMode: 'auto' })).toBe('B1')
    // a person typing Tamil (slow) is untouched by the detector
    const slow = tamil.map((e, i) => ({ ...e, t: 1000 + i * 200 }))
    expect(feedAll(new ScanDetector({ ...DEFAULT_SCANNER }), slow).scans).toEqual([])
  })
  it('a lone real symbol is never "repaired" into a digit', () => {
    expect(normalizeBurst([{ ch: 'A', code: 'KeyA', shift: true }, { ch: 'B', code: 'KeyB', shift: true }, { ch: '#', code: 'Digit3', shift: true }], { layout: 'auto', caseMode: 'auto' })).toBe('AB#')
    // ... but two shifted digit keys with no real digit are (Shift latched / AZERTY)
    expect(normalizeBurst([{ ch: '&', code: 'Digit1' }, { ch: 'é', code: 'Digit2' }], { layout: 'auto', caseMode: 'auto' })).toBe('12')
  })
  it('Alt+numpad "Alt codes": the numpad keydowns are ignored and the composed characters (keypress only) form the scan', () => {
    const ev: KeyIn[] = []
    let t = 1000
    for (const [ch, digits] of [['A', ['6', '5']], ['B', ['6', '6']], ['1', ['4', '9']], ['2', ['5', '0']]] as const) {
      ev.push({ key: 'Alt', t, alt: true })
      for (const dgt of digits) { ev.push({ key: dgt, code: `Numpad${dgt}`, t: (t += 1), alt: true }) }
      ev.push({ key: ch, t: (t += 1), fromInput: true })
      t += 2
    }
    ev.push({ key: 'Enter', t })
    const d = new ScanDetector({ ...DEFAULT_SCANNER })
    const r = feedAll(d, ev)
    expect(r.scans).toEqual(['AB12'])
    // the Alt+numpad keydowns must not be swallowed (the OS needs them to compose the character)
    expect(ev.every((e, i) => !(e.alt && /^Numpad/.test(e.code ?? '')) || r.consumed[i] === false)).toBe(true)
  })
  it('shows invisible characters in a not-found message', () => {
    expect(visibleCode('89012\r\n')).toBe('89012<CR><LF>')
    expect(visibleCode('A\u001dB C')).toBe('A<GS>B␣C')
    expect(visibleCode('\u0002123\u0003')).toBe('<STX>123<ETX>')
  })
})

describe('"Detect my reader" analysis', () => {
  const raw = (events: KeyIn[]): RawEvent[] => events.map((e) => ({ ...e, kind: e.fromInput ? 'input' : 'down' }))

  it('fast USB reader with an Enter suffix', () => {
    const a = analyzeCapture(raw(simulateKeys('8901234567890', { gap: 3 })))
    expect(a).toMatchObject({ ok: true, code: '8901234567890', suffix: 'Enter', prefixKey: '', prefixChars: '', speed: 'very-fast', doubleTerminator: false })
    expect(a.proposal).toMatchObject({ suffix: 'Enter', prefix: '', maxGapMs: 40, layout: 'auto' })
  })
  it('Tab suffix and a Tab prefix key', () => {
    const t = analyzeCapture(raw(simulateKeys('4006381333931', { gap: 8, terminator: 'Tab' })))
    expect(t.suffix).toBe('Tab')
    expect(t.proposal.suffix).toBe('Tab')
    const p = analyzeCapture(raw(simulateKeys('4006381333931', { gap: 8, prefixKey: 'Tab' })))
    expect(p).toMatchObject({ prefixKey: 'Tab', code: '4006381333931', suffix: 'Enter' })
    expect(p.proposal.prefix).toBe('Tab')
  })
  it('no suffix => pause mode; CR+LF is noticed', () => {
    const n = analyzeCapture(raw(simulateKeys('8901234567890', { gap: 5, terminator: null })))
    expect(n.suffix).toBe('none')
    expect(n.proposal).toMatchObject({ suffix: 'none' })
    expect(n.proposal.idleMs).toBeGreaterThanOrEqual(60)
    const crlf = analyzeCapture(raw(simulateKeys('8901234567890', { gap: 5, extraTerminator: 'Enter' })))
    expect(crlf.doubleTerminator).toBe(true)
    expect(crlf.findings.some((f) => /CR\+LF/.test(f.text))).toBe(true)
  })
  it('literal prefix character; Code 39 stars are not a prefix', () => {
    const a = analyzeCapture(raw(simulateKeys('~8901234567890', { gap: 5 })))
    expect(a.prefixChars).toBe('~')
    expect(a.code).toBe('8901234567890')
    expect(a.proposal.prefix).toBe('~')
    const star = analyzeCapture(raw([...'*ABC123*'].map((c, i): KeyIn => ({ key: c, code: /[A-Z]/.test(c) ? `Key${c}` : /\d/.test(c) ? `Digit${c}` : undefined, shift: c === '*' || /[A-Z]/.test(c), t: 1000 + i * 4 })).concat([{ key: 'Enter', t: 1100 }])))
    expect(star.prefixChars).toBe('')
    expect(star.code).toBe('*ABC123*')
  })
  it('slow Bluetooth reader widens the allowed gap; human-speed input is flagged', () => {
    const bt = analyzeCapture(raw(simulateKeys('8901234567890', { gap: 90 })))
    expect(bt.speed).toBe('slow')
    expect(bt.proposal.maxGapMs).toBeGreaterThanOrEqual(190)
    const human = analyzeCapture(raw(simulateKeys('8901234567890', { gap: 250 })))
    expect(human.speed).toBe('human')
    expect(human.findings.some((f) => f.level === 'warn' && /typing by hand|typed/.test(f.text))).toBe(true)
  })
  it('a slow gap before the terminator is included in the proposal', () => {
    const ev = simulateKeys('8901234567890', { gap: 4 })
    ev[ev.length - 1].t += 140
    const a = analyzeCapture(raw(ev))
    expect(a.proposal.maxGapMs).toBe(250)
    expect(a.findings.some((f) => /waits 144 ms/.test(f.text))).toBe(true)
  })
  it('layout / caps lock trouble is explained and the right layout saved', () => {
    const caps = analyzeCapture(raw(simulateKeys('ABC123', { gap: 4, capsLock: true })))
    expect(caps.code).toBe('ABC123')
    expect(caps.findings.some((f) => /Caps Lock/.test(f.text))).toBe(true)
    const tamil: KeyIn[] = [{ key: 'அ', code: 'KeyA', t: 1000 }, { key: 'ஆ', code: 'KeyB', t: 1004 }, { key: '1', code: 'Digit1', t: 1008 }, { key: '2', code: 'Digit2', t: 1012 }, { key: 'Enter', t: 1016 }]
    const ta = analyzeCapture(raw(tamil))
    expect(ta.code).toBe('ab12')
    expect(ta.proposal.layout).toBe('us')
    expect(ta.findings.some((f) => /Tamil/.test(f.text))).toBe(true)
    const azerty: KeyIn[] = ['&', 'é', '"', "'", '(', '-'].map((key, i) => ({ key, code: `Digit${i + 1}`, t: 1000 + i * 4 }))
    const az = analyzeCapture(raw([...azerty, { key: 'Enter', t: 1030 }]))
    expect(az.code).toBe('123456')
    expect(az.findings.some((f) => /number keys produced symbols/.test(f.text))).toBe(true)
  })
  it('Alt-code readers and nothing-heard', () => {
    const ev: KeyIn[] = []
    let t = 1000
    for (const ch of 'AB12') { ev.push({ key: 'Alt', t, alt: true }); ev.push({ key: ch, t: (t += 2), fromInput: true }); t += 3 }
    ev.push({ key: 'Enter', t })
    const a = analyzeCapture(raw(ev))
    expect(a.code).toBe('AB12')
    expect(a.findings.some((f) => /Alt\+number/.test(f.text))).toBe(true)
    const none = analyzeCapture([])
    expect(none.ok).toBe(false)
    expect(none.findings[0].text).toMatch(/No key was received/)
  })
})

describe('scan box recorder (primary path): any timing, layout repair only for machine-fast input', () => {
  const press = (rec: BoxRecorder, key: string, code: string, t: number, extra: Record<string, unknown> = {}) => rec.key({ key, code, timeStamp: t, ...extra })
  const cfg = { layout: 'auto' as const, caseMode: 'auto' as const, minLength: 3 }

  it('plain digits at any speed pass through unchanged and report their timing', () => {
    for (const gap of [2, 20, 90, 400]) {
      const rec = new BoxRecorder()
      '8901234567890'.split('').forEach((c, i) => press(rec, c, `Digit${c}`, 1000 + i * gap))
      const r = rec.take('8901234567890', cfg)
      expect(r.code).toBe('8901234567890')
      expect(r.repaired).toBe(false)
      expect(r.timing?.avgGapMs).toBe(gap)
    }
  })
  it('AZERTY / Tamil layout output from a fast reader is repaired; a person typing Tamil is not', () => {
    const rec = new BoxRecorder()
    ;['&', 'é', '"', "'", '('].forEach((c, i) => press(rec, c, `Digit${i + 1}`, 1000 + i * 4))
    expect(rec.take('&é"\'(', cfg)).toMatchObject({ code: '12345', repaired: true })
    const tamil = new BoxRecorder()
    ;[['அ', 'KeyA'], ['ஆ', 'KeyB'], ['இ', 'KeyC']].forEach(([c, k], i) => press(tamil, c, k, 1000 + i * 4))
    expect(tamil.take('அஆஇ', cfg)).toMatchObject({ code: 'abc', repaired: true })
    const person = new BoxRecorder()
    ;[['அ', 'KeyA'], ['ஆ', 'KeyB'], ['இ', 'KeyC']].forEach(([c, k], i) => press(person, c, k, 1000 + i * 350))
    expect(person.take('அஆஇ', cfg)).toMatchObject({ code: 'அஆஇ', repaired: false })
  })
  it('editing or pasting disables the repair (text is no longer just the typed keys)', () => {
    const rec = new BoxRecorder()
    press(rec, '&', 'Digit1', 1000); press(rec, 'é', 'Digit2', 1004); press(rec, 'Backspace', 'Backspace', 1008); press(rec, 'é', 'Digit2', 1012)
    expect(rec.take('&é', cfg).repaired).toBe(false)
  })
  it('Caps Lock inversion fixed from the Shift state', () => {
    const rec = new BoxRecorder()
    // reader wants "Ab1" with Caps Lock ON: sends Shift+A (-> 'a'), b (-> 'B'), 1
    press(rec, 'a', 'KeyA', 1000, { shiftKey: true, getModifierState: () => true })
    press(rec, 'B', 'KeyB', 1004, { getModifierState: () => true })
    press(rec, '1', 'Digit1', 1008)
    expect(rec.take('aB1', cfg).code).toBe('Ab1')
  })
})

describe('WebHID reports', () => {
  it('length-prefixed report: [len][symbology x3][data][padding]', () => {
    const r = parseHidPosReport(bytes(13, 0x6a, 0, 0, ...ascii('8901234567890'), ...new Array(40).fill(0)))
    expect(r).toEqual({ text: '8901234567890', more: false })
  })
  it('one-byte symbology, different padding, and the trailing "more data" flag', () => {
    expect(parseHidPosReport(bytes(5, 0x41, ...ascii('ABC12'), 0, 0, 0))?.text).toBe('ABC12')
    const first = parseHidPosReport(bytes(10, 1, 2, 3, ...ascii('0123456789'), 0, 0, 1))
    expect(first).toEqual({ text: '0123456789', more: true })
  })
  it('falls back to the longest printable run when the length byte does not fit', () => {
    expect(parseHidPosReport(bytes(0x40, 0, 0, ...ascii('SKU-77'), 0, 0))?.text).toBe('SKU-77')
    expect(parseHidPosReport(bytes(...ascii('4006381333931'), 13))?.text).toBe('4006381333931') // plain ASCII + CR
    expect(parseHidPosReport(bytes(0, 0, 0, 0))).toBeNull()
  })
  it('assembles multi-report codes and strips GS/CR', () => {
    const a = new HidAssembler()
    expect(a.push(bytes(6, 0, 0, 0, ...ascii('123456'), 0, 1))).toBeNull() // more follows
    expect(a.pending()).toBe(6)
    expect(a.push(bytes(3, 0, 0, 0, ...ascii('789'), 0, 0))).toBe('123456789')
    expect(a.push(bytes(4, 0, 0, 0, ...ascii('AB'), 0x1d, ...ascii('C'), 0))).toBe('ABC')
  })
})

describe('Windows device report (what the owner sees when the reader is not detected)', () => {
  const sample = JSON.stringify([
    { Name: 'Unknown USB Device (Device Descriptor Request Failed)', PNPDeviceID: 'USB\\VID_0000&PID_0002\\5&2B1A6D0D&0&2', PNPClass: 'USB', Status: 'Error', ConfigManagerErrorCode: 43 },
    { Name: 'USB Input Device', PNPDeviceID: 'HID\\VID_0483&PID_0011\\6&9A2B&0&0000', PNPClass: 'HIDClass', Status: 'OK', ConfigManagerErrorCode: 0 },
    { Name: 'USB Root Hub (USB 3.0)', PNPDeviceID: 'USB\\ROOT_HUB30\\4&1', PNPClass: 'USB', Status: 'OK', ConfigManagerErrorCode: 0 },
    { Name: 'Honeywell Voyager 1250g', PNPDeviceID: 'USB\\VID_0C2E&PID_0B61\\ABC', PNPClass: 'USB', Status: 'OK', ConfigManagerErrorCode: 0 }
  ])
  it('finds the failed enumeration and the reader-like devices', () => {
    const devices = parseDeviceJson(sample)
    expect(devices).toHaveLength(4)
    expect(devices[0]).toMatchObject({ problemCode: 43, vid: '0000', pid: '0002' })
    const c = classifyDevices(devices)
    expect(c.problems.map((d) => d.problemCode)).toEqual([43])
    expect(c.readers.map((d) => d.vid).sort()).toEqual(['0483', '0C2E'])
  })
  it('a single object (PowerShell prints one device without an array) and garbage', () => {
    expect(parseDeviceJson(JSON.stringify({ Name: 'x', PNPDeviceID: 'USB\\VID_1A86&PID_7523\\1', PNPClass: 'Ports', Status: 'OK', ConfigManagerErrorCode: 0 }))).toHaveLength(1)
    expect(parseDeviceJson('')).toEqual([])
    expect(parseDeviceJson('not json')).toEqual([])
  })
})

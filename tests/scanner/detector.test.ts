import { describe, expect, it } from 'vitest'
import { DEFAULT_SCANNER, normalizeBurst, normalizeScannerConfig, runDetector, simulateKeys, usChar, type KeyIn } from '../../src/renderer/lib/scanner'
import { SerialLineSplitter } from '../../src/renderer/lib/serialScanner'

const codes = (events: KeyIn[], cfg = {}, endAt?: number) => runDetector(events, cfg, endAt).scans.map((s) => s.code)

describe('keyboard-wedge scan detector', () => {
  it('detects a fast burst ending with Enter and swallows all but the first key', () => {
    const ev = simulateKeys('8901234567890', { gap: 5 })
    const r = runDetector(ev)
    expect(r.scans).toHaveLength(1)
    expect(r.scans[0]).toMatchObject({ code: '8901234567890', typed: '8901234567890', length: 13, terminator: 'Enter' })
    expect(r.scans[0].durationMs).toBe(60)
    expect(r.scans[0].avgGapMs).toBe(5)
    // first char leaks (cannot be known yet), the rest and the terminator are swallowed
    expect(r.consumed[0]).toBe(false)
    expect(r.consumed.slice(1).every(Boolean)).toBe(true)
    expect(r.replays).toEqual([])
  })

  it('ignores human typing: slow keys are never a scan and never swallowed', () => {
    const ev = simulateKeys('8901234567890', { gap: 120 })
    const r = runDetector(ev)
    expect(r.scans).toEqual([])
    expect(r.consumed.every((c) => !c)).toBe(true)
    expect(r.replays).toEqual([])
  })

  it('handles typing interleaved with scans (typing before, between and after)', () => {
    const human1 = simulateKeys('ab', { start: 1000, gap: 180, terminator: null })
    const scan1 = simulateKeys('5012345678900', { start: 3000, gap: 8 })
    const human2 = simulateKeys('qty', { start: 6000, gap: 200, terminator: 'Enter' })
    const scan2 = simulateKeys('ABC-1234', { start: 9000, gap: 12, terminator: 'Enter' })
    const r = runDetector([...human1, ...scan1, ...human2, ...scan2])
    expect(r.scans.map((s) => s.code)).toEqual(['5012345678900', 'ABC-1234'])
    // none of the human keys were swallowed
    expect(r.consumed.slice(0, human1.length).every((c) => !c)).toBe(true)
  })

  it('a person typing right before a scan does not poison it (stale char is dropped, scan still found)', () => {
    const ev = [...simulateKeys('9', { start: 100, terminator: null }), ...simulateKeys('4006381333931', { start: 900, gap: 6 })]
    expect(codes(ev)).toEqual(['4006381333931'])
  })

  it('a partial scan (shorter than the minimum) is typing: nothing detected and the swallowed keys are replayed', () => {
    const ev = simulateKeys('ABC', { gap: 5 }) // 3 chars + Enter, minLength 4
    const r = runDetector(ev, { minLength: 4 })
    expect(r.scans).toEqual([])
    expect(r.replays).toEqual(['BC']) // first char was never swallowed
    expect(r.consumed[ev.length - 1]).toBe(false) // Enter goes through
  })

  it('a burst that turns slow midway is replayed, not lost', () => {
    const fast = simulateKeys('1234', { start: 1000, gap: 5, terminator: null })
    const late = simulateKeys('5', { start: 1500, gap: 5, terminator: null })
    const r = runDetector([...fast, ...late], {}, 5000)
    expect(r.scans).toEqual([])
    expect(r.replays).toEqual(['234'])
  })

  it('caps lock: letters keep the case the scanner meant (Shift sent explicitly)', () => {
    const ev = simulateKeys('ABC123xyz', { gap: 4, capsLock: true })
    expect(codes(ev)).toEqual(['ABC123xyz'])
    // without the repair the OS-level case is inverted
    expect(codes(ev, { layout: 'native' })).toEqual(['abc123XYZ'])
    // forced case modes
    expect(codes(simulateKeys('ab12Cd', { gap: 4 }), { caseMode: 'upper' })).toEqual(['AB12CD'])
    expect(codes(simulateKeys('AB12Cd', { gap: 4 }), { caseMode: 'lower' })).toEqual(['ab12cd'])
  })

  it('shifted digits and AZERTY-style top row are repaired to digits; numpad digits work with NumLock off', () => {
    const azerty = ['&', 'é', '"', "'", '(', '-', 'è', '_'].map((key, i): KeyIn => ({ key, code: `Digit${i + 1}`, t: 1000 + i * 4 }))
    expect(codes([...azerty, { key: 'Enter', t: 1040 }])).toEqual(['12345678'])
    const stuckShift = '!@#$%^&*'.split('').map((key, i): KeyIn => ({ key, code: `Digit${i + 1}`, shift: true, t: 1000 + i * 4 }))
    expect(codes([...stuckShift, { key: 'Enter', t: 1040 }])).toEqual(['12345678'])
    const numpadOff = ['End', 'ArrowDown', 'PageDown', 'ArrowLeft', 'Clear', 'ArrowRight'].map((key, i): KeyIn => ({ key, code: `Numpad${i + 1}`, t: 1000 + i * 4 }))
    expect(codes([...numpadOff, { key: 'Enter', code: 'NumpadEnter', t: 1030 }])).toEqual(['123456'])
    const numpadOn = '4006381333931'.split('').map((key, i): KeyIn => ({ key, code: `Numpad${key}`, t: 1000 + i * 4 }))
    expect(codes([...numpadOn, { key: 'Enter', code: 'NumpadEnter', t: 1060 }])).toEqual(['4006381333931'])
  })

  it('does not "repair" real symbols when some digit keys really produced digits', () => {
    const mixed: KeyIn[] = [
      { key: 'A', code: 'KeyA', shift: true, t: 1000 }, { key: '1', code: 'Digit1', t: 1004 }, { key: '#', code: 'Digit3', shift: true, t: 1008 }, { key: '2', code: 'Digit2', t: 1012 }, { key: 'Enter', t: 1016 }
    ]
    expect(codes(mixed)).toEqual(['A1#2'])
  })

  it('US layout mode trusts physical keys (scanner programmed for a US keyboard on a foreign layout)', () => {
    expect(usChar('KeyQ', false)).toBe('q')
    expect(usChar('Digit1', true)).toBe('!')
    const onAzerty: KeyIn[] = [{ key: 'a', code: 'KeyQ', t: 1000 }, { key: 'z', code: 'KeyW', t: 1004 }, { key: 'e', code: 'KeyE', t: 1008 }, { key: '&', code: 'Digit1', t: 1012 }, { key: 'Enter', t: 1016 }]
    expect(codes(onAzerty, { layout: 'us' })).toEqual(['qwe1'])
    expect(normalizeBurst([{ ch: 'a', code: 'KeyQ' }], { layout: 'us', caseMode: 'auto' })).toBe('q')
  })

  it('configurable prefix (key or literal characters) and suffix', () => {
    expect(codes(simulateKeys('8901234567890', { gap: 5, prefixKey: 'Tab' }), { prefix: 'Tab' })).toEqual(['8901234567890'])
    // without the prefix key, the same burst is not a scan when a prefix is required
    expect(codes(simulateKeys('8901234567890', { gap: 5 }), { prefix: 'Tab' })).toEqual([])
    expect(codes(simulateKeys('~8901234567', { gap: 5 }), { prefix: '~' })).toEqual(['8901234567'])
    expect(codes(simulateKeys('8901234567', { gap: 5 }), { prefix: '~' })).toEqual([])
    // suffix Tab: Enter alone does not end it, Tab does
    expect(codes(simulateKeys('8901234567', { gap: 5, terminator: 'Tab' }), { suffix: 'Tab' })).toEqual(['8901234567'])
    expect(codes(simulateKeys('8901234567', { gap: 5, terminator: 'Enter' }), { suffix: 'Tab' })).toEqual([])
    expect(codes(simulateKeys('8901234567', { gap: 5, terminator: 'Tab' }), { suffix: 'any' })).toEqual(['8901234567'])
    expect(codes(simulateKeys('8901234567', { gap: 5, terminator: 'Tab' }))).toEqual(['8901234567']) // default accepts Enter OR Tab
    expect(codes(simulateKeys('8901234567', { gap: 5, terminator: 'Tab' }), { suffix: 'Enter' })).toEqual([]) // strict Enter
  })

  it('scanners with no suffix are finished by a pause', () => {
    const ev = simulateKeys('8901234567890', { gap: 5, terminator: null })
    const r = runDetector(ev, { suffix: 'none' })
    expect(r.scans).toHaveLength(1)
    expect(r.scans[0]).toMatchObject({ code: '8901234567890', terminator: 'idle' })
    // the same stream with suffix Enter expected is just an unfinished burst
    expect(runDetector(ev, { suffix: 'Enter' }).scans).toEqual([])
  })

  it('timing thresholds are configurable (slow Bluetooth scanner)', () => {
    const slow = simulateKeys('8901234567890', { gap: 60 })
    expect(codes(slow)).toEqual([])
    expect(codes(slow, { maxGapMs: 100 })).toEqual(['8901234567890'])
    expect(codes(simulateKeys('12', { gap: 5 }), { minLength: 2 })).toEqual(['12'])
  })

  it('two scans back to back and a disabled detector', () => {
    const a = simulateKeys('1111111111111', { start: 1000, gap: 3 })
    const b = simulateKeys('2222222222222', { start: 1000 + 13 * 3 + 40, gap: 3 })
    expect(codes([...a, ...b])).toEqual(['1111111111111', '2222222222222'])
    expect(codes(a, { enabled: false })).toEqual([])
  })

  it('shortcuts and navigation keys reset the burst', () => {
    const ev: KeyIn[] = [...simulateKeys('12345', { gap: 4, terminator: null }), { key: 'ArrowLeft', t: 1030 }, { key: 'Enter', t: 1034 }]
    expect(codes(ev)).toEqual([])
    const ctrl: KeyIn[] = [{ key: '1', code: 'Digit1', t: 1000 }, { key: 'v', code: 'KeyV', ctrl: true, t: 1004 }, { key: '2', code: 'Digit2', t: 1008 }, { key: '3', code: 'Digit3', t: 1012 }, { key: 'Enter', t: 1020 }]
    expect(codes(ctrl)).toEqual([])
  })

  it('symbologies: Code 39 / Code 128 / QR-ish text with punctuation survive intact', () => {
    for (const text of ['ABC-123.45', 'SKU/RED 42', 'https://x.in/p?id=7']) {
      const events: KeyIn[] = [...text].map((c, i) => ({ key: c, code: /[a-z]/i.test(c) ? `Key${c.toUpperCase()}` : /\d/.test(c) ? `Digit${c}` : undefined, shift: /[A-Z:?]/.test(c), t: 1000 + i * 3 }))
      events.push({ key: 'Enter', t: 1000 + text.length * 3 })
      expect(codes(events, { layout: 'native' })).toEqual([text])
    }
  })

  it('normalizes a stored config safely', () => {
    expect(normalizeScannerConfig(null)).toEqual(DEFAULT_SCANNER)
    expect(normalizeScannerConfig({ maxGapMs: 99999, minLength: -3, suffix: 'x', serialBaud: 123, prefix: 'abcdefghijk' })).toMatchObject({ maxGapMs: 300, minLength: 1, suffix: 'any', serialBaud: 9600, prefix: 'abcdef' })
  })
})

describe('serial line splitter', () => {
  it('splits CR/LF terminated codes across chunks and strips control characters', () => {
    const s = new SerialLineSplitter()
    expect(s.push('89012')).toEqual([])
    expect(s.push('34567890\r\n4006381')).toEqual(['8901234567890'])
    expect(s.push('333931\r')).toEqual(['4006381333931'])
    expect(s.push('\u0002ABC\u0003')).toEqual(['ABC'])
    expect(s.push('NOSUFFIX')).toEqual([])
    expect(s.flush()).toBe('NOSUFFIX')
    expect(s.flush()).toBeNull()
  })
})

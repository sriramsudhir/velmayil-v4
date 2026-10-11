import { beforeEach, describe, expect, it } from 'vitest'
import { createTestApp } from '../helpers'
import type { App } from '../../src/main/core/app'
import { codeCandidates, scanCandidates } from '../../src/main/modules/pos/codes'
import { DEFAULT_SCANNER, ScanDetector, runDetector, simulateKeys } from '../../src/renderer/lib/scanner'
import { BoxRecorder } from '../../src/renderer/lib/scanInput'
import { SerialLineSplitter } from '../../src/renderer/lib/serialScanner'
import { stripScanDecorations, stripScanFraming } from '../../src/shared/scanCode'
import { parseUnitCode } from '../../src/shared/scanList'

let app: App
/** Raw insert (no catalog validation), so odd legacy data can be set up. Returns the variant id. */
function product(name: string, barcode: string | null, o: { sku?: string; aliases?: string[]; active?: boolean } = {}): number {
  const p = app.db.run('INSERT INTO products(uuid,name,tax_rate_bp,hsn,track_stock,active) VALUES (?,?,?,?,1,?)', app.uuid(), name, 0, '3604', o.active === false ? 0 : 1)
  const v = app.db.run('INSERT INTO product_variants(uuid,product_id,sku,barcode,price,mrp,cost) VALUES (?,?,?,?,?,?,?)', app.uuid(), p.lastId, o.sku ?? 'SKU-' + name, barcode, 1000, 1000, 500)
  for (const a of o.aliases ?? []) app.db.run('INSERT INTO variant_barcodes(barcode,variant_id) VALUES (?,?)', a, v.lastId)
  return v.lastId
}
const scan = (code: string) => app.lookup.byScan(code)?.displayName
const ambiguous = (code: string) => {
  try {
    app.lookup.byScan(code)
  } catch (e) {
    return e as { code: string; message: string; details: { code: string; matches: { name: string; code: string }[] } }
  }
  throw new Error(`"${code}" was expected to be ambiguous`)
}

beforeEach(() => {
  app = createTestApp()
})

describe('candidate tiers (pure)', () => {
  it('the scanned text is tier 0, re-spellings of the same symbol tier 1, repair guesses tier 2', () => {
    const tiers = (s: string) => Object.fromEntries(scanCandidates(s).map((c) => [c.code, c.tier]))
    expect(scanCandidates(' 4006381333931\r\n')[0]).toEqual({ code: '4006381333931', tier: 0 })
    expect(tiers('012345678905')).toMatchObject({ '012345678905': 0, '0012345678905': 1, '01234567890': 2 })
    expect(tiers('400638133393')).toMatchObject({ '0400638133393': 1, '4006381333931': 2, '40063813339': 2 })
    expect(tiers('0012345678905')).toMatchObject({ '012345678905': 1, '001234567890': 2, '12345678905': 2 })
    expect(tiers('00012345678905')).toMatchObject({ '0012345678905': 1, '012345678905': 1 })
    expect(tiers(']E04006381333931')).toMatchObject({ '4006381333931': 1 })
    expect(tiers('*ABC123*')).toMatchObject({ ABC123: 1, abc123: 1 })
    expect(tiers('04252614')).toMatchObject({ '042100005264': 1, '0000004252614': 1 })
    expect(tiers('1234567')).toMatchObject({ '12345670': 2 })
    // the list itself (order) is what it always was
    expect(codeCandidates('ABC-123')).toEqual(['ABC-123', 'abc-123'])
    expect(codeCandidates('')).toEqual([])
  })

  it('a running-number barcode is only ever reached by its own text (or that text with zeros in front)', () => {
    // every spelling derived from some OTHER scanned number has a GTIN length (8, 11-14) - lengths the numbering refuses for
    // all-digit codes - unless it is just the scanned digits without their leading zeros
    const internalLength = (c: string) => /^[1-9]\d*$/.test(c) && [5, 6, 7, 9, 10].includes(c.length)
    let seed = 12345
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
    for (let i = 0; i < 4000; i++) {
      const len = 5 + Math.floor(rnd() * 12)
      let x = ''
      for (let k = 0; k < len; k++) x += rnd() < 0.25 ? '0' : String(Math.floor(rnd() * 10))
      for (const c of codeCandidates(x)) {
        if (c === x || !internalLength(c)) continue
        expect(x.replace(/^0+/, ''), `scanned ${x} -> ${c}`).toBe(c)
      }
    }
    // letters in the prefix: only the letter case is ever varied
    expect(codeCandidates('VM000124')).toEqual(['VM000124', 'vm000124'])
    expect(codeCandidates('vm000124')).toEqual(['vm000124', 'VM000124'])
  })
})

describe('a running-number barcode never resolves to the wrong product', () => {
  it('scanning it gives its own item even when look-alike codes exist', () => {
    product('Internal', '200000123')
    product('Padded13', '0000200000123')
    product('Shifted', '2000001230')
    product('Longer', '2000001234567')
    product('Shorter', '20000012')
    expect(scan('200000123')).toBe('Internal')
    expect(scan(' 200000123\r\n')).toBe('Internal')
    expect(scan('*200000123*')).toBe('Internal')
    expect(scan(']C0200000123')).toBe('Internal')
    expect(scan('0000200000123')).toBe('Padded13')
    expect(scan('2000001230')).toBe('Shifted')
    expect(scan('2000001234567')).toBe('Longer')
    expect(scan('20000012')).toBe('Shorter')
  })

  it('other numbers that merely contain it (extra digit, check digit, truncation) find nothing', () => {
    product('Internal', '200000123')
    for (const other of ['2000001236', '20000012', '2000001', '1200000123', '200000124', '2000001239999', '20000012300', '200000123000', '2000001230000', '12000001230'])
      expect(scan(other), other).toBeUndefined()
    // letters: nothing but the letter case is flexible
    product('Vm', 'VM000124')
    expect(scan('vm000124')).toBe('Vm')
    for (const other of ['VM00124', 'VM0000124', 'VM000125', 'M000124', '000124', 'VM-000124']) expect(scan(other), other).toBeUndefined()
  })

  it('a different symbol that only DERIVES to it is refused when it also derives to another item', () => {
    product('Internal', '200000123')
    product('Padded13', '0000200000123')
    // 11 digits that are neither item: without its zeros it is Internal, padded to 13 it is Padded13
    const e = ambiguous('00200000123')
    expect(e).toMatchObject({ code: 'CONFLICT', details: { code: 'SCAN_AMBIGUOUS' } })
    expect(e.details.matches.map((m) => m.name).sort()).toEqual(['Internal', 'Padded13'])
    expect(e.message).toMatch(/Internal/)
    expect(e.message).toMatch(/Padded13/)
  })

  it('why all-digit running numbers of 11 digits are refused by the numbering settings', () => {
    // a UPC-A read with its check digit matches a stored 11-digit code (the "reader dropped the check digit" repair)
    product('Eleven', '20000000123')
    expect(scan('200000001236')).toBe('Eleven')
    expect(scanCandidates('200000001236').find((c) => c.code === '20000000123')?.tier).toBe(2)
  })
})

describe('ambiguous scans are reported, never guessed', () => {
  it('two items whose barcodes differ only in letter case: the exact text wins, anything else is refused', async () => {
    product('Lower', 'abc-1x')
    product('Upper', 'ABC-1X')
    expect(scan('abc-1x')).toBe('Lower')
    expect(scan('ABC-1X')).toBe('Upper')
    const e = ambiguous('Abc-1X')
    expect(e.details.code).toBe('SCAN_AMBIGUOUS')
    expect(e.details.matches).toHaveLength(2)
    // the billing screen gets the same error instead of a wrong line on the bill
    await expect(app.call('pos', 'scan', { code: 'Abc-1X' })).rejects.toMatchObject({ code: 'CONFLICT', details: { code: 'SCAN_AMBIGUOUS' } })
    await expect(app.call('catalog', 'findByCode', { code: 'Abc-1X' })).rejects.toMatchObject({ details: { code: 'SCAN_AMBIGUOUS' } })
  })

  it('a re-spelling of the same symbol beats a repair guess; two different guesses are refused', () => {
    const x = '400638133393' // 12 digits: an EAN-13 without its check digit, or a UPC-A
    product('WithCheck', '4006381333931') // guess: check digit was dropped
    const asEan = product('AsEan13', '0400638133393') // the same UPC-A written as EAN-13
    expect(scan(x)).toBe('AsEan13')
    app.db.run('UPDATE product_variants SET barcode = NULL WHERE id = ?', asEan)
    expect(scan(x)).toBe('WithCheck')
    product('Truncated', '40063813339') // guess: stored without check digit
    expect(ambiguous(x).details.matches.map((m) => m.name).sort()).toEqual(['Truncated', 'WithCheck'])
    expect(scan('4006381333931')).toBe('WithCheck')
    expect(scan('40063813339')).toBe('Truncated')
  })

  it('one item reached through two spellings is not ambiguous', () => {
    product('Both', '012345678905', { aliases: ['0012345678905'], sku: 'both-1' })
    expect(scan('00012345678905')).toBe('Both')
    expect(scan('BOTH-1')).toBe('Both')
    expect(scan('Both-1')).toBe('Both')
  })
})

describe('what readers add around a code', () => {
  it('spaces, CR/LF, Tab, GS, zero-width characters, Code 39 stars, quotes and AIM identifiers are ignored', () => {
    product('Vm', 'VM000124')
    product('Dash', 'AB-12-CD')
    for (const s of ['VM000124', '  VM000124  ', 'VM000124\r', 'VM000124\r\n', '\tVM000124\t', '\u0002VM000124\u0003', 'VM000124​', '*VM000124*', '"VM000124"', ']C0VM000124', 'vm000124\n'])
      expect(scan(s), JSON.stringify(s)).toBe('Vm')
    for (const s of ['AB-12-CD', 'ab-12-cd', ' AB-12-CD\r\n', '*AB-12-CD*']) expect(scan(s), s).toBe('Dash')
    expect(scan('')).toBeUndefined()
    expect(scan(' \r\n')).toBeUndefined()
    expect(stripScanDecorations(' *VM000124*\r\n')).toBe('VM000124')
    expect(stripScanDecorations(']C0VM000124\t')).toBe('VM000124')
    expect(stripScanFraming('VM000124\r\n')).toBe('VM000124')
    expect(parseUnitCode('VM000124')).toBeNull() // a running-number barcode is never a unit code
    expect(parseUnitCode(' spk-0007\r\n')).toEqual({ prefix: 'SPK', seq: 7 })
  })

  it('leading zeros are significant: 0123 and 123 are different codes unless only one of them exists', () => {
    product('Zero', '00123')
    product('Plain', '123')
    expect(scan('00123')).toBe('Zero')
    expect(scan('123')).toBe('Plain')
    app.db.run("UPDATE product_variants SET barcode = NULL WHERE barcode = '123'")
    expect(scan('123')).toBeUndefined() // zeros are never ADDED to a short code
    expect(scan('000123')).toBeUndefined()
  })

  it('an inactive item is still identified (the caller decides), and a barcode beats another item\'s SKU text', () => {
    product('Gone', 'VM000200', { active: false })
    expect(app.lookup.byScan('VM000200')).toMatchObject({ displayName: 'Gone', active: false })
  })
})

describe('keyboard-wedge and serial readers deliver running-number codes intact', () => {
  const codes = ['200000123', 'VM000124', 'A0001']
  it('very fast (1 ms) to slow (35 ms) readers, with Enter, Tab or CR+LF', () => {
    for (const code of codes)
      for (const gap of [1, 5, 20, 35])
        for (const terminator of ['Enter', 'Tab'] as const) {
          const r = runDetector(simulateKeys(code, { gap, terminator }))
          expect(r.scans.map((s) => s.code), `${code} @${gap}ms ${terminator}`).toEqual([code])
        }
    const crlf = runDetector(simulateKeys('VM000124', { gap: 3, extraTerminator: 'Enter' }))
    expect(crlf.scans.map((s) => s.code)).toEqual(['VM000124'])
    expect(crlf.consumed[crlf.consumed.length - 1]).toBe(true) // the second Enter is swallowed, it cannot press a button
  })

  it('Caps Lock does not turn VM000124 into vm000124', () => {
    expect(runDetector(simulateKeys('VM000124', { gap: 4, capsLock: true })).scans.map((s) => s.code)).toEqual(['VM000124'])
  })

  it('a person typing the same code slowly into a normal field is left alone', () => {
    const r = runDetector(simulateKeys('VM000124', { gap: 180 }))
    expect(r.scans).toEqual([])
    expect(r.consumed.every((c) => !c)).toBe(true)
  })

  it('a slow Bluetooth reader (120 ms per key) still works through the scan box, which accepts any timing', () => {
    const d = new ScanDetector({ ...DEFAULT_SCANNER })
    expect(d.effectiveMaxGap()).toBe(40) // the global detector alone would call this typing ...
    const rec = new BoxRecorder()
    let t = 1000
    for (const ch of 'VM000124') { rec.key({ key: ch, code: /\d/.test(ch) ? `Digit${ch}` : `Key${ch}`, timeStamp: t, shiftKey: /[A-Z]/.test(ch) }); t += 120 }
    // ... but the box simply takes what was typed when Enter arrives
    expect(rec.take('VM000124', DEFAULT_SCANNER)).toMatchObject({ code: 'VM000124', repaired: false })
  })

  it('serial readers: CR, LF, CR+LF, NUL and STX/ETX framing all end exactly one code', () => {
    const s = new SerialLineSplitter()
    expect(s.push('VM000124\r\n200000123\r')).toEqual(['VM000124', '200000123'])
    expect(s.push('\u0002VM0001')).toEqual([])
    expect(s.push('25\u0003')).toEqual(['VM000125'])
    expect(s.push(' A0001 \n\n\n')).toEqual(['A0001'])
    expect(s.push('TAIL')).toEqual([])
    expect(s.flush()).toBe('TAIL')
    expect(s.flush()).toBeNull()
  })
})

describe('product search (QA DEF-4)', () => {
  const names = (text: string) => app.lookup.search(text).map((v) => v.displayName)
  beforeEach(() => {
    product('Sparkler Box 15cm', '4006381333931', { sku: 'SPK-15', aliases: ['ALIAS-7788'] })
    product('Sparkler Box 30cm', null, { sku: 'SPK-30' })
    product('100% Pure_Bomb', null, { sku: 'PB-1' })
    product('100 PureXBomb', null, { sku: 'PB-2' })
    product('Hidden Sparkler 15cm', null, { sku: 'HID-1', active: false })
  })

  it('words may match apart from each other and in any order', () => {
    expect(names('Sparkler 15cm')).toEqual(['Sparkler Box 15cm'])
    expect(names('15cm sparkler')).toEqual(['Sparkler Box 15cm'])
    expect(names('  box   spark  ')).toEqual(['Sparkler Box 15cm', 'Sparkler Box 30cm'])
    expect(names('Sparkler Box 15cm')).toEqual(['Sparkler Box 15cm']) // the contiguous name still works
    expect(names('sparkler rocket')).toEqual([]) // every word has to match
    // a word can also be the SKU or the barcode of the same item
    expect(names('sparkler SPK-30')).toEqual(['Sparkler Box 30cm'])
    expect(names('box 4006381333931')).toEqual(['Sparkler Box 15cm'])
  })

  it('% and _ are searched as text, not as wildcards', () => {
    expect(names('100%')).toEqual(['100% Pure_Bomb'])
    expect(names('100% Pure_Bomb')).toEqual(['100% Pure_Bomb'])
    expect(names('Pure_Bomb')).toEqual(['100% Pure_Bomb'])
    expect(names('%')).toEqual(['100% Pure_Bomb'])
    expect(names('_')).toEqual(['100% Pure_Bomb'])
    expect(names('Pure%Bomb')).toEqual([])
    expect(names('100')).toEqual(['100 PureXBomb', '100% Pure_Bomb'])
  })

  it('an alias barcode typed or scanned into a picker finds its item; an empty box lists the first page', () => {
    expect(names('ALIAS-7788')).toEqual(['Sparkler Box 15cm'])
    expect(names('7788')).toEqual(['Sparkler Box 15cm'])
    expect(names(']C0ALIAS-7788\r\n')).toEqual(['Sparkler Box 15cm'])
    expect(names('').length).toBe(4) // active items only
    expect(app.lookup.search('', 2).length).toBe(2)
  })
})

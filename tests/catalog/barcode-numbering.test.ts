import { describe, it, expect, beforeEach } from 'vitest'
import { createTestApp } from '../helpers'
import type { App } from '../../src/main/core/app'
import {
  checkNumbering, formatInternalBarcode, isValidGtin, maxSequenceNumber, parseInternalBarcode, validateBarcode, type BarcodeNumbering
} from '../../src/main/modules/catalog/barcode'

let app: App
const call = <T = any>(m: string, a?: unknown) => app.call('catalog', m, a) as Promise<T>
const csv = (text: string, filename = 'products.csv') => ({ bytesBase64: Buffer.from(text, 'utf8').toString('base64'), filename })

let n = 0
const prod = (variant: Record<string, unknown> = {}, over: Record<string, unknown> = {}) => ({
  name: `Item ${++n}`, hsn: '3604', taxRateBp: 1800, variants: [{ name: '', mrp: 12000, price: 10000, cost: 7000, ...variant }], ...over
})
/** create a product whose barcode is generated on save; returns the code */
const auto = async (over: Record<string, unknown> = {}) => (await call('save', prod({ autoBarcode: true }, over))).variants[0].barcode as string
const counter = () => app.setting('catalog.barcode_seq', '0')
const scanName = (code: string) => app.lookup.byScan(code)?.displayName

beforeEach(() => {
  app = createTestApp()
  n = 0
})

describe('numbering rules (pure)', () => {
  const seq = (prefix: string, width: number): BarcodeNumbering => ({ mode: 'sequence', prefix, width })

  it('sequence = prefix + zero-padded running number, nothing else', () => {
    expect(formatInternalBarcode(seq('VM', 6), 1)).toBe('VM000001')
    expect(formatInternalBarcode(seq('VM', 6), 124)).toBe('VM000124')
    expect(formatInternalBarcode(seq('200', 6), 3)).toBe('200000003')
    expect(formatInternalBarcode(seq('A', 4), 9999)).toBe('A9999')
    // the suffix never grows past its width
    expect(formatInternalBarcode(seq('A', 4), 10000)).toBeNull()
    expect(formatInternalBarcode(seq('A', 4), 0)).toBeNull()
    expect(maxSequenceNumber(seq('VM', 6))).toBe(999999)
    expect(maxSequenceNumber({ mode: 'ean13', prefix: '200', width: 6 })).toBe(999999999)
    expect(formatInternalBarcode({ mode: 'ean13', prefix: '200', width: 6 }, 1)).toBe('2000000000015')
  })

  it('recognises only codes of exactly the configured shape', () => {
    expect(parseInternalBarcode(seq('VM', 6), 'VM000124')).toBe(124)
    expect(parseInternalBarcode(seq('VM', 6), 'VM00124')).toBeNull()
    expect(parseInternalBarcode(seq('VM', 6), 'VM00012A')).toBeNull()
    expect(parseInternalBarcode(seq('VM', 6), 'XM000124')).toBeNull()
    expect(parseInternalBarcode(seq('200', 6), '2000000000015')).toBeNull()
    expect(parseInternalBarcode({ mode: 'ean13', prefix: '200', width: 6 }, '2000000000053')).toBe(5)
    expect(parseInternalBarcode({ mode: 'ean13', prefix: '200', width: 6 }, '2000000000054')).toBeNull() // wrong check digit
  })

  it('accepts sensible settings and normalises the prefix to upper case', () => {
    expect(checkNumbering({ mode: 'sequence', prefix: ' vm ', width: '6' })).toEqual({ ok: true, cfg: { mode: 'sequence', prefix: 'VM', width: 6 } })
    expect(checkNumbering({ mode: 'sequence', prefix: '200', width: 6 })).toMatchObject({ ok: true })
    expect(checkNumbering({ mode: 'sequence', prefix: 'ABCD1234', width: 10 })).toMatchObject({ ok: true })
    expect(checkNumbering({ mode: 'ean13', prefix: '299', width: 6 })).toMatchObject({ ok: true, cfg: { mode: 'ean13', prefix: '299' } })
  })

  it('refuses prefixes / widths that cannot work, with the reason', () => {
    const bad = (prefix: string, width: unknown, mode = 'sequence') => {
      const r = checkNumbering({ mode, prefix, width })
      if (r.ok) throw new Error(`${prefix}/${width} should be refused`)
      return r
    }
    expect(bad('', 6)).toMatchObject({ field: 'prefix' })
    expect(bad('V-M', 6)).toMatchObject({ field: 'prefix' })
    expect(bad('V M', 6)).toMatchObject({ field: 'prefix' })
    expect(bad('ABCDEFGHI', 6)).toMatchObject({ field: 'prefix' })
    expect(bad('VM', 3)).toMatchObject({ field: 'width' })
    expect(bad('VM', 11)).toMatchObject({ field: 'width' })
    expect(bad('VM', 'six')).toMatchObject({ field: 'width' })
    expect(bad('VM', 6, 'qr')).toMatchObject({ field: 'mode' })
    // EAN-13 numbering keeps the GS1 in-store range
    expect(bad('150', 6, 'ean13')).toMatchObject({ field: 'prefix' })
    expect(bad('VM', 6, 'ean13')).toMatchObject({ field: 'prefix' })
    // an all-digit result of a GTIN length would be read as EAN-8 / UPC-A / EAN-13 and fail the check-digit rule
    expect(bad('200', 5).error).toMatch(/EAN-8/)
    expect(bad('200', 9).error).toMatch(/UPC-A/)
    expect(bad('200', 10).error).toMatch(/EAN-13/)
    expect(bad('20', 6).error).toMatch(/EAN-8/)
    // ... or as a GTIN whose check digit was dropped / a GTIN-14 (pos/codes.ts would try those spellings)
    expect(bad('200', 8).error).toMatch(/UPC-A without its check digit/)
    expect(bad('2000', 10).error).toMatch(/GTIN-14/)
    // leading zeros of a numeric code get lost in spreadsheets
    expect(bad('012', 6).error).toMatch(/cannot start with 0/)
    // the same lengths are fine once the prefix has a letter (Code 128 text, never a GTIN)
    for (const w of [4, 5, 6, 7, 8, 9, 10]) expect(checkNumbering({ mode: 'sequence', prefix: 'V20', width: w }).ok).toBe(true)
  })

  it('no accepted all-digit configuration can produce a code validateBarcode would treat as a GTIN', () => {
    for (const prefix of ['1', '2', '20', '200', '2000', '20000', '200000', '2000000', '20000000'])
      for (let width = 4; width <= 10; width++) {
        const r = checkNumbering({ mode: 'sequence', prefix, width })
        if (!r.ok) continue
        for (const k of [1, 7, 123, maxSequenceNumber(r.cfg)]) {
          const code = formatInternalBarcode(r.cfg, k)!
          expect([8, 11, 12, 13, 14]).not.toContain(code.length)
          expect(validateBarcode(code)).toMatchObject({ valid: true, format: 'CODE128' })
        }
      }
  })
})

describe('fixed prefix + running suffix (default)', () => {
  it('a fresh install needs no setup: 200000001, 200000002, 200000003 ...', async () => {
    expect(await call('getSettings')).toMatchObject({ barcodeMode: 'sequence', barcodePrefix: '200', barcodeWidth: '6', nextBarcode: '200000001', barcodeError: '' })
    expect([await auto(), await auto(), await auto()]).toEqual(['200000001', '200000002', '200000003'])
    expect(counter()).toBe('3')
    expect((await call('getSettings')).nextBarcode).toBe('200000004')
  })

  it('an install that already issued EAN-13 codes continues its counter in the new format; the old codes stay', async () => {
    await call('saveSettings', { barcodeMode: 'ean13' })
    const old = [await auto(), await auto()]
    expect(old).toEqual(['2000000000015', '2000000000022'])
    app.db.run("DELETE FROM settings WHERE key IN ('catalog.barcode_mode','catalog.barcode_width')") // as after an upgrade
    expect(await auto()).toBe('200000003')
    expect(app.db.all<{ barcode: string }>('SELECT barcode FROM product_variants ORDER BY id').map((r) => r.barcode)).toEqual([...old, '200000003'])
    expect(scanName(old[0])).toBe('Item 1')
    expect(scanName('200000003')).toBe('Item 3')
  })

  it('custom prefix: only the suffix changes (VM000001, VM000002 ...), lower case is stored upper case', async () => {
    const s = await call('saveSettings', { barcodePrefix: 'vm', barcodeWidth: 6 })
    expect(s).toMatchObject({ barcodeMode: 'sequence', barcodePrefix: 'VM', barcodeWidth: '6', nextBarcode: 'VM000001' })
    const codes = [await auto(), await auto(), await auto(), await auto()]
    expect(codes).toEqual(['VM000001', 'VM000002', 'VM000003', 'VM000004'])
    for (const c of codes) expect(c.slice(0, 2)).toBe('VM')
    // a reader (or Caps Lock) that sends lower case still finds the item
    expect(scanName('vm000003')).toBe('Item 3')
    expect(scanName(' VM000003\r\n')).toBe('Item 3')
    expect((await call('validateBarcode', { code: 'VM000005' })).valid).toBe(true)
  })

  it('saveSettings validates mode + prefix + width together and saves nothing when refused', async () => {
    await call('saveSettings', { barcodePrefix: 'VM', barcodeWidth: 5 })
    for (const bad of [{ barcodePrefix: 'V-M' }, { barcodeWidth: 3 }, { barcodeWidth: 11 }, { barcodePrefix: '200', barcodeWidth: 5 }, { barcodePrefix: '200', barcodeWidth: 10 }, { barcodeMode: 'ean13' }, { barcodeMode: 'nope' }, { barcodePrefix: '' }])
      await expect(call('saveSettings', bad), JSON.stringify(bad)).rejects.toMatchObject({ code: 'VALIDATION', details: { code: 'BARCODE_SETTINGS_INVALID' } })
    // "200" alone is refused here because the stored width 5 would give 8 digits (EAN-8); the pair is what counts
    await expect(call('saveSettings', { barcodePrefix: '200' })).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(await call('getSettings')).toMatchObject({ barcodeMode: 'sequence', barcodePrefix: 'VM', barcodeWidth: '5' })
    expect(await call('saveSettings', { barcodeMode: 'ean13', barcodePrefix: '250' })).toMatchObject({ barcodeMode: 'ean13', barcodePrefix: '250', nextBarcode: '2500000000010' })
  })

  it('the preview shows an example and the real next code without saving anything', async () => {
    await auto()
    await auto()
    const before = await call('getSettings')
    expect(await call('barcodePreview', { mode: 'sequence', prefix: 'vm', width: 6 })).toMatchObject({
      valid: true, prefix: 'VM', width: 6, example: 'VM000001', exampleNext: 'VM000002', next: 'VM000003', last: 'VM999999', remaining: 999997
    })
    expect(await call('barcodePreview', { mode: 'sequence', prefix: '200', width: 5 })).toMatchObject({ valid: false, field: 'width', next: '' })
    expect((await call('barcodePreview', { mode: 'sequence', prefix: '200', width: 5 })).error).toMatch(/EAN-8/)
    expect(await call('barcodePreview', { mode: 'ean13', prefix: '200' })).toMatchObject({ valid: true, example: '2000000000015', next: '2000000000039' })
    expect(await call('barcodePreview', {})).toMatchObject({ valid: true, mode: 'sequence', prefix: '200', next: '200000003' })
    expect(await call('getSettings')).toEqual(before)
  })

  it('when the suffix is used up it fails clearly instead of growing, and saves nothing', async () => {
    await call('saveSettings', { barcodePrefix: 'VM', barcodeWidth: 4 })
    app.setSetting('catalog.barcode_seq', '9998')
    expect(await auto()).toBe('VM9999')
    const products = app.db.value<number>('SELECT COUNT(*) FROM products')
    const e = await call('save', prod({ autoBarcode: true })).catch((x) => x)
    expect(e).toMatchObject({ code: 'CONFLICT', details: { code: 'BARCODE_SEQ_EXHAUSTED', prefix: 'VM', width: 4, last: 'VM9999' } })
    expect(e.message).toMatch(/VM9999/)
    expect(app.db.value('SELECT COUNT(*) FROM products')).toBe(products)
    expect(app.db.value("SELECT COUNT(*) FROM product_variants WHERE barcode LIKE 'VM1%'")).toBe(0)
    expect(counter()).toBe('9999')
    await expect(call('generateBarcode')).rejects.toMatchObject({ details: { code: 'BARCODE_SEQ_EXHAUSTED' } })
    expect((await call('getSettings')).barcodeError).toMatch(/used up/)
    // more digits (or a new prefix) continues; nothing already issued changes
    await call('saveSettings', { barcodeWidth: 6 })
    expect(await auto()).toBe('VM010000')
    expect(scanName('VM9999')).toBe('Item 1')
  })

  it('never issues a number that is already a barcode, an alias or a SKU', async () => {
    await call('saveSettings', { barcodePrefix: 'VM', barcodeWidth: 6 })
    await call('save', prod({ sku: 'vm000002' }))
    await call('save', prod({ sku: 'OTHER-1', barcode: '4006381333931', aliases: ['VM000004'] }))
    expect(await auto()).toBe('VM000005') // continues after the highest number already present (alias VM000004)
    await call('save', prod({ sku: 'VM000007' }))
    expect([await auto(), await auto()]).toEqual(['VM000006', 'VM000008']) // the SKU VM000007 is skipped
    const all = app.db.all<{ c: string }>('SELECT barcode AS c FROM product_variants WHERE barcode IS NOT NULL UNION ALL SELECT barcode FROM variant_barcodes UNION ALL SELECT upper(sku) FROM product_variants')
    expect(new Set(all.map((r) => r.c)).size).toBe(all.length)
  })

  it('a generated code never looks like a unit code (PREFIX-NNNN)', async () => {
    await call('saveSettings', { barcodePrefix: 'SPK', barcodeWidth: 4 })
    await call('save', prod({ openingStock: 2 }, { trackUnits: true, unitPrefix: 'SPK' }))
    const code = await auto()
    expect(code).toBe('SPK0001')
    expect(code).not.toMatch(/-/)
    expect(app.lookup.byScan('SPK0001')?.unit).toBe('pcs') // the product barcode, not a unit
    expect(typeof app.lookup.byScan('SPK-0001')?.unit).toBe('object') // the unit code
    expect(app.lookup.byScan('SPK-0001')?.displayName).toBe('Item 1')
    expect(app.lookup.byScan('SPK0001')?.displayName).toBe('Item 2')
  })

  it('changing prefix or mode later leaves issued codes alone and the number keeps counting (never backwards)', async () => {
    const a = [await auto(), await auto(), await auto()]
    await call('saveSettings', { barcodePrefix: 'VM' })
    const b = [await auto(), await auto()]
    await call('saveSettings', { barcodeMode: 'ean13', barcodePrefix: '200' })
    const c = [await auto()]
    await call('saveSettings', { barcodeMode: 'sequence', barcodePrefix: 'VM', barcodeWidth: 4 })
    const d = [await auto()]
    await call('saveSettings', { barcodePrefix: '200', barcodeWidth: 6 })
    const e = [await auto()]
    expect([a, b, c, d, e]).toEqual([['200000001', '200000002', '200000003'], ['VM000004', 'VM000005'], ['2000000000060'], ['VM0007'], ['200000008']])
    expect(isValidGtin(c[0], 13)).toBe(true)
    const stored = app.db.all<{ barcode: string }>('SELECT barcode FROM product_variants ORDER BY id').map((r) => r.barcode)
    expect(stored).toEqual([...a, ...b, ...c, ...d, ...e])
    for (const [i, code] of stored.entries()) expect(scanName(code)).toBe(`Item ${i + 1}`)
    expect(app.db.value('SELECT COUNT(*) FROM variant_barcodes')).toBe(0)
  })

  it('continues after codes that arrived another way (typed, imported, synced), even when the counter is behind', async () => {
    await call('saveSettings', { barcodePrefix: 'VM' })
    await call('save', prod({ barcode: 'VM000050' })) // typed by hand / came from another terminal
    expect(counter()).toBe('0')
    expect(await auto()).toBe('VM000051')
    await call('importCommit', { ...csv('Name,SKU,Barcode,Price\nImported,IMP-1,VM000090,10\n'), mode: 'all_or_nothing' })
    expect(await auto()).toBe('VM000091')
    // codes of another width or another prefix do not count
    await call('save', prod({ barcode: 'VM7777' }))
    await call('save', prod({ barcode: 'XY999999' }))
    expect(await auto()).toBe('VM000092')
    // a counter that is ahead wins (numbers issued and deleted since are never handed out again)
    app.setSetting('catalog.barcode_seq', '500')
    expect(await auto()).toBe('VM000501')
  })

  it('a broken stored configuration is reported, never used', async () => {
    app.setSetting('catalog.barcode_prefix', 'AB-') // e.g. edited outside catalog.saveSettings
    await expect(call('save', prod({ autoBarcode: true }))).rejects.toMatchObject({ code: 'VALIDATION', details: { code: 'BARCODE_SETTINGS_INVALID' } })
    expect((await call('getSettings')).barcodeError).toMatch(/Barcode numbering is not set up correctly/)
    expect(app.db.value('SELECT COUNT(*) FROM products')).toBe(0)
    // products with their own barcode still save
    expect((await call('save', prod({ barcode: '4006381333931' }))).variants[0].barcode).toBe('4006381333931')
  })
})

describe('the running number is consumed transactionally (no gaps, no duplicates)', () => {
  it('"Generate" in the product form previews: repeated clicks and abandoned forms burn nothing', async () => {
    for (let i = 0; i < 5; i++) expect((await call('generateBarcode')).barcode).toBe('200000001')
    expect(counter()).toBe('0')
    expect(await auto()).toBe('200000001') // an abandoned preview does not leave a hole
  })

  it('saving the previewed code consumes it; a second product can never get the same code', async () => {
    const shown = (await call('generateBarcode')).barcode
    await call('save', prod({ barcode: shown }))
    expect(counter()).toBe('1')
    // another form that still shows the old preview is refused at save, and gets a new number from Generate
    await expect(call('save', prod({ barcode: shown }))).rejects.toMatchObject({ code: 'CONFLICT' })
    expect((await call('generateBarcode')).barcode).toBe('200000002')
    expect(await auto()).toBe('200000002')
  })

  it('several unsaved variants of one form get consecutive previews, all consumed on save', async () => {
    const a = (await call('generateBarcode')).barcode
    const b = (await call('generateBarcode', { exclude: [a] })).barcode
    const c = (await call('generateBarcode', { exclude: [a, b] })).barcode
    expect([a, b, c]).toEqual(['200000001', '200000002', '200000003'])
    await call('save', { name: 'Multi', variants: [{ name: 'S', barcode: a, price: 100 }, { name: 'M', barcode: b, price: 100 }, { name: 'L', barcode: c, price: 100 }] })
    expect(counter()).toBe('3')
    expect(await auto()).toBe('200000004')
  })

  it('a number used by a product that was deleted afterwards is not handed out again', async () => {
    const shown = (await call('generateBarcode')).barcode
    const p = await call('save', prod({ barcode: shown }))
    const q = await call('save', prod({ autoBarcode: true }))
    expect(q.variants[0].barcode).toBe('200000002')
    expect(await call('remove', { id: q.id })).toMatchObject({ deleted: true })
    expect(await call('remove', { id: p.id })).toMatchObject({ deleted: true })
    expect(await auto()).toBe('200000003') // labels printed for the deleted items can never point at a new product
  })

  it('a failed save gives the number back (product save, extra variant, grid, import)', async () => {
    await call('save', prod({ sku: 'DUP' }))
    // 2nd variant fails after the 1st one took a number
    await expect(call('save', { name: 'Fails', variants: [{ name: 'A', autoBarcode: true, price: 1 }, { name: 'B', sku: 'DUP', price: 1 }] })).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(counter()).toBe('0')
    // spreadsheet: all-or-nothing, the good new row's number is rolled back with the bad row
    await expect(app.call('catalog', 'bulkUpdate', { rows: [{ key: 'n1', patch: { name: 'Grid new', price: 100 } }, { key: 'n2', patch: { name: 'Grid bad', sku: 'DUP' } }] })).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(counter()).toBe('0')
    expect(app.db.value('SELECT COUNT(*) FROM products')).toBe(1)
    expect(await auto()).toBe('200000001')
  })

  it('spreadsheet rows and "generate missing" take consecutive numbers', async () => {
    const r: any = await app.call('catalog', 'bulkUpdate', { rows: [{ key: 'a', patch: { name: 'G1', price: 100 } }, { key: 'b', patch: { name: 'G2', price: 100 } }] })
    expect(r.created).toBe(2)
    for (let i = 0; i < 3; i++) await call('save', prod())
    expect(await call('generateMissingBarcodes')).toEqual({ assigned: 3, remaining: 0 })
    expect(app.db.all<{ barcode: string }>('SELECT barcode FROM product_variants ORDER BY id').map((x) => x.barcode))
      .toEqual(['200000001', '200000002', '200000003', '200000004', '200000005'])
    expect(counter()).toBe('5')
  })

  it('typing the generator\'s next number into the spreadsheet consumes it', async () => {
    const p = await call('save', prod())
    await app.call('catalog', 'bulkUpdate', { rows: [{ variantId: p.variants[0].id, patch: { barcode: '200000001' } }] })
    expect(counter()).toBe('1')
    expect(await auto()).toBe('200000002')
  })

  it('assignBarcode stores the next number at once; replacing keeps the old code scanning as an alias', async () => {
    const p = await call('save', prod())
    const vid = p.variants[0].id
    expect(await call('assignBarcode', { variantId: vid })).toMatchObject({ barcode: '200000001', replaced: false })
    await expect(call('assignBarcode', { variantId: vid })).rejects.toMatchObject({ code: 'CONFLICT', details: { code: 'BARCODE_EXISTS', barcode: '200000001' } })
    expect(counter()).toBe('1') // the refused call burned nothing
    await expect(call('assignBarcode', { variantId: 99999 })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(counter()).toBe('1')
    expect(await call('assignBarcode', { variantId: vid, replace: true })).toMatchObject({ barcode: '200000002', replaced: true, previous: '200000001' })
    expect(scanName('200000001')).toBe('Item 1')
    expect(scanName('200000002')).toBe('Item 1')
  })

  it('"generate missing" reports remaining for exactly the items it can number', async () => {
    const hidden = await call('save', prod())
    await call('setActive', { ids: [hidden.id], active: false }) // inactive product whose variant is still flagged active
    await call('save', prod())
    expect(await call('generateMissingBarcodes')).toEqual({ assigned: 1, remaining: 0 })
  })
})

describe('ean13 numbering (the previous behaviour, still available)', () => {
  beforeEach(async () => {
    await call('saveSettings', { barcodeMode: 'ean13' })
  })

  it('issues valid EAN-13 codes in the in-store range, unique and in order', async () => {
    const codes: string[] = []
    for (let i = 0; i < 25; i++) codes.push(await auto())
    expect(codes[0]).toBe('2000000000015')
    expect(codes[1]).toBe('2000000000022')
    expect(codes[2]).toBe('2000000000039')
    for (const c of codes) expect(isValidGtin(c, 13)).toBe(true)
    expect(new Set(codes).size).toBe(25)
    expect(codes.map((c) => Number(c.slice(3, 12)))).toEqual(Array.from({ length: 25 }, (_, i) => i + 1))
    expect(counter()).toBe('25')
  })

  it('honours the prefix 200-299 and skips numbers that are taken', async () => {
    await call('saveSettings', { barcodePrefix: '299' })
    await call('save', prod({ barcode: '2990000000026' })) // number 2 typed by hand
    expect([await auto(), await auto()]).toEqual(['2990000000019', '2990000000033'])
    await expect(call('saveSettings', { barcodePrefix: '300' })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call('saveSettings', { barcodePrefix: 'VM' })).rejects.toMatchObject({ code: 'VALIDATION' })
  })

  it('preview / consume-on-save works the same way', async () => {
    const shown = (await call('generateBarcode')).barcode
    expect((await call('generateBarcode')).barcode).toBe(shown)
    expect(counter()).toBe('0')
    await call('save', prod({ barcode: shown }))
    expect(counter()).toBe('1')
    expect(await auto()).toBe('2000000000022')
  })

  it('another shop\'s in-store code high in the range does not exhaust the counter', async () => {
    await call('save', prod({ barcode: '2099999999998' }))
    expect(await auto()).toBe('2000000000015')
  })

  it('fails clearly when the 9 digits are used up', async () => {
    app.setSetting('catalog.barcode_seq', '999999999')
    await expect(call('save', prod({ autoBarcode: true }))).rejects.toMatchObject({ code: 'CONFLICT', details: { code: 'BARCODE_SEQ_EXHAUSTED' } })
  })
})

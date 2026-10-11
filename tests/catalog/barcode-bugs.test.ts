import { describe, it, expect, beforeEach } from 'vitest'
import { createTestApp } from '../helpers'
import type { App } from '../../src/main/core/app'
import { validateBarcode } from '../../src/main/modules/catalog/barcode'

/** Regression tests for barcode defects found while reviewing the catalog side of the pipeline. */
let app: App
const call = <T = any>(m: string, a?: unknown) => app.call('catalog', m, a) as Promise<T>
const csv = (text: string, filename = 'products.csv') => ({ bytesBase64: Buffer.from(text, 'utf8').toString('base64'), filename })
const prod = (name: string, variant: Record<string, unknown> = {}, over: Record<string, unknown> = {}) => ({
  name, hsn: '3604', taxRateBp: 1800, variants: [{ name: '', mrp: 12000, price: 10000, cost: 7000, ...variant }], ...over
})

beforeEach(() => {
  app = createTestApp()
})

describe('a barcode and another item\'s SKU share one lookup, so they must not collide', () => {
  it('refuses a barcode / alias that is another item\'s SKU (it would hide that item from its own SKU)', async () => {
    await call('save', prod('Rocket', { sku: 'RKT-1' }))
    const e = await call('save', prod('Bomb', { barcode: 'RKT-1' })).catch((x) => x)
    expect(e).toMatchObject({ code: 'CONFLICT' })
    expect(e.message).toMatch(/already the SKU of "Rocket"/)
    await expect(call('save', prod('Bomb', { barcode: 'rkt-1' }))).rejects.toMatchObject({ code: 'CONFLICT' }) // SKUs are case-insensitive
    await expect(call('save', prod('Bomb', { aliases: ['RKT-1'] }))).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(app.db.value('SELECT COUNT(*) FROM products')).toBe(1)
    expect(app.lookup.byCode('RKT-1')?.displayName).toBe('Rocket')
    // the form check says the same before saving
    expect(await call('validateBarcode', { code: 'RKT-1' })).toMatchObject({ valid: false, owner: 'Rocket' })
    // an item may use its OWN SKU as its barcode
    const own = await call('save', prod('Same', { sku: 'SAME-9', barcode: 'SAME-9' }))
    expect(own.variants[0]).toMatchObject({ sku: 'SAME-9', barcode: 'SAME-9' })
    const r = await call('save', { id: own.id, name: 'Same', variants: [{ id: own.variants[0].id, name: '', barcode: 'SAME-9', price: 5 }] })
    expect(r.variants[0].barcode).toBe('SAME-9')
  })

  it('refuses a SKU that is another item\'s barcode or alias, on create, edit and in the spreadsheet', async () => {
    await call('save', prod('Rocket', { barcode: 'CODE-77', aliases: ['OLD-77'] }))
    await expect(call('save', prod('Bomb', { sku: 'CODE-77' }))).rejects.toMatchObject({ code: 'CONFLICT', details: { code: 'SKU_IS_BARCODE' } })
    await expect(call('save', prod('Bomb', { sku: 'old-77' }))).rejects.toMatchObject({ code: 'CONFLICT', details: { code: 'SKU_IS_BARCODE' } })
    const b = await call('save', prod('Bomb', { sku: 'B-1' }))
    await expect(call('save', { id: b.id, name: 'Bomb', variants: [{ id: b.variants[0].id, name: '', sku: 'CODE-77', price: 5 }] })).rejects.toMatchObject({ details: { code: 'SKU_IS_BARCODE' } })
    const g: any = await app.call('catalog', 'bulkUpdate', { rows: [{ variantId: b.variants[0].id, patch: { sku: 'CODE-77' } }] }).catch((x) => x)
    expect(g.details.rowErrors[0]).toMatchObject({ field: 'sku' })
    expect(g.details.rowErrors[0].message).toMatch(/already the barcode of "Rocket"/)
    const g2: any = await app.call('catalog', 'bulkUpdate', { rows: [{ variantId: b.variants[0].id, patch: { barcode: 'SKU-000001' } }] }).catch((x) => x)
    expect(g2.details.rowErrors[0].message).toMatch(/already the SKU of "Rocket"/)
    expect(app.lookup.byCode('CODE-77')?.displayName).toBe('Rocket')
    expect(app.lookup.byCode('B-1')?.displayName).toBe('Bomb')
  })

  it('auto-generated SKUs step over numbers that are already a barcode', async () => {
    await call('save', prod('Rocket', { sku: 'R', barcode: 'SKU-000001' }))
    expect((await call('save', prod('Bomb'))).variants[0].sku).toBe('SKU-000002')
  })

  it('the importer reports the collision per row instead of failing the whole file', async () => {
    await call('save', prod('Rocket', { sku: 'RKT-1', barcode: 'CODE-77' }))
    const text = ['Name,SKU,Barcode,Price', 'Bomb,B-1,RKT-1,10', 'Wheel,CODE-77,,10', 'Flower,F-1,F-2,10', 'Chakra,F-2,,10', 'Fine,OK-1,OK-1,10'].join('\n')
    const p = await call('importPreview', csv(text))
    const errs = Object.fromEntries(p.issues.map((i: any) => [i.name, i.errors.join(' | ')]))
    expect(errs.Bomb).toMatch(/RKT-1 is already the SKU of "Rocket"/)
    expect(errs.Wheel).toMatch(/SKU CODE-77 is already the barcode of "Rocket"/)
    expect(errs.Chakra).toMatch(/SKU F-2 is also the barcode of row 4/)
    expect(errs.Fine ?? '').toBe('')
    const r = await call('importCommit', { ...csv(text), mode: 'skip_bad_rows' })
    expect(r).toMatchObject({ created: 2, skipped: 3 })
  })
})

describe('unit code namespace', () => {
  it('a barcode / alias / SKU shaped like a tracked product\'s unit code is refused before it can block that numbering', async () => {
    const spk = await call('save', prod('Sparkler', { openingStock: 2 }, { trackUnits: true, unitPrefix: 'SPK' }))
    for (const v of [{ barcode: 'SPK-0500' }, { barcode: 'spk-0500' }, { aliases: ['SPK-0500'] }, { sku: 'SPK-0500' }]) {
      const e = await call('save', prod('Late', v)).catch((x) => x)
      expect(e, JSON.stringify(v)).toMatchObject({ code: 'CONFLICT', details: { code: 'UNIT_NAMESPACE' } })
      expect(e.message).toMatch(/unit code of Sparkler/)
    }
    expect((await call('validateBarcode', { code: 'SPK-0500' })).valid).toBe(false)
    const late = await call('save', prod('Late'))
    const g: any = await app.call('catalog', 'bulkUpdate', { rows: [{ variantId: late.variants[0].id, patch: { barcode: 'SPK-0500' } }] }).catch((x) => x)
    expect(g.details.rowErrors[0].message).toMatch(/unit code of Sparkler/)
    // codes with a dash that belong to nobody's unit prefix are still fine
    expect((await call('save', prod('Dash', { barcode: 'ABC-1234', sku: 'XY-0001' }))).variants[0].barcode).toBe('ABC-1234')
    // and the product's own numbering runs on undisturbed
    const r: any = await app.call('inventory', 'adjust', { variantId: spk.variants[0].id, delta: 1, reason: 'found' })
    expect(r.unitCodes).toEqual(['SPK-0003'])
  })
})

describe('barcode values', () => {
  it('a number a spreadsheet shortened to scientific notation is not accepted as a barcode', async () => {
    for (const bad of ['8.90123E+12', '8.90123e+12', '8E+12', '4.00638E12']) expect(validateBarcode(bad).valid, bad).toBe(false)
    expect(validateBarcode('8.90123E+12').error).toMatch(/Text/)
    for (const ok of ['E12', 'A1E+5X', '8901234567890', 'VM000124', '1E', 'CODE 39']) expect(validateBarcode(ok).valid, ok).toBe(true)
    await expect(call('save', prod('Sci', { barcode: '8.90123E+12' }))).rejects.toMatchObject({ code: 'VALIDATION' })
    const p = await call('importPreview', csv('Name,SKU,Barcode,Price\nSci,S-1,8.90123E+12,10\n'))
    expect(p.counts.invalid).toBe(1)
    expect(p.issues[0].errors.join(' ')).toMatch(/spreadsheet shortened/)
  })

  it('the importer keeps a barcode that was exported as a decimal ("8901234567890.0")', async () => {
    await call('importCommit', { ...csv('Name,SKU,Barcode,Alias Barcodes,Price\nDec,D-1,4006381333931.0,96385074.00,10\n'), mode: 'all_or_nothing' })
    expect(app.lookup.byCode('4006381333931')?.displayName).toBe('Dec')
    expect(app.lookup.byCode('96385074')?.displayName).toBe('Dec')
  })

  it('leading / trailing spaces, CR and LF never become part of a stored barcode; leading zeros are kept', async () => {
    const p = await call('save', prod('Trim', { barcode: '  00123457\r\n', aliases: [' AL-1 \t'] }))
    expect(p.variants[0].barcode).toBe('00123457')
    expect(p.variants[0].aliases).toEqual(['AL-1'])
    expect(app.lookup.byCode('00123457')?.displayName).toBe('Trim')
    await expect(call('save', prod('Dup', { barcode: '00123457 ' }))).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('the same barcode on two variants of one product is refused', async () => {
    await expect(call('save', { name: 'Two', variants: [{ name: 'S', barcode: '4006381333931', price: 1 }, { name: 'M', barcode: '4006381333931', price: 1 }] })).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(call('save', { name: 'Two', variants: [{ name: 'S', barcode: '4006381333931', price: 1 }, { name: 'M', aliases: ['4006381333931'], price: 1 }] })).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(app.db.value('SELECT COUNT(*) FROM products')).toBe(0)
  })

  it('an alias promoted to the primary barcode does not stay behind as an alias of itself', async () => {
    const p = await call('save', prod('Promo', { barcode: '4006381333931', aliases: ['OLD-LABEL'] }))
    const vid = p.variants[0].id
    // an edit that does not mention aliases (price list import, API caller)
    const r = await call('save', { id: p.id, name: 'Promo', variants: [{ id: vid, name: '', barcode: 'OLD-LABEL', price: 5 }] })
    expect(r.variants[0].barcode).toBe('OLD-LABEL')
    expect(r.variants[0].aliases).toEqual([])
    expect(app.db.value('SELECT COUNT(*) FROM variant_barcodes WHERE variant_id = ?', vid)).toBe(0)
    expect(app.lookup.byCode('OLD-LABEL')?.displayName).toBe('Promo')
  })
})

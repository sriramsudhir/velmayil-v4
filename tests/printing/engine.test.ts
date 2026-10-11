import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { BusinessProfile } from '../../src/shared/types'
import { renderInvoice, renderLabels, renderReport, renderTestPage } from '../../src/main/modules/printing/engine'
import { sampleInvoiceDoc } from '../../src/main/modules/printing/docBuilder'
import { renderTemplate, Safe, esc } from '../../src/main/modules/printing/mustache'
import { defaultConfig, normalizeConfig, TEMPLATE_KINDS, type InvoiceKind } from '../../src/main/modules/printing/config'
import { barcodeSvg, qrSvg } from '../../src/main/modules/printing/barcode'
import { prepareHtml, parseCalibration } from '../../src/main/modules/printing/adapter'
import { makePng } from './fixtures'

const profile = (over: Partial<BusinessProfile> = {}): BusinessProfile => ({
  id: 1, version: 1, shopName: 'Acme Traders', legalName: 'Acme Traders Private Limited', displayName: 'Acme Traders', shortName: 'Acme',
  address: '12 Market Road', city: 'Madurai', state: 'Tamil Nadu', pinCode: '625001', phone: '9876543210', email: 'hello@acme.example', website: 'www.acme.example',
  gstin: '33ABCDE1234F1Z5', pan: 'ABCDE1234F', footerText: 'Thank you, visit again', logoAssetId: null,
  logoSettings: { visible: true, widthMm: 0, heightMm: 0, alignment: 'center', position: 'top' },
  headerSettings: { showLogo: true, showShopName: true, showAddress: true, showPhone: true, showGstin: true }, createdAt: 1, createdBy: null, ...over
})
const logo = (w = 400, h = 200) => ({ widthPx: w, heightPx: h, dataUri: () => `data:image/png;base64,${makePng(4, 4).toString('base64')}` })
const INVOICES: InvoiceKind[] = ['receipt58', 'receipt80', 'invoiceA4', 'invoiceA5']

describe('mustache engine', () => {
  it('escapes values, supports raw Safe, sections, inverse and loops', () => {
    const out = renderTemplate('{{a}}|{{{b}}}|{{c}}|{{#list}}[{{n}}:{{_index}}]{{/list}}|{{#no}}x{{/no}}{{^no}}inv{{/no}}|{{#o}}{{p}}{{/o}}', {
      a: '<b>&"\'', b: '<i>', c: new Safe('<u>'), list: [{ n: 1 }, { n: 2 }], no: false, o: { p: 'P' }
    })
    expect(out).toBe('&lt;b&gt;&amp;&quot;&#39;|<i>|<u>|[1:1][2:2]|inv|P')
  })
  it('rejects malformed templates', () => {
    expect(() => renderTemplate('{{#a}}x', {})).toThrow(/unclosed/)
    expect(() => renderTemplate('{{/a}}', {})).toThrow()
  })
  it('esc covers the dangerous characters', () => {
    expect(esc('<script>"\'`&')).toBe('&lt;script&gt;&quot;&#39;&#96;&amp;')
  })
})

describe('every layout uses the profile values', () => {
  for (const kind of INVOICES) {
    it(`${kind} shows shop name, address, phone, GSTIN, invoice meta, totals and footer`, () => {
      const p = profile()
      const doc = sampleInvoiceDoc(p)
      const { html } = renderInvoice(kind, doc, {}, null)
      expect(html).toContain('Acme Traders')
      expect(html).toContain('12 Market Road')
      expect(html).toContain('9876543210')
      expect(html).toContain('33ABCDE1234F1Z5')
      expect(html).toContain('Thank you, visit again')
      expect(html).toContain('SAMPLE-0001')
      expect(html).toContain('Sample item B')
      expect(html).toContain('₹') // currency formatting through formatINR
      expect(html.replace(/<style>[\s\S]*?<\/style>/g, '')).not.toMatch(/\{\{|\}\}/) // no unresolved variables
      expect(html.startsWith('<!doctype html>')).toBe(true)
    })
  }
  it('uses Indian grouping for money (₹1,23,456.78)', () => {
    const doc = { ...sampleInvoiceDoc(profile()), total: 12345678, subtotal: 12345678 }
    expect(renderInvoice('receipt80', doc, {}, null).html).toContain('₹1,23,456.78')
    expect(renderInvoice('invoiceA4', doc, {}, null).html).toContain('₹1,23,456.78')
  })
  it('A4 has the professional header box, product table with HSN, tax summary and terms', () => {
    const { html } = renderInvoice('invoiceA4', sampleInvoiceDoc(profile()), {}, null)
    for (const s of ['hdr-box', 'HSN', 'Tax summary', 'CGST', 'Terms &amp; conditions', 'Authorised signatory', 'Bill to', 'Payment']) expect(html).toContain(s)
    expect(html).toContain('3604')
    expect(html).toContain('Phone: 9876543210')
  })
  it('layouts are independently designed (distinct structure, not scaled copies)', () => {
    const doc = sampleInvoiceDoc(profile())
    const h = Object.fromEntries(INVOICES.map((k) => [k, renderInvoice(k, doc, {}, null).html])) as Record<InvoiceKind, string>
    expect(h.receipt58).toContain('class="iline"') // two-line items for ~32 char paper
    expect(h.receipt58).not.toContain('class="items"')
    expect(h.receipt80).toContain('class="items"') // tabular items
    expect(h.receipt80).toContain('class="band"')
    expect(h.invoiceA4).toContain('hdr-box')
    expect(h.invoiceA5).toContain('class="titlebar"')
    expect(h.invoiceA5).not.toContain('hdr-box')
    expect(new Set(Object.values(h)).size).toBe(4)
    expect(h.receipt58).toMatch(/Consolas/) // monospace paper
    expect(h.receipt58).not.toContain('Tax summary')
  })
  it('receipt widths: 58 mm paper has ~48 mm printable, 80 mm has ~72 mm', () => {
    const doc = sampleInvoiceDoc(profile())
    const r58 = renderInvoice('receipt58', doc, {}, null)
    const r80 = renderInvoice('receipt80', doc, {}, null)
    expect(r58.widthMm).toBe(58)
    expect(r58.html).toContain('body{width:58mm;padding:2mm 5mm 6mm 5mm}')
    expect(r80.widthMm).toBe(80)
    expect(r80.html).toContain('body{width:80mm;padding:3mm 4mm 8mm 4mm}')
  })
  it('receipt80 can print a UPI QR code from template config; off by default', () => {
    const doc = sampleInvoiceDoc(profile())
    expect(renderInvoice('receipt80', doc, {}, null).html).not.toContain('class="qr"')
    const on = renderInvoice('receipt80', doc, { qrEnabled: true, upiId: 'acme@upi', upiLabel: 'Scan & pay' }, null).html
    expect(on).toContain('class="qr"')
    expect(on).toContain('Scan &amp; pay')
    expect(on).toContain('acme@upi')
  })
  it('returns render as credit notes with the original invoice', () => {
    const doc = { ...sampleInvoiceDoc(profile()), isReturn: true, originalInvoiceNumber: 'INV-1' }
    expect(renderInvoice('receipt80', doc, {}, null).html).toContain('CREDIT NOTE')
  })
  it('is non-GST friendly: no GSTIN means plain RECEIPT/INVOICE title and no GSTIN line', () => {
    const doc = sampleInvoiceDoc(profile({ gstin: '' }))
    const html = renderInvoice('receipt58', doc, {}, null).html
    expect(html).not.toContain('GSTIN')
    expect(html).toContain('RECEIPT')
  })
})

describe('shop name wrapping (never clipped, never overlapping, never wider than paper)', () => {
  const LONG = 'Sri Lakshmi Fireworks & Crackers Wholesale and Retail'
  const NOSPACE = 'SriLakshmiFireworksAndCrackersWholesaleAndRetailMerchantsAssociationLimited'
  const TAMIL = 'ஸ்ரீ லட்சுமி பட்டாசு மற்றும் வெடிப்பொருள் மொத்த மற்றும் சில்லறை விற்பனை நிலையம்'
  const names = { long: LONG, nospace: NOSPACE, tamil: TAMIL }

  for (const kind of INVOICES) {
    for (const [label, name] of Object.entries(names)) {
      it(`${kind} / ${label}: wrap rules present and the name is rendered whole`, () => {
        const p = profile({ shopName: name, displayName: name, legalName: name + ' Pvt' })
        const { html } = renderInvoice(kind, sampleInvoiceDoc(p), {}, logo())
        expect(html).toContain(esc(name))
        const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'))
        expect(css).toMatch(/\.shop-name[^{]*\{[^}]*overflow-wrap:anywhere/)
        expect(css).toMatch(/word-break:break-word/)
        expect(css).toMatch(/white-space:normal/)
        expect(css).toMatch(/min-width:0/)
        expect(css).toMatch(/max-width:100%/)
        // nothing that holds the name may clip it: no overflow:hidden / text-overflow, and no nowrap on name/address/text blocks
        expect(css).not.toMatch(/overflow\s*:\s*hidden/)
        expect(css).not.toMatch(/text-overflow/)
        for (const [, sel, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
          if (/shop-name|legal|addr|head-text|top-text|hb-main|rtext/.test(sel)) expect(body, sel).not.toMatch(/white-space\s*:\s*nowrap/)
        }
      })
    }
  }
  it('inline logo layouts give the text block flexible width so it wraps beside the logo instead of overlapping', () => {
    const p = profile({ shopName: LONG, displayName: LONG })
    for (const [kind, cfg] of [['receipt58', { logoPosition: 'inline-left' }], ['receipt80', { logoPosition: 'inline-right' }], ['invoiceA5', { logoPosition: 'inline-left' }]] as const) {
      const { html } = renderInvoice(kind, sampleInvoiceDoc(p), cfg, logo())
      expect(html).toMatch(/\.(head-text|top-text)\{flex:1 1 0;min-width:0/)
      expect(html).toMatch(/\.logo-side\{flex:0 0 auto/)
    }
    const a4 = renderInvoice('invoiceA4', sampleInvoiceDoc(p), {}, logo()).html
    expect(a4).toMatch(/\.hb-logo\{width:1%;white-space:nowrap/) // logo cell shrinks to the image only
    expect(a4).toMatch(/\.hb-main\{vertical-align:middle;width:99%/)
  })
  it('logo width is capped to a share of the printable width when inline', () => {
    const html = renderInvoice('receipt58', sampleInvoiceDoc(profile()), { logoPosition: 'inline-left', logoWidthMm: 60 }, logo()).html
    // 48 mm printable * 0.42 = 20.16
    expect(html).toMatch(/style="width:20\.16mm;height:auto;max-width:none"/)
  })
  it('labels wrap the shop name and product too', () => {
    const html = renderLabels('label_barcode', profile({ shopName: NOSPACE, displayName: NOSPACE }), {}, null, [
      { name: TAMIL, variant: LONG, sku: 'S1', barcode: '8901234567890', mrp: 10000, price: 9000, copies: 1 }
    ]).html
    expect(html).toMatch(/overflow-wrap:anywhere/)
    // the shop name is never ellipsised / clipped: it shrinks to fit and wraps (only the fixed-size label cell and the line-clamped product name hide overflow)
    expect(html).not.toMatch(/\.shop-name\{[^}]*overflow\s*:\s*hidden/)
    expect(html).toMatch(/class="shop-name" style="font-size:[\d.]+pt"/)
  })
})

describe('logo placement', () => {
  it('prints the logo with aspect ratio preserved: only width is emitted, height:auto', () => {
    const { html } = renderInvoice('receipt80', sampleInvoiceDoc(profile()), {}, logo(400, 100))
    expect(html).toMatch(/<img class="logo" alt="" src="data:image\/png;base64,[^"]+" style="width:32mm;height:auto;max-width:100%">/)
  })
  it('follows the profile logo settings (width, alignment, position)', () => {
    const p = profile({ logoSettings: { visible: true, widthMm: 20, heightMm: 0, alignment: 'right', position: 'inline-right' } })
    const html = renderInvoice('receipt80', sampleInvoiceDoc(p), {}, logo(400, 200)).html
    expect(html).toMatch(/width:20mm;height:auto/)
    expect(html).toMatch(/<div class="logo-side"><img/)
    expect(html.indexOf('class="logo"')).toBeGreaterThan(html.indexOf('class="head-text"'))
  })
  it('profile height drives the width when only height is set (never stretched)', () => {
    const p = profile({ logoSettings: { visible: true, widthMm: 0, heightMm: 10, alignment: 'center', position: 'top' } })
    expect(renderInvoice('receipt80', sampleInvoiceDoc(p), {}, logo(400, 200)).html).toMatch(/width:20mm;height:auto/)
  })
  it('hides the logo when the profile or the template says so, or when there is none', () => {
    const doc = sampleInvoiceDoc(profile())
    expect(renderInvoice('receipt80', doc, {}, null).html).not.toContain('<img')
    expect(renderInvoice('receipt80', doc, { logoEnabled: false }, logo()).html).not.toContain('<img')
    const hidden = sampleInvoiceDoc(profile({ logoSettings: { visible: false, widthMm: 0, heightMm: 0, alignment: 'center', position: 'top' } }))
    expect(renderInvoice('receipt80', hidden, {}, logo()).html).not.toContain('<img')
  })
  it('template overrides the profile logo size and position', () => {
    const html = renderInvoice('invoiceA4', sampleInvoiceDoc(profile()), { logoWidthMm: 50, logoPosition: 'inline-right' }, logo(400, 200)).html
    expect(html).toMatch(/width:50mm;height:auto/)
    expect(html.indexOf('class="logo"')).toBeGreaterThan(html.indexOf('class="hb-main"'))
  })
})

describe('template options', () => {
  const doc = sampleInvoiceDoc(profile())
  it('hides address / phone / GSTIN / footer on request', () => {
    const html = renderInvoice('receipt58', doc, { showAddress: false, showPhone: false, showGstin: false, showFooter: false }, null).html
    expect(html).not.toContain('12 Market Road')
    expect(html).not.toContain('9876543210')
    expect(html).not.toContain('33ABCDE')
    expect(html).not.toContain('Thank you, visit again')
  })
  it('custom footer text overrides the profile footer', () => {
    expect(renderInvoice('receipt80', doc, { footerText: 'Exchange within 7 days' }, null).html).toContain('Exchange within 7 days')
  })
  it('font size, margins, spacing and line spacing flow into the CSS', () => {
    const html = renderInvoice('receipt58', doc, { fontSizePt: 9, lineHeight: 1.6, marginLeftMm: 3, marginRightMm: 3, spacingMm: 4, shopNameSizePt: 13, shopNameAlign: 'left' }, null).html
    expect(html).toContain('font-size:9pt;line-height:1.6')
    expect(html).toContain('padding:2mm 3mm 6mm 3mm')
    expect(html).toContain('margin:4mm 0')
    expect(html).toContain('.shop-name{font-size:13pt;font-weight:700;text-align:left')
  })
  it('normalizeConfig clamps junk and drops unknown keys', () => {
    const c = normalizeConfig('receipt58', { fontSizePt: 999, marginLeftMm: -4, logoPosition: 'nowhere', evil: '<script>', shopNameAlign: 'center', footerText: 'x'.repeat(5000) })
    expect(c.fontSizePt).toBe(40)
    expect(c.marginLeftMm).toBe(0)
    expect(c.logoPosition).toBe('profile')
    expect(c).not.toHaveProperty('evil')
    expect(c.footerText.length).toBe(400)
    expect(normalizeConfig('invoiceA4', 'garbage')).toEqual(defaultConfig('invoiceA4'))
  })
})

describe('HTML escaping / XSS', () => {
  const evil = '<img src=x onerror=alert(1)><script>alert(2)</script>"\'&'
  it('every profile + document value is escaped in every layout', () => {
    const p = profile({ shopName: evil, displayName: evil, legalName: evil + '2', address: evil, city: evil, phone: evil, email: evil, website: evil, gstin: evil, footerText: evil })
    const doc = { ...sampleInvoiceDoc(p), customerName: evil, cashierName: evil, posName: evil, invoiceNumber: evil, lines: [{ ...sampleInvoiceDoc(p).lines[0], name: evil, sku: evil, hsn: evil }] }
    for (const kind of INVOICES) {
      const html = renderInvoice(kind, doc, { footerText: evil, terms: evil }, null).html
      expect(html, kind).not.toContain('<script>')
      expect(html, kind).not.toMatch(/<img src=x/)
      expect(html, kind).toContain('&lt;script&gt;')
    }
  })
  it('labels and reports escape too', () => {
    const p = profile({ shopName: evil, displayName: evil })
    const l = renderLabels('label_product', p, {}, null, [{ name: evil, variant: evil, sku: evil, barcode: evil, mrp: 1, price: 1, copies: 1 }]).html
    expect(l).not.toContain('<script>')
    expect(l).not.toMatch(/<img src=x/)
    const r = renderReport('report_sales', p, {}, null, { title: evil, subtitle: evil, columns: [{ key: 'a', header: evil }], rows: [{ a: evil }], totals: { a: evil } }).html
    expect(r).not.toContain('<script>')
    expect(r).not.toMatch(/<img src=x/)
  })
  it('barcode svg contains only generated shapes', () => {
    const s = barcodeSvg('"><script>alert(1)</script>', { heightMm: 9 })
    expect(s).not.toContain('<script>')
  })
})

describe('Unicode', () => {
  it('Tamil text round-trips through every layout byte for byte', () => {
    const t = { name: 'ஸ்ரீ வேல்முருகன் பட்டாசு', addr: 'பிள்ளையார் கோவில் தெரு', foot: 'நன்றி! மீண்டும் வருக', item: 'மத்தாப்பு பெட்டி' }
    const p = profile({ shopName: t.name, displayName: t.name, address: t.addr, footerText: t.foot })
    const doc = sampleInvoiceDoc(p)
    doc.lines[0].name = t.item
    for (const kind of INVOICES) {
      const html = renderInvoice(kind, doc, {}, null).html
      for (const v of Object.values(t)) expect(html, kind).toContain(v)
      expect(html).toContain('<meta charset="utf-8">')
      expect(html).toMatch(/Nirmala UI/) // font fallback for Tamil glyphs
    }
  })
})

describe('labels', () => {
  const items = [{ name: 'Rocket', variant: 'Large', sku: 'RK-1', barcode: '8901234567890', mrp: 25000, price: 22000, copies: 3 }]
  it('barcode label has shop name, product, variant, inline SVG barcode, MRP and price', () => {
    const { html, widthMm, heightMm } = renderLabels('label_barcode', profile(), {}, null, items)
    expect((html.match(/class="label bl"/g) ?? []).length).toBe(3)
    for (const s of ['Acme Traders', 'Rocket', 'Large', '<svg class="barcode"', '8901234567890', 'MRP ₹250.00', '₹220.00']) expect(html).toContain(s)
    expect(widthMm).toBe(50)
    expect(heightMm).toBe(25)
    expect(html).toContain('@page{size:50mm 25mm;margin:0}')
  })
  it('product label is a different layout with logo, SKU and large price', () => {
    const { html } = renderLabels('label_product', profile(), {}, logo(300, 300), items)
    expect(html).toContain('class="label pl"')
    expect(html).toContain('<img class="logo"')
    expect(html).toContain('SKU RK-1')
    expect(html).toContain('class="price"')
    expect(html).toContain('<s>₹250.00</s>')
  })
  it('falls back to CODE128 for non-EAN codes and falls back to SKU when no barcode', () => {
    expect(barcodeSvg('ABC-123', { heightMm: 8 })).toContain('<svg')
    expect(barcodeSvg('', { heightMm: 8 })).toBe('')
    const { html } = renderLabels('label_barcode', profile(), {}, null, [{ ...items[0], barcode: '' }])
    expect(html).toContain('RK-1')
    expect(html).toContain('<svg class="barcode"')
  })
  it('qr svg renders', () => {
    expect(qrSvg('upi://pay?pa=x@y', 20)).toMatch(/^<svg class="qr"/)
  })
})

describe('report header', () => {
  const spec = { title: 'Sales Report', subtitle: '01/04/2026 - 30/04/2026', columns: [{ key: 'd', header: 'Date', format: 'date' as const }, { key: 'n', header: 'Bills', format: 'int' as const }, { key: 'a', header: 'Amount', format: 'money' as const }], rows: [{ d: Date.UTC(2026, 3, 5), n: 3, a: 123456 }], totals: { n: 3, a: 123456 } }
  it('renders logo, shop name, address, phone, GSTIN, title, period and table', () => {
    const { html } = renderReport('report_sales', profile(), {}, logo(), spec)
    for (const s of ['Acme Traders', '12 Market Road', 'Madurai', '9876543210', '33ABCDE1234F1Z5', 'Sales Report', '01/04/2026 - 30/04/2026', '₹1,234.56', '<img class="logo"', '<tfoot>']) expect(html).toContain(s)
  })
  it('honours ReportHeaderSettings', () => {
    const p = profile({ headerSettings: { showLogo: false, showShopName: false, showAddress: false, showPhone: false, showGstin: false } })
    const html = renderReport('report_sales', p, {}, logo(), spec).html
    expect(html).not.toContain('<img')
    expect(html).not.toContain('Acme Traders')
    expect(html).not.toContain('12 Market Road')
    expect(html).not.toContain('9876543210')
    expect(html).not.toContain('33ABCDE')
    expect(html).toContain('Sales Report')
  })
})

describe('test page + calibration', () => {
  it('prints logo, shop name, address and a mm ruler/grid for each paper', () => {
    for (const paper of ['58', '80', 'A4', 'A5', 'label'] as const) {
      const { html } = renderTestPage(paper, profile(), {}, logo())
      for (const s of ['Acme Traders', '12 Market Road', 'class="ruler"', 'class="grid"', 'TEST PRINT', '<img class="logo"']) expect(html, paper).toContain(s)
    }
  })
  it('prepareHtml adds CSP and calibration offsets/scale', () => {
    const out = prepareHtml('<html><head><title>x</title></head><body>b</body></html>', { offsetXmm: 2, offsetYmm: -1.5, scalePct: 95 })
    expect(out).toContain('Content-Security-Policy')
    expect(out).toContain('left:2mm;top:-1.5mm;zoom:0.95')
    expect(prepareHtml('<html><head></head></html>', {})).not.toContain('calibration')
    expect(parseCalibration({ offsetXmm: 999, scalePct: 1 })).toMatchObject({ offsetXmm: 20, scalePct: 50, silent: true })
  })
})

describe('no hard-coded shop data anywhere in the printing / profile sources', () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f)
      return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(f) ? [p] : []
    })
  const files = ['src/main/modules/printing', 'src/main/modules/businessProfile', 'src/renderer/modules/printing', 'src/renderer/modules/businessProfile'].flatMap((d) => walk(join(process.cwd(), d)))
  const FORBIDDEN = [/velmayil/i, /lakshmi/i, /fireworks/i, /crackers/i, /sivakasi/i, /murugan/i, /\bGSTIN:\s*\d{2}[A-Z]{5}/, /\b\d{10}\b/]
  it('scans a non-trivial number of files', () => expect(files.length).toBeGreaterThan(10))
  it('contains no shop-name / gstin / phone literals', () => {
    const hits: string[] = []
    for (const f of files) {
      const src = readFileSync(f, 'utf8')
      for (const re of FORBIDDEN) if (re.test(src)) hits.push(`${f}: ${re}`)
    }
    expect(hits).toEqual([])
  })
  it('default template configs contain no shop name', () => {
    for (const k of TEMPLATE_KINDS) {
      const vals = Object.values(defaultConfig(k)).filter((v) => typeof v === 'string').join(' ')
      expect(vals).not.toMatch(/shop|traders|lakshmi/i)
    }
  })
  it('layout output with an empty-ish profile contains only the profile values', () => {
    const p = profile({ shopName: 'ZZZ', displayName: 'ZZZ', legalName: '', address: '', city: '', state: '', pinCode: '', phone: '', email: '', website: '', gstin: '', pan: '', footerText: '' })
    for (const kind of INVOICES) {
      const text = renderInvoice(kind, sampleInvoiceDoc(p), {}, null).html.replace(/<style>[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ')
      expect(text).toContain('ZZZ')
      expect(text).not.toMatch(/Acme|Test Shop/)
    }
  })
})

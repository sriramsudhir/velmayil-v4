import { formatINR } from '@shared/money'
import type { BusinessProfile, InvoiceDoc } from '@shared/types'
import { computeLogoSize } from '../businessProfile/imageTools'
import { qrSvg } from './barcode'
import { esc, Safe } from './mustache'
import type { TemplateConfig, TemplateKind } from './config'

/** Builds the data model ("variables") handed to the layout templates. Pure: DB access happens elsewhere. */

export interface InvoiceDocExt extends InvoiceDoc {
  pricesIncludeTax?: boolean
  originalInvoiceNumber?: string
}
export interface LogoSource {
  widthPx: number
  heightPx: number
  dataUri(original?: boolean): string
}

const pad = (n: number) => String(n).padStart(2, '0')
export const fmtDate = (ms: number) => {
  const d = new Date(ms)
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`
}
export const fmtTime = (ms: number) => {
  const d = new Date(ms)
  const h = d.getHours()
  return `${pad(h % 12 || 12)}:${pad(d.getMinutes())} ${h < 12 ? 'AM' : 'PM'}`
}
export const fmtDateTime = (ms: number) => `${fmtDate(ms)} ${fmtTime(ms)}`
export const methodLabel = (m: string) => (m === 'upi' ? 'UPI' : m ? m.charAt(0).toUpperCase() + m.slice(1) : '')
const pct = (bp: number) => `${(bp / 100).toFixed(bp % 100 ? 2 : 0)}`

export const FONT_STACKS = {
  sans: "'Segoe UI','Nirmala UI','Noto Sans Tamil','Latha',Arial,sans-serif",
  mono: "Consolas,'Courier New','Nirmala UI','Noto Sans Tamil',monospace",
  serif: "Georgia,'Times New Roman','Nirmala UI','Noto Sans Tamil',serif"
} as const

const DEFAULT_LOGO_MM: Record<string, number> = { receipt58: 24, receipt80: 32, invoiceA4: 32, invoiceA5: 26, label_barcode: 9, label_product: 10, report: 18 }

export interface LogoPlan {
  html: Safe
  enabled: boolean
  mode: 'none' | 'top' | 'left' | 'right'
  align: 'left' | 'center' | 'right'
  widthMm: number
  heightMm: number
}

/** Decide whether/where/how big the logo is. Aspect ratio is always preserved (only width is emitted; height:auto). */
export function planLogo(kind: TemplateKind, profile: BusinessProfile, cfg: TemplateConfig, logo: LogoSource | null, extraVisible = true): LogoPlan {
  const none: LogoPlan = { html: new Safe(''), enabled: false, mode: 'none', align: 'center', widthMm: 0, heightMm: 0 }
  if (!logo || !cfg.logoEnabled || !profile.logoSettings.visible || !extraVisible) return none
  const printable = Math.max(10, (cfg.paperWidthMm || 210) - cfg.marginLeftMm - cfg.marginRightMm)
  const pos = cfg.logoPosition === 'profile' ? profile.logoSettings.position : cfg.logoPosition
  const align = cfg.logoAlign === 'profile' ? profile.logoSettings.alignment : cfg.logoAlign
  const own = cfg.logoWidthMm > 0 || cfg.logoHeightMm > 0
  const want = own ? { widthMm: cfg.logoWidthMm, heightMm: cfg.logoHeightMm } : { widthMm: profile.logoSettings.widthMm, heightMm: profile.logoSettings.heightMm }
  const key = kind.startsWith('report_') ? 'report' : kind
  const inline = pos !== 'top'
  const size = computeLogoSize(logo.widthPx, logo.heightPx, want, { defaultWidthMm: DEFAULT_LOGO_MM[key] ?? 25, maxWidthMm: inline ? printable * 0.42 : printable })
  const html = `<img class="logo" alt="" src="${esc(logo.dataUri())}" style="width:${size.widthMm}mm;height:auto;max-width:${inline ? "none" : "100%"}">`
  return { html: new Safe(html), enabled: true, mode: pos === 'top' ? 'top' : pos === 'inline-left' ? 'left' : 'right', align, widthMm: size.widthMm, heightMm: size.heightMm }
}

export function shopVars(p: BusinessProfile, logo: LogoPlan) {
  const cityLine = [p.city, [p.state, p.pinCode].filter(Boolean).join(' - ')].filter(Boolean).join(', ')
  return {
    logo: logo.html,
    name: p.shopName,
    legal_name: p.legalName,
    display_name: p.displayName || p.shopName,
    short_name: p.shortName || p.displayName || p.shopName,
    address: p.address,
    city: p.city,
    state: p.state,
    pin_code: p.pinCode,
    city_line: cityLine,
    phone: p.phone,
    email: p.email,
    website: p.website,
    gstin: p.gstin,
    pan: p.pan,
    footer: p.footerText
  }
}

export function logoVars(l: LogoPlan) {
  return {
    mode: l.mode,
    top: l.mode === 'top',
    left: l.mode === 'left',
    right: l.mode === 'right',
    inline: l.mode === 'left' || l.mode === 'right',
    enabledAny: l.enabled,
    align: l.align,
    widthMm: l.widthMm
  }
}

export function taxSummary(doc: InvoiceDocExt) {
  const byRate = new Map<number, { taxable: number; tax: number }>()
  for (const l of doc.lines) {
    const cur = byRate.get(l.taxRateBp) ?? { taxable: 0, tax: 0 }
    cur.tax += l.taxAmount
    cur.taxable += doc.pricesIncludeTax === false ? l.total : l.total - l.taxAmount
    byRate.set(l.taxRateBp, cur)
  }
  return [...byRate.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([bp, v]) => {
      const half = Math.floor(v.tax / 2)
      return { rate: pct(bp), half_rate: pct(bp / 2), taxable: formatINR(v.taxable), cgst: formatINR(half), sgst: formatINR(v.tax - half), tax: formatINR(v.tax) }
    })
}

export function upiLink(cfg: TemplateConfig, p: BusinessProfile, doc: InvoiceDoc): string {
  const q = (s: string) => encodeURIComponent(s)
  return `upi://pay?pa=${q(cfg.upiId)}&pn=${q(p.displayName || p.shopName)}&am=${(doc.total / 100).toFixed(2)}&cu=INR&tn=${q(doc.invoiceNumber)}`
}

/** Full variable set for an invoice/receipt layout. */
export function invoiceContext(kind: TemplateKind, doc: InvoiceDocExt, cfg: TemplateConfig, logoSrc: LogoSource | null) {
  const p = doc.profile
  const logo = planLogo(kind, p, cfg, logoSrc)
  const sym = kind !== 'receipt58'
  const money = (n: number) => formatINR(n, { symbol: sym })
  const footer = cfg.footerText.trim() || p.footerText
  const methods = [...new Set(doc.payments.map((x) => methodLabel(x.method)).filter(Boolean))].join(', ')
  const taxes = taxSummary(doc)
  const itemsQty = doc.lines.reduce((s, l) => s + l.qty, 0)
  const hasGst = !!p.gstin
  const qrOn = cfg.qrEnabled && !!cfg.upiId.trim()
  return {
    shop: shopVars(p, logo),
    logo: logoVars(logo),
    invoice: {
      number: doc.invoiceNumber,
      date: fmtDate(doc.createdAt),
      time: fmtTime(doc.createdAt),
      title: doc.isReturn ? 'CREDIT NOTE' : hasGst ? 'TAX INVOICE' : kind.startsWith('receipt') ? 'RECEIPT' : 'INVOICE',
      original_number: doc.originalInvoiceNumber ?? ''
    },
    pos: { name: doc.posName },
    cashier: { name: doc.cashierName },
    customer: { name: doc.customerName, phone: doc.customerPhone },
    sale: {
      subtotal: money(doc.subtotal),
      discount: money(doc.discount),
      tax: money(doc.tax),
      round_off: money(doc.roundOff),
      total: money(doc.total),
      items: doc.lines.length,
      qty: itemsQty
    },
    payment: {
      method: methods,
      received: money(doc.received),
      change: money(doc.change),
      lines: doc.payments.map((x) => ({ method: methodLabel(x.method), amount: money(x.amount), reference: x.reference ?? '' }))
    },
    lines: doc.lines.map((l) => ({
      name: l.name,
      sku: l.sku,
      hsn: l.hsn ?? '',
      qty: l.qty,
      rate: money(l.unitPrice),
      discount: l.discount ? money(l.discount) : '',
      tax_rate: pct(l.taxRateBp),
      tax: money(l.taxAmount),
      total: money(l.total)
    })),
    taxes,
    footer,
    terms: cfg.terms,
    qr: { enabled: qrOn, svg: new Safe(qrOn ? qrSvg(upiLink(cfg, p, doc), Math.min(34, (cfg.paperWidthMm - cfg.marginLeftMm - cfg.marginRightMm) * 0.5)) : ''), label: cfg.upiLabel, upi: cfg.upiId },
    show: {
      shopName: cfg.showShopName,
      legalName: cfg.showLegalName && !!p.legalName && p.legalName !== (p.displayName || p.shopName),
      address: cfg.showAddress && !!p.address,
      cityLine: cfg.showAddress && !!(p.city || p.state || p.pinCode),
      phone: cfg.showPhone && !!p.phone,
      email: cfg.showPhone && cfg.showEmail && !!p.email,
      website: cfg.showWebsite && !!p.website,
      gstin: cfg.showGstin && !!p.gstin,
      pan: cfg.showPan && !!p.pan,
      contact: cfg.showPhone && !!(p.phone || (cfg.showEmail && p.email) || (cfg.showWebsite && p.website)),
      customer: cfg.showCustomer && !!(doc.customerName || doc.customerPhone),
      customerPhone: !!doc.customerPhone,
      cashier: cfg.showCashier && !!doc.cashierName,
      pos: cfg.showPos && !!doc.posName,
      hsn: cfg.showHsn,
      discount: cfg.showDiscount && doc.discount > 0,
      lineDiscount: cfg.showDiscount && doc.lines.some((l) => l.discount > 0),
      tax: doc.tax > 0,
      taxSummary: cfg.showTaxSummary && taxes.length > 0 && doc.tax > 0,
      roundOff: doc.roundOff !== 0,
      payment: cfg.showPayment && doc.payments.length > 0,
      change: doc.change > 0,
      footer: cfg.showFooter && !!footer,
      terms: !!cfg.terms.trim(),
      original: !!doc.originalInvoiceNumber
    }
  }
}

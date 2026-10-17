import { formatINR } from '@shared/money'
import type { BusinessProfile } from '@shared/types'
import { barcodeSymbol, DEFAULT_DPI, dotMm, minModuleDots, type BarcodeSymbol } from './barcode'
import { isInvoiceKind, normalizeConfig, type InvoiceKind, type LabelKind, type Paper, type ReportKind, type TemplateConfig, type TemplateKind } from './config'
import { fmtDate, fmtDateTime, invoiceContext, logoVars, planLogo, shopVars, type InvoiceDocExt, type LogoSource } from './context'
import { INVOICE_LAYOUTS, LABEL_LAYOUTS, labelBoxMm, labelCellMm, REPORT_LAYOUT, TEST_LABEL_TEMPLATE, TEST_TEMPLATE, testCss, testLabelCss } from './layouts'
import { renderTemplate, Safe } from './mustache'

/**
 * The print engine: PURE functions (profile + data + config in, HTML out). No Electron, no DB, no I/O, so it runs and is
 * tested under plain Node. Shop identity only ever arrives through the BusinessProfile argument.
 */

export interface Rendered {
  html: string
  widthMm: number
  heightMm: number
  /** Things the user should know before printing (e.g. a barcode that does not fit the label). Absent when there are none. */
  warnings?: string[]
}

export function renderInvoice(kind: InvoiceKind, doc: InvoiceDocExt, rawConfig: unknown, logo: LogoSource | null): Rendered {
  const cfg = normalizeConfig(kind, rawConfig)
  const layout = INVOICE_LAYOUTS[kind]
  const ctx = invoiceContext(kind, doc, cfg, logo)
  const html = renderTemplate(layout.template, { ...ctx, css: layout.css(cfg) })
  return { html, widthMm: cfg.paperWidthMm, heightMm: cfg.paperHeightMm }
}

// ---------------------------------------------------------------------------- labels
export interface LabelItem {
  name: string
  variant: string
  sku: string
  barcode: string
  mrp: number
  price: number
  copies: number
  /** Unit label: `barcode` is a unique unit code (PREFIX-NNNN), always drawn as Code 128 (EAN-13 is numeric only). */
  unit?: boolean
}
const MAX_LABELS = 2000
const MAX_WARNINGS = 5

/** The printer the labels are meant for: its resolution and scale decide the bar widths (whole dots, see barcode.ts). */
export interface LabelPrinter { dpi?: number; scale?: number }

const mm2 = (n: number) => String(Math.round(n * 100) / 100)

/** Plain-language warning for a barcode that cannot be printed properly on this label, or null. */
export function barcodeWarning(sym: BarcodeSymbol, availMm: number, dpi: number = DEFAULT_DPI): string | null {
  if (sym.problem === 'too_long') {
    const need = (sym.modules + sym.quiet[0] + sym.quiet[1]) * minModuleDots(dpi) * dotMm(dpi)
    return `Barcode too long for this label width: "${sym.value}" needs ${mm2(need)} mm but the label has ${mm2(availMm)} mm for it. No barcode is printed for this code. Choose a wider label or use a shorter code.`
  }
  if (sym.problem === 'not_encodable') return `"${sym.value}" cannot be made into a barcode (only English letters, digits and common symbols can be encoded). No barcode is printed for this code.`
  if (sym.problem === 'narrow') return `"${sym.value}": the bars are very fine on this label (${mm2(sym.moduleMm)} mm each) and may not scan with every reader. A wider label prints them larger.`
  return null
}

export function renderLabels(kind: LabelKind, profile: BusinessProfile, rawConfig: unknown, logo: LogoSource | null, items: LabelItem[], printer: LabelPrinter = {}): Rendered {
  const cfg = normalizeConfig(kind, rawConfig)
  const dpi = printer.dpi ?? DEFAULT_DPI
  const warnings: string[] = []
  let moreWarnings = 0
  const plan = planLogo(kind, profile, cfg, logo)
  const labels: unknown[] = []
  const cell = labelCellMm(cfg)
  const innerW = Math.max(5, cell.w - cfg.marginLeftMm - cfg.marginRightMm)
  const shopName = profile.displayName || profile.shopName
  const logoMm = plan.enabled ? plan.widthMm + 1 : 0
  const shopPt = fitPt(shopName, cfg.shopNameSizePt, innerW - logoMm, 1, true)
  const innerH = Math.max(5, labelBoxMm(cfg).h - cfg.marginTopMm - cfg.marginBottomMm)
  // where the bars' box starts, from the left edge of the page (label sheets: the first column)
  const sheet = kind === 'label_barcode' && cfg.sheetCols > 0 && cfg.sheetRows > 0
  const originMm = (sheet ? Math.max(0, (cfg.paperWidthMm - cfg.sheetCols * cell.w) / 2) : 0) + cfg.marginLeftMm
  for (const it of items) {
    // the bars and the readable line under them always carry the same string
    const code = (it.barcode || it.sku).trim()
    const symbol = (heightMm: number) => barcodeSymbol(code, { heightMm, format: it.unit ? 'CODE128' : cfg.barcodeFormat, maxWidthMm: innerW, dpi, scale: printer.scale, originMm })
    const sized = symbol(cfg.barcodeHeightMm)
    const warn = barcodeWarning(sized, innerW, dpi)
    if (warn && !warnings.includes(warn)) {
      if (warnings.length < MAX_WARNINGS) warnings.push(warn)
      else moreWarnings++
    }
    // bars shorter than 6 mm or 15 % of the symbol width are hard to hit with a scanner: the bar height does not go below that
    const barMin = Math.min(cfg.barcodeHeightMm, Math.max(6, sized.widthMm * 0.15))
    const name = kind === 'label_barcode' && !cfg.showProductName ? '' : it.name
    const variant = kind === 'label_barcode' && !cfg.showVariant ? '' : it.variant
    const nameText = [name, variant].filter(Boolean).join(' ')
    const mrp = formatINR(it.mrp)
    const price = formatINR(it.price)
    // ---- vertical budget (mm): head + name + bars + digits + prices must fit the label; the barcode gives way before the name
    const pt = cfg.fontSizePt
    const row = (p: number) => p * PT_MM * 1.12
    const head = cfg.showShopName || plan.enabled ? Math.max(plan.enabled ? plan.heightMm : 0, cfg.showShopName ? row(shopPt) * Math.ceil(([...shopName].length * shopPt * PT_MM * 0.62) / Math.max(1, innerW - logoMm) || 1) : 0) : 0
    const codeH = cfg.showBarcodeText ? row(Math.max(4.5, pt - 0.5)) * Math.ceil(([...code].length * Math.max(4.5, pt - 0.5) * PT_MM * 0.75) / innerW) : 0
    const priceW = (cfg.showMrp ? ([...mrp].length + 4) * pt * PT_MM * 0.55 : 0) + (cfg.showPrice ? [...price].length * (pt + 3) * PT_MM * 0.6 : 0) + 1.5
    const pricesH = cfg.showMrp || cfg.showPrice ? row(cfg.showPrice ? pt + 3 : pt) * (priceW > innerW && cfg.showMrp && cfg.showPrice ? 2 : 1) : 0
    const blocks = (head ? 1 : 0) + (nameText ? 1 : 0) + 1 + (codeH ? 1 : 0) + (pricesH ? 1 : 0)
    const free = innerH - head - codeH - pricesH - Math.max(0, blocks - 1) * cfg.spacingMm
    let barH = cfg.barcodeHeightMm
    let lines = 0
    if (nameText) {
      const lh = row(pt)
      const cpl = innerW / (pt * PT_MM * 0.62)
      const need = Math.max(1, Math.min(cfg.nameMaxLines, Math.ceil([...nameText].length / cpl)))
      lines = Math.floor((free - barH) / lh)
      // the barcode gives way (never below its minimum height) before the name has to shrink or lose a line
      while (lines < need && barH > barMin) {
        barH = Math.max(barMin, barH - 0.5)
        lines = Math.floor((free - barH) / lh)
      }
      lines = Math.max(1, Math.min(cfg.nameMaxLines, lines))
    } else barH = Math.min(barH + Math.max(0, free - barH) * 0.5, free)
    barH = Math.round(Math.max(3, barH) * 10) / 10
    const product = {
      name,
      variant,
      has_name: !!nameText,
      name_pt: fitPt(nameText, pt, innerW, Math.max(1, lines), true, Math.max(4, pt * 0.6)),
      lines: Math.max(1, lines),
      shop_pt: shopPt,
      sku: it.sku,
      code,
      barcode_svg: new Safe(symbol(kind === 'label_barcode' ? barH : cfg.barcodeHeightMm).svg),
      mrp,
      price
    }
    const n = Math.max(1, Math.min(500, Math.floor(it.copies || 1)))
    for (let i = 0; i < n && labels.length < MAX_LABELS; i++) labels.push({ product })
  }
  const ctxShow = {
    shopName: cfg.showShopName,
    head: cfg.showShopName || plan.enabled,
    mrp: cfg.showMrp,
    price: cfg.showPrice,
    priceRow: cfg.showMrp || cfg.showPrice,
    code: cfg.showBarcodeText,
    sku: cfg.showSku
  }
  // pages: a label sheet holds cols x rows labels per page; otherwise one label per page
  const perPage = cfg.sheetCols > 0 && cfg.sheetRows > 0 && kind === 'label_barcode' ? cfg.sheetCols * cfg.sheetRows : 1
  const pages: { labels: unknown[] }[] = []
  for (let i = 0; i < labels.length; i += perPage) pages.push({ labels: labels.slice(i, i + perPage) })
  const layout = LABEL_LAYOUTS[kind]
  const html = renderTemplate(layout.template, { shop: shopVars(profile, plan), logo: logoVars(plan), show: ctxShow, labels, pages, css: layout.css(cfg) })
  if (moreWarnings) warnings.push(`${moreWarnings} more code${moreWarnings === 1 ? ' has' : 's have'} a barcode problem on this label size.`)
  return { html, widthMm: cfg.paperWidthMm, heightMm: cfg.paperHeightMm, ...(warnings.length ? { warnings } : {}) }
}

const PT_MM = 25.4 / 72
/**
 * Font size (pt) at which `text` fits `lines` lines of `widthMm`: shrinks (never below 75 % of the base / 4.5 pt) when the
 * text is too long; the layout then line-clamps as a last resort. Heuristic average glyph width 0.6 em (bold, wide scripts).
 */
export function fitPt(text: string, basePt: number, widthMm: number, lines: number, bold = false, minPt = Math.max(4.5, basePt * 0.75)): number {
  const len = [...text].length
  if (!len || widthMm <= 0) return basePt
  const cpl = widthMm / (basePt * PT_MM * (bold ? 0.62 : 0.55))
  if (len <= cpl * lines) return basePt
  const min = Math.min(basePt, minPt)
  return Math.round(Math.max(min, Math.min(basePt, (basePt * cpl * lines) / len)) * 10) / 10
}

// ---------------------------------------------------------------------------- reports
export interface ReportColumn { key: string; header: string; align?: 'left' | 'right' | 'center'; format?: 'money' | 'int' | 'date' | 'datetime' | 'text' }
export interface ReportSpec {
  title: string
  subtitle?: string
  columns: ReportColumn[]
  rows: Record<string, unknown>[]
  totals?: Record<string, unknown>
}

const MAX_REPORT_ROWS = 20000
function cell(col: ReportColumn, v: unknown) {
  let text: string
  if (v === null || v === undefined) text = ''
  else if (col.format === 'money' && typeof v === 'number') text = formatINR(v)
  else if (col.format === 'date' && typeof v === 'number') text = fmtDate(v)
  else if (col.format === 'datetime' && typeof v === 'number') text = fmtDateTime(v)
  else text = String(v)
  const align = col.align ?? (typeof v === 'number' || col.format === 'money' || col.format === 'int' ? 'right' : 'left')
  return { v: text, align }
}

export function renderReport(kind: ReportKind, profile: BusinessProfile, rawConfig: unknown, logo: LogoSource | null, spec: ReportSpec): Rendered {
  const cfg = normalizeConfig(kind, rawConfig)
  const hs = profile.headerSettings
  const plan = planLogo(kind, profile, cfg, logo, hs.showLogo)
  const columns = spec.columns.map((c) => ({ header: c.header, align: c.align ?? (c.format === 'money' || c.format === 'int' ? 'right' : 'left') }))
  const rows = spec.rows.slice(0, MAX_REPORT_ROWS).map((r) => ({ cells: spec.columns.map((c) => cell(c, r[c.key])) }))
  const totals = spec.totals ? { cells: spec.columns.map((c) => cell(c, spec.totals![c.key])) } : null
  const show = {
    shopName: cfg.showShopName && hs.showShopName,
    address: cfg.showAddress && hs.showAddress && !!profile.address,
    cityLine: cfg.showAddress && hs.showAddress && !!(profile.city || profile.state || profile.pinCode),
    phone: cfg.showPhone && hs.showPhone && !!profile.phone,
    gstin: cfg.showGstin && hs.showGstin && !!profile.gstin,
    title: cfg.showReportTitle && !!spec.title,
    period: cfg.showPeriod && !!spec.subtitle
  }
  const html = renderTemplate(REPORT_LAYOUT.template, {
    shop: shopVars(profile, plan),
    logo: logoVars(plan),
    show,
    report: { title: spec.title, subtitle: spec.subtitle ?? '', printed_at: fmtDateTime(Date.now()) },
    columns,
    rows,
    totals,
    css: REPORT_LAYOUT.css(cfg)
  })
  // the page as it is read: landscape swaps the sides (a report sheet always has a height, A4 unless the template says otherwise)
  const long = cfg.paperHeightMm || 297
  return { html, widthMm: cfg.landscape ? long : cfg.paperWidthMm, heightMm: cfg.landscape ? cfg.paperWidthMm : long }
}

// ---------------------------------------------------------------------------- test page
export const TEST_KIND: Record<Paper, TemplateKind> = { '58': 'receipt58', '80': 'receipt80', A4: 'invoiceA4', A5: 'invoiceA5', label: 'label_barcode' }

/** Code printed on the test page: scanning it must give exactly this text. */
export const TEST_BARCODE = 'TEST-1234'

/**
 * `printer`: the profile the page is printed with. The page then also shows the darkness level with small text and a solid
 * bar to judge it by, and a sample barcode drawn for that printer's resolution: if it scans, product labels will too.
 */
export function renderTestPage(paper: Paper, profile: BusinessProfile, rawConfig: unknown, logo: LogoSource | null, printer: LabelPrinter & { darkness?: number } = {}): Rendered {
  const kind = TEST_KIND[paper]
  const cfg: TemplateConfig = normalizeConfig(kind, rawConfig)
  const plan = planLogo(kind, profile, { ...cfg, logoEnabled: true }, logo)
  const printable = Math.max(10, Math.floor((cfg.paperWidthMm - cfg.marginLeftMm - cfg.marginRightMm) * 10) / 10)
  const ticks: { left: number; major: boolean; label: string }[] = []
  for (let mm = 0; mm <= printable; mm += 5) ticks.push({ left: mm, major: mm % 10 === 0, label: mm % 10 === 0 && mm > 0 ? String(mm) : '' })
  const show = {
    address: !!profile.address && cfg.showAddress,
    cityLine: !!(profile.city || profile.state) && cfg.showAddress,
    phone: !!profile.phone && cfg.showPhone
  }
  const onLabel = paper === 'label' && cfg.paperHeightMm > 0 && !(cfg.sheetCols > 0 && cfg.sheetRows > 0)
  const html = renderTemplate(onLabel ? TEST_LABEL_TEMPLATE : TEST_TEMPLATE, {
    shop: shopVars(profile, plan),
    logo: logoVars(plan),
    show,
    test: {
      paper: paper === 'label' ? 'LABEL' : paper === 'A4' || paper === 'A5' ? paper : `${paper} mm`, width: `${cfg.paperWidthMm} mm`, height: cfg.paperHeightMm ? `${cfg.paperHeightMm} mm` : 'auto', printable, when: fmtDateTime(Date.now()),
      darkness: printer.darkness ?? 5, dpi: printer.dpi ?? DEFAULT_DPI, code: TEST_BARCODE,
      barcode: new Safe(barcodeSymbol(TEST_BARCODE, { heightMm: onLabel ? Math.max(4, Math.min(8, cfg.paperHeightMm * 0.28)) : 8, format: 'CODE128', maxWidthMm: Math.min(printable, 60), dpi: printer.dpi, scale: printer.scale, originMm: cfg.marginLeftMm }).svg)
    },
    ticks,
    css: onLabel ? testLabelCss(cfg, printable) : testCss(cfg, printable)
  })
  return { html, widthMm: cfg.paperWidthMm, heightMm: cfg.paperHeightMm }
}

export { isInvoiceKind }

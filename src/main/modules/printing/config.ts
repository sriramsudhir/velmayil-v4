/** Template kinds, per-template configuration (print_templates.config_json) and its defaults. No shop data lives here. */

export const TEMPLATE_KINDS = [
  'receipt58', 'receipt80', 'invoiceA4', 'invoiceA5', 'label_barcode', 'label_product', 'report_sales', 'report_purchase', 'report_inventory'
] as const
export type TemplateKind = (typeof TEMPLATE_KINDS)[number]
export type InvoiceKind = 'receipt58' | 'receipt80' | 'invoiceA4' | 'invoiceA5'
export type LabelKind = 'label_barcode' | 'label_product'
export type ReportKind = 'report_sales' | 'report_purchase' | 'report_inventory'
export type Paper = '58' | '80' | 'A4' | 'A5' | 'label'

export const isInvoiceKind = (k: string): k is InvoiceKind => ['receipt58', 'receipt80', 'invoiceA4', 'invoiceA5'].includes(k)
export const isLabelKind = (k: string): k is LabelKind => k === 'label_barcode' || k === 'label_product'
export const isReportKind = (k: string): k is ReportKind => k.startsWith('report_')

export const KIND_LABELS: Record<TemplateKind, string> = {
  receipt58: '58 mm receipt', receipt80: '80 mm receipt', invoiceA4: 'A4 invoice', invoiceA5: 'A5 invoice',
  label_barcode: 'Barcode label', label_product: 'Product label',
  report_sales: 'Sales report header', report_purchase: 'Purchase report header', report_inventory: 'Inventory report header'
}

export const paperForKind = (k: TemplateKind): Paper =>
  k === 'receipt58' ? '58' : k === 'receipt80' ? '80' : k === 'invoiceA5' ? 'A5' : isLabelKind(k) ? 'label' : 'A4'

export type Align = 'left' | 'center' | 'right'

export interface TemplateConfig {
  // ---- page
  paperWidthMm: number // 0 = not applicable
  paperHeightMm: number // 0 = auto (continuous roll / A-series default)
  landscape: boolean
  marginTopMm: number
  marginRightMm: number
  marginBottomMm: number
  marginLeftMm: number
  // ---- typography & spacing
  fontSizePt: number
  lineHeight: number
  spacingMm: number // gap between sections
  fontFamily: 'sans' | 'mono' | 'serif'
  // ---- logo ('profile' = follow the Shop Profile logo settings; mm 0 = follow profile / template default)
  logoEnabled: boolean
  logoWidthMm: number
  logoHeightMm: number
  logoPosition: 'profile' | 'top' | 'inline-left' | 'inline-right'
  logoAlign: 'profile' | Align
  // ---- shop block
  showShopName: boolean
  shopNameSizePt: number
  shopNameAlign: Align
  shopNameBold: boolean
  showLegalName: boolean
  showAddress: boolean
  showPhone: boolean
  showEmail: boolean
  showWebsite: boolean
  showGstin: boolean
  showPan: boolean
  // ---- body
  showCustomer: boolean
  showCashier: boolean
  showPos: boolean
  showHsn: boolean
  showDiscount: boolean
  showTaxSummary: boolean
  showPayment: boolean
  showFooter: boolean
  footerText: string // '' = use the Shop Profile footer
  terms: string
  // ---- receipt80 UPI / QR
  qrEnabled: boolean
  upiId: string
  upiLabel: string
  // ---- labels
  showMrp: boolean
  showPrice: boolean
  showSku: boolean
  barcodeHeightMm: number
  barcodeFormat: 'auto' | 'CODE128' | 'EAN13'
  showProductName: boolean
  showVariant: boolean
  showBarcodeText: boolean
  /** Max product-name lines on a label (the name also shrinks to fit). */
  nameMaxLines: number
  /** One label's size when it differs from the page (label sheets); 0 = same as the paper size. */
  labelWidthMm: number
  labelHeightMm: number
  /** Label sheet grid (0 = one label per page). */
  sheetCols: number
  sheetRows: number
  /** Preset id chosen in the label-size dialog (informational). */
  labelPreset: string
  // ---- reports
  showReportTitle: boolean
  showPeriod: boolean
}

const BASE: TemplateConfig = {
  paperWidthMm: 210, paperHeightMm: 0, landscape: false,
  marginTopMm: 10, marginRightMm: 10, marginBottomMm: 10, marginLeftMm: 10,
  fontSizePt: 10, lineHeight: 1.35, spacingMm: 3, fontFamily: 'sans',
  logoEnabled: true, logoWidthMm: 0, logoHeightMm: 0, logoPosition: 'profile', logoAlign: 'profile',
  showShopName: true, shopNameSizePt: 16, shopNameAlign: 'left', shopNameBold: true, showLegalName: true,
  showAddress: true, showPhone: true, showEmail: true, showWebsite: true, showGstin: true, showPan: false,
  showCustomer: true, showCashier: true, showPos: true, showHsn: true, showDiscount: true, showTaxSummary: true, showPayment: true,
  showFooter: true, footerText: '', terms: '',
  qrEnabled: false, upiId: '', upiLabel: 'Scan to pay',
  showMrp: true, showPrice: true, showSku: false, barcodeHeightMm: 9, barcodeFormat: 'auto',
  showProductName: true, showVariant: true, showBarcodeText: true, nameMaxLines: 2, labelWidthMm: 0, labelHeightMm: 0, sheetCols: 0, sheetRows: 0, labelPreset: '',
  showReportTitle: true, showPeriod: true
}

const DEFAULTS: Record<TemplateKind, Partial<TemplateConfig>> = {
  receipt58: {
    paperWidthMm: 58, marginTopMm: 2, marginRightMm: 5, marginBottomMm: 6, marginLeftMm: 5, fontSizePt: 7, lineHeight: 1.25, spacingMm: 1.5,
    fontFamily: 'mono', shopNameSizePt: 10, shopNameAlign: 'center', logoWidthMm: 0, showHsn: false, showEmail: false, showWebsite: false,
    showLegalName: false, showTaxSummary: false, showPos: false
  },
  receipt80: {
    paperWidthMm: 80, marginTopMm: 3, marginRightMm: 4, marginBottomMm: 8, marginLeftMm: 4, fontSizePt: 9, lineHeight: 1.3, spacingMm: 2.5,
    fontFamily: 'sans', shopNameSizePt: 14, shopNameAlign: 'center', showHsn: false, showTaxSummary: true, showWebsite: false
  },
  invoiceA4: { paperWidthMm: 210, paperHeightMm: 297, fontSizePt: 10, shopNameSizePt: 20, shopNameAlign: 'left', logoPosition: 'inline-left', showPan: true, terms: 'Goods once sold will not be taken back or exchanged.' },
  invoiceA5: { paperWidthMm: 148, paperHeightMm: 210, marginTopMm: 8, marginRightMm: 8, marginBottomMm: 8, marginLeftMm: 8, fontSizePt: 8.5, shopNameSizePt: 15, shopNameAlign: 'left', logoPosition: 'inline-right', spacingMm: 2.5, showEmail: true, showWebsite: false },
  label_barcode: {
    paperWidthMm: 50, paperHeightMm: 25, marginTopMm: 1, marginRightMm: 1.5, marginBottomMm: 1, marginLeftMm: 1.5, fontSizePt: 6.5, lineHeight: 1.15,
    spacingMm: 0.5, shopNameSizePt: 6.5, shopNameAlign: 'center', logoEnabled: false, showSku: false, barcodeHeightMm: 9, labelPreset: '50x25'
  },
  label_product: {
    paperWidthMm: 60, paperHeightMm: 40, marginTopMm: 1.5, marginRightMm: 2, marginBottomMm: 1.5, marginLeftMm: 2, fontSizePt: 7.5, lineHeight: 1.2,
    spacingMm: 0.8, shopNameSizePt: 8, shopNameAlign: 'left', logoEnabled: true, logoWidthMm: 9, logoPosition: 'inline-left', showSku: true, barcodeHeightMm: 8
  },
  report_sales: { fontSizePt: 9, shopNameSizePt: 18, logoPosition: 'inline-left', logoWidthMm: 18, showEmail: false, showWebsite: false },
  report_purchase: { fontSizePt: 9, shopNameSizePt: 18, logoPosition: 'inline-left', logoWidthMm: 18, showEmail: false, showWebsite: false },
  report_inventory: { fontSizePt: 9, shopNameSizePt: 18, logoPosition: 'inline-left', logoWidthMm: 18, showEmail: false, showWebsite: false }
}

const ENUMS: Partial<Record<keyof TemplateConfig, readonly string[]>> = {
  fontFamily: ['sans', 'mono', 'serif'],
  logoPosition: ['profile', 'top', 'inline-left', 'inline-right'],
  logoAlign: ['profile', 'left', 'center', 'right'],
  shopNameAlign: ['left', 'center', 'right'],
  barcodeFormat: ['auto', 'CODE128', 'EAN13']
}
const RANGES: Partial<Record<keyof TemplateConfig, [number, number]>> = {
  paperWidthMm: [0, 500], paperHeightMm: [0, 1000], marginTopMm: [0, 40], marginRightMm: [0, 40], marginBottomMm: [0, 40], marginLeftMm: [0, 40],
  fontSizePt: [4, 40], lineHeight: [0.9, 3], spacingMm: [0, 20], logoWidthMm: [0, 150], logoHeightMm: [0, 150], shopNameSizePt: [4, 60], barcodeHeightMm: [3, 40],
  nameMaxLines: [1, 4], labelWidthMm: [0, 500], labelHeightMm: [0, 500], sheetCols: [0, 10], sheetRows: [0, 40]
}
const TEXT_LIMITS: Partial<Record<keyof TemplateConfig, number>> = { footerText: 400, terms: 800, upiId: 80, upiLabel: 60 }

export function defaultConfig(kind: TemplateKind): TemplateConfig {
  return { ...BASE, ...DEFAULTS[kind] }
}

/** Merge a stored/edited config over the kind's defaults, dropping unknown keys and clamping values. Never throws. */
export function normalizeConfig(kind: TemplateKind, raw: unknown): TemplateConfig {
  const def = defaultConfig(kind)
  const out: Record<string, unknown> = { ...def }
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (!(k in def)) continue
      const key = k as keyof TemplateConfig
      const dv = def[key]
      if (typeof dv === 'number') {
        const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v
        if (typeof n === 'number' && Number.isFinite(n)) {
          const [lo, hi] = RANGES[key] ?? [0, 1000]
          out[k] = Math.min(hi, Math.max(lo, n))
        }
      } else if (typeof dv === 'boolean') {
        if (typeof v === 'boolean') out[k] = v
      } else if (typeof dv === 'string') {
        if (typeof v === 'string') {
          const allowed = ENUMS[key]
          if (allowed) {
            if (allowed.includes(v)) out[k] = v
          } else out[k] = v.slice(0, TEXT_LIMITS[key] ?? 200)
        }
      }
    }
  }
  return out as unknown as TemplateConfig
}

/**
 * Barcode label sizes + the template-config derived from a size/options choice.
 * Shared by the renderer (size dialog) and tests; the print engine only ever sees the resulting TemplateConfig keys
 * (paperWidthMm, paperHeightMm, labelWidthMm, labelHeightMm, sheetCols, sheetRows, ...).
 */

export interface LabelSize {
  id: string
  label: string
  /** One label (cell) in mm. */
  widthMm: number
  heightMm: number
  /** A4 label sheet: `cols` x `rows` labels per page of `pageWidthMm` x `pageHeightMm`. */
  sheet?: { cols: number; rows: number; pageWidthMm: number; pageHeightMm: number }
}

export const LABEL_PRESETS: LabelSize[] = [
  { id: '50x25', label: '50 x 25 mm', widthMm: 50, heightMm: 25 },
  { id: '38x25', label: '38 x 25 mm', widthMm: 38, heightMm: 25 },
  { id: '40x30', label: '40 x 30 mm', widthMm: 40, heightMm: 30 },
  { id: '50x30', label: '50 x 30 mm', widthMm: 50, heightMm: 30 },
  { id: '60x40', label: '60 x 40 mm', widthMm: 60, heightMm: 40 },
  { id: '75x50', label: '75 x 50 mm', widthMm: 75, heightMm: 50 },
  { id: '100x50', label: '100 x 50 mm', widthMm: 100, heightMm: 50 },
  { id: '100x150', label: '100 x 150 mm', widthMm: 100, heightMm: 150 },
  { id: 'a4-3x8', label: 'A4 sheet 3 x 8 (24 labels, 70 x 36 mm)', widthMm: 70, heightMm: 36, sheet: { cols: 3, rows: 8, pageWidthMm: 210, pageHeightMm: 297 } }
]
export const CUSTOM_LABEL_ID = 'custom'
export const DEFAULT_LABEL_PRESET = '50x25'
export const CUSTOM_LIMITS = { minWidthMm: 20, maxWidthMm: 210, minHeightMm: 15, maxHeightMm: 297 }

export interface LabelOptions {
  /** Shop name line. */
  showShopName: boolean
  /** Shop logo (from the current business profile). */
  showLogo: boolean
  showProductName: boolean
  showVariant: boolean
  showMrp: boolean
  showPrice: boolean
  showBarcodeText: boolean
}
export const DEFAULT_LABEL_OPTIONS: LabelOptions = {
  showShopName: true, showLogo: false, showProductName: true, showVariant: true, showMrp: true, showPrice: true, showBarcodeText: true
}

export interface LabelChoice {
  presetId: string
  /** Used when presetId === 'custom'. */
  customWidthMm?: number
  customHeightMm?: number
}

export function resolveLabelSize(choice: LabelChoice): LabelSize {
  if (choice.presetId === CUSTOM_LABEL_ID) {
    const w = clamp(Number(choice.customWidthMm) || 50, CUSTOM_LIMITS.minWidthMm, CUSTOM_LIMITS.maxWidthMm)
    const h = clamp(Number(choice.customHeightMm) || 25, CUSTOM_LIMITS.minHeightMm, CUSTOM_LIMITS.maxHeightMm)
    return { id: CUSTOM_LABEL_ID, label: `Custom ${w} x ${h} mm`, widthMm: w, heightMm: h }
  }
  return LABEL_PRESETS.find((p) => p.id === choice.presetId) ?? LABEL_PRESETS[0]
}

/** Size of the physical page sent to the printer. */
export const pageSizeOf = (s: LabelSize): { widthMm: number; heightMm: number } =>
  s.sheet ? { widthMm: s.sheet.pageWidthMm, heightMm: s.sheet.pageHeightMm } : { widthMm: s.widthMm, heightMm: s.heightMm }

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))
const r1 = (n: number) => Math.round(n * 10) / 10
const PT_MM = 25.4 / 72

/**
 * label_barcode TemplateConfig for a size + options: font, margins and barcode height scale with the label so that
 * shop line + name + bars + digits + prices always fit inside the label.
 */
export function labelConfigFor(size: LabelSize, opts: LabelOptions): Record<string, number | boolean | string> {
  const w = size.widthMm
  const h = size.heightMm
  const mt = h <= 30 ? 1 : 1.5
  const mx = w <= 40 ? 1.2 : w <= 60 ? 1.5 : 2.5
  const innerH = h - 2 * mt
  const pt = Math.round(clamp(Math.min(h * 0.22, w * 0.15), 5.5, 11) * 2) / 2
  const line = pt * PT_MM * 1.12
  const head = opts.showShopName || opts.showLogo
  const barH = r1(clamp(innerH * 0.32, 6, 25))
  const priceH = (pt + 3) * PT_MM * 1.12
  const fixed = barH + line * 0.9 * (opts.showBarcodeText ? 1 : 0) + (opts.showMrp || opts.showPrice ? priceH : 0) + (head ? line : 0) + 4 * 0.5
  const nameLines = Math.floor(clamp((innerH - fixed) / line, 1, 4))
  return {
    paperWidthMm: size.sheet ? size.sheet.pageWidthMm : w,
    paperHeightMm: size.sheet ? size.sheet.pageHeightMm : h,
    labelWidthMm: size.sheet ? w : 0,
    labelHeightMm: size.sheet ? h : 0,
    sheetCols: size.sheet?.cols ?? 0,
    sheetRows: size.sheet?.rows ?? 0,
    labelPreset: size.id,
    marginTopMm: mt, marginBottomMm: mt, marginLeftMm: mx, marginRightMm: mx,
    fontSizePt: pt, lineHeight: 1.12, spacingMm: 0.5,
    shopNameSizePt: pt, shopNameAlign: 'center', shopNameBold: true,
    barcodeHeightMm: barH, nameMaxLines: nameLines,
    showShopName: opts.showShopName, logoEnabled: opts.showLogo, logoPosition: 'inline-left', logoWidthMm: 0, logoHeightMm: r1(line * 1.3),
    showProductName: opts.showProductName, showVariant: opts.showVariant, showMrp: opts.showMrp, showPrice: opts.showPrice,
    showBarcodeText: opts.showBarcodeText, showSku: false, barcodeFormat: 'auto'
  }
}

/** Read size + options back out of a stored label_barcode TemplateConfig (used for the first-ever choice). */
export function choiceFromConfig(cfg: Record<string, unknown>): { choice: LabelChoice; options: LabelOptions } {
  const num = (k: string) => (typeof cfg[k] === 'number' ? (cfg[k] as number) : 0)
  const bool = (k: string, d: boolean) => (typeof cfg[k] === 'boolean' ? (cfg[k] as boolean) : d)
  const preset = LABEL_PRESETS.find((p) => p.id === cfg.labelPreset)
  let choice: LabelChoice
  if (preset) choice = { presetId: preset.id }
  else {
    const w = num('paperWidthMm')
    const h = num('paperHeightMm')
    const m = LABEL_PRESETS.find((p) => !p.sheet && p.widthMm === w && p.heightMm === h)
    choice = m ? { presetId: m.id } : w > 0 && h > 0 ? { presetId: CUSTOM_LABEL_ID, customWidthMm: w, customHeightMm: h } : { presetId: DEFAULT_LABEL_PRESET }
  }
  return {
    choice,
    options: {
      showShopName: bool('showShopName', true), showLogo: bool('logoEnabled', false), showProductName: bool('showProductName', true),
      showVariant: bool('showVariant', true), showMrp: bool('showMrp', true), showPrice: bool('showPrice', true), showBarcodeText: bool('showBarcodeText', true)
    }
  }
}

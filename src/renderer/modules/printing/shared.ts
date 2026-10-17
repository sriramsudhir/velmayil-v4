/** Renderer-side types for the printing service (mirrors src/main/modules/printing). */

export type Paper = '58' | '80' | 'A4' | 'A5' | 'label'
export type TemplateKind =
  | 'receipt58' | 'receipt80' | 'invoiceA4' | 'invoiceA5' | 'label_barcode' | 'label_product' | 'report_sales' | 'report_purchase' | 'report_inventory'

export type Config = Record<string, string | number | boolean>

export interface TemplateMeta { kind: TemplateKind; label: string; paper: Paper; defaults: Config }
export interface TemplateRow { id: number; kind: TemplateKind; label: string; paper: Paper; name: string; isDefault: boolean; updatedAt: number; config: Config }
export interface Rendered { html: string; widthMm: number; heightMm: number; docRef?: string; profileVersion?: number; warnings?: string[] }
/** `warning`: printed, but not as asked (e.g. on the Windows default printer because the saved printer was not found). */
export interface PrintResult { ok: boolean; error?: string; logId?: number; warning?: string }
export interface PrinterProfile {
  id: number
  name: string
  deviceName: string
  kind: 'receipt58' | 'receipt80' | 'a4' | 'a5' | 'label'
  calibration: {
    offsetXmm: number; offsetYmm: number; scalePct: number; silent: boolean; raw?: boolean; drawerKick?: boolean; drawerPin?: 2 | 5; cut?: 'none' | 'partial' | 'full'; printableMm?: number
    /** 1 lightest .. 5 normal .. 9 darkest */
    darkness?: number
    /** logo only: 1 darkest .. 5 same as print darkness .. 9 lightest */
    logoBrightness?: number
    dpi?: 203 | 300 | 600
    densityCommand?: boolean
    /** label printers: send labels as TSPL commands, one picture per label at the printer's resolution (past the Windows driver) */
    tspl?: boolean
    /** TSPL: gap between labels on the roll (mm), 0 = continuous */
    labelGapMm?: number
    /** TSPL: turn the print round by 180 degrees */
    flip?: boolean
  }
  isDefault: boolean
}
export interface SystemPrinter { name: string; displayName: string; isDefault: boolean }
export interface PrintLogRow { id: number; ts: number; paper: string; printer: string; ok: boolean; error: string | null; action: string; docRef: string; retryable: boolean }
export interface Variant { variantId: number; displayName: string; sku: string; barcode: string | null; mrp: number; price: number }

export const isInvoice = (k: TemplateKind) => k === 'receipt58' || k === 'receipt80' || k === 'invoiceA4' || k === 'invoiceA5'
export const isLabel = (k: TemplateKind) => k === 'label_barcode' || k === 'label_product'
export const isReport = (k: TemplateKind) => k.startsWith('report_')
export const PRINTER_KIND_LABEL: Record<PrinterProfile['kind'], string> = { receipt58: '58 mm receipt', receipt80: '80 mm receipt', a4: 'A4', a5: 'A5', label: 'Label' }
export const DARKNESS_LABEL = (n: number): string => (n <= 1 ? '1 - Lightest' : n >= 9 ? '9 - Darkest' : n === 5 ? '5 - Normal' : n < 5 ? `${n} - Lighter` : `${n} - Darker`)
export const LOGO_BRIGHTNESS_LABEL = (n: number): string => (n <= 1 ? '1 - Darkest logo' : n >= 9 ? '9 - Lightest logo' : n === 5 ? '5 - Same as print darkness' : n < 5 ? `${n} - Darker logo` : `${n} - Lighter logo`)
/** Where the printer's own darkness lives: for thermal printers that setting, not the app, decides how black the paper gets. */
export const DRIVER_DENSITY_HINT = 'The strongest control is the printer itself: Windows Settings > Bluetooth & devices > Printers & scanners > your printer > Printing preferences, then Darkness / Density / Heat (label printers: often on the Options or Stock tab).'
export const PAPER_FOR_PRINTER_KIND: Record<PrinterProfile['kind'], Paper> = { receipt58: '58', receipt80: '80', a4: 'A4', a5: 'A5', label: 'label' }

/** Placeholder rows ONLY for the report-header preview (the shop header itself is always the real profile). */
export const REPORT_PREVIEW = {
  columns: [
    { key: 'date', header: 'Date', format: 'text' },
    { key: 'bills', header: 'Bills', format: 'int' },
    { key: 'amount', header: 'Amount', format: 'money' }
  ],
  rows: [
    { date: 'Row 1', bills: 12, amount: 1234500 },
    { date: 'Row 2', bills: 9, amount: 875000 }
  ],
  totals: { date: 'Total', bills: 21, amount: 2109500 }
}

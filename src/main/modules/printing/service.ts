import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import type { App } from '../../core/app'
import { AppError } from '@shared/ipc'
import type { BusinessProfile } from '@shared/types'
import type { BusinessProfileService } from '../businessProfile/service'
import { darknessCss, ElectronPrintAdapter, imageDarkness, parseCalibration, prepareHtml, type Calibration, type PrintAdapter, type SystemPrinter } from './adapter'
import {
  defaultConfig, isInvoiceKind, isLabelKind, isReportKind, KIND_LABELS, normalizeConfig, paperForKind, TEMPLATE_KINDS,
  type InvoiceKind, type LabelKind, type Paper, type ReportKind, type TemplateConfig, type TemplateKind
} from './config'
import { buildInvoiceDoc, latestSaleId, sampleInvoiceDoc } from './docBuilder'
import { renderInvoice, renderLabels, renderReport, renderTestPage, type LabelItem, type ReportSpec } from './engine'
import { buildDrawerKick, buildEscPosReceipt, buildEscPosTest, defaultPrintableMm, rasterFromPixels, rasterThresholdFor, type EscPosOptions, type LogoDecoder, type RasterImage } from './escpos'
import { electronLogoDecoder, WindowsRawPrinter, type RawPrintAdapter } from './rawPrinter'

type Row = Record<string, any>

export interface TemplateRow { id: number; kind: TemplateKind; label: string; paper: Paper; name: string; isDefault: boolean; updatedAt: number; config: TemplateConfig }
export interface PrinterProfile { id: number; name: string; deviceName: string; kind: PrinterKind; calibration: Calibration; isDefault: boolean }
export type PrinterKind = 'receipt58' | 'receipt80' | 'a4' | 'a5' | 'label'
export const PRINTER_KIND_FOR_PAPER: Record<Paper, PrinterKind> = { '58': 'receipt58', '80': 'receipt80', A4: 'a4', A5: 'a5', label: 'label' }

export interface RenderInvoiceArgs {
  saleId?: number
  returnId?: number
  template: InvoiceKind
  /** Synthetic data. Only used when explicitly true. */
  sample?: boolean
  /** Designer mode: shop block from the ACTIVE profile instead of the document's pinned version. */
  preview?: boolean
  /** Unsaved template edits layered over the stored template (live preview). */
  config?: Partial<TemplateConfig>
  policy?: 'original' | 'current'
}
export interface RenderedOut { html: string; widthMm: number; heightMm: number; docRef?: string; profileVersion?: number; warnings?: string[] }

export interface PrintArgs {
  html: string
  paper: Paper
  printerProfileId?: number
  copies?: number
  widthMm?: number
  heightMm?: number
  docRef?: string
  /** Show the OS print dialog instead of printing silently. */
  showDialog?: boolean
}
export interface PrintResult {
  ok: boolean
  error?: string
  logId?: number
  /** The job was printed, but not the way it was asked for (e.g. on the Windows default printer because the saved one is gone). */
  warning?: string
}

const MAX_LOG = 200
const MAX_LOG_HTML = 3_000_000
const MAX_RAW_COPIES = 50

/** Page size / copies of a failed job, kept with its document in the print log so that Retry prints the same page. */
interface JobMeta { w?: number; h?: number; c?: number }
const JOB_META = /<!--print-job (\{[^}]*\})-->$/
const withJobMeta = (html: string, m: JobMeta): string => `${html}<!--print-job ${JSON.stringify(m)}-->`
export function splitJobMeta(stored: string): { html: string; meta: JobMeta } {
  const m = JOB_META.exec(stored)
  if (!m) return { html: stored, meta: {} }
  try {
    return { html: stored.slice(0, m.index), meta: JSON.parse(m[1]) as JobMeta }
  } catch {
    return { html: stored.slice(0, m.index), meta: {} }
  }
}

/** A-series sheets are portrait; a document asks for landscape with a wide `@page` size (reports) or a wide page size. */
export function isLandscapeJob(paper: Paper, html: string, widthMm: number, heightMm: number): boolean {
  if (paper !== 'A4' && paper !== 'A5') return false
  if (heightMm > 0 && widthMm > heightMm) return true
  const m = /@page\s*\{\s*size:\s*([\d.]+)mm\s+([\d.]+)mm/.exec(html)
  return !!m && Number(m[1]) > Number(m[2])
}

export class PrintingService {
  private adapter: PrintAdapter
  private rawAdapter: RawPrintAdapter
  private logoDecoder: LogoDecoder = electronLogoDecoder
  constructor(private app: App, private bp: BusinessProfileService, adapter?: PrintAdapter, rawAdapter?: RawPrintAdapter) {
    this.adapter = adapter ?? new ElectronPrintAdapter(app.userDataDir)
    this.rawAdapter = rawAdapter ?? new WindowsRawPrinter({ tmpDir: join(app.userDataDir, 'print-tmp') })
  }
  /** Inject a different printer backend (tests use a fake). */
  setAdapter(a: PrintAdapter): void {
    this.adapter = a
  }
  /** Inject the raw ESC/POS sender (tests use a fake). */
  setRawAdapter(a: RawPrintAdapter): void {
    this.rawAdapter = a
  }
  setLogoDecoder(d: LogoDecoder): void {
    this.logoDecoder = d
  }

  // ---------------------------------------------------------------- templates
  ensureTemplates(): void {
    const have = new Set(this.app.db.all<{ kind: string }>("SELECT kind FROM print_templates WHERE is_default = 1").map((r) => r.kind))
    for (const kind of TEMPLATE_KINDS) {
      if (have.has(kind)) continue
      this.app.db.run(
        `INSERT INTO print_templates(kind,name,config_json,is_default,updated_at) VALUES (?,?,?,1,?) ON CONFLICT(kind,name) DO UPDATE SET is_default = 1`,
        kind, 'Default', JSON.stringify(defaultConfig(kind)), Date.now()
      )
    }
  }
  private toRow(r: Row): TemplateRow {
    const kind = r.kind as TemplateKind
    let cfg: unknown = {}
    try {
      cfg = JSON.parse(r.config_json)
    } catch {
      /* use defaults */
    }
    return { id: r.id, kind, label: KIND_LABELS[kind] ?? kind, paper: paperForKind(kind), name: r.name, isDefault: !!r.is_default, updatedAt: r.updated_at, config: normalizeConfig(kind, cfg) }
  }
  listTemplates(): TemplateRow[] {
    this.ensureTemplates()
    return this.app.db.all<Row>('SELECT * FROM print_templates WHERE is_default = 1').map((r) => this.toRow(r)).sort((a, b) => TEMPLATE_KINDS.indexOf(a.kind) - TEMPLATE_KINDS.indexOf(b.kind))
  }
  getTemplate(kind: TemplateKind): TemplateRow {
    this.ensureTemplates()
    const r = this.app.db.get<Row>('SELECT * FROM print_templates WHERE kind = ? AND is_default = 1', kind)
    if (!r) throw new AppError('NOT_FOUND', `Unknown template ${kind}`)
    return this.toRow(r)
  }
  saveTemplate(kind: TemplateKind, config: Partial<TemplateConfig>): TemplateRow {
    const cur = this.getTemplate(kind)
    const next = normalizeConfig(kind, { ...cur.config, ...config })
    this.app.db.transaction(() => {
      this.app.db.run('UPDATE print_templates SET config_json = ?, updated_at = ? WHERE id = ?', JSON.stringify(next), Date.now(), cur.id)
      this.app.audit({ entity: 'print_template', entityId: kind, action: 'printing.template_save', old: cur.config, new: next })
    })
    return this.getTemplate(kind)
  }
  resetTemplate(kind: TemplateKind): TemplateRow {
    const cur = this.getTemplate(kind)
    const def = defaultConfig(kind)
    this.app.db.transaction(() => {
      this.app.db.run('UPDATE print_templates SET config_json = ?, updated_at = ? WHERE id = ?', JSON.stringify(def), Date.now(), cur.id)
      this.app.audit({ entity: 'print_template', entityId: kind, action: 'printing.template_reset', old: cur.config, new: def })
    })
    return this.getTemplate(kind)
  }

  // ---------------------------------------------------------------- rendering
  private cfgFor(kind: TemplateKind, override?: Partial<TemplateConfig>): TemplateConfig {
    return normalizeConfig(kind, { ...this.getTemplate(kind).config, ...(override ?? {}) })
  }
  private logoFor(p: BusinessProfile) {
    return this.bp.getLogo(p.logoAssetId)
  }

  renderInvoiceHtml(a: RenderInvoiceArgs): RenderedOut {
    if (!isInvoiceKind(a.template)) throw new AppError('VALIDATION', `Not an invoice template: ${a.template}`)
    const cfg = this.cfgFor(a.template, a.config)
    let doc
    if (a.sample === true) doc = sampleInvoiceDoc(this.bp.getActive())
    else {
      let saleId = a.saleId
      if (a.saleId == null && a.returnId == null) {
        saleId = latestSaleId(this.app) ?? undefined
        if (saleId == null) throw new AppError('NOT_FOUND', 'No sales yet. Turn on "use sample data" to preview the layout.')
      }
      doc = buildInvoiceDoc(this.app, this.bp, { saleId, returnId: a.returnId, profileMode: a.preview ? 'preview' : 'document', policy: a.policy })
    }
    const r = renderInvoice(a.template, doc, cfg, this.logoFor(doc.profile))
    return { ...r, docRef: doc.invoiceNumber, profileVersion: doc.profile.version }
  }

  renderReportHtml(a: ReportSpec & { template?: ReportKind; config?: Partial<TemplateConfig> }): RenderedOut {
    const kind = a.template ?? 'report_sales'
    if (!isReportKind(kind)) throw new AppError('VALIDATION', `Not a report template: ${kind}`)
    const profile = this.bp.getActive()
    return renderReport(kind, profile, this.cfgFor(kind, a.config), this.logoFor(profile), a)
  }

  /**
   * Labels for unique product units: one label per code (x `copies`), each drawn as Code 128 with the human-readable code.
   * `variantId` applies to every code; `units` carries a variant per code (resolved by the exposed handler via units.resolve).
   */
  private unitLabelItems(a: { unitCodes?: string[]; units?: { code: string; variantId: number }[]; variantId?: number; copies?: number }): LabelItem[] {
    const list = a.units ?? (a.unitCodes ?? []).map((code) => ({ code, variantId: a.variantId as number }))
    const seen = new Set<string>()
    const items: LabelItem[] = []
    for (const u of list) {
      const code = u.code.trim().toUpperCase()
      if (!code || seen.has(code)) continue
      seen.add(code)
      if (u.variantId == null) throw new AppError('VALIDATION', `Unit ${code}: product is unknown (pass variantId)`)
      const v = this.app.lookup.byId(u.variantId)
      if (!v) throw new AppError('NOT_FOUND', `Product variant ${u.variantId} not found`)
      items.push({ name: v.productName, variant: v.variantName, sku: v.sku, barcode: code, mrp: v.mrp, price: v.price, copies: a.copies ?? 1, unit: true })
    }
    return items
  }

  renderLabelHtml(a: {
    variantIds?: { variantId: number; copies?: number }[]; template?: LabelKind; sample?: boolean; config?: Partial<TemplateConfig>
    unitCodes?: string[]; units?: { code: string; variantId: number }[]; variantId?: number; copies?: number
  }): RenderedOut {
    const kind = a.template ?? 'label_barcode'
    if (!isLabelKind(kind)) throw new AppError('VALIDATION', `Not a label template: ${kind}`)
    const profile = this.bp.getActive()
    let items: LabelItem[] = []
    if ((a.unitCodes && a.unitCodes.length) || (a.units && a.units.length)) {
      items = this.unitLabelItems(a)
    } else if (a.sample === true) {
      items = [{ name: 'Sample product name', variant: 'Variant', sku: 'SMP-001', barcode: '8901234567890', mrp: 19900, price: 17500, copies: 1 }]
    } else {
      let req = a.variantIds
      if (!req || req.length === 0) {
        const id = this.app.db.value<number>('SELECT id FROM product_variants WHERE active = 1 ORDER BY id DESC LIMIT 1')
        if (id == null) throw new AppError('NOT_FOUND', 'No products yet. Turn on "use sample data" to preview the label.')
        req = [{ variantId: id, copies: 1 }]
      }
      for (const q of req) {
        const v = this.app.lookup.byId(q.variantId)
        if (!v) throw new AppError('NOT_FOUND', `Product variant ${q.variantId} not found`)
        items.push({ name: v.productName, variant: v.variantName, sku: v.sku, barcode: v.barcode ?? '', mrp: v.mrp, price: v.price, copies: q.copies ?? 1 })
      }
    }
    const cfg = this.cfgFor(kind, a.config)
    // bar widths are whole dots of the printer these labels normally go to (label sheets go to the A4 printer)
    const cal = this.resolvePrinter(kind === 'label_barcode' && cfg.sheetCols > 0 && cfg.sheetRows > 0 ? 'A4' : 'label')?.calibration
    return renderLabels(kind, profile, cfg, this.logoFor(profile), items, cal ? { dpi: cal.dpi, scale: cal.scalePct / 100 } : {})
  }

  // ---------------------------------------------------------------- printer profiles
  private toPrinter(r: Row): PrinterProfile {
    let cal: unknown = {}
    try {
      cal = JSON.parse(r.calibration_json)
    } catch {
      /* defaults */
    }
    return { id: r.id, name: r.name, deviceName: r.device_name, kind: r.kind, calibration: parseCalibration(cal), isDefault: !!r.is_default }
  }
  listPrinterProfiles(): PrinterProfile[] {
    return this.app.db.all<Row>('SELECT * FROM printer_profiles ORDER BY kind, is_default DESC, name').map((r) => this.toPrinter(r))
  }
  savePrinterProfile(p: { id?: number; name: string; deviceName: string; kind: PrinterKind; calibration?: Partial<Calibration>; isDefault?: boolean }): PrinterProfile {
    const cal = JSON.stringify(parseCalibration(p.calibration))
    const pos = this.app.db.value<number>('SELECT id FROM pos_terminals WHERE is_local = 1') ?? null
    return this.app.db.transaction(() => {
      let id = p.id
      try {
        if (id) {
          const n = this.app.db.run('UPDATE printer_profiles SET name=?, device_name=?, kind=?, calibration_json=?, is_default=? WHERE id=?', p.name, p.deviceName, p.kind, cal, p.isDefault ? 1 : 0, id).changes
          if (!n) throw new AppError('NOT_FOUND', 'Printer profile not found')
        } else id = this.app.db.run('INSERT INTO printer_profiles(name,device_name,kind,calibration_json,is_default,pos_id) VALUES (?,?,?,?,?,?)', p.name, p.deviceName, p.kind, cal, p.isDefault ? 1 : 0, pos).lastId
      } catch (e) {
        if (e instanceof Error && /UNIQUE/i.test(e.message)) throw new AppError('CONFLICT', `A printer profile named "${p.name}" already exists`)
        throw e
      }
      if (p.isDefault) this.app.db.run('UPDATE printer_profiles SET is_default = 0 WHERE kind = ? AND id <> ?', p.kind, id!)
      this.app.audit({ entity: 'printer_profile', entityId: id, action: p.id ? 'printing.printer_update' : 'printing.printer_create', new: { name: p.name, deviceName: p.deviceName, kind: p.kind, calibration: JSON.parse(cal) } })
      return this.toPrinter(this.app.db.get<Row>('SELECT * FROM printer_profiles WHERE id = ?', id!)!)
    })
  }
  deletePrinterProfile(id: number): void {
    const r = this.app.db.get<Row>('SELECT * FROM printer_profiles WHERE id = ?', id)
    if (!r) throw new AppError('NOT_FOUND', 'Printer profile not found')
    this.app.db.transaction(() => {
      this.app.db.run('DELETE FROM printer_profiles WHERE id = ?', id)
      this.app.audit({ entity: 'printer_profile', entityId: id, action: 'printing.printer_delete', old: { name: r.name, deviceName: r.device_name } })
    })
  }
  async listSystemPrinters(): Promise<SystemPrinter[]> {
    return this.adapter.listPrinters()
  }
  private resolvePrinter(paper: Paper, id?: number): PrinterProfile | null {
    if (id != null) {
      const r = this.app.db.get<Row>('SELECT * FROM printer_profiles WHERE id = ?', id)
      if (!r) throw new AppError('NOT_FOUND', 'Printer profile not found')
      return this.toPrinter(r)
    }
    const r = this.app.db.get<Row>('SELECT * FROM printer_profiles WHERE kind = ? ORDER BY is_default DESC, id LIMIT 1', PRINTER_KIND_FOR_PAPER[paper])
    return r ? this.toPrinter(r) : null
  }
  /**
   * The profile to print with. A remembered profile id that has since been deleted (the POS keeps the cashier's choice) must not
   * stop the receipt: the default profile for the paper is used and the caller gets a warning to show.
   */
  private pickPrinter(paper: Paper, id?: number): { prof: PrinterProfile | null; warning?: string } {
    if (id != null && !this.app.db.value('SELECT 1 FROM printer_profiles WHERE id = ?', id)) {
      return { prof: this.resolvePrinter(paper), warning: 'The selected printer profile no longer exists, so the default printer for this paper was used. Choose a printer again.' }
    }
    return { prof: this.resolvePrinter(paper, id) }
  }
  /**
   * After a failed job: is the profile's Windows printer gone (renamed, uninstalled, other PC)? Returns the Windows default
   * printer to fall back to, or null when the device exists / cannot be checked (then the failure is a real printer error).
   */
  private async missingDevice(deviceName: string): Promise<{ fallback: SystemPrinter | null } | null> {
    if (!deviceName) return null
    let list: SystemPrinter[] = []
    try {
      list = await this.adapter.listPrinters()
    } catch {
      return null
    }
    if (!list.length || list.some((p) => p.name === deviceName)) return null
    return { fallback: list.find((p) => p.isDefault) ?? null }
  }

  /** What "Print darkness" of a printer profile does to a preview (same CSS the print gets). */
  printLook(a: { paper: Paper; printerProfileId?: number }): { darkness: number; logoBrightness: number; css: string; printer: string } {
    const prof = this.pickPrinter(a.paper, a.printerProfileId).prof
    const cal = prof?.calibration ?? parseCalibration({})
    return { darkness: cal.darkness, logoBrightness: cal.logoBrightness, css: darknessCss(cal.darkness, cal.logoBrightness), printer: prof?.name ?? '' }
  }

  // ---------------------------------------------------------------- printing
  private pageSize(paper: Paper, w?: number, h?: number): { widthMm: number; heightMm: number } {
    if (w && w > 0) {
      if (h && h > 0) return { widthMm: w, heightMm: h }
      // height 0 means "measure the content" and is only right for roll paper: a cut sheet has a fixed second side
      const long = paper === 'A4' ? 297 : paper === 'A5' ? 210 : 0
      const short = paper === 'A4' ? 210 : 148
      return { widthMm: w, heightMm: long ? (Math.abs(w - long) < 1 ? short : long) : 0 }
    }
    const kind: TemplateKind = paper === '58' ? 'receipt58' : paper === '80' ? 'receipt80' : paper === 'A5' ? 'invoiceA5' : paper === 'label' ? 'label_barcode' : 'invoiceA4'
    const c = this.getTemplate(kind).config
    return { widthMm: c.paperWidthMm, heightMm: paper === '58' || paper === '80' ? 0 : c.paperHeightMm }
  }

  private writeLog(e: { paper: string; printer: string; ok: boolean; error?: string; action: string; docRef?: string; html?: string }): number {
    const db = this.app.db
    const id = db.run(
      'INSERT INTO print_log(paper,printer,ok,error,action,doc_ref,user_id,html) VALUES (?,?,?,?,?,?,?,?)',
      e.paper, e.printer, e.ok ? 1 : 0, e.error ?? null, e.action, e.docRef ?? '', this.app.session?.userId ?? null,
      !e.ok && e.html && e.html.length <= MAX_LOG_HTML ? e.html : null
    ).lastId
    db.run('DELETE FROM print_log WHERE id NOT IN (SELECT id FROM print_log ORDER BY id DESC LIMIT ?)', MAX_LOG)
    return id
  }

  /**
   * Print rendered HTML. NEVER throws for printer problems and never touches sales: returns {ok:false,error}.
   * If the profile's Windows printer no longer exists the job goes to the Windows default printer and the result carries a
   * `warning`; a failed job is kept in the print log with its page size and copies so Retry prints the same thing.
   */
  async print(a: PrintArgs): Promise<PrintResult> {
    let printerName = ''
    const kept = withJobMeta(a.html, { w: a.widthMm, h: a.heightMm, c: a.copies })
    try {
      const picked = this.pickPrinter(a.paper, a.printerProfileId)
      const prof = picked.prof
      let warning = picked.warning
      printerName = prof?.deviceName ?? ''
      const cal = prof?.calibration ?? parseCalibration({})
      const size = this.pageSize(a.paper, a.widthMm, a.heightMm)
      const html = prepareHtml(a.html, cal)
      const opts = {
        deviceName: printerName,
        silent: a.showDialog ? false : cal.silent,
        widthMm: size.widthMm,
        heightMm: size.heightMm,
        landscape: isLandscapeJob(a.paper, a.html, size.widthMm, size.heightMm),
        copies: a.copies ?? 1
      }
      let res = await this.adapter.print(html, opts)
      if (!res.ok) {
        const gone = await this.missingDevice(printerName)
        if (gone) {
          const lost = `Printer "${printerName}" was not found in Windows`
          const again = gone.fallback ? await this.adapter.print(html, { ...opts, deviceName: '' }) : null
          if (again?.ok) {
            res = again
            warning = `${lost}, so this was printed on the Windows default printer (${gone.fallback!.displayName}). Choose the printer again under Printing > Printers.`
            printerName = gone.fallback!.name
          } else res = { ok: false, error: `${res.error || 'Printing failed'}. ${lost}${gone.fallback ? ' and the Windows default printer did not print it either' : ' and Windows has no default printer'}. Choose the printer again under Printing > Printers.` }
        }
      }
      const logId = this.writeLog({ paper: a.paper, printer: printerName, ok: res.ok, error: res.ok ? warning : res.error, action: 'print', docRef: a.docRef, html: kept })
      return res.ok ? { ok: true, logId, ...(warning ? { warning } : {}) } : { ok: false, error: res.error || 'Printing failed', logId }
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      try {
        const logId = this.writeLog({ paper: a.paper, printer: printerName, ok: false, error, action: 'print', docRef: a.docRef, html: kept })
        return { ok: false, error, logId }
      } catch {
        return { ok: false, error }
      }
    }
  }

  // ---------------------------------------------------------------- raw ESC/POS (opt-in per printer profile) + cash drawer
  /** Logo as a 1-bit raster for ESC/POS, or null (no logo, hidden by the template/profile, or no decoder: skipped, never an error). */
  private rasterLogo(profile: BusinessProfile, printableMm: number, enabled: boolean, cal: Calibration): RasterImage | null {
    try {
      if (!enabled || !profile.logoSettings.visible) return null
      const logo = this.logoFor(profile)
      if (!logo) return null
      const dots = Math.floor(printableMm * 8)
      const maxW = Math.min(Math.floor(dots * 0.6), 240)
      let img = this.logoDecoder(logo.printBytes, maxW)
      if (img && img.height > 160) img = this.logoDecoder(logo.printBytes, Math.max(24, Math.floor((maxW * 160) / img.height)))
      return img ? rasterFromPixels(img.pixels, img.width, img.height, { order: img.order, threshold: rasterThresholdFor(imageDarkness(cal.darkness, cal.logoBrightness)) }) : null
    } catch {
      return null
    }
  }

  private escOptions(kind: 'receipt58' | 'receipt80', prof: PrinterProfile, kick: boolean, profile: BusinessProfile): EscPosOptions {
    const paper = kind === 'receipt58' ? 58 : 80
    const printableMm = prof.calibration.printableMm || defaultPrintableMm(paper)
    const cfg = this.cfgFor(kind)
    const cal = prof.calibration
    return {
      paper, printableMm, cut: cal.cut, drawerKick: kick, drawerPin: cal.drawerPin, logo: this.rasterLogo(profile, printableMm, cfg.logoEnabled, cal), cfg,
      darkness: cal.darkness, densityCommand: cal.densityCommand
    }
  }

  /** Raw jobs are never redirected to another printer (ESC/POS bytes on an office printer print pages of garbage): say what is wrong instead. */
  private async rawError(printer: string, error: string | undefined): Promise<string> {
    const base = error || 'Raw printing failed'
    return (await this.missingDevice(printer)) ? `${base}. Printer "${printer}" was not found in Windows: choose the printer again under Printing > Printers.` : base
  }

  private saleHasCash(saleId?: number): boolean {
    return saleId != null && !!this.app.db.value("SELECT 1 FROM sale_payments WHERE sale_id = ? AND method = 'cash' AND amount > 0", saleId)
  }

  /**
   * Print a stored sale / return. Receipt papers on a printer profile with "Raw ESC/POS" switched on go out as ESC/POS bytes
   * to the spooler; everything else renders HTML through the Windows driver. The sale is never touched: all failures come back as
   * {ok:false,error}. After a cash sale the drawer is kicked when the printer profile asks for it (failure ignored but logged).
   */
  async printInvoice(a: { saleId?: number; returnId?: number; template: InvoiceKind; printerProfileId?: number; copies?: number }): Promise<PrintResult & { mode: 'raw' | 'driver' }> {
    const paper = paperForKind(a.template)
    let prof: PrinterProfile | null = null
    let profWarning: string | undefined
    try {
      const picked = this.pickPrinter(paper, a.printerProfileId)
      prof = picked.prof
      profWarning = picked.warning
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), mode: 'driver' }
    }
    const isReceipt = a.template === 'receipt58' || a.template === 'receipt80'
    const kick = !!prof?.calibration.drawerKick && isReceipt && this.saleHasCash(a.saleId)
    if (isReceipt && prof?.calibration.raw) {
      const printer = prof.deviceName
      try {
        const doc = buildInvoiceDoc(this.app, this.bp, { saleId: a.saleId, returnId: a.returnId, profileMode: 'document' })
        const opts = this.escOptions(a.template as 'receipt58' | 'receipt80', prof, kick, doc.profile)
        const one = buildEscPosReceipt(doc, opts)
        const copies = Math.max(1, Math.min(MAX_RAW_COPIES, a.copies ?? 1))
        // the drawer pulse belongs to the sale, not to each copy: only the first copy carries it
        const rest = copies > 1 && kick ? buildEscPosReceipt(doc, { ...opts, drawerKick: false }) : one
        const res = await this.rawAdapter.sendRaw(printer, Buffer.concat([one, ...Array.from({ length: copies - 1 }, () => rest)]))
        const error = res.ok ? undefined : await this.rawError(printer, res.error)
        const logId = this.writeLog({ paper, printer, ok: res.ok, error: res.ok ? profWarning : error, action: 'print-raw', docRef: doc.invoiceNumber })
        return res.ok ? { ok: true, logId, mode: 'raw', ...(profWarning ? { warning: profWarning } : {}) } : { ok: false, error, logId, mode: 'raw' }
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e)
        try {
          return { ok: false, error, logId: this.writeLog({ paper, printer, ok: false, error, action: 'print-raw' }), mode: 'raw' }
        } catch {
          return { ok: false, error, mode: 'raw' }
        }
      }
    }
    try {
      const r = this.renderInvoiceHtml({ saleId: a.saleId, returnId: a.returnId, template: a.template })
      const res = await this.print({ html: r.html, paper, printerProfileId: a.printerProfileId, copies: a.copies, docRef: r.docRef, widthMm: r.widthMm, heightMm: r.heightMm })
      // not when the job was redirected to another printer: the drawer hangs on the receipt printer that was not found
      if (res.ok && kick && prof && !/was not found in Windows/.test(res.warning ?? '')) await this.kickDrawer(prof, paper)
      return { ...res, mode: 'driver' }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), mode: 'driver' }
    }
  }

  private async kickDrawer(prof: PrinterProfile, paper: Paper): Promise<PrintResult> {
    try {
      const res = await this.rawAdapter.sendRaw(prof.deviceName, buildDrawerKick(prof.calibration.drawerPin))
      const logId = this.writeLog({ paper, printer: prof.deviceName, ok: res.ok, error: res.error, action: 'drawer' })
      return res.ok ? { ok: true, logId } : { ok: false, error: res.error || 'Could not open the cash drawer', logId }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  /** "Open cash drawer" button: pulses the drawer connected to the receipt printer (profile id, else the default 80 mm / 58 mm profile). */
  async openDrawer(a: { printerProfileId?: number } = {}): Promise<PrintResult> {
    try {
      const prof = a.printerProfileId != null ? this.resolvePrinter('80', a.printerProfileId) : (this.resolvePrinter('80') ?? this.resolvePrinter('58'))
      if (!prof) return { ok: false, error: 'Add a receipt printer profile first (Printing > Printers).' }
      return await this.kickDrawer(prof, prof.kind === 'receipt58' ? '58' : '80')
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  /** Re-send a previously failed job (optionally to another printer profile). */
  async retryPrint(a: { logId: number; printerProfileId?: number }): Promise<PrintResult> {
    const r = this.app.db.get<Row>('SELECT * FROM print_log WHERE id = ?', a.logId)
    if (!r) throw new AppError('NOT_FOUND', 'Print job not found')
    if (!r.html) throw new AppError('NOT_FOUND', 'This job cannot be retried (document was not kept). Reprint it from the sale.')
    const { html, meta } = splitJobMeta(r.html)
    return this.print({ html, paper: r.paper as Paper, printerProfileId: a.printerProfileId, docRef: r.doc_ref, widthMm: meta.w, heightMm: meta.h, copies: meta.c })
  }

  listPrintLog(a: { limit?: number; onlyFailed?: boolean } = {}) {
    return this.app.db
      .all<Row>(`SELECT id, ts, paper, printer, ok, error, action, doc_ref, (html IS NOT NULL) AS retryable FROM print_log ${a.onlyFailed ? 'WHERE ok = 0' : ''} ORDER BY id DESC LIMIT ?`, Math.min(a.limit ?? 50, 200))
      .map((r) => ({ id: r.id, ts: r.ts, paper: r.paper, printer: r.printer, ok: !!r.ok, error: r.error, action: r.action, docRef: r.doc_ref, retryable: !!r.retryable }))
  }

  async exportPdf(a: { html: string; path?: string; paper?: Paper; widthMm?: number; heightMm?: number; name?: string }): Promise<{ path: string }> {
    const size = this.pageSize(a.paper ?? 'A4', a.widthMm, a.heightMm)
    // a bare file name means "let the user pick where to save it" (suggested name = that name)
    let target = a.path
    if (target && !isAbsolute(target)) {
      const suggested = basename(target)
      if (this.adapter.chooseSavePath) {
        const chosen = await this.adapter.chooseSavePath(suggested)
        if (!chosen) throw new AppError('PRINT_FAILED', 'Save cancelled')
        target = chosen
      } else target = join(this.app.userDataDir, 'pdf', suggested.replace(/[^\w.-]+/g, '_') || 'document.pdf')
    }
    let buf: Buffer
    try {
      buf = await this.adapter.toPdf(prepareHtml(a.html), { ...size, landscape: isLandscapeJob(a.paper ?? 'A4', a.html, size.widthMm, size.heightMm) })
    } catch (e) {
      throw new AppError('PRINT_FAILED', `Could not create PDF: ${e instanceof Error ? e.message : String(e)}`)
    }
    const safe = (a.name ?? 'document').replace(/[^\w.-]+/g, '_').slice(0, 60) || 'document'
    const path = target ?? join(this.app.userDataDir, 'pdf', `${safe}-${Date.now()}.pdf`)
    try {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, buf)
    } catch (e) {
      throw new AppError('PRINT_FAILED', `Could not save PDF: ${e instanceof Error ? e.message : String(e)}`)
    }
    return { path }
  }

  /** Prints logo + shop name + address + a millimetre ruler and grid so paper size / offsets can be verified. */
  async testPrint(a: { paper: '58' | '80' | 'A4' | 'A5' | 'label'; printerProfileId?: number; dryRun?: boolean }): Promise<PrintResult & { html: string; widthMm: number }> {
    const profile = this.bp.getActive()
    const kind: TemplateKind = a.paper === '58' ? 'receipt58' : a.paper === '80' ? 'receipt80' : a.paper === 'A5' ? 'invoiceA5' : a.paper === 'label' ? 'label_barcode' : 'invoiceA4'
    let prof: PrinterProfile | null = null
    try {
      prof = this.pickPrinter(a.paper, a.printerProfileId).prof
    } catch {
      /* print() reports it */
    }
    const cal = prof?.calibration ?? parseCalibration({})
    const r = renderTestPage(a.paper, profile, this.getTemplate(kind).config, this.logoFor(profile), { darkness: cal.darkness, dpi: cal.dpi, scale: cal.scalePct / 100 })
    if (a.dryRun) return { ok: true, html: r.html, widthMm: r.widthMm }
    if (a.paper === '58' || a.paper === '80') {
      if (prof?.calibration.raw) {
        try {
          const k = a.paper === '58' ? 'receipt58' : 'receipt80'
          const res = await this.rawAdapter.sendRaw(prof.deviceName, buildEscPosTest(profile, this.escOptions(k, prof, false, profile)))
          const logId = this.writeLog({ paper: a.paper, printer: prof.deviceName, ok: res.ok, error: res.error, action: 'print-raw', docRef: `test-${a.paper}` })
          return { ...(res.ok ? { ok: true } : { ok: false, error: await this.rawError(prof.deviceName, res.error) }), logId, html: r.html, widthMm: r.widthMm }
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e), html: r.html, widthMm: r.widthMm }
        }
      }
    }
    const res = await this.print({ html: r.html, paper: a.paper, printerProfileId: a.printerProfileId, widthMm: r.widthMm, heightMm: r.heightMm, docRef: `test-${a.paper}` })
    return { ...res, html: r.html, widthMm: r.widthMm }
  }
}

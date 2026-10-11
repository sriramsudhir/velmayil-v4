import { createRequire } from 'node:module'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { parseDpi, snapBarcodes, type PrinterDpi } from './barcode'

/**
 * Everything that touches Electron's printing stack lives behind this interface so tests can inject a fake printer
 * and the print engine stays pure. Printer errors are reported as {ok:false,error}; nothing here ever throws to callers
 * of print().
 */

export interface SystemPrinter { name: string; displayName: string; isDefault: boolean; status?: number }

export interface PrintJobOpts {
  deviceName: string // '' = system default printer
  silent: boolean
  widthMm: number
  heightMm: number // 0 = measure content (roll paper)
  /** true: `widthMm` x `heightMm` is the portrait sheet and the content is rotated onto it */
  landscape?: boolean
  copies: number
}
export interface PdfJobOpts { widthMm: number; heightMm: number; landscape?: boolean }

export interface PrintAdapter {
  print(html: string, opts: PrintJobOpts): Promise<{ ok: boolean; error?: string }>
  toPdf(html: string, opts: PdfJobOpts): Promise<Buffer>
  listPrinters(): Promise<SystemPrinter[]>
  /** Ask the user where to save a PDF (suggested file name). null = cancelled. Optional: absent in tests/headless. */
  chooseSavePath?(suggestedName: string): Promise<string | null>
}

// ---------------------------------------------------------------------------- pure helpers (testable)
export interface Calibration {
  offsetXmm: number
  offsetYmm: number
  scalePct: number
  silent: boolean
  /** Thermal receipt printers only. OFF by default: send ESC/POS bytes straight to the spooler instead of a Windows page. */
  raw: boolean
  /** Open the cash drawer (ESC p pulse through the printer) after a sale that has a cash payment. OFF by default. */
  drawerKick: boolean
  drawerPin: 2 | 5
  cut: 'none' | 'partial' | 'full'
  /** Printable width of the paper in mm (0 = typical: 48 for 58 mm, 72 for 80 mm; some 80 mm printers print 76 mm). */
  printableMm: number
  /**
   * Print darkness 1 (lightest) .. 9 (darkest); 5 = normal = exactly what was printed before this setting existed.
   * Windows-driver jobs: text strokes get heavier / thinner and the logo darker / lighter (darknessCss). Raw ESC/POS jobs:
   * logo threshold, double-strike text and the printer's density command (escpos.ts). Barcodes and QR codes are never touched.
   */
  darkness: number
  /** Logo / picture only, 1 (darkest) .. 9 (lightest); 5 = follow the print darkness. */
  logoBrightness: number
  /** Printer resolution: bar widths of barcodes are whole dots of this resolution (barcode.ts). */
  dpi: PrinterDpi
  /** Raw ESC/POS only: also send the printer's own density command (GS ( K) when darkness is not 5. */
  densityCommand: boolean
}
export const DARKNESS_NORMAL = 5
const level = (n: unknown): number => Math.round(clamp(n, 1, 9, DARKNESS_NORMAL))
const clamp = (n: unknown, lo: number, hi: number, d: number) => (typeof n === 'number' && Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d)

export function parseCalibration(raw: unknown): Calibration {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    offsetXmm: clamp(o.offsetXmm, -20, 20, 0),
    offsetYmm: clamp(o.offsetYmm, -20, 20, 0),
    scalePct: clamp(o.scalePct, 50, 150, 100),
    silent: typeof o.silent === 'boolean' ? o.silent : true,
    raw: o.raw === true,
    drawerKick: o.drawerKick === true,
    drawerPin: o.drawerPin === 5 ? 5 : 2,
    cut: o.cut === 'none' || o.cut === 'full' ? o.cut : 'partial',
    printableMm: o.printableMm === 0 ? 0 : clamp(o.printableMm, 40, 80, 0),
    darkness: level(o.darkness),
    logoBrightness: level(o.logoBrightness),
    dpi: parseDpi(o.dpi),
    densityCommand: o.densityCommand !== false
  }
}

/** Darkness level that applies to pictures: the print darkness, shifted by the logo brightness (brighter logo = lower level). */
export function imageDarkness(darkness: unknown, logoBrightness: unknown = DARKNESS_NORMAL): number {
  return Math.min(9, Math.max(1, level(darkness) - (level(logoBrightness) - DARKNESS_NORMAL)))
}

/**
 * CSS for the Windows-driver path. '' at the normal level, so level 5 prints exactly what it always did.
 *  - Text: a hairline stroke in the text colour makes every glyph heavier (0.1 pt per level, about a third of a 203 dpi dot);
 *    below 5 a paper-white stroke over the fill makes the glyphs thinner. Both are pure black/white (a thermal driver dithers
 *    grey into speckle) and neither changes the layout: font weights and sizes stay as designed, so nothing re-wraps and a
 *    label that fitted still fits.
 *  - Pictures (the logo): brightness / contrast filter.
 *  - Barcodes and QR codes are excluded explicitly: thicker, filtered or blurred bars do not scan.
 * How dark the paper really gets is decided by the printer (heat / density in its Windows driver); this only changes what is sent.
 */
export function darknessCss(darkness: unknown, logoBrightness: unknown = DARKNESS_NORMAL): string {
  const d = level(darkness) - DARKNESS_NORMAL
  const i = imageDarkness(darkness, logoBrightness) - DARKNESS_NORMAL
  let css = ''
  if (d > 0) css += `body{-webkit-text-stroke:${(d * 0.1).toFixed(2)}pt currentColor}`
  if (d < 0) css += `body{-webkit-text-stroke:${(-d * 0.08).toFixed(2)}pt #fff}`
  if (i > 0) css += `img{filter:brightness(${(1 - i * 0.1).toFixed(2)}) contrast(${(1 + i * 0.15).toFixed(2)})}`
  if (i < 0) css += `img{filter:brightness(${(1 - i * 0.12).toFixed(2)})}`
  if (!css) return ''
  return css + 'svg.barcode,svg.barcode *,svg.qr,svg.qr *{filter:none!important;-webkit-text-stroke:0!important;stroke:none!important;shape-rendering:crispEdges!important}'
}

export const CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:">`

/** Add a <style> block at the end of <head> (after the document's own styles, so it wins on equal specificity). */
export function injectStyle(html: string, id: string, css: string): string {
  const style = `<style id="${id}">${css}</style>`
  return /<\/head>/i.test(html) ? html.replace(/<\/head>/i, () => `${style}</head>`) : style + html
}

/**
 * Apply the printer profile to a rendered document: offline-only CSP, calibration (offset + scale), print darkness, and
 * barcodes re-snapped to this printer's dots. With a default profile only the CSP is added.
 */
export function prepareHtml(html: string, cal?: Partial<Calibration>): string {
  const c = parseCalibration(cal)
  let out = snapBarcodes(html, c.dpi, c.scalePct / 100, c.offsetXmm)
  if (!/Content-Security-Policy/i.test(out)) out = /<head[^>]*>/i.test(out) ? out.replace(/<head[^>]*>/i, (m) => `${m}${CSP}`) : CSP + out
  if (c.offsetXmm !== 0 || c.offsetYmm !== 0 || c.scalePct !== 100) {
    const style = `<style id="calibration">body{position:relative;left:${c.offsetXmm}mm;top:${c.offsetYmm}mm;${c.scalePct !== 100 ? `zoom:${c.scalePct / 100};` : ''}}</style>`
    out = /<\/head>/i.test(out) ? out.replace(/<\/head>/i, `${style}</head>`) : style + out
  }
  const dark = darknessCss(c.darkness, c.logoBrightness)
  if (dark) out = injectStyle(out, 'darkness', dark)
  return out
}

/** Page size for Electron (microns). Landscape jobs pass the portrait sheet plus the landscape flag, which is what drivers expect. */
export function pageSizeMicrons(widthMm: number, heightMm: number, landscape = false): { width: number; height: number } {
  const w = Math.round(widthMm * 1000)
  const h = Math.round(heightMm * 1000)
  return landscape ? { width: Math.min(w, h), height: Math.max(w, h) } : { width: w, height: h }
}

/** A silent job that has not been answered by the driver after this long is given up (the window is destroyed). */
export const PRINT_TIMEOUT_MS = 60_000
/** With the Windows print dialog open the user decides how long it takes. */
export const DIALOG_TIMEOUT_MS = 10 * 60_000

/** Resolve with `onTimeout()` if `p` has not settled after `ms` (a destroyed print window never calls its callback). */
export function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => resolve(onTimeout()), ms)
    p.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) }
    )
  })
}

// ---------------------------------------------------------------------------- Electron implementation
type ElectronModule = typeof import('electron')
function electron(): ElectronModule {
  return createRequire(process.execPath)('electron') as ElectronModule
}

const PX_TO_MM = 25.4 / 96

export class ElectronPrintAdapter implements PrintAdapter {
  constructor(private userDataDir: string) {}

  async chooseSavePath(suggestedName: string): Promise<string | null> {
    const { dialog, app } = electron()
    const r = await dialog.showSaveDialog({ defaultPath: join(app.getPath('documents'), suggestedName), filters: [{ name: 'PDF', extensions: ['pdf'] }] })
    return r.canceled || !r.filePath ? null : r.filePath
  }

  /**
   * Load the document in a hidden, locked-down window and run `fn` on it. The window never outlives `timeoutMs`: a driver
   * that never answers (printer off, queue stuck) would otherwise leave the caller waiting for ever, because Electron does not
   * call the print callback of a destroyed window. The temporary file is always removed.
   */
  private async withWindow<T>(html: string, timeoutMs: number, fn: (win: import('electron').BrowserWindow, contentHeightMm: number) => Promise<T>): Promise<T> {
    const { BrowserWindow } = electron()
    const dir = join(this.userDataDir, 'print-tmp')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `job-${randomUUID()}.html`)
    writeFileSync(file, html, 'utf8')
    const win = new BrowserWindow({ show: false, width: 900, height: 1200, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
    win.webContents.on('will-navigate', (e) => e.preventDefault())
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    const job = (async () => {
      await win.loadFile(file)
      const hpx = (await win.webContents.executeJavaScript(
        `Promise.all(Array.from(document.images).map(function(i){return i.decode?i.decode().catch(function(){}):0})).then(function(){return Math.ceil(document.documentElement.scrollHeight)})`
      )) as number
      return fn(win, hpx * PX_TO_MM)
    })()
    try {
      return await withTimeout(job, timeoutMs, () => {
        throw new Error(`The printer did not respond within ${Math.round(timeoutMs / 1000)} seconds. Check that it is switched on, connected and has paper.`)
      })
    } finally {
      job.catch(() => undefined) // a job abandoned by the timeout must not become an unhandled rejection
      if (!win.isDestroyed()) win.destroy()
      try {
        rmSync(file, { force: true })
      } catch {
        /* ignore */
      }
    }
  }

  async print(html: string, o: PrintJobOpts): Promise<{ ok: boolean; error?: string }> {
    try {
      return await this.withWindow(html, o.silent ? PRINT_TIMEOUT_MS : DIALOG_TIMEOUT_MS, (win, contentMm) => {
        const h = o.heightMm > 0 ? o.heightMm : Math.max(30, Math.ceil(contentMm) + 4)
        return new Promise<{ ok: boolean; error?: string }>((resolve) => {
          win.webContents.print(
            {
              silent: o.silent,
              deviceName: o.deviceName || undefined,
              printBackground: true,
              copies: Math.max(1, o.copies),
              landscape: !!o.landscape,
              margins: { marginType: 'none' },
              pageSize: pageSizeMicrons(o.widthMm, h, !!o.landscape)
            },
            (success, reason) => resolve(success ? { ok: true } : { ok: false, error: reason || 'Printer rejected the job' })
          )
        })
      })
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  async toPdf(html: string, o: PdfJobOpts): Promise<Buffer> {
    return this.withWindow(html, PRINT_TIMEOUT_MS, (win, contentMm) => {
      const h = o.heightMm > 0 ? o.heightMm : Math.max(30, Math.ceil(contentMm) + 4)
      const size = pageSizeMicrons(o.widthMm, h, !!o.landscape)
      return win.webContents.printToPDF({
        printBackground: true,
        landscape: !!o.landscape,
        margins: { top: 0, bottom: 0, left: 0, right: 0 },
        pageSize: { width: size.width / 25400, height: size.height / 25400 }
      })
    })
  }

  async listPrinters(): Promise<SystemPrinter[]> {
    try {
      const { BrowserWindow } = electron()
      const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } })
      try {
        const list = await win.webContents.getPrintersAsync()
        return list.map((p) => {
          const x = p as { name: string; displayName?: string; isDefault?: boolean; status?: number }
          return { name: x.name, displayName: x.displayName || x.name, isDefault: !!x.isDefault, status: x.status }
        })
      } finally {
        win.destroy()
      }
    } catch {
      return []
    }
  }
}

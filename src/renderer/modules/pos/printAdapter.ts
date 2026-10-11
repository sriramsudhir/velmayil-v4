/**
 * Thin adapter over the `printing` service (built by another agent). Everything here is best effort:
 * printing problems are returned as { ok:false, error } and NEVER thrown, and callers must never re-submit a sale
 * because of them. If the printing service is missing the adapter reports a friendly error instead of crashing.
 */
import { call, errMsg } from '@/lib/api'

export type PrintTemplate = 'receipt58' | 'receipt80' | 'invoiceA4' | 'invoiceA5'
export interface PrintRef { saleId?: number; returnId?: number }
/** `warning`: the document was printed, but not as asked (default printer used because the chosen one is gone): show it. */
export interface PrintResult { ok: boolean; error?: string; logId?: number; warning?: string }

const paperOf = (t: PrintTemplate): '58' | '80' | 'A4' | 'A5' =>
  t === 'receipt58' ? '58' : t === 'receipt80' ? '80' : t === 'invoiceA4' ? 'A4' : 'A5'

/**
 * Only "this build has no such printing method": an ordinary NOT_FOUND from the service ("Sale 12 not found", "This job cannot
 * be retried...") is a real answer for the user and must be shown as it is, not replaced by "printing is not available".
 */
export const missing = (e: unknown): boolean => /Unknown service method|Unknown service\b|not registered/i.test(errMsg(e))
const friendly = (e: unknown) => (missing(e) ? 'The printing service is not available.' : errMsg(e))
/** One shape for every answer of the printing service; never trusts it to be well formed. */
export const toResult = (r: PrintResult | null | undefined): PrintResult =>
  r?.ok ? { ok: true, logId: r.logId, ...(r.warning ? { warning: r.warning } : {}) } : { ok: false, error: r?.error || 'The printer did not accept the job.', logId: r?.logId }

async function render(ref: PrintRef, template: PrintTemplate): Promise<{ html: string; docRef?: string }> {
  return call<{ html: string; docRef?: string }>('printing', 'renderInvoiceHtml', { ...ref, template })
}

export async function printDocument(ref: PrintRef, template: PrintTemplate, printerProfileId?: number): Promise<PrintResult> {
  try {
    // preferred: one call; the printing service picks raw ESC/POS or the Windows driver from the printer profile and may kick the cash drawer
    try {
      return toResult(await call<PrintResult>('printing', 'printInvoice', { ...ref, template, printerProfileId }))
    } catch (e) {
      if (!missing(e)) throw e
    }
    const { html, docRef } = await render(ref, template)
    return toResult(await call<PrintResult>('printing', 'print', { html, printerProfileId, paper: paperOf(template), docRef }))
  } catch (e) {
    return { ok: false, error: friendly(e) }
  }
}

/** Re-send a failed job kept in the print log (optionally to another printer profile). */
export async function retryPrint(logId: number, printerProfileId?: number): Promise<PrintResult> {
  try {
    return toResult(await call<PrintResult>('printing', 'retryPrint', { logId, printerProfileId }))
  } catch (e) {
    return { ok: false, error: friendly(e) }
  }
}

/** Export to PDF. `fileName` is a suggestion; the printing service may show a save dialog when no absolute path is given. */
export async function savePdf(ref: PrintRef, template: PrintTemplate, fileName: string): Promise<PrintResult & { path?: string }> {
  try {
    const { html } = await render(ref, template)
    const r = await call<{ path: string }>('printing', 'exportPdf', { html, path: fileName, paper: paperOf(template) })
    return { ok: true, path: r?.path }
  } catch (e) {
    return { ok: false, error: friendly(e) }
  }
}

export interface PrinterChoice { id: number; name: string; deviceName?: string; kind?: string }
/** Printer profiles for the "Select printer" action. Empty list when the service has no such method. */
export async function listPrinters(): Promise<PrinterChoice[]> {
  try {
    const r = await call<PrinterChoice[] | { rows: PrinterChoice[] }>('printing', 'listPrinterProfiles')
    const rows = Array.isArray(r) ? r : r?.rows
    return Array.isArray(rows) ? rows : []
  } catch {
    return []
  }
}

// ---- per-terminal preferences (localStorage; purely a convenience) ----
const get = (k: string): string | null => { try { return localStorage.getItem(k) } catch { return null } }
const set = (k: string, v: string) => { try { localStorage.setItem(k, v) } catch { /* ignore */ } }
export const prefs = {
  template: (): PrintTemplate => (get('pos.receiptTemplate') as PrintTemplate) || 'receipt80',
  setTemplate: (t: PrintTemplate) => set('pos.receiptTemplate', t),
  autoPrint: (): boolean => get('pos.autoPrint') === '1',
  setAutoPrint: (v: boolean) => set('pos.autoPrint', v ? '1' : '0'),
  // a damaged value ("abc", "0") means "no printer chosen", never NaN: NaN would be rejected by the service and block every receipt
  printerId: (): number | undefined => { const n = Number(get('pos.printerId')); return Number.isInteger(n) && n > 0 ? n : undefined },
  setPrinterId: (id: number | undefined) => set('pos.printerId', id ? String(id) : '')
}

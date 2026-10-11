import { z } from 'zod'
import type { App } from '../../core/app'
import { AppError } from '@shared/ipc'
import type { Permission } from '@shared/permissions'
import type { BusinessProfileService } from '../businessProfile/service'
import { defaultConfig, KIND_LABELS, paperForKind, TEMPLATE_KINDS } from './config'
import { PrintingService } from './service'
import { validationError } from '../businessProfile/service'

// Must register after businessProfile (order 20).
export const order = 60

export { PrintingService } from './service'

const kindEnum = z.enum(TEMPLATE_KINDS)
const paperEnum = z.enum(['58', '80', 'A4', 'A5', 'label'])
const cfgOverride = z.record(z.string(), z.unknown()).optional()
const reportCol = z.object({
  key: z.string(), header: z.string(), align: z.enum(['left', 'right', 'center']).optional(), format: z.enum(['money', 'int', 'date', 'datetime', 'text']).optional()
})

/** Printing a document is allowed for anyone who may use printing OR reprint invoices (cashiers). */
function requireAny(app: App, perms: Permission[]): void {
  app.requireSession()
  if (!perms.some((p) => app.can(p))) throw new AppError('FORBIDDEN', `Permission required: ${perms[0]}`)
}
const parse = <T extends z.ZodType>(schema: T, args: unknown): z.output<T> => {
  const r = schema.safeParse(args ?? {})
  if (!r.success) throw validationError(r.error)
  return r.data
}

export function register(app: App): void {
  const bp = app.get<BusinessProfileService>('businessProfile')
  const svc = app.provide('printing', new PrintingService(app, bp))
  const use: Permission[] = ['printing.view', 'pos.reprint']

  app.expose('printing', {
    templateMeta: (_a, a) => (
      requireAny(a, use),
      TEMPLATE_KINDS.map((k) => ({ kind: k, label: KIND_LABELS[k], paper: paperForKind(k), defaults: defaultConfig(k) }))
    ),
    listTemplates: (_a, a) => (requireAny(a, use), svc.listTemplates()),
    getTemplate: (args, a) => (requireAny(a, use), svc.getTemplate(parse(z.object({ kind: kindEnum }), args).kind)),
    saveTemplate: (args, a) => {
      a.requirePermission('printing.templates')
      const p = parse(z.object({ kind: kindEnum, config: z.record(z.string(), z.unknown()) }), args)
      return svc.saveTemplate(p.kind, p.config as never)
    },
    resetTemplate: (args, a) => (a.requirePermission('printing.templates'), svc.resetTemplate(parse(z.object({ kind: kindEnum }), args).kind)),

    renderInvoiceHtml: (args, a) => {
      requireAny(a, use)
      const p = parse(
        z.object({
          saleId: z.number().int().optional(), returnId: z.number().int().optional(),
          template: z.enum(['receipt58', 'receipt80', 'invoiceA4', 'invoiceA5']),
          sample: z.boolean().optional(), preview: z.boolean().optional(), config: cfgOverride, policy: z.enum(['original', 'current']).optional()
        }),
        args
      )
      return svc.renderInvoiceHtml(p as never)
    },
    renderReportHtml: (args, a) => {
      requireAny(a, [...use, 'reports.view'])
      const p = parse(
        z.object({
          title: z.string(), subtitle: z.string().optional(), columns: z.array(reportCol),
          rows: z.array(z.record(z.string(), z.unknown())), totals: z.record(z.string(), z.unknown()).optional(),
          template: z.enum(['report_sales', 'report_purchase', 'report_inventory']).optional(), config: cfgOverride
        }),
        args
      )
      return svc.renderReportHtml(p as never)
    },
    renderLabelHtml: async (args, a) => {
      requireAny(a, use)
      const p = parse(
        z.object({
          variantIds: z.array(z.object({ variantId: z.number().int(), copies: z.number().int().min(1).max(500).optional() })).optional(),
          template: z.enum(['label_barcode', 'label_product']).optional(), sample: z.boolean().optional(), config: cfgOverride,
          /** Unit labels: unique unit codes (PREFIX-NNNN), `copies` of each. `variantId` skips the lookup when all codes share a product. */
          unitCodes: z.array(z.string().min(1).max(40)).max(2000).optional(), variantId: z.number().int().optional(),
          copies: z.number().int().min(1).max(500).optional()
        }),
        args
      )
      if (p.unitCodes?.length && p.variantId == null) {
        const units: { code: string; variantId: number }[] = []
        for (const code of p.unitCodes) {
          const r = (await a.call('units', 'resolve', { code })) as { unit: { code: string; variantId: number }; variant?: unknown } | null
          if (!r) throw new AppError('NOT_FOUND', `Unit code ${code.trim().toUpperCase()} was not found`)
          units.push({ code: r.unit.code, variantId: r.unit.variantId })
        }
        return svc.renderLabelHtml({ ...p, units, unitCodes: undefined } as never)
      }
      return svc.renderLabelHtml(p as never)
    },

    print: (args, a) => {
      requireAny(a, use)
      return svc.print(
        parse(
          z.object({
            html: z.string().min(1), paper: paperEnum, printerProfileId: z.number().int().optional(), copies: z.number().int().min(1).max(50).optional(),
            widthMm: z.number().positive().optional(), heightMm: z.number().min(0).optional(), docRef: z.string().optional(), showDialog: z.boolean().optional()
          }),
          args
        )
      )
    },
    /** Print a stored sale/return: raw ESC/POS when the receipt printer profile asks for it, else the Windows driver. Never throws for printer errors. */
    printInvoice: (args, a) => {
      requireAny(a, use)
      return svc.printInvoice(
        parse(
          z.object({
            saleId: z.number().int().optional(), returnId: z.number().int().optional(), template: z.enum(['receipt58', 'receipt80', 'invoiceA4', 'invoiceA5']),
            printerProfileId: z.number().int().optional(), copies: z.number().int().min(1).max(50).optional()
          }),
          args
        )
      )
    },
    openDrawer: (args, a) => (requireAny(a, use), svc.openDrawer(parse(z.object({ printerProfileId: z.number().int().optional() }), args))),
    retryPrint: (args, a) => (requireAny(a, use), svc.retryPrint(parse(z.object({ logId: z.number().int(), printerProfileId: z.number().int().optional() }), args))),
    exportPdf: (args, a) => {
      requireAny(a, use)
      return svc.exportPdf(parse(z.object({ html: z.string().min(1), path: z.string().optional(), paper: paperEnum.optional(), widthMm: z.number().positive().optional(), heightMm: z.number().min(0).optional(), name: z.string().optional() }), args))
    },
    testPrint: (args, a) => (requireAny(a, use), svc.testPrint(parse(z.object({ paper: paperEnum, printerProfileId: z.number().int().optional(), dryRun: z.boolean().optional() }), args))),
    /** Print darkness of the printer a paper goes to, as CSS for a preview (the same CSS the print job gets). */
    printLook: (args, a) => (requireAny(a, use), svc.printLook(parse(z.object({ paper: paperEnum, printerProfileId: z.number().int().optional() }), args))),
    listPrintLog: (args, a) => (requireAny(a, use), svc.listPrintLog(parse(z.object({ limit: z.number().int().optional(), onlyFailed: z.boolean().optional() }), args))),

    /** Product picker for the label screen (core lookup: name / sku / barcode). */
    searchVariants: (args, a) => {
      requireAny(a, use)
      const p = parse(z.object({ text: z.string().max(100), limit: z.number().int().min(1).max(100).optional() }), args)
      return a.lookup.search(p.text, p.limit ?? 30)
    },
    listSystemPrinters: (_a, a) => (requireAny(a, use), svc.listSystemPrinters()),
    listPrinterProfiles: (_a, a) => (requireAny(a, use), svc.listPrinterProfiles()),
    savePrinterProfile: (args, a) => {
      a.requirePermission('printing.templates')
      return svc.savePrinterProfile(
        parse(
          z.object({
            id: z.number().int().optional(), name: z.string().trim().min(1, 'Name is required').max(80), deviceName: z.string().max(260),
            kind: z.enum(['receipt58', 'receipt80', 'a4', 'a5', 'label']), calibration: z.record(z.string(), z.unknown()).optional(), isDefault: z.boolean().optional()
          }),
          args
        ) as never
      )
    },
    deletePrinterProfile: (args, a) => {
      a.requirePermission('printing.templates')
      svc.deletePrinterProfile(parse(z.object({ id: z.number().int() }), args).id)
      return { ok: true }
    }
  })
}

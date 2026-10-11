import { z } from 'zod'
import type { App } from '../../core/app'
import { AppError } from '@shared/ipc'
import { CatalogService } from './service'
import { Importer, autoMap, FIELDS } from './importer'
import { FileInput, parse } from './schemas'
import { chooseOpenPath, deliver, readInput } from './io'
import { bulkUpdate, gridList } from './grid'
import { buildPackage, decodePackage, encodePackage, mergePackage } from './package'

export const order = 30
export { CatalogService } from './service'

const MIME = { csv: 'text/csv', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', json: 'application/json', gz: 'application/gzip' }

const Mapping = z.record(z.string(), z.number().int().nullable()).optional()
const ImportArgs = FileInput.extend({
  mapping: Mapping,
  mode: z.enum(['all_or_nothing', 'skip_bad_rows']).optional()
})
const ExportArgs = z.object({
  format: z.enum(['csv', 'xlsx']).default('csv'),
  path: z.string().optional(),
  categoryId: z.number().int().optional(),
  brandId: z.number().int().optional(),
  active: z.boolean().optional(),
  includeStock: z.boolean().optional()
})

export function register(app: App): void {
  const svc = app.provide('catalog', new CatalogService(app))
  const importer = new Importer(app, svc)

  const needFile = async (a: z.output<typeof FileInput>) => {
    if (a.path || a.bytesBase64) return a
    const p = await chooseOpenPath(['csv', 'xlsx', 'json', 'gz'])
    if (p === null) throw new AppError('VALIDATION', 'No file selected')
    if (p === undefined) throw new AppError('VALIDATION', 'Provide {path} or {bytesBase64, filename}')
    return { path: p }
  }

  app.expose('catalog', {
    // ---- products
    list: (a) => svc.list(a),
    get: (a) => svc.get(a),
    findByCode: (a) => svc.findByCode(a),
    save: (a) => svc.save(a),
    remove: (a) => svc.remove(a),
    removeVariant: (a) => svc.removeVariant(a),
    setActive: (a) => svc.setActive(a),
    assignCategory: (a) => svc.assignCategory(a),
    priceHistory: (a) => svc.priceHistory(a),
    getImage: (a) => svc.getImage(a),
    // ---- spreadsheet grid
    gridList: (a) => gridList(app, a),
    bulkUpdate: (a) => bulkUpdate(app, svc, a),
    // ---- barcodes / sku / settings
    generateBarcode: (a) => svc.generateBarcode(a),
    barcodePreview: (a) => svc.previewBarcodeNumbering(a),
    assignBarcode: (a) => svc.assignBarcode(parse(z.object({ variantId: z.number().int().positive(), replace: z.boolean().optional() }), a)),
    generateMissingBarcodes: (a) => svc.generateMissingBarcodes(a),
    validateBarcode: (a) => svc.validateBarcodeFor(a),
    getSettings: () => svc.getSettings(),
    saveSettings: (a) => svc.saveSettings(a),
    // ---- categories / brands
    listCategories: () => svc.listCategories(),
    saveCategory: (a) => svc.saveCategory(a),
    deleteCategory: (a) => svc.deleteCategory(a),
    listBrands: () => svc.listBrands(),
    saveBrand: (a) => svc.saveBrand(a),
    deleteBrand: (a) => svc.deleteBrand(a),

    // ---- import / export (catalog.import). Files: {path} | {bytesBase64, filename}
    importColumns: () => {
      app.requirePermission('catalog.import')
      return FIELDS.map((f) => ({ key: f.key, header: f.header }))
    },
    importPreview: async (a) => {
      app.requirePermission('catalog.import')
      const args = parse(ImportArgs, a)
      return importer.preview(await needFile(args), { mapping: args.mapping as any })
    },
    importCommit: async (a) => {
      app.requirePermission('catalog.import')
      const args = parse(ImportArgs, a)
      return importer.commit(await needFile(args), { mapping: args.mapping as any, mode: args.mode })
    },
    /** Alias of importPreview/importCommit that picks the file via the OS dialog when none is given. */
    importFile: async (a) => {
      app.requirePermission('catalog.import')
      const args = parse(ImportArgs, a)
      const file = await needFile(args)
      return args.mode ? importer.commit(file, { mapping: args.mapping as any, mode: args.mode }) : importer.preview(file, { mapping: args.mapping as any })
    },
    autoMap: (a: { headers?: string[] }) => autoMap(a?.headers ?? []),
    exportFile: async (a) => {
      app.requirePermission('catalog.import')
      const args = parse(ExportArgs, a)
      const bytes = await importer.buildExport(args.format, args)
      return deliver(bytes, { path: args.path, filename: `products.${args.format}`, ext: args.format, mime: MIME[args.format] })
    },
    templateFile: async (a) => {
      app.requirePermission('catalog.import')
      const args = parse(ExportArgs.pick({ format: true, path: true }), a)
      const bytes = await importer.buildTemplate(args.format)
      return deliver(bytes, { path: args.path, filename: `product-import-template.${args.format}`, ext: args.format, mime: MIME[args.format] })
    },

    /** Open-file dialog (renderer-triggered). Returns {path} or {cancelled:true}; {unavailable:true} when there is no UI (tests). */
    pickFile: async (a: { exts?: string[] }) => {
      app.requirePermission('catalog.import')
      const p = await chooseOpenPath(a?.exts ?? ['csv', 'xlsx', 'json', 'gz'])
      return p === null ? { cancelled: true } : p === undefined ? { unavailable: true } : { path: p }
    },

    // ---- catalog package
    packageExport: async (a: { gzip?: boolean; path?: string }) => {
      app.requirePermission('catalog.import')
      const gzip = !!a?.gzip
      const pkg = buildPackage(app.db)
      const out = await deliver(encodePackage(pkg, gzip), {
        path: a?.path, filename: `catalog-package.${gzip ? 'json.gz' : 'json'}`, ext: gzip ? 'gz' : 'json', mime: gzip ? MIME.gz : MIME.json
      })
      return { ...out, counts: Object.fromEntries(Object.entries(pkg.data).map(([k, v]) => [k, v.length])), checksum: pkg.checksum }
    },
    packageImport: async (a) => {
      app.requirePermission('catalog.import')
      const args = parse(FileInput.extend({ dryRun: z.boolean().optional() }), a)
      const { bytes } = readInput(await needFile(args))
      return mergePackage(app, decodePackage(bytes), { dryRun: args.dryRun })
    }
  })
}

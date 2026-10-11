import { z } from 'zod'
import { AppError } from '@shared/ipc'

const money = z.number().int().min(0).max(2_000_000_000)

export const VariantInput = z.object({
  id: z.number().int().positive().optional(),
  name: z.string().trim().max(120).default(''),
  /** blank / missing -> auto-generated on create, unchanged on update */
  sku: z.string().trim().max(64).optional(),
  /** undefined = leave unchanged (update) / none (create); null or '' = clear */
  barcode: z.string().trim().max(64).nullish(),
  /** generate an internal EAN-13 when no barcode is given */
  autoBarcode: z.boolean().optional(),
  /** alias barcodes. undefined = leave unchanged; [] = remove all aliases */
  aliases: z.array(z.string().trim().max(64)).optional(),
  mrp: money.default(0),
  price: money.default(0),
  cost: money.default(0),
  reorderLevel: z.number().int().min(0).max(1_000_000_000).default(0),
  active: z.boolean().default(true),
  /** only honoured when the variant is created */
  openingStock: z.number().int().min(0).max(1_000_000_000).optional()
})
export type VariantInputT = z.output<typeof VariantInput>

export const ImageInput = z.object({
  mime: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
  /** raw base64 (no data: prefix) */
  base64: z.string().min(1)
})

export const ProductInput = z.object({
  id: z.number().int().positive().optional(),
  name: z.string().trim().min(1, 'Product name is required').max(200),
  description: z.string().trim().max(2000).default(''),
  categoryId: z.number().int().positive().nullish(),
  brandId: z.number().int().positive().nullish(),
  hsn: z.string().trim().regex(/^\d{0,8}$/, 'HSN must be up to 8 digits').default(''),
  taxRateBp: z.number().int().min(0, 'GST rate cannot be negative').max(10000, 'GST rate cannot exceed 100%').default(1800),
  unit: z.string().trim().min(1).max(16).default('pcs'),
  trackStock: z.boolean().default(true),
  /** per-unit identification codes (PREFIX-NNNN). undefined = leave unchanged. Turning on also codes existing stock. */
  trackUnits: z.boolean().optional(),
  /** 2-8 chars A-Z0-9, unique across products; blank = suggested automatically when tracking is first turned on */
  unitPrefix: z.string().trim().max(8).nullish(),
  /** turning tracking off while units are still in stock: void them without touching stock */
  discardUnits: z.boolean().optional(),
  active: z.boolean().default(true),
  variants: z.array(VariantInput).min(1, 'A product needs at least one variant').max(200),
  image: ImageInput.nullish(),
  removeImage: z.boolean().optional()
})
export type ProductInputT = z.output<typeof ProductInput>

export const ListQueryInput = z.object({
  search: z.string().trim().max(100).optional(),
  categoryId: z.number().int().positive().optional(),
  brandId: z.number().int().positive().optional(),
  active: z.boolean().optional(),
  lowStock: z.boolean().optional(),
  noBarcode: z.boolean().optional(),
  limit: z.number().int().min(1).max(500).default(50),
  offset: z.number().int().min(0).default(0),
  sort: z.enum(['name', 'updated', 'created', 'id']).default('name'),
  dir: z.enum(['asc', 'desc']).default('asc')
})
export type ListQueryT = z.output<typeof ListQueryInput>

export const NamedInput = z.object({
  id: z.number().int().positive().optional(),
  name: z.string().trim().min(1, 'Name is required').max(100),
  parentId: z.number().int().positive().nullish(),
  active: z.boolean().default(true)
})

export const IdsInput = z.object({ ids: z.array(z.number().int().positive()).min(1).max(5000) })

/** Parse with zod and convert failures into friendly AppError('VALIDATION'). */
export function parse<S extends z.ZodType>(schema: S, args: unknown): z.output<S> {
  const r = schema.safeParse(args ?? {})
  if (r.success) return r.data
  const issue = r.error.issues[0]
  const path = issue.path.length ? issue.path.join('.') + ': ' : ''
  throw new AppError('VALIDATION', path + issue.message, r.error.issues)
}

/** A file given either as a path on disk or inline base64 (renderer upload / tests). */
export const FileInput = z.object({
  path: z.string().optional(),
  bytesBase64: z.string().optional(),
  filename: z.string().optional()
})
export type FileInputT = z.infer<typeof FileInput>

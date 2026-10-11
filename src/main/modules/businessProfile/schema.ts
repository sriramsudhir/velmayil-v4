import { z } from 'zod'
import type { LogoSettings, ReportHeaderSettings } from '@shared/types'

export const GSTIN_RE = /^(0[1-9]|[1-2]\d|3[0-8])[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/
export const PAN_RE = /^[A-Z]{5}\d{4}[A-Z]$/
export const PIN_RE = /^[1-9]\d{5}$/
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/
const PHONE_RE = /^[+()\-\s\d,/]{6,40}$/

export const DEFAULT_LOGO_SETTINGS: LogoSettings = { visible: true, widthMm: 0, heightMm: 0, alignment: 'center', position: 'top' }
export const DEFAULT_HEADER_SETTINGS: ReportHeaderSettings = { showLogo: true, showShopName: true, showAddress: true, showPhone: true, showGstin: true }

const text = (max: number) => z.string().trim().max(max, `At most ${max} characters`).default('')
const mm = z.coerce.number().min(0, 'Must be 0 or more').max(200, 'Too large').default(0)

export const logoSettingsSchema = z.object({
  visible: z.boolean().default(true),
  widthMm: mm,
  heightMm: mm,
  alignment: z.enum(['left', 'center', 'right']).default('center'),
  position: z.enum(['top', 'inline-left', 'inline-right']).default('top')
})
export const headerSettingsSchema = z.object({
  showLogo: z.boolean().default(true),
  showShopName: z.boolean().default(true),
  showAddress: z.boolean().default(true),
  showPhone: z.boolean().default(true),
  showGstin: z.boolean().default(true)
})

export const profileFieldsSchema = z.object({
  shopName: z.string().trim().min(1, 'Shop name is required').max(120, 'Shop name is too long (max 120)'),
  legalName: text(160),
  displayName: text(120),
  shortName: text(40),
  address: text(300),
  city: text(80),
  state: text(80),
  pinCode: z.string().trim().default('').refine((v) => v === '' || PIN_RE.test(v), 'PIN code must be 6 digits'),
  phone: z.string().trim().default('').refine((v) => v === '' || (PHONE_RE.test(v) && v.replace(/\D/g, '').length >= 6), 'Enter a valid phone number'),
  email: z.string().trim().default('').refine((v) => v === '' || EMAIL_RE.test(v), 'Enter a valid email address'),
  website: z.string().trim().max(200).default('').refine((v) => v === '' || /^(https?:\/\/)?[^\s/$.?#][^\s]*\.[^\s]{2,}$/i.test(v), 'Enter a valid website'),
  gstin: z.string().trim().default('').transform((v) => v.toUpperCase()).refine((v) => v === '' || GSTIN_RE.test(v), 'GSTIN must be 15 characters, e.g. 22AAAAA0000A1Z5'),
  pan: z.string().trim().default('').transform((v) => v.toUpperCase()).refine((v) => v === '' || PAN_RE.test(v), 'PAN must look like ABCDE1234F'),
  footerText: text(300),
  logoSettings: logoSettingsSchema.default({ ...DEFAULT_LOGO_SETTINGS }),
  headerSettings: headerSettingsSchema.default({ ...DEFAULT_HEADER_SETTINGS })
})

export type ProfileFields = z.infer<typeof profileFieldsSchema>

/** Parse + normalise; throws ZodError (caller converts to AppError VALIDATION). displayName defaults to shopName. */
export function parseProfileFields(raw: unknown): ProfileFields {
  const f = profileFieldsSchema.parse(raw)
  if (!f.displayName) f.displayName = f.shopName
  return f
}

export const parseLogoSettings = (raw: unknown): LogoSettings => {
  const r = logoSettingsSchema.safeParse(raw ?? {})
  return r.success ? r.data : { ...DEFAULT_LOGO_SETTINGS }
}
export const parseHeaderSettings = (raw: unknown): ReportHeaderSettings => {
  const r = headerSettingsSchema.safeParse(raw ?? {})
  return r.success ? r.data : { ...DEFAULT_HEADER_SETTINGS }
}

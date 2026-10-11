import { z, type ZodType } from 'zod'
import { AppError } from '@shared/ipc'

export const id = z.number().int().positive()
export const qtyPos = z.number().int().positive().max(10_000_000)
export const paise = z.number().int().min(0).max(100_000_000_000)
export const bp = z.number().int().min(0).max(100_000)
export const text = (max = 500) => z.string().trim().max(max)
export const page = {
  limit: z.number().int().min(1).max(10_000).optional(),
  offset: z.number().int().min(0).optional()
}

/** Validate input with zod and surface a friendly AppError(VALIDATION). */
export function parse<T>(schema: ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input ?? {})
  if (r.success) return r.data
  const msg = r.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')
  throw new AppError('VALIDATION', msg, r.error.issues)
}

/** LIKE pattern with wildcards escaped (backslash). Every query using it must add `ESCAPE '\'`. */
export const likeTerm = (s: string): string => `%${s.trim().replace(/[\\%_]/g, (c) => '\\' + c)}%`

export const ADJUST_REASONS = ['damage', 'expiry', 'theft', 'found', 'correction'] as const
export type AdjustReason = (typeof ADJUST_REASONS)[number]

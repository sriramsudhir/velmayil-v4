import type { z } from 'zod'
import { AppError } from '@shared/ipc'

/** Parse IPC args with zod and throw a friendly AppError('VALIDATION') listing field problems. Reusable by any module. */
export function parseInput<S extends z.ZodType>(schema: S, args: unknown): z.output<S> {
  const r = schema.safeParse(args)
  if (r.success) return r.data
  const fields: Record<string, string> = {}
  for (const i of r.error.issues) fields[i.path.join('.') || '_'] ??= i.message
  const first = r.error.issues[0]
  const where = first.path.length ? `${first.path.join('.')}: ` : ''
  throw new AppError('VALIDATION', `${where}${first.message}`, { fields })
}

/** Column names of a SQLite "UNIQUE constraint failed: t.a, t.b" message, humanised ("invoice no"). */
const uniqueColumns = (msg: string): string =>
  msg.replace(/^.*failed:\s*/i, '').split(',').map((c) => c.trim().split('.').pop()!.replace(/_/g, ' ')).filter(Boolean).join(', ')

/**
 * Normalise anything a service threw into an AppError so the renderer always gets a readable message:
 *  - a raw ZodError (schema.parse without parseInput) -> VALIDATION "field: problem" (never the JSON dump of issues)
 *  - SQLite constraint failures -> CONFLICT / VALIDATION in plain words
 *  - everything else -> INTERNAL with the original message
 */
export function toAppError(e: unknown): AppError {
  if (e instanceof AppError) return e
  const issues = (e as { issues?: { path?: PropertyKey[]; message?: string }[] } | null)?.issues
  if (Array.isArray(issues) && issues.length && (e as { name?: string }).name?.includes('ZodError')) {
    const fields: Record<string, string> = {}
    for (const i of issues) fields[(i.path ?? []).map(String).join('.') || '_'] ??= String(i.message ?? 'Invalid value')
    const first = issues[0]
    const where = first.path?.length ? `${first.path.map(String).join('.')}: ` : ''
    return new AppError('VALIDATION', `${where}${first.message ?? 'Invalid value'}`, { fields })
  }
  const msg = e instanceof Error ? e.message : typeof e === 'string' ? e : ''
  if (/UNIQUE constraint failed/i.test(msg)) return new AppError('CONFLICT', `A record with the same ${uniqueColumns(msg) || 'value'} already exists`)
  if (/FOREIGN KEY constraint failed/i.test(msg)) return new AppError('CONFLICT', 'This record is linked to other records, so it cannot be removed or changed this way')
  if (/NOT NULL constraint failed|CHECK constraint failed/i.test(msg)) return new AppError('VALIDATION', `A required value is missing or not allowed (${uniqueColumns(msg) || 'check the entered values'})`)
  if (/database is locked|SQLITE_BUSY/i.test(msg)) return new AppError('CONFLICT', 'The database is busy (a backup or another task is running). Please try again in a moment.')
  if (/database or disk is full|SQLITE_FULL/i.test(msg)) return new AppError('INTERNAL', 'The disk is full: free some space on this computer, then try again.')
  return new AppError('INTERNAL', msg || 'Unexpected error')
}

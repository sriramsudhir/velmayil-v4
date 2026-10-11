/**
 * Pure helpers for "Print barcode label" with unique label numbers (no UI, no IPC).
 * Server contract: units.labelPlan / units.issueLabels / units.reprintLabels (main/modules/units/service.ts).
 */

export interface LabelPlan {
  variantId: number
  displayName: string
  /** 'unique' = every label gets its own number; 'shared' = the product does not track stock: labels carry the product barcode */
  mode: 'unique' | 'shared'
  tracked: boolean
  prefix: string | null
  stock: number
  unlabelled: number
  previewCodes: string[]
  blocked: string | null
  canReceive: boolean
}

export interface IssuedLabels { variantId: number; prefix: string; codes: string[]; received: number }
export interface Shortfall { variantId: number; name: string; requested: number; unlabelled: number; extra: number }

/** Most labels one printing.renderLabelHtml call draws. */
export const MAX_LABELS_PER_RUN = 2000

export const chunk = <T,>(list: T[], size: number): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < list.length; i += Math.max(1, size)) out.push(list.slice(i, i + Math.max(1, size)))
  return out
}

/** Which variants get their own numbers and which keep the shared product barcode (no stock tracking). */
export function splitPlans(variantIds: number[], plans: LabelPlan[] | null): { unique: number[]; shared: number[] } {
  const byId = new Map((plans ?? []).map((p) => [p.variantId, p]))
  const unique: number[] = []
  const shared: number[] = []
  for (const id of variantIds) (byId.get(id)?.mode === 'unique' ? unique : shared).push(id)
  return { unique, shared }
}

/** One number as it is, several as "first to last (count)". */
export function codeRangeText(codes: string[]): string {
  if (!codes.length) return ''
  return codes.length === 1 ? codes[0] : `${codes[0]} to ${codes[codes.length - 1]} (${codes.length})`
}

/** One line per product that has fewer unlabelled pieces in stock than the labels asked for. */
export function shortfallLines(list: Shortfall[], max = 5): string[] {
  const lines = list.slice(0, max).map((s) =>
    s.unlabelled === 0
      ? `${s.name}: no piece in stock is waiting for a label, but ${s.requested} label${s.requested === 1 ? ' was' : 's were'} asked for.`
      : `${s.name}: only ${s.unlabelled} piece${s.unlabelled === 1 ? '' : 's'} in stock ${s.unlabelled === 1 ? 'has' : 'have'} no label yet, but ${s.requested} labels were asked for.`
  )
  if (list.length > max) lines.push(`... and ${list.length - max} more product${list.length - max === 1 ? '' : 's'}.`)
  return lines
}

export const shortfallExtra = (list: Shortfall[]): number => list.reduce((n, s) => n + s.extra, 0)

/** The shortfall list of a units.issueLabels error, or null for any other error. */
export function shortfallsOf(e: unknown): Shortfall[] | null {
  const d = (e as { details?: { code?: string; shortfalls?: Shortfall[] } } | null)?.details
  return d?.code === 'LABELS_EXCEED_STOCK' && Array.isArray(d.shortfalls) ? d.shortfalls : null
}

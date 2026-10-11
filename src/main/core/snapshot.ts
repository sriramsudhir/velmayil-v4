import type { Db } from '../db/driver'

export interface Snapshot {
  table: string
  uuid: string
  /** Full row. Local integer FK columns stay as-is, but see __refs for portable references. */
  row: Record<string, unknown>
  /** For each FK column: the referenced table + that row's uuid (portable across POS terminals). */
  refs: Record<string, { table: string; uuid: string } | null>
  children?: Record<string, Snapshot[]>
}

export interface ChildSpec {
  table: string
  fk: string
  children?: ChildSpec[]
}

const BLOBS_SKIPPED = new Set(['bytes', 'print_bytes'])

/** Portable image of a row (+ child rows) for the sync queue. Rows without a `uuid` column get uuid ''. */
export function snapshotRow(db: Db, table: string, id: number | string, children: ChildSpec[] = [], idCol = 'id'): Snapshot {
  const row = db.get<Record<string, unknown>>(`SELECT * FROM ${table} WHERE ${idCol} = ?`, id as number)
  if (!row) throw new Error(`snapshotRow: ${table}#${id} not found`)
  return build(db, table, row, children)
}

function build(db: Db, table: string, row: Record<string, unknown>, children: ChildSpec[]): Snapshot {
  const clean: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row)) if (!BLOBS_SKIPPED.has(k)) clean[k] = v
  const refs: Snapshot['refs'] = {}
  for (const fk of db.all<{ from: string; table: string; to: string }>(`PRAGMA foreign_key_list(${table})`)) {
    const val = row[fk.from]
    if (val == null) {
      refs[fk.from] = null
      continue
    }
    const hasUuid = db.all<{ name: string }>(`PRAGMA table_info(${fk.table})`).some((c) => c.name === 'uuid')
    const uuid = hasUuid ? db.value<string>(`SELECT uuid FROM ${fk.table} WHERE ${fk.to || 'id'} = ?`, val as number) : undefined
    refs[fk.from] = uuid ? { table: fk.table, uuid } : null
  }
  const snap: Snapshot = { table, uuid: (row.uuid as string) ?? '', row: clean, refs }
  if (children.length) {
    snap.children = {}
    for (const c of children) {
      const rows = db.all<Record<string, unknown>>(`SELECT * FROM ${c.table} WHERE ${c.fk} = ?`, row.id as number)
      snap.children[c.table] = rows.map((r) => build(db, c.table, r, c.children ?? []))
    }
  }
  return snap
}

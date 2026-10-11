import { useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { EmptyState, Select } from './base'
import { SkeletonTable } from './display'

export interface DataColumn<T> {
  key: string
  header: ReactNode
  render?: (row: T) => ReactNode
  align?: 'left' | 'right' | 'center'
  width?: string
  /** enable header click sorting; uses sortValue(row) or row[key] */
  sortable?: boolean
  sortValue?: (row: T) => string | number | null | undefined
  /** monospace/tabular figures (use for money/qty columns) */
  numeric?: boolean
}
const AUTO_PAGE_ABOVE = 300
const AUTO_PAGE_SIZE = 100
export interface SortState { key: string; dir: 'asc' | 'desc' }

/**
 * Sortable, keyboard-navigable table with sticky header. Up/Down/Home/End move row focus, Enter/Space activates onRowClick.
 * Sorting is client-side unless `sort` + `onSortChange` are supplied (controlled; then you sort rows yourself).
 * Optional client pagination via `pageSize`.
 */
export function DataTable<T>({ columns, rows, rowKey, onRowClick, empty, loading, sort: sortProp, onSortChange, defaultSort, pageSize: pageSizeProp, maxHeight, dense, selectedKey, caption }: {
  columns: DataColumn<T>[]
  rows: T[]
  rowKey: (r: T) => string | number
  onRowClick?: (r: T) => void
  empty?: ReactNode
  loading?: boolean
  sort?: SortState | null
  onSortChange?: (s: SortState | null) => void
  defaultSort?: SortState
  pageSize?: number
  maxHeight?: number | string
  dense?: boolean
  selectedKey?: string | number | null
  caption?: string
}) {
  // Safety net: a few thousand <tr>s is a 150 ms+ layout/paint stall, so big lists page themselves unless the caller chose a size.
  const pageSize = pageSizeProp ?? (rows.length > AUTO_PAGE_ABOVE ? AUTO_PAGE_SIZE : undefined)
  const [inner, setInner] = useState<SortState | null>(defaultSort ?? null)
  const [page, setPage] = useState(1)
  const controlled = onSortChange != null
  const sort = controlled ? sortProp ?? null : inner
  const body = useRef<HTMLTableSectionElement>(null)

  const sorted = useMemo(() => {
    if (!sort || controlled) return rows
    const col = columns.find((c) => c.key === sort.key)
    if (!col) return rows
    const val = (r: T) => col.sortValue ? col.sortValue(r) : ((r as Record<string, unknown>)[col.key] as string | number | null | undefined)
    const dir = sort.dir === 'asc' ? 1 : -1
    return [...rows].sort((a, b) => {
      const x = val(a), y = val(b)
      if (x == null && y == null) return 0
      if (x == null) return 1
      if (y == null) return -1
      return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'en-IN', { numeric: true, sensitivity: 'base' })) * dir
    })
  }, [rows, sort, columns, controlled])

  const pages = pageSize ? Math.max(1, Math.ceil(sorted.length / pageSize)) : 1
  const cur = Math.min(page, pages)
  const view = pageSize ? sorted.slice((cur - 1) * pageSize, cur * pageSize) : sorted

  const toggle = (c: DataColumn<T>) => {
    if (!c.sortable) return
    const next: SortState | null = sort?.key !== c.key ? { key: c.key, dir: 'asc' } : sort.dir === 'asc' ? { key: c.key, dir: 'desc' } : null
    if (controlled) onSortChange?.(next); else setInner(next)
    setPage(1)
  }
  const onKey = (e: KeyboardEvent<HTMLTableRowElement>, r: T) => {
    const trs = Array.from(body.current?.querySelectorAll<HTMLTableRowElement>('tr') ?? [])
    const i = trs.indexOf(e.currentTarget)
    const go = (n: number) => { e.preventDefault(); trs[Math.max(0, Math.min(trs.length - 1, n))]?.focus() }
    if (e.key === 'ArrowDown') go(i + 1)
    else if (e.key === 'ArrowUp') go(i - 1)
    else if (e.key === 'Home') go(0)
    else if (e.key === 'End') go(trs.length - 1)
    else if (e.key === 'PageDown') go(i + 10)
    else if (e.key === 'PageUp') go(i - 10)
    else if ((e.key === 'Enter' || e.key === ' ') && onRowClick) { e.preventDefault(); onRowClick(r) }
  }

  if (loading) return <SkeletonTable cols={columns.length} />
  if (!rows.length) return <>{empty ?? <EmptyState title="Nothing here yet" />}</>
  return (
    <>
      <div className="table-wrap" style={maxHeight ? { maxHeight } : undefined}>
        <table className={`table ${dense ? 'table-dense' : ''}`}>
          {caption && <caption className="sr-only">{caption}</caption>}
          <thead>
            <tr>
              {columns.map((c) => {
                const active = sort?.key === c.key
                return (
                  <th key={c.key} scope="col" style={{ textAlign: c.align, width: c.width }} aria-sort={active ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : c.sortable ? 'none' : undefined}>
                    {c.sortable
                      ? <button type="button" className="th-sort" onClick={() => toggle(c)} style={{ justifyContent: c.align === 'right' ? 'flex-end' : c.align === 'center' ? 'center' : 'flex-start' }}>{c.header}<span className="sort-ind" aria-hidden="true">{active ? (sort!.dir === 'asc' ? '▲' : '▼') : '↕'}</span></button>
                      : c.header}
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody ref={body}>
            {view.map((r) => {
              const k = rowKey(r)
              return (
                <tr key={k} tabIndex={onRowClick ? 0 : undefined} aria-selected={selectedKey != null ? k === selectedKey : undefined}
                  className={`${onRowClick ? 'clickable' : ''} ${selectedKey === k ? 'selected' : ''}`}
                  onClick={onRowClick ? () => onRowClick(r) : undefined} onKeyDown={onRowClick ? (e) => onKey(e, r) : undefined}>
                  {columns.map((c) => (
                    <td key={c.key} className={c.numeric ? 'num' : undefined} style={{ textAlign: c.align }}>{c.render ? c.render(r) : String((r as Record<string, unknown>)[c.key] ?? '')}</td>
                  ))}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {pageSize && sorted.length > pageSize && <Pagination page={cur} pageSize={pageSize} total={sorted.length} onPage={setPage} />}
    </>
  )
}

/** Page controls for server- or client-side paging. `page` is 1-based. */
export function Pagination({ page, pageSize, total, onPage, onPageSize, pageSizes = [25, 50, 100] }: { page: number; pageSize: number; total: number; onPage: (p: number) => void; onPageSize?: (n: number) => void; pageSizes?: number[] }) {
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1
  const to = Math.min(total, page * pageSize)
  const btn = (label: string, target: number, disabled: boolean, aria: string) => (
    <button type="button" className="btn btn-sm" disabled={disabled} aria-label={aria} onClick={() => onPage(target)}>{label}</button>
  )
  return (
    <nav className="pagination" aria-label="Pagination">
      <span className="muted">{from}–{to} of {total}</span>
      <span className="row">
        {onPageSize && <Select aria-label="Rows per page" value={pageSize} onChange={(e) => onPageSize(Number(e.target.value))} style={{ width: 'auto' }}>{pageSizes.map((n) => <option key={n} value={n}>{n} / page</option>)}</Select>}
        {btn('«', 1, page <= 1, 'First page')}
        {btn('‹', page - 1, page <= 1, 'Previous page')}
        <span className="page-ind">Page {page} of {pages}</span>
        {btn('›', page + 1, page >= pages, 'Next page')}
        {btn('»', pages, page >= pages, 'Last page')}
      </span>
    </nav>
  )
}

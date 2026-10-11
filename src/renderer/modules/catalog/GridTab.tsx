import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, ErrorState, Input, Select, Spinner, useAsync, useToast } from '@/ui'
import { call, errMsg, ApiError } from '@/lib/api'
import { useSession } from '@/lib/session'
import { useLiveRefresh } from '@/lib/live'
import { stripScanDecorations } from '@shared/scanCode'
import { ImportWizard } from './ImportWizard'
import { downloadBase64, type Brand, type Category } from './types'
import {
  COLS, FIELD_TO_COL, GST_OK, baseText, blankRow, parseCell, parseClipboard, toClipboard,
  type ColKey, type GridRow, type Lookups
} from './gridModel'

const ROW_H = 28
const HEAD_H = 58
const OVERSCAN = 8

type Edits = Map<string, Partial<Record<ColKey, string>>>
interface Doc { edits: Edits; added: string[] }
interface Row { id: string; g: GridRow; isNew: boolean }
interface Pos { r: number; c: number }
type Issue = { level: 'error' | 'warn'; msg: string }

const EMPTY: Doc = { edits: new Map(), added: [] }
const colIndex = (k: ColKey) => COLS.findIndex((c) => c.key === k)
const frozenLeft = (() => {
  let x = 0
  return COLS.map((c) => (c.frozen ? ((x += c.width), x - c.width) : -1))
})()
const FROZEN_W = COLS.filter((c) => c.frozen).reduce((s, c) => s + c.width, 0)
const TOTAL_W = COLS.reduce((s, c) => s + c.width, 0)
const LEFT = (() => {
  let x = 0
  return COLS.map((c) => ((x += c.width), x - c.width))
})()

const CSS = `
.xg-wrap{display:flex;flex-direction:column;gap:8px}
.xg-bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.xg-scroll{position:relative;overflow:auto;border:1px solid var(--line-strong);border-radius:6px;background:var(--panel);height:calc(100vh - 290px);min-height:320px;outline:none}
.xg-scroll:focus-visible{box-shadow:var(--focus-ring)}
.xg-head{position:sticky;top:0;z-index:8;background:var(--panel-2);height:${HEAD_H}px;display:flex;flex-direction:column}
.xg-hrow{display:flex;height:30px}
.xg-frow{display:flex;height:28px}
.xg-h{box-sizing:border-box;flex:none;border-right:1px solid var(--line);border-bottom:1px solid var(--line);padding:0 6px;font-size:12px;font-weight:600;display:flex;align-items:center;cursor:pointer;user-select:none;background:var(--panel-2);overflow:hidden;white-space:nowrap}
.xg-f{box-sizing:border-box;flex:none;border-right:1px solid var(--line);border-bottom:1px solid var(--line-strong);background:var(--panel-2);padding:2px}
.xg-f input{width:100%;height:22px;box-sizing:border-box;font-size:12px;padding:0 4px;border:1px solid var(--line);border-radius:3px;background:var(--input-bg);color:var(--text)}
.xg-body{position:relative}
.xg-row{position:absolute;left:0;display:flex;height:${ROW_H}px}
.xg-c{box-sizing:border-box;flex:none;height:${ROW_H}px;line-height:${ROW_H - 1}px;padding:0 6px;border-right:1px solid var(--line);border-bottom:1px solid var(--line);font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:var(--panel);cursor:cell;position:relative}
.xg-c.num{text-align:right}
.xg-c.ro{color:var(--muted);background:var(--panel-2)}
.xg-c.fz{position:sticky;z-index:5}
.xg-c.dirty{background:var(--warn-bg)}
.xg-c.newrow{background:var(--info-bg)}
.xg-c.sel{background:var(--info-bg)}
.xg-c.active{outline:2px solid var(--focus);outline-offset:-2px;z-index:4}
.xg-c.err{box-shadow:inset 0 0 0 2px var(--bad)}
.xg-c.warn{box-shadow:inset 0 0 0 2px var(--warn)}
.xg-c input.xg-in{position:absolute;inset:0;width:100%;height:100%;box-sizing:border-box;border:2px solid var(--focus);padding:0 5px;font:inherit;background:var(--input-bg);color:var(--text);outline:none;text-align:inherit}
.xg-status{font-size:12px;color:var(--muted);display:flex;gap:12px;flex-wrap:wrap}
`

export function GridTab({ categories, brands, reloadTaxonomy }: { categories: Category[]; brands: Brand[]; reloadTaxonomy: () => void }) {
  const toast = useToast()
  const { can } = useSession()
  const canEdit = can('catalog.edit')
  const data = useAsync(() => call<{ rows: GridRow[]; total: number }>('catalog', 'gridList', {}), [])
  useLiveRefresh(['catalog', 'inventory', 'purchases', 'pos'], data.reload)

  const [doc, setDocState] = useState<Doc>(EMPTY)
  const docRef = useRef(doc)
  const hist = useRef<{ past: Doc[]; future: Doc[] }>({ past: [], future: [] })
  const seq = useRef(0)
  const [serverErr, setServerErr] = useState<Map<string, string>>(new Map())
  const [saving, setSaving] = useState(false)

  const [search, setSearch] = useState('')
  const [catFilter, setCatFilter] = useState('')
  const [activeFilter, setActiveFilter] = useState('1')
  const [changedOnly, setChangedOnly] = useState(false)
  const [colFilter, setColFilter] = useState<Partial<Record<ColKey, string>>>({})
  const [sort, setSort] = useState<{ key: ColKey; dir: 1 | -1 } | null>(null)
  const [showImport, setShowImport] = useState(false)

  const [sel, setSel] = useState<Pos>({ r: 0, c: 1 })
  const [anchor, setAnchor] = useState<Pos>({ r: 0, c: 1 })
  const [editing, setEditing] = useState<{ text: string; select?: boolean } | null>(null)
  const editingRef = useRef<{ text: string; select?: boolean } | null>(null)
  const setEdit = (e: { text: string; select?: boolean } | null) => { editingRef.current = e; setEditing(e) }

  const scrollRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewH, setViewH] = useState(500)

  // ------------------------------------------------------------------ lookups
  const lookups: Lookups = useMemo(() => {
    const cm = new Map<string, number>()
    for (const c of categories) { cm.set(c.path.toLowerCase(), c.id); if (!cm.has(c.name.toLowerCase())) cm.set(c.name.toLowerCase(), c.id) }
    const bm = new Map<string, number>()
    for (const b of brands) bm.set(b.name.toLowerCase(), b.id)
    return { categories: cm, brands: bm }
  }, [categories, brands])

  // ------------------------------------------------------------------ rows (filter + sort on BASE values so rows do not jump while typing)
  const baseRows = data.data?.rows
  const byId = useMemo(() => {
    const m = new Map<string, Row>()
    for (const g of baseRows ?? []) m.set('v' + g.variantId, { id: 'v' + g.variantId, g, isNew: false })
    return m
  }, [baseRows])

  const rows: Row[] = useMemo(() => {
    let list = [...byId.values()]
    const s = search.trim().toLowerCase()
    const cf = catFilter ? Number(catFilter) : null
    const catSet = cf ? descendantIds(categories, cf) : null
    list = list.filter(({ g }) => {
      if (activeFilter !== '' && g.active !== (activeFilter === '1')) return false
      if (catSet && !(g.categoryId && catSet.has(g.categoryId))) return false
      if (s && !(g.name.toLowerCase().includes(s) || g.sku.toLowerCase().includes(s) || g.variantName.toLowerCase().includes(s) || (g.barcode ?? '').includes(s))) return false
      for (const [k, v] of Object.entries(colFilter)) {
        if (v && !baseText(g, k as ColKey).toLowerCase().includes(v.toLowerCase())) return false
      }
      return true
    })
    if (sort) {
      const col = COLS[colIndex(sort.key)]
      const val = (g: GridRow): string | number => (col.num ? numVal(g, sort.key) : baseText(g, sort.key).toLowerCase())
      list.sort((a, b) => {
        const x = val(a.g), y = val(b.g)
        return (x < y ? -1 : x > y ? 1 : 0) * sort.dir
      })
    }
    if (changedOnly) list = list.filter((r) => doc.edits.has(r.id))
    const added: Row[] = doc.added.map((id) => ({ id, g: blankRow(), isNew: true }))
    return [...added, ...list]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [byId, search, catFilter, activeFilter, colFilter, sort, changedOnly, changedOnly ? doc.edits : null, doc.added, categories])

  // ------------------------------------------------------------------ cell value / validation
  const textOf = useCallback((row: Row, k: ColKey): string => doc.edits.get(row.id)?.[k] ?? baseText(row.g, k), [doc.edits])

  const dups = useMemo(() => {
    const m = new Map<string, number>()
    const add = (key: string) => m.set(key, (m.get(key) ?? 0) + 1)
    const edited = doc.edits
    for (const [id, r] of byId) {
      const e = edited.get(id)
      const bc = (e?.barcode ?? r.g.barcode ?? '').trim()
      const sku = (e?.sku ?? r.g.sku).trim().toLowerCase()
      if (bc) add('b:' + bc)
      if (sku) add('s:' + sku)
    }
    for (const id of doc.added) {
      const e = edited.get(id)
      if (e?.barcode?.trim()) add('b:' + e.barcode.trim())
      if (e?.sku?.trim()) add('s:' + e.sku.trim().toLowerCase())
    }
    return m
  }, [byId, doc])

  const issueFor = useCallback((row: Row, k: ColKey): Issue | null => {
    const se = serverErr.get(`${row.id}:${k}`)
    if (se) return { level: 'error', msg: se }
    const e = doc.edits.get(row.id)
    if (!e) return row.isNew && k === 'name' ? { level: 'error', msg: 'Name is required for a new product' } : null
    const t = e[k]
    if (t !== undefined) {
      const p = parseCell(k, t, lookups)
      if (!p.ok) return { level: 'error', msg: p.msg }
      if (k === 'barcode' && t.trim() && (dups.get('b:' + t.trim()) ?? 0) > 1) return { level: 'error', msg: 'Duplicate barcode in this sheet or catalog' }
      if (k === 'sku' && (dups.get('s:' + t.trim().toLowerCase()) ?? 0) > 1) return { level: 'error', msg: 'Duplicate SKU' }
      if (k === 'gst' && !GST_OK.has(Number(t.replace(/%$/, '') || 0))) return { level: 'warn', msg: 'GST is not one of 0 / 5 / 12 / 18 / 28 %' }
    }
    if (k === 'price' || k === 'mrp') {
      const mrp = parseCell('mrp', textOf(row, 'mrp'), lookups)
      const price = parseCell('price', textOf(row, 'price'), lookups)
      if (mrp.ok && price.ok && (mrp.value as number) > 0 && (price.value as number) > (mrp.value as number)) return { level: 'warn', msg: 'Selling price is above MRP' }
    }
    if (row.isNew && k === 'name' && !(e.name ?? '').trim()) return { level: 'error', msg: 'Name is required for a new product' }
    return null
  }, [doc.edits, serverErr, lookups, dups, textOf])

  const counts = useMemo(() => {
    let cells = 0, errors = 0, warns = 0
    for (const id of new Set([...doc.edits.keys(), ...doc.added])) {
      const row = byId.get(id) ?? { id, g: blankRow(), isNew: true }
      cells += Object.keys(doc.edits.get(id) ?? {}).length
      for (const c of COLS) {
        const i = issueFor(row, c.key)
        if (i?.level === 'error') errors++
        else if (i?.level === 'warn') warns++
      }
    }
    return { cells, errors, warns, rows: new Set([...doc.edits.keys(), ...doc.added]).size }
  }, [doc, byId, issueFor])

  // ------------------------------------------------------------------ document edits (+ undo/redo)
  const setDoc = (next: Doc, record = true) => {
    if (record) {
      hist.current.past.push(docRef.current)
      if (hist.current.past.length > 200) hist.current.past.shift()
      hist.current.future = []
    }
    docRef.current = next
    setDocState(next)
  }
  const undo = () => {
    const p = hist.current.past.pop()
    if (!p) return
    hist.current.future.push(docRef.current)
    setDoc(p, false)
  }
  const redo = () => {
    const f = hist.current.future.pop()
    if (!f) return
    hist.current.past.push(docRef.current)
    setDoc(f, false)
  }

  /** Apply cell text changes. Setting a cell back to its original value un-dirties it. */
  const applyCells = (changes: { row: Row; k: ColKey; text: string }[]) => {
    if (!canEdit || !changes.length) return
    const cur = docRef.current
    const edits: Edits = new Map(cur.edits)
    let changed = false
    for (const change of changes) {
      const { row, k } = change
      // a scanned barcode may carry reader decorations (CR/LF/Tab, ]E0, Code 39 stars): never store those
      const text = k === 'barcode' ? stripScanDecorations(change.text) : change.text
      if (COLS[colIndex(k)].field === undefined) continue
      const prev = edits.get(row.id) ?? {}
      const orig = baseText(row.g, k)
      const next = { ...prev }
      if (text === orig && !row.isNew) delete next[k]
      else next[k] = text
      if (next[k] === prev[k]) continue
      changed = true
      if (Object.keys(next).length) edits.set(row.id, next)
      else edits.delete(row.id)
    }
    if (changed) setDoc({ edits, added: cur.added })
  }

  // ------------------------------------------------------------------ navigation
  const clamp = (p: Pos): Pos => ({ r: Math.max(0, Math.min(rows.length - 1, p.r)), c: Math.max(0, Math.min(COLS.length - 1, p.c)) })
  const reveal = (p: Pos) => {
    const el = scrollRef.current
    if (!el) return
    const top = p.r * ROW_H
    if (top < el.scrollTop) el.scrollTop = top
    else if (top + ROW_H > el.scrollTop + el.clientHeight - HEAD_H) el.scrollTop = top + ROW_H - el.clientHeight + HEAD_H + 2
    const left = LEFT[p.c]
    if (!COLS[p.c].frozen) {
      if (left - FROZEN_W < el.scrollLeft) el.scrollLeft = Math.max(0, left - FROZEN_W)
      else if (left + COLS[p.c].width > el.scrollLeft + el.clientWidth) el.scrollLeft = left + COLS[p.c].width - el.clientWidth + 2
    }
  }
  const moveTo = (p: Pos, extend = false) => {
    const q = clamp(p)
    setSel(q)
    if (!extend) setAnchor(q)
    reveal(q)
  }

  const range = useMemo(() => ({
    r0: Math.min(sel.r, anchor.r), r1: Math.max(sel.r, anchor.r), c0: Math.min(sel.c, anchor.c), c1: Math.max(sel.c, anchor.c)
  }), [sel, anchor])

  const startEdit = (initial?: string) => {
    const row = rows[sel.r]
    if (!canEdit || !row || COLS[sel.c].field === undefined) return
    setEdit({ text: initial ?? textOf(row, COLS[sel.c].key), select: initial === undefined })
  }
  const commitEdit = (move?: Pos) => {
    const e = editingRef.current
    if (!e) return
    const row = rows[sel.r]
    setEdit(null)
    if (row) applyCells([{ row, k: COLS[sel.c].key, text: e.text }])
    if (move) moveTo(move)
    scrollRef.current?.focus()
  }
  const cancelEdit = () => { setEdit(null); scrollRef.current?.focus() }

  const rangeCells = (): { row: Row; k: ColKey }[] => {
    const out: { row: Row; k: ColKey }[] = []
    for (let r = range.r0; r <= range.r1; r++) for (let c = range.c0; c <= range.c1; c++) if (rows[r]) out.push({ row: rows[r], k: COLS[c].key })
    return out
  }

  const fillDown = () => {
    const ch: { row: Row; k: ColKey; text: string }[] = []
    if (range.r0 === range.r1) {
      if (range.r0 === 0) return
      for (let c = range.c0; c <= range.c1; c++) ch.push({ row: rows[range.r0], k: COLS[c].key, text: textOf(rows[range.r0 - 1], COLS[c].key) })
    } else {
      for (let c = range.c0; c <= range.c1; c++) {
        const src = textOf(rows[range.r0], COLS[c].key)
        for (let r = range.r0 + 1; r <= range.r1; r++) ch.push({ row: rows[r], k: COLS[c].key, text: src })
      }
    }
    applyCells(ch)
  }

  const onCopy = (e: React.ClipboardEvent) => {
    if (editingRef.current) return
    const m: string[][] = []
    for (let r = range.r0; r <= range.r1; r++) m.push(COLS.slice(range.c0, range.c1 + 1).map((c) => (rows[r] ? textOf(rows[r], c.key) : '')))
    e.clipboardData.setData('text/plain', toClipboard(m))
    e.preventDefault()
  }
  const onPaste = (e: React.ClipboardEvent) => {
    if (editingRef.current || !canEdit) return
    const text = e.clipboardData.getData('text/plain')
    if (!text) return
    e.preventDefault()
    const m = parseClipboard(text)
    if (!m.length) return
    const ch: { row: Row; k: ColKey; text: string }[] = []
    const single = m.length === 1 && m[0].length === 1
    const multiSel = range.r1 > range.r0 || range.c1 > range.c0
    if (single && multiSel) {
      for (const { row, k } of rangeCells()) ch.push({ row, k, text: m[0][0] })
    } else {
      for (let i = 0; i < m.length; i++) for (let j = 0; j < m[i].length; j++) {
        const row = rows[range.r0 + i]
        const col = COLS[range.c0 + j]
        if (row && col) ch.push({ row, k: col.key, text: m[i][j] })
      }
      setAnchor({ r: range.r0, c: range.c0 })
      setSel(clamp({ r: range.r0 + m.length - 1, c: range.c0 + Math.max(...m.map((x) => x.length)) - 1 }))
    }
    applyCells(ch)
    toast(`Pasted ${ch.length} cell${ch.length === 1 ? '' : 's'}`, 'info')
  }

  const addRow = () => {
    if (!canEdit) return
    const id = 'n' + ++seq.current
    const cur = docRef.current
    setDoc({ edits: cur.edits, added: [id, ...cur.added] })
    setSort(null)
    requestAnimationFrame(() => {
      if (scrollRef.current) scrollRef.current.scrollTop = 0
      setSel({ r: 0, c: 1 }); setAnchor({ r: 0, c: 1 })
      scrollRef.current?.focus()
    })
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (editingRef.current) return
    const mod = e.ctrlKey || e.metaKey
    const k = e.key
    if (mod && !e.shiftKey && k.toLowerCase() === 'z') { e.preventDefault(); undo(); return }
    if (mod && (k.toLowerCase() === 'y' || (e.shiftKey && k.toLowerCase() === 'z'))) { e.preventDefault(); redo(); return }
    if (mod && k.toLowerCase() === 's') { e.preventDefault(); void saveRef.current(); return }
    if (mod && k.toLowerCase() === 'd') { e.preventDefault(); fillDown(); return }
    if (mod && k.toLowerCase() === 'a') { e.preventDefault(); setAnchor({ r: 0, c: 0 }); setSel({ r: rows.length - 1, c: COLS.length - 1 }); return }
    if (mod) return // let copy / paste events through
    const ext = e.shiftKey
    const page = Math.max(1, Math.floor(((scrollRef.current?.clientHeight ?? 400) - HEAD_H) / ROW_H) - 1)
    switch (k) {
      case 'ArrowDown': e.preventDefault(); moveTo({ r: sel.r + 1, c: sel.c }, ext); return
      case 'ArrowUp': e.preventDefault(); moveTo({ r: sel.r - 1, c: sel.c }, ext); return
      case 'ArrowLeft': e.preventDefault(); moveTo({ r: sel.r, c: sel.c - 1 }, ext); return
      case 'ArrowRight': e.preventDefault(); moveTo({ r: sel.r, c: sel.c + 1 }, ext); return
      case 'PageDown': e.preventDefault(); moveTo({ r: sel.r + page, c: sel.c }, ext); return
      case 'PageUp': e.preventDefault(); moveTo({ r: sel.r - page, c: sel.c }, ext); return
      case 'Home': e.preventDefault(); moveTo({ r: mod ? 0 : sel.r, c: 0 }, ext); return
      case 'End': e.preventDefault(); moveTo({ r: sel.r, c: COLS.length - 1 }, ext); return
      case 'Tab': e.preventDefault(); moveTo({ r: sel.r, c: sel.c + (e.shiftKey ? -1 : 1) }); return
      case 'Enter': case 'F2': e.preventDefault(); startEdit(); return
      case 'Escape': setAnchor(sel); return
      case 'Delete': case 'Backspace':
        e.preventDefault()
        applyCells(rangeCells().map(({ row, k: kk }) => ({ row, k: kk, text: '' })))
        return
    }
    if (k.length === 1 && !e.altKey && canEdit) { e.preventDefault(); startEdit(k) }
  }

  const onInputKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation()
    const mod = e.ctrlKey || e.metaKey
    if (e.key === 'Enter') { e.preventDefault(); commitEdit({ r: sel.r + 1, c: sel.c }) }
    else if (e.key === 'Tab') { e.preventDefault(); commitEdit({ r: sel.r, c: sel.c + (e.shiftKey ? -1 : 1) }) }
    else if (e.key === 'Escape') { e.preventDefault(); cancelEdit() }
    else if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); commitEdit(); setTimeout(() => void saveRef.current(), 0) }
  }

  // ------------------------------------------------------------------ save / discard
  const save = async () => {
    if (!canEdit || saving) return
    if (editingRef.current) { commitEdit(); await new Promise((r) => setTimeout(r, 0)) }
    const cur = docRef.current
    const ids = [...new Set([...cur.edits.keys(), ...cur.added])]
    if (!ids.length) return toast('No changes to save', 'info')
    if (counts.errors > 0) return toast(`Fix the ${counts.errors} highlighted error(s) first (hover a red cell to see why)`, 'bad')
    if (counts.warns > 0 && !confirm(`${counts.warns} warning(s) (price above MRP or unusual GST). Save anyway?`)) return
    const payload: { variantId?: number; key: string; patch: Record<string, unknown> }[] = []
    for (const id of ids) {
      const e = cur.edits.get(id) ?? {}
      const isNew = id.startsWith('n')
      const patch: Record<string, unknown> = {}
      for (const [k, t] of Object.entries(e) as [ColKey, string][]) {
        const col = COLS[colIndex(k)]
        const p = parseCell(k, t, lookups)
        if (col.field && p.ok) patch[col.field] = p.value
      }
      if (isNew && !patch.name) continue // untouched blank row
      payload.push({ variantId: isNew ? undefined : byId.get(id)?.g.variantId, key: id, patch })
    }
    if (!payload.length) return toast('No changes to save', 'info')
    setSaving(true)
    try {
      const r = await call<{ updated: number; created: number; unchanged: number }>('catalog', 'bulkUpdate', { rows: payload })
      hist.current = { past: [], future: [] }
      setServerErr(new Map())
      setDoc(EMPTY, false)
      toast(`Saved: ${r.updated} updated${r.created ? `, ${r.created} new` : ''}. Every screen now shows the new values.`, 'good')
      data.reload()
      reloadTaxonomy()
    } catch (e) {
      if (e instanceof ApiError && Array.isArray((e.details as { rowErrors?: unknown[] } | undefined)?.rowErrors)) {
        const m = new Map<string, string>()
        for (const x of (e.details as { rowErrors: { variantId?: number; key?: string; field?: string; message: string }[] }).rowErrors) {
          const id = x.key ?? (x.variantId ? 'v' + x.variantId : '')
          m.set(`${id}:${(x.field && FIELD_TO_COL[x.field]) || 'name'}`, x.message)
        }
        setServerErr(m)
        toast(`Nothing was saved. ${e.message}`, 'bad')
      } else toast(errMsg(e), 'bad')
    } finally {
      setSaving(false)
    }
  }
  const saveRef = useRef(save)
  saveRef.current = save

  const discard = () => {
    if (docRef.current.edits.size + docRef.current.added.length && !confirm('Discard all unsaved changes?')) return
    hist.current = { past: [], future: [] }
    setServerErr(new Map())
    setDoc(EMPTY, false)
    setEdit(null)
  }

  // ------------------------------------------------------------------ export
  const doExport = async () => {
    try {
      const r = await call<{ path?: string; cancelled?: boolean; bytesBase64?: string; filename: string; mime: string }>('catalog', 'exportFile', { format: 'xlsx' })
      if (r.cancelled) return
      if (r.bytesBase64) downloadBase64(r)
      toast(r.path ? `Exported to ${r.path}` : 'Export ready', 'good')
    } catch (e) { toast(errMsg(e), 'bad') }
  }

  // ------------------------------------------------------------------ misc effects
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setViewH(el.clientHeight))
    ro.observe(el)
    setViewH(el.clientHeight)
    return () => ro.disconnect()
  }, [data.data])
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => { if (docRef.current.edits.size) e.preventDefault() }
    window.addEventListener('beforeunload', h)
    return () => window.removeEventListener('beforeunload', h)
  }, [])
  useEffect(() => { setSel((s) => clamp(s)) /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [rows.length])

  // ------------------------------------------------------------------ render
  const first = Math.max(0, Math.floor((scrollTop - HEAD_H) / ROW_H) - OVERSCAN)
  const last = Math.min(rows.length - 1, Math.ceil((scrollTop + viewH) / ROW_H) + OVERSCAN)
  const visible: number[] = []
  for (let i = first; i <= last; i++) visible.push(i)

  const sortBy = (k: ColKey) => setSort((s) => (s?.key === k ? (s.dir === 1 ? { key: k, dir: -1 } : null) : { key: k, dir: 1 }))

  if (data.error) return <ErrorState message={data.error} onRetry={data.reload} />
  if (!data.data) return <Spinner />

  const dirty = counts.rows > 0
  return (
    <div className="xg-wrap" data-testid="product-grid">
      <style>{CSS}</style>
      <div className="xg-bar">
        <Input aria-label="Search grid" placeholder="Quick search name, SKU, barcode…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: 260 }} />
        <Select aria-label="Category filter" style={{ width: 'auto', maxWidth: 200 }} value={catFilter} onChange={(e) => setCatFilter(e.target.value)}>
          <option value="">All categories</option>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.path}</option>)}
        </Select>
        <Select aria-label="Active filter" style={{ width: 'auto' }} value={activeFilter} onChange={(e) => setActiveFilter(e.target.value)}>
          <option value="1">Active</option><option value="0">Inactive</option><option value="">All</option>
        </Select>
        <label><input type="checkbox" checked={changedOnly} onChange={(e) => setChangedOnly(e.target.checked)} /> Changed only</label>
        <span style={{ flex: 1 }} />
        {canEdit && <Button onClick={addRow}>+ Add row</Button>}
        {canEdit && <Button onClick={undo} disabled={!hist.current.past.length} title="Ctrl+Z">Undo</Button>}
        {canEdit && <Button onClick={redo} disabled={!hist.current.future.length} title="Ctrl+Y">Redo</Button>}
        {canEdit && <Button onClick={discard} disabled={!dirty}>Discard</Button>}
        {canEdit && <Button variant="primary" onClick={() => void save()} disabled={!dirty || saving} title="Ctrl+S">{saving ? 'Saving…' : `Save changes${dirty ? ` (${counts.rows})` : ''}`}</Button>}
        {can('catalog.import') && <Button onClick={() => setShowImport(true)}>Import</Button>}
        {can('catalog.import') && <Button onClick={() => void doExport()}>Export to Excel</Button>}
      </div>
      <div className="xg-status" aria-live="polite">
        <span>{rows.length.toLocaleString()} row{rows.length === 1 ? '' : 's'}</span>
        {!canEdit && <strong>View only (you do not have permission to edit)</strong>}
        {counts.cells > 0 && <span>{counts.cells} changed cell{counts.cells === 1 ? '' : 's'} in {counts.rows} row{counts.rows === 1 ? '' : 's'} (not saved yet)</span>}
        {counts.errors > 0 && <span style={{ color: 'var(--bad)' }}>{counts.errors} error(s)</span>}
        {counts.warns > 0 && <span style={{ color: 'var(--warn)' }}>{counts.warns} warning(s)</span>}
        <span>Enter / F2 edit · Tab next · Ctrl+D fill down · Ctrl+C/V Excel copy-paste · Ctrl+Z/Y undo · Ctrl+S save</span>
      </div>

      <div
        ref={scrollRef} className="xg-scroll" tabIndex={0} role="grid" aria-label="Product spreadsheet" aria-rowcount={rows.length}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)} onKeyDown={onKeyDown} onCopy={onCopy} onPaste={onPaste}
        onCut={(e) => { if (editingRef.current) return; onCopy(e); applyCells(rangeCells().map(({ row, k }) => ({ row, k, text: '' }))) }}
      >
        <div style={{ width: TOTAL_W }}>
          <div className="xg-head">
            <div className="xg-hrow" role="row">
              {COLS.map((c, i) => (
                <div key={c.key} role="columnheader" className="xg-h" onClick={() => sortBy(c.key)} aria-sort={sort?.key === c.key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}
                  style={{ width: c.width, justifyContent: c.num ? 'flex-end' : 'flex-start', ...(c.frozen ? { position: 'sticky', left: frozenLeft[i], zIndex: 6 } : {}) }}>
                  {c.header}{sort?.key === c.key ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}
                </div>
              ))}
            </div>
            <div className="xg-frow">
              {COLS.map((c, i) => (
                <div key={c.key} className="xg-f" style={{ width: c.width, ...(c.frozen ? { position: 'sticky', left: frozenLeft[i], zIndex: 6 } : {}) }}>
                  <input aria-label={`Filter ${c.header}`} placeholder="filter" value={colFilter[c.key] ?? ''} onChange={(e) => setColFilter((f) => ({ ...f, [c.key]: e.target.value }))} />
                </div>
              ))}
            </div>
          </div>
          <div className="xg-body" style={{ height: rows.length * ROW_H }}>
            {visible.map((ri) => {
              const row = rows[ri]
              if (!row) return null
              const e = doc.edits.get(row.id)
              return (
                <div key={row.id} className="xg-row" role="row" aria-rowindex={ri + 1} style={{ top: ri * ROW_H, width: TOTAL_W }} data-row={row.id}>
                  {COLS.map((c, ci) => {
                    const isActive = sel.r === ri && sel.c === ci
                    const inRange = ri >= range.r0 && ri <= range.r1 && ci >= range.c0 && ci <= range.c1
                    const isDirty = e?.[c.key] !== undefined
                    const issue = isDirty || row.isNew || serverErr.size ? issueFor(row, c.key) : null
                    const ro = c.field === undefined
                    const cls = ['xg-c', c.num ? 'num' : '', ro ? 'ro' : '', c.frozen ? 'fz' : '', isDirty ? 'dirty' : row.isNew ? 'newrow' : '', inRange && !isActive ? 'sel' : '', isActive ? 'active' : '', issue ? issue.level === 'error' ? 'err' : 'warn' : ''].filter(Boolean).join(' ')
                    const txt = textOf(row, c.key)
                    return (
                      <div
                        key={c.key} className={cls} role="gridcell" aria-selected={inRange} data-row={row.id} data-col={c.key}
                        title={issue?.msg ?? txt}
                        style={{ width: c.width, ...(c.frozen ? { left: frozenLeft[ci] } : {}) }}
                        onMouseDown={(ev) => {
                          if (ev.button !== 0) return
                          if (editingRef.current) commitEdit()
                          const p = { r: ri, c: ci }
                          setSel(p)
                          if (!ev.shiftKey) setAnchor(p)
                        }}
                        onMouseEnter={(ev) => { if (ev.buttons === 1 && !editingRef.current) setSel({ r: ri, c: ci }) }}
                        onDoubleClick={() => { setSel({ r: ri, c: ci }); setAnchor({ r: ri, c: ci }); setTimeout(() => startEdit(), 0) }}
                      >
                        {isActive && editing ? (
                          <input
                            className="xg-in" autoFocus aria-label={`Edit ${c.header}`} value={editing.text} inputMode={c.num ? 'decimal' : 'text'}
                            onChange={(ev) => setEdit({ text: ev.target.value })} onKeyDown={onInputKey} onBlur={() => commitEdit()}
                            onFocus={(ev) => { const n = ev.currentTarget; if (editingRef.current?.select) n.select(); else n.setSelectionRange(n.value.length, n.value.length) }}
                          />
                        ) : txt}
                      </div>
                    )
                  })}
                </div>
              )
            })}
          </div>
        </div>
      </div>
      <ImportWizard open={showImport} onClose={() => setShowImport(false)} onDone={() => { data.reload(); reloadTaxonomy() }} />
    </div>
  )
}

function numVal(g: GridRow, k: ColKey): number {
  switch (k) {
    case 'mrp': return g.mrp
    case 'price': return g.price
    case 'cost': return g.cost
    case 'gst': return g.taxRateBp
    case 'reorder': return g.reorderLevel
    case 'stock': return g.stock
    default: return 0
  }
}

function descendantIds(cats: Category[], root: number): Set<number> {
  const out = new Set<number>([root])
  let grew = true
  while (grew) {
    grew = false
    for (const c of cats) if (c.parentId && out.has(c.parentId) && !out.has(c.id)) (out.add(c.id), (grew = true))
  }
  return out
}

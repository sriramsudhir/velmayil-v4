import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Badge, Button, Field, Input, Modal, Table, useToast } from '@/ui'
import { call, errMsg, ApiError } from '@/lib/api'
import { useSession } from '@/lib/session'
import { beepError, beepOk } from '@/ui/sound'
import { formatINR } from '@shared/money'
import { calcBill, effectiveDiscountBp, type Discount } from '@shared/billing'
import { DiscountField, MoneyField, PrintActions, QtyField } from './parts'
import { PaymentDialog } from './PaymentDialog'
import { prefs } from './printAdapter'
import { useScanner, useScannerConfig, useSerialStatus } from '@/lib/useScanner'
import { loadScannerConfig, visibleCode, type ScanResult } from '@/lib/scanner'
import { serialScanner, serialSupported } from '@/lib/serialScanner'
import { hidScanner, hidSupported } from '@/lib/hidScanner'
import { BoxRecorder, noteBoxSubmit, scanBoxKey } from '@/lib/scanInput'
import { createScanList, duplicateMessage, type ScanList } from '@shared/scanList'
import { addCodes, addUnit, allUnitCodes, classifyScan, keepUnits, MAX_UNIT_QTY, clearDraft, MAX_LINE_QTY, isLocalDuplicate, legacyScanAllowed, lineWithCode, listFromLines, loadDraft, normalizeResumed, notAvailableMessage, removeLine, removeUnit, saleLinePayload, saveDraft, TRACKED_HINT, unitInfoOf, type ScanResponse } from './unitCart'
import type { Approval, CartCustomer, CartLine, PayMethod, PosSettings, SaleResult, SavedCart, Variant } from './types'
import './pos.css'

const newId = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`)
const DEFAULT_SETTINGS: PosSettings = { maxDiscountBp: 0, canDiscountUnlimited: false, pricesIncludeTax: true, roundOff: true, requireShift: false, allowNegative: false }

interface ShiftRow { id: number; openedAt: number; openingCash: number }
interface ShiftSummary { shift: ShiftRow; openingCash: number; cashSales: number; cashRefunds: number; expectedCash: number; salesCount: number; salesTotal: number; returnsTotal: number; byMethod: { method: string; amount: number }[]; closingCash: number | null; variance: number | null }

export function PosScreen() {
  const toast = useToast()
  const { can, session } = useSession()
  const userId = session?.userId ?? 0
  // A bill that was in progress when the cashier opened another screen (sales history, stock...) comes back with this screen.
  const [resumed] = useState<SavedCart | null>(() => { const d = loadDraft(userId); return d ? { ...d, lines: normalizeResumed(d.lines) } : null })
  const [settings, setSettings] = useState<PosSettings>(DEFAULT_SETTINGS)
  const [lines, setLines] = useState<CartLine[]>(resumed?.lines ?? [])
  const linesRef = useRef<CartLine[]>(resumed?.lines ?? []) // always the latest bill, updated synchronously (scans can arrive faster than a render)
  const unitList = useRef<ScanList>(resumed ? listFromLines(resumed.lines) : createScanList()) // the active list: unit codes already on THIS bill
  const [unitWarn, setUnitWarn] = useState<{ msg: string; at: number; kind: 'duplicate' | 'unavailable' | 'tracked' } | null>(null)
  const [flashKey, setFlashKey] = useState<string | null>(null)
  const [soldUnits, setSoldUnits] = useState<string[]>([])
  const [billDiscount, setBillDiscount] = useState<Discount>(resumed?.billDiscount ?? null)
  const [customer, setCustomer] = useState<CartCustomer | null>(resumed?.customer ?? null)
  const [note, setNote] = useState(resumed?.note ?? '')
  const [shift, setShift] = useState<ShiftRow | null | undefined>(undefined)
  const [shiftDlg, setShiftDlg] = useState<'open' | 'close' | null>(null)
  const [payOpen, setPayOpen] = useState(false)
  const [done, setDone] = useState<SaleResult | null>(null)
  const [heldOpen, setHeldOpen] = useState(false)
  const [clearAsk, setClearAsk] = useState(false)

  // scan / search
  const [text, setText] = useState('')
  const [results, setResults] = useState<Variant[]>([])
  const [hi, setHi] = useState(-1)
  const scanRef = useRef<HTMLInputElement>(null)
  const rec = useRef(new BoxRecorder())
  const navigated = useRef(false) // the cashier moved the highlight in the suggestion list with the arrow keys
  const idleSubmit = useRef<ReturnType<typeof setTimeout> | null>(null) // readers that send no Enter/Tab: a pause after a machine-fast burst ends the code
  const submitRef = useRef<() => void>(() => {})
  const [lastScan, setLastScan] = useState<{ at: number; code: string; avgGapMs: number | null; source: string; ok: boolean } | null>(null)
  const [notFound, setNotFound] = useState<{ code: string; at: number } | null>(null)
  const seq = useRef(0)
  const requestId = useRef(newId())

  const anyDialog = payOpen || !!done || heldOpen || clearAsk || !!shiftDlg
  const focusScan = useCallback(() => { setTimeout(() => scanRef.current?.focus(), 0) }, [])

  useEffect(() => { call<PosSettings>('pos', 'settings').then(setSettings).catch(() => {}) }, [payOpen]) // re-read when the payment screen opens (UPI id may have changed)
  const loadShift = useCallback(async () => {
    try { setShift(await call<ShiftRow | null>('pos', 'getCurrentShift')) } catch { setShift(null) }
  }, [])
  useEffect(() => { void loadShift() }, [loadShift])
  // A shift is only forced (modal) when the shop requires one. Otherwise the header badge + "Open shift" button are the
  // non-blocking prompt, so the dialog never steals focus mid-scan.
  // It never opens over a bill in progress either: with items on the bill the shift is asked for at payment (openPay).
  const prompted = useRef(false)
  useEffect(() => {
    if (shift === null && settings.requireShift && !prompted.current && can('pos.shift') && linesRef.current.length === 0) { prompted.current = true; setShiftDlg('open') }
  }, [shift, settings.requireShift, can])

  useEffect(() => { if (resumed?.lines.length) toast('Your bill in progress is back on screen', 'info') }, []) // eslint-disable-line react-hooks/exhaustive-deps
  // keep the bill in progress for when the cashier comes back from another screen; a completed sale is never brought back
  useEffect(() => {
    if (done) clearDraft()
    else saveDraft(userId, { lines, billDiscount, customer, note })
  }, [userId, lines, billDiscount, customer, note, done])

  // any cart change invalidates the idempotency key (a different bill must not replay an old sale)
  useEffect(() => { requestId.current = newId() }, [lines, billDiscount, customer, note])

  // ---- live totals (same math as the server's authoritative recalculation)
  const bill = useMemo(
    () => lines.length
      ? calcBill(
          lines.map((l) => ({ qty: l.qty, unitPrice: l.overridePrice ?? l.price, discount: l.discount, taxRateBp: l.taxRateBp })),
          { pricesIncludeTax: settings.pricesIncludeTax, billDiscount, roundToRupee: settings.roundOff }
        )
      : null,
    [lines, billDiscount, settings]
  )
  const discBp = bill ? effectiveDiscountBp(bill) : 0
  const needsApproval = !!bill && discBp > settings.maxDiscountBp && !settings.canDiscountUnlimited
  const stockWarnings = lines.filter((l) => l.trackStock && l.qty > l.stock)

  // ---- cart ops
  const setLinesSync = useCallback((u: CartLine[] | ((c: CartLine[]) => CartLine[])) => {
    const next = typeof u === 'function' ? u(linesRef.current) : u
    linesRef.current = next
    setLines(next)
  }, [])
  const addVariant = useCallback((v: Variant, qty = 1, quiet = false) => {
    if (!quiet) beepOk()
    setLinesSync((cur) => {
      const i = cur.findIndex((l) => !l.tracked && l.variantId === v.variantId && l.overridePrice == null && !l.discount)
      if (i >= 0) return cur.map((l, j) => (j === i ? { ...l, qty: Math.min(MAX_LINE_QTY, l.qty + qty), stock: v.stock } : l))
      return [...cur, { key: newId(), variantId: v.variantId, name: v.displayName, sku: v.sku, qty, price: v.price, overridePrice: null, discount: null, taxRateBp: v.taxRateBp, trackStock: v.trackStock, stock: v.stock }]
    })
  }, [setLinesSync])
  const patch = (key: string, p: Partial<CartLine>) => setLinesSync((cur) => cur.map((l) => (l.key === key ? { ...l, ...p } : l)))
  const remove = (key: string) => { setLinesSync((cur) => removeLine(cur, unitList.current, key)); focusScan() }
  const removeCode = (key: string, code: string) => { setLinesSync((cur) => removeUnit(cur, unitList.current, key, code)); focusScan() }

  /**
   * "+", "-" and a typed quantity on a line with unit codes. More: the server names the next pieces in stock that are not on the
   * bill yet; fewer: the codes added last are released. One change at a time, so two quick clicks never ask for the same piece.
   */
  const unitQtyQueue = useRef<Promise<void>>(Promise.resolve())
  const changeUnitQty = (key: string, to: (have: number) => number) => {
    unitQtyQueue.current = unitQtyQueue.current.then(async () => {
      const line = linesRef.current.find((l) => l.key === key)
      if (!line?.tracked) return
      const have = line.unitCodes?.length ?? 0
      const want = Math.max(1, Math.min(MAX_UNIT_QTY, to(have)))
      if (want < have) { setLinesSync((cur) => keepUnits(cur, unitList.current, key, want)); return }
      if (want === have) return
      try {
        const r = await call<{ codes: string[]; left: number }>('units', 'nextAvailable', { variantId: line.variantId, exclude: allUnitCodes(linesRef.current), count: want - have })
        if (r.codes.length) setLinesSync((cur) => addCodes(cur, unitList.current, key, r.codes))
        if (r.codes.length < want - have) {
          const now = have + r.codes.length
          toast(`${line.name}: only ${now} piece${now === 1 ? ' is' : 's are'} in stock, so the quantity is ${now}. Add stock (Products > Print label, or a purchase) to sell more.`, 'bad')
        }
      } catch (e) {
        toast(errMsg(e), 'bad')
      }
    })
  }

  /** Red warning for a unit scan that was NOT added (duplicate / sold / tracked product scanned without a unit code). */
  const warnUnit = useCallback((kind: 'duplicate' | 'unavailable' | 'tracked', msg: string, lineKey?: string | null) => {
    if (loadScannerConfig().sound) beepError()
    setUnitWarn({ msg, at: Date.now(), kind })
    toast(msg, 'bad')
    if (lineKey) {
      setFlashKey(lineKey)
      setTimeout(() => setFlashKey((k) => (k === lineKey ? null : k)), 1800)
      setTimeout(() => document.querySelector(`[data-linekey="${lineKey}"]`)?.scrollIntoView({ block: 'nearest' }), 0)
    }
  }, [toast])

  /** The bill is the active list: a unit code already on it is never added twice. Returns true when something was added. */
  const applyScan = useCallback((v: ScanResponse, code: string, qty: number, beep: boolean): boolean => {
    const kind = classifyScan(v)
    if (kind === 'unit') {
      const out = addUnit(linesRef.current, unitList.current, v, unitInfoOf(v)!.code, newId)
      if (out.result === 'duplicate') { warnUnit('duplicate', duplicateMessage(unitInfoOf(v)!.code, 'this bill'), out.lineKey); return false }
      setLinesSync(out.lines)
      setUnitWarn(null)
      if (beep) beepOk()
      return true
    }
    // an old label with the shared product barcode: allowed only while pieces without a label of their own are left in stock
    if (kind === 'tracked-product' && !legacyScanAllowed(linesRef.current, v, qty)) { warnUnit('tracked', `${v.displayName}: ${TRACKED_HINT}`); return false }
    addVariant(v as Variant, qty, !beep)
    return true
  }, [addVariant, setLinesSync, warnUnit])

  /** Server said the unit exists but is sold / void. */
  const unitConflict = useCallback((e: unknown, code: string): boolean => {
    if (!(e instanceof ApiError) || e.code !== 'CONFLICT') return false
    const d = e.details as { code?: string; status?: string; unitCode?: string } | undefined
    if (d?.code !== 'UNIT_NOT_AVAILABLE') return false
    warnUnit('unavailable', notAvailableMessage(d.unitCode ?? code, d.status))
    return true
  }, [warnUnit])

  const resetUnits = () => { unitList.current = createScanList(); setUnitWarn(null); setFlashKey(null) }
  const newBill = useCallback(() => {
    setLinesSync([]); resetUnits(); setSoldUnits([]); setBillDiscount(null); setCustomer(null); setNote(''); setDone(null); setPayOpen(false)
    setText(''); setResults([]); setNotFound(null); requestId.current = newId(); focusScan()
  }, [focusScan])

  // ---- scan / search
  useEffect(() => {
    const q = text.trim().replace(/^\d{1,4}\*(?=.)/, '').replace(/^\*+|\*+$/g, '').trim() // "5*code" => code, Code 39 "*CODE*" => CODE
    if (q.length < 2) { setResults([]); setHi(-1); return }
    const my = ++seq.current
    const t = setTimeout(() => {
      call<Variant[]>('pos', 'search', { text: q }).then((r) => { if (my === seq.current) { setResults(r); setHi(r.length ? 0 : -1); navigated.current = false } }).catch(() => {})
    }, 150)
    return () => clearTimeout(t)
  }, [text])

  const lineWithCodeKey = useCallback((code: string) => lineWithCode(linesRef.current, code)?.key ?? null, [])
  const noteScan = useCallback((code: string, source: string, avgGapMs: number | null, ok: boolean) => {
    setLastScan({ at: Date.now(), code, avgGapMs, source, ok })
    setNotFound(ok ? null : { code, at: Date.now() })
  }, [])

  /** Resolve a scanned code and add it. Returns true when a product was added. */
  const addScanned = useCallback(async (code: string, qty: number, source: string, avgGapMs: number | null, quiet: boolean): Promise<boolean> => {
    if (isLocalDuplicate(unitList.current, code)) {
      noteScan(code, source, avgGapMs, true)
      warnUnit('duplicate', duplicateMessage(code, 'this bill'), lineWithCodeKey(code))
      return false
    }
    try {
      const v = await call<ScanResponse>('pos', 'scan', { code })
      const added = applyScan(v, code, qty, loadScannerConfig().sound && !quiet)
      noteScan(code, source, avgGapMs, true)
      return added
    } catch (e) {
      if (unitConflict(e, code)) { noteScan(code, source, avgGapMs, true); return false }
      if (e instanceof ApiError && e.code === 'NOT_FOUND') {
        if (loadScannerConfig().sound) beepError()
        noteScan(code, source, avgGapMs, false)
        toast(`Barcode not found: ${visibleCode(code)}`, 'bad')
      } else {
        if (loadScannerConfig().sound) beepError()
        toast(errMsg(e), 'bad')
      }
      return false
    }
  }, [applyScan, noteScan, toast, unitConflict, warnUnit, lineWithCodeKey])

  /** Enter / Tab in the scan box. The box works with ANY reader speed: everything typed (or scanned) lands here, then Enter. */
  const submitScan = async () => {
    const field = scanRef.current
    const typed = (field?.value ?? text).trim() // read the DOM, not state: a 1 ms/key reader may outrun a React render
    const cfg = loadScannerConfig()
    const rec1 = rec.current.take(typed, cfg)
    let raw = rec1.code
    // the reader's configured literal prefix (e.g. "~") is not part of the code
    if (cfg.prefix && cfg.prefix !== 'Enter' && cfg.prefix !== 'Tab' && raw.startsWith(cfg.prefix) && raw.length > cfg.prefix.length) raw = raw.slice(cfg.prefix.length)
    if (idleSubmit.current) { clearTimeout(idleSubmit.current); idleSubmit.current = null }
    noteBoxSubmit()
    if (!raw) { if (lines.length && cfg.prefix !== 'Enter') openPay(); return } // Enter on an empty box = pay (unless the reader's prefix IS Enter)
    const fast = !!rec1.timing && rec1.timing.avgGapMs <= Math.max(60, cfg.maxGapMs)
    if (cfg.scanToSearch && fast && !rec1.repaired) { setText(raw); return } // scan-to-search mode: show matches, the cashier picks
    if (navigated.current && hi >= 0 && results[hi]) { pick(results[hi]); return } // cashier chose from the list with the arrow keys
    let qty = 1, code = raw
    const m = raw.match(/^(\d{1,4})\*(.+)$/) // "5*8901234" => qty 5
    if (m) { qty = Math.max(1, Number(m[1])); code = m[2] } // "0*code" is one item, never a line with quantity 0
    seq.current++
    const resultsNow = results
    const hiNow = hi
    // Empty the box NOW (not after the lookup): a CR+LF reader's 2nd Enter, or the next scan, arrives a few ms later and must not
    // find the old code still sitting in the box (that would add the item twice).
    setText(''); setResults([]); setHi(-1)
    if (isLocalDuplicate(unitList.current, code)) {
      noteScan(code, 'box', rec1.timing?.avgGapMs ?? null, true)
      warnUnit('duplicate', duplicateMessage(code, 'this bill'), lineWithCodeKey(code))
      return
    }
    try {
      const v = await call<ScanResponse>('pos', 'scan', { code })
      applyScan(v, code, qty, true)
      noteScan(code, 'box', rec1.timing?.avgGapMs ?? null, true)
    } catch (e) {
      if (unitConflict(e, code)) { noteScan(code, 'box', rec1.timing?.avgGapMs ?? null, true); return }
      if (e instanceof ApiError && e.code === 'NOT_FOUND') {
        if (resultsNow.length && !fast && !/^\d{6,}$/.test(code)) { pick(resultsNow[Math.max(hiNow, 0)]); return } // typed a name: take the highlighted match
        beepError()
        noteScan(code, 'box', rec1.timing?.avgGapMs ?? null, false)
        toast(`Barcode not found: ${visibleCode(code)}`, 'bad')
      } else {
        beepError()
        toast(errMsg(e), 'bad')
      }
      if (!fast) { setText((cur) => cur || typed); setTimeout(() => scanRef.current?.select(), 0) } // typed by hand: give the text back to correct it (a reader's code is in the red message instead)
    }
  }
  submitRef.current = () => { void submitScan() }
  const pick = (v: Variant) => { if (v.trackUnits && !legacyScanAllowed(linesRef.current, v, 1)) warnUnit('tracked', `${v.displayName}: ${TRACKED_HINT}`); else addVariant(v); setText(''); setResults([]); setHi(-1); setNotFound(null); focusScan() }

  // ---- barcode scanners (keyboard-wedge when focus is NOT in the scan box, serial / HID readers) go straight to the cart
  const scannerCfg = useScannerConfig()
  const serial = useSerialStatus()
  const onScanned = useCallback(async (code: string, scan?: ScanResult) => {
    if (!can('pos.sell')) return
    const gap = scan && scan.avgGapMs > 0 ? scan.avgGapMs : null
    if (loadScannerConfig().scanToSearch) { setText(code); noteScan(code, scan?.source ?? 'wedge', gap, true); focusScan(); return } // scan-to-search mode: show matches, cashier picks
    if (await addScanned(code, 1, scan?.source ?? 'wedge', gap, false)) { setText(''); setResults([]) }
  }, [can, addScanned, noteScan, focusScan])
  const doneRef = useRef(done)
  doneRef.current = done
  const onBlocked = useCallback((scan: ScanResult) => {
    if (doneRef.current) { newBill(); void onScanned(scan.code, scan) } // the previous sale is finished: a scan starts the next bill
    else toast('Close the open window, then scan again', 'info')
  }, [newBill, onScanned, toast])
  useScanner(onScanned, !anyDialog, onBlocked)
  useEffect(() => {
    if (scannerCfg.serialAutoConnect && serialSupported()) void serialScanner.connect(scannerCfg.serialBaud, true)
  }, [scannerCfg.serialAutoConnect, scannerCfg.serialBaud])
  useEffect(() => {
    if (scannerCfg.hidAutoConnect && hidSupported()) void hidScanner.autoConnect()
  }, [scannerCfg.hidAutoConnect])

  // ---- hold / resume
  const hold = useCallback(async () => {
    if (!lines.length) return toast('Nothing to hold', 'info')
    if (!can('pos.hold')) return toast('You are not allowed to hold bills', 'bad')
    try {
      const cart: SavedCart = { lines, billDiscount, customer, note }
      await call('pos', 'holdCart', { label: customer?.name || customer?.phone || '', cart })
      toast('Bill held', 'good')
      newBill()
    } catch (e) { toast(errMsg(e), 'bad') }
  }, [lines, billDiscount, customer, note, can, toast, newBill])

  const openPay = useCallback(() => {
    if (!lines.length) return toast('Add items first', 'info')
    if (!can('pos.sell')) return toast('You are not allowed to sell', 'bad')
    if (settings.requireShift && !shift) { setShiftDlg('open'); return }
    setPayOpen(true)
  }, [lines.length, can, settings.requireShift, shift, toast])

  // ---- keyboard shortcuts
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (anyDialog) {
        // "New bill (F9)" on the Sale completed window
        if (done && !payOpen && !heldOpen && !clearAsk && !shiftDlg && e.key === 'F9') { e.preventDefault(); newBill() }
        return
      }
      if (e.key === 'F2') { e.preventDefault(); scanRef.current?.focus(); scanRef.current?.select() }
      else if (e.key === 'F4') { e.preventDefault(); void hold() }
      else if (e.key === 'F8') { e.preventDefault(); openPay() }
      else if (e.key === 'F9') { e.preventDefault(); if (lines.length) setClearAsk(true); else newBill() }
      else if (e.key === 'Escape') {
        if (notFound) setNotFound(null)
        if (unitWarn) setUnitWarn(null)
        if (results.length || text) { setText(''); setResults([]); rec.current.reset() }
        else if (lines.length) setClearAsk(true)
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [anyDialog, done, payOpen, heldOpen, clearAsk, shiftDlg, hold, openPay, lines.length, newBill, results.length, text, notFound, unitWarn])

  // keep the scan box focused when clicking empty areas
  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (anyDialog) return
      const t = e.target as HTMLElement
      if (!t.closest('input,button,select,textarea,a,label,table')) scanRef.current?.focus()
    }
    document.addEventListener('click', h)
    return () => document.removeEventListener('click', h)
  }, [anyDialog])
  useEffect(() => { if (!anyDialog) focusScan() }, [anyDialog, focusScan])

  // ---- checkout
  const submitSale = async (payments: { method: PayMethod; amount: number; reference?: string }[], approval?: Approval) => {
    const cust = customer && (customer.id || customer.name || customer.phone)
      ? customer.id ? { customerId: customer.id } : { customer: { name: customer.name || customer.phone, phone: customer.phone } }
      : {}
    const res = await call<SaleResult>('pos', 'completeSale', {
      requestId: requestId.current,
      lines: lines.map(saleLinePayload),
      billDiscount, ...cust, payments, note, approval
    })
    setSoldUnits(lines.flatMap((l) => (l.tracked ? (l.unitCodes ?? []).map((c) => c) : [])))
    setPayOpen(false)
    setDone(res)
  }

  const canDiscount = can('pos.discount')
  const canOverride = can('pos.price_override')

  return (
    <div className="pos">
      <div className="pos-top">
        <div className="pos-scan">
          <input
            ref={scanRef} className="input" autoFocus autoComplete="off" spellCheck={false} data-scanbox="true"
            placeholder="Scan barcode or type product name / SKU, then Enter   (5*code = quantity)"
            value={text}
            onChange={(e) => {
              setText(e.target.value)
              if (!e.target.value) rec.current.reset()
              // reader without Enter/Tab: a pause after a machine-fast burst ends the code
              const c = loadScannerConfig()
              if (idleSubmit.current) clearTimeout(idleSubmit.current)
              idleSubmit.current = null
              if (c.suffix === 'none' && e.target.value.trim().length >= c.minLength) {
                idleSubmit.current = setTimeout(() => { idleSubmit.current = null; if (rec.current.looksFast(Math.max(c.maxGapMs, 40))) submitRef.current() }, c.idleMs + 10)
              }
            }}
            onKeyDown={(e) => {
              rec.current.key(e.nativeEvent)
              const cfgNow = loadScannerConfig()
              const val = scanRef.current?.value ?? text
              const act = scanBoxKey(e.nativeEvent, val, performance.now(), rec.current.looksFast())
              if (act === 'ignore') { e.preventDefault(); return } // 2nd half of a CR+LF terminator: not a person
              if (cfgNow.prefix === 'Enter' && e.key === 'Enter' && !val.trim()) { e.preventDefault(); return } // the reader's prefix key, not "pay"
              if (cfgNow.prefix === 'Tab' && e.key === 'Tab' && !val.trim()) { e.preventDefault(); return } // keep focus here for the code that follows
              if (act === 'submit') { e.preventDefault(); void submitScan(); return }
              if (e.key === 'ArrowDown') { e.preventDefault(); navigated.current = true; setHi((i) => Math.min(results.length - 1, i + 1)) }
              else if (e.key === 'ArrowUp') { e.preventDefault(); navigated.current = true; setHi((i) => Math.max(0, i - 1)) }
            }}
            aria-label="Scan or search products"
          />
          {results.length > 0 && (
            <div className="pos-suggest" role="listbox">
              {results.map((r, i) => (
                <button key={r.variantId} className={i === hi ? 'active' : ''} onMouseDown={(e) => { e.preventDefault(); pick(r) }} role="option" aria-selected={i === hi}>
                  <span><strong>{r.displayName}</strong> <span className="muted">{r.sku}{r.barcode ? ` · ${r.barcode}` : ''}</span></span>
                  <span>{formatINR(r.price)} <span className={r.trackStock && r.stock <= 0 ? 'pos-bad' : 'muted'}>· stock {r.trackStock ? r.stock : '∞'}</span></span>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="row">
          <span className={`pos-scan-ind ${lastScan ? (lastScan.ok ? 'ok' : 'bad') : ''}`} data-testid="scanner-indicator" role="status"
            title="Shows the last code the barcode reader delivered and how fast its keys arrived. Fast (a few ms per key) = a reader; slow = typed by hand.">
            {lastScan
              ? `Scanner: last scan ${new Date(lastScan.at).toLocaleTimeString([], { hour12: false })} (${lastScan.code.length > 10 ? `${lastScan.code.slice(0, 10)}…` : lastScan.code}, ${lastScan.avgGapMs != null ? `${lastScan.avgGapMs} ms/key` : lastScan.source})`
              : 'Scanner: ready, no scan yet'}
          </span>
          {shift === undefined ? null : shift ? (
            <>
              <Badge tone="good">Shift open · {new Date(shift.openedAt).toLocaleTimeString()}</Badge>
              {can('pos.shift') && <Button onClick={() => setShiftDlg('close')}>Close shift</Button>}
            </>
          ) : (
            <>
              <Badge tone="warn">No shift open</Badge>
              {can('pos.shift') && <Button onClick={() => setShiftDlg('open')}>Open shift</Button>}
            </>
          )}
          {serialSupported() && (
            serial.state === 'connected'
              ? <Button onClick={() => void serialScanner.disconnect()} title={`Serial scanner connected at ${serial.baud} baud. Click to disconnect.`}>Serial scanner: on</Button>
              : <Button onClick={() => void serialScanner.connect(scannerCfg.serialBaud)} disabled={serial.state === 'connecting'} title={serial.message ?? `Connect a COM-port barcode scanner (${scannerCfg.serialBaud} baud, change in Settings > Scanner)`}>Connect serial scanner</Button>
          )}
          <Button onClick={() => setHeldOpen(true)} disabled={!can('pos.hold')}>Held bills</Button>
          <Link to="/pos/history"><Button>Sales history</Button></Link>
        </div>
        {unitWarn && (
          <div className="pos-notfound pos-unitwarn" role="alert" data-testid="unit-warning" data-kind={unitWarn.kind} style={{ flex: '1 1 100%' }}>
            <span data-testid="unit-warning-text">{unitWarn.msg}</span>
            <Button size="sm" onClick={() => { setUnitWarn(null); focusScan() }}>Dismiss</Button>
          </div>
        )}
        {notFound && (
          <div className="pos-notfound" role="alert" data-testid="scan-notfound" style={{ flex: '1 1 100%' }}>
            <span>
              Not found in catalog: <code data-testid="scan-notfound-code">{visibleCode(notFound.code)}</code> ({notFound.code.length} character{notFound.code.length === 1 ? '' : 's'})
              <div className="muted">Compare with the number printed under the barcode: if the reader added or dropped characters (check digit, leading zero, ]E0 prefix, * stars), run Settings &gt; Scanner &gt; Detect my reader, or add this code as an alias barcode on the product.</div>
            </span>
            <Button size="sm" onClick={() => { setNotFound(null); focusScan() }}>Dismiss</Button>
          </div>
        )}
      </div>

      <div className="pos-main">
        <div className="pos-cart">
          {lines.length === 0 ? (
            <div className="empty"><strong>Scan an item to start a bill</strong><p className="muted">Barcode scanners work automatically. Press F2 to search by name.</p></div>
          ) : (
            <table>
              <thead><tr><th>#</th><th>Item</th><th className="r">Price</th><th>Qty</th><th>Discount</th><th className="r">Total</th><th /></tr></thead>
              <tbody>
                {lines.map((l, i) => {
                  const bl = bill!.lines[i]
                  const over = l.trackStock && l.qty > l.stock
                  return (
                    <tr key={l.key} data-linekey={l.key} className={l.key === flashKey ? 'pos-flash' : undefined}>
                      <td>{i + 1}</td>
                      <td>
                        <strong>{l.name}</strong> <span className="muted">{l.sku}</span>
                        {l.tracked && (
                          <div className="pos-units" data-testid="unit-codes">
                            {(l.unitCodes ?? []).map((c) => (
                              <span key={c} className="pos-unitchip" data-unit={c}>{c}<button type="button" aria-label={`Remove ${c}`} onClick={() => removeCode(l.key, c)}>✕</button></span>
                            ))}
                          </div>
                        )}
                        {over && <div className="pos-warn">Only {l.stock} in stock{settings.allowNegative ? ' (negative stock allowed)' : ''}</div>}
                        {l.overridePrice != null && <div className="pos-warn">Price overridden (was {formatINR(l.price)})</div>}
                      </td>
                      <td className="r">
                        {canOverride
                          ? <MoneyField value={l.overridePrice ?? l.price} title="Override price" onCommit={(p) => patch(l.key, { overridePrice: p === l.price ? null : p })} />
                          : formatINR(l.price)}
                      </td>
                      <td>
                        <span className="pos-qty">
                          <Button aria-label="Decrease quantity" disabled={l.qty <= 1} title={l.tracked ? 'Takes off the label number added last' : undefined} onClick={() => (l.tracked ? changeUnitQty(l.key, (n) => n - 1) : patch(l.key, { qty: Math.max(1, l.qty - 1) }))}>−</Button>
                          <QtyField value={l.qty} commitOnBlur={l.tracked} onCommit={(q) => (l.tracked ? changeUnitQty(l.key, () => q) : patch(l.key, { qty: q }))} onDone={focusScan} />
                          <Button aria-label="Increase quantity" disabled={l.qty >= MAX_LINE_QTY} title={l.tracked ? 'Adds the next piece in stock (or scan its label)' : undefined} onClick={() => (l.tracked ? changeUnitQty(l.key, (n) => n + 1) : patch(l.key, { qty: Math.min(MAX_LINE_QTY, l.qty + 1) }))}>+</Button>
                        </span>
                      </td>
                      <td><DiscountField value={l.discount} disabled={!canDiscount} onChange={(d) => patch(l.key, { discount: d })} /></td>
                      <td className="r"><strong>{formatINR(bl.lineTotal)}</strong></td>
                      <td><Button variant="ghost" aria-label="Remove line" onClick={() => remove(l.key)}>✕</Button></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>

        <div className="pos-side">
          <div className="pos-panel">
            <CustomerBox customer={customer} onChange={setCustomer} />
          </div>
          <div className="pos-panel pos-totals">
            <div><span>Items</span><span>{lines.reduce((a, l) => a + l.qty, 0)}</span></div>
            <div><span>Subtotal</span><span>{formatINR(bill?.subtotal ?? 0)}</span></div>
            <div>
              <span>Bill discount</span>
              <DiscountField value={billDiscount} disabled={!canDiscount || !lines.length} onChange={setBillDiscount} width={80} />
            </div>
            <div><span>Total discount</span><span>−{formatINR(bill?.discount ?? 0)}</span></div>
            <div><span>{settings.pricesIncludeTax ? 'GST (included)' : 'GST'}</span><span>{formatINR(bill?.tax ?? 0)}</span></div>
            {settings.roundOff && <div><span>Round off</span><span>{formatINR(bill?.roundOff ?? 0)}</span></div>}
            <div className="pos-grand"><span>TOTAL</span><span>{formatINR(bill?.total ?? 0)}</span></div>
            {needsApproval && <p className="pos-warn">Discount {(discBp / 100).toFixed(1)}% is above your {(settings.maxDiscountBp / 100).toFixed(0)}% limit: manager approval will be asked at payment.</p>}
            {stockWarnings.length > 0 && <p className="pos-warn">{stockWarnings.length} item(s) exceed available stock.</p>}
          </div>
          <Input placeholder="Bill note (optional)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
          <Button variant="primary" className="pos-big-btn" disabled={!lines.length} onClick={openPay}>Pay (F8)</Button>
          <div className="row">
            <Button onClick={() => void hold()} disabled={!lines.length}>Hold (F4)</Button>
            <Button onClick={() => (lines.length ? setClearAsk(true) : newBill())}>New bill (F9)</Button>
          </div>
        </div>
      </div>

      <div className="pos-keys" aria-label="Keyboard shortcuts">
        <span><kbd>F2</kbd> Search</span><span><kbd>Enter</kbd> Add / Pay</span><span><kbd>F4</kbd> Hold</span>
        <span><kbd>F8</kbd> Pay</span><span><kbd>F9</kbd> New bill</span><span><kbd>Esc</kbd> Cancel</span><span><kbd>5*code</kbd> Quantity</span>
      </div>

      <PaymentDialog open={payOpen} total={bill?.total ?? 0} hasCustomer={!!(customer && (customer.id || customer.phone))} upiId={settings.upiId} payeeName={settings.payeeName} onClose={() => { setPayOpen(false); focusScan() }} onSubmit={submitSale} />

      <Modal title="Sale completed" open={!!done} onClose={newBill}
        footer={<Button variant="primary" onClick={newBill}>New bill (F9)</Button>}>
        {done && (
          <div className="pos-success">
            <Badge tone="good">Saved</Badge>
            <div className="big">{done.invoiceNo}</div>
            <div>Total <strong>{formatINR(done.total)}</strong> · Received <strong>{formatINR(done.paid)}</strong></div>
            {done.change > 0 && (
              <div className="pos-change-big pos-good-bg" role="status" data-testid="success-change"><span>Change to return:</span> <strong>{formatINR(done.change)}</strong></div>
            )}
            {soldUnits.length > 0 && <div className="muted" data-testid="sold-units" style={{ marginTop: 6 }}>Units sold: {soldUnits.join(', ')}</div>}
            <div style={{ marginTop: 14 }}>
              <PrintActions printRef={{ saleId: done.saleId }} invoiceNo={done.invoiceNo} afterSale autoPrint={prefs.autoPrint()} />
            </div>
            <label className="row" style={{ justifyContent: 'center', marginTop: 12 }}>
              <input type="checkbox" defaultChecked={prefs.autoPrint()} onChange={(e) => prefs.setAutoPrint(e.target.checked)} /> Print receipt automatically after each sale
            </label>
          </div>
        )}
      </Modal>

      <Modal title="Cancel this bill?" open={clearAsk} onClose={() => { setClearAsk(false); focusScan() }}
        footer={<><Button onClick={() => setClearAsk(false)}>Keep bill</Button><Button variant="danger" autoFocus onClick={() => { setClearAsk(false); newBill() }}>Clear bill</Button></>}>
        <p>All items on this bill will be removed.</p>
      </Modal>

      <HeldDialog open={heldOpen} onClose={() => { setHeldOpen(false); focusScan() }}
        busy={lines.length > 0}
        onResume={(cart) => { const ls = normalizeResumed(cart.lines ?? []); setLinesSync(ls); unitList.current = listFromLines(ls); setUnitWarn(null); setBillDiscount(cart.billDiscount ?? null); setCustomer(cart.customer ?? null); setNote(cart.note ?? ''); setHeldOpen(false) }} />

      <ShiftDialog mode={shiftDlg} required={settings.requireShift} onClose={() => { setShiftDlg(null); focusScan() }} onChanged={loadShift} />
    </div>
  )
}

// ------------------------------------------------------------------ customer
function CustomerBox({ customer, onChange }: { customer: CartCustomer | null; onChange: (c: CartCustomer | null) => void }) {
  const [phone, setPhone] = useState(customer?.phone ?? '')
  const [name, setName] = useState(customer?.name ?? '')
  const [status, setStatus] = useState('')
  useEffect(() => { setPhone(customer?.phone ?? ''); setName(customer?.name ?? '') }, [customer])

  const lookup = async () => {
    const p = phone.trim()
    if (p.length < 3) { onChange(name.trim() ? { name: name.trim(), phone: p } : null); return }
    try {
      const c = await call<{ id: number; name: string; phone: string } | null>('pos', 'findCustomerByPhone', { phone: p })
      if (c) { onChange({ id: c.id, name: c.name, phone: c.phone }); setStatus('') }
      else { onChange({ name: name.trim(), phone: p }); setStatus('New customer will be saved with this bill') }
    } catch (e) { setStatus(errMsg(e)) }
  }
  return (
    <div>
      <div className="field-label" style={{ fontWeight: 600, fontSize: 12, color: 'var(--muted)' }}>Customer</div>
      <div className="row" style={{ flexWrap: 'nowrap' }}>
        <Input placeholder="Phone" inputMode="tel" value={phone} onChange={(e) => { setPhone(e.target.value); if (customer?.id) onChange(null) }}
          onBlur={lookup} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void lookup() } }} aria-label="Customer phone" />
        {customer && <Button variant="ghost" aria-label="Clear customer" onClick={() => { onChange(null); setPhone(''); setName(''); setStatus('') }}>✕</Button>}
      </div>
      <Input style={{ marginTop: 6 }} placeholder="Name (walk-in if empty)" value={name} disabled={!!customer?.id}
        onChange={(e) => setName(e.target.value)} onBlur={() => { if (!customer?.id) onChange(name.trim() || phone.trim() ? { name: name.trim(), phone: phone.trim() } : null) }} aria-label="Customer name" />
      {customer?.id && <div className="pos-good" style={{ fontSize: 12, marginTop: 4 }}>Existing customer</div>}
      {status && <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{status}</div>}
    </div>
  )
}

// ------------------------------------------------------------------ held bills
interface HeldRow { id: number; label: string; createdAt: number; lineCount: number; customerName: string }
function HeldDialog({ open, onClose, onResume, busy }: { open: boolean; onClose: () => void; onResume: (c: SavedCart) => void; busy: boolean }) {
  const toast = useToast()
  const [rows, setRows] = useState<HeldRow[]>([])
  const load = useCallback(() => { call<HeldRow[]>('pos', 'listHeld').then(setRows).catch((e) => toast(errMsg(e), 'bad')) }, [toast])
  useEffect(() => { if (open) load() }, [open, load])
  return (
    <Modal title="Held bills" open={open} onClose={onClose} wide>
      {busy && <p className="pos-warn">Finish or hold the current bill before resuming another.</p>}
      <Table
        rows={rows} rowKey={(r) => r.id}
        empty={<div className="empty">No held bills</div>}
        columns={[
          { key: 'label', header: 'Bill', render: (r) => r.label || `Bill #${r.id}` },
          { key: 'customerName', header: 'Customer' },
          { key: 'lineCount', header: 'Items', align: 'right' },
          { key: 'createdAt', header: 'Held at', render: (r) => new Date(r.createdAt).toLocaleString() },
          { key: 'act', header: '', render: (r) => (
            <span className="row">
              <Button variant="primary" disabled={busy} onClick={async () => {
                try { const h = await call<{ cart: SavedCart }>('pos', 'resumeHeld', { id: r.id }); onResume(h.cart) } catch (e) { toast(errMsg(e), 'bad') }
              }}>Resume</Button>
              <Button variant="danger" onClick={async () => { try { await call('pos', 'discardHeld', { id: r.id }); load() } catch (e) { toast(errMsg(e), 'bad') } }}>Discard</Button>
            </span>
          ) }
        ]}
      />
    </Modal>
  )
}

// ------------------------------------------------------------------ shift
function ShiftDialog({ mode, required, onClose, onChanged }: { mode: 'open' | 'close' | null; required: boolean; onClose: () => void; onChanged: () => Promise<void> }) {
  const toast = useToast()
  const [cash, setCash] = useState(0)
  const [note, setNote] = useState('')
  const [sum, setSum] = useState<ShiftSummary | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    setCash(0); setNote(''); setSum(null)
    if (mode === 'close') call<ShiftSummary>('pos', 'shiftSummary', {}).then((s) => { setSum(s); setCash(s.expectedCash) }).catch((e) => toast(errMsg(e), 'bad'))
  }, [mode, toast])
  if (!mode) return null
  const act = async () => {
    setBusy(true)
    try {
      if (mode === 'open') await call('pos', 'openShift', { openingCash: cash, note })
      else await call('pos', 'closeShift', { closingCash: cash, note })
      toast(mode === 'open' ? 'Shift opened' : 'Shift closed', 'good')
      await onChanged()
      onClose()
    } catch (e) { toast(errMsg(e), 'bad') } finally { setBusy(false) }
  }
  const variance = sum ? cash - sum.expectedCash : 0
  return (
    <Modal title={mode === 'open' ? 'Open cash shift' : 'Close cash shift'} open onClose={onClose}
      footer={<>
        <Button onClick={onClose}>{mode === 'open' && !required ? 'Skip for now' : 'Cancel'}</Button>
        <Button variant="primary" disabled={busy || (mode === 'close' && !sum)} onClick={act}>{mode === 'open' ? 'Open shift' : 'Close shift'}</Button>
      </>}>
      {mode === 'close' && sum && (
        <div className="pos-panel pos-totals" style={{ marginBottom: 12 }}>
          <div><span>Opening cash</span><span>{formatINR(sum.openingCash)}</span></div>
          <div><span>Cash sales</span><span>{formatINR(sum.cashSales)}</span></div>
          <div><span>Cash refunds</span><span>−{formatINR(sum.cashRefunds)}</span></div>
          <div><strong>Expected in drawer</strong><strong>{formatINR(sum.expectedCash)}</strong></div>
          {sum.byMethod.filter((m) => m.method !== 'cash').map((m) => <div key={m.method} className="muted"><span>{m.method.toUpperCase()} sales</span><span>{formatINR(m.amount)}</span></div>)}
          <div className="muted"><span>{sum.salesCount} sales · {sum.returnsTotal ? `returns ${formatINR(sum.returnsTotal)}` : 'no returns'}</span><span /></div>
        </div>
      )}
      <Field label={mode === 'open' ? 'Opening cash in drawer (₹)' : 'Counted cash in drawer (₹)'}>
        <MoneyField value={cash} width={160} onCommit={setCash} />
      </Field>
      {mode === 'close' && sum && (
        <p className={variance === 0 ? 'pos-good' : 'pos-bad'}><strong>{variance === 0 ? 'Cash matches' : variance > 0 ? `Over by ${formatINR(variance)}` : `Short by ${formatINR(-variance)}`}</strong></p>
      )}
      <Field label="Note"><Input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
    </Modal>
  )
}

export function PosPage() {
  return (
    <div style={{ height: '100%' }}>
      <PosScreen />
    </div>
  )
}

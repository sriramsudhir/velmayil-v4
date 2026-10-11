// @vitest-environment jsdom
import { createElement, useState, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ConfirmProvider, DataTable, Field, Input, Modal, MoneyInput, Pagination, Tabs, friendlyError, useConfirm,
  formatMoney, formatMoneyCompact, parseRupeesToPaise, paiseToRupeeString, formatDate, formatDateTime, todayISO, startOfDayIST, addDaysISO, istDateString, pctChange
} from '@/ui'
import { ApiError } from '@/lib/api'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const h = createElement as (type: any, props?: any, ...children: any[]) => ReactElement
let host: HTMLDivElement
let root: Root
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host) })
afterEach(() => { act(() => root.unmount()); host.remove() })
const render = (el: ReactElement) => act(() => { root.render(el) })
const type = (input: HTMLInputElement, value: string) => act(() => {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  set.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
})

describe('format helpers', () => {
  it('formats paise with Indian grouping', () => {
    expect(formatMoney(123456789)).toBe('₹12,34,567.89')
    expect(formatMoney(-5000)).toBe('-₹50.00')
    expect(formatMoney(null)).toBe('₹0.00')
    expect(formatMoneyCompact(12_500_000)).toBe('₹1.25L')
    expect(formatMoneyCompact(30_000_000_00)).toBe('₹3Cr')
  })
  it('parses rupees to paise without float error', () => {
    expect(parseRupeesToPaise('1,234.56')).toBe(123456)
    expect(parseRupeesToPaise('₹ 0.1')).toBe(10)
    expect(parseRupeesToPaise('19.99')).toBe(1999)
    expect(parseRupeesToPaise('1.005')).toBe(101)
    expect(parseRupeesToPaise('')).toBeNull()
    expect(parseRupeesToPaise('abc')).toBeNull()
    expect(paiseToRupeeString(1999)).toBe('19.99')
    expect(paiseToRupeeString(5, { trimZero: true })).toBe('0.05')
    expect(paiseToRupeeString(500, { trimZero: true })).toBe('5')
  })
  it('uses IST for dates', () => {
    // 2026-01-01T19:00:00Z is 2026-01-02 00:30 IST
    const t = Date.UTC(2026, 0, 1, 19, 0, 0)
    expect(istDateString(t)).toBe('2026-01-02')
    expect(formatDate(t)).toBe('02 Jan 2026')
    expect(formatDateTime(t)).toMatch(/12:30 AM/)
    expect(startOfDayIST('2026-01-02')).toBe(Date.UTC(2026, 0, 1, 18, 30))
    expect(addDaysISO('2026-03-01', -1)).toBe('2026-02-28')
    expect(todayISO()).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(pctChange(150, 100)).toBe(50)
    expect(pctChange(1, 0)).toBeNull()
  })
  it('maps API errors to friendly text', () => {
    expect(friendlyError(new ApiError('FORBIDDEN', 'x'))).toBe('You do not have permission to do that.')
    expect(friendlyError(new ApiError('INSUFFICIENT_STOCK', 'Rocket: only 2 left'))).toContain('only 2 left')
    expect(friendlyError(new ApiError('UNAUTHENTICATED', 'x'))).toMatch(/sign in/i)
    expect(friendlyError(new Error('boom'))).toBe('boom')
  })
})

describe('components', () => {
  it('Field binds its label to the control', () => {
    render(h(Field, { label: 'Name' }, h(Input, { defaultValue: 'x' })))
    const input = host.querySelector('input')!
    const label = host.querySelector('label')!
    expect(label.htmlFor).toBe(input.id)
    expect(input.id).not.toBe('')
  })

  it('Field wires error into aria attributes', () => {
    render(h(Field, { label: 'Qty', error: 'Required' }, h(Input, {})))
    const input = host.querySelector('input')!
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(document.getElementById(input.getAttribute('aria-describedby')!)?.textContent).toBe('Required')
  })

  it('MoneyInput converts rupees <-> integer paise', () => {
    const seen: (number | null)[] = []
    function T() {
      const [v, setV] = useState<number | null>(null)
      return h(MoneyInput, { value: v, onChange: (n: number | null) => { seen.push(n); setV(n) } })
    }
    render(h(T))
    const input = host.querySelector('input')!
    type(input, '12.5')
    expect(seen.at(-1)).toBe(1250)
    type(input, '1,0') // grouping commas are ignored
    expect(seen.at(-1)).toBe(1000)
    type(input, '0.999') // third decimal rejected: value unchanged
    expect(seen.at(-1)).toBe(1000)
    type(input, 'x1') // letters rejected
    expect(seen.at(-1)).toBe(1000)
    type(input, '')
    expect(seen.at(-1)).toBeNull()
  })

  it('Modal traps focus, closes on Esc, restores focus', () => {
    const onClose = vi.fn()
    const opener = document.createElement('button')
    document.body.appendChild(opener)
    opener.focus()
    render(h(Modal, { title: 'Edit', open: true, onClose, footer: h('button', { id: 'last' }, 'Save') }, h('input', { id: 'first' })))
    const dlg = document.querySelector('[role=dialog]')!
    expect(dlg.getAttribute('aria-modal')).toBe('true')
    expect(dlg.contains(document.activeElement)).toBe(true)
    // Tab from the last focusable wraps to the first
    const last = document.getElementById('last') as HTMLButtonElement
    last.focus()
    const ev = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    // jsdom has no layout, so offsetParent is null; trap treats the active element as focusable.
    act(() => { last.dispatchEvent(ev) })
    expect(dlg.contains(document.activeElement)).toBe(true)
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    expect(onClose).toHaveBeenCalledTimes(1)
    render(h(Modal, { title: 'Edit', open: false, onClose, children: null }))
    expect(document.activeElement).toBe(opener)
    opener.remove()
  })

  it('only the top-most Modal handles Esc', () => {
    const a = vi.fn(), b = vi.fn()
    render(h('div', null, h(Modal, { title: 'A', open: true, onClose: a, children: 'a' }), h(Modal, { title: 'B', open: true, onClose: b, children: 'b' })))
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    expect(b).toHaveBeenCalledTimes(1)
    expect(a).not.toHaveBeenCalled()
  })

  it('DataTable sorts on header click and supports keyboard row activation', () => {
    const rows = [{ id: 1, n: 'b', v: 30 }, { id: 2, n: 'a', v: 10 }, { id: 3, n: 'c', v: 20 }]
    const clicked: number[] = []
    render(h(DataTable, {
      rows, rowKey: (r: typeof rows[0]) => r.id, onRowClick: (r: typeof rows[0]) => clicked.push(r.id),
      columns: [{ key: 'n', header: 'Name', sortable: true }, { key: 'v', header: 'Value', sortable: true, numeric: true }]
    }))
    const names = () => Array.from(host.querySelectorAll('tbody tr td:first-child')).map((t) => t.textContent)
    expect(names()).toEqual(['b', 'a', 'c'])
    act(() => { (host.querySelectorAll('.th-sort')[1] as HTMLButtonElement).click() })
    expect(names()).toEqual(['a', 'c', 'b'])
    act(() => { (host.querySelectorAll('.th-sort')[1] as HTMLButtonElement).click() })
    expect(names()).toEqual(['b', 'c', 'a'])
    expect(host.querySelectorAll('th')[1].getAttribute('aria-sort')).toBe('descending')
    const firstRow = host.querySelector('tbody tr') as HTMLElement
    act(() => { firstRow.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) })
    expect(clicked).toEqual([1])
  })

  it('DataTable paginates client-side', () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ id: i, n: `r${i}` }))
    render(h(DataTable, { rows, rowKey: (r: typeof rows[0]) => r.id, pageSize: 5, columns: [{ key: 'n', header: 'N' }] }))
    expect(host.querySelectorAll('tbody tr').length).toBe(5)
    act(() => { (host.querySelector('[aria-label="Next page"]') as HTMLButtonElement).click() })
    expect(host.querySelector('tbody tr td')!.textContent).toBe('r5')
  })

  it('Pagination reports ranges', () => {
    render(h(Pagination, { page: 2, pageSize: 25, total: 60, onPage: () => {} }))
    expect(host.textContent).toContain('26–50 of 60')
  })

  it('Tabs switch with arrow keys', () => {
    const seen: string[] = []
    render(h(Tabs, { items: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }], value: 'a', onChange: (k: string) => seen.push(k) }))
    const tab = host.querySelector('[role=tab][aria-selected=true]') as HTMLElement
    act(() => { tab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })) })
    expect(seen).toEqual(['b'])
  })

  it('useConfirm resolves true on confirm and false on cancel', async () => {
    let ask!: ReturnType<typeof useConfirm>
    function Grab() { ask = useConfirm(); return null }
    render(h(ConfirmProvider, null, h(Grab)))
    let p!: Promise<boolean>
    act(() => { p = ask({ message: 'Delete it?', confirmLabel: 'Delete', tone: 'danger' }) })
    const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Delete')!
    await act(async () => { btn.click() })
    expect(await p).toBe(true)
    act(() => { p = ask('Sure?') })
    const cancel = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Cancel')!
    await act(async () => { cancel.click() })
    expect(await p).toBe(false)
  })
})

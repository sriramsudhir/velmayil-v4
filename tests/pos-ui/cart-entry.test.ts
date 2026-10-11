// @vitest-environment jsdom
import { createElement, useState, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DiscountField, QtyField } from '@/modules/pos/parts'
import { MAX_LINE_QTY, clearDraft, loadDraft, parseQtyText, saveDraft } from '@/modules/pos/unitCart'
import type { CartLine } from '@/modules/pos/types'
import type { Discount } from '@shared/billing'

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
const blur = (el: HTMLElement) => act(() => { el.dispatchEvent(new FocusEvent('focusout', { bubbles: true })) })
const choose = (sel: HTMLSelectElement, value: string) => act(() => {
  const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
  set.call(sel, value)
  sel.dispatchEvent(new Event('change', { bubbles: true }))
})

describe('parseQtyText', () => {
  it('accepts whole numbers of at least 1, with grouping commas / spaces', () => {
    expect(parseQtyText('5')).toBe(5)
    expect(parseQtyText(' 12 ')).toBe(12)
    expect(parseQtyText('1,000')).toBe(1000)
    expect(parseQtyText('007')).toBe(7)
  })
  it('refuses empty, zero, negative, decimal and non-numeric text (the line keeps its quantity)', () => {
    for (const t of ['', ' ', '0', '-3', '1.5', 'abc', '5x', '1e3']) expect(parseQtyText(t)).toBeNull()
  })
  it('caps huge numbers at the per-line limit', () => {
    expect(parseQtyText('999999999')).toBe(MAX_LINE_QTY)
    expect(parseQtyText('9999999999999999999999')).toBeNull()
  })
})

describe('QtyField (quantity box of a bill line)', () => {
  function Harness({ log }: { log: number[] }) {
    const [qty, setQty] = useState(3)
    return h(QtyField, { value: qty, onCommit: (q: number) => { log.push(q); setQty(q) } })
  }
  it('clearing the box and typing a new number gives that number (not "1" glued in front of it)', () => {
    const log: number[] = []
    render(h(Harness, { log }))
    const input = host.querySelector('input')!
    expect(input.value).toBe('3')
    type(input, '')
    expect(input.value).toBe('') // stays empty while typing; the line still has 3
    expect(log).toEqual([])
    type(input, '2')
    expect(input.value).toBe('2')
    type(input, '25')
    expect(log).toEqual([2, 25])
    expect(input.value).toBe('25')
  })
  it('ignores letters and decimals, and an empty or zero box falls back to the real quantity on blur', () => {
    const log: number[] = []
    render(h(Harness, { log }))
    const input = host.querySelector('input')!
    type(input, '1.5')
    expect(input.value).toBe('3') // keystroke refused: 1.5 never becomes 15
    type(input, 'x')
    expect(input.value).toBe('3')
    type(input, '0')
    expect(log).toEqual([])
    blur(input)
    expect(input.value).toBe('3')
    type(input, '')
    blur(input)
    expect(input.value).toBe('3')
    expect(log).toEqual([])
  })
})

describe('DiscountField', () => {
  function Harness({ log, initial = null }: { log: Discount[]; initial?: Discount }) {
    const [d, setD] = useState<Discount>(initial)
    return h(DiscountField, { value: d, onChange: (x: Discount) => { log.push(x); setD(x) } })
  }
  it('"%" can be chosen before typing the number and stays chosen', () => {
    const log: Discount[] = []
    render(h(Harness, { log }))
    const input = host.querySelector('input')!
    const sel = host.querySelector('select')!
    choose(sel, 'percent')
    expect(sel.value).toBe('percent') // used to jump back to rupees because there was no discount yet
    type(input, '10')
    blur(input)
    expect(log[log.length - 1]).toEqual({ type: 'percent', value: 1000 })
    expect(sel.value).toBe('percent')
    expect(input.value).toBe('10')
  })
  it('an invalid entry shows the discount that is really applied instead of an empty box', () => {
    const log: Discount[] = []
    render(h(Harness, { log, initial: { type: 'amount', value: 500 } }))
    const input = host.querySelector('input')!
    expect(input.value).toBe('5')
    type(input, 'abc')
    blur(input)
    expect(log).toEqual([]) // discount unchanged...
    expect(input.value).toBe('5') // ...and the box says so
  })
  it('percent is capped at 100 and the box shows the capped value; empty removes the discount', () => {
    const log: Discount[] = []
    render(h(Harness, { log, initial: { type: 'percent', value: 10000 } }))
    const input = host.querySelector('input')!
    type(input, '150')
    blur(input)
    expect(input.value).toBe('100')
    type(input, '')
    blur(input)
    expect(log[log.length - 1]).toBeNull()
  })
})

describe('bill in progress (draft kept while another screen is open)', () => {
  const line = (key: string): CartLine => ({ key, variantId: 1, name: 'Item', sku: 'S1', qty: 2, price: 1000, overridePrice: null, discount: null, taxRateBp: 0, trackStock: true, stock: 5 })
  it('comes back for the same cashier with items, discount, customer and note', () => {
    clearDraft()
    expect(loadDraft(7)).toBeNull()
    saveDraft(7, { lines: [line('a')], billDiscount: { type: 'percent', value: 500 }, customer: { name: 'Ravi', phone: '9000000001' }, note: 'gift' })
    expect(loadDraft(7)).toEqual({ lines: [line('a')], billDiscount: { type: 'percent', value: 500 }, customer: { name: 'Ravi', phone: '9000000001' }, note: 'gift' })
  })
  it('is not shown to another user, and an empty bill or a finished sale leaves nothing behind', () => {
    saveDraft(7, { lines: [line('a')], billDiscount: null, customer: null, note: '' })
    expect(loadDraft(8)).toBeNull()
    saveDraft(7, { lines: [], billDiscount: null, customer: null, note: 'x' })
    expect(loadDraft(7)).toBeNull()
    saveDraft(7, { lines: [line('b')], billDiscount: null, customer: null, note: '' })
    clearDraft()
    expect(loadDraft(7)).toBeNull()
  })
})

// @vitest-environment jsdom
import { createElement, useState, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DataTable, Table, useInterval } from '@/ui'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const h = createElement as (type: any, props?: any, ...children: any[]) => ReactElement
let host: HTMLDivElement
let root: Root
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host) })
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers() })
const render = (el: ReactElement) => act(() => { root.render(el) })

const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i, name: `Item ${i}` }))
const cols = [{ key: 'name', header: 'Name' }]

describe('big lists never mount thousands of rows at once', () => {
  it('Table paints the first chunk and offers "Show more"', () => {
    render(h(Table, { columns: cols, rows: rows(1500), rowKey: (r: { id: number }) => r.id }))
    expect(host.querySelectorAll('tbody tr').length).toBeLessThanOrEqual(100)
    const more = [...host.querySelectorAll('button')].find((b) => /show more/i.test(b.textContent ?? ''))!
    expect(more).toBeTruthy()
    act(() => more.click())
    const n = host.querySelectorAll('tbody tr').length
    expect(n).toBeGreaterThan(100)
    expect(n).toBeLessThan(1500)
  })
  it('Table with a normal number of rows is unchanged (no button)', () => {
    render(h(Table, { columns: cols, rows: rows(80), rowKey: (r: { id: number }) => r.id }))
    expect(host.querySelectorAll('tbody tr')).toHaveLength(80)
    expect([...host.querySelectorAll('button')].some((b) => /show more/i.test(b.textContent ?? ''))).toBe(false)
  })
  it('DataTable pages itself above 300 rows unless the caller chooses', () => {
    render(h(DataTable, { columns: cols, rows: rows(2000), rowKey: (r: { id: number }) => r.id }))
    expect(host.querySelectorAll('tbody tr').length).toBeLessThanOrEqual(100)
    expect(host.querySelector('nav[aria-label="Pagination"]')).toBeTruthy()
  })
})

describe('useInterval is cheap', () => {
  const setHidden = (v: boolean) => Object.defineProperty(document, 'hidden', { configurable: true, get: () => v })
  function Probe({ fn, ms }: { fn: () => void | Promise<unknown>; ms: number }) {
    useInterval(fn, ms, { onFocus: true })
    return null
  }
  it('does not run while the window is hidden, and refreshes on return only when stale', () => {
    vi.useFakeTimers()
    const fn = vi.fn()
    render(h(Probe, { fn, ms: 1000 }))
    act(() => { vi.advanceTimersByTime(3100) })
    expect(fn).toHaveBeenCalledTimes(3)
    setHidden(true)
    act(() => { vi.advanceTimersByTime(60_000) })
    expect(fn).toHaveBeenCalledTimes(3) // nothing while hidden
    setHidden(false)
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(fn).toHaveBeenCalledTimes(4) // stale -> one refresh on return
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(fn).toHaveBeenCalledTimes(4) // fresh -> nothing
    setHidden(false)
  })
  it('never starts a run while the previous one is still in flight', async () => {
    vi.useFakeTimers()
    let release: () => void = () => undefined
    const fn = vi.fn(() => new Promise<void>((res) => { release = res }))
    render(h(Probe, { fn, ms: 500 }))
    act(() => { vi.advanceTimersByTime(5000) })
    expect(fn).toHaveBeenCalledTimes(1) // 10 ticks elapsed, one run in flight
    await act(async () => { release(); await Promise.resolve(); await Promise.resolve() })
    act(() => { vi.advanceTimersByTime(600) })
    expect(fn).toHaveBeenCalledTimes(2)
  })
  it('polls nothing when ms is null', () => {
    vi.useFakeTimers()
    const fn = vi.fn()
    function P() { const [n] = useState(0); useInterval(fn, null); return h('i', null, n) }
    render(h(P))
    act(() => { vi.advanceTimersByTime(60_000) })
    expect(fn).not.toHaveBeenCalled()
  })
})

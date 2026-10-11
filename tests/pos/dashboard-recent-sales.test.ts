// @vitest-environment jsdom
import { createElement, act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '@/ui'
import { SessionProvider } from '@/lib/session'
import Dashboard from '@/modules/dashboard/DashboardPage'
import type { DashboardSummary } from '@shared/reports'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const h = createElement as (type: any, props?: any, ...children: any[]) => ReactElement
const day = { sales: 0, bills: 0, avgBill: 0, returns: 0, grossProfit: null }
const recent = (id: number, total: number, customerName: string | null = null) => ({ id, invoiceNo: `INV-2026-00000${id}`, createdAt: Date.now() - id * 60_000, customerName, cashierName: 'Admin', total, status: 'completed' })

let host: HTMLDivElement
let root: Root
let permissions: string[]
let sales: ReturnType<typeof recent>[]
let calls: [string, string, unknown][]
let live: ((events: { service: string; method: string; ts: number }[]) => void) | null

function summary(): DashboardSummary {
  return {
    generatedAt: Date.now(), restricted: false, today: { ...day, bills: sales.length, sales: sales.reduce((t, s) => t + s.total, 0) }, yesterday: day, yesterdaySoFar: day,
    last7: [], last30: [], topProducts: [], categoryShare: [], paymentMix: [], heatmap: [], lowStockCount: 0, openShift: null, pendingSync: 0, recentSales: sales
  }
}

beforeEach(() => {
  host = document.createElement('div')
  host.id = 'root'
  document.body.appendChild(host)
  root = createRoot(host)
  permissions = ['*']
  sales = [recent(1, 50000, 'Ravi Kumar'), recent(2, 12000)]
  calls = []
  live = null
  window.velmayil = {
    call: (async (service: string, method: string, args?: unknown) => {
      calls.push([service, method, args])
      const key = `${service}.${method}`
      if (key === 'setup.status') return { ok: true, data: { complete: true } }
      if (key === 'auth.current') return { ok: true, data: { userId: 1, username: 'admin', name: 'Admin', role: 'Owner', permissions, posId: 1, posCode: 'POS-01' } }
      if (key === 'dashboard.summary') return { ok: true, data: summary() }
      if (key === 'pos.deleteSale') {
        const id = (args as { saleId: number }).saleId
        const s = sales.find((x) => x.id === id)!
        sales = sales.filter((x) => x.id !== id)
        return { ok: true, data: { ok: true, saleId: id, invoiceNo: s.invoiceNo, total: s.total, stockRestored: 2 } }
      }
      return { ok: false, error: { code: 'NOT_FOUND', message: `unexpected ${key}` } }
    }) as never,
    onChange: (cb) => { live = cb; return () => { live = null } }
  }
})
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers() })

const Where = () => h('output', { 'data-testid': 'where' }, useLocation().pathname + useLocation().search)
async function mount(): Promise<void> {
  await act(async () => {
    root.render(h(MemoryRouter, { initialEntries: ['/dashboard'] }, h(SessionProvider, null, h(ToastProvider, null,
      h(Routes, null, h(Route, { path: '/dashboard', element: h(Dashboard) }), h(Route, { path: '*', element: h(Where) }))))))
  })
  await settle()
}
const settle = () => act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve() })
const rows = () => [...host.querySelectorAll<HTMLElement>('[data-testid="recent-sale"]')]
const trash = (row: HTMLElement) => row.querySelector<HTMLButtonElement>('button.del-sale-icon')
const type = (input: HTMLInputElement, value: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
})

describe('dashboard: recent sales', () => {
  it('every row has an accessible delete button; confirming deletes the bill and the dashboard reloads at once', async () => {
    await mount()
    expect(rows()).toHaveLength(2)
    const btn = trash(rows()[0])!
    expect(btn.getAttribute('aria-label')).toBe('Delete invoice INV-2026-000001')
    expect(btn.tagName).toBe('BUTTON') // keyboard reachable
    expect(host.textContent).toContain('₹620.00') // today's sales tile

    await act(async () => { btn.click() })
    const dlg = document.querySelector<HTMLElement>('[role="dialog"]')!
    expect(dlg.textContent).toContain('INV-2026-000001')
    expect(dlg.textContent).toContain('500.00')
    expect(dlg.textContent).toContain('Ravi Kumar')
    expect(calls.some(([s, m]) => s === 'pos' && m === 'deleteSale')).toBe(false) // nothing happens before the confirmation

    type(dlg.querySelector<HTMLInputElement>('input')!, 'billed twice')
    const loads = calls.filter(([s, m]) => s === 'dashboard' && m === 'summary').length
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-testid="delete-sale-confirm"]')!.click() })
    await settle()
    expect(calls.find(([s, m]) => s === 'pos' && m === 'deleteSale')![2]).toEqual({ saleId: 1, reason: 'billed twice', approval: undefined })
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(calls.filter(([s, m]) => s === 'dashboard' && m === 'summary').length).toBe(loads + 1)
    expect(rows().map((r) => r.querySelector('strong')!.textContent)).toEqual(['INV-2026-000002'])
    expect(host.textContent).toContain('₹120.00')
    expect(document.querySelector('.toast')!.textContent).toContain('Invoice INV-2026-000001 deleted')
  })

  it('cancelling the dialog deletes nothing', async () => {
    await mount()
    await act(async () => { trash(rows()[1])!.click() })
    const cancel = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] footer button')].find((b) => b.textContent === 'Cancel')!
    await act(async () => { cancel.click() })
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(calls.some(([s, m]) => s === 'pos' && m === 'deleteSale')).toBe(false)
    expect(rows()).toHaveLength(2)
  })

  it('without pos.delete there is no delete button; the row still opens the bill in Sales history', async () => {
    permissions = ['reports.view', 'pos.reprint']
    await mount()
    expect(rows()).toHaveLength(2)
    expect(rows().some((r) => trash(r))).toBe(false)
    const link = rows()[0].querySelector<HTMLAnchorElement>('a.recent-open')!
    expect(link.getAttribute('aria-label')).toMatch(/^Open invoice INV-2026-000001/)
    await act(async () => { link.click() })
    expect(host.querySelector('[data-testid="where"]')!.textContent).toBe('/pos/history?sale=1')
  })

  it('reloads when a sale changes elsewhere (live bus)', async () => {
    vi.useFakeTimers()
    await mount()
    expect(live).toBeTypeOf('function')
    const loads = calls.filter(([s, m]) => s === 'dashboard' && m === 'summary').length
    sales = [recent(3, 7000), ...sales]
    await act(async () => { live!([{ service: 'catalog', method: 'save', ts: Date.now() }]); vi.advanceTimersByTime(200) })
    expect(calls.filter(([s, m]) => s === 'dashboard' && m === 'summary').length).toBe(loads) // unrelated service
    await act(async () => { live!([{ service: 'pos', method: 'completeSale', ts: Date.now() }]); vi.advanceTimersByTime(200) })
    await settle()
    expect(calls.filter(([s, m]) => s === 'dashboard' && m === 'summary').length).toBe(loads + 1)
    expect(rows()).toHaveLength(3)
  })
})

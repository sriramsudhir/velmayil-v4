// @vitest-environment jsdom
import { createElement, act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '@/ui'
import { DeleteSaleDialog } from '@/modules/pos/DeleteSaleDialog'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const h = createElement as (type: any, props?: any, ...children: any[]) => ReactElement
let host: HTMLDivElement
let root: Root
let bridge: ReturnType<typeof vi.fn>
beforeEach(() => {
  host = document.createElement('div')
  host.id = 'root'
  document.body.appendChild(host)
  root = createRoot(host)
  bridge = vi.fn()
  window.velmayil = { call: bridge as never }
})
afterEach(() => { act(() => root.unmount()); host.remove() })

const sale = { id: 7, invoiceNo: 'INV-2026-000007', total: 123450, customerName: 'Ravi Kumar', createdAt: Date.UTC(2026, 3, 10, 6, 30), status: 'completed' }
const render = (props: Record<string, unknown> = {}) => act(() => { root.render(h(ToastProvider, null, h(DeleteSaleDialog, { sale, onClose: () => undefined, onDeleted: () => undefined, ...props }))) })
const dialogs = () => [...document.querySelectorAll<HTMLElement>('[role="dialog"]')]
const confirmBtn = () => document.querySelector<HTMLButtonElement>('[data-testid="delete-sale-confirm"]')!
const reasonInput = () => dialogs()[0].querySelector<HTMLInputElement>('input')!
const type = (input: HTMLInputElement, value: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
})
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve() })

describe('DeleteSaleDialog', () => {
  it('names the invoice, amount and customer, explains the consequences and needs a reason before it can be confirmed', async () => {
    const onDeleted = vi.fn()
    render({ onDeleted })
    const d = dialogs()[0]
    expect(d.getAttribute('aria-modal')).toBe('true')
    expect(d.querySelector('h3')!.textContent).toBe('Delete invoice INV-2026-000007?')
    const text = d.textContent ?? ''
    expect(text).toContain('INV-2026-000007')
    expect(text).toContain('1,234.50')
    expect(text).toContain('Ravi Kumar')
    expect(text).toContain('permanently deleted')
    expect(text).toMatch(/returned to stock/)
    expect(text).toMatch(/cannot be undone/)
    // the reason field is labelled and focused; the destructive button is locked until a reason is typed
    const input = reasonInput()
    expect(d.querySelector(`label[for="${input.id}"]`)!.textContent).toMatch(/Reason/)
    expect(confirmBtn().disabled).toBe(true)
    type(input, 'ab')
    expect(confirmBtn().disabled).toBe(true)
    await act(async () => { confirmBtn().click() })
    expect(bridge).not.toHaveBeenCalled()

    type(input, '  billed twice ')
    expect(confirmBtn().disabled).toBe(false)
    bridge.mockResolvedValueOnce({ ok: true, data: { ok: true, saleId: 7, invoiceNo: 'INV-2026-000007', total: 123450, stockRestored: 3 } })
    await act(async () => { confirmBtn().click() })
    await flush()
    expect(bridge).toHaveBeenCalledTimes(1)
    expect(bridge).toHaveBeenCalledWith('pos', 'deleteSale', { saleId: 7, reason: 'billed twice', approval: undefined })
    expect(onDeleted).toHaveBeenCalledWith(expect.objectContaining({ invoiceNo: 'INV-2026-000007', stockRestored: 3 }))
    expect(document.querySelector('.toast')!.textContent).toContain('Invoice INV-2026-000007 deleted · 3 items back in stock')
  })

  it('Enter in the reason field submits; a server error is shown and the dialog stays open', async () => {
    const onDeleted = vi.fn()
    render({ onDeleted })
    type(reasonInput(), 'test bill')
    bridge.mockResolvedValueOnce({ ok: false, error: { code: 'NOT_FOUND', message: 'Sale not found' } })
    await act(async () => { dialogs()[0].querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    await flush()
    expect(bridge).toHaveBeenCalledWith('pos', 'deleteSale', expect.objectContaining({ saleId: 7, reason: 'test bill' }))
    expect(onDeleted).not.toHaveBeenCalled()
    expect(dialogs()[0].querySelector('[role="alert"].field-error')!.textContent).toBe('Sale not found')
    expect(confirmBtn().disabled).toBe(false)
  })

  it('a void bill says its stock is already back; walk-in customers are named as such', () => {
    render({ sale: { id: 9, invoiceNo: 'INV-9', total: 5000, status: 'void', customerName: null } })
    const text = dialogs()[0].textContent ?? ''
    expect(text).toContain('Walk-in customer')
    expect(text).toMatch(/already void/)
    expect(text).not.toMatch(/still with the customer/)
  })

  it('APPROVAL_REQUIRED opens the manager approval dialog; once approved the delete is retried with the approval id', async () => {
    const onDeleted = vi.fn()
    render({ onDeleted })
    type(reasonInput(), 'test bill')
    bridge.mockResolvedValueOnce({ ok: false, error: { code: 'APPROVAL_REQUIRED', message: 'Manager approval required' } })
    await act(async () => { confirmBtn().click() })
    await flush()
    expect(dialogs()).toHaveLength(2)
    const appr = dialogs()[1]
    expect(appr.textContent).toContain('Manager approval required')
    expect(appr.textContent).toContain('INV-2026-000007')
    const [user, secret] = [...appr.querySelectorAll<HTMLInputElement>('input')].filter((i) => i.type !== 'checkbox')
    type(user, 'boss')
    type(secret, 'secret123')
    bridge.mockResolvedValueOnce({ ok: true, data: { approvalId: 55, approvedBy: { id: 2, username: 'boss', name: 'Boss', role: 'Manager' } } })
    bridge.mockResolvedValueOnce({ ok: true, data: { ok: true, saleId: 7, invoiceNo: 'INV-2026-000007', total: 123450, stockRestored: 0 } })
    await act(async () => { appr.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    await flush()
    await flush()
    expect(bridge.mock.calls[1]).toEqual(['auth', 'verifyApprover', expect.objectContaining({ username: 'boss', password: 'secret123', action: 'pos.delete', entity: 'sale', entityId: 7 })])
    expect(bridge.mock.calls[2]).toEqual(['pos', 'deleteSale', { saleId: 7, reason: 'test bill', approval: { approvalId: 55 } }])
    expect(onDeleted).toHaveBeenCalledTimes(1)
  })
})

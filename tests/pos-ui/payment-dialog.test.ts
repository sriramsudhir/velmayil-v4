// @vitest-environment jsdom
import { createElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PaymentDialog } from '@/modules/pos/PaymentDialog'
import { ApiError } from '@/lib/api'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const h = createElement as (type: any, props?: any, ...children: any[]) => ReactElement
type Pay = { method: string; amount: number; reference?: string }
let host: HTMLDivElement
let root: Root
let bridge: ReturnType<typeof vi.fn>
beforeEach(() => {
  host = document.createElement('div'); host.id = 'root'; document.body.appendChild(host); root = createRoot(host)
  bridge = vi.fn(async () => ({ ok: true, data: { approvalId: 77, approvedBy: { id: 2, username: 'boss', name: 'Boss', role: 'Manager' } } }))
  ;(window as unknown as { velmayil: unknown }).velmayil = { call: bridge }
})
afterEach(() => { act(() => root.unmount()); host.remove(); document.body.innerHTML = '' })
const render = (el: ReactElement) => act(() => { root.render(el) })
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 40)) })
const type = (input: HTMLInputElement | HTMLTextAreaElement, value: string) => act(() => {
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
})
const key = (el: Element, k: string) => act(async () => { el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })); await Promise.resolve() })
const dialogs = () => Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]'))
const buttonIn = (el: ParentNode, text: RegExp) => Array.from(el.querySelectorAll('button')).find((b) => text.test(b.textContent ?? ''))!

describe('payment dialog', () => {
  it('cash: change follows the typing, a third decimal is refused, Enter twice saves once', async () => {
    let release: () => void = () => undefined
    const onSubmit = vi.fn((_p: Pay[]) => new Promise<void>((r) => { release = r }))
    await render(h(PaymentDialog, { open: true, total: 23650, hasCustomer: false, onClose: () => undefined, onSubmit }))
    await flush()
    const cash = document.getElementById('pay-cash') as HTMLInputElement
    expect(document.querySelector('[data-testid="exact"]')).not.toBeNull()
    type(cash, '500')
    expect(document.querySelector('[data-testid="change-due"]')!.textContent).toContain('263.50')
    type(cash, '500.555') // refused: box and amount stay in step
    expect(cash.value).toBe('500')
    expect(document.querySelector('[data-testid="received"]')!.textContent).toContain('500.00')
    type(cash, '100')
    expect(document.querySelector('[data-testid="balance-due"]')!.textContent).toContain('136.50')
    await key(cash, 'Enter') // short payment: nothing is sent
    expect(onSubmit).not.toHaveBeenCalled()
    type(cash, '300')
    await key(cash, 'Enter')
    await key(cash, 'Enter')
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit.mock.calls[0][0]).toEqual([{ method: 'cash', amount: 30000 }])
    release()
  })

  it('credit needs a customer; a failed sale keeps the dialog open with the reason and can be retried', async () => {
    const onSubmit = vi.fn<(p: Pay[]) => Promise<void>>().mockRejectedValueOnce(new ApiError('INSUFFICIENT_STOCK', 'Insufficient stock for Sparkler Box (available 1, needed 2)')).mockResolvedValue(undefined)
    await render(h(PaymentDialog, { open: true, total: 10000, hasCustomer: false, onClose: () => undefined, onSubmit }))
    await flush()
    const dlg = dialogs()[0]
    await act(async () => { buttonIn(dlg, /^Credit$/).click() })
    expect(dlg.textContent).toContain('Select a customer (phone) to sell on credit.')
    expect(buttonIn(dlg, /Complete sale/).disabled).toBe(true)
    await act(async () => { buttonIn(dlg, /^Cash$/).click() })
    await act(async () => { buttonIn(dlg, /Complete sale/).click() })
    expect(dlg.querySelector('[role="alert"]')!.textContent).toContain('Insufficient stock for Sparkler Box')
    expect(buttonIn(dlg, /Complete sale/).disabled).toBe(false)
    await act(async () => { buttonIn(dlg, /Complete sale/).click() })
    expect(onSubmit).toHaveBeenCalledTimes(2)
  })

  it('manager approval: Enter in the approval window submits the approval, then the sale goes out once with it', async () => {
    const onSubmit = vi.fn(async (_p: Pay[], approval?: { approvalId?: number }) => {
      if (!approval?.approvalId) throw new ApiError('APPROVAL_REQUIRED', 'Discount above your limit needs manager approval')
    })
    await render(h(PaymentDialog, { open: true, total: 10000, hasCustomer: false, onClose: () => undefined, onSubmit }))
    await flush()
    await act(async () => { buttonIn(dialogs()[0], /Complete sale/).click() })
    expect(onSubmit).toHaveBeenCalledTimes(1)
    const approval = dialogs().find((d) => /Manager approval required/.test(d.textContent ?? ''))!
    expect(approval).toBeTruthy()
    const [user, secret] = Array.from(approval.querySelectorAll('input')).filter((i) => i.type !== 'checkbox') as HTMLInputElement[]
    type(user, 'boss'); type(secret, 'secret-pw'); type(approval.querySelector('textarea')!, 'festival offer')
    // Enter in the approver's password box: it used to bubble to the payment form and re-send the sale WITHOUT approval
    const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    await act(async () => { secret.dispatchEvent(ev); await Promise.resolve() })
    expect(ev.defaultPrevented).toBe(false) // the browser may submit the approval form
    expect(onSubmit).toHaveBeenCalledTimes(1)
    await act(async () => { approval.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await new Promise((r) => setTimeout(r, 20)) })
    expect(bridge).toHaveBeenCalledWith('auth', 'verifyApprover', expect.objectContaining({ username: 'boss', password: 'secret-pw', action: 'pos.discount' }))
    expect(onSubmit).toHaveBeenCalledTimes(2)
    expect(onSubmit.mock.calls[1][1]).toEqual({ approvalId: 77 })
  })
})

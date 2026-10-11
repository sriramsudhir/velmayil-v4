import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, UNAUTHENTICATED_EVENT, call, errMsg } from '@/lib/api'

type Bridge = (service: string, method: string, args?: unknown) => Promise<unknown>
const g = globalThis as unknown as { window?: unknown }
const install = (bridge: Bridge, dispatchEvent: (e: Event) => boolean = () => true) => {
  g.window = { velmayil: { call: bridge }, dispatchEvent }
}
afterEach(() => { delete g.window })

describe('renderer API bridge', () => {
  it('errMsg never returns "[object Object]"', () => {
    expect(errMsg(new Error('boom'))).toBe('boom')
    expect(errMsg('text')).toBe('text')
    expect(errMsg({ message: 'from object' })).toBe('from object')
    expect(errMsg({ code: 'X' })).toBe('{"code":"X"}')
    expect(errMsg(null)).toBe('')
    expect(errMsg(undefined)).toBe('')
  })

  it('returns data and maps a service error to ApiError with its code, message and details', async () => {
    install(async (s) => (s === 'ok' ? { ok: true, data: 7 } : { ok: false, error: { code: 'CONFLICT', message: 'Already exists', details: { id: 1 } } }))
    expect(await call('ok', 'm')).toBe(7)
    const e = await call('bad', 'm').catch((x: unknown) => x)
    expect(e).toBeInstanceOf(ApiError)
    expect(e).toMatchObject({ code: 'CONFLICT', message: 'Already exists', details: { id: 1 } })
  })

  it('a failing bridge (IPC rejection) is still an ApiError in plain words', async () => {
    install(async () => { throw new Error("Error invoking remote method 'svc:call': Error: No handler registered for 'svc:call'") })
    const e = (await call('x', 'y').catch((x: unknown) => x)) as ApiError
    expect(e).toBeInstanceOf(ApiError)
    expect(e.code).toBe('INTERNAL')
    expect(e.message).toMatch(/did not answer/)
    expect(e.message).not.toMatch(/Error invoking remote method/)

    install(async () => { throw new Error('An object could not be cloned.') })
    expect(((await call('x', 'y').catch((x: unknown) => x)) as ApiError).message).toMatch(/could not read/)
  })

  it('an error without a message still shows something readable', async () => {
    install(async () => ({ ok: false, error: { code: 'INTERNAL', message: '' } }))
    expect(((await call('x', 'y').catch((x: unknown) => x)) as ApiError).message).toBe('Something went wrong. Please try again.')
    install(async () => undefined)
    expect(((await call('x', 'y').catch((x: unknown) => x)) as ApiError).message).toMatch(/did not answer/)
  })

  it('announces a refused call so the lock screen shows at once (but not for a wrong password)', async () => {
    const seen = vi.fn((e: Event) => { void e; return true })
    install(async () => ({ ok: false, error: { code: 'UNAUTHENTICATED', message: 'Please sign in' } }), seen)
    await call('pos', 'scan', { code: '1' }).catch(() => undefined)
    expect(seen).toHaveBeenCalledTimes(1)
    expect(seen.mock.calls[0][0].type).toBe(UNAUTHENTICATED_EVENT)
    await call('auth', 'login', { username: 'a', password: 'b' }).catch(() => undefined)
    await call('auth', 'verifyApprover', {}).catch(() => undefined)
    expect(seen).toHaveBeenCalledTimes(1)
  })
})

import type { IpcResult, AppErrorCode } from '@shared/ipc'

declare global {
  interface Window {
    velmayil: {
      call: (service: string, method: string, args?: unknown) => Promise<IpcResult>
      onChange?: (cb: (events: { service: string; method: string; ts: number }[]) => void) => () => void
    }
  }
}

export class ApiError extends Error {
  constructor(public code: AppErrorCode, message: string, public details?: unknown) {
    super(message)
  }
}

/** Fired on window when a service call was refused because the session is locked or gone (the lock screen listens). */
export const UNAUTHENTICATED_EVENT = 'velmayil:unauthenticated'

/** Call a main-process service: call<Product[]>('catalog', 'list', { search }). Throws ApiError on failure. */
export async function call<T = unknown>(service: string, method: string, args?: unknown): Promise<T> {
  let res: IpcResult
  try {
    res = await window.velmayil.call(service, method, args)
  } catch (e) {
    // the bridge itself failed (main process busy/closing, or a value that cannot be sent): still an ApiError with plain words
    const raw = e instanceof Error ? e.message : String(e)
    throw new ApiError('INTERNAL', /could not be cloned/i.test(raw) ? 'This screen sent data the application could not read. Please try again.' : `The application did not answer (${raw.replace(/^Error invoking remote method '[^']*':\s*/, '')}). Please try again.`)
  }
  if (!res || typeof res !== 'object') throw new ApiError('INTERNAL', 'The application did not answer. Please try again.')
  if (!res.ok) {
    const err = res.error ?? { code: 'INTERNAL' as AppErrorCode, message: '' }
    if (err.code === 'UNAUTHENTICATED' && !(service === 'auth' && (method === 'login' || method === 'changePassword' || method === 'setPin' || method === 'clearPin' || method === 'verifyApprover' || method === 'requestApproval'))) {
      try { window.dispatchEvent(new Event(UNAUTHENTICATED_EVENT)) } catch { /* no window (tests) */ }
    }
    throw new ApiError(err.code, errMsg(err.message) || 'Something went wrong. Please try again.', err.details)
  }
  return res.data as T
}

/** Text of any thrown value. Objects never become "[object Object]". */
export const errMsg = (e: unknown): string => {
  if (e instanceof Error) return e.message
  if (typeof e === 'string') return e
  if (e == null) return ''
  if (typeof e === 'object') {
    const m = (e as { message?: unknown; error?: unknown }).message ?? (e as { error?: unknown }).error
    if (typeof m === 'string' && m) return m
    try { return JSON.stringify(e) } catch { return 'Unexpected error' }
  }
  return String(e)
}

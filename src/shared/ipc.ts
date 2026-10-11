/** Single generic IPC channel. Renderer calls services by name; no per-feature channel lists. */
export const IPC_CHANNEL = 'svc:call'
/** Main -> renderer push channel: payload is ChangeEvent[] ({service, method, ts}) after data changed. */
export const LIVE_CHANNEL = 'live:change'

export type AppErrorCode =
  | 'VALIDATION' | 'NOT_FOUND' | 'FORBIDDEN' | 'UNAUTHENTICATED' | 'CONFLICT'
  | 'APPROVAL_REQUIRED' | 'INSUFFICIENT_STOCK' | 'PRINT_FAILED' | 'INTERNAL'

export interface AppErrorShape { code: AppErrorCode; message: string; details?: unknown }
export type IpcResult<T = unknown> = { ok: true; data: T } | { ok: false; error: AppErrorShape }

export class AppError extends Error {
  constructor(public code: AppErrorCode, message: string, public details?: unknown) {
    super(message)
    this.name = 'AppError'
  }
}

export interface SessionInfo {
  userId: number
  username: string
  name: string
  role: string
  permissions: string[]
  posId: number
  posCode: string
}

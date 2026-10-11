export interface SyncServerOptions {
  apiKey: string
  file?: string
  maxBodyBytes?: number
  name?: string
}
export interface SyncServerHandle {
  server: import('node:http').Server
  state: () => { seq: number; changes: unknown[]; seen: Record<string, number>; devices: Record<string, unknown> }
  listen: (port?: number, host?: string) => Promise<{ port: number; url: string }>
  close: () => Promise<void>
}
export function createSyncServer(opts: SyncServerOptions): SyncServerHandle

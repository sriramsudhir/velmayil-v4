import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNEL, LIVE_CHANNEL } from '@shared/ipc'

contextBridge.exposeInMainWorld('velmayil', {
  call: (service: string, method: string, args?: unknown) => ipcRenderer.invoke(IPC_CHANNEL, service, method, args),
  /** Subscribe to data-change pushes. Returns an unsubscribe function. */
  onChange: (cb: (events: { service: string; method: string; ts: number }[]) => void) => {
    const h = (_e: unknown, events: { service: string; method: string; ts: number }[]) => cb(events)
    ipcRenderer.on(LIVE_CHANNEL, h)
    return () => void ipcRenderer.removeListener(LIVE_CHANNEL, h)
  }
})

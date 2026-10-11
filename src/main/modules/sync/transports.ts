import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Change, PullResult, PushResult, SyncTransport } from './protocol'

const pad = (n: number) => String(n).padStart(12, '0')

/**
 * Zero-server transport: every terminal appends immutable batch files to a shared folder (network share / OneDrive /
 * Dropbox / USB):  <folder>/changes/<deviceUuid>/<firstQid>-<lastQid>.json . Each terminal only ever writes its own
 * sub-folder (no write conflicts for the sync tools to resolve) and reads the others, remembering the last file per device.
 */
export class FolderTransport implements SyncTransport {
  readonly kind = 'folder' as const
  constructor(private folder: string) {}

  private root(): string {
    return join(this.folder, 'changes')
  }

  async ping() {
    if (!this.folder) throw new Error('Sync folder is not configured')
    mkdirSync(this.root(), { recursive: true })
    if (!statSync(this.root()).isDirectory()) throw new Error('Sync folder is not a directory')
    return { ok: true as const, detail: this.folder }
  }

  async push(device: { uuid: string }, changes: Change[]): Promise<PushResult> {
    if (!changes.length) return { accepted: [], rejected: [] }
    const dir = join(this.root(), device.uuid)
    mkdirSync(dir, { recursive: true })
    const qids = changes.map((c) => c.qid)
    const name = `${pad(Math.min(...qids))}-${pad(Math.max(...qids))}.json`
    const tmp = join(dir, name + '.tmp')
    writeFileSync(tmp, JSON.stringify({ device: device.uuid, changes }), 'utf8')
    renameSync(tmp, join(dir, name)) // atomic: readers never see half-written batches
    return { accepted: qids, rejected: [] }
  }

  async pull(device: { uuid: string }, cursor: string | null, limit: number): Promise<PullResult> {
    const cur: Record<string, string> = cursor ? JSON.parse(cursor) : {}
    const root = this.root()
    if (!existsSync(root)) return { changes: [], cursor: JSON.stringify(cur), more: false }
    const out: PullResult['changes'] = []
    let more = false
    for (const dev of readdirSync(root).sort()) {
      if (dev === device.uuid) continue
      const dir = join(root, dev)
      let files: string[]
      try {
        files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
      } catch {
        continue
      }
      for (const f of files) {
        if (cur[dev] && f <= cur[dev]) continue
        if (out.length >= limit) {
          more = true
          break
        }
        let batch: { changes: Change[] }
        try {
          batch = JSON.parse(readFileSync(join(dir, f), 'utf8'))
        } catch {
          // a half-synced file (cloud client still uploading): stop here for this device, retry next cycle
          break
        }
        for (const c of batch.changes) out.push(c)
        cur[dev] = f
      }
    }
    return { changes: out, cursor: JSON.stringify(cur), more }
  }
}

export class HttpTransport implements SyncTransport {
  readonly kind = 'http' as const
  constructor(private url: string, private key: string, private timeoutMs = 15_000) {}

  private async req<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    if (!this.url) throw new Error('Sync server URL is not configured')
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), this.timeoutMs)
    try {
      const res = await fetch(this.url.replace(/\/+$/, '') + path, {
        method,
        headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctl.signal
      })
      if (res.status === 401 || res.status === 403) throw new Error('Sync server rejected the API key')
      if (!res.ok) throw new Error(`Sync server error ${res.status}: ${(await res.text()).slice(0, 200)}`)
      return (await res.json()) as T
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw new Error('Sync server timed out')
      throw e
    } finally {
      clearTimeout(t)
    }
  }

  async ping() {
    const r = await this.req<{ ok: boolean; name?: string }>('GET', '/status')
    return { ok: true as const, detail: r.name }
  }

  push(device: { uuid: string; code: string; name: string }, changes: Change[]): Promise<PushResult> {
    return this.req<PushResult>('POST', '/push', { device: device.uuid, deviceCode: device.code, deviceName: device.name, changes })
  }

  pull(device: { uuid: string }, cursor: string | null, limit: number): Promise<PullResult> {
    const q = new URLSearchParams({ since: cursor ?? '0', device: device.uuid, limit: String(limit) })
    return this.req<PullResult>('GET', '/pull?' + q.toString())
  }
}

export interface TransportConfig {
  transport: 'http' | 'folder'
  url: string
  folder: string
  key: string
}

export function makeTransport(c: TransportConfig): SyncTransport {
  return c.transport === 'folder' ? new FolderTransport(c.folder) : new HttpTransport(c.url, c.key)
}

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Change, PullResult, PushResult, SyncTransport } from './protocol'
import type { SyncHub } from './hub'

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
    let cur: Record<string, string> = {}
    try {
      const j: unknown = cursor ? JSON.parse(cursor) : {}
      if (j && typeof j === 'object') cur = j as Record<string, string>
    } catch {
      /* cursor of another transport (this terminal used a server before): start over, receivers are idempotent */
    }
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

/** The remote understood us but refuses: wrong pairing code / API key. Retrying quickly cannot help. */
export class SyncAuthError extends Error {}
/** This terminal is a copy of the Admin system (same terminal uuid). */
export class SyncIdentityError extends Error {}

export interface HttpOptions {
  timeoutMs?: number
  /** talking to the Admin system on the LAN: problems are worded for the shop owner */
  lan?: boolean
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** Turn a low-level network failure into a sentence that says what to check. */
export function explainNetworkError(e: unknown, url: string, lan: boolean): Error {
  const err = e as Error & { cause?: { code?: string; message?: string }; code?: string }
  if (err instanceof SyncAuthError || err instanceof SyncIdentityError) return err
  const code = err.cause?.code ?? err.code ?? ''
  const who = lan ? `the Admin system at ${hostOf(url)}` : `the sync server at ${hostOf(url)}`
  if (err.name === 'AbortError' || err.name === 'TimeoutError' || /TIMEOUT|ETIMEDOUT/i.test(code)) {
    return new Error(
      lan
        ? `No answer from ${who}. Check that the LAN cable is plugged in at both ends, that Velmayil POS is open on the Admin laptop, and that Windows Firewall on the Admin laptop allows Velmayil POS.`
        : 'Sync server timed out'
    )
  }
  if (code === 'ECONNREFUSED') {
    return new Error(
      lan
        ? `The Admin laptop was found at ${hostOf(url)}, but Velmayil POS is not accepting connections there. Open Velmayil POS on the Admin laptop, check it is set as the Admin system, and that the port number matches.`
        : `Sync server refused the connection (${hostOf(url)})`
    )
  }
  if (/EHOSTUNREACH|ENETUNREACH|EADDRNOTAVAIL|ENOTFOUND|EAI_AGAIN|ECONNRESET|EPIPE|UND_ERR/i.test(code) || /fetch failed|terminated/i.test(err.message ?? '')) {
    return new Error(
      lan
        ? `Cannot reach ${who}. Check the LAN cable and that the address is the one shown on the Admin laptop.`
        : `Cannot reach ${who}${code ? ` (${code})` : ''}`
    )
  }
  return err
}

export class HttpTransport implements SyncTransport {
  readonly kind = 'http' as const
  private timeoutMs: number
  private lan: boolean
  constructor(private url: string, private key: string, opts: number | HttpOptions = {}) {
    const o = typeof opts === 'number' ? { timeoutMs: opts } : opts
    this.timeoutMs = o.timeoutMs ?? 15_000
    this.lan = !!o.lan
  }

  private async req<T>(
    method: 'GET' | 'POST', path: string, body?: unknown, o: { timeoutMs?: number; signal?: AbortSignal; auth?: boolean } = {}
  ): Promise<T> {
    if (!this.url) throw new Error(this.lan ? 'The address of the Admin system is not set' : 'Sync server URL is not configured')
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), o.timeoutMs ?? this.timeoutMs)
    const onOuter = () => ctl.abort()
    o.signal?.addEventListener('abort', onOuter)
    if (o.signal?.aborted) ctl.abort()
    try {
      const res = await fetch(this.url.replace(/\/+$/, '') + path, {
        method,
        headers: { ...(o.auth === false ? {} : { Authorization: `Bearer ${this.key}` }), 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctl.signal
      })
      if (res.status === 401 || res.status === 403) {
        throw new SyncAuthError(
          this.lan ? 'The Admin system was reached, but the pairing code is not correct. Type the code shown on the Admin laptop again.' : 'Sync server rejected the API key'
        )
      }
      if (res.status === 409 || res.status === 429) {
        const j = (await res.json().catch(() => ({}))) as { error?: string; message?: string }
        if (j.error === 'same_terminal') throw new SyncIdentityError(j.message ?? 'This terminal has the same identity as the Admin system')
        throw new SyncAuthError(j.message ?? `Sync server refused the request (${res.status})`)
      }
      if (!res.ok) throw Object.assign(new Error(`Sync server error ${res.status}: ${(await res.text()).slice(0, 200)}`), { status: res.status })
      return (await res.json()) as T
    } catch (e) {
      throw explainNetworkError(e, this.url, this.lan)
    } finally {
      clearTimeout(t)
      o.signal?.removeEventListener('abort', onOuter)
    }
  }

  async ping() {
    const r = await this.req<{ ok: boolean; name?: string; code?: string; role?: string; device?: string }>('GET', '/status', undefined, { timeoutMs: Math.min(this.timeoutMs, 6000) })
    return {
      ok: true as const,
      detail: r.role === 'admin' ? `Admin system ${[r.code, r.name].filter(Boolean).join(' - ')}`.trim() : r.name,
      code: r.code, name: r.name, role: r.role, device: r.device
    }
  }

  /** Is a Velmayil Admin system listening there at all? Needs no pairing code. */
  health(): Promise<{ ok: boolean; app?: string; role?: string; name?: string; code?: string }> {
    return this.req('GET', '/health', undefined, { timeoutMs: Math.min(this.timeoutMs, 5000), auth: false })
  }

  push(device: { uuid: string; code: string; name: string }, changes: Change[]): Promise<PushResult> {
    return this.req<PushResult>('POST', '/push', { device: device.uuid, deviceCode: device.code, deviceName: device.name, changes }, { timeoutMs: Math.max(this.timeoutMs, 20_000) })
  }

  pull(device: { uuid: string; code?: string; name?: string }, cursor: string | null, limit: number): Promise<PullResult> {
    const q = new URLSearchParams({ since: cursor ?? '0', device: device.uuid, limit: String(limit) })
    if (this.lan && device.code) {
      q.set('code', device.code)
      q.set('name', device.name ?? '')
    }
    return this.req<PullResult>('GET', '/pull?' + q.toString())
  }

  async wait(device: { uuid: string }, cursor: string | null, seconds: number, signal?: AbortSignal): Promise<'changed' | 'timeout' | 'unsupported'> {
    const q = new URLSearchParams({ since: cursor ?? '0', device: device.uuid, wait: String(seconds) })
    try {
      const r = await this.req<{ changed?: boolean }>('GET', '/wait?' + q.toString(), undefined, { timeoutMs: (seconds + 10) * 1000, signal })
      return r.changed ? 'changed' : 'timeout'
    } catch (e) {
      if ((e as { status?: number }).status === 404) return 'unsupported' // reference server: no long-poll
      throw e
    }
  }
}

/** The Admin system's own terminal talks to its embedded store directly: no network, so it can never be "offline". */
export class HubTransport implements SyncTransport {
  readonly kind = 'hub' as const
  constructor(private hub: SyncHub) {}
  async ping() {
    return { ok: true as const, detail: 'This computer is the Admin system' }
  }
  async push(device: { uuid: string; code: string; name: string }, changes: Change[]): Promise<PushResult> {
    const r = this.hub.push(device, changes, { admin: true })
    return { accepted: r.accepted, rejected: r.rejected }
  }
  async pull(device: { uuid: string }, cursor: string | null, limit: number): Promise<PullResult> {
    return this.hub.pull(device.uuid, cursor, limit)
  }
}

export interface TransportConfig {
  transport: 'http' | 'folder'
  url: string
  folder: string
  key: string
  /** the URL is the Admin system on the LAN (role 'client') */
  lan?: boolean
}

export function makeTransport(c: TransportConfig): SyncTransport {
  if (c.transport === 'folder') return new FolderTransport(c.folder)
  return c.lan ? new HttpTransport(c.url, c.key, { lan: true, timeoutMs: 8000 }) : new HttpTransport(c.url, c.key)
}

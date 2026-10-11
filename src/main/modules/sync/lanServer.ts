import http from 'node:http'
import { randomInt, timingSafeEqual } from 'node:crypto'
import type { SyncHub } from './hub'

/**
 * The sync server that runs INSIDE the Admin system's main process (nothing to start by hand). Same wire protocol as
 * server/sync-server.mjs, served from the SyncHub store, plus:
 *   GET /wait?since=<cursor>&device=<uuid>&wait=<seconds>  -> { changed }   long-poll: answers as soon as another terminal pushed
 *   GET /health (no pairing code)                          -> { ok, app:'velmayil-pos', role:'admin', name, code }
 * Everything else needs "Authorization: Bearer <pairing code>". All handlers are short and non-blocking; the only
 * synchronous work is one small SQLite transaction per request.
 */
export const DEFAULT_LAN_PORT = 8787
const MAX_BODY = 32 * 1024 * 1024
const MAX_WAIT_S = 55
const BAD_KEY_LIMIT = 30 // wrong pairing codes per address per minute before it is told to slow down

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no 0/O, 1/I: easy to read out and type

/** Pairing code the owner types once on the client, e.g. "K7QM-2XHD". */
export function newPairingCode(): string {
  let s = ''
  for (let i = 0; i < 8; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
  return `${s.slice(0, 4)}-${s.slice(4)}`
}
/** Codes are compared without dashes / spaces / letter case, so "k7qm 2xhd" works too. */
export const normalizeCode = (s: string): string => String(s ?? '').replace(/[\s-]+/g, '').toUpperCase()

export interface LanState {
  listening: boolean
  port: number | null
  /** plain-language reason when the server could not start */
  error: string | null
  errorCode: string | null
}

/** Why the server could not start, in words a shop owner can act on. */
export function listenProblem(e: NodeJS.ErrnoException, port: number): string {
  switch (e.code) {
    case 'EADDRINUSE':
      return `Port ${port} is already being used by another program on this computer, so the other computer cannot connect yet. ` +
        `Close that program, or choose a different port number here (for example ${port + 1}) and use the same number on the Client system.`
    case 'EACCES':
      return `Windows did not allow Velmayil v4 to open port ${port}. Choose a different port number (for example ${port < 1024 ? 8787 : port + 1}), ` +
        'or ask whoever looks after this computer whether security software is blocking it.'
    case 'EADDRNOTAVAIL':
      return 'This computer has no usable network connection right now. Plug in the LAN cable and try again.'
    default:
      return `Could not start sharing on port ${port} (${e.code ?? e.message}). Restart Velmayil v4; if it keeps happening, choose a different port number.`
  }
}

export interface LanServerOptions {
  /** current pairing code (read on every request, so a new code takes effect at once) */
  key: () => string
  /** shown to the client by "Test connection" */
  identity: () => { name: string; code: string }
}

export class LanServer {
  private server: http.Server | null = null
  private bad = new Map<string, { n: number; until: number }>()
  state: LanState = { listening: false, port: null, error: null, errorCode: null }

  constructor(private hub: SyncHub, private opts: LanServerOptions) {}

  private authorized(req: http.IncomingMessage): boolean {
    const h = String(req.headers.authorization ?? '')
    const given = Buffer.from(normalizeCode(h.startsWith('Bearer ') ? h.slice(7) : ''))
    const want = Buffer.from(normalizeCode(this.opts.key()))
    return want.length > 0 && given.length === want.length && timingSafeEqual(given, want)
  }

  private send(res: http.ServerResponse, code: number, body: unknown, raw?: string): void {
    if (res.writableEnded || res.destroyed) return
    const s = raw ?? JSON.stringify(body)
    res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(s), 'Cache-Control': 'no-store' })
    res.end(s)
  }

  private readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      let size = 0
      const parts: Buffer[] = []
      req.on('data', (c: Buffer) => {
        size += c.length
        if (size > MAX_BODY) {
          reject(Object.assign(new Error('Payload too large'), { status: 413 }))
          req.destroy()
          return
        }
        parts.push(c)
      })
      req.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(parts).toString('utf8') || '{}'))
        } catch {
          reject(Object.assign(new Error('Invalid JSON'), { status: 400 }))
        }
      })
      req.on('error', reject)
      req.on('aborted', () => reject(Object.assign(new Error('Connection lost'), { status: 400 })))
    })
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://x')
    const ip = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '')
    if (req.method === 'GET' && url.pathname === '/health') {
      return this.send(res, 200, { ok: true, app: 'velmayil-pos', role: 'admin', ...this.opts.identity() })
    }
    const now = Date.now()
    const b = this.bad.get(ip)
    if (b && b.until > now && b.n >= BAD_KEY_LIMIT) return this.send(res, 429, { error: 'too_many_attempts', message: 'Too many wrong pairing codes. Wait a minute and try again.' })
    if (!this.authorized(req)) {
      if (!b || b.until <= now) this.bad.set(ip, { n: 1, until: now + 60_000 })
      else b.n++
      return this.send(res, 401, { error: 'unauthorized' })
    }
    const q = url.searchParams
    const sameIdentity = (device: string) =>
      device === this.hub.adminDevice &&
      (this.send(res, 409, {
        error: 'same_terminal',
        message: 'This computer has the same terminal identity as the Admin system (its data was copied or restored from the Admin). ' +
          'It needs its own identity before the two can be linked.'
      }), true)

    if (req.method === 'GET' && url.pathname === '/status') {
      return this.send(res, 200, { ok: true, role: 'admin', epoch: this.hub.epoch, seq: this.hub.seq(), device: this.hub.adminDevice, devices: this.hub.devices().length, ...this.opts.identity() })
    }
    if (req.method === 'POST' && url.pathname === '/push') {
      const body = await this.readBody(req)
      if (typeof body.device !== 'string' || !body.device || !Array.isArray(body.changes)) return this.send(res, 400, { error: 'device and changes[] required' })
      if (sameIdentity(body.device)) return
      const r = this.hub.push({ uuid: body.device, code: String(body.deviceCode ?? ''), name: String(body.deviceName ?? '') }, body.changes, { address: ip })
      return this.send(res, 200, r)
    }
    if (req.method === 'GET' && url.pathname === '/pull') {
      const device = q.get('device') ?? ''
      if (sameIdentity(device)) return
      const r = this.hub.pullRaw(device, q.get('since'), Number(q.get('limit') ?? 200) || 200, { address: ip, code: (q.get('code') ?? '').slice(0, 40), name: (q.get('name') ?? '').slice(0, 80) })
      return this.send(res, 200, null, `{"changes":[${r.items.join(',')}],"cursor":${JSON.stringify(r.cursor)},"more":${r.more}}`)
    }
    if (req.method === 'GET' && url.pathname === '/wait') {
      const device = q.get('device') ?? ''
      if (sameIdentity(device)) return
      const secs = Math.min(MAX_WAIT_S, Math.max(0, Number(q.get('wait') ?? 25) || 0))
      const w = this.hub.wait(device, q.get('since'), secs * 1000)
      res.on('close', w.cancel) // the client went away (cable pulled, app closed): stop waiting for it
      const changed = await w.promise
      return this.send(res, 200, { changed })
    }
    return this.send(res, 404, { error: 'not found' })
  }

  /** Start listening for clients. Never rejects: a failure is described in the returned state. */
  start(port: number, host = '0.0.0.0'): Promise<LanState> {
    return this.stop().then(
      () =>
        new Promise<LanState>((resolve) => {
          const server = http.createServer((req, res) => {
            this.handle(req, res).catch((e: Error & { status?: number }) => this.send(res, e.status ?? 500, { error: e.message }))
          })
          server.keepAliveTimeout = 65_000
          server.on('clientError', (_e, socket) => socket.destroy())
          server.once('error', (e: NodeJS.ErrnoException) => {
            this.state = { listening: false, port, error: listenProblem(e, port), errorCode: e.code ?? 'ERROR' }
            resolve(this.state)
          })
          server.listen(port, host, () => {
            this.server = server
            const a = server.address()
            this.state = { listening: true, port: typeof a === 'object' && a ? a.port : port, error: null, errorCode: null }
            server.on('error', () => undefined) // later socket-level errors must never crash the POS
            resolve(this.state)
          })
        })
    )
  }

  stop(): Promise<void> {
    const s = this.server
    this.server = null
    this.state = { listening: false, port: null, error: null, errorCode: null }
    if (!s) return Promise.resolve()
    this.hub.releaseWaiters()
    return new Promise((resolve) => {
      s.close(() => resolve())
      s.closeAllConnections?.()
    })
  }
}

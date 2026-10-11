#!/usr/bin/env node
/**
 * Velmayil reference sync server (plain Node ESM, zero dependencies).
 *
 *   node server/sync-server.mjs --port 8787 --key <secret> [--file sync-data.json] [--host 0.0.0.0]
 *   (or env SYNC_API_KEY / SYNC_PORT / SYNC_FILE)
 *
 * Protocol (JSON, "Authorization: Bearer <key>" on everything except /health):
 *   POST /push   { device, deviceCode, deviceName, changes:[{device,qid,entity,entityUuid,op,createdAt,payload,...}] }
 *                -> { accepted:[qid...], rejected:[{qid,error}], seq }       (idempotent: dedupe by (device, qid))
 *   GET  /pull?since=<cursor>&device=<uuid>&limit=<n>
 *                -> { changes:[{seq,...change}], cursor:"<seq>", more:bool } (never returns the caller's own changes)
 *   GET  /status -> { ok, name, seq, devices }       GET /devices -> per-terminal push/pull cursors      GET /health
 *
 * Store: in memory, optionally mirrored to a JSON file (atomic write). This is a REFERENCE implementation for LAN use
 * and tests; put it behind TLS (reverse proxy) before exposing it to the internet.
 */
import http from 'node:http'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { timingSafeEqual } from 'node:crypto'
import { pathToFileURL } from 'node:url'

export function createSyncServer(opts = {}) {
  const apiKey = opts.apiKey
  if (!apiKey) throw new Error('apiKey is required')
  const maxBody = opts.maxBodyBytes ?? 32 * 1024 * 1024
  const file = opts.file
  const name = opts.name ?? 'Velmayil reference sync server'

  /** @type {{seq:number, changes:any[], seen:Record<string,number>, devices:Record<string,any>}} */
  let state = { seq: 0, changes: [], seen: {}, devices: {} }
  if (file && existsSync(file)) {
    try {
      state = JSON.parse(readFileSync(file, 'utf8'))
    } catch (e) {
      throw new Error(`Cannot read store ${file}: ${e.message}`)
    }
  }
  let dirty = false
  let timer
  const persist = () => {
    if (!file || !dirty) return
    dirty = false
    const tmp = file + '.tmp'
    writeFileSync(tmp, JSON.stringify(state))
    renameSync(tmp, file)
  }
  const markDirty = () => {
    dirty = true
    if (!file || timer) return
    timer = setTimeout(() => {
      timer = undefined
      persist()
    }, 200)
    timer.unref?.()
  }

  const keyBuf = Buffer.from(apiKey)
  const authorized = (req) => {
    const h = String(req.headers.authorization ?? '')
    const given = Buffer.from(h.startsWith('Bearer ') ? h.slice(7) : '')
    return given.length === keyBuf.length && timingSafeEqual(given, keyBuf)
  }
  const send = (res, code, body) => {
    const s = JSON.stringify(body)
    res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(s) })
    res.end(s)
  }
  const readBody = (req) =>
    new Promise((resolve, reject) => {
      let size = 0
      const parts = []
      req.on('data', (c) => {
        size += c.length
        if (size > maxBody) {
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
    })

  const touch = (uuid, patch) => {
    const d = (state.devices[uuid] ??= { device: uuid, code: '', name: '', firstSeen: Date.now(), lastPushAt: null, lastPullAt: null, pushed: 0, cursor: 0 })
    Object.assign(d, patch)
    return d
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://x')
      if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true })
      if (!authorized(req)) return send(res, 401, { error: 'unauthorized' })

      if (req.method === 'GET' && url.pathname === '/status') {
        return send(res, 200, { ok: true, name, seq: state.seq, devices: Object.keys(state.devices).length })
      }
      if (req.method === 'GET' && url.pathname === '/devices') return send(res, 200, { devices: Object.values(state.devices) })

      if (req.method === 'POST' && url.pathname === '/push') {
        const body = await readBody(req)
        if (typeof body.device !== 'string' || !body.device || !Array.isArray(body.changes)) return send(res, 400, { error: 'device and changes[] required' })
        const accepted = []
        const rejected = []
        for (const c of body.changes) {
          if (!c || c.device !== body.device || !Number.isInteger(c.qid) || typeof c.entity !== 'string' || typeof c.payload !== 'object' || c.payload === null) {
            rejected.push({ qid: c?.qid ?? -1, error: 'malformed change' })
            continue
          }
          const k = `${c.device}:${c.qid}`
          if (state.seen[k] === undefined) {
            state.seq += 1
            state.seen[k] = state.seq
            state.changes.push({ ...c, seq: state.seq })
          }
          accepted.push(c.qid)
        }
        touch(body.device, { code: body.deviceCode ?? '', name: body.deviceName ?? '', lastPushAt: Date.now() }).pushed += accepted.length
        markDirty()
        return send(res, 200, { accepted, rejected, seq: state.seq })
      }

      if (req.method === 'GET' && url.pathname === '/pull') {
        const since = Number(url.searchParams.get('since') ?? 0) || 0
        const device = url.searchParams.get('device') ?? ''
        const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit') ?? 200) || 200))
        const out = []
        let cursor = since
        let more = false
        // changes are stored in seq order; binary search the first seq > since
        let lo = 0
        let hi = state.changes.length
        while (lo < hi) {
          const mid = (lo + hi) >> 1
          if (state.changes[mid].seq > since) hi = mid
          else lo = mid + 1
        }
        for (let i = lo; i < state.changes.length; i++) {
          const c = state.changes[i]
          if (out.length >= limit) {
            more = true
            break
          }
          cursor = c.seq
          if (c.device !== device) out.push(c)
        }
        if (device) {
          touch(device, { lastPullAt: Date.now(), cursor })
          markDirty()
        }
        return send(res, 200, { changes: out, cursor: String(cursor), more })
      }
      return send(res, 404, { error: 'not found' })
    } catch (e) {
      return send(res, e.status ?? 500, { error: e.message })
    }
  })

  return {
    server,
    state: () => state,
    listen: (port = 0, host = '127.0.0.1') =>
      new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, host, () => {
          const addr = server.address()
          resolve({ port: addr.port, url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${addr.port}` })
        })
      }),
    close: () =>
      new Promise((resolve) => {
        if (timer) clearTimeout(timer)
        persist()
        server.closeAllConnections?.()
        server.close(() => resolve())
      })
  }
}

// ---- CLI ----
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (n, d) => {
    const i = process.argv.indexOf('--' + n)
    return i > 0 ? process.argv[i + 1] : d
  }
  const key = arg('key', process.env.SYNC_API_KEY)
  if (!key) {
    console.error('Usage: node server/sync-server.mjs --key <secret> [--port 8787] [--host 0.0.0.0] [--file sync-data.json]')
    process.exit(1)
  }
  const s = createSyncServer({ apiKey: key, file: arg('file', process.env.SYNC_FILE) })
  const { url } = await s.listen(Number(arg('port', process.env.SYNC_PORT ?? 8787)), arg('host', '127.0.0.1'))
  console.log(`Velmayil sync server listening on ${url}`)
  process.on('SIGINT', async () => {
    await s.close()
    process.exit(0)
  })
}

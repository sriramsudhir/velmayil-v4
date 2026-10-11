import { Worker } from 'node:worker_threads'
import type { Manifest } from './engine'

/**
 * The heavy half of a backup (VACUUM INTO, schema/row counts, SHA-256, integrity + FK check, rename, manifest, second
 * copy) runs in a worker thread so the main process keeps answering IPC while an 80+ MB database is being backed up
 * (synchronously this froze the whole app for 6-8 s). The worker opens its OWN read-only connection to the live file
 * (WAL readers never block the writer), so the result is still a transactionally consistent snapshot.
 *
 * The worker source is a plain string (CommonJS, built-ins only) so it works unchanged in the electron-vite bundle,
 * in dev and under vitest, with no extra build entry.
 */
export interface SnapshotJob {
  dbPath: string
  partial: string
  final: string
  manifestPath: string
  copyFolder: string
  kind: string
  pos: string
  appVersion: string
  now: number
}
export interface SnapshotOutcome {
  manifest: Manifest
  ok: boolean
  problems: string[]
  copiedTo?: string
  warnings: string[]
}

const WORKER_SOURCE = `
const { parentPort, workerData: j } = require('node:worker_threads')
const { DatabaseSync } = require('node:sqlite')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const q = (n) => '"' + n.replace(/"/g, '""') + '"'
function sha(file) {
  const h = crypto.createHash('sha256'); const fd = fs.openSync(file, 'r'); const buf = Buffer.allocUnsafe(1 << 20)
  try { for (;;) { const n = fs.readSync(fd, buf, 0, buf.length, null); if (n <= 0) break; h.update(buf.subarray(0, n)) } } finally { fs.closeSync(fd) }
  return h.digest('hex')
}
function run() {
  const problems = [], warnings = []
  let live = new DatabaseSync(j.dbPath, { readOnly: true })
  try { live.exec('PRAGMA busy_timeout = 10000'); live.prepare('VACUUM INTO ?').run(j.partial) } finally { live.close() }
  let d = new DatabaseSync(j.partial)
  try { d.exec('PRAGMA journal_mode = DELETE') } finally { d.close() }
  d = new DatabaseSync(j.partial, { readOnly: true })
  let tables = {}, schemaVersion = 0, schemaCount = 0
  try {
    const s = d.prepare('SELECT COALESCE(MAX(version),0) AS m, COUNT(*) AS c FROM schema_migrations').get()
    schemaVersion = Number(s.m); schemaCount = Number(s.c)
    for (const t of d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all())
      tables[t.name] = Number(d.prepare('SELECT COUNT(*) AS c FROM ' + q(t.name)).get().c)
    const ic = d.prepare('PRAGMA integrity_check').all()
    if (!(ic.length === 1 && ic[0].integrity_check === 'ok')) problems.push('integrity_check failed: ' + ic.slice(0, 3).map((r) => r.integrity_check).join('; '))
    const fk = d.prepare('PRAGMA foreign_key_check').all()
    if (fk.length) problems.push('foreign_key_check found ' + fk.length + ' violation(s)')
  } finally { d.close() }
  const sizeBytes = fs.statSync(j.partial).size
  const sha256 = sha(j.partial)
  const manifest = { format: 1, app: 'velmayil-pos', appVersion: j.appVersion, createdAt: j.now, kind: j.kind, posCode: j.pos, schemaVersion, schemaCount, sizeBytes, sha256, tables }
  fs.renameSync(j.partial, j.final)
  const tmp = j.manifestPath + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2), 'utf8'); fs.renameSync(tmp, j.manifestPath)
  if (fs.statSync(j.final).size !== sizeBytes) problems.push('Size mismatch after rename')
  let copiedTo
  if (j.copyFolder) {
    try {
      fs.mkdirSync(j.copyFolder, { recursive: true })
      const dest = path.join(j.copyFolder, path.basename(j.final))
      fs.copyFileSync(j.final, dest); fs.copyFileSync(j.manifestPath, dest + '.json')
      if (sha(dest) !== sha256) throw new Error('copy hash mismatch')
      copiedTo = dest
    } catch (e) { warnings.push('Second copy to "' + j.copyFolder + '" failed: ' + e.message) }
  }
  return { manifest, ok: problems.length === 0, problems, copiedTo, warnings }
}
try { parentPort.postMessage({ ok: true, value: run() }) }
catch (e) { try { fs.rmSync(j.partial, { force: true }) } catch {} parentPort.postMessage({ ok: false, error: String(e && e.message || e) }) }
`

/** Run one snapshot in a worker thread. Rejects if the worker itself fails (the partial file is removed). */
export function runSnapshotInWorker(job: SnapshotJob): Promise<SnapshotOutcome> {
  return new Promise((resolve, reject) => {
    const w = new Worker(WORKER_SOURCE, { eval: true, workerData: job })
    let settled = false
    const done = (fn: () => void) => {
      if (settled) return
      settled = true
      fn()
    }
    w.once('message', (m: { ok: true; value: SnapshotOutcome } | { ok: false; error: string }) =>
      done(() => (m.ok ? resolve(m.value) : reject(new Error(m.error))))
    )
    w.once('error', (e) => done(() => reject(e)))
    w.once('exit', (code) => done(() => reject(new Error(`Backup worker exited unexpectedly (code ${code})`))))
  })
}

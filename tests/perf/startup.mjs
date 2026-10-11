/**
 * Cold-start timing of the BUILT app (out/): launch -> login form visible, N times, on a copy of a seeded data dir.
 *   node tests/perf/startup.mjs <seeded-data-dir> [runs=5]
 */
import { _electron as electron } from '@playwright/test'
import { cpSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..', '..')
const src = process.argv[2]
const runs = Number(process.argv[3] ?? 5)
if (!src) throw new Error('usage: node tests/perf/startup.mjs <seeded-data-dir> [runs]')
const env = {}
for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v

const toLogin = []
const mainReady = []
for (let i = 0; i < runs; i++) {
  const dir = mkdtempSync(join(tmpdir(), 'velmayil-start-'))
  cpSync(src, dir, { recursive: true })
  env.VELMAYIL_DATA_DIR = dir
  const t0 = Date.now()
  const app = await electron.launch({ args: [ROOT, `--user-data-dir=${join(dir, 'chromium-profile')}`], cwd: ROOT, env })
  const page = await app.firstWindow()
  mainReady.push(Date.now() - t0)
  await page.waitForSelector('input[type=password]', { timeout: 60000 })
  toLogin.push(Date.now() - t0)
  await app.close()
}
const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]
console.log(JSON.stringify({ runs, windowMs: { min: Math.min(...mainReady), median: med(mainReady) }, loginFormMs: { min: Math.min(...toLogin), median: med(toLogin), all: toLogin } }))

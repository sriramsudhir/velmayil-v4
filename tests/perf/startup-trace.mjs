/**
 * Where does the MAIN process spend its startup? Loads tests/perf/startup-hook.cjs with `electron -r`, which logs every
 * top-level require() slower than 15 ms and the app-ready / window-created times.
 *   node tests/perf/startup-trace.mjs <seeded-data-dir>
 * (login-form times include ~2 s of Playwright launch overhead: compare runs with each other, not with a stopwatch.)
 */
import { _electron as electron } from '@playwright/test'
import { cpSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
const ROOT = resolve(import.meta.dirname, '..', '..')
const dir = mkdtempSync(join(tmpdir(), 'velmayil-hook-'))
cpSync(process.argv[2], dir, { recursive: true })
const env = {}
for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v
env.VELMAYIL_DATA_DIR = dir
env.HOOK_OUT = join(dir, 'hook.txt')
const t0 = Date.now()
const app = await electron.launch({ args: ['-r', join(ROOT, 'tests', 'perf', 'startup-hook.cjs'), ROOT, `--user-data-dir=${join(dir, 'chromium-profile')}`], cwd: ROOT, env })
const page = await app.firstWindow()
await page.waitForSelector('input[type=password]', { timeout: 60000 })
console.log('login form after', Date.now() - t0, 'ms')
console.log('main uptime', await app.evaluate(() => Math.round(process.uptime() * 1000)))
await app.close()
console.log(await (await import('node:fs/promises')).readFile(env.HOOK_OUT, 'utf8'))

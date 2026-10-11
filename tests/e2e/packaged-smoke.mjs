// Smoke test of the PACKAGED app (release/win-unpacked). Run: node tests/e2e/packaged-smoke.mjs
import { _electron as electron } from '@playwright/test'
import { mkdtempSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

delete process.env.ELECTRON_RUN_AS_NODE
const dir = mkdtempSync(join(tmpdir(), 'velmayil-pkg-'))
const app = await electron.launch({
  executablePath: join(process.cwd(), 'release', 'win-unpacked', 'Velmayil POS.exe'),
  args: ['--user-data-dir=' + join(dir, 'chromium')],
  env: { ...process.env, VELMAYIL_DATA_DIR: dir }
})
const errors = []
app.process().stderr?.on('data', (d) => errors.push(String(d)))
const page = await app.firstWindow()
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))
await page.waitForLoadState('domcontentloaded')
await page.getByText(/first-time setup|set up|shop/i).first().waitFor({ timeout: 20000 })
const info = await page.evaluate(() => window.velmayil.call('app', 'info'))
console.log('app.info =>', JSON.stringify(info))
await page.screenshot({ path: join(dir, 'setup.png') })
await app.close()
const db = join(dir, 'velmayil.db')
console.log('db exists:', existsSync(db), 'size:', existsSync(db) ? statSync(db).size : 0)
console.log('errors:', JSON.stringify(errors.filter((e) => !/Gtk|dbus|DevTools/i.test(e)).map((e) => e.slice(0, 300))))
console.log('screenshot:', join(dir, 'setup.png'))

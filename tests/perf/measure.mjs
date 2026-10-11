/**
 * Measures the BUILT app on a seeded dataset (see tests/perf/seed.ts).
 *   node tests/perf/measure.mjs <seeded-data-dir> [out.json]
 * Reports: startup (launch -> login form -> dashboard), page render time per route (+ long tasks), IPC latency + payload
 * size of every list/get/summary service method, and a main-process event-loop-lag trace taken while idle on the dashboard.
 * The dataset dir is COPIED first so the seeded original stays pristine.
 */
import { _electron as electron } from '@playwright/test'
import { cpSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..', '..')
const src = process.argv[2]
const outFile = process.argv[3]
if (!src) throw new Error('usage: node tests/perf/measure.mjs <seeded-data-dir> [out.json]')
const dir = mkdtempSync(join(tmpdir(), 'velmayil-perf-run-'))
cpSync(src, dir, { recursive: true })

const env = {}
for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v
env.VELMAYIL_DATA_DIR = dir

const result = { startup: {}, pages: {}, ipc: [], loop: {} }
const t0 = Date.now()
const app = await electron.launch({ args: [ROOT, `--user-data-dir=${join(dir, 'chromium-profile')}`], cwd: ROOT, env })
const page = await app.firstWindow()
await page.addInitScript(() => {
  window.__long = []
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push({ at: Math.round(e.startTime), dur: Math.round(e.duration) }) }).observe({ entryTypes: ['longtask'] })
  } catch { /* ignore */ }
})
await page.reload()
await page.waitForSelector('input[type=password]', { timeout: 60000 })
result.startup.launchToLoginMs = Date.now() - t0
result.startup.mainUptimeAtLoginMs = await app.evaluate(() => Math.round(process.uptime() * 1000))
result.startup.paint = await page.evaluate(() => Object.fromEntries(performance.getEntriesByType('paint').map((p) => [p.name, Math.round(p.startTime)])))
result.startup.domContentLoaded = await page.evaluate(() => Math.round(performance.getEntriesByType('navigation')[0].domContentLoadedEventEnd))
result.startup.scriptBytes = await page.evaluate(() => performance.getEntriesByType('resource').filter((r) => /\.js/.test(r.name)).reduce((a, r) => a + (r.encodedBodySize || r.decodedBodySize || 0), 0))

const call = (service, method, args) => page.evaluate(async ([s, m, a]) => {
  const t = performance.now()
  const r = await window.velmayil.call(s, m, a)
  const ms = performance.now() - t
  return { ok: r.ok, ms, bytes: r.ok ? JSON.stringify(r.data ?? null).length : 0, err: r.ok ? '' : `${r.error.code}: ${r.error.message}`, data: undefined }
}, [service, method, args ?? {}])

// login through the real UI
const tl = Date.now()
await page.fill('input[autocomplete=username], input[name=username], input[type=text]', 'owner')
await page.fill('input[type=password]', 'perf-pass-1')
await page.keyboard.press('Enter')
await page.waitForSelector('nav[aria-label=Main]', { timeout: 60000 })
result.startup.loginToShellMs = Date.now() - tl
await page.waitForFunction(() => document.querySelector('.kpi-grid') && !document.querySelector('.kpi-grid [class*=skeleton]'), null, { timeout: 60000 })
result.startup.loginToDashboardMs = Date.now() - tl

// main-process loop lag sampler (runs inside the Electron main process)
await app.evaluate(() => {
  const g = globalThis
  g.__lag = { max: 0, over50: 0, over100: 0, samples: 0 }
  let last = Date.now()
  g.__lagTimer = setInterval(() => {
    const now = Date.now()
    const lag = now - last - 10
    last = now
    g.__lag.samples++
    if (lag > g.__lag.max) g.__lag.max = lag
    if (lag > 50) g.__lag.over50++
    if (lag > 100) g.__lag.over100++
  }, 10)
})
const lagReset = () => app.evaluate(() => { globalThis.__lag = { max: 0, over50: 0, over100: 0, samples: 0 } })
const lagRead = () => app.evaluate(() => ({ ...globalThis.__lag }))

// main-side wrapper around the IPC handler: counts every call + main-process duration (sync work shows up here)
await app.evaluate(({ ipcMain }) => {
  const g = globalThis
  g.__ipc = []
  const h = ipcMain._invokeHandlers.get('svc:call')
  ipcMain._invokeHandlers.set('svc:call', async (e, s, m, a) => {
    const t = performance.now()
    try { return await h(e, s, m, a) } finally { g.__ipc.push([`${s}.${m}`, performance.now() - t]) }
  })
})
const ipcTake = () => app.evaluate(() => { const r = globalThis.__ipc; globalThis.__ipc = []; return r })

// ---- page render times (hash navigation, settle = no DOM mutation for 150 ms and no skeleton/spinner)
const ROUTES = ['/dashboard', '/products', '/pos', '/pos/history', '/inventory', '/inventory/low-stock', '/inventory/purchases', '/inventory/suppliers', '/inventory/adjustments', '/inventory/counts', '/reports', '/reports/sales_summary', '/reports/sales_detail', '/reports/item_sales', '/reports/tax_register', '/inventory/counts/1', '/settings', '/settings/shop', '/users', '/backup', '/printing']
async function renderTime(route) {
  await page.evaluate(() => { window.location.hash = '#/settings'; })
  await page.waitForTimeout(200)
  await page.evaluate(() => { window.__long.length = 0 })
  await lagReset()
  const r = await page.evaluate((route) => new Promise((res) => {
    const t0 = performance.now()
    let lastMut = performance.now()
    const main = document.querySelector('main') ?? document.body
    const mo = new MutationObserver(() => { lastMut = performance.now() })
    mo.observe(main, { childList: true, subtree: true, attributes: true, characterData: true })
    window.location.hash = '#' + route
    const iv = setInterval(() => {
      const now = performance.now()
      const busy = main.querySelector('[class*=skeleton],[class*=spinner],[aria-busy=true]')
      if (now - lastMut > 150 && !busy && now - t0 > 100) {
        clearInterval(iv); mo.disconnect()
        res({ ms: Math.round(lastMut - t0), long: window.__long.slice(), rows: main.querySelectorAll('tr').length, nodes: main.querySelectorAll('*').length })
      } else if (now - t0 > 20000) { clearInterval(iv); mo.disconnect(); res({ ms: -1, long: window.__long.slice(), rows: 0, nodes: 0 }) }
    }, 25)
  }), route)
  r.mainLag = await lagRead()
  return r
}
for (const r of ROUTES) result.pages[r] = await renderTime(r)

// ---- IPC: every list/get/summary method
const D30 = { from: new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10), to: new Date().toISOString().slice(0, 10) }
const CALLS = [
  ['dashboard', 'summary', {}],
  ['catalog', 'list', {}], ['catalog', 'list', { search: 'rocket' }], ['catalog', 'list', { search: '8910000' }], ['catalog', 'list', { limit: 50, offset: 10000 }],
  ['catalog', 'listCategories'], ['catalog', 'listBrands'], ['catalog', 'get', { id: 5 }], ['catalog', 'findByCode', { code: '8910000000010' }], ['catalog', 'getSettings'],
  ['pos', 'scan', { code: '8910000000010' }], ['pos', 'search', { text: 'rock' }], ['pos', 'listSales', {}], ['pos', 'listSales', { limit: 50, offset: 20000 }], ['pos', 'listSales', { search: 'INV-2026-0100' }],
  ['pos', 'getSale', { id: 100 }], ['pos', 'listHeld'], ['pos', 'getCurrentShift'], ['pos', 'listCustomers', {}], ['pos', 'listCustomers', { search: 'arun' }], ['pos', 'findCustomerByPhone', { phone: '9100000007' }], ['pos', 'settings'],
  ['inventory', 'locations'], ['inventory', 'categories'], ['inventory', 'lookup', { code: '8910000000010' }], ['inventory', 'search', { text: 'rocket' }],
  ['inventory', 'stock', {}], ['inventory', 'stock', { search: 'rocket' }], ['inventory', 'valuation', {}], ['inventory', 'ledger', {}], ['inventory', 'ledger', { variantId: 7 }], ['inventory', 'verifyLedger'],
  ['inventory', 'lowStock', {}], ['inventory', 'lowStockCount', {}], ['inventory', 'adjustments', {}], ['inventory', 'countList', {}], ['inventory', 'transferList', {}],
  ['purchases', 'list', {}], ['purchases', 'supplierList', {}], ['purchases', 'payables', {}], ['purchases', 'returnList', {}],
  ['reports', 'list'], ['reports', 'options'],
  ['audit', 'search', {}], ['audit', 'entities'], ['audit', 'actions'],
  ['auth', 'current'], ['auth', 'listUsers'], ['auth', 'listRoles'], ['auth', 'permissionCatalog'], ['auth', 'listApprovals', {}],
  ['businessProfile', 'getActive'], ['businessProfile', 'getActiveLogo'], ['businessProfile', 'listVersions'],
  ['settings', 'getAll'], ['settings', 'listTerminals'], ['settings', 'listLocations'], ['db', 'stats'],
  ['backup', 'status'], ['backup', 'list'], ['backup', 'getSettings'],
  ['sync', 'getStatus'], ['sync', 'getConfig'], ['sync', 'listQueue', {}], ['sync', 'listConflicts', {}], ['sync', 'listDevices'],
  ['printing', 'listTemplates', {}], ['printing', 'listPrinters', {}]
]
const reportList = await page.evaluate(async () => (await window.velmayil.call('reports', 'list', {})).data)
for (const r of reportList ?? []) {
  const id = r.id ?? r.key
  CALLS.push(['reports', 'run', { id, filters: { ...D30 } }])
  CALLS.push(['reports', 'runPage', { id, filters: { ...D30 }, offset: 0, limit: 200 }])
}
await lagReset()
for (const [s, m, a] of CALLS) {
  const runs = []
  let err = '', bytes = 0
  for (let i = 0; i < 3; i++) {
    const r = await call(s, m, a)
    runs.push(r.ms)
    err = r.err
    bytes = r.bytes
  }
  result.ipc.push({ call: `${s}.${m}${a && Object.keys(a).length ? ' ' + JSON.stringify(a).slice(0, 60) : ''}`, first: Math.round(runs[0]), best: Math.round(Math.min(...runs)), max: Math.round(Math.max(...runs)), kb: Math.round(bytes / 1024), err })
}
result.loop.duringIpc = await lagRead()

// ---- idle on dashboard for 20 s: loop lag + number of IPC calls the renderer makes by itself
await page.evaluate(() => { window.location.hash = '#/dashboard' })
await page.waitForTimeout(500)
await ipcTake()
await lagReset()
await page.waitForTimeout(65000)
result.loop.idle65s = await lagRead()
result.loop.idleCalls = (await ipcTake()).reduce((o, [k]) => ((o[k] = (o[k] || 0) + 1), o), {})

// ---- backup (manual create) while measuring main-process loop lag + a concurrent cheap call's latency
await lagReset()
const probe = page.evaluate(async () => {
  await new Promise((r) => setTimeout(r, 50))
  const t = performance.now(); await window.velmayil.call('auth', 'current', {}); return performance.now() - t
})
const bt = Date.now()
const br = await call('backup', 'create', {})
result.backup = { totalMs: Date.now() - bt, probeLatencyMs: Math.round(await probe), err: br.err, loop: await lagRead() }
// window hidden (minimised) simulation: ask the renderer how many timers it keeps
result.heap = await page.evaluate(() => Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1048576))

await app.close()
const json = JSON.stringify(result, null, 2)
if (outFile) writeFileSync(outFile, json)
const pad = (s, n) => String(s).padEnd(n)
console.log('\nSTARTUP', JSON.stringify(result.startup))
console.log('\nPAGES (ms to settle | long tasks | main-loop lag max/>50ms | rows | nodes)')
for (const [k, v] of Object.entries(result.pages)) console.log(pad(k, 28), pad(v.ms, 7), pad(JSON.stringify(v.long.map((l) => l.dur)), 24), pad(`${v.mainLag.max}/${v.mainLag.over50}`, 10), v.rows, v.nodes)
console.log('\nIPC (ms first/best/max | KB)  [* = >50ms]')
for (const c of result.ipc) console.log(c.max > 50 ? '*' : ' ', pad(c.call, 60), pad(`${c.first}/${c.best}/${c.max}`, 14), pad(c.kb + 'KB', 8), c.err)
console.log('\nBACKUP', JSON.stringify(result.backup))
console.log('\nLOOP', JSON.stringify(result.loop))
console.log('heap MB', result.heap)

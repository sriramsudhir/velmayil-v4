/**
 * Two REAL app processes of the BUILT app (out/): one becomes the Admin system, the other a Client system, linked through
 * the server embedded in the Admin's main process (127.0.0.1 here; on site it is the LAN cable). Proves in the real
 * Electron runtime what tests/sync/lan.test.ts proves in-process: price change on the Admin shows on the Client's
 * billing search within a few seconds, a shared setting follows, the Client reconnects after the Admin was closed.
 * Run:  npm run build && npx playwright test -c tests/e2e/playwright.config.ts lan-sync
 */
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, mkdirSync, existsSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(__dirname, '..', '..')
const SHOTS = join(ROOT, 'docs', 'qa-screens')
mkdirSync(SHOTS, { recursive: true })

interface Box { app: ElectronApplication; page: Page; dir: string }
const boxes: Box[] = []

async function launch(dir: string): Promise<Box> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v
  env.VELMAYIL_DATA_DIR = dir
  const app = await electron.launch({ args: [ROOT, `--user-data-dir=${join(dir, 'chromium-profile')}`], cwd: ROOT, env })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  const b = { app, page, dir }
  boxes.push(b)
  return b
}
const call = async (b: Box, service: string, method: string, args?: unknown): Promise<any> => {
  const r = await b.page.evaluate(([s, m, a]) => (window as any).velmayil.call(s, m, a), [service, method, args ?? {}] as const)
  if (!r.ok) throw new Error(`${service}.${method}: ${r.error?.code} ${r.error?.message}`)
  return r.data
}
async function firstRun(b: Box, shopName: string, posCode: string): Promise<void> {
  await call(b, 'setup', 'complete', { shop: { shopName }, owner: { username: 'owner', password: 'secret123' }, pos: { code: posCode, name: `Counter ${posCode}` } })
  await call(b, 'auth', 'login', { username: 'owner', password: 'secret123' })
  await b.page.reload()
  await b.page.waitForLoadState('domcontentloaded')
}
const freePort = (): Promise<number> =>
  new Promise((res, rej) => {
    const s = net.createServer()
    s.once('error', rej)
    s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)) })
  })
async function until<T>(what: string, fn: () => Promise<T | undefined | null | false>, ms = 15_000): Promise<{ value: T; ms: number }> {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return { value: v, ms: Date.now() - t0 }
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for: ${what}`)
    await new Promise((r) => setTimeout(r, 100))
  }
}
const priceOn = async (b: Box, text: string): Promise<number | undefined> => ((await call(b, 'pos', 'search', { text })) as { price: number }[])[0]?.price

test.describe.configure({ mode: 'serial' })
let admin: Box
let client: Box
let port = 0
let code = ''
const adminDir = mkdtempSync(join(tmpdir(), 'velmayil-lan-admin-'))
const clientDir = mkdtempSync(join(tmpdir(), 'velmayil-lan-client-'))

test.beforeAll(async () => {
  if (!existsSync(join(ROOT, 'out', 'main', 'index.js'))) throw new Error('Run `npm run build` first')
  port = await freePort()
  admin = await launch(adminDir)
  client = await launch(clientDir)
  await firstRun(admin, 'Velmayil Crackers', 'POS-01')
  await firstRun(client, 'Second counter', 'POS-02')
})
test.afterAll(async () => {
  for (const b of boxes) await b.app.close().catch(() => undefined)
})

test('01 admin system: sharing starts inside the app and shows address + pairing code', async () => {
  await call(admin, 'sync', 'saveConfig', { role: 'admin', port })
  const st = await until('admin listening', async () => {
    const s = await call(admin, 'sync', 'getStatus')
    return s.lan.listening || s.lan.problem ? s : null
  })
  expect(st.value.lan.problem).toBeNull()
  expect(st.value.lan.port).toBe(port)
  code = (await call(admin, 'sync', 'getPairingCode')).code
  expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/)
  expect((await call(admin, 'sync', 'testConnection')).ok).toBe(true)

  await admin.page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /Backup/ }).click()
  await admin.page.getByRole('tab', { name: /Multi-POS Sync/ }).click()
  await expect(admin.page.getByText('Sharing is on').first()).toBeVisible()
  await expect(admin.page.getByText(code)).toBeVisible()
  await admin.page.screenshot({ path: join(SHOTS, 'lan-01-admin.png'), fullPage: true })
})

test('02 client system: test connection explains a wrong code, the right one links', async () => {
  const bad = await call(client, 'sync', 'testConnection', { address: `127.0.0.1:${port}`, pairingCode: 'AAAA-AAAA' === code ? 'BBBB-BBBB' : 'AAAA-AAAA' })
  expect(bad.ok).toBe(false)
  expect(bad.error).toMatch(/pairing code is not correct/)

  await client.page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /Backup/ }).click()
  await client.page.getByRole('tab', { name: /Multi-POS Sync/ }).click()
  await client.page.getByText('This is a Client system').click()
  await client.page.getByLabel('Address of the Admin system').fill(`127.0.0.1:${port}`)
  await client.page.getByLabel('Pairing code').fill(code.toLowerCase())
  await client.page.getByRole('button', { name: 'Test connection' }).click()
  await expect(client.page.getByText(/Connected to the Admin system POS-01/)).toBeVisible()
  await client.page.getByRole('button', { name: 'Link to the Admin system' }).click()
  await until('client online', async () => (await call(client, 'sync', 'getStatus')).online === true)
  await expect(client.page.getByText(/Connected to the Admin system/).first()).toBeVisible()
  await client.page.screenshot({ path: join(SHOTS, 'lan-02-client.png'), fullPage: true })
})

test('03 a product made on the Admin appears on the Client; a price change follows within a few seconds', async () => {
  await call(admin, 'catalog', 'save', { name: 'Lan Sparkler', taxRateBp: 1800, variants: [{ sku: 'LANSPK', price: 10000, openingStock: 10 }] })
  const first = await until('product on client', async () => (await priceOn(client, 'Lan Sparkler')) === 10000)
  console.log(`new product reached the client in ${first.ms} ms`)

  const grid = (await call(admin, 'pos', 'search', { text: 'Lan Sparkler' })) as { variantId: number }[]
  await call(admin, 'catalog', 'bulkUpdate', { rows: [{ variantId: grid[0].variantId, patch: { price: 12500 } }] })
  const changed = await until('new price on client', async () => (await priceOn(client, 'Lan Sparkler')) === 12500, 10_000)
  console.log(`price change reached the client in ${changed.ms} ms`)
  expect(changed.ms).toBeLessThan(5000)

  // the shop details are the Admin's on both machines, although the Client was set up later
  await until('admin profile on client', async () => ((await call(client, 'businessProfile', 'getActive')) as { shopName: string }).shopName === 'Velmayil Crackers')
  expect(((await call(admin, 'businessProfile', 'getActive')) as { shopName: string }).shopName).toBe('Velmayil Crackers')

  // the Client's open product list re-reads by itself (live refresh), nobody presses anything
  await client.page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /Products/ }).click()
  await expect(client.page.getByText('Lan Sparkler').first()).toBeVisible()
  await expect(client.page.getByText(/125\.00/).first()).toBeVisible()
  await call(admin, 'catalog', 'bulkUpdate', { rows: [{ variantId: grid[0].variantId, patch: { price: 13300 } }] })
  await expect(client.page.getByText(/133\.00/).first()).toBeVisible({ timeout: 8000 })
  await client.page.screenshot({ path: join(SHOTS, 'lan-03-client-products.png') })
})

test('04 a shop-wide setting follows the Admin, a per-machine one does not', async () => {
  const valueOf = async (b: Box, key: string): Promise<string | undefined> => ((await call(b, 'settings', 'getAll')) as { values: Record<string, string> }).values[key]
  const before = await valueOf(client, 'pos.round_off')
  const next = before === '0' ? '1' : '0'
  await call(admin, 'settings', 'set', { key: 'pos.round_off', value: next })
  await until('shared setting on client', async () => (await valueOf(client, 'pos.round_off')) === next)
  // per machine: the sync interval / role of the Admin never reach the Client
  const a = await call(admin, 'sync', 'getConfig')
  const c = await call(client, 'sync', 'getConfig')
  expect(a.role).toBe('admin')
  expect(c.role).toBe('client')
})

test('05 Admin closed and started again: the Client keeps billing and catches up by itself', async () => {
  await admin.app.close()
  await until('client sees the admin is away', async () => (await call(client, 'sync', 'getStatus')).online === false, 60_000)
  const st = await call(client, 'sync', 'getStatus')
  expect(st.lastError).toMatch(/Admin/)
  expect(st.lastError).not.toMatch(/ECONNREFUSED|fetch failed/)
  // billing on the client is unaffected (a search answers immediately)
  const t0 = Date.now()
  expect(await priceOn(client, 'Lan Sparkler')).toBe(13300)
  expect(Date.now() - t0).toBeLessThan(1500)

  admin = await launch(adminDir)
  await call(admin, 'auth', 'login', { username: 'owner', password: 'secret123' })
  const grid = (await call(admin, 'pos', 'search', { text: 'Lan Sparkler' })) as { variantId: number }[]
  await call(admin, 'catalog', 'bulkUpdate', { rows: [{ variantId: grid[0].variantId, patch: { price: 14000 } }] })
  const back = await until('price after the admin returned', async () => (await priceOn(client, 'Lan Sparkler')) === 14000, 45_000)
  console.log(`after the admin came back, the client caught up in ${back.ms} ms`)
  expect((await call(admin, 'sync', 'getPairingCode')).code).toBe(code)
})

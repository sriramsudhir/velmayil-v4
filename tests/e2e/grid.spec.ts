/**
 * Excel-style product grid + live data bus, driven through the real built app (out/).
 * Run:  npm run build && npx playwright test -c tests/e2e/playwright.config.ts grid.spec.ts
 */
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(__dirname, '..', '..')
const dataDir = mkdtempSync(join(tmpdir(), 'velmayil-grid-e2e-'))
let app: ElectronApplication
let page: Page
const consoleErrors: string[] = []

const call = async (service: string, method: string, args?: unknown): Promise<any> => {
  const r = await page.evaluate(([s, m, a]) => (window as any).velmayil.call(s, m, a), [service, method, args ?? {}] as const)
  if (!r.ok) throw new Error(`${service}.${method}: ${r.error?.code} ${r.error?.message}`)
  return r.data
}
const nav = async (label: string | RegExp) => {
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: label }).click()
  await page.waitForTimeout(400)
}
const skipShift = async () => {
  const skip = page.getByRole('button', { name: 'Skip for now' })
  if (await skip.isVisible({ timeout: 2500 }).catch(() => false)) await skip.click()
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  if (!existsSync(join(ROOT, 'out', 'main', 'index.js'))) throw new Error('Run `npm run build` first')
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v
  env.VELMAYIL_DATA_DIR = dataDir
  app = await electron.launch({ args: [ROOT, `--user-data-dir=${join(dataDir, 'chromium-profile')}`], cwd: ROOT, env })
  page = await app.firstWindow()
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
  page.on('pageerror', (e) => consoleErrors.push(`[pageerror] ${e.message}`))
  await page.waitForLoadState('domcontentloaded')
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setContentSize(1400, 850) })
  // first-run setup through the service (the wizard itself is covered by app.spec.ts), then reload into the signed-in app
  await call('setup', 'complete', {
    shop: { shopName: 'Grid Test Shop' }, owner: { username: 'owner', name: 'Owner', password: 'Owner@123' }, pos: {}, locationName: 'Main Store'
  })
  await page.reload()
  const signIn = page.getByRole('button', { name: 'Sign in' })
  if (await signIn.isVisible({ timeout: 4000 }).catch(() => false)) {
    await page.getByLabel('Username').fill('owner')
    await page.getByLabel('Password', { exact: true }).fill('Owner@123')
    await signIn.click()
  }
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible({ timeout: 20_000 })
})
test.afterAll(async () => {
  await app?.close().catch(() => undefined)
})

let barcode = ''
let variantId = 0

test('01 grid: edit a price, Ctrl+S, POS shows the new price (barcode unchanged)', async () => {
  const saved = await call('catalog', 'save', {
    name: 'Grid Sparkler', hsn: '3604', taxRateBp: 1800,
    variants: [{ mrp: 20000, price: 15000, cost: 9000, autoBarcode: true, openingStock: 10 }]
  })
  await call('catalog', 'save', { name: 'Grid Rocket', hsn: '3604', taxRateBp: 1800, variants: [{ mrp: 30000, price: 25000, cost: 15000, autoBarcode: true }] })
  barcode = saved.variants[0].barcode
  variantId = saved.variants[0].id
  expect(barcode).toMatch(/^200\d{6}$/)

  await nav('Products')
  await page.getByRole('button', { name: 'Spreadsheet' }).click()
  const grid = page.getByRole('grid', { name: 'Product spreadsheet' })
  await expect(grid).toBeVisible()
  await expect(grid.locator(`[data-row="v${variantId}"][data-col="price"]`)).toHaveText('150.00')

  // select the price cell and type a new value (starts editing), Enter commits
  await grid.locator(`[data-row="v${variantId}"][data-col="price"]`).click()
  await page.keyboard.type('179.5')
  await page.keyboard.press('Enter')
  const cell = grid.locator(`[data-row="v${variantId}"][data-col="price"]`)
  await expect(cell).toHaveText('179.5')
  await expect(cell).toHaveClass(/dirty/)
  await expect(page.getByText(/1 changed cell/)).toBeVisible()

  // undo / redo of local edits
  await grid.focus()
  await page.keyboard.press('Control+z')
  await expect(cell).toHaveText('150.00')
  await page.keyboard.press('Control+y')
  await expect(cell).toHaveText('179.5')

  // invalid value is flagged and blocks saving
  await grid.locator(`[data-row="v${variantId}"][data-col="cost"]`).click()
  await page.keyboard.type('-5')
  await page.keyboard.press('Enter')
  await expect(grid.locator(`[data-row="v${variantId}"][data-col="cost"]`)).toHaveClass(/err/)
  await grid.focus()
  await page.keyboard.press('Control+z')

  await grid.focus()
  await page.keyboard.press('Control+s')
  await expect(page.getByText(/Saved: 1 updated/)).toBeVisible({ timeout: 10_000 })
  await expect(grid.locator(`[data-row="v${variantId}"][data-col="price"]`)).toHaveText('179.50')

  const after = await call('catalog', 'get', { id: saved.id })
  expect(after.variants[0].price).toBe(17950)
  expect(after.variants[0].barcode).toBe(barcode)

  // POS in the same window charges the new price
  await nav(/Billing/)
  await skipShift()
  const scan = page.getByLabel('Scan or search products')
  await scan.fill(barcode)
  await scan.press('Enter')
  await expect(page.getByText('Grid Sparkler').first()).toBeVisible()
  await expect(page.getByText('₹179.50').first()).toBeVisible({ timeout: 10_000 })
})

test('02 live refresh: a change made elsewhere shows up in the Products list without reload', async () => {
  await nav('Products')
  await page.getByRole('button', { name: 'Products', exact: true }).click()
  await page.getByPlaceholder(/Search name, SKU/).fill('Grid Rocket')
  const row = page.getByRole('row', { name: /Grid Rocket/ })
  await expect(row).toContainText('250.00', { timeout: 10_000 })
  const rocket = (await call('catalog', 'list', { search: 'Grid Rocket' })).rows[0]
  const detail = await call('catalog', 'get', { id: rocket.id })
  // write through the bus-enabled service API, as another screen / window / synced terminal would
  await call('catalog', 'bulkUpdate', { rows: [{ variantId: detail.variants[0].id, patch: { price: 27500 } }] })
  await expect(row).toContainText('275.00', { timeout: 5000 })
})

test('03 grid reflects a change made elsewhere and copy/paste fills cells', async () => {
  await page.getByRole('button', { name: 'Spreadsheet' }).click()
  const grid = page.getByRole('grid', { name: 'Product spreadsheet' })
  const rocketCell = grid.locator('[data-col="price"]', { hasText: '275.00' })
  await expect(rocketCell).toBeVisible()
  const rocket = (await call('catalog', 'list', { search: 'Grid Rocket' })).rows[0]
  const rv = (await call('catalog', 'get', { id: rocket.id })).variants[0].id
  await call('catalog', 'bulkUpdate', { rows: [{ variantId: rv, patch: { price: 28000 } }] })
  await expect(grid.locator(`[data-row="v${rv}"][data-col="price"]`)).toHaveText('280.00', { timeout: 5000 })

  // Excel-style paste: put tab/newline text in the clipboard and paste into the active cell
  await grid.locator(`[data-row="v${rv}"][data-col="mrp"]`).click()
  // Deliver the Excel-style text through a real DOM paste event (not the shared OS clipboard, which other programs can overwrite).
  await grid.focus()
  await grid.evaluate((el) => {
    const dt = new DataTransfer()
    dt.setData('text/plain', '333\t300')
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  })
  await expect(grid.locator(`[data-row="v${rv}"][data-col="mrp"]`)).toHaveText('333')
  await expect(grid.locator(`[data-row="v${rv}"][data-col="price"]`)).toHaveText('300')
  page.once('dialog', (d) => void d.accept())
  await page.getByRole('button', { name: 'Discard' }).click()
  await expect(grid.locator(`[data-row="v${rv}"][data-col="price"]`)).toHaveText('280.00')
})

test('99 no renderer errors', () => {
  expect.soft(consoleErrors).toEqual([])
})

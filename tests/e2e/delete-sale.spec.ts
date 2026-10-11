/**
 * Real-UI end-to-end check of the BUILT app (out/): deleting an order from the Dashboard removes the invoice
 * everywhere (dashboard, sales history, reports) and puts the stock back. Also screenshots the new screens.
 * Run:  npm run build && npx playwright test -c tests/e2e/playwright.config.ts tests/e2e/delete-sale.spec.ts
 */
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(__dirname, '..', '..')
const SHOTS = join(ROOT, 'docs', 'qa-screens')
mkdirSync(SHOTS, { recursive: true })
const dataDir = mkdtempSync(join(tmpdir(), 'velmayil-e2e-del-'))
const consoleErrors: string[] = []

let app: ElectronApplication
let page: Page
let barcode = ''
let variantId = 0
let invoice = ''

const call = async (service: string, method: string, args?: unknown): Promise<any> => {
  const r = await page.evaluate(([s, m, a]) => (window as any).velmayil.call(s, m, a), [service, method, args ?? {}] as const)
  if (!r.ok) throw new Error(`${service}.${method}: ${r.error?.code} ${r.error?.message}`)
  return r.data
}
const nav = async (label: RegExp) => {
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: label }).click()
  await page.waitForTimeout(500)
}
const shot = async (name: string) => { await page.screenshot({ path: join(SHOTS, `${name}.png`) }) }
const stock = async (): Promise<number> => (await call('catalog', 'get', { id: (await call('catalog', 'list', { search: 'Delete Test Rocket' })).rows[0].id })).variants[0].stock

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  if (!existsSync(join(ROOT, 'out', 'main', 'index.js'))) throw new Error('Run `npm run build` first')
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v
  env.VELMAYIL_DATA_DIR = dataDir
  app = await electron.launch({ args: [ROOT, `--user-data-dir=${join(dataDir, 'chromium-profile')}`], cwd: ROOT, env })
  page = await app.firstWindow()
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`[${m.location().url.split('/').pop()}] ${m.text()}`) })
  page.on('pageerror', (e) => consoleErrors.push(`[pageerror] ${e.message}`))
  await page.waitForLoadState('domcontentloaded')
})
test.afterAll(async () => { await app?.close().catch(() => undefined) })

test('01 setup, a product with a generated running-number barcode, one cash sale', async () => {
  await expect(page.getByText(/First-time setup/)).toBeVisible()
  await page.getByLabel('Shop name *').fill('Delete Test Shop')
  await page.getByLabel('Address').fill('1 Main Road')
  await page.getByLabel('City').fill('Sivakasi')
  await page.getByLabel('State').fill('Tamil Nadu')
  await page.getByLabel('PIN code').fill('626123')
  await page.getByLabel('Phone').fill('9876543210')
  await page.getByRole('button', { name: 'Next' }).click()
  await page.getByLabel('Username *').fill('owner')
  await page.getByLabel('Your name').fill('Shop Owner')
  await page.getByLabel('Password *', { exact: true }).fill('Owner@123')
  await page.getByLabel('Confirm password *').fill('Owner@123')
  await page.getByRole('button', { name: 'Next' }).click()
  await page.getByRole('button', { name: 'Next' }).click()
  await page.getByRole('button', { name: 'Finish setup' }).click()
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible({ timeout: 20_000 })

  const a = await call('catalog', 'save', { name: 'Delete Test Rocket', hsn: '3604', taxRateBp: 1800, variants: [{ name: '', autoBarcode: true, mrp: 11800, price: 11800, cost: 6000, openingStock: 10 }] })
  const b = await call('catalog', 'save', { name: 'Delete Test Sparkler', hsn: '3604', taxRateBp: 1800, variants: [{ name: '', autoBarcode: true, mrp: 5000, price: 5000, cost: 2000, openingStock: 10 }] })
  barcode = a.variants[0].barcode
  variantId = a.variants[0].id
  // owner rule: the prefix stays the same, only the suffix counts up
  expect(barcode).toBe('200000001')
  expect(b.variants[0].barcode).toBe('200000002')
  expect(variantId).toBeGreaterThan(0)

  await nav(/Billing/)
  const skip = page.getByRole('button', { name: 'Skip for now' })
  if (await skip.isVisible({ timeout: 2500 }).catch(() => false)) await skip.click()
  const scan = page.getByLabel('Scan or search products')
  await scan.fill(barcode)
  await scan.press('Enter')
  await expect(page.getByText('Delete Test Rocket').first()).toBeVisible()
  await page.getByRole('button', { name: /^Pay/ }).click()
  await page.getByRole('button', { name: /Complete sale/ }).click()
  await expect(page.getByText('Sale completed')).toBeVisible({ timeout: 15_000 })
  invoice = (await page.locator('.pos-success .big').innerText()).trim()
  await page.getByRole('dialog').getByRole('button', { name: /New bill/ }).click()
  expect(await stock()).toBe(9)
})

test('02 Dashboard: Recent sales row has Delete; confirming removes the invoice and returns the stock', async () => {
  await nav(/Dashboard/)
  const row = page.getByTestId('recent-sale').filter({ hasText: invoice })
  await expect(row).toBeVisible()
  await row.scrollIntoViewIfNeeded()
  await shot('50-dashboard-recent-sales-delete')
  await row.getByRole('button', { name: `Delete invoice ${invoice}` }).click()
  const dlg = page.getByRole('dialog')
  await expect(dlg.getByTestId('delete-sale-dialog')).toContainText(invoice)
  // a reason is required
  await expect(dlg.getByTestId('delete-sale-confirm')).toBeDisabled()
  await dlg.getByRole('textbox').first().fill('test bill')
  await shot('51-delete-sale-dialog')
  await dlg.getByTestId('delete-sale-confirm').click()
  await expect(page.getByTestId('recent-sale').filter({ hasText: invoice })).toHaveCount(0)

  expect((await call('pos', 'listSales', { search: invoice })).total).toBe(0)
  expect(await stock()).toBe(10)
  const dash = await call('dashboard', 'summary', {})
  expect(dash.today.bills).toBe(0)
  expect(dash.today.sales).toBe(0)
  await shot('52-dashboard-after-delete')
})

test('03 Sales history no longer lists the invoice', async () => {
  await nav(/Sales history/)
  await expect(page.getByText(invoice)).toHaveCount(0)
})

test('04 screenshots: barcode numbering dialog, printer darkness, dark billing screen', async () => {
  await nav(/Products/)
  await page.getByRole('button', { name: 'Barcode numbering' }).click()
  await expect(page.getByRole('dialog')).toContainText('200000003')
  await shot('53-barcode-numbering')
  await page.keyboard.press('Escape')

  await nav(/Printing/)
  await page.getByRole('tab', { name: /Printers/ }).or(page.getByRole('button', { name: /^Printers/ })).first().click()
  await page.waitForTimeout(400)
  await shot('54-printers-tab')
  await page.getByRole('button', { name: 'Add printer' }).click()
  await expect(page.getByText(/Print darkness/).first()).toBeVisible()
  await page.getByText(/Print darkness/).first().scrollIntoViewIfNeeded()
  await shot('54b-printer-darkness')
  await page.keyboard.press('Escape')

  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
  await nav(/Billing/)
  await page.waitForTimeout(600)
  await shot('55-pos-dark')
})

test('99 no renderer console errors', async () => {
  expect(consoleErrors).toEqual([])
})

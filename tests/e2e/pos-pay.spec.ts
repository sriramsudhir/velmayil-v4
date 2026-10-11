/**
 * Real-UI end-to-end checks of the BUILT app (out/) for the payment screen and keyboard-wedge barcode scanning.
 * Run:  npm run build && npx playwright test -c tests/e2e/playwright.config.ts tests/e2e/pos-pay.spec.ts
 */
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(__dirname, '..', '..')
const dataDir = mkdtempSync(join(tmpdir(), 'velmayil-e2e-pay-'))
const BARCODE = '8901234567890'
const consoleErrors: string[] = []

let app: ElectronApplication
let page: Page

async function launch(): Promise<void> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v
  env.VELMAYIL_DATA_DIR = dataDir
  app = await electron.launch({ args: [ROOT, `--user-data-dir=${join(dataDir, 'chromium-profile')}`], cwd: ROOT, env })
  page = await app.firstWindow()
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`[${m.location().url.split('/').pop()}] ${m.text()}`) })
  page.on('pageerror', (e) => consoleErrors.push(`[pageerror] ${e.message}`))
  await page.waitForLoadState('domcontentloaded')
}
const call = async (service: string, method: string, args?: unknown): Promise<any> => {
  const r = await page.evaluate(([s, m, a]) => (window as any).velmayil.call(s, m, a), [service, method, args ?? {}] as const)
  if (!r.ok) throw new Error(`${service}.${method}: ${r.error?.code} ${r.error?.message}`)
  return r.data
}
const skipShift = async () => {
  const skip = page.getByRole('button', { name: 'Skip for now' })
  if (await skip.isVisible({ timeout: 2500 }).catch(() => false)) await skip.click()
}
const openBilling = async () => {
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /Billing/ }).click()
  await page.waitForTimeout(500)
  await skipShift()
  await expect(page.getByLabel('Scan or search products')).toBeVisible()
}
const addByScanBox = async () => {
  const scan = page.getByLabel('Scan or search products')
  await scan.fill(BARCODE)
  await scan.press('Enter')
  await expect(page.getByText('Pay Test Rocket').first()).toBeVisible()
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  if (!existsSync(join(ROOT, 'out', 'main', 'index.js'))) throw new Error('Run `npm run build` first')
  await launch()
})
test.afterAll(async () => { await app?.close().catch(() => undefined) })

test('01 setup shop + a Rs 4000 product', async () => {
  await expect(page.getByText(/First-time setup/)).toBeVisible()
  await page.getByLabel('Shop name *').fill('Pay Test Shop')
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
  const saved = await call('catalog', 'save', { name: 'Pay Test Rocket', hsn: '3604', taxRateBp: 0, variants: [{ name: '', mrp: 400000, price: 400000, cost: 200000, openingStock: 50, barcode: BARCODE }] })
  expect(saved.variants[0].barcode).toBe(BARCODE)
})

test('02 cash: 4000 bill, 4500 tendered => big "Balance to return" 500.00 instantly, Enter completes, success panel shows change', async () => {
  await openBilling()
  await addByScanBox()
  await page.getByRole('button', { name: /^Pay/ }).click()
  const cash = page.getByLabel('Cash received', { exact: true })
  await expect(cash).toBeFocused()
  await expect(page.getByTestId('amount-due')).toHaveText('₹4,000.00')
  // not enough cash: balance due
  await cash.pressSequentially('3500')
  await expect(page.getByTestId('balance-due')).toContainText('Balance due')
  await expect(page.getByTestId('balance-due')).toContainText('500.00')
  await expect(page.getByRole('button', { name: /Complete sale/ })).toBeDisabled()
  // exactly what the owner described: customer gives 4500
  await cash.fill('')
  await cash.pressSequentially('4500')
  const change = page.getByTestId('change-due')
  await expect(change).toContainText('Balance to return')
  await expect(change).toContainText('500.00')
  const fs = await change.locator('strong').evaluate((el) => parseFloat(getComputedStyle(el).fontSize))
  expect(fs).toBeGreaterThanOrEqual(30) // large type
  await expect(page.getByTestId('received')).toHaveText('₹4,500.00')
  // quick-cash buttons: Exact, next round amounts
  await expect(page.getByRole('button', { name: 'Exact' })).toBeVisible()
  await page.getByRole('button', { name: '5,000.00' }).click()
  await expect(change).toContainText('1,000.00')
  await cash.fill('4500')
  await cash.press('Enter') // Enter completes the sale when payable
  await expect(page.getByText('Sale completed')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('success-change')).toContainText('Change to return')
  await expect(page.getByTestId('success-change')).toContainText('500.00')
  await expect(page.locator('.pos-success')).toContainText('₹4,500.00')
  const sales = await call('pos', 'listSales', { limit: 1 })
  expect(sales.rows[0].total).toBe(400000)
  const sale = await call('pos', 'getSale', { id: sales.rows[0].id })
  expect(sale.paid ?? sale.sale?.paid).toBe(450000)
  await page.getByRole('dialog').getByRole('button', { name: /New bill/ }).click()
})

test('03 mixed: 1500 UPI + 3000 cash on a 4000 bill => change 500; online cannot be overpaid', async () => {
  await openBilling()
  await addByScanBox()
  await page.getByRole('button', { name: /^Pay/ }).click()
  await page.getByRole('tab', { name: 'Mixed / split' }).click()
  const amounts = page.getByLabel('Amount', { exact: true })
  await amounts.nth(0).fill('3000') // cash row
  await expect(page.getByTestId('balance-due')).toContainText('1,000.00')
  await page.getByLabel('Method', { exact: true }).nth(1).selectOption('upi')
  await amounts.nth(1).fill('1500')
  await expect(page.getByTestId('change-due')).toContainText('500.00')
  // overpaying only the online part is refused
  await amounts.nth(0).fill('100')
  await amounts.nth(1).fill('4500')
  await expect(page.getByText(/Only cash can be overpaid/)).toBeVisible()
  await expect(page.getByRole('button', { name: /Complete sale/ })).toBeDisabled()
  await amounts.nth(0).fill('3000')
  await amounts.nth(1).fill('1500')
  await page.getByRole('button', { name: /Complete sale/ }).click()
  await expect(page.getByTestId('success-change')).toContainText('500.00', { timeout: 15_000 })
  const sales = await call('pos', 'listSales', { limit: 1 })
  const sale = await call('pos', 'getSale', { id: sales.rows[0].id })
  const pays = (sale.payments ?? sale.sale?.payments) as { method: string; amount: number }[]
  expect(pays.map((p) => [p.method, p.amount])).toEqual([['cash', 250000], ['upi', 150000]])
  await page.getByRole('dialog').getByRole('button', { name: /New bill/ }).click()
})

test('04 online UPI: exact amount, reference, QR when the shop UPI id is set', async () => {
  await call('settings', 'set', { key: 'billing.upi_id', value: 'paytest@okbank' })
  expect((await call('pos', 'settings')).upiId).toBe('paytest@okbank')
  await openBilling()
  await addByScanBox()
  await page.getByRole('button', { name: /^Pay/ }).click()
  await page.getByRole('tab', { name: 'UPI' }).click()
  await expect(page.getByTestId('upi-qr').locator('img')).toBeVisible({ timeout: 10_000 })
  await expect(page.getByTestId('upi-qr')).toContainText('4,000.00')
  await expect(page.getByTestId('change-due')).toHaveCount(0)
  await page.getByPlaceholder('Reference no.').fill('UTR998877')
  await page.getByRole('button', { name: /Complete sale/ }).click()
  await expect(page.getByText('Sale completed')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('success-change')).toHaveCount(0)
  await page.getByRole('dialog').getByRole('button', { name: /New bill/ }).click()
})

test('05 keyboard-wedge scan with focus on the page body adds the item (nothing typed anywhere)', async () => {
  await openBilling()
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('BODY')
  await page.keyboard.type(BARCODE)
  await page.keyboard.press('Enter')
  await expect(page.getByText('Pay Test Rocket').first()).toBeVisible({ timeout: 10_000 })
  await expect(page.getByLabel('Scan or search products')).toHaveValue('')
  // scan again: quantity goes to 2
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.keyboard.type(BARCODE)
  await page.keyboard.press('Enter')
  await expect(page.getByLabel('Quantity', { exact: true })).toHaveValue('2')
})

test('06 a scan while another field has focus goes to the cart and is not typed into that field; human typing is untouched', async () => {
  const note = page.getByPlaceholder('Bill note (optional)')
  await note.click()
  await expect(note).toBeFocused()
  await page.keyboard.type(BARCODE)
  await page.keyboard.press('Enter')
  await expect(page.getByLabel('Quantity', { exact: true })).toHaveValue('3', { timeout: 10_000 })
  await expect(note).toHaveValue('') // the leaked first character was removed again
  // slow typing is a person, not a scan
  await note.pressSequentially('gift wrap', { delay: 120 })
  await expect(note).toHaveValue('gift wrap')
  await expect(page.getByLabel('Quantity', { exact: true })).toHaveValue('3')
})

test('07 unknown barcode: error toast, cart unchanged', async () => {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.keyboard.type('9999999999994')
  await page.keyboard.press('Enter')
  await expect(page.getByText(/Barcode not found: 9999999999994/)).toBeVisible({ timeout: 10_000 })
  await expect(page.getByLabel('Quantity', { exact: true })).toHaveValue('3')
  // the red message carries the exact scanned code (nothing glued on: the last character a person typed in the note is not part of it)
  await expect(page.getByTestId('scan-notfound-code')).toHaveText('9999999999994')
  // ... and that last character is still in the note
  await expect(page.getByPlaceholder('Bill note (optional)')).toHaveValue('gift wrap')
})

test('08 Settings > Scanner test page shows the scan, its timing and the product', async () => {
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Settings' }).click()
  await page.getByRole('tab', { name: 'Scanner' }).click()
  await expect(page.getByRole('tab', { name: 'Scanner', selected: true })).toBeVisible()
  await page.waitForTimeout(800) // let the Scanner panel mount and attach its key listener before the "scan" starts
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.keyboard.type(BARCODE)
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('scan-code')).toHaveText(BARCODE, { timeout: 10_000 })
  await expect(page.getByTestId('scan-lookup')).toContainText('Pay Test Rocket')
  await expect(page.getByTestId('key-log')).toContainText('Digit8')
})

test('99 no renderer console errors', async () => {
  expect.soft(consoleErrors, 'renderer console errors').toEqual([])
})

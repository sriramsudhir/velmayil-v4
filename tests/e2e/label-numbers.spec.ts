/**
 * Unique label numbers, through the real screens of the BUILT app (out/):
 *   Products > product > "Print label"  ->  every label gets its own 10-digit number (same prefix, suffix + 1),
 *   more labels than stock asks before stock changes, a reprint creates no number, and at Billing a label is added once.
 * Nothing is sent to a printer: the job is saved as a PDF (the native save dialog is answered by the test).
 *
 * Run:  npm run build && npx playwright test -c tests/e2e/playwright.config.ts label-numbers.spec.ts
 */
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(__dirname, '..', '..')
const dataDir = mkdtempSync(join(tmpdir(), 'velmayil-labels-e2e-'))
const SHARED = '200000777'
const consoleErrors: string[] = []

let app: ElectronApplication
let page: Page
let variantId = 0
let productId = 0
let codes: string[] = []
let pdfNo = 0

const call = async (service: string, method: string, args?: unknown): Promise<any> => {
  const r = await page.evaluate(([s, m, a]) => (window as any).velmayil.call(s, m, a), [service, method, args ?? {}] as const)
  if (!r.ok) throw new Error(`${service}.${method}: ${r.error?.code} ${r.error?.message}`)
  return r.data
}
/** Answer the next native "Save PDF" dialog with a file in the test's own folder. */
const nextPdf = async (): Promise<string> => {
  const file = join(dataDir, `labels-${++pdfNo}.pdf`)
  await app.evaluate(({ dialog }, p) => { (dialog as any).showSaveDialog = async () => ({ canceled: false, filePath: p }) }, file)
  return file
}
const unitsOf = async (): Promise<{ code: string; status: string; labelPrintedAt: number | null }[]> =>
  ((await call('units', 'list', { variantId, limit: 200 })).rows as { code: string; status: string; labelPrintedAt: number | null }[]).sort((a, b) => a.code.localeCompare(b.code))
const stock = async (): Promise<number> => (await call('inventory', 'lookup', { code: SHARED })).qtyAtLocation
const openProduct = async () => {
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Products' }).click()
  await page.getByPlaceholder(/Search name, SKU/).fill('Flower Pot Deluxe')
  await page.waitForTimeout(700)
  await page.getByText('Flower Pot Deluxe').first().click()
  await expect(page.getByLabel('Product name')).toHaveValue('Flower Pot Deluxe')
}
const labelDialog = () => page.getByRole('dialog', { name: /barcode label/ })
const preview = () => page.frameLocator('iframe[title="Label preview"]')
const scanBox = () => page.getByLabel('Scan or search products')
const scan = async (code: string) => {
  await scanBox().focus()
  await scanBox().fill('')
  await page.keyboard.type(code, { delay: 5 })
  await page.keyboard.press('Enter')
  await page.waitForTimeout(500)
}
const chips = () => page.evaluate(() => [...document.querySelectorAll('.pos-cart [data-unit]')].map((e) => e.getAttribute('data-unit')))

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
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setContentSize(1400, 860); w.show() })
  await call('setup', 'complete', { shop: { shopName: 'Label Numbers Shop' }, owner: { username: 'owner', name: 'Owner', password: 'Owner@123' }, pos: {}, locationName: 'Main Store' })
  await page.reload()
  const signIn = page.getByRole('button', { name: 'Sign in' })
  if (await signIn.isVisible({ timeout: 4000 }).catch(() => false)) {
    await page.getByLabel('Username').fill('owner')
    await page.getByLabel('Password', { exact: true }).fill('Owner@123')
    await signIn.click()
  }
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible({ timeout: 20_000 })
  // an ordinary stock-tracked product exactly as the shop makes it: nothing ticked, no prefix, 3 pieces with the shared barcode
  const saved = await call('catalog', 'save', { name: 'Flower Pot Deluxe', hsn: '3604', taxRateBp: 0, variants: [{ name: '', mrp: 10000, price: 10000, cost: 5000, openingStock: 3, barcode: SHARED }] })
  productId = saved.id
  variantId = saved.variants[0].id
})
test.afterAll(async () => {
  await app?.close().catch(() => undefined)
})

test('01 the dialog previews the next number and asks before printing more labels than stock', async () => {
  await openProduct()
  await page.getByRole('button', { name: 'Print label', exact: true }).first().click()
  const dlg = labelDialog()
  await expect(dlg).toBeVisible({ timeout: 15_000 })
  await expect(dlg.getByTestId('label-plan')).toContainText('3 of 3')
  // the preview shows a 10-digit label number, not the shared product barcode
  await expect(preview().locator('.code').first()).toHaveText(/^[1-9]\d{9}$/, { timeout: 15_000 })
  const first = (await preview().locator('.code').first().innerText()).trim()
  expect(first.slice(4)).toBe('000001')
  expect(first).not.toBe(SHARED)
  // nothing is reserved by looking
  expect((await unitsOf()).length).toBe(0)
  expect((await call('catalog', 'get', { id: productId })).trackUnits).toBeFalsy()

  await dlg.getByTestId('label-copies').fill('5')
  await expect(dlg.getByRole('button', { name: 'Print 5 labels' })).toBeEnabled({ timeout: 15_000 })
  await nextPdf()
  await dlg.getByRole('button', { name: 'Save PDF' }).click()
  await expect(dlg.getByTestId('label-shortfall')).toContainText('only 3 pieces in stock have no label yet, but 5 labels were asked for', { timeout: 15_000 })
  // refused: no number, no stock change
  expect((await unitsOf()).length).toBe(0)
  expect(await stock()).toBe(3)
})

test('02 confirming receives the extra pieces and issues 5 consecutive numbers with one prefix', async () => {
  const dlg = labelDialog()
  const file = await nextPdf()
  await dlg.getByTestId('label-receive-extra').click()
  await expect(dlg.getByText(/PDF saved to/)).toBeVisible({ timeout: 30_000 })
  await expect(dlg.getByTestId('label-issued')).toBeVisible()
  expect(statSync(file).size).toBeGreaterThan(1000)
  const units = await unitsOf()
  codes = units.map((u) => u.code)
  expect(codes).toHaveLength(5)
  for (const c of codes) expect(c).toMatch(/^[1-9]\d{9}$/)
  expect(new Set(codes.map((c) => c.slice(0, 4))).size).toBe(1)
  expect(codes.map((c) => Number(c.slice(4)))).toEqual([1, 2, 3, 4, 5])
  expect(units.every((u) => u.labelPrintedAt != null && u.status === 'in_stock')).toBe(true)
  expect(await stock()).toBe(5)
  expect((await call('inventory', 'verifyLedger')).ok).toBe(true)
  // saving the PDF again prints the SAME numbers: nothing new is issued
  await nextPdf()
  await dlg.getByRole('button', { name: 'Save PDF' }).first().click()
  await page.waitForTimeout(1500)
  expect((await unitsOf()).map((u) => u.code)).toEqual(codes)
  await dlg.locator('footer').getByRole('button', { name: 'Close' }).click()
})

test('03 printing again continues with the next number; a reprint creates none', async () => {
  await call('inventory', 'adjust', { variantId, delta: 2, reason: 'found' }) // 2 more pieces arrive
  await page.getByRole('button', { name: 'Print label', exact: true }).first().click()
  const dlg = labelDialog()
  await expect(dlg.getByTestId('label-plan')).toContainText('2 of 7', { timeout: 15_000 })
  await expect(preview().locator('.code').first()).toHaveText(`${codes[0].slice(0, 4)}000006`, { timeout: 15_000 })
  await dlg.getByTestId('label-copies').fill('2')
  await page.waitForTimeout(600)
  await nextPdf()
  await dlg.getByRole('button', { name: 'Save PDF' }).click()
  await expect(dlg.getByText(/PDF saved to/)).toBeVisible({ timeout: 30_000 })
  const after = (await unitsOf()).map((u) => u.code)
  expect(after).toEqual([...codes, `${codes[0].slice(0, 4)}000006`, `${codes[0].slice(0, 4)}000007`])
  await dlg.locator('footer').getByRole('button', { name: 'Close' }).click()

  // reprint a damaged label: the existing number, no new one
  await page.getByRole('button', { name: 'Print label', exact: true }).first().click()
  await dlg.getByLabel('Label number to reprint').fill('2999000123')
  await dlg.getByRole('button', { name: 'Reprint', exact: true }).click()
  await expect(dlg.getByText(/does not exist/)).toBeVisible()
  await dlg.getByLabel('Label number to reprint').fill(codes[1])
  await dlg.getByRole('button', { name: 'Reprint', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Reprint barcode label' })).toBeVisible()
  await expect(preview().locator('.code').first()).toHaveText(codes[1], { timeout: 15_000 })
  await nextPdf()
  await dlg.getByRole('button', { name: 'Save PDF' }).click()
  await expect(dlg.getByText(/PDF saved to/)).toBeVisible({ timeout: 30_000 })
  expect((await unitsOf()).map((u) => u.code)).toEqual(after)
  expect(await stock()).toBe(7)
  codes = after
  await dlg.locator('footer').getByRole('button', { name: 'Close' }).click()
  await page.getByRole('dialog', { name: 'Edit product' }).locator('footer').getByRole('button', { name: 'Cancel' }).click()
})

test('04 billing: a label is added once, a second scan is a duplicate, a sold label and the old shared barcode are refused', async () => {
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /Billing/ }).click()
  await page.waitForTimeout(500)
  const skip = page.getByRole('button', { name: 'Skip for now' })
  if (await skip.isVisible({ timeout: 2500 }).catch(() => false)) await skip.click()
  await expect(scanBox()).toBeVisible()

  await scan(codes[0])
  expect(await chips()).toEqual([codes[0]])
  await scan(codes[0])
  await expect(page.getByTestId('unit-warning')).toContainText(`Duplicate entry: ${codes[0]}`)
  expect(await chips()).toEqual([codes[0]])
  await scan(codes[1])
  expect(await chips()).toEqual([codes[0], codes[1]])
  // every piece has its own label now: the old shared barcode is refused with the hint
  await scan(SHARED)
  await expect(page.getByTestId('unit-warning')).toContainText('scan the unit code on the item')
  expect(await chips()).toEqual([codes[0], codes[1]])

  // the server refuses the same things, whatever the screen does
  const sale = await call('pos', 'completeSale', { lines: [{ variantId, qty: 1, unitCodes: [codes[2]] }], payments: [{ method: 'cash', amount: 10000 }] })
  expect(sale.invoiceNo).toBeTruthy()
  await scan(codes[2])
  await expect(page.getByTestId('unit-warning')).toContainText(`${codes[2]} is already sold`)
  expect(await chips()).toEqual([codes[0], codes[1]])
  expect(await stock()).toBe(6)
  expect((await call('inventory', 'verifyLedger')).ok).toBe(true)
})

test('99 no renderer errors', async () => {
  expect(consoleErrors.filter((e) => !/Failed to load resource|net::ERR/.test(e))).toEqual([])
})

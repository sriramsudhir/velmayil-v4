/**
 * Unit codes (PREFIX-NNNN) on the stock side, driven through the real built app (out/):
 * tracking toggle + prefix on the product form, the Units tab, unit label dialog (size picker, Code 128), the stock-count sheet and
 * the label print queue applying the ACTIVE-LIST rule (new code -> added, repeated code -> red duplicate warning).
 *
 * Run:  npm run build && npx playwright test -c tests/e2e/playwright.config.ts units-stock.spec.ts
 */
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(__dirname, '..', '..')
const dataDir = mkdtempSync(join(tmpdir(), 'velmayil-units-stock-e2e-'))
let app: ElectronApplication
let page: Page
const consoleErrors: string[] = []
let productId = 0
let variantId = 0
let countId = 0

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
  if (await skip.isVisible({ timeout: 1500 }).catch(() => false)) await skip.click()
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
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setContentSize(1400, 900) })
  await call('setup', 'complete', {
    shop: { shopName: 'Units Stock Shop' }, owner: { username: 'owner', name: 'Owner', password: 'Owner@123' }, pos: {}, locationName: 'Main Store'
  })
  await page.reload()
  const signIn = page.getByRole('button', { name: 'Sign in' })
  if (await signIn.isVisible({ timeout: 4000 }).catch(() => false)) {
    await page.getByLabel('Username').fill('owner')
    await page.getByLabel('Password', { exact: true }).fill('Owner@123')
    await signIn.click()
  }
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible({ timeout: 20_000 })
  await skipShift()
})
test.afterAll(async () => {
  await app?.close().catch(() => undefined)
})

test('01 product form: track units with a prefix, 3 opening units get codes, label dialog offers the size picker', async () => {
  await nav('Products')
  await page.getByRole('button', { name: '+ Add product' }).click()
  const form = page.getByRole('dialog', { name: 'Add product' })
  await form.getByLabel('Product name').fill('Sparkler Pack')
  await form.getByLabel('Selling price ₹').fill('100')
  await form.getByLabel('MRP ₹').fill('120')
  await form.getByLabel('Cost ₹').fill('60')
  await form.getByLabel('Opening stock').fill('3')

  await form.getByTestId('track-units').check()
  const prefix = form.getByTestId('unit-prefix')
  await expect(prefix).not.toHaveValue('', { timeout: 10_000 }) // auto-suggested from the name
  await prefix.fill('spk')
  await expect(prefix).toHaveValue('SPK') // upper-cased
  await expect(form.getByTestId('unit-capacity')).toContainText('Next code: SPK-0001')
  await expect(form.getByTestId('unit-capacity')).toContainText('9,999')

  // invalid prefix: inline error, nothing saved
  await prefix.fill('S')
  await form.getByRole('button', { name: 'Save product' }).click()
  await expect(form.getByText(/at least 2 characters/)).toBeVisible()
  await prefix.fill('SPK')

  await form.getByRole('button', { name: 'Save product' }).click()
  // generated codes -> offer their labels straight away, with the size picker
  const labels = page.getByRole('dialog', { name: 'Print unit labels' })
  await expect(labels).toBeVisible({ timeout: 15_000 })
  await expect(labels.getByLabel('Label size')).toBeVisible()
  await expect(labels.getByTestId('label-unit-codes')).toContainText('SPK-0001')
  await expect(labels.getByTestId('label-unit-codes')).toContainText('SPK-0003')
  const preview = labels.frameLocator('iframe[title="Label preview"]')
  await expect(preview.locator('svg.barcode').first()).toBeVisible({ timeout: 10_000 })
  await expect(preview.locator('.code').first()).toHaveText('SPK-0001')
  await labels.getByLabel('Label size').selectOption('a4-3x8')
  await expect(preview.locator('svg.barcode')).toHaveCount(3, { timeout: 10_000 })
  await labels.locator('button.btn-default', { hasText: /^Close$/ }).click()

  const p = (await call('catalog', 'list', { search: 'Sparkler Pack' })).rows[0]
  productId = p.id
  expect(p.trackUnits).toBe(true)
  expect(p.unitPrefix).toBe('SPK')
  variantId = (await call('catalog', 'get', { id: productId })).variants[0].id
})

test('02 Units tab lists the codes with status, generate is guarded, print offers range choices', async () => {
  await page.getByPlaceholder(/Search name, SKU/).fill('Sparkler Pack')
  await expect(page.getByRole('row', { name: /Sparkler Pack/ })).toContainText('SPK-NNNN')
  await page.getByRole('row', { name: /Sparkler Pack/ }).click()
  const form = page.getByRole('dialog', { name: 'Edit product' })
  await expect(form.getByTestId('unit-prefix')).toBeDisabled() // locked once units exist
  await form.getByTestId('open-units').click()
  const panel = page.getByRole('dialog', { name: /Units - Sparkler Pack/ })
  await expect(panel.getByTestId('units-count-in_stock')).toContainText('3')
  for (const c of ['SPK-0001', 'SPK-0002', 'SPK-0003']) await expect(panel.getByRole('cell', { name: c })).toBeVisible()
  await panel.getByLabel('Search unit codes').fill('0002')
  await expect(panel.getByRole('cell', { name: 'SPK-0002' })).toBeVisible()
  await expect(panel.getByRole('cell', { name: 'SPK-0001' })).toHaveCount(0)
  await panel.getByLabel('Search unit codes').fill('')

  // every piece already has a code, so generating more is refused with a clear message
  await panel.getByRole('button', { name: 'Generate unit codes' }).click()
  const gen = page.getByRole('dialog', { name: 'Generate unit codes' })
  await gen.getByLabel('Number of units').fill('2')
  await gen.getByRole('button', { name: 'Generate' }).click()
  await expect(gen).toContainText(/without a unit code|unit limit|have stock/i)
  await gen.getByRole('button', { name: 'Cancel' }).click()

  await panel.getByRole('button', { name: 'Print unit labels' }).click()
  const pick = page.getByRole('dialog', { name: 'Print unit labels' }).last()
  await pick.getByLabel('Which units').selectOption('range')
  await pick.getByLabel('Range from').fill('2')
  await pick.getByLabel('Range to').fill('3')
  await pick.getByRole('button', { name: 'Choose label size…' }).click()
  const labels = page.getByRole('dialog', { name: 'Print unit labels' }).last()
  await expect(labels.getByTestId('label-unit-codes')).toContainText('SPK-0002')
  await expect(labels.getByTestId('label-unit-codes')).not.toContainText('SPK-0001')
  await expect(labels.getByLabel('Label size')).toBeVisible()
  await expect(labels.frameLocator('iframe[title="Label preview"]').locator('svg.barcode').first()).toBeVisible({ timeout: 10_000 })
})

test('03 count sheet: a unit code is counted once; scanning it again warns "duplicate"; unknown code says not found', async () => {
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  const c = await call('inventory', 'countCreate', {})
  countId = c.id
  await nav('Stock counts')
  await page.getByRole('row', { name: new RegExp(c.number) }).click()
  const box = page.getByLabel('Scan to count')
  await expect(box).toBeVisible()
  const result = page.getByTestId('count-scan-result')

  await box.fill('SPK-0001')
  await box.press('Enter')
  await expect(result).toContainText('SPK-0001')
  await expect(result).toHaveAttribute('data-ok', '1')

  await box.fill('spk-0001')
  await box.press('Enter')
  await expect(result).toContainText('Duplicate entry: SPK-0001 is already in this count sheet')
  await expect(result).toHaveAttribute('data-ok', '0')

  await box.fill('SPK-0002')
  await box.press('Enter')
  await expect(result).toHaveAttribute('data-ok', '1')

  await box.fill('SPK-9998')
  await box.press('Enter')
  await expect(result).toContainText('SPK-9998')
  await expect(result).toContainText(/not found/i)
  await expect(result).toHaveAttribute('data-ok', '0')

  // the sheet counted exactly 2 units (SPK-0001 once)
  const d = await call('inventory', 'countGet', { id: countId })
  expect(d.items.find((i: any) => i.variantId === variantId).countedQty).toBe(2)
})

test('04 label print queue: new unit code added, repeated one warns, unknown one is not found', async () => {
  await nav('Printing & Labels')
  await page.getByRole('tab', { name: 'Labels' }).click()
  const box = page.getByTestId('unit-queue-input')
  const msg = page.getByTestId('unit-queue-msg')
  await box.fill('SPK-0003')
  await box.press('Enter')
  await expect(msg).toContainText('SPK-0003 added')
  await expect(msg).toHaveAttribute('data-ok', '1')
  await box.fill('SPK-0003')
  await box.press('Enter')
  await expect(msg).toContainText('Duplicate entry: SPK-0003 is already in the label print queue')
  await expect(msg).toHaveAttribute('data-ok', '0')
  await box.fill('SPK-7777')
  await box.press('Enter')
  await expect(msg).toContainText('SPK-7777')
  await expect(msg).toContainText(/not found/i)
  await expect(page.getByTestId('unit-queue-list').locator('.badge')).toHaveCount(1)
  await page.getByRole('button', { name: 'Print unit labels…' }).click()
  const dlg = page.getByRole('dialog', { name: 'Print unit labels' })
  await expect(dlg.getByLabel('Label size')).toBeVisible()
})

test('05 purchase: tracked line gets auto-generated codes shown after save with Print labels; scanning a known unit is refused', async () => {
  await page.keyboard.press('Escape') // close the label dialog left open by the previous test
  await nav('Purchases')
  await page.getByRole('button', { name: 'New purchase' }).click()
  const find = page.getByLabel('Find product')
  await find.fill('Sparkler')
  await expect(page.getByRole('option', { name: /Sparkler Pack/ })).toBeVisible()
  await page.getByRole('option', { name: /Sparkler Pack/ }).dispatchEvent('mousedown')
  await page.getByLabel('Quantity Sparkler Pack').fill('2')
  await page.getByLabel('Unit cost Sparkler Pack').fill('60')
  // a unit that already exists is not received again
  await find.fill('SPK-0001')
  await find.press('Enter')
  await expect(page.getByText(/SPK-0001 is already a known unit/).first()).toBeVisible()
  await page.getByRole('button', { name: /Save & receive stock/ }).click()
  const dlg = page.getByRole('dialog', { name: /unit codes issued/ })
  await expect(dlg.getByTestId('received-codes')).toContainText('SPK-0004')
  await expect(dlg.getByTestId('received-codes')).toContainText('SPK-0005')
  await dlg.getByTestId('print-received-labels').click()
  const labels = page.getByRole('dialog', { name: 'Print unit labels' })
  await expect(labels.getByLabel('Label size')).toBeVisible()
  await expect(labels.getByTestId('label-unit-codes')).toContainText('SPK-0004')
})

test('06 no console errors', async () => {
  expect(consoleErrors.filter((e) => !/Autofill|ResizeObserver/.test(e))).toEqual([])
})

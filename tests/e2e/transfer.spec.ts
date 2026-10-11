/**
 * Real-UI end-to-end check of "Export everything" on one installation and "Import everything" on a brand-new one
 * (first-time setup screen), each with its own temporary data folder.
 * Run:  npm run build && npx playwright test -c tests/e2e/playwright.config.ts tests/e2e/transfer.spec.ts
 */
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(__dirname, '..', '..')
const dirA = mkdtempSync(join(tmpdir(), 'velmayil-e2e-xfer-a-'))
const dirB = mkdtempSync(join(tmpdir(), 'velmayil-e2e-xfer-b-'))
const usb = mkdtempSync(join(tmpdir(), 'velmayil-e2e-xfer-usb-'))
const FILE = join(usb, 'everything.vmove')
const errors: string[] = []

let app: ElectronApplication
let page: Page

async function launch(dataDir: string): Promise<void> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v
  env.VELMAYIL_DATA_DIR = dataDir
  app = await electron.launch({ args: [ROOT, `--user-data-dir=${join(dataDir, 'chromium-profile')}`], cwd: ROOT, env })
  page = await app.firstWindow()
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`))
  await page.waitForLoadState('domcontentloaded')
}
const call = async (service: string, method: string, args?: unknown): Promise<any> => {
  const r = await page.evaluate(([s, m, a]) => (window as any).velmayil.call(s, m, a), [service, method, args ?? {}] as const)
  if (!r.ok) throw new Error(`${service}.${method}: ${r.error?.code} ${r.error?.message}`)
  return r.data
}

test.describe.configure({ mode: 'serial' })

test('laptop A: export everything from the Backup & Sync page', async () => {
  await launch(dirA)
  await expect(page.getByText(/First-time setup/)).toBeVisible()
  await call('setup', 'complete', {
    shop: { shopName: 'Transfer Test Shop', address: '1 Main Road', city: 'Sivakasi', state: 'Tamil Nadu', pinCode: '626123', phone: '9876543210', gstin: '' },
    owner: { username: 'owner', name: 'Shop Owner', password: 'Owner@123' }, pos: { code: 'POS-01', name: 'Counter 1' }, locationName: 'Main Store'
  })
  await call('catalog', 'save', { name: 'Sparkler Box', trackUnits: true, unitPrefix: 'SPK', variants: [{ name: '', price: 12500, mrp: 12500, cost: 5000, openingStock: 4 }] })
  await call('catalog', 'save', { name: 'Match Box', variants: [{ name: '', price: 500, mrp: 500, cost: 200, openingStock: 30 }] })
  await page.reload()
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /Backup/ }).click()
  await page.getByRole('tab', { name: 'Set up another laptop' }).click()
  await app.evaluate(({ dialog }, p) => { dialog.showSaveDialog = (async () => ({ canceled: false, filePath: p })) as any }, FILE)
  await page.getByRole('button', { name: 'Export everything', exact: true }).click()
  await expect(page.getByText('File saved and checked')).toBeVisible({ timeout: 60_000 })
  await expect(page.getByText(FILE)).toBeVisible()
  expect(readdirSync(usb)).toEqual(['everything.vmove'])
  await app.close()
})

test('laptop B (brand new): import everything from the first-time setup screen, then sign in with laptop A\'s user', async () => {
  await launch(dirB)
  await expect(page.getByText(/First-time setup/)).toBeVisible()
  await page.getByRole('button', { name: 'Import everything from it' }).click()
  await app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [p] })) as any }, FILE)
  await page.getByRole('button', { name: /Choose the file/ }).click()
  await expect(page.getByText('The file is complete and undamaged')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText(/Transfer Test Shop/).first()).toBeVisible()
  await page.getByRole('button', { name: 'Continue' }).click()
  const go = page.getByRole('button', { name: /Replace this laptop/ })
  await expect(go).toBeDisabled()
  await page.getByLabel('Type REPLACE to confirm').fill('REPLACE')
  await go.click()
  await expect(page.getByText('Import complete and checked')).toBeVisible({ timeout: 60_000 })
  await expect(page.getByText('Same', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('Different', { exact: true })).toHaveCount(0)
  await expect(page.getByText(/This laptop is counter/)).toContainText('POS-02')
  await page.getByRole('dialog').getByRole('button', { name: 'Sign in' }).click()

  await page.getByLabel('Username').fill('owner')
  await page.getByLabel('Password', { exact: true }).fill('Owner@123')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible({ timeout: 20_000 })
  const units = await call('units', 'list', { limit: 50, offset: 0 })
  expect(units.total).toBe(4)
  const status = await call('sync', 'getStatus')
  expect(status.device.code).toBe('POS-02')
  // the in-app screen is there too and warns before replacing
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /Backup/ }).click()
  await page.getByRole('tab', { name: 'Set up another laptop' }).click()
  await page.getByRole('button', { name: /Import everything/ }).click()
  await expect(page.getByRole('dialog').getByText(/Nothing is changed until you confirm/)).toBeVisible()
  expect(errors).toEqual([])
  await app.close()
})

/**
 * Real-UI end-to-end walk of the BUILT app (out/). Serial: each step builds on the previous one.
 * Run:  npm run build && npx playwright test -c tests/e2e/playwright.config.ts
 */
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { deflateSync } from 'node:zlib'

const ROOT = resolve(__dirname, '..', '..')
const SHOTS = join(ROOT, 'docs', 'qa-screens')
mkdirSync(SHOTS, { recursive: true })

const SHOP = 'Sri Lakshmi Fireworks & Crackers Wholesale and Retail'
const NEW_SHOP = 'Velmayil Crackers Mart'
const dataDir = mkdtempSync(join(tmpdir(), 'velmayil-e2e-'))
const consoleErrors: string[] = []
const mainErrors: string[] = []
const notes: string[] = []

// ---- tiny PNG generator (valid, 200x100, red/white stripes)
function png(w: number, h: number): Buffer {
  const crcT: number[] = []
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0 }
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const chunk = (t: string, d: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]) }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2
  const rows: Buffer[] = []
  for (let y = 0; y < h; y++) { const r = Buffer.alloc(1 + w * 3); for (let x = 0; x < w; x++) { const red = Math.floor(x / 20) % 2 === 0; r[1 + x * 3] = red ? 200 : 255; r[2 + x * 3] = red ? 30 : 255; r[3 + x * 3] = red ? 30 : 255 } rows.push(r) }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))])
}
const LOGO = join(dataDir, 'qa-logo.png')
writeFileSync(LOGO, png(200, 100))

let app: ElectronApplication
let page: Page

async function launch(): Promise<void> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v
  env.VELMAYIL_DATA_DIR = dataDir
  // own Chromium profile dir: the single-instance lock is per userData, so a running installed copy of the app cannot block the test
  app = await electron.launch({ args: [ROOT, `--user-data-dir=${join(dataDir, 'chromium-profile')}`], cwd: ROOT, env })
  app.process().stderr?.on('data', (d) => mainErrors.push(String(d).trim()))
  app.on('console', (m) => { if (m.type() === 'error') mainErrors.push(`[main console] ${m.text()}`) })
  page = await app.firstWindow()
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`[${m.location().url.split('/').pop()}] ${m.text()}`) })
  page.on('pageerror', (e) => consoleErrors.push(`[pageerror] ${e.message}`))
  await page.waitForLoadState('domcontentloaded')
}
async function size(w: number, h: number): Promise<void> {
  await app.evaluate(({ BrowserWindow }, [W, H]) => { const win = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && x.isVisible()) ?? BrowserWindow.getAllWindows()[0]; win.setContentSize(W, H); win.center() }, [w, h])
  await page.waitForTimeout(400)
}
const shot = async (name: string) => { await page.screenshot({ path: join(SHOTS, `${name}.png`) }) }
const nav = async (label: string | RegExp) => {
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: label }).click()
  await page.waitForTimeout(500)
  if (String(label).includes('Billing')) await skipShift()
}
/** The POS offers "Open cash shift" a moment after the screen loads (can pop over a half-built cart). */
const skipShift = async () => {
  const skip = page.getByRole('button', { name: 'Skip for now' })
  if (await skip.isVisible({ timeout: 2500 }).catch(() => false)) { notes.push('Open-shift dialog appeared after POS load (can steal focus during a scan)'); await skip.click() }
}
const call = async (service: string, method: string, args?: unknown): Promise<any> => {
  const r = await page.evaluate(([s, m, a]) => (window as any).velmayil.call(s, m, a), [service, method, args ?? {}] as const)
  if (!r.ok) throw new Error(`${service}.${method}: ${r.error?.code} ${r.error?.message}`)
  return r.data
}

/** horizontal overflow check of the page (layout bug detector) */
async function overflow(label: string): Promise<void> {
  const r = await page.evaluate(() => {
    const d = document.documentElement
    const bad: string[] = []
    document.querySelectorAll('body *').forEach((el) => {
      const e = el as HTMLElement
      const cs = getComputedStyle(e)
      if (cs.display === 'none' || cs.visibility === 'hidden') return
      const b = e.getBoundingClientRect()
      if (b.width > 0 && b.right > window.innerWidth + 2 && !e.closest('[style*="overflow"],.table-wrap,.print-preview,iframe') && bad.length < 5) bad.push(`${e.tagName.toLowerCase()}.${(e.className || '').toString().slice(0, 30)} right=${Math.round(b.right)}`)
    })
    return { scrollW: d.scrollWidth, innerW: window.innerWidth, bad }
  })
  if (r.scrollW > r.innerW + 2 || r.bad.length) notes.push(`OVERFLOW ${label}: scrollWidth ${r.scrollW} > ${r.innerW}; ${r.bad.join(' | ')}`)
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  if (!existsSync(join(ROOT, 'out', 'main', 'index.js'))) throw new Error('Run `npm run build` first')
  await launch()
})
test.afterAll(async () => {
  writeFileSync(join(SHOTS, 'console-and-main-errors.json'), JSON.stringify({ consoleErrors, mainErrors, notes }, null, 2))
  await app?.close().catch(() => undefined)
})

test('01 first-run wizard', async () => {
  await size(1366, 768)
  await expect(page.getByText(/First-time setup/)).toBeVisible()
  await shot('01-wizard-step1')
  await page.getByLabel('Shop name *').fill(SHOP)
  await page.getByLabel('Address').fill('12, Cracker Street, Near Bus Stand')
  await page.getByLabel('City').fill('Sivakasi')
  await page.getByLabel('State').fill('Tamil Nadu')
  await page.getByLabel('PIN code').fill('626123')
  await page.getByLabel('Phone').fill('9876543210')
  await page.getByLabel('GSTIN').fill('33abcde1234f1z5')
  await page.getByRole('button', { name: 'Next' }).click()
  // owner step: validation first
  await page.getByRole('button', { name: 'Next' }).click()
  await expect(page.getByText('3-32 letters, digits, dot, dash or underscore')).toBeVisible()
  await page.getByLabel('Username *').fill('owner')
  await page.getByLabel('Your name').fill('Shop Owner')
  await page.getByLabel('Password *', { exact: true }).fill('Owner@123')
  await page.getByLabel('Confirm password *').fill('Owner@124')
  await page.getByRole('button', { name: 'Next' }).click()
  await expect(page.getByText('Passwords do not match')).toBeVisible()
  await page.getByLabel('Confirm password *').fill('Owner@123')
  await page.getByRole('button', { name: 'Next' }).click()
  await page.getByRole('button', { name: 'Next' }).click() // counter step defaults
  await expect(page.getByText('33ABCDE1234F1Z5')).toBeVisible()
  await shot('02-wizard-review')
  await page.getByRole('button', { name: 'Finish setup' }).click()
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible({ timeout: 20_000 })
  await shot('03-after-setup-dashboard')
})

test('02 shop profile: upload logo, edit, persists after relaunch', async () => {
  await nav('Shop Profile')
  await expect(page.getByLabel('Shop name *')).toHaveValue(SHOP)
  await expect(page.getByRole('textbox', { name: 'GSTIN' })).toHaveValue('33ABCDE1234F1Z5')
  await page.setInputFiles('input[type=file]', LOGO)
  await expect(page.getByAltText('Shop logo preview')).toBeVisible({ timeout: 15_000 })
  const dims = await page.getByAltText('Shop logo preview').evaluate((i: HTMLImageElement) => [i.naturalWidth, i.naturalHeight])
  expect(dims).toEqual([200, 100])
  await page.getByLabel('Email').fill('qa@example.com')
  await page.getByLabel('Bill footer text').fill('Thank you for shopping!')
  await page.getByRole('button', { name: 'Save profile' }).click()
  await expect(page.getByText('Shop profile saved')).toBeVisible()
  await shot('04-shop-profile-saved')
  await overflow('shop-profile-1366')
  // close and relaunch with the same data dir
  await app.close()
  await launch()
  await size(1366, 768)
  await expect(page.getByRole('heading', { name: /Sign in/ }).or(page.getByText('Sign in').first())).toBeVisible({ timeout: 20_000 })
  await shot('05-login-after-relaunch')
  await page.getByLabel('Username').fill('owner')
  await page.getByLabel('Password', { exact: true }).fill('Owner@123')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible()
  await nav('Shop Profile')
  await expect(page.getByLabel('Shop name *')).toHaveValue(SHOP)
  await expect(page.getByLabel('Email')).toHaveValue('qa@example.com')
  await expect(page.getByAltText('Shop logo preview')).toBeVisible()
  await shot('06-shop-profile-after-relaunch')
})

let barcode = ''
test('03 add a product via Products UI with generated barcode + opening stock', async () => {
  await nav('Products')
  await page.getByRole('button', { name: '+ Add product' }).click()
  await page.getByLabel('Product name').fill('QA Sparkler Deluxe')
  await page.getByLabel('HSN code').fill('3604')
  await page.locator('select:has(option[value="custom"])').selectOption('18')
  await page.getByRole('button', { name: 'Generate', exact: true }).click()
  await page.waitForTimeout(500)
  barcode = await page.getByLabel('Barcode (scan or type)').inputValue()
  expect(barcode).toMatch(/^200\d{6}$/) // default numbering: fixed prefix 200 + 6-digit running number
  await page.getByLabel('MRP ₹').fill('150')
  await page.getByLabel('Selling price ₹').fill('118')
  await page.getByLabel('Cost ₹').fill('70')
  await page.getByLabel('Opening stock').fill('25')
  await shot('07-product-form')
  await page.getByRole('button', { name: 'Save product' }).click()
  await expect(page.getByText('QA Sparkler Deluxe').first()).toBeVisible({ timeout: 10_000 })
  const lookup = await call('pos', 'scan', { code: barcode })
  expect(lookup.price).toBe(11800)
  expect(lookup.stock).toBe(25)
  await shot('08-products-list')
})

test('03b Generate barcode -> label size dialog -> 50x25 preview shows the barcode; replacing asks first', async () => {
  const saved = await call('catalog', 'save', { name: 'QA Label Item', hsn: '3604', taxRateBp: 1800, variants: [{ name: '', mrp: 9900, price: 8500, cost: 5000, openingStock: 3 }] })
  const variantId = saved.variants[0].id
  expect(saved.variants[0].barcode).toBeFalsy()
  await nav('Products')
  await page.getByPlaceholder(/Search name, SKU/).fill('QA Label')
  await page.waitForTimeout(700)
  await page.getByText('QA Label Item').first().click()
  await expect(page.getByLabel('Product name')).toHaveValue('QA Label Item')
  await page.getByRole('button', { name: 'Generate', exact: true }).click()
  const dlg = page.getByRole('dialog', { name: 'Print barcode label' })
  await expect(dlg).toBeVisible({ timeout: 15_000 })
  await expect(dlg.getByLabel('Label size')).toBeVisible()
  await dlg.getByLabel('Label size').selectOption('50x25')
  const digits = (await dlg.getByTestId('label-barcode').innerText()).trim()
  expect(digits).toMatch(/^200\d{6}$/)
  // saved on the variant right away
  expect((await call('catalog', 'get', { id: saved.id })).variants[0].barcode).toBe(digits)
  const frame = page.frameLocator('iframe[title="Label preview"]')
  // a stock-tracked product: every label carries its OWN 10-digit number (4-digit prefix + 6-digit suffix), not the shared product barcode
  await expect(frame.locator('.code').first()).toHaveText(/^[1-9]\d{9}$/, { timeout: 15_000 })
  await expect(frame.locator('.pname')).toContainText('QA Label Item')
  await expect(frame.locator('.shop-name').first()).toContainText(/Sri Lakshmi|Velmayil/)
  await expect(frame.locator('svg.barcode')).toBeVisible()
  const box = await page.locator('iframe[title="Label preview"]').evaluate((f: HTMLIFrameElement) => { const l = f.contentDocument!.querySelector('.label') as HTMLElement; const r = l.getBoundingClientRect(); return { w: r.width, h: r.height } })
  expect(Math.round(box.w)).toBe(Math.round((50 * 96) / 25.4))
  // the label box is 0.5 mm shorter than the label so a driver page that is a hair short never spills onto a blank label
  expect(Math.round(box.h)).toBe(Math.round((24.5 * 96) / 25.4))
  await shot('07b-label-dialog-50x25')
  // other sizes re-render; the choice is remembered per user
  await dlg.getByLabel('Label size').selectOption('a4-3x8')
  await expect(frame.locator('.sheet')).toBeVisible({ timeout: 15_000 })
  await dlg.getByLabel('Label size').selectOption('50x25')
  // printing: with a label printer that cannot print the dialog never loses the barcode and offers Retry / Save PDF
  await call('printing', 'savePrinterProfile', { name: 'QA label', deviceName: 'OneNote (Desktop)', kind: 'label', isDefault: true })
  await dlg.getByRole('button', { name: /^Print \d+ label/ }).click()
  const outcome = await Promise.race([
    page.getByText(/sent to the printer/).first().waitFor({ timeout: 25_000 }).then(() => 'sent'),
    dlg.getByRole('button', { name: 'Retry' }).waitFor({ timeout: 25_000 }).then(() => 'failed')
  ]).catch(() => 'timeout')
  notes.push(`Label print outcome with virtual OneNote printer: ${outcome}`)
  expect(['sent', 'failed']).toContain(outcome)
  if (outcome === 'failed') await expect(dlg.getByRole('button', { name: 'Save PDF' }).first()).toBeVisible()
  await shot('07c-label-after-print')
  if (await dlg.isVisible().catch(() => false)) await dlg.locator('footer').getByRole('button', { name: 'Close' }).click()
  // Generate again: the item already has a barcode -> asks before replacing (cancel keeps it)
  const form = page.getByRole('dialog', { name: 'Edit product' })
  await expect(form).toBeVisible()
  page.once('dialog', (d) => { expect(d.message()).toContain(digits); void d.dismiss() })
  await form.getByRole('button', { name: 'Generate', exact: true }).click()
  await page.waitForTimeout(600)
  expect((await call('catalog', 'get', { id: saved.id })).variants[0].barcode).toBe(digits)
  await expect(page.getByRole('dialog', { name: 'Print barcode label' })).toBeHidden()
  // confirming replaces it; the old number stays scannable (alias)
  page.once('dialog', (d) => void d.accept())
  await form.getByRole('button', { name: 'Generate', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Print barcode label' })).toBeVisible({ timeout: 15_000 })
  const next = (await page.getByTestId('label-barcode').innerText()).trim()
  expect(next).not.toBe(digits)
  expect((await call('catalog', 'get', { id: saved.id })).variants[0].barcode).toBe(next)
  expect((await call('pos', 'scan', { code: digits })).variantId ?? variantId).toBe(variantId)
  await page.getByRole('dialog', { name: 'Print barcode label' }).locator('footer').getByRole('button', { name: 'Close' }).click()
  await form.locator('footer').getByRole('button', { name: 'Cancel' }).click()
})

test('04 POS: scan barcode, cash sale, success panel, Print A5 path', async () => {
  // real (OS) printing needs a printer: route all paper kinds to a harmless virtual printer
  for (const kind of ['receipt58', 'receipt80', 'a4', 'a5']) await call('printing', 'savePrinterProfile', { name: `QA ${kind}`, deviceName: 'OneNote (Desktop)', kind, isDefault: true })
  await nav(/Billing/)
  await skipShift()
  const scan = page.getByLabel('Scan or search products')
  await scan.fill(barcode)
  await scan.press('Enter')
  await expect(page.getByText('QA Sparkler Deluxe').first()).toBeVisible()
  await expect(page.getByText('₹118.00').first()).toBeVisible()
  await shot('09-pos-cart')
  await page.getByRole('button', { name: /^Pay/ }).click()
  await page.getByRole('button', { name: /Complete sale/ }).click()
  await expect(page.getByText('Sale completed')).toBeVisible({ timeout: 15_000 })
  const inv = (await page.locator('.pos-success .big').innerText()).trim()
  expect(inv).toMatch(/^INV-\d{4}-\d{6}$/)
  notes.push(`POS sale invoice shown in success panel: ${inv}`)
  await shot('10-pos-success')
  const a5 = page.getByRole('button', { name: 'Print A5' })
  await expect(a5).toBeVisible()
  await a5.click()
  const outcome = await Promise.race([
    page.getByText('Sent to printer').waitFor({ timeout: 25_000 }).then(() => 'sent'),
    page.getByText(/Printing failed/).first().waitFor({ timeout: 25_000 }).then(() => 'failed')
  ]).catch(() => 'timeout')
  notes.push(`Print A5 outcome with virtual OneNote printer: ${outcome}`)
  await shot('11-pos-after-print-a5')
  // the sale exists exactly once regardless of print outcome
  const sales = await call('pos', 'listSales', { search: inv })
  expect(sales.total).toBe(1)
  expect(sales.rows[0].total).toBe(11800)
  await page.getByRole('dialog').getByRole('button', { name: /New bill/ }).click()
})

test('05 change price in Products UI; OLD barcode now charges NEW price at POS', async () => {
  await nav('Products')
  await page.getByPlaceholder(/Search name, SKU/).fill('QA Sparkler')
  await page.waitForTimeout(600)
  await page.getByText('QA Sparkler Deluxe').first().click()
  await expect(page.getByLabel('Product name')).toHaveValue('QA Sparkler Deluxe')
  await expect(page.getByLabel('Barcode (scan or type)')).toHaveValue(barcode)
  await page.getByLabel('Selling price ₹').fill('141.60')
  await page.getByRole('button', { name: 'Save product' }).click()
  await page.waitForTimeout(800)
  await nav(/Billing/)
  await skipShift()
  const scan = page.getByLabel('Scan or search products')
  await scan.fill(barcode)
  await scan.press('Enter')
  await expect(page.getByText('₹141.60').first()).toBeVisible({ timeout: 10_000 })
  await shot('12-pos-new-price')
  await page.getByRole('button', { name: /^Pay/ }).click()
  await page.getByRole('button', { name: /Complete sale/ }).click()
  await expect(page.getByText('Sale completed')).toBeVisible({ timeout: 15_000 })
  const row = await call('pos', 'listSales', { limit: 1 })
  expect(row.rows[0].total).toBe(14200) // 141.60 rounded to the rupee
  await page.getByRole('dialog').getByRole('button', { name: /New bill/ }).click()
})

test('06 Printing page: preview iframe has shop name + logo; test print preview; rename updates preview', async () => {
  await nav(/Printing/)
  const frame = () => page.frameLocator('iframe[title="Print preview"]')
  await expect(frame().locator('.shop-name').first()).toContainText('Sri Lakshmi Fireworks', { timeout: 15_000 })
  await expect(frame().locator('img.logo').first()).toBeVisible()
  const loaded = await page.locator('iframe[title="Print preview"]').evaluate((f: HTMLIFrameElement) => { const i = f.contentDocument?.querySelector('img.logo') as HTMLImageElement | null; return !!i && i.complete && i.naturalWidth > 0 })
  expect(loaded).toBe(true)
  const m = await page.locator('iframe[title="Print preview"]').evaluate((f: HTMLIFrameElement) => { const d = f.contentDocument!.documentElement; return { docScrollW: d.scrollWidth, docClientW: d.clientWidth, docScrollH: d.scrollHeight, frameH: f.clientHeight, frameW: f.clientWidth } })
  notes.push(`58mm preview iframe metrics: ${JSON.stringify(m)}`)
  await shot('13-printing-templates')
  for (const [val, nm] of [['receipt80', '80'], ['invoiceA4', 'a4'], ['invoiceA5', 'a5']] as const) {
    await page.locator('select').first().selectOption(val)
    await page.waitForTimeout(1200)
    const mm = await page.locator('iframe[title="Print preview"]').evaluate((f: HTMLIFrameElement) => { const d = f.contentDocument!.documentElement; return { docScrollW: d.scrollWidth, docClientW: d.clientWidth, docScrollH: d.scrollHeight, frameH: f.clientHeight, frameW: f.clientWidth } })
    notes.push(`${val} preview iframe metrics: ${JSON.stringify(mm)}`)
    await shot(`13b-printing-preview-${nm}`)
  }
  await page.locator('select').first().selectOption('receipt58')
  await overflow('printing-1366')
  // test print tab (preview only: dry run)
  await page.getByRole('tab', { name: 'Test print' }).click()
  await page.getByRole('button', { name: 'Preview' }).first().click()
  await expect(page.frameLocator('iframe[title="Print preview"]').locator('body')).toContainText('Sri Lakshmi', { timeout: 15_000 })
  await shot('14-printing-test-print')
  // rename the shop
  await nav('Shop Profile')
  await page.getByLabel('Shop name *').fill(NEW_SHOP)
  await page.getByLabel('Name printed on bills').fill(NEW_SHOP)
  await page.getByRole('button', { name: 'Save profile' }).click()
  await expect(page.getByText('Shop profile saved')).toBeVisible()
  await nav(/Printing/)
  await expect(page.frameLocator('iframe[title="Print preview"]').locator('.shop-name').first()).toContainText(NEW_SHOP, { timeout: 15_000 })
  await shot('15-printing-after-rename')
})

test('07 Sales history: reprint keeps original name; return flow', async () => {
  await nav('Sales history')
  await expect(page.getByText('INV-').first()).toBeVisible()
  await shot('16-sales-history')
  await page.getByText(/INV-\d{4}-000001/).first().click()
  await expect(page.getByText(/^Invoice INV-/)).toBeVisible()
  await shot('17-sale-detail')
  // reprint document content must carry the ORIGINAL shop name
  const html = await call('printing', 'renderInvoiceHtml', { saleId: 1, template: 'receipt80' })
  expect(html.html).toContain('Sri Lakshmi Fireworks')
  expect(html.html).not.toContain(NEW_SHOP)
  await page.getByRole('button', { name: /Return items/ }).click()
  await page.getByLabel(/Return quantity for/).fill('1')
  await page.getByLabel('Reason (required)').fill('QA return')
  await shot('18-return-dialog')
  await page.getByRole('button', { name: /^Refund about/ }).click()
  await expect(page.getByText(/RET-|Return|refund/i).first()).toBeVisible({ timeout: 10_000 })
  await page.waitForTimeout(800)
  await shot('19-after-return')
  const s = await call('pos', 'getSale', { id: 1 })
  expect(s.returns).toHaveLength(1)
  expect(s.returns[0].total).toBe(11800)
  expect((await call('pos', 'scan', { code: barcode })).stock).toBe(24) // 25 - 2 sold + 1 returned
  await page.locator('button.btn-default', { hasText: /^Close$/ }).click()
})

test('08 Reports page shows the right total', async () => {
  await nav('Reports')
  await page.getByRole('navigation', { name: 'Reports' }).getByText('Sales summary').click()
  await page.getByRole('button', { name: 'Run report' }).click()
  await page.waitForTimeout(1200)
  await shot('20-reports-sales-summary')
  // 118.00 + 142.00 sold = 260.00, returns 118.00
  const tableText = await page.locator('table').first().innerText()
  expect(tableText).toContain('260.00')
  expect(tableText).toContain('118.00')
  await overflow('reports-1366')
})

test('09 Backup page creates a backup', async () => {
  await nav(/Backup/)
  await page.getByRole('button', { name: 'Back up now' }).click()
  await expect(page.getByText(/Backup created and verified/)).toBeVisible({ timeout: 30_000 })
  await shot('21-backup')
  const b = await call('backup', 'list')
  expect(b.length).toBeGreaterThan(0)
  expect(b[0].verified).toBe(true)
})

test('10 Settings + Users pages load; dashboard; layout at 1920x1080', async () => {
  await nav('Settings')
  await expect(page.getByText(/Settings/).first()).toBeVisible()
  await shot('22-settings')
  await nav(/Users/)
  await expect(page.getByText('owner').first()).toBeVisible()
  await shot('23-users')
  await size(1920, 1080)
  for (const [label, name] of [[/Dashboard/, 'dashboard'], [/Billing/, 'pos'], ['Products', 'products'], ['Shop Profile', 'profile'], [/Printing/, 'printing'], ['Reports', 'reports']] as const) {
    await nav(label)
    await page.waitForTimeout(700)
    await shot(`30-1920-${name}`)
    await overflow(`${name}-1920`)
  }
  await size(1366, 768)
  for (const [label, name] of [[/Dashboard/, 'dashboard'], [/Billing/, 'pos'], ['Products', 'products'], [/Printing/, 'printing'], ['Sales history', 'history'], ['Settings', 'settings'], [/Users/, 'users'], [/Backup/, 'backup']] as const) {
    await nav(label)
    await page.waitForTimeout(700)
    await shot(`31-1366-${name}`)
    await overflow(`${name}-1366`)
  }
  await size(1024, 700)
  for (const [label, name] of [[/Billing/, 'pos'], ['Shop Profile', 'profile']] as const) {
    await nav(label)
    await page.waitForTimeout(500)
    await shot(`32-1024-${name}`)
    await overflow(`${name}-1024`)
  }
})

test('11 logout and login again', async () => {
  await size(1366, 768)
  await page.getByRole('button', { name: 'Account menu' }).click()
  await page.getByRole('menuitem', { name: /Sign out/ }).click()
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible({ timeout: 10_000 })
  await shot('40-logged-out')
  await page.getByLabel('Username').fill('owner')
  await page.getByLabel('Password', { exact: true }).fill('wrong-password')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('alert')).toBeVisible()
  await shot('41-login-wrong-password')
  await page.getByLabel('Password', { exact: true }).fill('Owner@123')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible()
})

test('99 no unexpected renderer/main errors', async () => {
  console.log('NOTES:\n' + notes.join('\n'))
  console.log('RENDERER CONSOLE ERRORS:', JSON.stringify(consoleErrors, null, 1))
  console.log('MAIN STDERR:', JSON.stringify(mainErrors, null, 1))
  expect.soft(consoleErrors, 'renderer console errors').toEqual([])
  expect.soft(mainErrors.filter((m) => !/ExperimentalWarning|trace-warnings|DeprecationWarning|Debugger ending|learn\/getting-started\/debugging/.test(m)), 'main-process errors').toEqual([])
})

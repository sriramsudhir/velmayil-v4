/**
 * Quantity of bill lines on the Billing screen of the BUILT app (out/): "+", "-", a typed quantity, for plain products and
 * for products with unit codes / label numbers, whichever way the line got on the bill (unit code scan, product barcode,
 * "3*BARCODE", picked by name). Every tracked line must keep qty == number of unit codes, and the sale must sell exactly them.
 *
 * Run:  SCAN_E2E_MODE=cdp npx playwright test -c tests/e2e/playwright.config.ts pos-qty.spec.ts
 */
import { test, expect, _electron as electron, type ElectronApplication, type Page, type Locator } from '@playwright/test'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(__dirname, '..', '..')
const dataDir = mkdtempSync(join(tmpdir(), 'velmayil-pos-qty-'))
const consoleErrors: string[] = []

let app: ElectronApplication
let page: Page

interface Prod { name: string; barcode: string; productId: number; variantId: number; codes: string[]; sold: string[] }
const PLAIN = { name: 'Plain Matchbox', barcode: '8901234567890', price: 5000 }
const P: Record<string, Prod> = {}
let shopLabelled: string[] = []

const call = async (service: string, method: string, args?: unknown): Promise<any> => {
  const r = await page.evaluate(([s, m, a]) => (window as any).velmayil.call(s, m, a), [service, method, args ?? {}] as const)
  if (!r.ok) throw new Error(`${service}.${method}: ${r.error?.code} ${r.error?.message}`)
  return r.data
}
const scanBox = () => page.getByLabel('Scan or search products')
const warning = () => page.getByTestId('unit-warning')
const blurAll = () => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())

interface Line { name: string; qty: number; chips: string[]; more: number; total: string }
const cart = (): Promise<Line[]> =>
  page.evaluate(() =>
    [...document.querySelectorAll('.pos-cart tbody tr')].map((tr) => ({
      name: tr.querySelector('td:nth-child(2) strong')?.textContent ?? '',
      qty: Number((tr.querySelector('input[aria-label="Quantity"]') as HTMLInputElement).value),
      chips: [...tr.querySelectorAll('[data-unit]')].map((e) => e.getAttribute('data-unit') ?? ''),
      more: Number((tr.querySelector('[data-testid="unit-more"]')?.textContent ?? '').replace(/\D/g, '') || 0),
      total: tr.querySelector('td:nth-child(6)')?.textContent ?? ''
    }))
  )
const lineCount = async () => (await cart()).length
const qtys = async () => (await cart()).map((l) => l.qty)
const chipsOf = async (name: string) => (await cart()).find((l) => l.name === name)?.chips ?? []
const qtyOf = async (name: string) => (await cart()).find((l) => l.name === name)?.qty ?? 0
const grand = async () => ((await page.locator('.pos-grand').innerText()).replace(/\s+/g, ' '))
const itemsCount = async () => Number((await page.locator('.pos-totals > div').first().innerText()).replace(/\D/g, ''))

/** qty of every tracked line equals its number of unit codes, and no code is on the bill twice */
async function expectConsistent(where: string): Promise<void> {
  const lines = await cart()
  const all: string[] = []
  for (const l of lines) {
    if (!l.chips.length) continue
    expect(l.qty, `${where}: ${l.name} qty equals its unit codes (${l.chips.join(',')} +${l.more})`).toBe(l.chips.length + l.more)
    all.push(...l.chips)
  }
  expect(new Set(all).size, `${where}: no unit code twice on the bill (${all.join(',')})`).toBe(all.length)
}

const row = (name: string): Locator => page.locator('.pos-cart tbody tr').filter({ hasText: name })
const plus = (name: string) => row(name).getByRole('button', { name: 'Increase quantity' })
const minus = (name: string) => row(name).getByRole('button', { name: 'Decrease quantity' })
const qtyBox = (name: string) => row(name).getByLabel('Quantity', { exact: true })

/** A reader scan (or a code typed) into the focused scan box, then Enter. */
async function scan(code: string): Promise<void> {
  await scanBox().focus()
  await scanBox().fill('')
  await page.keyboard.type(code, { delay: 5 })
  await page.keyboard.press('Enter')
}
/** A keyboard-wedge reader scan with the focus wherever it is now (not moved to the scan box). */
async function wedgeScan(code: string): Promise<void> {
  await page.keyboard.type(code, { delay: 5 })
  await page.keyboard.press('Enter')
}
/** Type a quantity like a cashier: click the box, select all, type the digits, then Enter or Tab away. */
async function typeQty(name: string, text: string, end: 'Enter' | 'Tab' = 'Enter'): Promise<void> {
  const box = qtyBox(name)
  await box.click()
  await page.keyboard.press('Control+A')
  if (text === '') await page.keyboard.press('Backspace')
  else await page.keyboard.type(text, { delay: 90 })
  await page.waitForTimeout(120)
  await page.keyboard.press(end)
}
async function clearToasts(): Promise<void> {
  for (let i = 0; i < 12; i++) {
    const x = page.locator('.toast .toast-x').first()
    if (!(await x.isVisible().catch(() => false))) break
    await x.click().catch(() => undefined)
  }
}
const stockToast = () => page.locator('.toast').filter({ hasText: /in stock/ }).first()

async function freshBill(): Promise<void> {
  const dlgNew = page.getByRole('dialog').getByRole('button', { name: /New bill/ })
  if (await dlgNew.isVisible().catch(() => false)) await dlgNew.click()
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /Billing/ }).click()
  await page.waitForTimeout(400)
  const skip = page.getByRole('button', { name: 'Skip for now' })
  if (await skip.isVisible({ timeout: 1200 }).catch(() => false)) await skip.click()
  await expect(scanBox()).toBeVisible()
  if ((await lineCount()) > 0) {
    await page.getByRole('button', { name: /New bill/ }).click()
    await page.getByRole('button', { name: 'Clear bill' }).click()
  }
  await expect.poll(lineCount).toBe(0)
  const dismiss = warning().getByRole('button', { name: 'Dismiss' })
  if (await dismiss.isVisible().catch(() => false)) await dismiss.click()
  await clearToasts()
  await scanBox().focus()
  await page.waitForTimeout(100)
}

const stockOf = async (barcode: string): Promise<number> => (await call('inventory', 'lookup', { code: barcode })).qtyAtLocation
const unitCodes = async (variantId: number, status: string): Promise<string[]> =>
  ((await call('units', 'list', { variantId, status, limit: 500 })).rows as { code: string }[]).map((r) => r.code).sort()

async function makeTracked(key: string, name: string, barcode: string, stock: number, prefix: string): Promise<void> {
  const saved = await call('catalog', 'save', { name, hsn: '3604', taxRateBp: 0, variants: [{ name: '', mrp: 10000, price: 10000, cost: 5000, openingStock: stock, barcode }] })
  await call('units', 'setTracking', { productId: saved.id, trackUnits: true, prefix, backfill: true })
  const codes = await unitCodes(saved.variants[0].id, 'in_stock')
  expect(codes, `${name} unit codes`).toHaveLength(stock)
  P[key] = { name, barcode, productId: saved.id, variantId: saved.variants[0].id, codes, sold: [] }
}

/**
 * Pay cash, complete the sale and check the books: stock dropped by the quantity, exactly the billed unit codes are sold,
 * the ledger is consistent. `expectCodes` = the codes the bill showed (all of them when the line shows at most 6).
 */
async function payAndVerify(p: Prod, qty: number, shown: string[], allShown: boolean): Promise<string[]> {
  await expectConsistent('before pay')
  const before = await stockOf(p.barcode)
  await page.getByRole('button', { name: /^Pay/ }).click()
  await page.getByRole('button', { name: /Complete sale/ }).click()
  await expect(page.getByText('Sale completed')).toBeVisible({ timeout: 15_000 })
  const soldNow = (await unitCodes(p.variantId, 'sold')).filter((c) => !p.sold.includes(c))
  expect(soldNow.length, `${p.name}: number of unit codes marked sold`).toBe(qty)
  if (allShown) expect(soldNow, `${p.name}: exactly the billed codes are sold`).toEqual([...shown].sort())
  else for (const c of shown) expect(soldNow, `${p.name}: shown code ${c} is sold`).toContain(c)
  for (const c of shown) await expect(page.getByTestId('sold-units')).toContainText(c)
  expect(await stockOf(p.barcode), `${p.name}: stock after the sale`).toBe(before - qty)
  expect((await unitCodes(p.variantId, 'in_stock')).length, `${p.name}: in-stock unit codes == stock`).toBe(before - qty)
  expect((await call('inventory', 'verifyLedger')).ok, 'inventory.verifyLedger').toBe(true)
  p.sold.push(...soldNow)
  await page.getByRole('dialog').getByRole('button', { name: /New bill/ }).click()
  await expect.poll(lineCount).toBe(0)
  return soldNow
}

/** a sold unit code scanned again is refused */
async function expectSoldRefused(code: string): Promise<void> {
  await scan(code)
  await expect(warning()).toBeVisible()
  await expect(page.getByTestId('unit-warning-text')).toContainText(`${code} is already sold`)
  expect(await lineCount()).toBe(0)
}

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
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setContentSize(1400, 860); w.show(); w.focus() })
  await call('setup', 'complete', { shop: { shopName: 'Qty Test Shop' }, owner: { username: 'owner', name: 'Owner', password: 'Owner@123' }, pos: {}, locationName: 'Main Store' })
  await page.reload()
  const signIn = page.getByRole('button', { name: 'Sign in' })
  if (await signIn.isVisible({ timeout: 4000 }).catch(() => false)) {
    await page.getByLabel('Username').fill('owner')
    await page.getByLabel('Password', { exact: true }).fill('Owner@123')
    await signIn.click()
  }
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible({ timeout: 20_000 })

  await page.evaluate(() => {
    const w = window as any
    w.__log = []
    const d = (e: EventTarget | null) => (e instanceof Element ? `${e.tagName}[${e.getAttribute('aria-label') ?? (e.textContent ?? '').slice(0, 12)}]@${e.closest('tr')?.querySelector('strong')?.textContent ?? ''}` : 'null')
    const L = (t: string) => { w.__log.push(`${performance.now().toFixed(0)} ${t}`); if (w.__log.length > 600) w.__log.splice(0, 200) }
    document.addEventListener('focusin', (e) => L(`focusin ${d(e.target)}`), true)
    document.addEventListener('keydown', (e) => L(`keydown ${e.key} -> ${d(e.target)}`), true)
    document.addEventListener('mousedown', (e) => L(`mousedown -> ${d(e.target)}`), true)
    document.addEventListener('input', (e) => L(`input -> ${d(e.target)} value=${(e.target as HTMLInputElement).value}`), true)
  })

  await call('catalog', 'save', { name: PLAIN.name, hsn: '3604', taxRateBp: 0, variants: [{ name: '', mrp: PLAIN.price, price: PLAIN.price, cost: 2000, openingStock: 50, barcode: PLAIN.barcode }] })
  await makeTracked('scan', 'Sparkler Scanned', '8900000001019', 6, 'SPK')
  await makeTracked('bar', 'Rocket Barcoded', '8900000002016', 8, 'RKT')
  await makeTracked('name', 'Chakra Byname', '8900000003013', 8, 'CHK')
  await makeTracked('mix', 'Bijili Mixed', '8900000004010', 6, 'BJL')
  await makeTracked('hold', 'Fountain Held', '8900000005017', 6, 'FNT')
  await makeTracked('many', 'Garland Many', '8900000006014', 12, 'GRL')
  await makeTracked('chip', 'Pencil Chipped', '8900000007011', 5, 'PNC')
  await makeTracked('focus', 'Whistle Focus', '8900000008018', 8, 'WHS')
  await makeTracked('move', 'Lakshmi Moving', '8900000009015', 8, 'LKS')
  await makeTracked('disc', 'Atom Discounted', '8900000010011', 8, 'ATM')
  await makeTracked('pay', 'Deluxe Paynow', '8900000011018', 8, 'DLX')

  // the way the shop really does it: an ordinary product with a shared barcode, then unique label numbers printed for SOME pieces
  const shop = await call('catalog', 'save', { name: 'Flower Pot Deluxe', hsn: '3604', taxRateBp: 0, variants: [{ name: '', mrp: 10000, price: 10000, cost: 5000, openingStock: 8, barcode: '200000777' }] })
  const issued = await call('units', 'issueLabels', { items: [{ variantId: shop.variants[0].id, count: 3 }], receiveExtra: false })
  shopLabelled = [...(issued.items[0].codes as string[])].sort()
  expect(shopLabelled).toHaveLength(3)
  const all = await unitCodes(shop.variants[0].id, 'in_stock')
  expect(all).toHaveLength(8)
  P.shop = { name: 'Flower Pot Deluxe', barcode: '200000777', productId: shop.id, variantId: shop.variants[0].id, codes: all, sold: [] }
  const rows = (await call('units', 'list', { variantId: P.shop.variantId, limit: 500 })).rows as { code: string; labelPrintedAt: number | null }[]
  expect(rows.filter((r) => r.labelPrintedAt != null).map((r) => r.code).sort()).toEqual(shopLabelled)
  console.log(`[pos-qty] shop product: labelled ${shopLabelled.join(', ')}; all ${all.join(', ')}`)
})
/** On a failure: print the last key / focus / click events of the renderer and the bill, so a timing problem can be told from a real bug. */
test.afterEach(async ({}, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus || !page) return
  const log = await page.evaluate(() => ((window as any).__log as string[] | undefined)?.slice(-160) ?? []).catch(() => [])
  console.log(`[pos-qty] "${testInfo.title}" failed. Bill: ${JSON.stringify(await cart().catch(() => null))}\n  scan box: ${JSON.stringify(await scanBox().inputValue().catch(() => null))}\n  last events:\n  ${log.join('\n  ')}`)
})
test.afterAll(async () => {
  await app?.close().catch(() => undefined)
})

test('01 plain product: scan, + + -, typed 7, 0 / empty keep the quantity, totals follow', async () => {
  await freshBill()
  await scan(PLAIN.barcode)
  await expect.poll(qtys).toEqual([1])
  expect(await chipsOf(PLAIN.name)).toEqual([])
  await expect(minus(PLAIN.name)).toBeDisabled()
  await plus(PLAIN.name).click()
  await plus(PLAIN.name).click()
  await expect.poll(qtys).toEqual([3])
  await minus(PLAIN.name).click()
  await expect.poll(qtys).toEqual([2])
  expect(await grand()).toContain('100.00')
  expect(await itemsCount()).toBe(2)

  await typeQty(PLAIN.name, '7')
  await expect.poll(qtys).toEqual([7])
  await expect(qtyBox(PLAIN.name)).toHaveValue('7')
  expect(await grand()).toContain('350.00')
  expect((await cart())[0].total).toContain('350.00')
  expect(await itemsCount()).toBe(7)

  await typeQty(PLAIN.name, '0')
  await expect(qtyBox(PLAIN.name)).toHaveValue('7')
  expect(await qtys()).toEqual([7])
  await typeQty(PLAIN.name, '', 'Tab')
  await expect(qtyBox(PLAIN.name)).toHaveValue('7')
  expect(await grand()).toContain('350.00')

  // two digits, committed keystroke by keystroke
  await typeQty(PLAIN.name, '12')
  await expect.poll(qtys).toEqual([12])
  expect(await grand()).toContain('600.00')
  // a second scan of the same barcode still just adds one; "3*" adds three
  await scan(PLAIN.barcode)
  await expect.poll(qtys).toEqual([13])
  await scan(`3*${PLAIN.barcode}`)
  await expect.poll(qtys).toEqual([16])
  await minus(PLAIN.name).click()
  await expect.poll(qtys).toEqual([15])

  const before = await stockOf(PLAIN.barcode)
  await page.getByRole('button', { name: /^Pay/ }).click()
  await page.getByRole('button', { name: /Complete sale/ }).click()
  await expect(page.getByText('Sale completed')).toBeVisible({ timeout: 15_000 })
  expect(await stockOf(PLAIN.barcode)).toBe(before - 15)
  expect((await call('inventory', 'verifyLedger')).ok).toBe(true)
})

test('02 tracked, scanned unit code: + / quick double + / - / typed quantity / above stock; sale sells exactly the codes', async () => {
  const p = P.scan
  await freshBill()
  await scan(p.codes[2])
  await expect.poll(() => chipsOf(p.name)).toEqual([p.codes[2]])
  expect(await qtys()).toEqual([1])
  await expect(minus(p.name)).toBeDisabled()
  await expect(plus(p.name)).toBeEnabled()

  await plus(p.name).click()
  await expect.poll(qtys).toEqual([2])
  let chips = await chipsOf(p.name)
  expect(chips[0]).toBe(p.codes[2])
  expect(chips[1]).not.toBe(p.codes[2])
  expect(p.codes).toContain(chips[1])
  await expectConsistent('after +')

  await plus(p.name).dblclick()
  await expect.poll(qtys).toEqual([4])
  chips = await chipsOf(p.name)
  expect(new Set(chips).size).toBe(4)
  await expectConsistent('after double +')
  expect(await grand()).toContain('400.00')

  await minus(p.name).click()
  await expect.poll(qtys).toEqual([3])
  expect(await chipsOf(p.name)).toEqual(chips.slice(0, 3))
  // two separate clicks (a double-click at one screen position is test 12: the button moves when a label number goes)
  await minus(p.name).click()
  await minus(p.name).click()
  await expect.poll(qtys).toEqual([1])
  expect(await chipsOf(p.name)).toEqual([p.codes[2]])
  await expect(minus(p.name)).toBeDisabled()

  await typeQty(p.name, '3')
  await expect.poll(qtys).toEqual([3])
  await expectConsistent('typed 3')
  expect((await chipsOf(p.name))[0]).toBe(p.codes[2])
  await expect(scanBox()).toBeFocused() // Enter in the quantity box goes back to the scan box

  await clearToasts()
  await typeQty(p.name, '99')
  await expect.poll(qtys).toEqual([6])
  await expect(stockToast()).toBeVisible()
  await expectConsistent('typed 99')
  expect([...(await chipsOf(p.name))].sort()).toEqual(p.codes)
  // + at the stock limit: stays, says why
  await clearToasts()
  await plus(p.name).click()
  await expect(stockToast()).toBeVisible()
  expect(await qtys()).toEqual([6])

  await typeQty(p.name, '1', 'Tab')
  await expect.poll(qtys).toEqual([1])
  expect(await chipsOf(p.name)).toEqual([p.codes[2]])
  // 0 / empty never change a tracked line either
  await typeQty(p.name, '0')
  await page.waitForTimeout(300)
  expect(await qtys()).toEqual([1])
  await typeQty(p.name, '', 'Tab')
  await page.waitForTimeout(300)
  expect(await qtys()).toEqual([1])
  await expect(qtyBox(p.name)).toHaveValue('1')

  // scan a second label, then type 4
  await scan(p.codes[5])
  await expect.poll(() => chipsOf(p.name)).toEqual([p.codes[2], p.codes[5]])
  await typeQty(p.name, '4')
  await expect.poll(qtys).toEqual([4])
  chips = await chipsOf(p.name)
  expect(chips.slice(0, 2)).toEqual([p.codes[2], p.codes[5]])
  expect(await grand()).toContain('400.00')
  expect(await itemsCount()).toBe(4)

  const sold = await payAndVerify(p, 4, chips, true)
  await expectSoldRefused(sold[0])
  // only 2 pieces are left now: + stops at 2
  await scan(p.codes.find((c) => !sold.includes(c))!)
  await expect.poll(qtys).toEqual([1])
  await clearToasts()
  await plus(p.name).click()
  await plus(p.name).click()
  await expect(stockToast()).toBeVisible()
  expect(await qtys()).toEqual([2])
  await expectConsistent('2 left')
})

test('03 tracked, added by the ordinary product barcode: a tracked line with 1 code; + / - / typed work; 3*BARCODE adds 3', async () => {
  const p = P.bar
  await freshBill()
  await scan(p.barcode)
  await expect.poll(qtys).toEqual([1])
  await expect(warning()).toHaveCount(0)
  let chips = await chipsOf(p.name)
  expect(chips).toHaveLength(1)
  expect(p.codes).toContain(chips[0])
  await expect(minus(p.name)).toBeDisabled()

  await plus(p.name).click()
  await expect.poll(qtys).toEqual([2])
  await expectConsistent('barcode then +')
  await plus(p.name).dblclick()
  await expect.poll(qtys).toEqual([4])
  await expectConsistent('barcode then ++')
  await minus(p.name).click()
  await expect.poll(qtys).toEqual([3])
  await typeQty(p.name, '5')
  await expect.poll(qtys).toEqual([5])
  await expectConsistent('typed 5')
  await typeQty(p.name, '2', 'Tab')
  await expect.poll(qtys).toEqual([2])
  chips = await chipsOf(p.name)
  expect(chips).toHaveLength(2)

  // the barcode again: same line, one more piece
  await scan(p.barcode)
  await expect.poll(qtys).toEqual([3])
  await expectConsistent('barcode twice')
  // 3*BARCODE: three more
  await scan(`3*${p.barcode}`)
  await expect.poll(qtys).toEqual([6])
  await expectConsistent('3*barcode on the line')
  expect((await chipsOf(p.name)).slice(0, 2)).toEqual(chips)

  // a reader scan of the barcode with the focus on the page body (keyboard wedge) adds one too
  await blurAll()
  await wedgeScan(p.barcode)
  await expect.poll(qtys).toEqual([7])
  // above the stock: stops at 8 and says so
  await clearToasts()
  await scan(`20*${p.barcode}`)
  await expect.poll(qtys).toEqual([8])
  await expect(stockToast()).toBeVisible()
  expect(await lineCount()).toBe(1)

  // a fresh bill started with 3*BARCODE
  await freshBill()
  await scan(`3*${p.barcode}`)
  await expect.poll(qtys).toEqual([3])
  chips = await chipsOf(p.name)
  expect(new Set(chips).size).toBe(3)
  await minus(p.name).click()
  await expect.poll(qtys).toEqual([2])
  await plus(p.name).click()
  await expect.poll(qtys).toEqual([3])
  chips = await chipsOf(p.name)
  await expectConsistent('3*barcode fresh')
  expect(await grand()).toContain('300.00')
  const sold = await payAndVerify(p, 3, chips, true)
  await expectSoldRefused(sold[1])
})

test('04 tracked, picked by name (Enter, click, arrow keys): a tracked line; + / - / typed work', async () => {
  const p = P.name
  await freshBill()
  const option = page.getByRole('option').filter({ hasText: p.name })

  // type the name, Enter takes the highlighted match
  await scanBox().focus()
  await page.keyboard.type('Chakra', { delay: 120 })
  await expect(option).toBeVisible()
  await page.keyboard.press('Enter')
  await expect.poll(qtys).toEqual([1])
  await expect(warning()).toHaveCount(0)
  let chips = await chipsOf(p.name)
  expect(chips).toHaveLength(1)
  expect(p.codes).toContain(chips[0])
  await expect(scanBox()).toHaveValue('')
  await expect(minus(p.name)).toBeDisabled()

  await plus(p.name).click()
  await expect.poll(qtys).toEqual([2])
  await plus(p.name).dblclick()
  await expect.poll(qtys).toEqual([4])
  await expectConsistent('name then +')
  await minus(p.name).click()
  await expect.poll(qtys).toEqual([3])
  await typeQty(p.name, '6')
  await expect.poll(qtys).toEqual([6])
  await expectConsistent('name typed 6')
  await typeQty(p.name, '1', 'Tab')
  await expect.poll(qtys).toEqual([1])
  expect(await chipsOf(p.name)).toEqual(chips)

  // pick it with the mouse: one more on the same line
  await scanBox().focus()
  await page.keyboard.type('chakra by', { delay: 120 })
  await expect(option).toBeVisible()
  await option.click()
  await expect.poll(qtys).toEqual([2])
  await expectConsistent('picked by click')
  // pick it with the arrow keys
  await scanBox().focus()
  await page.keyboard.type('Byname', { delay: 120 })
  await expect(option).toBeVisible()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await expect.poll(qtys).toEqual([3])
  await expectConsistent('picked by arrows')
  expect(await lineCount()).toBe(1)

  await plus(p.name).click()
  await expect.poll(qtys).toEqual([4])
  await minus(p.name).click()
  await expect.poll(qtys).toEqual([3])
  chips = await chipsOf(p.name)
  const sold = await payAndVerify(p, 3, chips, true)
  await expectSoldRefused(sold[0])
})

test('05 mixed: unit code, then the product barcode => one line, 2 distinct codes; + / - ; other lines untouched', async () => {
  const p = P.mix
  const A = p.codes[0] // the piece "next available" would name first
  await freshBill()
  await scan(A)
  await expect.poll(() => chipsOf(p.name)).toEqual([A])
  await scan(p.barcode)
  await expect.poll(qtys).toEqual([2])
  expect(await lineCount()).toBe(1)
  let chips = await chipsOf(p.name)
  expect(chips[0]).toBe(A)
  expect(chips[1]).not.toBe(A)
  await expectConsistent('unit then barcode')

  // the same unit code once more: duplicate, nothing changes
  await scan(A)
  await expect(warning()).toBeVisible()
  await expect(page.getByTestId('unit-warning-text')).toContainText(`Duplicate entry: ${A}`)
  expect(await qtys()).toEqual([2])
  await warning().getByRole('button', { name: 'Dismiss' }).click()

  await scan(PLAIN.barcode)
  await expect.poll(qtys).toEqual([2, 1])
  await plus(p.name).click()
  await expect.poll(qtys).toEqual([3, 1])
  await plus(PLAIN.name).click()
  await expect.poll(qtys).toEqual([3, 2])
  await minus(p.name).click()
  await expect.poll(qtys).toEqual([2, 2])
  expect(await chipsOf(p.name)).toEqual(chips)
  await typeQty(p.name, '4')
  await expect.poll(qtys).toEqual([4, 2])
  await typeQty(PLAIN.name, '5')
  await expect.poll(qtys).toEqual([4, 5])
  await expectConsistent('mixed bill')
  // a label of a piece that "+" already put on the bill is a duplicate, not a 5th piece
  chips = await chipsOf(p.name)
  await scan(chips[3])
  await expect(warning()).toBeVisible()
  expect(await qtys()).toEqual([4, 5])
  await warning().getByRole('button', { name: 'Dismiss' }).click()
  // a label that is not on the bill yet joins the line
  const free = p.codes.find((c) => !chips.includes(c))!
  await scan(free)
  await expect.poll(qtys).toEqual([5, 5])
  chips = await chipsOf(p.name)
  expect(chips[4]).toBe(free)
  expect(await grand()).toContain('750.00')

  const plainBefore = await stockOf(PLAIN.barcode)
  const sold = await payAndVerify(p, 5, chips, true)
  expect(await stockOf(PLAIN.barcode)).toBe(plainBefore - 5)
  await expectSoldRefused(sold[0])
})

test('06 shop-style product (some pieces labelled): label scan, +, product barcode, typed; qty == codes, none twice', async () => {
  const p = P.shop
  const L = shopLabelled
  await freshBill()
  await scan(L[1])
  await expect.poll(() => chipsOf(p.name)).toEqual([L[1]])
  await plus(p.name).click()
  await expect.poll(qtys).toEqual([2])
  await expectConsistent('label then +')
  await scan(p.barcode)
  await expect.poll(qtys).toEqual([3])
  await expect(warning()).toHaveCount(0)
  await expectConsistent('label, +, barcode')
  expect(await lineCount()).toBe(1)

  await scan(L[1])
  await expect(warning()).toBeVisible()
  await expect(page.getByTestId('unit-warning-text')).toContainText(`Duplicate entry: ${L[1]}`)
  expect(await qtys()).toEqual([3])
  await warning().getByRole('button', { name: 'Dismiss' }).click()

  await scan(`2*${p.barcode}`)
  await expect.poll(qtys).toEqual([5])
  await expectConsistent('2*barcode')
  await scan(L[0])
  await expect.poll(qtys).toEqual([6])
  await expectConsistent('second label')
  await minus(p.name).click()
  await expect.poll(qtys).toEqual([5])
  expect(await chipsOf(p.name)).not.toContain(L[0])

  await clearToasts()
  await typeQty(p.name, '9')
  await expect.poll(qtys).toEqual([8])
  await expect(stockToast()).toBeVisible()
  await typeQty(p.name, '5')
  await expect.poll(qtys).toEqual([5])
  await plus(p.name).click()
  await expect.poll(qtys).toEqual([6])
  const chips = await chipsOf(p.name)
  expect(chips).toHaveLength(6)
  expect(new Set(chips).size).toBe(6)
  expect(chips[0]).toBe(L[1])
  for (const c of chips) expect(p.codes).toContain(c)
  await expectConsistent('shop product')

  const sold = await payAndVerify(p, 6, chips, true)
  await expectSoldRefused(sold[0])

  // what is left (2 pieces) by the product barcode alone
  await freshBill()
  await scan(p.barcode)
  await expect.poll(qtys).toEqual([1])
  await clearToasts()
  await plus(p.name).dblclick()
  await expect.poll(qtys).toEqual([2])
  await expect(stockToast()).toBeVisible()
  const rest = await chipsOf(p.name)
  await payAndVerify(p, 2, rest, true)
  // nothing is left: the barcode is refused with a clear message and no line
  await scan(p.barcode)
  await expect(warning()).toBeVisible()
  await expect(page.getByTestId('unit-warning-text')).toContainText('no piece is left in stock')
  expect(await lineCount()).toBe(0)
})

test('08 hold a bill with a tracked line of 3, resume: codes kept, + and - still work, sale completes', async () => {
  const p = P.hold
  await freshBill()
  await scan(p.codes[3])
  await expect.poll(qtys).toEqual([1])
  await plus(p.name).click()
  await scan(p.barcode)
  await expect.poll(qtys).toEqual([3])
  const held = await chipsOf(p.name)
  expect(held).toHaveLength(3)

  await page.getByRole('button', { name: /^Hold/ }).click()
  await expect.poll(lineCount).toBe(0)
  await page.getByRole('button', { name: 'Held bills' }).click()
  await page.getByRole('button', { name: 'Resume' }).first().click()
  await expect.poll(() => chipsOf(p.name)).toEqual(held)
  expect(await qtys()).toEqual([3])

  await plus(p.name).click()
  await expect.poll(qtys).toEqual([4])
  let chips = await chipsOf(p.name)
  expect(chips.slice(0, 3)).toEqual(held)
  expect(new Set(chips).size).toBe(4)
  await minus(p.name).click()
  await expect.poll(qtys).toEqual([3])
  expect(await chipsOf(p.name)).toEqual(held)
  await typeQty(p.name, '5')
  await expect.poll(qtys).toEqual([5])
  await expectConsistent('resumed, typed 5')
  await scan(held[0])
  await expect(warning()).toBeVisible()
  expect(await qtys()).toEqual([5])
  await warning().getByRole('button', { name: 'Dismiss' }).click()
  await typeQty(p.name, '4', 'Tab')
  await expect.poll(qtys).toEqual([4])
  chips = await chipsOf(p.name)
  const sold = await payAndVerify(p, 4, chips, true)
  await expectSoldRefused(sold[0])
})

test('09 a line with more than 6 codes: "and N more", - and a typed quantity still work, sale completes', async () => {
  const p = P.many
  await freshBill()
  await scan(`8*${p.barcode}`)
  await expect.poll(qtys).toEqual([8])
  let l = (await cart())[0]
  expect(l.chips).toHaveLength(6)
  expect(l.more).toBe(2)
  await expect(row(p.name).getByTestId('unit-more')).toHaveText('and 2 more')
  await plus(p.name).click()
  await expect.poll(qtys).toEqual([9])
  await expect(row(p.name).getByTestId('unit-more')).toHaveText('and 3 more')
  await minus(p.name).dblclick()
  await expect.poll(qtys).toEqual([7])
  await expect(row(p.name).getByTestId('unit-more')).toHaveText('and 1 more')
  await typeQty(p.name, '10')
  await expect.poll(qtys).toEqual([10])
  await expect(row(p.name).getByTestId('unit-more')).toHaveText('and 4 more')
  await expectConsistent('10 pieces')
  await typeQty(p.name, '5', 'Tab')
  await expect.poll(qtys).toEqual([5])
  await expect(row(p.name).getByTestId('unit-more')).toHaveCount(0)
  expect(await chipsOf(p.name)).toEqual(l.chips.slice(0, 5))
  await clearToasts()
  await typeQty(p.name, '50')
  await expect.poll(qtys).toEqual([12])
  await expect(stockToast()).toBeVisible()
  await expect(row(p.name).getByTestId('unit-more')).toHaveText('and 6 more')
  await minus(p.name).click()
  await minus(p.name).click()
  await minus(p.name).click()
  await expect.poll(qtys).toEqual([9])
  l = (await cart())[0]
  expect(l.more).toBe(3)
  expect(await grand()).toContain('900.00')
  await payAndVerify(p, 9, l.chips, false)
  expect(await stockOf(p.barcode)).toBe(3)
})

test('10 remove one chip, then +: quantity and codes stay consistent', async () => {
  const p = P.chip
  await freshBill()
  await scan(`3*${p.barcode}`)
  await expect.poll(qtys).toEqual([3])
  const three = await chipsOf(p.name)
  await page.getByRole('button', { name: `Remove ${three[1]}` }).click()
  await expect.poll(qtys).toEqual([2])
  expect(await chipsOf(p.name)).toEqual([three[0], three[2]])
  await plus(p.name).click()
  await expect.poll(qtys).toEqual([3])
  await expectConsistent('chip removed then +')
  // the removed label can be scanned again (if "+" did not already take that piece)
  let chips = await chipsOf(p.name)
  if (!chips.includes(three[1])) {
    await scan(three[1])
    await expect.poll(qtys).toEqual([4])
  } else {
    await plus(p.name).click()
    await expect.poll(qtys).toEqual([4])
  }
  await expectConsistent('4 pieces')
  chips = await chipsOf(p.name)
  await page.getByRole('button', { name: `Remove ${chips[0]}` }).click()
  await expect.poll(qtys).toEqual([3])
  await minus(p.name).click()
  await expect.poll(qtys).toEqual([2])
  await typeQty(p.name, '5')
  await expect.poll(qtys).toEqual([5])
  await expectConsistent('typed 5 after removals')
  await page.getByRole('button', { name: `Remove ${(await chipsOf(p.name))[4]}` }).click()
  await expect.poll(qtys).toEqual([4])
  // down to one chip, then that chip: the line goes
  chips = await chipsOf(p.name)
  const sold = await payAndVerify(p, 4, chips, true)
  await expectSoldRefused(sold[0])
  const last = p.codes.find((c) => !sold.includes(c))!
  await scan(last)
  await expect.poll(qtys).toEqual([1])
  await page.getByRole('button', { name: `Remove ${last}` }).click()
  await expect.poll(lineCount).toBe(0)
  await scan(last)
  await expect.poll(() => chipsOf(p.name)).toEqual([last])
})

test('11 a reader scan right after using + / the quantity box (focus not in the scan box) adds exactly one piece', async () => {
  const p = P.focus
  await freshBill()
  // plain line: click +, then the reader fires while the + button still has the focus
  await scan(PLAIN.barcode)
  await expect.poll(qtys).toEqual([1])
  await plus(PLAIN.name).click()
  await expect.poll(qtys).toEqual([2])
  await wedgeScan(PLAIN.barcode)
  await expect.poll(qtys).toEqual([3])
  await page.waitForTimeout(400)
  expect(await qtys(), 'plain: scan with focus on + adds exactly 1').toEqual([3])
  // plain line: the cashier clicked into the quantity box, then scans
  await qtyBox(PLAIN.name).click()
  await wedgeScan(PLAIN.barcode)
  await expect.poll(qtys).toEqual([4])
  await page.waitForTimeout(400)
  expect(await qtys(), 'plain: scan with focus in the quantity box adds exactly 1').toEqual([4])
  await expect(qtyBox(PLAIN.name)).toHaveValue('4')

  await freshBill()
  await scan(p.codes[0])
  await expect.poll(qtys).toEqual([1])
  await plus(p.name).click()
  await expect.poll(qtys).toEqual([2])
  let chips = await chipsOf(p.name)
  const next = p.codes.find((c) => !chips.includes(c))!
  // focus is on the + button: scan another label
  await wedgeScan(next)
  await expect.poll(qtys).toEqual([3])
  await page.waitForTimeout(400)
  expect(await qtys(), 'tracked: label scan with focus on + adds exactly 1').toEqual([3])
  expect((await chipsOf(p.name))[2]).toBe(next)
  await expectConsistent('scan with focus on +')
  // focus in the quantity box: scan another label
  chips = await chipsOf(p.name)
  const next2 = p.codes.find((c) => !chips.includes(c))!
  await qtyBox(p.name).click()
  await wedgeScan(next2)
  await expect.poll(qtys).toEqual([4])
  await page.waitForTimeout(400)
  expect(await qtys(), 'tracked: label scan with focus in the quantity box adds exactly 1').toEqual([4])
  expect((await chipsOf(p.name))[3]).toBe(next2)
  await expectConsistent('scan with focus in qty box')
  // focus on the - button: scan the product barcode
  await minus(p.name).click()
  await expect.poll(qtys).toEqual([3])
  await wedgeScan(p.barcode)
  await expect.poll(qtys).toEqual([4])
  await page.waitForTimeout(400)
  expect(await qtys(), 'tracked: barcode scan with focus on - adds exactly 1').toEqual([4])
  await expectConsistent('scan with focus on -')
  // and + / - / typed still work after all that
  await plus(p.name).click()
  await expect.poll(qtys).toEqual([5])
  await typeQty(p.name, '2')
  await expect.poll(qtys).toEqual([2])
  chips = await chipsOf(p.name)
  await payAndVerify(p, 2, chips, true)
})

test('12 clicking + / - repeatedly WITHOUT moving the mouse changes the quantity each time (the buttons must not move away)', async () => {
  // Was a bug: the bill table had no pinned columns, so a label-number chip appearing or wrapping under the name moved the
  // buttons away from the mouse and the 3rd click landed on the Quantity box (pos.css .pos-cart).
  const p = P.move
  await freshBill()
  await scan(p.codes[0])
  await expect.poll(qtys).toEqual([1])
  const centre = async (l: Locator) => { const b = (await l.boundingBox())!; return { x: b.x + b.width / 2, y: b.y + b.height / 2, left: Math.round(b.x), top: Math.round(b.y) } }
  const at = await centre(plus(p.name))
  const trail: string[] = []
  for (let i = 0; i < 5; i++) {
    await page.mouse.click(at.x, at.y)
    await page.waitForTimeout(400)
    const now = await centre(plus(p.name))
    trail.push(`click ${i + 1}: qty ${(await qtys())[0]}, + button at x=${now.left} y=${now.top}`)
  }
  console.log(`[pos-qty] 12 "+" pressed 5 times at x=${Math.round(at.x)} y=${Math.round(at.y)} (button was at x=${at.left} y=${at.top}):\n  ${trail.join('\n  ')}`)
  const afterPlus = (await qtys())[0]
  // bring it to 6 for the "-" half whatever happened
  await typeQty(p.name, '6')
  await expect.poll(qtys).toEqual([6])
  await blurAll()
  const m = await centre(minus(p.name))
  const trail2: string[] = []
  for (let i = 0; i < 5; i++) {
    await page.mouse.click(m.x, m.y)
    await page.waitForTimeout(400)
    const now = await centre(minus(p.name))
    trail2.push(`click ${i + 1}: qty ${(await qtys())[0]}, - button at x=${now.left} y=${now.top}`)
  }
  console.log(`[pos-qty] 12 "-" pressed 5 times at x=${Math.round(m.x)} y=${Math.round(m.y)} (button was at x=${m.left} y=${m.top}):\n  ${trail2.join('\n  ')}`)
  const afterMinus = (await qtys())[0]
  await expectConsistent('fixed-position clicks')
  expect({ afterPlus, afterMinus }).toEqual({ afterPlus: 6, afterMinus: 1 })
})

test('13 a tracked line with a discount: + / - / typed still work on it, the sale sells exactly its codes', async () => {
  const p = P.disc
  await freshBill()
  await scan(p.codes[1])
  await expect.poll(qtys).toEqual([1])
  const disc = row(p.name).getByLabel('Discount', { exact: true })
  await disc.click()
  await page.keyboard.type('10', { delay: 90 })
  await page.keyboard.press('Enter')
  await expect.poll(grand).toContain('90.00')
  await plus(p.name).click()
  await expect.poll(qtys).toEqual([2])
  await plus(p.name).dblclick()
  await page.waitForTimeout(500)
  await typeQty(p.name, '5')
  await expect.poll(qtys).toEqual([5])
  await minus(p.name).click()
  await expect.poll(qtys).toEqual([4])
  expect(await lineCount()).toBe(1)
  await expectConsistent('discounted line')
  expect(await grand()).toContain('390.00')
  const chips = await chipsOf(p.name)
  expect(chips[0]).toBe(p.codes[1])
  const sold = await payAndVerify(p, 4, chips, true)
  await expectSoldRefused(sold[0])
})

test('14 a typed quantity that is not committed yet (no Enter) is applied before + and before Pay; the bill survives leaving the screen', async () => {
  const p = P.pay
  await freshBill()
  await scan(p.barcode)
  await expect.poll(qtys).toEqual([1])
  // type 3, then click + straight away: 3 then one more
  await qtyBox(p.name).click()
  await page.keyboard.press('Control+A')
  await page.keyboard.type('3', { delay: 90 })
  await plus(p.name).click()
  await expect.poll(qtys).toEqual([4])
  await expectConsistent('typed 3 then +')
  // leave Billing and come back: the bill is still there and + / - still work
  const before = await chipsOf(p.name)
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Products' }).click()
  await page.waitForTimeout(500)
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /Billing/ }).click()
  await expect.poll(() => chipsOf(p.name)).toEqual(before)
  expect(await qtys()).toEqual([4])
  await minus(p.name).click()
  await expect.poll(qtys).toEqual([3])
  await plus(p.name).click()
  await expect.poll(qtys).toEqual([4])
  await expectConsistent('after coming back')
  // type 2, then press Pay straight away: the sale is for 2
  await qtyBox(p.name).click()
  await page.keyboard.press('Control+A')
  await page.keyboard.type('2', { delay: 90 })
  const stockBefore = await stockOf(p.barcode)
  await page.getByRole('button', { name: /^Pay/ }).click()
  await expect(page.getByTestId('amount-due')).toHaveText('₹200.00')
  await page.getByRole('button', { name: /Complete sale/ }).click()
  await expect(page.getByText('Sale completed')).toBeVisible({ timeout: 15_000 })
  const sold = await unitCodes(p.variantId, 'sold')
  expect(sold).toEqual([...before.slice(0, 2)].sort())
  expect(await stockOf(p.barcode)).toBe(stockBefore - 2)
  expect((await call('inventory', 'verifyLedger')).ok).toBe(true)
})

test('99 no renderer console errors', async () => {
  expect(consoleErrors, 'renderer console errors').toEqual([])
})

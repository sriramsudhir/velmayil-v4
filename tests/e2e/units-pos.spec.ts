/**
 * Per-unit codes (PREFIX-NNNN) on the billing screen, driven by OS-level scans (SendInput, same injector as scanner-os.spec.ts).
 * Rule: scanned code not on the bill -> add; already on the bill -> duplicate warning, bill unchanged; sold unit -> not-available warning.
 *
 * Run:  npm run build && npx playwright test -c tests/e2e/playwright.config.ts units-pos.spec.ts
 */
import { test, expect, _electron as electron, type ElectronApplication, type Page, type CDPSession } from '@playwright/test'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(__dirname, '..', '..')
const SENDKEYS = join(__dirname, 'tools', 'sendkeys.ps1')
const dataDir = mkdtempSync(join(tmpdir(), 'velmayil-units-pos-'))
const consoleErrors: string[] = []
const PLAIN = '8901234567890'

let app: ElectronApplication
let page: Page
let appPid = 0
let keys: OsKeys | null = null
let cdp: CDPSession | null = null
let mode: 'os' | 'cdp' = 'os'
let codes: string[] = []

class OsKeys {
  private proc: ChildProcessWithoutNullStreams
  private lines: string[] = []
  private waiter: ((l: string) => void) | null = null
  private buf = ''
  private constructor(p: ChildProcessWithoutNullStreams) {
    this.proc = p
    p.stdout.setEncoding('utf8')
    p.stdout.on('data', (d: string) => {
      this.buf += d
      let i: number
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).replace(/\r$/, '')
        this.buf = this.buf.slice(i + 1)
        if (this.waiter) { const w = this.waiter; this.waiter = null; w(line) } else this.lines.push(line)
      }
    })
  }
  static async start(): Promise<OsKeys> {
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SENDKEYS, '-Server'], { stdio: 'pipe', windowsHide: true })
    const k = new OsKeys(p)
    const first = await Promise.race([k.next(), new Promise<string>((r) => setTimeout(() => r('timeout'), 90_000))])
    if (first !== 'ready') throw new Error(`sendkeys.ps1 did not start: ${first}`)
    return k
  }
  private next(): Promise<string> {
    const l = this.lines.shift()
    if (l !== undefined) return Promise.resolve(l)
    return new Promise((r) => { this.waiter = r })
  }
  async cmd(line: string): Promise<string> {
    this.proc.stdin.write(line + '\n')
    return Promise.race([this.next(), new Promise<string>((r) => setTimeout(() => r('err timeout'), 60_000))])
  }
  stop(): void {
    try { this.proc.stdin.write('exit\n') } catch { /* ignore */ }
    setTimeout(() => this.proc.kill(), 1500).unref()
  }
}
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64')

// CDP fallback (US layout, A-Z 0-9 and '-' are all a unit code needs)
const spin = (ms: number) => new Promise<void>((r) => { const end = performance.now() + ms; const tick = () => (performance.now() >= end ? r() : setImmediate(tick)); tick() })
async function cdpKey(c: string, gap: number): Promise<void> {
  const up = /[A-Z]/.test(c)
  const key = c
  const code = /[A-Za-z]/.test(c) ? `Key${c.toUpperCase()}` : /[0-9]/.test(c) ? `Digit${c}` : 'Minus'
  const vk = /[A-Za-z0-9]/.test(c) ? c.toUpperCase().charCodeAt(0) : 189
  const mods = up ? 8 : 0
  if (up) await cdp!.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, modifiers: 8 })
  await cdp!.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: vk, modifiers: mods })
  await cdp!.send('Input.dispatchKeyEvent', { type: 'char', key, code, text: c, unmodifiedText: c, windowsVirtualKeyCode: c.charCodeAt(0), modifiers: mods })
  await cdp!.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, modifiers: mods })
  if (up) await cdp!.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 })
  await spin(gap)
}
async function cdpEnter(gap: number): Promise<void> {
  await cdp!.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
  await cdp!.send('Input.dispatchKeyEvent', { type: 'char', key: 'Enter', code: 'Enter', text: '\r', windowsVirtualKeyCode: 13 })
  await cdp!.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await spin(gap)
}

async function ensureForeground(): Promise<void> {
  const st = await keys!.cmd('state')
  if (new RegExp(`fgpid=${appPid}\\b`).test(st) && (await page.evaluate(() => document.hasFocus()))) return
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.show(); w.focus() })
  const r = await keys!.cmd(`focus pid=${appPid}`)
  if (!r.startsWith('ok')) throw new Error(`cannot take the foreground, refusing to type into another window: ${r}`)
  await expect.poll(() => page.evaluate(() => document.hasFocus()), { timeout: 5000 }).toBe(true)
}
/** one reader scan: the code's keys 5 ms apart, then Enter */
async function scan(code: string): Promise<void> {
  if (mode === 'cdp') {
    for (const ch of code) await cdpKey(ch, 5)
    await cdpEnter(5)
    return
  }
  await ensureForeground()
  const r = await keys!.cmd(`type text=${b64(code)} mode=scancode gap=5 suffix=enter`)
  if (!r.startsWith('ok')) throw new Error(`sendkeys: ${r}`)
}

const call = async (service: string, method: string, args?: unknown): Promise<any> => {
  const r = await page.evaluate(([s, m, a]) => (window as any).velmayil.call(s, m, a), [service, method, args ?? {}] as const)
  if (!r.ok) throw new Error(`${service}.${method}: ${r.error?.code} ${r.error?.message}`)
  return r.data
}
const scanBox = () => page.getByLabel('Scan or search products')
const warning = () => page.getByTestId('unit-warning')
const unitChips = () => page.evaluate(() => [...document.querySelectorAll('.pos-cart [data-unit]')].map((e) => e.getAttribute('data-unit')))
const lineCount = () => page.evaluate(() => document.querySelectorAll('.pos-cart tbody tr').length)
const qtyOf = () => page.evaluate(() => [...document.querySelectorAll('.pos-cart tbody tr')].map((tr) => Number((tr.querySelector('input[aria-label="Quantity"]') as HTMLInputElement).value)))
const blurAll = () => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())

async function freshBill(): Promise<void> {
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /Billing/ }).click()
  await page.waitForTimeout(500)
  const skip = page.getByRole('button', { name: 'Skip for now' })
  if (await skip.isVisible({ timeout: 1500 }).catch(() => false)) await skip.click()
  await expect(scanBox()).toBeVisible()
  if ((await lineCount()) > 0) {
    await page.getByRole('button', { name: /New bill/ }).click()
    await page.getByRole('button', { name: 'Clear bill' }).click()
  }
  await expect.poll(lineCount).toBe(0)
  await scanBox().focus()
  await page.waitForTimeout(100)
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  if (!existsSync(join(ROOT, 'out', 'main', 'index.js'))) throw new Error('Run `npm run build` first')
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v
  env.VELMAYIL_DATA_DIR = dataDir
  app = await electron.launch({ args: [ROOT, `--user-data-dir=${join(dataDir, 'chromium-profile')}`], cwd: ROOT, env })
  appPid = await app.evaluate(() => process.pid)
  page = await app.firstWindow()
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`[${m.location().url.split('/').pop()}] ${m.text()}`) })
  page.on('pageerror', (e) => consoleErrors.push(`[pageerror] ${e.message}`))
  await page.waitForLoadState('domcontentloaded')
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setContentSize(1400, 860); w.show(); w.focus() })
  await call('setup', 'complete', { shop: { shopName: 'Units POS Shop' }, owner: { username: 'owner', name: 'Owner', password: 'Owner@123' }, pos: {}, locationName: 'Main Store' })
  await page.reload()
  const signIn = page.getByRole('button', { name: 'Sign in' })
  if (await signIn.isVisible({ timeout: 4000 }).catch(() => false)) {
    await page.getByLabel('Username').fill('owner')
    await page.getByLabel('Password', { exact: true }).fill('Owner@123')
    await signIn.click()
  }
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible({ timeout: 20_000 })

  // a plain (untracked) product, and a tracked product with 3 units made by the real catalog + units services
  await call('catalog', 'save', { name: 'Plain Item', hsn: '3604', taxRateBp: 0, variants: [{ name: '', mrp: 5000, price: 5000, cost: 2000, openingStock: 50, barcode: PLAIN }] })
  const saved = await call('catalog', 'save', { name: 'Sparkler Pack', hsn: '3604', taxRateBp: 0, variants: [{ name: '', mrp: 10000, price: 10000, cost: 5000, openingStock: 3, barcode: '8900000000012' }] })
  await call('units', 'setTracking', { productId: saved.id, trackUnits: true, prefix: 'SPK', backfill: true })
  const list = await call('units', 'list', { variantId: saved.variants[0].id, status: 'in_stock', limit: 50 })
  const rows: { code: string }[] = Array.isArray(list) ? list : (list.rows ?? list.items ?? [])
  codes = rows.map((r) => r.code).sort()
  expect(codes).toHaveLength(3)
  expect(codes[0]).toMatch(/^SPK-\d{4}$/)

  if (process.env.SCAN_E2E_MODE === 'cdp') mode = 'cdp'
  else {
    try {
      keys = await OsKeys.start()
      await ensureForeground()
      await page.evaluate(() => { const i = document.createElement('input'); i.id = '__probe'; i.style.cssText = 'position:fixed;top:0;left:0;z-index:99999'; document.body.appendChild(i); i.focus() })
      const r = await keys.cmd(`type text=${b64('q')} mode=scancode gap=5 suffix=none`)
      const got = await page.evaluate(() => (document.getElementById('__probe') as HTMLInputElement).value)
      await page.evaluate(() => document.getElementById('__probe')?.remove())
      if (!r.startsWith('ok') || got !== 'q') throw new Error(`probe typed ${JSON.stringify(got)} (${r})`)
    } catch {
      mode = 'cdp'
      keys?.stop(); keys = null
    }
  }
  if (mode === 'cdp') cdp = await page.context().newCDPSession(page)
  console.log(`[units-pos] injection mode: ${mode}; units ${codes.join(', ')}`)
})
test.afterAll(async () => {
  keys?.stop()
  await app?.close().catch(() => undefined)
})

test('01 scan unit 1 adds it; scanning it again warns "duplicate" and leaves the bill unchanged; unit 2 is added', async () => {
  await freshBill()
  await scan(codes[0])
  await expect.poll(unitChips).toEqual([codes[0]])
  expect(await qtyOf()).toEqual([1])
  await expect(warning()).toHaveCount(0)

  // same unit again, scanner focus in the box and then on the body: both are duplicates
  for (const where of ['box', 'body'] as const) {
    if (where === 'box') await scanBox().focus(); else await blurAll()
    await scan(codes[0])
    await expect(warning()).toBeVisible()
    await expect(page.getByTestId('unit-warning-text')).toContainText(`Duplicate entry: ${codes[0]} is already in this bill`)
    await page.waitForTimeout(250)
    expect(await unitChips(), `bill unchanged (${where})`).toEqual([codes[0]])
    expect(await qtyOf()).toEqual([1])
  }
  await warning().getByRole('button', { name: 'Dismiss' }).click()
  await expect(warning()).toHaveCount(0)

  await scanBox().focus()
  await scan(codes[1])
  await expect.poll(unitChips).toEqual([codes[0], codes[1]])
  expect(await lineCount()).toBe(1)
  expect(await qtyOf()).toEqual([2])
  await expect(page.getByRole('button', { name: 'Increase quantity' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Decrease quantity' })).toBeDisabled()
})

test('02 removing one unit code releases it (it can be scanned again); a plain barcode still just increments', async () => {
  await page.getByRole('button', { name: `Remove ${codes[0]}` }).click()
  await expect.poll(unitChips).toEqual([codes[1]])
  await scanBox().focus()
  await scan(codes[0])
  await expect.poll(unitChips).toEqual([codes[1], codes[0]])
  await scan(PLAIN)
  await expect.poll(qtyOf).toEqual([2, 1])
  await scan(PLAIN)
  await expect.poll(qtyOf).toEqual([2, 2])
})

test('03 hold and resume keep the unit codes (and the duplicate rule still applies)', async () => {
  await page.getByRole('button', { name: /^Hold/ }).click()
  await expect.poll(lineCount).toBe(0)
  await expect(page.getByText('Bill held')).toBeVisible()
  await page.getByRole('button', { name: 'Held bills' }).click()
  await page.getByRole('button', { name: 'Resume' }).first().click()
  await expect.poll(unitChips).toEqual([codes[1], codes[0]])
  await scanBox().focus()
  await scan(codes[1])
  await expect(warning()).toBeVisible()
  expect(await unitChips()).toEqual([codes[1], codes[0]])
})

test('04 pay: the sale completes with the unit codes, the dialog lists them; a sold unit in a new bill is rejected', async () => {
  await page.getByRole('button', { name: /^Pay/ }).click()
  await page.getByRole('button', { name: /Complete sale/ }).click()
  await expect(page.getByText('Sale completed')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('sold-units')).toContainText(codes[0])
  await expect(page.getByTestId('sold-units')).toContainText(codes[1])
  const sold = await call('units', 'list', { productId: undefined, status: 'sold', limit: 50 }).catch(() => null)
  if (sold) expect((Array.isArray(sold) ? sold : (sold.rows ?? sold.items ?? [])).length).toBeGreaterThanOrEqual(2)

  await page.getByRole('button', { name: /New bill/ }).click()
  await expect.poll(lineCount).toBe(0)
  await scanBox().focus()
  await scan(codes[0])
  await expect(warning()).toBeVisible()
  await expect(page.getByTestId('unit-warning-text')).toContainText(`${codes[0]} is already sold`)
  expect(await lineCount()).toBe(0)
  // the unit that is still in stock sells normally in the new bill
  await scan(codes[2])
  await expect.poll(unitChips).toEqual([codes[2]])
})

test('05 scanning the plain product barcode of a tracked product asks for the unit code and adds nothing', async () => {
  await freshBill()
  await scan('8900000000012')
  await expect(warning()).toBeVisible()
  await expect(page.getByTestId('unit-warning-text')).toContainText('tracked per unit')
  expect(await lineCount()).toBe(0)
})

test('99 no renderer console errors', async () => {
  expect.soft(consoleErrors, 'renderer console errors').toEqual([])
})

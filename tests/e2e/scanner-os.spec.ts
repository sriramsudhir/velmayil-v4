/**
 * OS-LEVEL barcode-reader emulation against the REAL built app.
 *
 * Keystrokes are injected with user32!SendInput (tests/e2e/tools/sendkeys.ps1), i.e. through the Windows keyboard stack exactly like a
 * USB/Bluetooth keyboard-wedge reader: scan codes with Shift held for capitals/symbols, KEYEVENTF_UNICODE packets, numeric keypad
 * scan codes, Alt+numpad "Alt codes", CapsLock/NumLock toggled for real, auto-repeat of a held key. Playwright's page.keyboard (synthetic
 * DOM-level events) is NOT used to type barcodes here.
 *
 * Needs an interactive Windows desktop (the Electron window must be able to take the foreground). If it cannot, the suite falls back to
 * Chrome-DevTools-protocol Input.dispatchKeyEvent (rawKeyDown + char + keyUp) and says so in the test annotations; set SCAN_E2E_MODE=cdp to force it.
 * Safety: nothing is typed unless the foreground window belongs to the launched test app.
 *
 * Run:  npm run build && npx playwright test -c tests/e2e/playwright.config.ts scanner-os.spec.ts
 */
import { test, expect, _electron as electron, type ElectronApplication, type Page, type CDPSession } from '@playwright/test'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(__dirname, '..', '..')
const SENDKEYS = join(__dirname, 'tools', 'sendkeys.ps1')
const dataDir = mkdtempSync(join(tmpdir(), 'velmayil-scan-os-'))
const consoleErrors: string[] = []

const EAN = '8901234567890'
const EAN2 = '4006381333931'
const C39 = 'ABC123XYZ'
const SYM = 'A#B$1%2&3(4)' // Shift + digit row symbols
const LONG30 = 'ABCDEFGHIJ0123456789KLMNOPQRST'
const SHORT4 = '1234'
const ZEROS = '000123'
const LOWER = 'rk-77x'

let app: ElectronApplication
let page: Page
let appPid = 0
let keys: OsKeys | null = null
let cdp: CDPSession | null = null
let mode: 'os' | 'cdp' = 'os'
let modeNote = ''

// ------------------------------------------------------------------ OS key injector (PowerShell + SendInput), one long-lived process
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

// ------------------------------------------------------------------ CDP fallback: realistic rawKeyDown + char + keyUp (US layout)
const SHIFTED: Record<string, string> = { '!': '1', '@': '2', '#': '3', $: '4', '%': '5', '^': '6', '&': '7', '*': '8', '(': '9', ')': '0', _: '-', '+': '=', '{': '[', '}': ']', '|': '\\', ':': ';', '"': "'", '<': ',', '>': '.', '?': '/', '~': '`' }
function keyInfo(c: string): { key: string; code: string; vk: number; shift: boolean } {
  if (/[a-z]/.test(c)) return { key: c, code: `Key${c.toUpperCase()}`, vk: c.toUpperCase().charCodeAt(0), shift: false }
  if (/[A-Z]/.test(c)) return { key: c, code: `Key${c}`, vk: c.charCodeAt(0), shift: true }
  if (/[0-9]/.test(c)) return { key: c, code: `Digit${c}`, vk: c.charCodeAt(0), shift: false }
  const base = SHIFTED[c]
  const plain = base ?? c
  const table: Record<string, [string, number]> = { '-': ['Minus', 189], '=': ['Equal', 187], '[': ['BracketLeft', 219], ']': ['BracketRight', 221], '\\': ['Backslash', 220], ';': ['Semicolon', 186], "'": ['Quote', 222], ',': ['Comma', 188], '.': ['Period', 190], '/': ['Slash', 191], '`': ['Backquote', 192], ' ': ['Space', 32] }
  if (/[0-9]/.test(plain)) return { key: c, code: `Digit${plain}`, vk: plain.charCodeAt(0), shift: true }
  const t = table[plain] ?? ['Unidentified', 0]
  return { key: c, code: t[0], vk: t[1], shift: base !== undefined }
}
const spin = (ms: number) => new Promise<void>((r) => { const end = performance.now() + ms; const tick = () => (performance.now() >= end ? r() : setImmediate(tick)); tick() })
async function cdpKey(c: string, gap: number): Promise<void> {
  const { key, code, vk, shift } = keyInfo(c)
  const mods = shift ? 8 : 0
  if (shift) await cdp!.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, modifiers: 8 })
  await cdp!.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: vk, modifiers: mods })
  await cdp!.send('Input.dispatchKeyEvent', { type: 'char', key, code, text: c, unmodifiedText: c, windowsVirtualKeyCode: c.charCodeAt(0), modifiers: mods })
  await cdp!.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, modifiers: mods })
  if (shift) await cdp!.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 })
  await spin(gap)
}
async function cdpNamed(name: 'Enter' | 'Tab', gap: number): Promise<void> {
  const vk = name === 'Enter' ? 13 : 9
  await cdp!.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: name, code: name, windowsVirtualKeyCode: vk, ...(name === 'Enter' ? { text: '\r' } : {}) })
  if (name === 'Enter') await cdp!.send('Input.dispatchKeyEvent', { type: 'char', key: 'Enter', code: 'Enter', text: '\r', windowsVirtualKeyCode: 13 })
  await cdp!.send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code: name, windowsVirtualKeyCode: vk })
  await spin(gap)
}

// ------------------------------------------------------------------ scan helper (what a reader does)
interface ScanOpts { gap?: number; suffix?: 'enter' | 'tab' | 'crlf' | 'lfctrl' | 'none'; prefix?: string; mode?: 'scancode' | 'unicode' | 'numpad' | 'altcode'; latched?: boolean; repeat?: number }

async function ensureForeground(): Promise<void> {
  const st = await keys!.cmd('state')
  if (new RegExp(`fgpid=${appPid}\\b`).test(st) && (await page.evaluate(() => document.hasFocus()))) return
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.show(); w.focus() })
  const r = await keys!.cmd(`focus pid=${appPid}`)
  if (!r.startsWith('ok')) throw new Error(`cannot take the foreground, refusing to type into another window: ${r}`)
  await expect.poll(() => page.evaluate(() => document.hasFocus()), { timeout: 5000 }).toBe(true)
}
async function scan(code: string, o: ScanOpts = {}): Promise<void> {
  const gap = o.gap ?? 5
  const suffix = o.suffix ?? 'enter'
  if (mode === 'cdp') {
    for (let r = 0; r < (o.repeat ?? 1); r++) {
      if (r) await spin(Math.max(gap, 50))
      for (const ch of o.prefix ?? '') await cdpKey(ch, gap)
      for (const ch of code) await cdpKey(ch, gap)
      if (suffix === 'enter') await cdpNamed('Enter', gap)
      else if (suffix === 'crlf') { await cdpNamed('Enter', gap); await cdpNamed('Enter', gap) }
      else if (suffix === 'tab') await cdpNamed('Tab', gap)
    }
    return
  }
  await ensureForeground()
  const r = await keys!.cmd(`type text=${b64(code)} mode=${o.mode ?? 'scancode'} gap=${gap} suffix=${suffix}${o.prefix ? ` prefix=${b64(o.prefix)}` : ''}${o.latched ? ' shift=latched' : ''}${o.repeat ? ` repeat=${o.repeat}` : ''}`)
  if (!r.startsWith('ok')) throw new Error(`sendkeys: ${r}`)
}
const osOnly = (why: string) => test.skip(mode === 'cdp', `${why} cannot be produced through CDP`)

// ------------------------------------------------------------------ app helpers
const call = async (service: string, method: string, args?: unknown): Promise<any> => {
  const r = await page.evaluate(([s, m, a]) => (window as any).velmayil.call(s, m, a), [service, method, args ?? {}] as const)
  if (!r.ok) throw new Error(`${service}.${method}: ${r.error?.code} ${r.error?.message}`)
  return r.data
}
const setScannerCfg = (patch: Record<string, unknown>) => page.evaluate((p) => {
  const cur = JSON.parse(localStorage.getItem('velmayil.scanner') ?? '{}')
  localStorage.setItem('velmayil.scanner', JSON.stringify({ ...cur, ...p }))
  localStorage.removeItem('velmayil.scanner.learned')
}, patch)
const resetScannerCfg = () => page.evaluate(() => { localStorage.removeItem('velmayil.scanner'); localStorage.removeItem('velmayil.scanner.learned') })
const nav = async (label: string | RegExp) => {
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: label }).click()
  await page.waitForTimeout(500)
}
const skipShift = async () => {
  const skip = page.getByRole('button', { name: 'Skip for now' })
  if (await skip.isVisible({ timeout: 2000 }).catch(() => false)) await skip.click()
}
const scanBox = () => page.getByLabel('Scan or search products')
const noteBox = () => page.getByPlaceholder('Bill note (optional)')
const cart = () => page.evaluate(() => [...document.querySelectorAll('.pos-cart tbody tr')].map((tr) => ({ name: tr.querySelector('strong')?.textContent ?? '', qty: Number((tr.querySelector('input[aria-label="Quantity"]') as HTMLInputElement | null)?.value) })))
const cartQty = async (name: string) => (await cart()).find((l) => l.name === name)?.qty ?? 0
const lineCount = async () => (await cart()).length
/** every non-empty text field on the page (bill-quantity boxes excluded): after a scan this must be empty = nothing leaked anywhere */
const leaks = () => page.evaluate(() => [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')]
  .filter((e) => !['checkbox', 'radio', 'button', 'submit', 'hidden'].includes((e as HTMLInputElement).type) && !e.closest('.pos-cart, .pos-totals, table') && e.value !== '')
  .map((e) => `${e.getAttribute('aria-label') ?? e.placeholder ?? e.name ?? e.tagName}=${JSON.stringify(e.value)}`))
const blurAll = () => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())

async function freshBill(): Promise<void> {
  await nav(/Billing/)
  await skipShift()
  await expect(scanBox()).toBeVisible()
  if ((await lineCount()) > 0) {
    await page.getByRole('button', { name: /New bill/ }).click()
    await page.getByRole('button', { name: 'Clear bill' }).click()
  }
  await expect.poll(lineCount).toBe(0)
  await scanBox().focus()
  await page.waitForTimeout(100)
}
/** wait until the cart is exactly `expected` (name -> qty), then check nothing leaked into any field */
async function expectCart(expected: Record<string, number>, o: { allowLeak?: string[] } = {}): Promise<void> {
  await expect.poll(async () => Object.fromEntries((await cart()).map((l) => [l.name, l.qty])), { timeout: 10_000 }).toEqual(expected)
  await page.waitForTimeout(150) // a late duplicate add would show up now
  expect(Object.fromEntries((await cart()).map((l) => [l.name, l.qty])), 'no double add').toEqual(expected)
  const l = (await leaks()).filter((x) => !(o.allowLeak ?? []).some((a) => x.startsWith(a)))
  expect(l, 'no characters leaked into any field').toEqual([])
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  if (!existsSync(join(ROOT, 'out', 'main', 'index.js'))) throw new Error('Run `npm run build` first')
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v
  env.VELMAYIL_DATA_DIR = dataDir
  app = await electron.launch({ args: [ROOT, `--user-data-dir=${join(dataDir, 'chromium-profile')}`], cwd: ROOT, env })
  appPid = await app.evaluate(() => process.pid) // the Electron main process (app.process() may be a cmd.exe shim)
  page = await app.firstWindow()
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`[${m.location().url.split('/').pop()}] ${m.text()}`) })
  page.on('pageerror', (e) => consoleErrors.push(`[pageerror] ${e.message}`))
  await page.waitForLoadState('domcontentloaded')
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setContentSize(1400, 860); w.show(); w.focus() })
  await call('setup', 'complete', { shop: { shopName: 'Scanner OS Shop' }, owner: { username: 'owner', name: 'Owner', password: 'Owner@123' }, pos: {}, locationName: 'Main Store' })
  await page.reload()
  const signIn = page.getByRole('button', { name: 'Sign in' })
  if (await signIn.isVisible({ timeout: 4000 }).catch(() => false)) {
    await page.getByLabel('Username').fill('owner')
    await page.getByLabel('Password', { exact: true }).fill('Owner@123')
    await signIn.click()
  }
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible({ timeout: 20_000 })

  const mk = (name: string, barcode: string) => call('catalog', 'save', { name, hsn: '3604', taxRateBp: 0, variants: [{ name: '', mrp: 10000, price: 10000, cost: 5000, openingStock: 500, barcode }] })
  await mk('Rocket', EAN); await mk('Bomb', EAN2); await mk('Code39 Item', C39); await mk('Symbol Item', SYM)
  await mk('Long Item', LONG30); await mk('Short Item', SHORT4); await mk('Zero Item', ZEROS); await mk('Lower Item', LOWER)

  if (process.env.SCAN_E2E_MODE === 'cdp') { mode = 'cdp'; modeNote = 'forced by SCAN_E2E_MODE=cdp' } else {
    try {
      keys = await OsKeys.start()
      await ensureForeground()
      // prove the injection path really reaches the page: type one character at OS level into a throwaway field
      await page.evaluate(() => { const i = document.createElement('input'); i.id = '__probe'; i.style.cssText = 'position:fixed;top:0;left:0;z-index:99999'; document.body.appendChild(i); i.focus() })
      const r = await keys.cmd(`type text=${b64('q')} mode=scancode gap=5 suffix=none`)
      const got = await page.evaluate(() => (document.getElementById('__probe') as HTMLInputElement).value)
      await page.evaluate(() => document.getElementById('__probe')?.remove())
      if (!r.startsWith('ok') || got !== 'q') throw new Error(`probe typed ${JSON.stringify(got)} (${r})`)
      modeNote = 'real Windows SendInput (user32) into the launched Electron window'
    } catch (e) {
      mode = 'cdp'
      modeNote = `OS-level injection impossible here (${(e as Error).message}); fell back to CDP Input.dispatchKeyEvent`
      keys?.stop(); keys = null
    }
  }
  if (mode === 'cdp') cdp = await page.context().newCDPSession(page)
  test.info().annotations.push({ type: 'injection', description: modeNote })
  console.log(`[scanner-os] injection mode: ${mode} - ${modeNote}`)
})
test.afterAll(async () => {
  if (keys) { await keys.cmd('caps off').catch(() => undefined); await keys.cmd('num on').catch(() => undefined); keys.stop() }
  await app?.close().catch(() => undefined)
})

// =============================================================================================================== basics
test('01 injection path works and reports its mode', async () => {
  console.log(`[scanner-os] ${mode}: ${modeNote}`)
  expect(['os', 'cdp']).toContain(mode)
})

test('02 gaps 1/5/20 ms: scan with focus in the scan box, on the body, on the bill note => exactly one add each, nothing leaked', async () => {
  await freshBill()
  let n = 0
  for (const gap of [1, 5, 20]) {
    for (const where of ['box', 'body', 'note'] as const) {
      if (where === 'box') await scanBox().focus(); else if (where === 'body') await blurAll(); else await noteBox().focus()
      await scan(EAN, { gap })
      n++
      await expectCart({ Rocket: n })
    }
  }
})

test('03 gaps 50/90 ms (Bluetooth speed): box and body work at any speed; the note field treats it as typing until the reader is calibrated', async () => {
  await freshBill()
  let n = 0
  for (const gap of [50, 90]) {
    await scanBox().focus()
    await scan(EAN, { gap })
    await expect.poll(() => cartQty('Rocket'), { timeout: 15_000, message: `box @${gap}ms` }).toBe(++n)
    await blurAll()
    await scan(EAN, { gap })
    await expect.poll(() => cartQty('Rocket'), { timeout: 15_000, message: `body @${gap}ms` }).toBe(++n)
  }
  expect(await leaks()).toEqual([])
  // note field + slow reader: indistinguishable from typing => the text stays in the note, the cart is untouched
  await noteBox().focus()
  await scan(EAN, { gap: 90, suffix: 'none' })
  await expect(noteBox()).toHaveValue(EAN)
  expect(await cartQty('Rocket')).toBe(4)
  await noteBox().fill('')
  // after "Detect my reader" saved a wider gap (what the wizard does for a slow reader) the same scan is a scan
  await setScannerCfg({ maxGapMs: 200 })
  await noteBox().focus()
  await scan(EAN, { gap: 90 })
  await expect.poll(() => cartQty('Rocket'), { timeout: 15_000 }).toBe(5)
  await page.waitForTimeout(200)
  await expect(noteBox()).toHaveValue('')
  await resetScannerCfg()
})

test('04 suffixes: Enter, Tab, CR+LF (2nd Enter ignored, no Pay dialog), Ctrl+J, none (pause)', async () => {
  await freshBill()
  const sets: { name: string; opts: ScanOpts; cfg: Record<string, unknown> }[] = [
    { name: 'enter', opts: { suffix: 'enter' }, cfg: {} },
    { name: 'tab', opts: { suffix: 'tab' }, cfg: {} },
    { name: 'crlf', opts: { suffix: 'crlf' }, cfg: {} },
    { name: 'lfctrl', opts: { suffix: 'lfctrl' }, cfg: {} },
    { name: 'none', opts: { suffix: 'none' }, cfg: { suffix: 'none' } }
  ]
  for (const s of sets) {
    if ((s.name === 'lfctrl') && mode === 'cdp') continue
    await resetScannerCfg()
    await setScannerCfg(s.cfg)
    let n = await cartQty('Rocket')
    for (const where of ['box', 'body'] as const) {
      if (where === 'box') await scanBox().focus(); else await blurAll()
      await scan(EAN, s.opts)
      n++
      await expect.poll(() => cartQty('Rocket'), { timeout: 10_000, message: `${s.name}/${where}` }).toBe(n)
      await page.waitForTimeout(200)
      await expect(page.getByRole('dialog'), `no dialog opened by the extra terminator (${s.name}/${where})`).toHaveCount(0)
      expect(await cartQty('Rocket'), `${s.name}/${where} no double add`).toBe(n)
      expect(await leaks()).toEqual([])
    }
  }
  await resetScannerCfg()
})

test('05 prefix key / prefix character / prefix + suffix', async () => {
  await freshBill()
  await setScannerCfg({ prefix: 'Tab', suffix: 'Enter' })
  await scanBox().focus()
  await scan(EAN, { prefix: '\t' })
  await expect.poll(() => cartQty('Rocket'), { timeout: 10_000 }).toBe(1)
  await blurAll()
  await scan(EAN, { prefix: '\t' })
  await expect.poll(() => cartQty('Rocket'), { timeout: 10_000 }).toBe(2)
  await setScannerCfg({ prefix: '~', suffix: 'Tab' })
  await scanBox().focus()
  await scan(EAN, { prefix: '~', suffix: 'tab' })
  await expect.poll(() => cartQty('Rocket'), { timeout: 10_000 }).toBe(3)
  await blurAll()
  await scan(EAN, { prefix: '~', suffix: 'tab' })
  await expect.poll(() => cartQty('Rocket'), { timeout: 10_000 }).toBe(4)
  await noteBox().focus()
  await scan(EAN, { prefix: '~', suffix: 'tab' })
  await expect.poll(() => cartQty('Rocket'), { timeout: 10_000 }).toBe(5)
  expect(await leaks()).toEqual([])
  await resetScannerCfg()
})

test('06 uppercase Code 39/128, symbols via Shift+digit row, lower case, with CapsLock ON/OFF and Shift latched', async () => {
  await freshBill()
  osOnly('A real CapsLock / latched Shift')
  const items: [string, string][] = [[C39, 'Code39 Item'], [SYM, 'Symbol Item'], [LOWER, 'Lower Item']]
  for (const caps of [false, true]) {
    await keys!.cmd(caps ? 'caps on' : 'caps off')
    for (const where of ['box', 'body'] as const) {
      for (const [code, name] of items) {
        if (where === 'box') await scanBox().focus(); else await blurAll()
        const before = await cartQty(name)
        await scan(code, { gap: 4 })
        await expect.poll(() => cartQty(name), { timeout: 10_000, message: `${name} caps=${caps} ${where}` }).toBe(before + 1)
      }
    }
  }
  await keys!.cmd('caps off')
  expect(await leaks()).toEqual([])
  // Shift latched on (a reader/driver that leaves Shift down): digits arrive as symbols, repaired to digits
  await freshBill()
  for (const where of ['box', 'body'] as const) {
    if (where === 'box') await scanBox().focus(); else await blurAll()
    const before = await cartQty('Rocket')
    await scan(EAN, { gap: 4, latched: true })
    await expect.poll(() => cartQty('Rocket'), { timeout: 10_000, message: `latched ${where}` }).toBe(before + 1)
  }
  expect(await leaks()).toEqual([])
})

test('07 numeric keypad scan codes, NumLock ON and OFF', async () => {
  osOnly('Numeric keypad scan codes with NumLock state')
  await freshBill()
  for (const where of ['box', 'body', 'note'] as const) {
    if (where === 'box') await scanBox().focus(); else if (where === 'body') await blurAll(); else await noteBox().focus()
    const before = await cartQty('Rocket')
    await scan(EAN, { gap: 4, mode: 'numpad' })
    await expect.poll(() => cartQty('Rocket'), { timeout: 10_000, message: `numlock on ${where}` }).toBe(before + 1)
  }
  expect(await leaks()).toEqual([])
  await keys!.cmd('num off')
  try {
    for (const where of ['box', 'body'] as const) {
      if (where === 'box') await scanBox().focus(); else await blurAll()
      const before = await cartQty('Rocket')
      await scan(EAN, { gap: 4, mode: 'numpad' })
      await expect.poll(() => cartQty('Rocket'), { timeout: 10_000, message: `numlock OFF ${where}` }).toBe(before + 1)
    }
  } finally { await keys!.cmd('num on') }
  expect(await leaks()).toEqual([])
})

test('08 unicode (VK_PACKET) readers, long 30-char codes, short 4-digit and leading-zero codes', async () => {
  await freshBill()
  for (const where of ['box', 'body'] as const) {
    if (where === 'box') await scanBox().focus(); else await blurAll()
    for (const [code, name] of [[LONG30, 'Long Item'], [SHORT4, 'Short Item'], [ZEROS, 'Zero Item']] as const) {
      const before = await cartQty(name)
      await scan(code, { gap: 3 })
      await expect.poll(() => cartQty(name), { timeout: 10_000, message: `${name} ${where}` }).toBe(before + 1)
    }
    if (mode === 'os') {
      await blurAll()
      const before = await cartQty('Rocket')
      await scan(EAN, { gap: 3, mode: 'unicode' })
      await expect.poll(() => cartQty('Rocket'), { timeout: 10_000, message: 'unicode packets' }).toBe(before + 1)
    }
  }
  expect(await leaks()).toEqual([])
  expect(await cartQty('Zero Item')).toBe(2) // the leading zeros were kept (000123 is not 123)
})

test('09 back-to-back scans 50 ms apart (same item, then two different items)', async () => {
  await freshBill()
  await scanBox().focus()
  await scan(EAN, { gap: 3, repeat: 4 })
  await expectCart({ Rocket: 4 })
  await blurAll()
  await scan(EAN2, { gap: 3, repeat: 3 })
  await expectCart({ Rocket: 4, Bomb: 3 })
  await noteBox().focus()
  await scan(EAN, { gap: 3, repeat: 3 })
  await expectCart({ Rocket: 7, Bomb: 3 })
})

test('10 Alt+numpad "Alt code" readers (character arrives with no normal keydown)', async () => {
  osOnly('Alt+numpad codes')
  await freshBill()
  for (const where of ['box', 'body'] as const) {
    if (where === 'box') await scanBox().focus(); else await blurAll()
    const before = await cartQty('Rocket')
    await scan(EAN, { gap: 8, mode: 'altcode' })
    await expect.poll(() => cartQty('Rocket'), { timeout: 10_000, message: `altcode ${where}` }).toBe(before + 1)
  }
  expect(await leaks()).toEqual([])
})

test('11 held key (auto-repeat) is never a scan; a person can still type quantities and notes', async () => {
  osOnly('Auto-repeat of a held key')
  await freshBill()
  await noteBox().focus()
  const r = await keys!.cmd('hold name=a ms=900 rate=30')
  expect(r).toMatch(/^ok downs=\d+/)
  const downs = Number(/downs=(\d+)/.exec(r)![1])
  expect(downs).toBeGreaterThan(5)
  await keys!.cmd('key name=enter')
  await page.waitForTimeout(300)
  expect(await lineCount()).toBe(0)
  const v = await noteBox().inputValue()
  expect(v.length, 'every auto-repeated character reached the field').toBeGreaterThanOrEqual(downs - 1)
  expect(v).toMatch(/^a+$/)
  await noteBox().fill('')
  // held digit then Enter in the scan box: nothing added
  await scanBox().focus()
  await keys!.cmd('hold name=5 ms=700 rate=30')
  await keys!.cmd('key name=backspace repeat=30 gap=5')
  await page.waitForTimeout(200)
  expect(await lineCount()).toBe(0)
})

test('11b a person types in the note, then a scan follows immediately: the last typed character is neither lost nor glued onto the code', async () => {
  await freshBill()
  await noteBox().focus()
  await scan('gift wrap', { gap: 110, suffix: 'none' }) // OS-level slow typing (a person)
  await blurAll()
  await scan(EAN, { gap: 4 })
  await expectCart({ Rocket: 1 }, { allowLeak: ['Bill note'] })
  await expect(noteBox()).toHaveValue('gift wrap')
})

// =============================================================================================================== focus variants
test('12 unknown code: red message with the exact code, indicator, cart unchanged; reader-added junk is shown literally', async () => {
  await freshBill()
  await scanBox().focus()
  await scan('9999999999994', { gap: 4 })
  await expect(page.getByTestId('scan-notfound-code')).toHaveText('9999999999994')
  await expect(page.getByTestId('scan-notfound')).toContainText('Not found in catalog')
  await expect(page.getByTestId('scanner-indicator')).toContainText('9999999999')
  expect(await lineCount()).toBe(0)
  // reader adds a symbology prefix: found, and the red message disappears
  await blurAll()
  await scan(']E0' + EAN, { gap: 4 })
  await expectCart({ Rocket: 1 })
  await expect(page.getByTestId('scan-notfound')).toHaveCount(0)
  const ind = await page.getByTestId('scanner-indicator').innerText()
  expect(ind).toMatch(/^Scanner: last scan \d\d:\d\d:\d\d \(.{1,11}, [\d.]+ ms\/key\)$/)
  // scan with a trailing check-digit-stripped code
  await scan(EAN.slice(0, 12), { gap: 4 })
  await expectCart({ Rocket: 2 })
})

test('13 scan while a toast is showing, and while the cart already has lines', async () => {
  await freshBill()
  await blurAll()
  await scan('1111111111116', { gap: 4 })
  await expect(page.getByText(/Barcode not found: 1111111111116/)).toBeVisible()
  await scan(EAN, { gap: 4 }) // toast still on screen
  await expectCart({ Rocket: 1 })
  await scanBox().focus()
  await scan(EAN2, { gap: 4 })
  await expectCart({ Rocket: 1, Bomb: 1 })
})

test('14 scan while a modal is open: "Cancel this bill?" must NOT be confirmed by the reader\'s Enter', async () => {
  await freshBill()
  await scanBox().focus()
  await scan(EAN, { gap: 4 })
  await expectCart({ Rocket: 1 })
  await page.getByRole('button', { name: /New bill/ }).click() // opens "Cancel this bill?" with "Clear bill" focused
  await expect(page.getByRole('dialog', { name: 'Cancel this bill?' })).toBeVisible()
  await scan(EAN2, { gap: 4 })
  await page.waitForTimeout(400)
  await expect(page.getByRole('dialog', { name: 'Cancel this bill?' })).toBeVisible() // still open: the scan's Enter did not press "Clear bill"
  expect(await cartQty('Rocket')).toBe(1)
  await expect(page.getByText(/Close the open window, then scan again/)).toBeVisible()
  await page.getByRole('button', { name: 'Keep bill' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(scanBox()).toBeFocused()
  expect(await leaks()).toEqual([])
})

test('15 scan on the "Sale completed" dialog starts the next bill with that item', async () => {
  await freshBill()
  await scanBox().focus()
  await scan(EAN, { gap: 4 })
  await expectCart({ Rocket: 1 })
  await page.getByRole('button', { name: /^Pay/ }).click()
  await page.getByRole('button', { name: /Complete sale/ }).click()
  await expect(page.getByText('Sale completed')).toBeVisible({ timeout: 15_000 })
  await scan(EAN2, { gap: 4 }) // focus is on the dialog's "Receipt size" drop-down: still recognised as a scan
  await expect(page.getByText('Sale completed')).toHaveCount(0)
  await expectCart({ Bomb: 1 })
})

test('16 residue: number input, contenteditable and textarea with focus never keep a character of a scan', async () => {
  await freshBill()
  await page.evaluate(() => {
    const mk = (tag: string, id: string) => { const e = document.createElement(tag); e.id = id; document.querySelector('.pos-side')!.appendChild(e); return e }
    const n = mk('input', 'x-num') as HTMLInputElement; n.type = 'number'; n.setAttribute('aria-label', 'x-num')
    const t = mk('textarea', 'x-area') as HTMLTextAreaElement; t.setAttribute('aria-label', 'x-area')
    const c = mk('div', 'x-ce'); c.contentEditable = 'true'; c.textContent = 'keep'; c.style.minHeight = '20px'
    const s = mk('select', 'x-sel') as HTMLSelectElement; s.innerHTML = '<option>none</option><option>8-option</option><option>9-option</option>'
  })
  for (const id of ['x-num', 'x-area', 'x-ce', 'x-sel']) {
    await page.evaluate((i) => (document.getElementById(i) as HTMLElement).focus(), id)
    const before = await cartQty('Rocket')
    await scan(EAN, { gap: 4 })
    await expect.poll(() => cartQty('Rocket'), { timeout: 10_000, message: id }).toBe(before + 1)
    await page.waitForTimeout(100)
  }
  expect(await page.evaluate(() => (document.getElementById('x-num') as HTMLInputElement).value)).toBe('')
  expect(await page.evaluate(() => (document.getElementById('x-area') as HTMLTextAreaElement).value)).toBe('')
  expect(await page.evaluate(() => document.getElementById('x-ce')!.textContent)).toBe('keep')
  expect(await page.evaluate(() => (document.getElementById('x-sel') as HTMLSelectElement).selectedIndex)).toBe(0)
  // a person typing into them is untouched
  await page.locator('#x-area').focus()
  await page.locator('#x-area').pressSequentially('gift', { delay: 90 })
  await expect(page.locator('#x-area')).toHaveValue('gift')
  await page.evaluate(() => ['x-num', 'x-area', 'x-ce', 'x-sel'].forEach((i) => document.getElementById(i)?.remove()))
})

// =============================================================================================================== other screens
test('17 Products form: the barcode field receives the whole code (replacing the old one), nothing leaks into other fields', async () => {
  await nav('Products')
  await page.getByRole('button', { name: '+ Add product' }).click()
  await page.getByLabel('Product name').fill('Scan Form Item')
  const bc = page.getByLabel('Barcode (scan or type)')
  await bc.fill('OLD-CODE')
  for (const [code, suffix] of [[EAN, 'enter'], [EAN2, 'tab'], ['4006381333931', 'crlf']] as const) {
    await bc.focus()
    await scan(code, { gap: 4, suffix })
    await expect(bc).toHaveValue(code, { timeout: 5000 })
    await expect(page.getByRole('button', { name: 'Save product' })).toBeVisible() // dialog still open: Enter did not submit the form
  }
  // reader decorations never reach the stored value
  await bc.focus()
  await scan(']E0' + C39, { gap: 4 })
  await expect(bc).toHaveValue(C39)
  expect(await page.getByLabel('Product name').inputValue()).toBe('Scan Form Item')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
})

test('18 Spreadsheet: a scan into a selected barcode cell fills exactly that cell', async () => {
  await nav('Products')
  await page.getByRole('button', { name: 'Spreadsheet' }).click()
  const grid = page.getByRole('grid', { name: 'Product spreadsheet' })
  await expect(grid).toBeVisible()
  const saved = await call('catalog', 'save', { name: 'Grid Scan Item', hsn: '3604', taxRateBp: 0, variants: [{ mrp: 10000, price: 10000, cost: 5000 }] })
  const vid = saved.variants[0].id
  await page.getByLabel('Search grid').fill('Grid Scan Item')
  const cell = grid.locator(`[data-row="v${vid}"][data-col="barcode"]`)
  await expect(cell).toBeVisible({ timeout: 10_000 })
  await cell.click()
  await scan(']E0' + EAN2.slice(0, 12) + '1', { gap: 4, suffix: 'enter' }) // decorated: stored clean
  await expect(cell).toHaveText('4006381333931', { timeout: 5000 })
  await expect(cell).toHaveClass(/dirty/)
  // neighbouring cells untouched
  await expect(grid.locator(`[data-row="v${vid}"][data-col="price"]`)).not.toHaveClass(/dirty/)
  await expect(grid.locator(`[data-row="v${vid}"][data-col="name"]`)).toHaveText('Grid Scan Item')
  expect(await leaks()).toEqual(['Search grid="Grid Scan Item"'])
  // Tab suffix commits and moves right, still one clean value
  await cell.click()
  await scan('7000000000001', { gap: 4, suffix: 'tab' })
  await expect(cell).toHaveText('7000000000001', { timeout: 5000 })
})

test('19 stock count box and purchase product picker take scans (Enter and Tab), decorated codes included', async () => {
  const sheet = await call('inventory', 'countCreate', {})
  await nav('Stock counts')
  await page.getByText(sheet.number).first().click()
  const box = page.getByLabel('Scan to count')
  await expect(box).toBeVisible({ timeout: 10_000 })
  await box.focus()
  await scan(EAN, { gap: 4 })
  await expect(page.getByRole('status').filter({ hasText: 'Rocket: counted 1' })).toBeVisible({ timeout: 10_000 })
  await box.focus()
  await scan(']E0' + EAN, { gap: 4, suffix: 'tab' })
  await expect(page.getByRole('status').filter({ hasText: 'Rocket: counted 2' })).toBeVisible({ timeout: 10_000 })
  await box.focus()
  await scan(EAN.slice(0, 12), { gap: 4, suffix: 'crlf' })
  await expect(page.getByRole('status').filter({ hasText: 'Rocket: counted 3' })).toBeVisible({ timeout: 10_000 })
  expect((await call('inventory', 'countGet', { id: sheet.id })).summary.counted).toBeGreaterThanOrEqual(1)
  expect(await leaks()).toEqual([])

  // purchase entry: the product picker adds the scanned product (Enter, Tab, decorated)
  await nav('Purchases')
  await page.getByRole('button', { name: 'New purchase' }).click()
  const picker = page.getByLabel('Find product')
  await expect(picker).toBeVisible({ timeout: 10_000 })
  await picker.focus()
  await scan(EAN, { gap: 4 })
  await expect(page.getByRole('row').filter({ hasText: 'Rocket' })).toHaveCount(1, { timeout: 10_000 })
  await picker.focus()
  await scan(']E0' + EAN2, { gap: 4, suffix: 'tab' })
  await expect(page.getByRole('row').filter({ hasText: 'Bomb' })).toHaveCount(1, { timeout: 10_000 })
  await expect(picker).toHaveValue('')
})

test('20 Printing > Labels search box takes a scan', async () => {
  await nav(/Printing/)
  const tab = page.getByRole('tab', { name: /Labels/ })
  if (await tab.isVisible({ timeout: 2000 }).catch(() => false)) await tab.click()
  const search = page.getByRole('searchbox').first()
  await expect(search).toBeVisible({ timeout: 10_000 })
  await search.focus()
  await scan(EAN, { gap: 4, suffix: 'enter' })
  await expect(page.getByText('Rocket').first()).toBeVisible({ timeout: 10_000 })
  await expect(search).toHaveValue(EAN)
})

// =============================================================================================================== settings: wizard + diagnostics
test('21 Settings > Scanner "Detect my reader": captures a real scan, saves suffix/prefix/gap, shows layout & caps findings', async () => {
  await nav('Settings')
  await page.getByRole('tab', { name: 'Scanner' }).click()
  await resetScannerCfg()
  await page.getByTestId('wizard-start').click()
  await expect(page.getByTestId('wizard-listening')).toBeVisible()
  await scan(EAN, { gap: 6, suffix: 'tab' })
  await expect(page.getByTestId('wizard-result')).toBeVisible({ timeout: 10_000 })
  await expect(page.getByTestId('wizard-code')).toHaveText(EAN)
  await expect(page.getByTestId('wizard-summary')).toContainText('Tab key')
  await expect(page.getByTestId('wizard-saved')).toContainText('ends with Tab')
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('velmayil.scanner') ?? '{}'))
  expect(saved).toMatchObject({ suffix: 'Tab', prefix: '' })
  // nothing the wizard heard leaked into any field (the settings fields hold their own numbers, never the scanned digits)
  expect((await leaks()).filter((x) => x.includes('89012'))).toEqual([])

  // CR+LF + caps lock + slow reader
  if (mode === 'os') {
    await keys!.cmd('caps on')
    await page.getByRole('button', { name: 'Scan another to double-check' }).click()
    await scan('ABC123', { gap: 70, suffix: 'crlf' })
    await expect(page.getByTestId('wizard-result')).toContainText('Caps Lock is ON', { timeout: 10_000 })
    await expect(page.getByTestId('wizard-result')).toContainText('CR+LF')
    await expect(page.getByTestId('wizard-code')).toHaveText('ABC123')
    await keys!.cmd('caps off')
    const slow = await page.evaluate(() => JSON.parse(localStorage.getItem('velmayil.scanner') ?? '{}'))
    expect(slow.maxGapMs).toBeGreaterThanOrEqual(150)
    await page.getByRole('button', { name: 'Undo these settings' }).click()
  }
  // after calibration (the first wizard run saved "ends with Tab") the test card sees the reader's scan and looks the product up
  await blurAll()
  await scan(EAN, { gap: 4, suffix: 'tab' })
  await expect(page.getByTestId('scan-code')).toHaveText(EAN, { timeout: 10_000 })
  await expect(page.getByTestId('scan-lookup')).toContainText('Rocket')
})

test('22 connected-devices panel and troubleshooting checklist are shown', async () => {
  await nav('Settings')
  await page.getByRole('tab', { name: 'Scanner' }).click()
  await expect(page.getByText('Connected devices')).toBeVisible()
  await expect(page.getByTestId('win-devices')).toBeVisible({ timeout: 40_000 })
  // one verdict from what Windows itself reports: failed USB device / reader found / nothing reader-like
  await expect(page.getByTestId('diag-problem').or(page.getByTestId('diag-reader')).or(page.getByTestId('diag-none'))).toBeVisible()
  console.log('[scanner-os] Windows verdict on this machine:', await page.getByTestId('diag-problem').or(page.getByTestId('diag-reader')).or(page.getByTestId('diag-none')).innerText())
  await expect(page.getByTestId('troubleshooting')).toContainText('Windows does not see the reader at all')
  await expect(page.getByTestId('troubleshooting')).toContainText('USB HID Keyboard')
  await expect(page.getByTestId('troubleshooting')).toContainText('Enter suffix')
  await expect(page.getByTestId('troubleshooting')).toContainText('types into Notepad')
  await page.getByRole('button', { name: 'Refresh' }).click()
  // the Chromium device APIs the HID / serial readers use exist in this build and the main-process permission handlers answer
  const apis = await page.evaluate(async () => {
    const n = navigator as any
    return {
      hid: n.hid ? (await n.hid.getDevices()).length : null,
      serial: n.serial ? (await n.serial.getPorts()).length : null
    }
  })
  console.log('[scanner-os] navigator.hid.getDevices / navigator.serial.getPorts ->', JSON.stringify(apis))
  expect(apis.hid).not.toBeNull()
  expect(apis.serial).not.toBeNull()
  await expect(page.getByRole('button', { name: 'Connect HID reader' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Connect serial scanner' })).toBeVisible()
})

test('99 no renderer console errors', async () => {
  expect.soft(consoleErrors, 'renderer console errors').toEqual([])
})

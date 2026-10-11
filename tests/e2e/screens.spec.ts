/**
 * Walks EVERY screen of the BUILT app (out/): each menu entry, each tab on it, and on Printing & Labels each template.
 * On every screen:
 *   - no crash screen, no JavaScript error, no error in the console
 *   - the window itself never scrolls. The shell fills the window and only the page inside it scrolls; when the window scrolls,
 *     the whole app slides up and the rest of the window is blank ("white screen"). Moving the keyboard focus to any control
 *     (a click on a switch far down a long page does exactly that) must not scroll it either.
 *
 * Run:  npm run build && npx playwright test -c tests/e2e/playwright.config.ts screens.spec.ts
 */
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(__dirname, '..', '..')
const dataDir = mkdtempSync(join(tmpdir(), 'velmayil-screens-e2e-'))
const consoleErrors: string[] = []
const problems: string[] = []

let app: ElectronApplication
let page: Page

const call = async (service: string, method: string, args?: unknown): Promise<any> => {
  const r = await page.evaluate(([s, m, a]) => (window as any).velmayil.call(s, m, a), [service, method, args ?? {}] as const)
  if (!r.ok) throw new Error(`${service}.${method}: ${r.error?.code} ${r.error?.message}`)
  return r.data
}
const mainNav = () => page.getByRole('navigation', { name: 'Main' })

/** Focus every control of the screen in turn; report what made the window (or the clipped main area) scroll. */
async function check(where: string): Promise<void> {
  const found = await page.evaluate(() => {
    const out: string[] = []
    const main = document.querySelector('.main')
    const state = () => `${Math.round(window.scrollY)}/${Math.round(document.body.scrollTop)}/${Math.round(main?.scrollTop ?? 0)}`
    const reset = () => { window.scrollTo(0, 0); document.body.scrollTop = 0; if (main) main.scrollTop = 0 }
    if (document.querySelector('.crash')) out.push('crash screen is shown')
    if (state() !== '0/0/0') out.push(`window is scrolled (${state()})`)
    reset()
    const before = document.activeElement as HTMLElement | null
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('#root input, #root select, #root textarea, #root button, #root a[href], #root [tabindex]'))) {
      if ((el as HTMLInputElement).disabled) continue
      el.focus()
      if (state() !== '0/0/0') {
        if (out.length < 6) out.push(`focus on <${el.tagName.toLowerCase()}> "${(el.closest('label')?.textContent || el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 40)}" scrolled the window (${state()})`)
        reset()
      }
    }
    before?.focus?.()
    const d = document.documentElement
    if (d.scrollHeight > window.innerHeight + 1) out.push(`document is taller than the window (${d.scrollHeight} > ${window.innerHeight})`)
    return out
  })
  for (const f of found) problems.push(`${where}: ${f}`)
}

/** Close whatever a screen opened by itself (the POS offers "Open cash shift"). */
async function dismiss(): Promise<void> {
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
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`[${m.location().url.split('/').pop()}] ${m.text()}`) })
  page.on('pageerror', (e) => consoleErrors.push(`[pageerror] ${e.message}`))
  await page.waitForLoadState('domcontentloaded')
  // a small window: long pages scroll, which is where the layout breaks
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setContentSize(1100, 660); w.show() })
  await call('setup', 'complete', { shop: { shopName: 'Screens Shop' }, owner: { username: 'owner', name: 'Owner', password: 'Owner@123' }, pos: {}, locationName: 'Main Store' })
  await page.reload()
  const signIn = page.getByRole('button', { name: 'Sign in' })
  if (await signIn.isVisible({ timeout: 4000 }).catch(() => false)) {
    await page.getByLabel('Username').fill('owner')
    await page.getByLabel('Password', { exact: true }).fill('Owner@123')
    await signIn.click()
  }
  await expect(mainNav()).toBeVisible({ timeout: 20_000 })
  // something to show: a product with stock and one sale
  const saved = await call('catalog', 'save', { name: 'Flower Pot Deluxe', hsn: '3604', taxRateBp: 0, variants: [{ name: '', mrp: 10000, price: 10000, cost: 5000, openingStock: 20, barcode: '200000777' }] })
  await call('printing', 'renderLabelHtml', { variantIds: [{ variantId: saved.variants[0].id }], template: 'label_barcode' })
})
test.afterAll(async () => {
  await app?.close().catch(() => undefined)
})

test('01 every menu entry and every tab opens without an error and without scrolling the window', async () => {
  test.setTimeout(600_000)
  const links = mainNav().getByRole('link')
  const n = await links.count()
  expect(n).toBeGreaterThan(8)
  for (let i = 0; i < n; i++) {
    const name = (await links.nth(i).locator('.nav-label').innerText().catch(() => '')).trim() || `menu ${i + 1}`
    await links.nth(i).click()
    await page.waitForTimeout(700)
    await dismiss()
    await check(name)
    const tabs = page.locator('#root [role="tab"]:not([disabled])')
    const t = await tabs.count()
    for (let j = 0; j < t; j++) {
      const tab = tabs.nth(j)
      if (!(await tab.isVisible().catch(() => false))) continue
      const tabName = (await tab.innerText()).split('\n')[0].trim()
      await tab.click()
      await page.waitForTimeout(600)
      await dismiss()
      await check(`${name} > ${tabName}`)
    }
  }
  expect(problems, problems.join('\n')).toEqual([])
  expect(consoleErrors, consoleErrors.join('\n')).toEqual([])
})

test('02 Printing & Labels: every template, with a switch at the bottom of the page clicked', async () => {
  test.setTimeout(300_000)
  await mainNav().getByRole('link', { name: /Printing/ }).click()
  await page.getByRole('tab', { name: 'Templates' }).click()
  const picker = page.getByLabel('Document')
  await expect(picker).toBeVisible({ timeout: 15_000 })
  const kinds = await picker.locator('option').evaluateAll((o) => o.map((x) => (x as HTMLOptionElement).value))
  expect(kinds.length).toBeGreaterThan(4)
  for (const kind of kinds) {
    await picker.selectOption(kind)
    await expect(page.locator('#root .toggle').first()).toBeVisible({ timeout: 15_000 })
    await page.waitForTimeout(500)
    // the last switch of the long settings column: clicking it twice leaves the template as it was
    const last = page.locator('#root .page .grid2 > div:first-child .toggle').last()
    await last.scrollIntoViewIfNeeded()
    await last.click()
    await last.click()
    const scrolled = await page.evaluate(() => `${Math.round(window.scrollY)}/${Math.round(document.body.scrollTop)}/${Math.round(document.querySelector('.main')?.scrollTop ?? 0)}`)
    if (scrolled !== '0/0/0') problems.push(`Templates > ${kind}: clicking the last switch scrolled the window (${scrolled})`)
    await page.evaluate(() => { window.scrollTo(0, 0); const m = document.querySelector('.main'); if (m) m.scrollTop = 0 })
    await check(`Templates > ${kind}`)
    // the menu and the top bar are still where they belong
    const top = await page.evaluate(() => Math.round(document.querySelector('.sidebar')!.getBoundingClientRect().top))
    expect(top, `sidebar moved on ${kind}`).toBe(0)
  }
  expect(problems, problems.join('\n')).toEqual([])
  expect(consoleErrors, consoleErrors.join('\n')).toEqual([])
})

/**
 * Direct label printing (TSPL) through the BUILT app (out/): a label printer profile with "print in the printer's own language"
 * on, labels printed from the label window, and the bytes that would reach the printer read back.
 * Nothing reaches a real printer: POS_RAW_DUMP_DIR keeps every raw job as a file. The decoded labels are written as PNG files
 * next to the test results (.qa-pw-output/tspl) so a person can look at them.
 *
 * Run:  npm run build && npx playwright test -c tests/e2e/playwright.config.ts label-tspl.spec.ts
 */
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { deflateSync } from 'node:zlib'
import { parseTspl } from '../printing/tsplParse'
import type { MonoBitmap } from '../../src/main/modules/printing/tspl'

const ROOT = resolve(__dirname, '..', '..')
const dataDir = mkdtempSync(join(tmpdir(), 'velmayil-tspl-e2e-'))
const dumpDir = join(dataDir, 'raw')
const OUT = join(ROOT, '.qa-pw-output', 'tspl')
const consoleErrors: string[] = []

let app: ElectronApplication
let page: Page
let variantId = 0

const call = async (service: string, method: string, args?: unknown): Promise<any> => {
  const r = await page.evaluate(([s, m, a]) => (window as any).velmayil.call(s, m, a), [service, method, args ?? {}] as const)
  if (!r.ok) throw new Error(`${service}.${method}: ${r.error?.code} ${r.error?.message}`)
  return r.data
}
const jobs = (): Buffer[] => (existsSync(dumpDir) ? readdirSync(dumpDir).sort().map((f) => readFileSync(join(dumpDir, f))) : [])

/** 1-bit label as a PNG (black dots on white) */
function png(b: MonoBitmap): Buffer {
  const crcT: number[] = []
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0 }
  const crc = (x: Buffer) => { let c = 0xffffffff; for (const v of x) c = crcT[(c ^ v) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const chunk = (t: string, d: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]) }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(b.width, 0); ihdr.writeUInt32BE(b.height, 4); ihdr[8] = 1; ihdr[9] = 0
  const rb = Math.ceil(b.width / 8)
  const rows: Buffer[] = []
  for (let y = 0; y < b.height; y++) rows.push(Buffer.concat([Buffer.from([0]), Buffer.from(b.bits.subarray(y * rb, y * rb + rb).map((v) => ~v & 0xff))]))
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))])
}
const dark = (b: MonoBitmap, x0 = 0, y0 = 0, x1 = b.width, y1 = b.height): number => {
  const rb = Math.ceil(b.width / 8)
  let n = 0
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (b.bits[y * rb + (x >> 3)] & (0x80 >> (x & 7))) n++
  return n
}
/** widths of the black runs along one row */
const runs = (b: MonoBitmap, y: number): number[] => {
  const rb = Math.ceil(b.width / 8)
  const out: number[] = []
  let cur = 0
  for (let x = 0; x < b.width; x++) {
    const on = !!(b.bits[y * rb + (x >> 3)] & (0x80 >> (x & 7)))
    if (on) cur++
    else if (cur) { out.push(cur); cur = 0 }
  }
  if (cur) out.push(cur)
  return out
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  if (!existsSync(join(ROOT, 'out', 'main', 'index.js'))) throw new Error('Run `npm run build` first')
  mkdirSync(OUT, { recursive: true })
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v
  env.VELMAYIL_DATA_DIR = dataDir
  env.POS_RAW_DUMP_DIR = dumpDir
  app = await electron.launch({ args: [ROOT, `--user-data-dir=${join(dataDir, 'chromium-profile')}`], cwd: ROOT, env })
  page = await app.firstWindow()
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`[${m.location().url.split('/').pop()}] ${m.text()}`) })
  page.on('pageerror', (e) => consoleErrors.push(`[pageerror] ${e.message}`))
  await page.waitForLoadState('domcontentloaded')
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setContentSize(1400, 860); w.show() })
  await call('setup', 'complete', { shop: { shopName: 'Label Quality Shop' }, owner: { username: 'owner', name: 'Owner', password: 'Owner@123' }, pos: {}, locationName: 'Main Store' })
  await page.reload()
  const signIn = page.getByRole('button', { name: 'Sign in' })
  if (await signIn.isVisible({ timeout: 4000 }).catch(() => false)) {
    await page.getByLabel('Username').fill('owner')
    await page.getByLabel('Password', { exact: true }).fill('Owner@123')
    await signIn.click()
  }
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible({ timeout: 20_000 })
  const saved = await call('catalog', 'save', { name: 'Shahara Music Gun', hsn: '3604', taxRateBp: 0, variants: [{ name: '', mrp: 25000, price: 19900, cost: 9000, openingStock: 5, barcode: '2001230004' }] })
  variantId = saved.variants[0].id
})
test.afterAll(async () => { await app?.close().catch(() => undefined) })

test('01 labels on a direct (TSPL) label printer: exact size, one picture per label, sharp bars', async () => {
  await call('printing', 'savePrinterProfile', { name: 'Label printer', deviceName: '4BARCODE 4B-2054N', kind: 'label', isDefault: true, calibration: { tspl: true, labelGapMm: 2, dpi: 203 } })
  const r = await call('printing', 'renderLabelHtml', { template: 'label_barcode', variantIds: [{ variantId, copies: 3 }] })
  const res = await call('printing', 'print', { html: r.html, paper: 'label', widthMm: 50, heightMm: 25, docRef: 'labels-3' })
  expect(res).toMatchObject({ ok: true })
  const [job] = jobs()
  expect(job).toBeTruthy()
  const { lines, labels } = parseTspl(job)
  expect(lines.slice(0, 3)).toEqual(['SIZE 50 mm,25 mm', 'GAP 2 mm,0 mm', 'DIRECTION 1,0'])
  // the 3 copies are one picture printed 3 times
  expect(labels).toHaveLength(1)
  expect(labels[0].copies).toBe(3)
  const b = labels[0].bitmap
  // 50 x 25 mm at 203 dpi = 400 x 200 dots
  expect([b.width, b.height]).toEqual([400, 200])
  writeFileSync(join(OUT, 'label-50x25.png'), png(b))
  const ink = dark(b) / (b.width * b.height)
  expect(ink).toBeGreaterThan(0.04) // there is a label on it ...
  expect(ink).toBeLessThan(0.5) // ... and it is not a black block (inverted bitmap)
  // the bars: the run pattern that repeats on many rows (bars are vertical; text is not); every bar is whole modules
  const seen = new Map<string, number>()
  for (let y = 0; y < b.height; y++) { const k = runs(b, y).join(','); seen.set(k, (seen.get(k) ?? 0) + 1) }
  const key = [...seen.entries()].filter(([k, n]) => n >= 30 && k.split(',').length > 20).sort((x, y) => y[0].split(',').length - x[0].split(',').length)[0]?.[0] ?? ''
  const bars = key ? key.split(',').map(Number) : []
  expect(bars.length).toBeGreaterThan(20)
  const module = Math.min(...bars)
  expect(module).toBeGreaterThanOrEqual(2)
  for (const w of bars) expect(w % module, `bar of ${w} dots on a ${module}-dot module`).toBe(0)
  const log = await call('printing', 'listPrintLog', { limit: 1 })
  expect(log[0]).toMatchObject({ ok: true, action: 'print-tspl', printer: '4BARCODE 4B-2054N' })
})

test('02 unit labels: every label number is its own picture; the test page prints on labels too', async () => {
  const before = jobs().length
  const plan = await call('units', 'labelPlan', { variantId, count: 3 })
  const issued = await call('units', 'issueLabels', { items: [{ variantId, count: 3 }], receiveExtra: false })
  const codes: string[] = issued.items[0].codes
  expect(codes).toHaveLength(3)
  expect(plan.previewCodes[0]).toBe(codes[0])
  const r = await call('printing', 'renderLabelHtml', { template: 'label_barcode', unitCodes: codes, copies: 1 })
  expect((await call('printing', 'print', { html: r.html, paper: 'label', widthMm: 50, heightMm: 25 })).ok).toBe(true)
  const { labels } = parseTspl(jobs()[before])
  expect(labels.map((l) => l.copies)).toEqual([1, 1, 1])
  expect(new Set(labels.map((l) => l.bitmap.bits.toString('base64'))).size).toBe(3)
  labels.forEach((l, i) => writeFileSync(join(OUT, `unit-label-${i + 1}.png`), png(l.bitmap)))

  const t = await call('printing', 'testPrint', { paper: 'label' })
  expect(t.ok).toBe(true)
  const test = parseTspl(jobs()[before + 1])
  expect(test.labels.length).toBeGreaterThanOrEqual(1)
  test.labels.forEach((l, i) => writeFileSync(join(OUT, `test-page-${i + 1}.png`), png(l.bitmap)))
})

test('03 settings: darkness, gap, flip and offsets reach the printer', async () => {
  const before = jobs().length
  const prof = (await call('printing', 'listPrinterProfiles'))[0]
  await call('printing', 'savePrinterProfile', { id: prof.id, name: prof.name, deviceName: prof.deviceName, kind: 'label', isDefault: true, calibration: { ...prof.calibration, darkness: 8, labelGapMm: 3, flip: true, offsetXmm: 1 } })
  const r = await call('printing', 'renderLabelHtml', { template: 'label_barcode', variantIds: [{ variantId, copies: 1 }] })
  expect((await call('printing', 'print', { html: r.html, paper: 'label', widthMm: 50, heightMm: 25 })).ok).toBe(true)
  const { lines } = parseTspl(jobs()[before])
  expect(lines).toEqual(expect.arrayContaining(['GAP 3 mm,0 mm', 'DIRECTION 0,0', 'REFERENCE 8,0', 'DENSITY 13']))
})

test('04 no label printer set up: a label is never sent silently to the Windows default printer', async () => {
  for (const p of await call('printing', 'listPrinterProfiles')) await call('printing', 'deletePrinterProfile', { id: p.id })
  // the dialog would wait for a person: only check what the service decides, through a dry run of the label window
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Products' }).click()
  await page.getByText('Shahara Music Gun').first().click()
  await page.getByRole('button', { name: 'Print label', exact: true }).first().click()
  const dlg = page.getByRole('dialog', { name: /barcode label/ })
  await expect(dlg).toBeVisible({ timeout: 15_000 })
  await expect(dlg.getByTestId('label-no-printer')).toBeVisible({ timeout: 15_000 })
  // one click sets it up: the installed printers are offered, a TSC-compatible one is picked with direct printing on
  await dlg.getByTestId('label-setup-printer').click()
  const choose = dlg.getByLabel('Label printer', { exact: true })
  await expect(choose).toBeVisible()
  const installed = await choose.locator('option').evaluateAll((o) => o.map((x) => (x as HTMLOptionElement).value))
  expect(installed.length).toBeGreaterThan(0)
  const tsplName = installed.find((n) => /4\s*barcode|tsc|xprinter/i.test(n))
  if (tsplName) {
    await expect(choose).toHaveValue(tsplName)
    await expect(dlg.getByRole('checkbox', { name: /printer's language/ })).toBeChecked()
  }
  await dlg.getByTestId('label-setup-save').click()
  await expect(dlg.getByTestId('label-no-printer')).toHaveCount(0)
  const prof = (await call('printing', 'listPrinterProfiles')).find((p: any) => p.kind === 'label')
  expect(prof).toMatchObject({ isDefault: true, deviceName: tsplName ?? installed[0] })
  if (tsplName) {
    expect(prof.calibration.tspl).toBe(true)
    // printing from the window now goes straight to it as TSPL
    const before = jobs().length
    await dlg.getByTestId('label-print').click()
    await expect.poll(() => jobs().length, { timeout: 20_000 }).toBe(before + 1)
    expect(parseTspl(jobs()[before]).lines[0]).toBe('SIZE 50 mm,25 mm')
  }
})

test('05 product screen: stock in hand corrects a wrong opening stock (label numbers follow)', async () => {
  await page.keyboard.press('Escape').catch(() => undefined)
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Products' }).click()
  const p = await call('catalog', 'save', { name: 'Dragon and Peacock', hsn: '3604', taxRateBp: 0, variants: [{ name: '', mrp: 5000, price: 4000, cost: 2000, openingStock: 3000, barcode: '2001230021' }] })
  const vid = p.variants[0].id
  await page.getByPlaceholder(/Search name, SKU/).fill('Dragon and Peacock')
  await page.waitForTimeout(700)
  await page.getByText('Dragon and Peacock').first().click()
  const box = page.getByTestId('stock-in-hand')
  await expect(box).toHaveValue('3000')
  await box.fill('30')
  await expect(page.getByText('Was 3000. Saved as a stock correction')).toBeVisible()
  await page.getByRole('button', { name: /^Save/ }).last().click()
  await expect(page.getByText(/stock reduced to 30/).first()).toBeVisible({ timeout: 15_000 })
  expect((await call('inventory', 'lookup', { code: '2001230021' })).qtyAtLocation).toBe(30)
  // open again: the field shows the new stock; raise it
  await page.getByText('Dragon and Peacock').first().click()
  await expect(page.getByTestId('stock-in-hand')).toHaveValue('30')
  await page.getByTestId('stock-in-hand').fill('35')
  await page.getByRole('button', { name: /^Save/ }).last().click()
  await expect(page.getByText(/stock increased to 35/).first()).toBeVisible({ timeout: 15_000 })
  expect((await call('inventory', 'lookup', { code: '2001230021' })).qtyAtLocation).toBe(35)
  expect((await call('inventory', 'verifyLedger')).ok).toBe(true)
  expect(vid).toBeGreaterThan(0)
})

test('99 no renderer errors', async () => {
  expect(consoleErrors.filter((e) => !/Failed to load resource|net::ERR/.test(e))).toEqual([])
})

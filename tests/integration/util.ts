import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestApp } from '../helpers'
import type { App } from '../../src/main/core/app'
import type { PrintingService } from '../../src/main/modules/printing/service'
import { FakePrinter, makePng } from '../printing/fixtures'

export { FakePrinter, makePng }

export const call = <T = any>(app: App, svc: string, method: string, args?: unknown) => app.call(svc, method, args) as Promise<T>

/** EAN-13 with a correct check digit from a 12-digit body. */
export function ean13(body12: string): string {
  let s = 0
  for (let i = 0; i < 12; i++) s += Number(body12[i]) * (i % 2 === 0 ? 1 : 3)
  return body12 + String((10 - (s % 10)) % 10)
}

export interface Prod {
  name: string
  sku: string
  barcode: string
  category: string
  hsn: string
  gstPct: number
  mrp: number // paise
  price: number // paise (tax inclusive)
  cost: number
  opening: number
}

const GST = [5, 12, 18, 28]
const BASE: [string, string][] = [
  ['Sparkler Box 10cm', 'Sparklers'], ['Sparkler Box 15cm', 'Sparklers'], ['Sparkler Box 30cm', 'Sparklers'],
  ['Flower Pot Small', 'Flower Pots'], ['Flower Pot Big', 'Flower Pots'], ['Flower Pot Deluxe', 'Flower Pots'],
  ['Ground Chakkar Pack', 'Chakkars'], ['Ground Chakkar Special', 'Chakkars'], ['Rocket Bomb 2 Pcs', 'Rockets'],
  ['Rocket Whistling 5 Pcs', 'Rockets'], ['Atom Bomb', 'Bombs'], ['Lakshmi Bomb 10 Pcs', 'Bombs'],
  ['Bijili Cracker Red', 'Crackers'], ['Bijili Cracker Green', 'Crackers'], ['Garland 1000 Wala', 'Garlands'],
  ['Garland 2000 Wala', 'Garlands'], ['Pencil Fountain', 'Fountains'], ['Colour Fountain', 'Fountains'],
  ['Magic Pop Pop', 'Novelty'], ['Snake Tablet', 'Novelty'], ['Gift Box Family', 'Gift Boxes'],
  ['Gift Box Mega', 'Gift Boxes'], ['Matchbox Pack', 'Accessories'], ['Sky Shot 7 Shot', 'Sky Shots']
]
/** Prices are chosen so the tax-inclusive price contains a "round" tax for the first four items (hand-checkable). */
export const FIXED: Record<string, { price: number; gst: number }> = {
  'Sparkler Box 10cm': { price: 11800, gst: 18 }, // taxable 10000, tax 1800
  'Sparkler Box 15cm': { price: 10500, gst: 5 }, // taxable 10000, tax 500
  'Sparkler Box 30cm': { price: 11200, gst: 12 }, // taxable 10000, tax 1200
  'Flower Pot Small': { price: 12800, gst: 28 }, // taxable 10000, tax 2800
  'Flower Pot Big': { price: 10050, gst: 5 } // tax 479 (478.57 rounded), total rounds to 10100
}

export function crackersCatalog(): Prod[] {
  return BASE.map(([name, category], i) => {
    const fx = FIXED[name]
    const gst = fx?.gst ?? GST[i % 4]
    const price = fx?.price ?? 5000 + i * 1300 + 7 * i
    return {
      name, category, sku: `CRK${String(i + 1).padStart(3, '0')}`, barcode: ean13(String(890123400000 + i * 7 + 1).slice(0, 12)),
      hsn: '3604', gstPct: gst, mrp: price + 500, price, cost: Math.round(price * 0.6), opening: 100
    }
  })
}

export function catalogCsv(prods: Prod[]): string {
  const rows = [['Name', 'SKU', 'Barcode', 'Category', 'HSN', 'GST %', 'MRP', 'Price', 'Cost', 'Opening Stock']]
  for (const p of prods) rows.push([p.name, p.sku, p.barcode, p.category, p.hsn, String(p.gstPct), (p.mrp / 100).toFixed(2), (p.price / 100).toFixed(2), (p.cost / 100).toFixed(2), String(p.opening)])
  return rows.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\n') + '\n'
}

/** First-run on an EMPTY database exactly like the wizard does (setup.complete), file-backed so backup/restore work. */
export async function freshShop(opts: { shopName?: string; dir?: string } = {}): Promise<{ app: App; dir: string; printer: FakePrinter }> {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), 'vqa-'))
  const app = createTestApp({ seed: false, dbPath: join(dir, 'pos.db'), userDataDir: dir })
  await app.call('setup', 'complete', {
    shop: {
      shopName: opts.shopName ?? 'Sri Lakshmi Fireworks & Crackers Wholesale and Retail',
      address: '12, Cracker Street, Near Bus Stand', city: 'Sivakasi', state: 'Tamil Nadu', pinCode: '626123',
      phone: '9876543210', gstin: '33ABCDE1234F1Z5'
    },
    owner: { username: 'owner', name: 'Shop Owner', password: 'Owner@123' },
    pos: { code: 'POS-01', name: 'Counter 1' },
    locationName: 'Main Store'
  })
  const printer = new FakePrinter()
  app.get<PrintingService>('printing').setAdapter(printer)
  return { app, dir, printer }
}

/** Independent integer oracle for tax-inclusive carts without discounts (BigInt, exact rational half-up). */
export function oracleInclusive(lines: { qty: number; price: number; bp: number }[]): { tax: number; pre: number; total: number; roundOff: number } {
  let tax = 0n
  let pre = 0n
  for (const l of lines) {
    const net = BigInt(l.qty) * BigInt(l.price)
    const num = net * BigInt(l.bp)
    const den = 10000n + BigInt(l.bp)
    // half-up of num/den
    let q = num / den
    if ((num % den) * 2n >= den) q += 1n
    tax += q
    pre += net
  }
  // round to rupee half-up
  let r = (pre / 100n) * 100n
  if ((pre % 100n) >= 50n) r += 100n
  return { tax: Number(tax), pre: Number(pre), total: Number(r), roundOff: Number(r - pre) }
}

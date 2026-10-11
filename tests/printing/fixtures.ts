import { deflateSync } from 'node:zlib'
import type { App } from '../../src/main/core/app'
import type { PrintAdapter, PrintJobOpts, PdfJobOpts } from '../../src/main/modules/printing/adapter'

// ---------------------------------------------------------------- tiny valid image generators (plain Node)
const crcTable = (() => {
  const t: number[] = []
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
const crc32 = (b: Buffer) => {
  let c = 0xffffffff
  for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type: string, data: Buffer) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}

export function makePng(w: number, h: number, opts: { alpha?: boolean } = {}): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = opts.alpha ? 6 : 2
  const bpp = opts.alpha ? 4 : 3
  const row = Buffer.alloc(1 + w * bpp, 0x7f)
  row[0] = 0
  const raw = Buffer.concat(Array.from({ length: h }, () => row))
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

/** Header-only JPEG (SOI + APP0 + SOF0 + EOI): enough for dimension parsing. */
export function makeJpeg(w: number, h: number): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00])
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01])
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])])
}

const riff = (fourcc: string, payload: Buffer) => {
  const body = Buffer.concat([Buffer.from('WEBP'), Buffer.from(fourcc), (() => { const l = Buffer.alloc(4); l.writeUInt32LE(payload.length); return l })(), payload])
  const size = Buffer.alloc(4)
  size.writeUInt32LE(body.length)
  return Buffer.concat([Buffer.from('RIFF'), size, body])
}
const le24 = (n: number) => Buffer.from([n & 255, (n >> 8) & 255, (n >> 16) & 255])

export function makeWebpExtended(w: number, h: number, alpha = false): Buffer {
  return riff('VP8X', Buffer.concat([Buffer.from([alpha ? 0x10 : 0, 0, 0, 0]), le24(w - 1), le24(h - 1)]))
}
export function makeWebpLossless(w: number, h: number): Buffer {
  const bits = ((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14)
  const b = Buffer.alloc(5)
  b[0] = 0x2f
  b.writeUInt32LE(bits >>> 0, 1)
  return riff('VP8L', b)
}
export function makeWebpLossy(w: number, h: number): Buffer {
  const p = Buffer.alloc(10)
  p[3] = 0x9d; p[4] = 0x01; p[5] = 0x2a
  p.writeUInt16LE(w, 6)
  p.writeUInt16LE(h, 8)
  return riff('VP8 ', p)
}
export const makeSvg = (viewBox = '0 0 200 100') =>
  Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}"><rect width="200" height="100" fill="#c00"/></svg>`)

// ---------------------------------------------------------------- fake printer
export class FakePrinter implements PrintAdapter {
  jobs: { html: string; opts: PrintJobOpts }[] = []
  pdfs: { html: string; opts: PdfJobOpts }[] = []
  failWith: string | null = null
  throwWith: string | null = null
  printers = [{ name: 'POS-58-USB', displayName: 'POS-58 USB', isDefault: true }, { name: 'Office A4', displayName: 'Office A4', isDefault: false }]
  async print(html: string, opts: PrintJobOpts) {
    if (this.throwWith) throw new Error(this.throwWith)
    if (this.failWith) return { ok: false, error: this.failWith }
    this.jobs.push({ html, opts })
    return { ok: true }
  }
  async toPdf(html: string, opts: PdfJobOpts) {
    this.pdfs.push({ html, opts })
    return Buffer.from('%PDF-1.4 fake')
  }
  async listPrinters() {
    return this.printers
  }
}

// ---------------------------------------------------------------- sales fixture
export function insertSale(app: App, o: { invoiceNo: string; profileVersionId: number; lines?: { name: string; qty: number; price: number }[]; customer?: { name: string; phone: string } }): number {
  const db = app.db
  const lines = o.lines ?? [{ name: 'Sparkler Box', qty: 2, price: 11800 }]
  const pos = db.value<number>('SELECT id FROM pos_terminals WHERE is_local=1')!
  const user = app.session!.userId
  let cust: number | null = null
  if (o.customer) cust = db.run('INSERT INTO customers(uuid,name,phone) VALUES (?,?,?)', app.uuid(), o.customer.name, o.customer.phone).lastId
  const total = lines.reduce((s, l) => s + l.qty * l.price, 0)
  const tax = Math.round((total * 1800) / 11800)
  const sale = db.run(
    `INSERT INTO sales(uuid,invoice_no,pos_id,user_id,customer_id,subtotal,discount,tax,round_off,total,paid,change_given,profile_version_id) VALUES (?,?,?,?,?,?,?,?,0,?,?,?,?)`,
    app.uuid(), o.invoiceNo, pos, user, cust, total - tax, 0, tax, total, total + 1000, 1000, o.profileVersionId
  ).lastId
  const p = db.run("INSERT INTO products(uuid,name,hsn) VALUES (?,?,'3604')", app.uuid(), 'Item ' + o.invoiceNo).lastId
  const v = db.run('INSERT INTO product_variants(uuid,product_id,sku,price,mrp) VALUES (?,?,?,?,?)', app.uuid(), p, 'SKU-' + o.invoiceNo, 11800, 12500).lastId
  for (const l of lines) {
    const lt = l.qty * l.price
    db.run(
      `INSERT INTO sale_items(sale_id,variant_id,name,sku,hsn,qty,unit_price,mrp,tax_rate_bp,tax_amount,line_total) VALUES (?,?,?,?,?,?,?,?,1800,?,?)`,
      sale, v, l.name, 'SKU-' + o.invoiceNo, '3604', l.qty, l.price, l.price, Math.round((lt * 1800) / 11800), lt
    )
  }
  db.run("INSERT INTO sale_payments(sale_id,method,amount) VALUES (?, 'cash', ?)", sale, total + 1000)
  return sale
}

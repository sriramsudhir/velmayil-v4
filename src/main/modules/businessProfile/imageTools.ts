import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { AppError } from '@shared/ipc'

/** Pure TypeScript image helpers for the shop logo (testable under plain Node: no Electron, no sharp). */

export type LogoFormat = 'png' | 'jpeg' | 'webp' | 'svg'
export const MAX_LOGO_BYTES = 2 * 1024 * 1024
export const MIME_BY_FORMAT: Record<LogoFormat, string> = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp', svg: 'image/svg+xml' }

export interface ImageInfo {
  format: LogoFormat
  mime: string
  widthPx: number
  heightPx: number
  hasTransparency: boolean
}

export interface ParsedLogo extends ImageInfo {
  /** Bytes to store (SVG is stored sanitized). */
  bytes: Buffer
  sha256: string
  sizeBytes: number
}

const u16be = (b: Uint8Array, o: number) => (b[o] << 8) | b[o + 1]
const u32be = (b: Uint8Array, o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0
const u24le = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)
const ascii = (b: Uint8Array, o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n))

/** Detect the real format from magic bytes (never from the file extension). */
export function detectFormat(b: Uint8Array): LogoFormat | null {
  if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, 3) === 'PNG' && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'png'
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg'
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return 'webp'
  const head = Buffer.from(b.subarray(0, Math.min(b.length, 2048))).toString('utf8').replace(/^﻿/, '')
  const svgAt = head.search(/<svg[\s>]/i)
  if (svgAt >= 0 && head.trimStart().startsWith('<') && !/<(html|body|script|iframe)\b/i.test(head.slice(0, svgAt))) return 'svg'
  return null
}

export function parsePng(b: Uint8Array): { widthPx: number; heightPx: number; hasTransparency: boolean } {
  if (b.length < 33 || ascii(b, 12, 4) !== 'IHDR') throw new AppError('VALIDATION', 'Corrupt PNG file')
  const widthPx = u32be(b, 16)
  const heightPx = u32be(b, 20)
  const colorType = b[25]
  let hasTransparency = colorType === 4 || colorType === 6
  let o = 8
  while (!hasTransparency && o + 8 <= b.length) {
    const len = u32be(b, o)
    const type = ascii(b, o + 4, 4)
    if (type === 'tRNS') hasTransparency = true
    if (type === 'IDAT' || type === 'IEND') break
    o += 12 + len
  }
  return { widthPx, heightPx, hasTransparency }
}

export function parseJpeg(b: Uint8Array): { widthPx: number; heightPx: number; hasTransparency: boolean } {
  let o = 2
  while (o + 4 <= b.length) {
    if (b[o] !== 0xff) { o++; continue }
    const m = b[o + 1]
    if (m === 0xff) { o++; continue }
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd8)) { o += 2; continue }
    if (m === 0xd9) break
    const len = u16be(b, o + 2)
    const isSof = m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc
    if (isSof) {
      if (o + 9 > b.length) break
      return { heightPx: u16be(b, o + 5), widthPx: u16be(b, o + 7), hasTransparency: false }
    }
    o += 2 + len
  }
  throw new AppError('VALIDATION', 'Corrupt JPEG file (no frame header)')
}

export function parseWebp(b: Uint8Array): { widthPx: number; heightPx: number; hasTransparency: boolean } {
  const chunk = ascii(b, 12, 4)
  if (chunk === 'VP8X' && b.length >= 30) {
    return { widthPx: u24le(b, 24) + 1, heightPx: u24le(b, 27) + 1, hasTransparency: (b[20] & 0x10) !== 0 }
  }
  if (chunk === 'VP8L' && b.length >= 25 && b[20] === 0x2f) {
    const bits = (b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)) >>> 0
    return { widthPx: (bits & 0x3fff) + 1, heightPx: ((bits >>> 14) & 0x3fff) + 1, hasTransparency: ((bits >>> 28) & 1) === 1 }
  }
  if (chunk === 'VP8 ' && b.length >= 30 && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
    return { widthPx: (b[26] | (b[27] << 8)) & 0x3fff, heightPx: (b[28] | (b[29] << 8)) & 0x3fff, hasTransparency: false }
  }
  throw new AppError('VALIDATION', 'Corrupt or unsupported WebP file')
}

// ---------------------------------------------------------------- SVG

const SVG_UNIT_PX: Record<string, number> = { '': 1, px: 1, pt: 96 / 72, pc: 16, mm: 96 / 25.4, cm: 96 / 2.54, in: 96 }
function svgLength(v: string | undefined): number | null {
  if (!v) return null
  const m = /^\s*([0-9]*\.?[0-9]+)\s*(px|pt|pc|mm|cm|in)?\s*$/i.exec(v)
  if (!m) return null
  return Number(m[1]) * SVG_UNIT_PX[(m[2] ?? '').toLowerCase()]
}
const attr = (tag: string, name: string): string | undefined => new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tag)?.slice(2).find((x) => x !== undefined)

export function parseSvgDims(svg: string): { widthPx: number; heightPx: number } {
  const root = /<svg\b(?:"[^"]*"|'[^']*'|[^>"'])*>/i.exec(svg)?.[0]
  if (!root) throw new AppError('VALIDATION', 'Corrupt SVG file')
  let w = svgLength(attr(root, 'width'))
  let h = svgLength(attr(root, 'height'))
  const vb = attr(root, 'viewBox')?.trim().split(/[\s,]+/).map(Number)
  if (vb && vb.length === 4 && vb.every(Number.isFinite) && vb[2] > 0 && vb[3] > 0) {
    if (!w && !h) { w = vb[2]; h = vb[3] }
    else if (!w && h) w = (h * vb[2]) / vb[3]
    else if (w && !h) h = (w * vb[3]) / vb[2]
  }
  if (!w || !h) throw new AppError('VALIDATION', 'SVG needs a viewBox or width/height')
  return { widthPx: Math.max(1, Math.round(w)), heightPx: Math.max(1, Math.round(h)) }
}

const SVG_ALLOWED = new Set(
  ['svg', 'g', 'defs', 'symbol', 'use', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan', 'textpath',
    'title', 'desc', 'lineargradient', 'radialgradient', 'stop', 'clippath', 'mask', 'pattern', 'image', 'style', 'filter', 'marker',
    'fegaussianblur', 'feoffset', 'feblend', 'fecolormatrix', 'fecomposite', 'feflood', 'femerge', 'femergenode', 'feturbulence', 'fedropshadow']
)
/** Elements removed together with everything inside them. */
const SVG_DROP_WITH_CONTENT = new Set(['script', 'foreignobject', 'iframe', 'object', 'embed', 'audio', 'video', 'canvas', 'animate', 'set', 'animatetransform', 'animatemotion', 'handler', 'listener'])

const TAG_RE = /<!DOCTYPE[^[>]*(?:\[[\s\S]*?\]\s*)?>|<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\?[\s\S]*?\?>|<(\/?)([a-zA-Z][\w:.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g
const ATTR_RE = /([^\s=/"'<>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g

function cleanCss(css: string): string {
  return css.replace(/@import[^;]*;?/gi, '').replace(/url\(\s*(['"]?)(?!#|data:image\/(?:png|jpeg|webp|gif);)[^)]*\)/gi, 'none').replace(/expression\s*\([^)]*\)/gi, '').replace(/javascript:/gi, '')
}

/**
 * Remove everything executable or network-reaching from an SVG: scripts, foreignObject, animation, event handlers,
 * external/`javascript:` references, DOCTYPE/entities. Only a whitelist of drawing elements survives.
 */
export function sanitizeSvg(input: string): string {
  const text = input.replace(/^﻿/, '')
  let out = ''
  let last = 0
  let skipDepth = 0
  let skipName = ''
  let inStyle = false
  let styleBuf = ''
  let m: RegExpExecArray | null
  TAG_RE.lastIndex = 0
  const emitText = (t: string) => {
    if (skipDepth) return
    if (inStyle) styleBuf += t
    else out += t.replace(/<(?!$)/g, '&lt;')
  }
  while ((m = TAG_RE.exec(text))) {
    emitText(text.slice(last, m.index))
    last = m.index + m[0].length
    if (m[2] === undefined) continue // comment / CDATA / doctype / PI : dropped
    const closing = m[1] === '/'
    const name = m[2]
    const lower = name.toLowerCase().replace(/^svg:/, '')
    const selfClosing = /\/\s*$/.test(m[3])
    if (skipDepth) {
      if (lower === skipName) skipDepth += closing ? -1 : selfClosing ? 0 : 1
      continue
    }
    if (SVG_DROP_WITH_CONTENT.has(lower)) {
      if (!closing && !selfClosing) { skipDepth = 1; skipName = lower }
      continue
    }
    if (!SVG_ALLOWED.has(lower)) continue // unknown element: drop the tag, keep harmless text
    if (lower === 'style') {
      if (closing) { out += cleanCss(styleBuf) + '</style>'; inStyle = false; styleBuf = '' }
      else if (!selfClosing) { out += '<style>'; inStyle = true }
      continue
    }
    if (closing) { out += `</${name}>`; continue }
    let attrs = ''
    let a: RegExpExecArray | null
    ATTR_RE.lastIndex = 0
    while ((a = ATTR_RE.exec(m[3].replace(/\/\s*$/, '')))) {
      const an = a[1]
      const lan = an.toLowerCase()
      let val = a[2] ?? a[3] ?? a[4]
      if (lan.startsWith('on')) continue
      if (/^(xmlns:(?!xlink)|xml:base|requiredextensions|requiredfeatures)/i.test(lan) && lan !== 'xmlns') continue
      if (val !== undefined) {
        const norm = val.replace(/[\u0000- ]+/g, '').toLowerCase()
        if (/javascript:|vbscript:|data:text|data:application|data:image\/svg/.test(norm)) continue
        if (lan === 'href' || lan === 'xlink:href') {
          if (!(norm.startsWith('#') || /^data:image\/(png|jpeg|jpg|webp|gif);base64,/.test(norm))) continue
        } else if (lan === 'style') val = cleanCss(val)
        else if (/url\(/i.test(val)) val = val.replace(/url\(\s*(['"]?)(?!#)[^)]*\)/gi, 'none')
        attrs += ` ${an}="${val.replace(/"/g, '&quot;')}"`
      } else attrs += ` ${an}=""`
    }
    out += `<${name}${attrs}${selfClosing ? '/' : ''}>`
  }
  emitText(text.slice(last))
  if (!/<svg[\s>]/i.test(out)) throw new AppError('VALIDATION', 'File is not a valid SVG')
  const a = out.search(/<svg[\s>]/i)
  const b = out.toLowerCase().lastIndexOf('</svg>')
  return (b > a ? out.slice(a, b + 6) : out.slice(a)).trim()
}

// ---------------------------------------------------------------- public API

export function readImageInfo(b: Uint8Array): ImageInfo {
  const format = detectFormat(b)
  if (!format) throw new AppError('VALIDATION', 'Unsupported logo file. Use PNG, JPG, WebP or SVG.')
  let dims: { widthPx: number; heightPx: number; hasTransparency?: boolean }
  if (format === 'png') dims = parsePng(b)
  else if (format === 'jpeg') dims = parseJpeg(b)
  else if (format === 'webp') dims = parseWebp(b)
  else dims = parseSvgDims(Buffer.from(b).toString('utf8'))
  if (!(dims.widthPx > 0 && dims.heightPx > 0) || dims.widthPx > 20000 || dims.heightPx > 20000) {
    throw new AppError('VALIDATION', 'Logo image dimensions are invalid')
  }
  return { format, mime: MIME_BY_FORMAT[format], widthPx: dims.widthPx, heightPx: dims.heightPx, hasTransparency: !!dims.hasTransparency }
}

/** Validate size + magic bytes, parse dimensions, sanitize SVG. Throws AppError('VALIDATION'). */
export function parseLogoFile(input: Uint8Array): ParsedLogo {
  if (!input || input.length === 0) throw new AppError('VALIDATION', 'Logo file is empty')
  if (input.length > MAX_LOGO_BYTES) throw new AppError('VALIDATION', 'Logo file is larger than 2 MB')
  let bytes = Buffer.from(input)
  const info0 = readImageInfo(bytes)
  if (info0.format === 'svg') bytes = Buffer.from(sanitizeSvg(bytes.toString('utf8')), 'utf8')
  const info = info0.format === 'svg' ? readImageInfo(bytes) : info0
  return { ...info, bytes, sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.length }
}

export const MAX_PRINT_PX = 1200

interface ElectronNativeImage {
  createFromBuffer(b: Buffer): { isEmpty(): boolean; getSize(): { width: number; height: number }; resize(o: { width: number; height: number; quality?: string }): any; toBitmap(): Buffer; toPNG(): Buffer; toJPEG(q: number): Buffer }
  createFromBitmap(b: Buffer, o: { width: number; height: number }): { toPNG(): Buffer }
}
function electronNativeImage(): ElectronNativeImage | null {
  if (!process.versions.electron) return null
  try {
    const req = createRequire(process.execPath)
    const ni = req('electron')?.nativeImage
    return ni && typeof ni.createFromBuffer === 'function' ? (ni as ElectronNativeImage) : null
  } catch {
    return null
  }
}

/**
 * Optimised copy for thermal printing: downscale > 1200 px (aspect preserved) and flatten transparency to white.
 * Falls back to the original bytes when Electron's nativeImage is not available (plain Node / tests).
 */
export function optimizeForPrint(p: ParsedLogo): { bytes: Buffer; mime: string; widthPx: number; heightPx: number } {
  const orig = { bytes: p.bytes, mime: p.mime, widthPx: p.widthPx, heightPx: p.heightPx }
  if (p.format === 'svg') return orig
  const needResize = Math.max(p.widthPx, p.heightPx) > MAX_PRINT_PX
  if (!needResize && !p.hasTransparency) return orig
  const ni = electronNativeImage()
  if (!ni) return orig
  try {
    let img = ni.createFromBuffer(p.bytes)
    if (img.isEmpty()) return orig
    const size = img.getSize()
    if (needResize) {
      const k = MAX_PRINT_PX / Math.max(size.width, size.height)
      img = img.resize({ width: Math.max(1, Math.round(size.width * k)), height: Math.max(1, Math.round(size.height * k)), quality: 'best' })
    }
    const s = img.getSize()
    if (p.hasTransparency) {
      const bmp = Buffer.from(img.toBitmap()) // BGRA
      for (let i = 0; i + 3 < bmp.length; i += 4) {
        const a = bmp[i + 3]
        if (a === 255) continue
        // toBitmap() is premultiplied BGRA: compositing over white is simply c + (255 - a)
        bmp[i] = Math.min(255, bmp[i] + (255 - a))
        bmp[i + 1] = Math.min(255, bmp[i + 1] + (255 - a))
        bmp[i + 2] = Math.min(255, bmp[i + 2] + (255 - a))
        bmp[i + 3] = 255
      }
      return { bytes: ni.createFromBitmap(bmp, { width: s.width, height: s.height }).toPNG(), mime: 'image/png', widthPx: s.width, heightPx: s.height }
    }
    return p.format === 'jpeg'
      ? { bytes: img.toJPEG(92), mime: 'image/jpeg', widthPx: s.width, heightPx: s.height }
      : { bytes: img.toPNG(), mime: 'image/png', widthPx: s.width, heightPx: s.height }
  } catch {
    return orig
  }
}

// ---------------------------------------------------------------- sizing & quality

export interface LogoSizeOpts { defaultWidthMm: number; maxWidthMm: number }
/**
 * Rendered logo size in mm. The aspect ratio is NEVER distorted: width OR height drives and the other is derived;
 * when both are given the image is fitted inside that box.
 */
export function computeLogoSize(widthPx: number, heightPx: number, want: { widthMm?: number; heightMm?: number }, o: LogoSizeOpts): { widthMm: number; heightMm: number } {
  const ratio = widthPx > 0 && heightPx > 0 ? heightPx / widthPx : 1
  const wm = want.widthMm && want.widthMm > 0 ? want.widthMm : 0
  const hm = want.heightMm && want.heightMm > 0 ? want.heightMm : 0
  let w: number
  if (wm && hm) w = Math.min(wm, hm / ratio)
  else if (wm) w = wm
  else if (hm) w = hm / ratio
  else w = o.defaultWidthMm
  if (o.maxWidthMm > 0 && w > o.maxWidthMm) w = o.maxWidthMm
  const r2 = (n: number) => Math.round(n * 100) / 100
  return { widthMm: r2(w), heightMm: r2(w * ratio) }
}

export interface LogoQuality {
  effectiveDpi: number | null
  widthMm: number
  heightMm: number
  warnings: string[]
  info: string[]
}
export const LOW_RES_WARNING = 'Logo resolution may be too low for high-quality printing.'

export function checkLogoQuality(
  asset: { mime: string; widthPx: number; heightPx: number; sizeBytes: number; hasTransparency: boolean },
  targetMm: number | { widthMm?: number; heightMm?: number }
): LogoQuality {
  const want = typeof targetMm === 'number' ? { widthMm: targetMm } : targetMm
  const size = computeLogoSize(asset.widthPx, asset.heightPx, want, { defaultWidthMm: 30, maxWidthMm: 0 })
  const warnings: string[] = []
  const info: string[] = []
  const isVector = asset.mime === 'image/svg+xml'
  const effectiveDpi = isVector || size.widthMm <= 0 ? null : Math.round((asset.widthPx / (size.widthMm / 25.4)) * 10) / 10
  if (effectiveDpi !== null) {
    if (effectiveDpi < 150) warnings.push(LOW_RES_WARNING)
    else if (effectiveDpi < 203) info.push('Below the 203 dpi thermal-printer ideal; fine detail may look soft.')
  }
  const ratio = asset.widthPx / Math.max(1, asset.heightPx)
  if (ratio > 4 || ratio < 0.25) warnings.push('Logo has an extreme aspect ratio; it will be shown very small or very tall.')
  if (asset.sizeBytes > 1024 * 1024) warnings.push('Logo file is large (over 1 MB); a smaller file prints and syncs faster.')
  if (asset.hasTransparency) warnings.push('Logo has transparency; it is printed on a white background for thermal printers.')
  return { effectiveDpi, widthMm: size.widthMm, heightMm: size.heightMm, warnings, info }
}

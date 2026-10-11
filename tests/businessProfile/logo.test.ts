import { describe, it, expect } from 'vitest'
import {
  checkLogoQuality, computeLogoSize, detectFormat, LOW_RES_WARNING, parseLogoFile, readImageInfo, sanitizeSvg, optimizeForPrint
} from '../../src/main/modules/businessProfile/imageTools'
import { makeJpeg, makePng, makeSvg, makeWebpExtended, makeWebpLossless, makeWebpLossy } from '../printing/fixtures'

describe('logo parsing (pure TypeScript)', () => {
  it('reads PNG dimensions and alpha', () => {
    expect(readImageInfo(makePng(320, 120))).toMatchObject({ format: 'png', widthPx: 320, heightPx: 120, hasTransparency: false })
    expect(readImageInfo(makePng(64, 64, { alpha: true })).hasTransparency).toBe(true)
  })
  it('reads JPEG dimensions', () => {
    expect(readImageInfo(makeJpeg(800, 600))).toMatchObject({ format: 'jpeg', widthPx: 800, heightPx: 600, mime: 'image/jpeg' })
  })
  it('reads WebP (VP8X, VP8L, VP8)', () => {
    expect(readImageInfo(makeWebpExtended(500, 250, true))).toMatchObject({ format: 'webp', widthPx: 500, heightPx: 250, hasTransparency: true })
    expect(readImageInfo(makeWebpLossless(333, 111))).toMatchObject({ widthPx: 333, heightPx: 111 })
    expect(readImageInfo(makeWebpLossy(640, 480))).toMatchObject({ widthPx: 640, heightPx: 480 })
  })
  it('reads SVG viewBox / width-height', () => {
    expect(readImageInfo(makeSvg('0 0 200 100'))).toMatchObject({ format: 'svg', widthPx: 200, heightPx: 100 })
    const wh = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="2in" height="1in"></svg>')
    expect(readImageInfo(wh)).toMatchObject({ widthPx: 192, heightPx: 96 })
  })
  it('detects the type from magic bytes, not the extension', () => {
    expect(detectFormat(Buffer.from('this is not an image'))).toBeNull()
    expect(() => parseLogoFile(Buffer.from('MZ\x90\x00 executable renamed logo.png'))).toThrow(/Unsupported/)
    expect(() => parseLogoFile(Buffer.from('<html><script>alert(1)</script></html>'))).toThrow(/Unsupported/)
    expect(() => parseLogoFile(Buffer.alloc(0))).toThrow(/empty/)
  })
  it('rejects files over 2 MB', () => {
    const big = Buffer.concat([makePng(10, 10), Buffer.alloc(2 * 1024 * 1024)])
    expect(() => parseLogoFile(big)).toThrow(/2 MB/)
  })
  it('rejects corrupt headers', () => {
    expect(() => readImageInfo(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]))).toThrow()
    expect(() => readImageInfo(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))).toThrow()
  })
  it('hashes the stored bytes', () => {
    const a = parseLogoFile(makePng(10, 10))
    const b = parseLogoFile(makePng(10, 10))
    const c = parseLogoFile(makePng(11, 10))
    expect(a.sha256).toBe(b.sha256)
    expect(a.sha256).not.toBe(c.sha256)
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('SVG sanitisation', () => {
  const dirty = `<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10" onload="alert(1)">
<script>alert(1)</script><SCRIPT type="x">steal()</SCRIPT>
<foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><img src=x onerror=alert(2)></div></foreignObject>
<a xlink:href="javascript:alert(3)"><rect width="5" height="5" onclick="alert(4)" fill="red"/></a>
<image href="http://evil.example/track.png" width="5" height="5"/>
<image href="https://evil.example/a.png" width="5" height="5"/>
<use xlink:href="http://evil.example/x.svg#a"/>
<rect style="fill:url(http://evil.example/x);background:url('https://e.example/y')" width="1" height="1"/>
<style>@import url(http://evil.example/x.css); .a{fill:url(http://evil.example/z)}</style>
<animate attributeName="href" values="javascript:alert(5)"/><set attributeName="onmouseover" to="alert(6)"/>
<circle cx="5" cy="5" r="3" fill="#00f"/>
</svg>`
  const clean = sanitizeSvg(dirty)
  it('strips scripts, foreignObject, handlers, external refs, entities', () => {
    expect(clean).not.toMatch(/<script/i)
    expect(clean).not.toMatch(/foreignObject/i)
    expect(clean).not.toMatch(/\son\w+\s*=/i)
    expect(clean).not.toMatch(/javascript:/i)
    expect(clean).not.toMatch(/evil\.example/)
    expect(clean).not.toMatch(/<!DOCTYPE|<!ENTITY|@import|<animate|<set\b/i)
    expect(clean).not.toMatch(/alert|steal/)
  })
  it('keeps the drawing', () => {
    expect(clean).toMatch(/<svg\b/)
    expect(clean).toMatch(/<circle[^>]*fill="#00f"/)
    expect(clean).toMatch(/<rect[^>]*fill="red"/)
    expect(readImageInfo(Buffer.from(clean))).toMatchObject({ format: 'svg', widthPx: 10, heightPx: 10 })
  })
  it('keeps internal #fragment references', () => {
    const s = sanitizeSvg('<svg viewBox="0 0 4 4"><defs><path id="p" d="M0 0h4v4z"/></defs><use href="#p"/></svg>')
    expect(s).toContain('href="#p"')
  })
  it('stores the sanitised bytes, never the original', () => {
    const p = parseLogoFile(Buffer.from(dirty))
    expect(p.bytes.toString()).not.toMatch(/script|onload/i)
  })
  it('rejects non-SVG after sanitising', () => {
    expect(() => sanitizeSvg('<script>alert(1)</script>')).toThrow()
  })
})

describe('logo sizing and print quality', () => {
  const asset = (w: number, h: number, extra = {}) => ({ mime: 'image/png', widthPx: w, heightPx: h, sizeBytes: 5000, hasTransparency: false, ...extra })

  it('never distorts: width drives, height derived (and vice versa)', () => {
    const o = { defaultWidthMm: 30, maxWidthMm: 48 }
    expect(computeLogoSize(400, 200, { widthMm: 20 }, o)).toEqual({ widthMm: 20, heightMm: 10 })
    expect(computeLogoSize(400, 200, { heightMm: 10 }, o)).toEqual({ widthMm: 20, heightMm: 10 })
    expect(computeLogoSize(400, 200, {}, o)).toEqual({ widthMm: 30, heightMm: 15 })
  })
  it('fits inside a box when both dimensions are given (contain, no stretch)', () => {
    const s = computeLogoSize(400, 200, { widthMm: 40, heightMm: 10 }, { defaultWidthMm: 30, maxWidthMm: 0 })
    expect(s.widthMm / s.heightMm).toBeCloseTo(2, 2)
    expect(s.heightMm).toBeLessThanOrEqual(10)
    const s2 = computeLogoSize(200, 400, { widthMm: 40, heightMm: 10 }, { defaultWidthMm: 30, maxWidthMm: 0 })
    expect(s2.widthMm / s2.heightMm).toBeCloseTo(0.5, 2)
  })
  it('clamps to the printable width while keeping the ratio', () => {
    const s = computeLogoSize(300, 100, { widthMm: 100 }, { defaultWidthMm: 30, maxWidthMm: 48 })
    expect(s).toEqual({ widthMm: 48, heightMm: 16 })
  })
  it('warns when effective DPI < 150', () => {
    // 200 px across 40 mm = 127 dpi
    const q = checkLogoQuality(asset(200, 100), 40)
    expect(q.effectiveDpi).toBeCloseTo(127, 0)
    expect(q.warnings).toContain(LOW_RES_WARNING)
  })
  it('no resolution warning at 203 dpi (thermal ideal) and a note between 150 and 203', () => {
    const ok = checkLogoQuality(asset(400, 200), 40) // 254 dpi
    expect(ok.warnings).not.toContain(LOW_RES_WARNING)
    const mid = checkLogoQuality(asset(280, 140), 40) // ~178 dpi
    expect(mid.warnings).not.toContain(LOW_RES_WARNING)
    expect(mid.info.length).toBe(1)
  })
  it('vector logos have no DPI problem', () => {
    const q = checkLogoQuality(asset(10, 10, { mime: 'image/svg+xml' }), 60)
    expect(q.effectiveDpi).toBeNull()
    expect(q.warnings).toHaveLength(0)
  })
  it('warns about extreme aspect ratio, large file and transparency', () => {
    const q = checkLogoQuality(asset(2000, 100, { sizeBytes: 1_500_000, hasTransparency: true }), 40)
    expect(q.warnings.join(' ')).toMatch(/aspect ratio/)
    expect(q.warnings.join(' ')).toMatch(/large/)
    expect(q.warnings.join(' ')).toMatch(/transparency/)
  })
  it('target size can be width+height and uses the fitted size for DPI', () => {
    const q = checkLogoQuality(asset(400, 200), { widthMm: 80, heightMm: 20 }) // fitted to 40x20 mm -> 254 dpi
    expect(q.widthMm).toBe(40)
    expect(q.effectiveDpi).toBeGreaterThan(200)
  })
})

describe('print optimisation', () => {
  it('keeps original bytes when Electron nativeImage is unavailable (plain Node)', () => {
    const p = parseLogoFile(makePng(3000, 1000, { alpha: true }))
    const o = optimizeForPrint(p)
    expect(o.bytes.equals(p.bytes)).toBe(true)
    expect(o.widthPx).toBe(3000)
  })
})

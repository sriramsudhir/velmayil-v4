/** Pure helpers for PrintPreview (no React, no DOM), so the "preview = print" rules can be unit-tested. */

export const MM_PX = 96 / 25.4

/**
 * Width of the preview frame for a paper width. Rounded UP: 58 mm is 219.2 px, and a 219 px frame is narrower than the
 * page inside it, which gave receipts a horizontal scrollbar and made text wrap earlier than on paper.
 */
export const previewWidthPx = (widthMm: number): number => Math.ceil(widthMm * MM_PX - 0.01)

/** Frame height: a fixed page (A4, label) is at least its own height; roll paper is as tall as its content. */
export function previewHeightPx(heightMm: number, contentPx: number): number {
  const fixed = heightMm > 0 ? Math.ceil(heightMm * MM_PX - 0.01) : 0
  return fixed ? Math.max(fixed, contentPx) : Math.max(contentPx, 120)
}

/**
 * The frame never scrolls (the surrounding box does): a scrollbar inside the frame takes about 15 px off the page width,
 * so the preview would wrap differently from the print.
 */
const FRAME_CSS = 'html{overflow:hidden!important}'

/** The document shown in the preview frame: the print HTML plus the no-scrollbar rule and, optionally, the print-darkness CSS. */
export function previewDoc(html: string, extraCss = ''): string {
  const style = `<style id="preview">${FRAME_CSS}${extraCss}</style>`
  return /<\/head>/i.test(html) ? html.replace(/<\/head>/i, () => `${style}</head>`) : style + html
}

/** What a printer profile's "Print darkness" does to a preview (printing.printLook). */
export interface PrintLook { darkness: number; logoBrightness: number; css: string; printer: string }

/** One line under a preview: which darkness it is drawn with, and that paper may differ. */
export function lookNote(look: PrintLook | null | undefined): string {
  if (!look) return ''
  const who = look.printer ? ` of printer "${look.printer}"` : ''
  const level = look.darkness === 5 ? '5 (normal)' : `${look.darkness} of 9`
  return `Shown with print darkness ${level}${who}. The screen is only an approximation: how dark the paper comes out depends on the printer and on the density set in its Windows driver.`
}

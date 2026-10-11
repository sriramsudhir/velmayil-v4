import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { lookNote, previewDoc, previewHeightPx, previewWidthPx, type PrintLook } from './previewDoc'

/**
 * Accurate print preview: renders the generated print HTML in a sandboxed iframe at the real paper width.
 * Reusable by any module:  <PrintPreview html={r.html} widthMm={r.widthMm} />
 *  - the iframe is sandboxed (no scripts, no navigation); the HTML carries its own CSP
 *  - the frame is exactly as wide as the paper and never scrolls itself, so lines wrap where they wrap on paper
 *  - `scale` shrinks the page visually (CSS transform) while keeping real layout widths
 *  - `look` (printing.printLook) draws the printer profile's print darkness and adds a line saying paper may differ
 */
export function PrintPreview({ html, widthMm, heightMm = 0, scale = 1, maxHeight, title = 'Print preview', look }: {
  html: string; widthMm: number; heightMm?: number; scale?: number; maxHeight?: number | string; title?: string; look?: PrintLook | null
}) {
  const ref = useRef<HTMLIFrameElement>(null)
  const [contentH, setContentH] = useState(0)
  const widthPx = previewWidthPx(widthMm)
  const doc = useMemo(() => previewDoc(html, look?.css ?? ''), [html, look?.css])

  const measure = useCallback(() => {
    const d = ref.current?.contentDocument
    if (!d) return
    const h = Math.ceil(Math.max(d.documentElement.scrollHeight, d.body?.scrollHeight ?? 0))
    setContentH((cur) => (Math.abs(cur - h) > 1 ? h : cur))
  }, [])

  useEffect(() => {
    setContentH(0)
  }, [doc])

  const h = previewHeightPx(heightMm, contentH)
  const note = lookNote(look)

  return (
    <>
      <div className="print-preview" style={{ overflow: 'auto', maxHeight, background: '#e9ebf0', padding: 12, borderRadius: 8 }}>
        <div style={{ width: widthPx * scale, height: h * scale, margin: '0 auto', boxShadow: '0 1px 8px rgba(0,0,0,.25)', background: '#fff', overflow: 'hidden' }}>
          <iframe
            ref={ref}
            title={title}
            srcDoc={doc}
            sandbox="allow-same-origin"
            scrolling="no"
            onLoad={() => {
              measure()
              // images (logo) decode just after load
              setTimeout(measure, 120)
            }}
            style={{ width: widthPx, height: h, border: 0, background: '#fff', transform: `scale(${scale})`, transformOrigin: 'top left', display: 'block' }}
          />
        </div>
      </div>
      {note && <p className="muted" style={{ marginTop: 6 }} data-testid="preview-look-note">{note}</p>}
    </>
  )
}

export default PrintPreview

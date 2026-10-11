import { useEffect, useRef, useState } from 'react'
import { Button, Field, InlineAlert, Input, Modal, Select, useToast } from '@/ui'
import { call, errMsg } from '@/lib/api'

/** What `catalog.barcodePreview` answers for a mode / prefix / width (nothing is saved by asking). */
export interface NumberingPreview {
  valid: boolean
  error?: string
  field?: 'mode' | 'prefix' | 'width'
  mode: string
  prefix: string
  width: number
  example: string
  exampleNext: string
  next: string
  last: string
  remaining: number
}

type Mode = 'sequence' | 'ean13'
const WIDTHS = [4, 5, 6, 7, 8, 9, 10]
/** As typed: upper-case letters and digits only (the server stores it upper-case too). */
export const sanitizeBarcodePrefix = (raw: string, mode: Mode): string =>
  mode === 'ean13' ? raw.replace(/\D/g, '').slice(0, 3) : raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8)

const code = { fontFamily: 'var(--mono)', fontWeight: 600, letterSpacing: '0.04em' } as const

/**
 * Owner setting: how barcodes made by the app are numbered. Default "prefix + running number": the prefix stays the same and
 * only the number behind it counts up. Shows a live example and the real next barcode while typing; saving never changes a
 * barcode that is already on a product.
 */
export function BarcodeNumberingDialog({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved?: () => void }) {
  const toast = useToast()
  const [mode, setMode] = useState<Mode>('sequence')
  const [prefix, setPrefix] = useState('')
  const [width, setWidth] = useState(6)
  const [seqPrefix, setSeqPrefix] = useState('200') // remembered per mode while the dialog is open
  const [preview, setPreview] = useState<NumberingPreview | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ask = useRef(0)

  useEffect(() => {
    if (!open) return
    setLoaded(false); setError(null); setPreview(null)
    call<Record<string, string>>('catalog', 'getSettings')
      .then((s) => {
        const m: Mode = s.barcodeMode === 'ean13' ? 'ean13' : 'sequence'
        setMode(m)
        setPrefix(s.barcodePrefix ?? '200')
        if (m === 'sequence') setSeqPrefix(s.barcodePrefix ?? '200')
        setWidth(WIDTHS.includes(Number(s.barcodeWidth)) ? Number(s.barcodeWidth) : 6)
        setLoaded(true)
      })
      .catch((e) => setError(errMsg(e)))
  }, [open])

  // live example: ask the server (it knows which numbers are taken), slightly debounced while typing
  useEffect(() => {
    if (!open || !loaded) return
    const id = ++ask.current
    const t = setTimeout(() => {
      call<NumberingPreview>('catalog', 'barcodePreview', { mode, prefix, width })
        .then((p) => { if (ask.current === id) setPreview(p) })
        .catch((e) => { if (ask.current === id) setPreview({ valid: false, error: errMsg(e), mode, prefix, width, example: '', exampleNext: '', next: '', last: '', remaining: 0 }) })
    }, 120)
    return () => clearTimeout(t)
  }, [open, loaded, mode, prefix, width])

  const changeMode = (m: Mode) => {
    if (m === mode) return
    if (mode === 'sequence') setSeqPrefix(prefix)
    setMode(m)
    setPrefix(m === 'ean13' ? (/^2\d\d$/.test(prefix) ? prefix : '200') : seqPrefix || '200')
  }

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      const s = await call<Record<string, string>>('catalog', 'saveSettings', { barcodeMode: mode, barcodePrefix: prefix, barcodeWidth: width })
      toast(s.nextBarcode ? `Barcode numbering saved. Next barcode: ${s.nextBarcode}` : 'Barcode numbering saved', 'good')
      onSaved?.()
      onClose()
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  const stale = !preview || preview.mode !== mode || preview.prefix !== prefix.trim().toUpperCase() || (mode === 'sequence' && preview.width !== width)
  const err = (f: 'prefix' | 'width') => (preview && !preview.valid && preview.field === f ? preview.error : undefined)
  const otherError = preview && !preview.valid && preview.field !== 'prefix' && !(mode === 'sequence' && preview.field === 'width') ? preview.error : undefined
  const sequence = mode === 'sequence'

  return (
    <Modal
      open={open} onClose={onClose} title="Barcode numbering"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={busy || !loaded || stale || !preview?.valid} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</Button></>}
    >
      {error && <div className="field-error" role="alert" style={{ marginBottom: 8 }}>{error}</div>}
      <p className="muted" style={{ marginTop: 0 }}>
        How the app numbers the barcodes it creates (the Generate button, "Generate missing barcodes", new rows in the spreadsheet). Barcodes printed on the goods by their maker are not affected.
      </p>
      <Field label="Numbering" hint={sequence ? 'The prefix stays the same on every label; only the number behind it counts up by one.' : 'A 13-digit retail-style number. Its last digit is a check digit, so the end of the number does not count up evenly.'}>
        <Select aria-label="Barcode numbering" data-testid="barcode-mode" value={mode} disabled={!loaded} onChange={(e) => changeMode(e.target.value as Mode)}>
          <option value="sequence">Prefix + running number (recommended)</option>
          <option value="ean13">EAN-13 with check digit</option>
        </Select>
      </Field>
      <div className="grid2" style={{ marginTop: 8, alignItems: 'start' }}>
        <Field label="Prefix" error={err('prefix')} hint={err('prefix') ? undefined : sequence ? '1-8 letters or digits, for example VM' : 'In-store range: 200 to 299'}>
          <Input
            aria-label="Barcode prefix" data-testid="barcode-prefix" value={prefix} disabled={!loaded} maxLength={sequence ? 8 : 3} autoComplete="off" spellCheck={false}
            inputMode={sequence ? 'text' : 'numeric'} style={{ textTransform: 'uppercase', fontFamily: 'var(--mono)' }}
            onChange={(e) => setPrefix(sanitizeBarcodePrefix(e.target.value, mode))}
            onKeyDown={(e) => { if (e.key === 'Enter' && preview?.valid && !stale) void save() }}
          />
        </Field>
        {sequence ? (
          <Field label="Digits in the number" error={err('width')} hint={err('width') ? undefined : preview?.valid && !stale ? `Room for ${preview.remaining.toLocaleString('en-IN')} more barcodes` : undefined}>
            <Select aria-label="Digits in the number" data-testid="barcode-width" value={String(width)} disabled={!loaded} onChange={(e) => setWidth(Number(e.target.value))}>
              {WIDTHS.map((w) => <option key={w} value={w}>{w} digits ({'0'.repeat(w - 1)}1)</option>)}
            </Select>
          </Field>
        ) : (
          <Field label="Digits in the number" hint="Fixed by the EAN-13 standard"><Input aria-label="Digits in the number" value="9 + check digit" disabled readOnly /></Field>
        )}
      </div>

      <div style={{ marginTop: 12 }}>
        {!loaded || stale ? (
          <InlineAlert tone="info" title="Checking…" />
        ) : preview.valid ? (
          <InlineAlert tone="good" title="Next barcode">
            <div data-testid="barcode-next" style={{ ...code, fontSize: '1.35em', margin: '2px 0 4px' }}>{preview.next}</div>
            <div>
              {sequence
                ? <>Series: <span style={code}>{preview.example}</span>, <span style={code}>{preview.exampleNext}</span> … up to <span style={code}>{preview.last}</span>. The prefix <span style={code}>{preview.prefix}</span> never changes.</>
                : <>Series: <span style={code}>{preview.example}</span>, <span style={code}>{preview.exampleNext}</span> … Labels are printed as EAN-13.</>}
            </div>
          </InlineAlert>
        ) : otherError ? (
          <InlineAlert tone="warn" title="This numbering cannot be used">{otherError}</InlineAlert>
        ) : (
          <InlineAlert tone="warn" title="Check the highlighted field">No barcode can be generated with these values yet.</InlineAlert>
        )}
      </div>
      <p className="muted" style={{ marginBottom: 0 }}>
        Barcodes already on your products are never changed, and labels already printed keep scanning. After a change the running number simply continues.
      </p>
    </Modal>
  )
}

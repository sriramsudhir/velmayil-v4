import { beepOk } from '@/ui/sound'
import { useEffect, useState } from 'react'
import { Button, Field, Input, Modal, Select, TextArea, useToast } from '@/ui'
import { call, errMsg } from '@/lib/api'
import { stripScanDecorations } from '@shared/scanCode'
import { useScanner } from '@/lib/useScanner'
import { LabelPrintDialog } from '@/modules/printing/LabelPrintDialog'
import { MAX_UNIT_SEQ } from '@shared/scanList'
import { UnitsPanel } from './UnitsPanel'
import { capacityText, prefixError, sanitizePrefix } from './unitsModel'
import { bpToPct, fileToBase64, parseRupees, rupees, GST_SLABS, type Brand, type Category, type ProductDetail } from './types'

/** Headless: routes reader scans to `onCode` while mounted (the form renders it only while open). */
function BarcodeScanCatcher({ onCode }: { onCode: (code: string, target?: EventTarget | null) => void }) {
  useScanner((code, _scan, target) => onCode(code, target), true)
  return null
}

interface VariantDraft {
  id?: number
  name: string
  sku: string
  barcode: string
  aliases: string
  mrp: string
  price: string
  cost: string
  reorderLevel: string
  openingStock: string
  active: boolean
  barcodeHint?: string
  /** the code in the field came from "Generate" and is not saved yet (cleared as soon as the field is edited) */
  generated?: string
}
const emptyVariant = (name = ''): VariantDraft => ({ name, sku: '', barcode: '', aliases: '', mrp: '', price: '', cost: '', reorderLevel: '0', openingStock: '', active: true })

export function ProductForm({ productId, open, onClose, onSaved, categories, brands, reloadTaxonomy }: {
  productId: number | null
  open: boolean
  onClose: () => void
  onSaved: () => void
  categories: Category[]
  brands: Brand[]
  reloadTaxonomy: () => void
}) {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [categoryId, setCategoryId] = useState<string>('')
  const [brandId, setBrandId] = useState<string>('')
  const [hsn, setHsn] = useState('')
  const [gst, setGst] = useState('18')
  const [unit, setUnit] = useState('pcs')
  const [trackStock, setTrackStock] = useState(true)
  const [active, setActive] = useState(true)
  const [variants, setVariants] = useState<VariantDraft[]>([emptyVariant()])
  const [image, setImage] = useState<{ mime: string; base64: string } | null>(null)
  const [imageUri, setImageUri] = useState<string | null>(null)
  const [removeImage, setRemoveImage] = useState(false)
  const [newCat, setNewCat] = useState<string | null>(null)
  const [newBrand, setNewBrand] = useState<string | null>(null)
  const [labelFor, setLabelFor] = useState<{ variantId: number; barcode: string; heading?: string } | null>(null)
  const [trackUnits, setTrackUnits] = useState(false)
  const [unitPrefix, setUnitPrefix] = useState('')
  const [prefixErr, setPrefixErr] = useState<string | null>(null)
  const [unitsUsed, setUnitsUsed] = useState(0)
  const [wasTracked, setWasTracked] = useState(false)
  const [unitsOpen, setUnitsOpen] = useState(false)
  const [fresh, setFresh] = useState<{ codes: string[]; variantId?: number; total: number } | null>(null)
  // the barcode "Generate" would give right now (prefix + running number), shown next to the button
  const [nextBarcode, setNextBarcode] = useState('')
  const loadNext = () => {
    call<Record<string, string>>('catalog', 'getSettings').then((s) => setNextBarcode(s.nextBarcode ?? '')).catch(() => setNextBarcode(''))
  }
  // once unit codes exist the prefix is locked (changing it would orphan printed labels), unless all 9999 are used
  const prefixLocked = wasTracked && unitsUsed > 0 && unitsUsed < MAX_UNIT_SEQ

  const suggest = async (forName: string) => {
    if (!forName.trim()) return
    try {
      const r = await call<{ prefix: string }>('units', 'suggestPrefix', { name: forName.trim(), productId: productId ?? undefined })
      setUnitPrefix((cur) => (cur ? cur : r.prefix))
    } catch {
      /* the user can type one */
    }
  }
  const onToggleUnits = (on: boolean) => {
    setTrackUnits(on)
    setPrefixErr(null)
    if (on && !unitPrefix) void suggest(name)
  }

  useEffect(() => {
    if (!open) return
    setError(null)
    setPrefixErr(null)
    setUnitsOpen(false)
    setTrackUnits(false); setUnitPrefix(''); setUnitsUsed(0); setWasTracked(false)
    setImage(null)
    setRemoveImage(false)
    setNewCat(null)
    setNewBrand(null)
    loadNext()
    if (productId == null) {
      setName(''); setDescription(''); setCategoryId(''); setBrandId(''); setHsn(''); setGst('18'); setUnit('pcs')
      setTrackStock(true); setActive(true); setImageUri(null); setVariants([emptyVariant()])
      return
    }
    call<ProductDetail>('catalog', 'get', { id: productId })
      .then((p) => {
        setName(p.name); setDescription(p.description); setCategoryId(p.categoryId ? String(p.categoryId) : ''); setBrandId(p.brandId ? String(p.brandId) : '')
        setHsn(p.hsn); setGst(bpToPct(p.taxRateBp)); setUnit(p.unit); setTrackStock(p.trackStock); setActive(p.active); setImageUri(p.imageDataUri)
        setTrackUnits(!!p.trackUnits); setWasTracked(!!p.trackUnits); setUnitPrefix(p.unitPrefix ?? '')
        if (p.unitPrefix) {
          call<{ total: number }>('units', 'list', { productId: p.id, limit: 1 }).then((r) => setUnitsUsed(r.total)).catch(() => undefined)
        }
        setVariants(p.variants.map((v) => ({
          id: v.id, name: v.name, sku: v.sku, barcode: v.barcode ?? '', aliases: v.aliases.join(', '), mrp: rupees(v.mrp), price: rupees(v.price),
          cost: rupees(v.cost), reorderLevel: String(v.reorderLevel), openingStock: '', active: v.active
        })))
      })
      .catch((e) => setError(errMsg(e)))
  }, [open, productId])

  const setV = (i: number, patch: Partial<VariantDraft>) => setVariants((vs) => vs.map((v, j) => (j === i ? { ...v, ...patch } : v)))

  /**
   * Generate + SAVE a barcode for this variant, then open the label dialog. A variant that already has a barcode asks first
   * (old printed labels use it; the old number stays as an alias so they keep scanning). A variant that is not saved yet only
   * gets a number in the field (it is stored with the product); use "Print label" after saving.
   */
  const generate = async (i: number) => {
    const v = variants[i]
    setError(null)
    try {
      if (!v.id) {
        // a preview of the next number: nothing is used up until the product is saved, so clicking again gives the same code.
        // Codes already shown on the other variants of this form are skipped, so two variants never show the same one.
        const exclude = variants.filter((_, j) => j !== i).map((x) => x.barcode.trim()).filter(Boolean)
        const r = await call<{ barcode: string }>('catalog', 'generateBarcode', { exclude })
        setV(i, { barcode: r.barcode, barcodeHint: undefined, generated: r.barcode })
        toast(`Barcode ${r.barcode} is ready. Save the product, then click "Print label".`, 'good')
        return
      }
      const replaceText = (old: string) => `This item already has the barcode ${old}.\n\nLabels already printed with it will no longer match the new number (the old number is kept as an alias so they still scan).\n\nGenerate a NEW barcode and replace it?`
      let replace = false
      if (v.barcode.trim()) {
        if (!confirm(replaceText(v.barcode.trim()))) return
        replace = true
      }
      let r: { barcode: string; variantId: number; replaced: boolean }
      try {
        r = await call('catalog', 'assignBarcode', { variantId: v.id, replace })
      } catch (e) {
        const d = (e as { details?: { code?: string; barcode?: string } }).details
        if (d?.code !== 'BARCODE_EXISTS') throw e
        if (!confirm(replaceText(d.barcode ?? ''))) return
        r = await call('catalog', 'assignBarcode', { variantId: v.id, replace: true })
      }
      setV(i, { barcode: r.barcode, barcodeHint: undefined, generated: undefined })
      loadNext()
      onSaved()
      const label = [name.trim(), v.name.trim()].filter(Boolean).join(' - ')
      setLabelFor({ variantId: v.id, barcode: r.barcode, heading: `Barcode ${r.barcode} generated and saved for ${label || 'this product'}${r.replaced ? ' (old barcode kept as an alias)' : ''}.` })
    } catch (e) {
      setError(errMsg(e))
    }
  }
  const checkBarcode = async (i: number) => {
    const v = variants[i]
    // a reader may wrap the code (CR/LF/Tab, ]E0 identifier, Code 39 stars): never save those into the product
    const clean = stripScanDecorations(v.barcode)
    if (clean !== v.barcode) setV(i, { barcode: clean })
    if (!clean) return setV(i, { barcodeHint: undefined })
    try {
      const r = await call<{ valid: boolean; error?: string; format?: string }>('catalog', 'validateBarcode', { code: clean, variantId: v.id })
      setV(i, { barcodeHint: r.valid ? `Valid ${r.format}` : r.error })
    } catch {
      /* ignore */
    }
  }

  const quickCreate = async (kind: 'category' | 'brand') => {
    const nm = (kind === 'category' ? newCat : newBrand)?.trim()
    if (!nm) return
    try {
      const r = await call<{ id: number }>('catalog', kind === 'category' ? 'saveCategory' : 'saveBrand', { name: nm })
      reloadTaxonomy()
      if (kind === 'category') (setCategoryId(String(r.id)), setNewCat(null))
      else (setBrandId(String(r.id)), setNewBrand(null))
    } catch (e) {
      setError(errMsg(e))
    }
  }

  const pickImage = async (f: File | undefined) => {
    if (!f) return
    if (f.size > 2 * 1024 * 1024) return setError('Image must be 2 MB or smaller')
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(f.type)) return setError('Use a PNG, JPEG, WebP or GIF image')
    const base64 = await fileToBase64(f)
    setImage({ mime: f.type, base64 })
    setImageUri(`data:${f.type};base64,${base64}`)
    setRemoveImage(false)
    setError(null)
  }

  const save = async () => {
    setError(null)
    const pct = Number(gst)
    if (!name.trim()) return setError('Product name is required')
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) return setError('GST rate must be between 0 and 100')
    const out = []
    for (const [i, v] of variants.entries()) {
      const mrp = parseRupees(v.mrp), price = parseRupees(v.price), cost = parseRupees(v.cost)
      const label = v.name || (variants.length > 1 ? `Variant ${i + 1}` : 'Product')
      if (mrp == null || price == null || cost == null) return setError(`${label}: enter prices as numbers like 120 or 99.50`)
      if (mrp > 0 && mrp < price) {
        // warning only; allowed
      }
      const reorder = Number(v.reorderLevel || 0)
      if (!Number.isInteger(reorder) || reorder < 0) return setError(`${label}: reorder level must be a whole number`)
      const opening = v.openingStock.trim() === '' ? undefined : Number(v.openingStock)
      if (opening !== undefined && (!Number.isInteger(opening) || opening < 0)) return setError(`${label}: opening stock must be a whole number`)
      out.push({
        id: v.id, name: v.name.trim(), sku: v.sku.trim() || undefined, barcode: v.barcode.trim() || null,
        aliases: v.aliases.split(/[,;\n]/).map((a) => a.trim()).filter(Boolean),
        mrp, price, cost, reorderLevel: reorder, active: v.active, openingStock: v.id ? undefined : opening
      })
    }
    if (trackUnits) {
      const pe = prefixError(unitPrefix)
      if (pe) return setPrefixErr(pe)
      if (!trackStock) return setError('Unit codes need "Track stock" to be on')
    }
    setBusy(true)
    setPrefixErr(null)
    const body = {
      id: productId ?? undefined, name: name.trim(), description, categoryId: categoryId ? Number(categoryId) : null,
      brandId: brandId ? Number(brandId) : null, hsn: hsn.trim(), taxRateBp: Math.round(pct * 100), unit: unit.trim() || 'pcs',
      trackStock, active, variants: out, image: image ?? undefined, removeImage: removeImage || undefined,
      trackUnits, unitPrefix: trackUnits ? unitPrefix : undefined
    }
    try {
      let saved: { id: number }
      try {
        saved = await call<{ id: number }>('catalog', 'save', body)
      } catch (e) {
        const d = (e as { details?: { code?: string; inStock?: number } }).details
        if (d?.code !== 'UNITS_IN_STOCK') throw e
        if (!confirm(`${d.inStock ?? 'Some'} unit code(s) are still in stock. Turn off unit codes anyway? The codes are voided; stock quantity is not changed.`)) return
        saved = await call<{ id: number }>('catalog', 'save', { ...body, discardUnits: true })
      }
      beepOk()
      toast(productId ? 'Product updated' : 'Product created', 'good')
      onSaved()
      // tracking was just turned on (or a new tracked product got opening stock): the stock was given unit codes, offer their labels now
      if (trackUnits && !wasTracked && saved?.id) {
        try {
          const r = await call<{ rows: { code: string; variantId: number }[]; total: number }>('units', 'list', { productId: saved.id, status: 'in_stock', limit: 500 })
          if (r.rows.length) {
            const codes = r.rows.map((u) => u.code).sort()
            const one = new Set(r.rows.map((u) => u.variantId))
            setFresh({ codes, variantId: one.size === 1 ? r.rows[0].variantId : undefined, total: r.total })
            return
          }
        } catch {
          /* labels can be printed later from the Units tab */
        }
      }
      onClose()
    } catch (e) {
      const d = (e as { details?: { code?: string } }).details
      if (d?.code && /^PREFIX_/.test(d.code)) setPrefixErr(errMsg(e))
      else setError(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  /**
   * A barcode reader scan while this form is open fills the barcode of the variant whose barcode field has focus (otherwise the first
   * variant without a barcode): the code REPLACES the field's old text, is cleaned and checked. Never typed into the name/price fields.
   */
  const onScannedCode = (code: string, target?: EventTarget | null) => {
    const clean = stripScanDecorations(code)
    if (!clean) return
    const attr = (target as HTMLElement | null)?.closest?.('[data-barcode-index]')?.getAttribute('data-barcode-index')
    let i = attr != null ? Number(attr) : variants.findIndex((v) => !v.barcode.trim())
    if (!(i >= 0 && i < variants.length)) i = 0
    setV(i, { barcode: clean, barcodeHint: undefined })
    beepOk()
    void call<{ valid: boolean; error?: string; format?: string }>('catalog', 'validateBarcode', { code: clean, variantId: variants[i]?.id })
      .then((r) => setV(i, { barcodeHint: r.valid ? `Valid ${r.format}` : r.error }))
      .catch(() => undefined)
  }

  const multi = variants.length > 1 || variants.some((v) => v.name)
  return (
    <Modal
      wide open={open} onClose={onClose} title={productId ? 'Edit product' : 'Add product'}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save product'}</Button></>}
    >
      {error && <div className="field-error" role="alert" style={{ marginBottom: 8 }}>{error}</div>}
      {open && <BarcodeScanCatcher onCode={onScannedCode} />}
      <div className="grid2">
        <Field label="Product name"><Input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={200} /></Field>
        <Field label="Unit"><Input value={unit} onChange={(e) => setUnit(e.target.value)} maxLength={16} /></Field>
        <Field label="Category">
          {newCat === null ? (
            <div className="row">
              <Select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} style={{ flex: 1 }}>
                <option value="">— none —</option>
                {categories.filter((c) => c.active || String(c.id) === categoryId).map((c) => <option key={c.id} value={c.id}>{c.path}</option>)}
              </Select>
              <Button type="button" title="New category" onClick={() => setNewCat('')}>+</Button>
            </div>
          ) : (
            <div className="row">
              <Input autoFocus placeholder="New category name" value={newCat} onChange={(e) => setNewCat(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void quickCreate('category') } }} />
              <Button type="button" variant="primary" onClick={() => void quickCreate('category')}>Add</Button>
              <Button type="button" onClick={() => setNewCat(null)}>✕</Button>
            </div>
          )}
        </Field>
        <Field label="Brand">
          {newBrand === null ? (
            <div className="row">
              <Select value={brandId} onChange={(e) => setBrandId(e.target.value)} style={{ flex: 1 }}>
                <option value="">— none —</option>
                {brands.filter((b) => b.active || String(b.id) === brandId).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </Select>
              <Button type="button" title="New brand" onClick={() => setNewBrand('')}>+</Button>
            </div>
          ) : (
            <div className="row">
              <Input autoFocus placeholder="New brand name" value={newBrand} onChange={(e) => setNewBrand(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void quickCreate('brand') } }} />
              <Button type="button" variant="primary" onClick={() => void quickCreate('brand')}>Add</Button>
              <Button type="button" onClick={() => setNewBrand(null)}>✕</Button>
            </div>
          )}
        </Field>
        <Field label="HSN code" hint="Up to 8 digits"><Input inputMode="numeric" value={hsn} onChange={(e) => setHsn(e.target.value.replace(/\D/g, '').slice(0, 8))} /></Field>
        <Field label="GST rate %">
          <div className="row">
            <Select value={GST_SLABS.includes(Number(gst)) ? gst : 'custom'} onChange={(e) => e.target.value !== 'custom' && setGst(e.target.value)}>
              {GST_SLABS.map((s) => <option key={s} value={s}>{s}%</option>)}
              <option value="custom">Other…</option>
            </Select>
            <Input type="number" min={0} max={100} step="0.01" value={gst} onChange={(e) => setGst(e.target.value)} style={{ width: 90 }} />
          </div>
        </Field>
        <Field label="Description"><TextArea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
        <Field label="Image (max 2 MB)">
          <div className="row">
            {imageUri && <img src={imageUri} alt="Product" style={{ width: 56, height: 56, objectFit: 'cover', borderRadius: 6 }} />}
            <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(e) => void pickImage(e.target.files?.[0])} />
            {imageUri && <Button type="button" onClick={() => { setImage(null); setImageUri(null); setRemoveImage(true) }}>Remove</Button>}
          </div>
        </Field>
      </div>
      <div className="row" style={{ gap: 16, margin: '8px 0' }}>
        <label><input type="checkbox" checked={trackStock} onChange={(e) => setTrackStock(e.target.checked)} /> Track stock</label>
        <label><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Active (sellable)</label>
      </div>

      <div className="card" style={{ padding: 10, marginBottom: 8 }} data-testid="unit-tracking">
        <label>
          <input type="checkbox" checked={trackUnits} disabled={!trackStock} onChange={(e) => onToggleUnits(e.target.checked)} data-testid="track-units" /> Track each unit with a unique code
        </label>
        <span className="muted"> {trackStock ? '(each piece gets a code like SPK-0001 you scan when selling, counting and receiving)' : '(turn on "Track stock" first)'}</span>
        {trackUnits && (
          <div className="row" style={{ gap: 12, alignItems: 'flex-end', marginTop: 8, flexWrap: 'wrap' }}>
            <Field label="Unit code prefix" error={prefixErr ?? undefined} hint={prefixErr ? undefined : prefixLocked ? 'Locked: unit codes already exist' : '2-8 letters or digits'}>
              <div className="row">
                <Input aria-label="Unit code prefix" data-testid="unit-prefix" style={{ width: 130, textTransform: 'uppercase' }} value={unitPrefix} disabled={prefixLocked} maxLength={8}
                  onChange={(e) => { setUnitPrefix(sanitizePrefix(e.target.value)); setPrefixErr(null) }}
                  onBlur={() => { if (!unitPrefix) void suggest(name) }} />
                {!prefixLocked && <Button type="button" onClick={() => { setUnitPrefix(''); void call<{ prefix: string }>('units', 'suggestPrefix', { name: name.trim() || 'Item', productId: productId ?? undefined }).then((r) => setUnitPrefix(r.prefix)).catch(() => undefined) }}>Suggest</Button>}
              </div>
            </Field>
            <span className="muted" data-testid="unit-capacity" style={{ paddingBottom: 6 }}>{capacityText(unitPrefix, unitsUsed)}</span>
            {productId != null && wasTracked && <Button type="button" onClick={() => setUnitsOpen(true)} data-testid="open-units">Units…</Button>}
          </div>
        )}
      </div>

      <h4 style={{ margin: '12px 0 4px' }}>{multi ? 'Variants' : 'Pricing & barcode'}</h4>
      {variants.map((v, i) => (
        <div key={v.id ?? `n${i}`} className="card" style={{ marginBottom: 8, padding: 10 }}>
          <div className="grid3">
            {(multi || !v.id) && <Field label="Variant name" hint={i === 0 && !multi ? 'Leave blank for a simple product' : undefined}>
              <Input value={v.name} onChange={(e) => setV(i, { name: e.target.value })} placeholder="e.g. Large / 500 g" />
            </Field>}
            <Field label="SKU" hint={v.id ? undefined : 'Blank = auto-generate'}><Input value={v.sku} onChange={(e) => setV(i, { sku: e.target.value })} placeholder={v.id ? '' : 'auto'} /></Field>
            <Field
              label="Barcode (scan or type)" error={v.barcodeHint && !v.barcodeHint.startsWith('Valid') ? v.barcodeHint : undefined}
              hint={v.generated && v.generated === v.barcode.trim() ? `Generated ${v.generated} - saved when you save the product`
                : v.barcodeHint?.startsWith('Valid') ? v.barcodeHint
                  : !v.barcode.trim() && nextBarcode ? `Generate gives ${nextBarcode}` : undefined}
            >
              <div className="row">
                <Input data-barcode-index={i} value={v.barcode} onChange={(e) => setV(i, { barcode: e.target.value, barcodeHint: undefined, generated: undefined })} onBlur={() => void checkBarcode(i)}
                  onFocus={(e) => e.target.select()} /* a scan REPLACES the old code instead of being appended to it */
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void checkBarcode(i) } }} inputMode="text" autoComplete="off" />
                <Button type="button" onClick={() => void generate(i)} title={v.id ? `Give this item the next barcode${nextBarcode ? ` (${nextBarcode})` : ''}, save it and print its label` : `Fill in the next barcode${nextBarcode ? ` (${nextBarcode})` : ''}; it is saved with the product`}>Generate</Button>
                {v.id && v.barcode.trim() && <Button type="button" onClick={() => setLabelFor({ variantId: v.id!, barcode: v.barcode.trim() })} title="Print barcode labels for this item">Print label</Button>}
              </div>
            </Field>
            <Field label="Alias barcodes" hint="Comma separated"><Input value={v.aliases} onChange={(e) => setV(i, { aliases: e.target.value })} /></Field>
            <Field label="MRP ₹"><Input inputMode="decimal" value={v.mrp} onChange={(e) => setV(i, { mrp: e.target.value })} /></Field>
            <Field label="Selling price ₹"><Input inputMode="decimal" value={v.price} onChange={(e) => setV(i, { price: e.target.value })} /></Field>
            <Field label="Cost ₹"><Input inputMode="decimal" value={v.cost} onChange={(e) => setV(i, { cost: e.target.value })} /></Field>
            <Field label="Reorder level"><Input inputMode="numeric" value={v.reorderLevel} onChange={(e) => setV(i, { reorderLevel: e.target.value })} /></Field>
            {!v.id && trackStock && <Field label="Opening stock"><Input inputMode="numeric" value={v.openingStock} onChange={(e) => setV(i, { openingStock: e.target.value })} /></Field>}
          </div>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <label><input type="checkbox" checked={v.active} onChange={(e) => setV(i, { active: e.target.checked })} /> Variant active</label>
            {v.id ? (
              variants.length > 1 && <Button type="button" variant="danger" onClick={async () => {
                if (!confirm('Remove this variant? Variants with sales or stock history are deactivated instead.')) return
                try {
                  await call('catalog', 'removeVariant', { id: v.id })
                  setVariants((vs) => vs.filter((x) => x.id !== v.id))
                  onSaved()
                } catch (e) { setError(errMsg(e)) }
              }}>Remove variant</Button>
            ) : (
              variants.length > 1 && <Button type="button" onClick={() => setVariants((vs) => vs.filter((_, j) => j !== i))}>Remove</Button>
            )}
          </div>
        </div>
      ))}
      <Button type="button" onClick={() => setVariants((vs) => [...vs, emptyVariant(vs.length === 1 && !vs[0].name ? '' : '')])}>+ Add variant</Button>
      {productId != null && wasTracked && (
        <UnitsPanel open={unitsOpen} onClose={() => setUnitsOpen(false)} productId={productId} productName={name || 'Product'} prefix={unitPrefix}
          variants={variants.filter((v) => v.id).map((v) => ({ id: v.id!, name: v.name, sku: v.sku }))} />
      )}
      <LabelPrintDialog
        open={fresh !== null} onClose={() => { setFresh(null); onClose() }} variantIds={[]} unitCodes={fresh?.codes ?? []} unitVariantId={fresh?.variantId}
        heading={fresh ? `${fresh.total} unit code${fresh.total === 1 ? '' : 's'} created${fresh.total > fresh.codes.length ? ` (first ${fresh.codes.length} shown here)` : ''}: ${fresh.codes[0]}${fresh.codes.length > 1 ? ` to ${fresh.codes[fresh.codes.length - 1]}` : ''}. Choose a label size and print them now, or close to do it later from Units.` : undefined}
      />
      <LabelPrintDialog open={labelFor !== null} onClose={() => setLabelFor(null)} variantIds={labelFor ? [labelFor.variantId] : []} heading={labelFor?.heading} barcode={labelFor?.barcode} />
    </Modal>
  )
}

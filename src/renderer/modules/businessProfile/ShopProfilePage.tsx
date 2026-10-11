import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { ApiError, call } from '@/lib/api'
import { useSession } from '@/lib/session'
import {
  Badge, Button, Card, EmptyState, ErrorState, Field, FormGrid, InlineAlert, Input, Modal, NumberInput, PageHeader, Select, Spinner, Table, TextArea, Toggle,
  formatDateTime, useApiAction, useAsync, useConfirm, useDirtyGuard
} from '@/ui'

interface LogoSettings { visible: boolean; widthMm: number; heightMm: number; alignment: 'left' | 'center' | 'right'; position: 'top' | 'inline-left' | 'inline-right' }
interface HeaderSettings { showLogo: boolean; showShopName: boolean; showAddress: boolean; showPhone: boolean; showGstin: boolean }
interface Profile {
  id: number; version: number; shopName: string; legalName: string; displayName: string; shortName: string; address: string; city: string; state: string; pinCode: string
  phone: string; email: string; website: string; gstin: string; pan: string; footerText: string; logoAssetId: number | null
  logoSettings: LogoSettings; headerSettings: HeaderSettings; createdAt: number
}
interface LogoView { id: number; sha256: string; mime: string; widthPx: number; heightPx: number; sizeBytes: number; hasTransparency: boolean; dataUri: string }
interface Quality { effectiveDpi: number | null; widthMm: number; heightMm: number; warnings: string[]; info: string[] }
interface VersionRow { id: number; version: number; shopName: string; displayName: string; isActive: boolean; createdAt: number; createdByName: string | null }

type Form = Omit<Profile, 'id' | 'version' | 'logoAssetId' | 'createdAt'>
const EMPTY: Form = {
  shopName: '', legalName: '', displayName: '', shortName: '', address: '', city: '', state: '', pinCode: '', phone: '', email: '', website: '', gstin: '', pan: '', footerText: '',
  logoSettings: { visible: true, widthMm: 0, heightMm: 0, alignment: 'center', position: 'top' },
  headerSettings: { showLogo: true, showShopName: true, showAddress: true, showPhone: true, showGstin: true }
}
const toForm = (p: Profile): Form => ({
  shopName: p.shopName, legalName: p.legalName, displayName: p.displayName === p.shopName ? '' : p.displayName, shortName: p.shortName, address: p.address, city: p.city, state: p.state, pinCode: p.pinCode,
  phone: p.phone, email: p.email, website: p.website, gstin: p.gstin, pan: p.pan, footerText: p.footerText, logoSettings: p.logoSettings, headerSettings: p.headerSettings
})
const MM = 96 / 25.4

const fileToBase64 = (f: File) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''))
    r.onerror = () => reject(new Error('Could not read the file'))
    r.readAsDataURL(f)
  })

export function ShopProfilePage() {
  const { can } = useSession()
  const canEdit = can('profile.edit')
  const nav = useNavigate()
  const confirm = useConfirm()
  const { run, loading: busy } = useApiAction()
  const [active, setActive] = useState<Profile | null>(null)
  const [form, setForm] = useState<Form>(EMPTY)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [logo, setLogo] = useState<LogoView | null>(null)
  const [quality, setQuality] = useState<Quality | null>(null)
  const [justSaved, setJustSaved] = useState(false)
  const [view, setView] = useState<Profile | null>(null)
  const [viewLogo, setViewLogo] = useState<LogoView | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const loaded = useAsync(async () => {
    const [p, lg, pol] = await Promise.all([
      call<Profile | null>('businessProfile', 'findActive'),
      call<LogoView | null>('businessProfile', 'getActiveLogo'),
      call<'original' | 'current'>('businessProfile', 'getReprintPolicy')
    ])
    return { p, lg, pol }
  }, [])
  const versions = useAsync(() => call<VersionRow[]>('businessProfile', 'listVersions'), [])
  const [policy, setPolicy] = useState<'original' | 'current'>('original')

  useEffect(() => {
    if (!loaded.data) return
    setActive(loaded.data.p)
    setForm(loaded.data.p ? toForm(loaded.data.p) : EMPTY)
    setLogo(loaded.data.lg)
    setPolicy(loaded.data.pol)
  }, [loaded.data])

  const base = useMemo(() => (active ? toForm(active) : EMPTY), [active])
  const dirty = JSON.stringify(base) !== JSON.stringify(form)
  useDirtyGuard(dirty)

  // print-quality warnings for the logo at the chosen size
  useEffect(() => {
    if (!logo) { setQuality(null); return }
    const t = setTimeout(() => {
      call<Quality>('businessProfile', 'checkLogoQuality', { assetId: logo.id, widthMm: form.logoSettings.widthMm || 40, heightMm: form.logoSettings.heightMm || 0 }).then(setQuality).catch(() => setQuality(null))
    }, 200)
    return () => clearTimeout(t)
  }, [logo, form.logoSettings.widthMm, form.logoSettings.heightMm])

  const set = useCallback(<K extends keyof Form>(k: K, v: Form[K]) => { setForm((f) => ({ ...f, [k]: v })); setErrors((e) => ({ ...e, [k]: '' })); setJustSaved(false) }, [])
  const setLogoSetting = <K extends keyof LogoSettings>(k: K, v: LogoSettings[K]) => set('logoSettings', { ...form.logoSettings, [k]: v })
  const setHeader = <K extends keyof HeaderSettings>(k: K, v: boolean) => set('headerSettings', { ...form.headerSettings, [k]: v })
  const text = (k: keyof Form) => ({ value: String(form[k] ?? ''), onChange: (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => set(k, e.target.value as never), disabled: !canEdit })

  const save = async () => {
    setErrors({})
    try {
      const p = await call<Profile>('businessProfile', 'save', form)
      setActive(p)
      setForm(toForm(p))
      setJustSaved(true)
      versions.reload()
    } catch (e) {
      if (e instanceof ApiError && e.code === 'VALIDATION') {
        const fields = (e.details as { fields?: Record<string, string> } | undefined)?.fields ?? {}
        setErrors(Object.fromEntries(Object.entries(fields).map(([k, v]) => [k.split('.')[0], v])))
      }
      await run(async () => { throw e })
    }
  }

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    await run(async () => {
      const data = await fileToBase64(f)
      const r = await call<{ profile: Profile; logo: LogoView }>('businessProfile', 'setLogo', { data, name: f.name })
      setLogo(r.logo)
      setActive((a) => (a ? { ...a, id: r.profile.id, version: r.profile.version, logoAssetId: r.profile.logoAssetId } : r.profile))
      versions.reload()
    }, { success: 'Logo updated' })
  }
  const removeLogo = async () => {
    if (!(await confirm({ title: 'Remove the logo?', message: 'New bills will print without a logo. Old bills keep theirs.', confirmLabel: 'Remove', tone: 'danger' }))) return
    await run(async () => {
      const p = await call<Profile>('businessProfile', 'removeLogo')
      setLogo(null)
      setActive((a) => (a ? { ...a, id: p.id, version: p.version, logoAssetId: null } : p))
      versions.reload()
    }, { success: 'Logo removed' })
  }
  const changePolicy = async (v: 'original' | 'current') => {
    setPolicy(v)
    await run(() => call('businessProfile', 'setReprintPolicy', { policy: v }), { success: 'Reprint policy saved' })
  }
  const openVersion = async (id: number) => {
    const p = await run(() => call<Profile>('businessProfile', 'getById', { id }))
    if (!p) return
    setView(p)
    setViewLogo(p.logoAssetId ? await call<LogoView | null>('businessProfile', 'getLogo', { assetId: p.logoAssetId }).catch(() => null) : null)
  }
  const testPrint = async (paper: '58' | '80' | 'A4') => {
    const r = await run(() => call<{ ok: boolean; error?: string }>('printing', 'testPrint', { paper }))
    if (r && !r.ok) await run(async () => { throw new Error(`Printing failed: ${r.error}`) })
  }

  if (loaded.loading && !loaded.data) return <div className="page"><Spinner /></div>
  if (loaded.error) return <div className="page"><ErrorState message={loaded.error} onRetry={loaded.reload} /></div>

  const sz = form.logoSettings
  const boxW = logo ? Math.min(sz.widthMm > 0 ? sz.widthMm : sz.heightMm > 0 ? (sz.heightMm * logo.widthPx) / logo.heightPx : 40, 120) : 0

  return (
    <div className="page">
      <PageHeader
        title="Shop Profile"
        subtitle={active ? `Version ${active.version}. Every bill, report and label uses these details.` : 'Enter your shop details. They appear on every bill, report and label.'}
        actions={<>
          {dirty && <Badge tone="warn">Unsaved changes</Badge>}
          <Button onClick={() => { setForm(base); setErrors({}) }} disabled={!dirty}>Undo changes</Button>
          <Button variant="primary" onClick={save} disabled={!canEdit || !dirty || busy}>Save profile</Button>
        </>}
      />
      {!canEdit && <InlineAlert tone="info">You can view the shop profile. Changing it needs the "Edit shop name, logo and business info" permission.</InlineAlert>}
      {justSaved && (
        <InlineAlert tone="good" title="Shop profile saved" action={can('printing.view') ? <div className="row"><Button size="sm" onClick={() => void testPrint('58')}>Print test receipt (58 mm)</Button><Button size="sm" onClick={() => void testPrint('80')}>80 mm</Button><Button size="sm" variant="ghost" onClick={() => nav('/printing')}>Printing settings</Button></div> : undefined}>
          Saved as version {active?.version}. New bills use these details; older bills keep what was on them.
        </InlineAlert>
      )}

      <div className="grid2" style={{ gridTemplateColumns: 'minmax(340px, 3fr) minmax(300px, 2fr)', alignItems: 'start', marginTop: 12 }}>
        <div>
          <Card title="Shop identity">
            <FormGrid cols={2}>
              <Field label="Shop name *" error={errors.shopName}><Input {...text('shopName')} maxLength={120} autoFocus /></Field>
              <Field label="Name printed on bills" hint="Leave blank to use the shop name" error={errors.displayName}><Input {...text('displayName')} maxLength={120} /></Field>
              <Field label="Legal / registered name" error={errors.legalName}><Input {...text('legalName')} maxLength={160} /></Field>
              <Field label="Short name" hint="For narrow places such as labels" error={errors.shortName}><Input {...text('shortName')} maxLength={40} /></Field>
            </FormGrid>
          </Card>
          <Card title="Address & contact">
            <Field label="Address" error={errors.address}><TextArea {...text('address')} rows={2} maxLength={300} /></Field>
            <FormGrid cols={3}>
              <Field label="City" error={errors.city}><Input {...text('city')} /></Field>
              <Field label="State" error={errors.state}><Input {...text('state')} /></Field>
              <Field label="PIN code" error={errors.pinCode}><Input {...text('pinCode')} inputMode="numeric" maxLength={6} /></Field>
              <Field label="Phone" error={errors.phone}><Input {...text('phone')} inputMode="tel" /></Field>
              <Field label="Email" error={errors.email}><Input {...text('email')} type="email" /></Field>
              <Field label="Website" error={errors.website}><Input {...text('website')} /></Field>
            </FormGrid>
          </Card>
          <Card title="Tax & footer">
            <FormGrid cols={2}>
              <Field label="GSTIN" hint="15 characters, e.g. 22AAAAA0000A1Z5" error={errors.gstin}><Input {...text('gstin')} maxLength={15} style={{ textTransform: 'uppercase' }} /></Field>
              <Field label="PAN" error={errors.pan}><Input {...text('pan')} maxLength={10} style={{ textTransform: 'uppercase' }} /></Field>
            </FormGrid>
            <Field label="Bill footer text" hint="Printed at the bottom of receipts and invoices" error={errors.footerText}><TextArea {...text('footerText')} rows={2} maxLength={300} /></Field>
          </Card>
          <Card title="Report header">
            <p className="muted" style={{ marginBottom: 8 }}>What the top of every printed report shows.</p>
            <div style={{ display: 'grid', gap: 8 }}>
              <Toggle checked={form.headerSettings.showLogo} onChange={(v) => setHeader('showLogo', v)} label="Logo" disabled={!canEdit} />
              <Toggle checked={form.headerSettings.showShopName} onChange={(v) => setHeader('showShopName', v)} label="Shop name" disabled={!canEdit} />
              <Toggle checked={form.headerSettings.showAddress} onChange={(v) => setHeader('showAddress', v)} label="Address" disabled={!canEdit} />
              <Toggle checked={form.headerSettings.showPhone} onChange={(v) => setHeader('showPhone', v)} label="Phone" disabled={!canEdit} />
              <Toggle checked={form.headerSettings.showGstin} onChange={(v) => setHeader('showGstin', v)} label="GSTIN" disabled={!canEdit} />
            </div>
          </Card>
        </div>

        <div>
          <Card title="Logo" actions={logo && canEdit ? <Button size="sm" variant="danger" onClick={removeLogo} disabled={busy}>Remove</Button> : undefined}>
            <div style={{ background: '#fff', border: '1px dashed var(--line, #ccc)', borderRadius: 8, padding: 12, minHeight: 110, display: 'flex', justifyContent: sz.alignment === 'left' ? 'flex-start' : sz.alignment === 'right' ? 'flex-end' : 'center', alignItems: 'center', opacity: sz.visible ? 1 : 0.4 }}>
              {logo ? (
                <img src={logo.dataUri} alt="Shop logo preview" style={{ width: boxW * MM, maxWidth: '100%', height: 'auto', objectFit: 'contain' }} />
              ) : (
                <EmptyState title="No logo yet" hint="PNG, JPG, WebP or SVG, up to 2 MB. A wide logo of at least 600 px prints sharpest." />
              )}
            </div>
            {logo && <p className="muted" style={{ marginTop: 6 }}>{logo.widthPx} x {logo.heightPx} px, {(logo.sizeBytes / 1024).toFixed(0)} KB{quality ? `, printed at ${quality.widthMm} x ${quality.heightMm} mm` : ''}{quality?.effectiveDpi ? ` (${Math.round(quality.effectiveDpi)} dpi)` : ''}. Shape is always preserved.</p>}
            {canEdit && (
              <div className="row" style={{ marginTop: 8 }}>
                <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml,.png,.jpg,.jpeg,.webp,.svg" onChange={(e) => void onFile(e)} style={{ display: 'none' }} />
                <Button onClick={() => fileRef.current?.click()} disabled={busy}>{logo ? 'Replace logo' : 'Upload logo'}</Button>
              </div>
            )}
            <div style={{ display: 'grid', gap: 8, marginTop: 10 }}>
              {quality?.warnings.map((w) => <InlineAlert key={w} tone="warn">{w}</InlineAlert>)}
              {quality?.info.map((w) => <InlineAlert key={w} tone="info">{w}</InlineAlert>)}
            </div>
            <div style={{ marginTop: 12 }}>
              <Toggle checked={sz.visible} onChange={(v) => setLogoSetting('visible', v)} label="Print the logo on bills, reports and labels" disabled={!canEdit} />
            </div>
            <FormGrid cols={2}>
              <Field label="Width (mm)" hint="0 = automatic"><NumberInput value={sz.widthMm} min={0} max={200} onChange={(n) => setLogoSetting('widthMm', n ?? 0)} disabled={!canEdit} /></Field>
              <Field label="Height (mm)" hint="0 = automatic. Never stretches."><NumberInput value={sz.heightMm} min={0} max={200} onChange={(n) => setLogoSetting('heightMm', n ?? 0)} disabled={!canEdit} /></Field>
              <Field label="Alignment">
                <Select value={sz.alignment} onChange={(e) => setLogoSetting('alignment', e.target.value as LogoSettings['alignment'])} disabled={!canEdit}>
                  <option value="left">Left</option><option value="center">Centre</option><option value="right">Right</option>
                </Select>
              </Field>
              <Field label="Position">
                <Select value={sz.position} onChange={(e) => setLogoSetting('position', e.target.value as LogoSettings['position'])} disabled={!canEdit}>
                  <option value="top">Above the shop name</option><option value="inline-left">Left of the shop name</option><option value="inline-right">Right of the shop name</option>
                </Select>
              </Field>
            </FormGrid>
          </Card>

          <Card title="Reprinting old bills">
            <Field label="Shop details on reprinted bills" hint="Applies to bills and credit notes printed again after the profile changed.">
              <Select value={policy} onChange={(e) => void changePolicy(e.target.value as 'original' | 'current')} disabled={!canEdit}>
                <option value="original">Original: as printed on the first bill</option>
                <option value="current">Current: today's shop profile</option>
              </Select>
            </Field>
          </Card>

          <Card title="Version history">
            {versions.loading && !versions.data ? <Spinner /> : (
              <Table
                rows={versions.data ?? []}
                rowKey={(v) => v.id}
                onRowClick={(v) => void openVersion(v.id)}
                columns={[
                  { key: 'v', header: 'Version', render: (v) => <span>v{v.version} {v.isActive && <Badge tone="good">Current</Badge>}</span> },
                  { key: 'name', header: 'Shop name', render: (v) => v.displayName },
                  { key: 'when', header: 'Saved', render: (v) => `${formatDateTime(v.createdAt)}${v.createdByName ? ` by ${v.createdByName}` : ''}` }
                ]}
              />
            )}
            <p className="muted" style={{ marginTop: 6 }}>Old versions cannot be changed. Bills remember the version they were printed with.</p>
          </Card>
        </div>
      </div>

      <Modal title={view ? `Version ${view.version}` : ''} open={!!view} onClose={() => { setView(null); setViewLogo(null) }} footer={<Button onClick={() => setView(null)}>Close</Button>}>
        {view && (
          <div style={{ display: 'grid', gap: 6 }}>
            {viewLogo && <img src={viewLogo.dataUri} alt="Logo in this version" style={{ maxWidth: 200, maxHeight: 100, objectFit: 'contain' }} />}
            {([['Shop name', view.shopName], ['Printed name', view.displayName], ['Legal name', view.legalName], ['Address', [view.address, view.city, view.state, view.pinCode].filter(Boolean).join(', ')], ['Phone', view.phone], ['Email', view.email], ['Website', view.website], ['GSTIN', view.gstin], ['PAN', view.pan], ['Footer', view.footerText]] as const).filter(([, v]) => v).map(([k, v]) => (
              <div key={k}><span className="muted">{k}: </span><span style={{ overflowWrap: 'anywhere' }}>{v}</span></div>
            ))}
            <div className="muted">Saved {formatDateTime(view.createdAt)}</div>
          </div>
        )}
      </Modal>
    </div>
  )
}


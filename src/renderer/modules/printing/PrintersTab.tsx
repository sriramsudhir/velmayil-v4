import { useState } from 'react'
import { call } from '@/lib/api'
import { useSession } from '@/lib/session'
import { Badge, Button, Card, EmptyState, ErrorState, Field, FormGrid, InlineAlert, Input, Modal, NumberInput, Select, Spinner, Table, Toggle, useApiAction, useAsync, useConfirm } from '@/ui'
import { DARKNESS_LABEL, DRIVER_DENSITY_HINT, LOGO_BRIGHTNESS_LABEL, PAPER_FOR_PRINTER_KIND, PRINTER_KIND_LABEL, type PrinterProfile, type PrintResult, type SystemPrinter } from './shared'

const blank = (): PrinterProfile => ({ id: 0, name: '', deviceName: '', kind: 'receipt58', calibration: { offsetXmm: 0, offsetYmm: 0, scalePct: 100, silent: true, darkness: 5, logoBrightness: 5, dpi: 203, densityCommand: true }, isDefault: false })

const LEVELS = [1, 2, 3, 4, 5, 6, 7, 8, 9]

/** A 1..9 slider with its value spelled out and the two ends named. */
function LevelSlider({ label, hint, value, onChange, text, low, high }: { label: string; hint: string; value: number; onChange: (n: number) => void; text: (n: number) => string; low: string; high: string }) {
  return (
    <Field label={`${label}: ${text(value)}`} hint={hint}>
      <input type="range" aria-label={label} min={1} max={9} step={1} value={value} list="print-levels" aria-valuetext={text(value)} onChange={(e) => onChange(Number(e.target.value))} style={{ width: '100%' }} />
      <datalist id="print-levels">{LEVELS.map((n) => <option key={n} value={n} />)}</datalist>
      <div className="row muted" style={{ justifyContent: 'space-between', fontSize: 12 }}><span>{low}</span><span>Normal</span><span>{high}</span></div>
    </Field>
  )
}

export function PrintersTab() {
  const { can } = useSession()
  const canEdit = can('printing.templates')
  const confirm = useConfirm()
  const { run, loading } = useApiAction()
  const profiles = useAsync(() => call<PrinterProfile[]>('printing', 'listPrinterProfiles'), [])
  const system = useAsync(() => call<SystemPrinter[]>('printing', 'listSystemPrinters'), [])
  const [edit, setEdit] = useState<PrinterProfile | null>(null)
  const [msg, setMsg] = useState<{ id: number; r: PrintResult } | null>(null)
  const [tested, setTested] = useState<PrintResult | null>(null)

  const persist = (p: PrinterProfile) => call<PrinterProfile>('printing', 'savePrinterProfile', { ...(p.id ? { id: p.id } : {}), name: p.name, deviceName: p.deviceName, kind: p.kind, calibration: p.calibration, isDefault: p.isDefault })
  const save = async () => {
    if (!edit) return
    const ok = await run(() => persist(edit), { success: 'Printer saved' })
    if (ok) { setEdit(null); setTested(null); profiles.reload() }
  }
  /** Saves the settings on screen, then prints the test page with them: the quick way to tune darkness. */
  const saveAndTest = async () => {
    if (!edit) return
    const saved = await run(() => persist(edit))
    if (!saved) return
    setEdit(saved)
    profiles.reload()
    const r = await run(() => call<PrintResult>('printing', 'testPrint', { paper: PAPER_FOR_PRINTER_KIND[saved.kind], printerProfileId: saved.id }))
    if (r) setTested(r)
  }
  const remove = async (p: PrinterProfile) => {
    if (!(await confirm({ title: `Delete "${p.name}"?`, message: 'Documents for this paper type will use the default printer for that paper, or the Windows default printer.', confirmLabel: 'Delete', tone: 'danger' }))) return
    await run(() => call('printing', 'deletePrinterProfile', { id: p.id }), { success: 'Printer removed' })
    profiles.reload()
  }
  const test = async (p: PrinterProfile) => {
    const r = await run(() => call<PrintResult>('printing', 'testPrint', { paper: PAPER_FOR_PRINTER_KIND[p.kind], printerProfileId: p.id }))
    if (r) setMsg({ id: p.id, r })
  }

  const drawer = async (p: PrinterProfile) => {
    const r = await run(() => call<PrintResult>('printing', 'openDrawer', { printerProfileId: p.id }))
    if (r) setMsg({ id: p.id, r })
  }

  if (profiles.loading && !profiles.data) return <Spinner />
  if (profiles.error) return <ErrorState message={profiles.error} onRetry={profiles.reload} />
  const list = profiles.data ?? []
  const cal = edit?.calibration
  const setCal = (patch: Partial<PrinterProfile['calibration']>) => edit && setEdit({ ...edit, calibration: { ...edit.calibration, ...patch } })
  const thermal = edit?.kind === 'receipt58' || edit?.kind === 'receipt80'
  const missing = (p: PrinterProfile) => !!p.deviceName && !!system.data && system.data.length > 0 && !system.data.some((s) => s.name === p.deviceName)
  const result = (r: PrintResult, failTitle: string) =>
    !r.ok ? <InlineAlert tone="bad" title={failTitle}>{r.error}</InlineAlert> : r.warning ? <InlineAlert tone="warn" title="Printed on another printer">{r.warning}</InlineAlert> : <InlineAlert tone="good">Sent to the printer.</InlineAlert>

  return (
    <>
      <Card title="Printer profiles" actions={canEdit && <Button variant="primary" onClick={() => { setTested(null); setEdit(blank()) }}>Add printer</Button>}>
        <p className="muted" style={{ marginBottom: 10 }}>A profile links a paper type to a Windows printer and keeps that printer's settings: print darkness, position and scale. The default profile of each paper type is used automatically.</p>
        {msg && result(msg.r, 'Could not print')}
        <Table
          rows={list}
          rowKey={(p) => p.id}
          empty={<EmptyState title="No printer profiles yet" hint="Until you add one, documents are printed on the Windows default printer." />}
          columns={[
            { key: 'name', header: 'Name', render: (p) => <strong>{p.name}</strong> },
            { key: 'kind', header: 'Paper', render: (p) => PRINTER_KIND_LABEL[p.kind] },
            { key: 'device', header: 'Windows printer', render: (p) => (missing(p) ? <span>{p.deviceName} <Badge tone="bad">Not found</Badge></span> : p.deviceName || 'Windows default') },
            { key: 'cal', header: 'Settings', render: (p) => `${p.calibration.raw ? 'Raw ESC/POS' : p.calibration.silent ? 'Prints directly' : 'Shows the Windows dialog'}${p.calibration.drawerKick ? ', opens drawer' : ''} · darkness ${p.calibration.darkness ?? 5} · ${p.calibration.dpi ?? 203} dpi · x ${p.calibration.offsetXmm} mm, y ${p.calibration.offsetYmm} mm, ${p.calibration.scalePct}%` },
            { key: 'def', header: '', render: (p) => (p.isDefault ? <Badge tone="good">Default</Badge> : null) },
            {
              key: 'actions', header: '', align: 'right',
              render: (p) => (
                <div className="row" style={{ justifyContent: 'flex-end' }}>
                  <Button size="sm" onClick={() => void test(p)} disabled={loading}>Test print</Button>
                  {p.calibration.drawerKick && <Button size="sm" onClick={() => void drawer(p)} disabled={loading}>Open drawer</Button>}
                  {canEdit && <Button size="sm" onClick={() => { setTested(null); setEdit(p) }}>Edit</Button>}
                  {canEdit && <Button size="sm" variant="danger" onClick={() => void remove(p)}>Delete</Button>}
                </div>
              )
            }
          ]}
        />
        {list.some(missing) && <div style={{ marginTop: 8 }}><InlineAlert tone="warn" title="A saved printer was not found in Windows">Its documents are printed on the Windows default printer until you edit the profile and choose the printer again.</InlineAlert></div>}
      </Card>

      <Card title="Printers installed on this PC" actions={<Button size="sm" onClick={system.reload}>Refresh</Button>}>
        {system.loading ? <Spinner /> : (system.data ?? []).length === 0 ? (
          <EmptyState title="No printers found" hint="Install the printer's driver in Windows, then press Refresh." />
        ) : (
          <ul style={{ margin: 0, paddingLeft: 18 }}>{(system.data ?? []).map((s) => {
            const used = list.filter((p) => p.deviceName === s.name)
            return <li key={s.name}>{s.displayName}{s.isDefault ? ' (Windows default)' : ''}{used.length > 0 && <span className="muted"> {' - used for '}{used.map((p) => PRINTER_KIND_LABEL[p.kind]).join(', ')}</span>}</li>
          })}</ul>
        )}
      </Card>

      <Modal
        title={edit?.id ? 'Edit printer' : 'Add printer'}
        open={!!edit}
        onClose={() => { setEdit(null); setTested(null) }}
        footer={<><Button onClick={() => { setEdit(null); setTested(null) }}>Cancel</Button><Button onClick={() => void saveAndTest()} disabled={!edit?.name.trim() || loading}>Save and test print</Button><Button variant="primary" onClick={save} disabled={!edit?.name.trim() || loading}>Save</Button></>}
      >
        {edit && cal && (
          <>
            <FormGrid cols={2}>
              <Field label="Profile name"><Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} autoFocus /></Field>
              <Field label="Paper type">
                <Select value={edit.kind} onChange={(e) => setEdit({ ...edit, kind: e.target.value as PrinterProfile['kind'] })}>
                  {Object.entries(PRINTER_KIND_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </Select>
              </Field>
            </FormGrid>
            <Field label="Windows printer" hint="'Windows default' uses whichever printer Windows has set as default.">
              <Select value={edit.deviceName} onChange={(e) => setEdit({ ...edit, deviceName: e.target.value })}>
                <option value="">Windows default</option>
                {(system.data ?? []).map((s) => <option key={s.name} value={s.name}>{s.displayName}</option>)}
                {edit.deviceName && !(system.data ?? []).some((s) => s.name === edit.deviceName) && <option value={edit.deviceName}>{edit.deviceName} (not found)</option>}
              </Select>
            </Field>

            <div style={{ marginTop: 12, padding: 10, border: '1px solid var(--line)', borderRadius: 8 }}>
              <strong>Print quality</strong>
              <p className="muted" style={{ margin: '4px 0 8px' }}>
                If prints are too faint, raise the darkness one step and press Save and test print; if letters run together, lower it. Barcodes and QR codes are never changed by this setting, so they keep scanning.
              </p>
              <LevelSlider
                label="Print darkness" value={cal.darkness ?? 5} text={DARKNESS_LABEL} low="Lightest" high="Darkest" onChange={(n) => setCal({ darkness: n })}
                hint={cal.raw && thermal ? 'Raw mode: darker levels print the text double-struck, darken the logo and ask the printer for more heat. Lighter levels lower the heat and lighten the logo.' : 'Makes text heavier or finer and the logo darker or lighter. 5 prints exactly as designed.'}
              />
              <LevelSlider
                label="Logo brightness" value={cal.logoBrightness ?? 5} text={LOGO_BRIGHTNESS_LABEL} low="Darkest" high="Lightest" onChange={(n) => setCal({ logoBrightness: n })}
                hint="Only the logo. Use it when the logo prints as a black patch (move right) or is too pale (move left)."
              />
              <FormGrid cols={2}>
                <Field label="Printer resolution" hint="Barcode bars are sized in whole printer dots. Most receipt and label printers are 203 dpi; the value is on the printer's label or in its manual.">
                  <Select value={String(cal.dpi ?? 203)} onChange={(e) => setCal({ dpi: Number(e.target.value) as 203 | 300 | 600 })}>
                    <option value="203">203 dpi (8 dots/mm) - most thermal printers</option>
                    <option value="300">300 dpi (12 dots/mm)</option>
                    <option value="600">600 dpi - laser / inkjet</option>
                  </Select>
                </Field>
              </FormGrid>
              <p className="muted" style={{ margin: '6px 0 0' }}>{DRIVER_DENSITY_HINT} This app cannot change that setting.</p>
              {tested && <div style={{ marginTop: 8 }}>{result(tested, 'Test print failed')}</div>}
            </div>

            <FormGrid cols={3}>
              <Field label="Move right (mm)" hint="Negative moves the print left"><NumberInput value={cal.offsetXmm} step={0.5} decimals={1} min={-20} max={20} onChange={(n) => setCal({ offsetXmm: n ?? 0 })} /></Field>
              <Field label="Move down (mm)" hint="Negative moves the print up"><NumberInput value={cal.offsetYmm} step={0.5} decimals={1} min={-20} max={20} onChange={(n) => setCal({ offsetYmm: n ?? 0 })} /></Field>
              <Field label="Scale (%)" hint="Keep 100 unless the ruler on the test page measures wrong"><NumberInput value={cal.scalePct} step={1} min={50} max={150} onChange={(n) => setCal({ scalePct: n ?? 100 })} /></Field>
            </FormGrid>
            <Toggle checked={cal.silent} onChange={(v) => setCal({ silent: v })} label="Print directly, without the Windows print dialog" />
            {thermal && (
              <div style={{ marginTop: 12, padding: 10, border: '1px solid var(--line)', borderRadius: 8 }}>
                <strong>Thermal receipt printer</strong>
                <p className="muted" style={{ margin: '4px 0 8px' }}>
                  Normally the receipt is printed as a page through the printer's Windows driver, which works with every printer and every language.
                  If that prints badly (cut off, blank paper fed, slow), switch on Raw ESC/POS: the receipt is sent as printer commands straight to the Windows print queue.
                  Raw mode prints plain text only (English letters, digits, "Rs."), so Tamil and other scripts need the normal mode, and it does not print the UPI QR code.
                  It needs a driver that accepts raw data (Generic / Text Only, or the maker's ESC/POS driver) and does not work with PDF or OneNote printers.
                </p>
                <Toggle checked={!!cal.raw} onChange={(v) => setCal({ raw: v })} label="Raw ESC/POS mode" />
                <div style={{ height: 6 }} />
                {cal.raw && (
                  <>
                    <Toggle checked={cal.densityCommand !== false} onChange={(v) => setCal({ densityCommand: v })} label="Let Print darkness set the printer's heat (Epson-compatible density command)" />
                    <p className="muted" style={{ margin: '2px 0 6px' }}>Switch this off if a stray character appears at the top of the receipt after changing the darkness: that printer does not know the command.</p>
                  </>
                )}
                <Toggle checked={!!cal.drawerKick} onChange={(v) => setCal({ drawerKick: v })} label="Open the cash drawer after a cash sale (drawer plugged into the printer's RJ11 socket)" />
                <FormGrid cols={3}>
                  <Field label="Printable width" hint={edit.kind === 'receipt58' ? 'Usually 48 mm on 58 mm paper' : 'Usually 72 mm; some 80 mm printers print 76 mm'}>
                    <Select value={String(cal.printableMm ?? 0)} onChange={(e) => setCal({ printableMm: Number(e.target.value) })}>
                      <option value="0">Standard ({edit.kind === 'receipt58' ? '48' : '72'} mm)</option>
                      {edit.kind === 'receipt58' ? [44, 46, 48, 50, 52, 54].map((n) => <option key={n} value={n}>{n} mm</option>) : [68, 70, 72, 74, 76, 78].map((n) => <option key={n} value={n}>{n} mm</option>)}
                    </Select>
                  </Field>
                  <Field label="Paper cut" hint="Raw mode only">
                    <Select value={cal.cut ?? 'partial'} onChange={(e) => setCal({ cut: e.target.value as 'none' | 'partial' | 'full' })}>
                      <option value="partial">Partial cut</option><option value="full">Full cut</option><option value="none">No cut (feed only)</option>
                    </Select>
                  </Field>
                  <Field label="Drawer pin" hint="Pin 2 for most drawers">
                    <Select value={String(cal.drawerPin ?? 2)} onChange={(e) => setCal({ drawerPin: e.target.value === '5' ? 5 : 2 })}>
                      <option value="2">Pin 2</option><option value="5">Pin 5</option>
                    </Select>
                  </Field>
                </FormGrid>
              </div>
            )}
            <div style={{ height: 8 }} />
            <Toggle checked={edit.isDefault} onChange={(v) => setEdit({ ...edit, isDefault: v })} label="Use by default for this paper type" />
          </>
        )}
      </Modal>
    </>
  )
}

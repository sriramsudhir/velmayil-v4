import { useCallback, useEffect, useRef, useState } from 'react'
import { Badge, Button, Card, Field, FormGrid, Input, Select, Toggle } from '@/ui'
import { call, errMsg } from '@/lib/api'
import { beepError, beepOk } from '@/ui/sound'
import { formatINR } from '@shared/money'
import {
  analyzeCapture, attachScanner, clearLearned, DEFAULT_SCANNER, loadLearned, loadScannerConfig, saveScannerConfig, visibleCode,
  type CaptureAnalysis, type RawEvent, type ScanResult, type ScannerConfig, type Terminator
} from '@/lib/scanner'
import { serialScanner, serialSupported } from '@/lib/serialScanner'
import { hex4, hidScanner, hidSupported, type HidDeviceInfo } from '@/lib/hidScanner'
import { useHidStatus, useSerialStatus } from '@/lib/useScanner'

interface Found { variantId: number; displayName: string; sku: string; barcode: string | null; price: number; stock: number; trackStock: boolean }
interface KeyRow { n: number; key: string; code: string; gap: number; t: number }
interface WinDevice { name: string; instanceId: string; pnpClass: string; status: string; problemCode: number; vid: string; pid: string }
interface WinReport { supported: boolean; devices: WinDevice[]; readers: WinDevice[]; problems: WinDevice[]; error?: string }
interface PortRow { name: string; vid?: number; pid?: number }

const PREFIX_PRESETS = [['', 'None'], ['Enter', 'Enter key'], ['Tab', 'Tab key']] as const

export function ScannerSettings() {
  const [cfg, setCfg] = useState<ScannerConfig>(loadScannerConfig)
  const [customPrefix, setCustomPrefix] = useState(() => (['', 'Enter', 'Tab'].includes(loadScannerConfig().prefix) ? '' : loadScannerConfig().prefix))
  const serial = useSerialStatus()
  const hid = useHidStatus()
  const keyLog = useRef<KeyLogHandle | null>(null)
  const [last, setLast] = useState<{ scan: ScanResult; at: number } | null>(null)
  const [found, setFound] = useState<{ code: string; items: Found[]; error?: string } | null>(null)
  const [scanCount, setScanCount] = useState(0)
  const cfgRef = useRef(cfg)
  cfgRef.current = cfg
  const seq = useRef(0)
  const lastKeyT = useRef(0)

  // ---- "Detect my reader" wizard
  const [wiz, setWiz] = useState<{ state: 'idle' | 'listening' | 'done'; analysis?: CaptureAnalysis; before?: ScannerConfig; silent?: boolean }>({ state: 'idle' })
  const wizRef = useRef(wiz)
  wizRef.current = wiz
  const rawBuf = useRef<RawEvent[]>([])
  const wizTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const wizGiveUp = useRef<ReturnType<typeof setTimeout> | null>(null)

  const update = useCallback((patch: Partial<ScannerConfig>) => {
    const next = { ...cfgRef.current, ...patch }
    cfgRef.current = next
    setCfg(next)
    saveScannerConfig(next)
  }, [])

  const lookup = async (scan: ScanResult) => {
    const code = scan.code
    try {
      const v = await call<Found>('pos', 'scan', { code })
      if (cfgRef.current.sound) beepOk()
      setFound({ code, items: [v] })
    } catch (e) {
      if (cfgRef.current.sound) beepError()
      // scan-to-search mode: show every product matching the scanned text instead of a hard "not found"
      if (cfgRef.current.scanToSearch) {
        try { setFound({ code, items: await call<Found[]>('pos', 'search', { text: code }) }); return } catch { /* fall through */ }
      }
      setFound({ code, items: [], error: errMsg(e) })
    }
  }

  const finishWizard = useCallback(() => {
    if (wizTimer.current) clearTimeout(wizTimer.current)
    if (wizGiveUp.current) clearTimeout(wizGiveUp.current)
    const events = rawBuf.current
    rawBuf.current = []
    const analysis = analyzeCapture(events, cfgRef.current)
    const before = cfgRef.current
    if (analysis.ok) update(analysis.proposal) // propose AND save: the reader works right away; Undo restores the old settings
    setWiz({ state: 'done', analysis, before })
  }, [update])

  useEffect(() => {
    const onScan = (scan: ScanResult) => {
      setLast({ scan, at: Date.now() })
      setScanCount((n) => n + 1)
      void lookup(scan)
    }
    const onRaw = (ev: RawEvent, e: Event) => {
      if (wizRef.current.state === 'listening') {
        // the wizard owns the keyboard: nothing may leak into the page while a code is being captured
        e.preventDefault()
        e.stopImmediatePropagation()
        if (['Shift', 'CapsLock', 'Control', 'Alt'].includes(ev.key)) { rawBuf.current.push(ev); return }
        rawBuf.current.push(ev)
        if (wizTimer.current) clearTimeout(wizTimer.current)
        wizTimer.current = setTimeout(finishWizard, 650) // the code is over when the keyboard has been quiet for a moment
        if (wizGiveUp.current) { clearTimeout(wizGiveUp.current); wizGiveUp.current = null }
        return
      }
      if (ev.kind === 'input') {
        keyLog.current?.push({ n: ++seq.current, key: ev.key, code: '(no keydown: Alt code)', gap: 0, t: Math.round(ev.t) })
        return
      }
      if (['Shift', 'CapsLock', 'Control', 'Alt'].includes(ev.key)) return
      const gap = lastKeyT.current ? Math.round((ev.t - lastKeyT.current) * 10) / 10 : 0
      lastKeyT.current = ev.t
      keyLog.current?.push({ n: ++seq.current, key: ev.key === ' ' ? 'Space' : ev.key, code: ev.code ?? '', gap, t: Math.round(ev.t) })
    }
    const detach = attachScanner({
      config: () => (wizRef.current.state === 'listening' ? { ...cfgRef.current, enabled: false } : cfgRef.current),
      onScan,
      onRaw
    })
    const off = serialScanner.onScan((s) => { setLast({ scan: s, at: Date.now() }); setScanCount((n) => n + 1); void lookup(s) })
    const offHid = hidScanner.onScan((s) => { setLast({ scan: s, at: Date.now() }); setScanCount((n) => n + 1); void lookup(s) })
    return () => { detach(); off(); offHid(); if (wizTimer.current) clearTimeout(wizTimer.current); if (wizGiveUp.current) clearTimeout(wizGiveUp.current) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const startWizard = () => {
    rawBuf.current = []
    ;(document.activeElement as HTMLElement | null)?.blur?.()
    setWiz({ state: 'listening' })
    if (wizGiveUp.current) clearTimeout(wizGiveUp.current)
    wizGiveUp.current = setTimeout(() => { // nothing at all within 20 s: the keyboard path hears nothing
      wizGiveUp.current = null
      setWiz({ state: 'done', analysis: analyzeCapture([], cfgRef.current) })
    }, 20_000)
  }
  const cancelWizard = () => {
    if (wizTimer.current) clearTimeout(wizTimer.current)
    if (wizGiveUp.current) clearTimeout(wizGiveUp.current)
    rawBuf.current = []
    setWiz({ state: 'idle' })
  }
  const undoWizard = () => {
    if (wiz.before) { setCfg(wiz.before); cfgRef.current = wiz.before; saveScannerConfig(wiz.before) }
    setWiz({ state: 'idle' })
  }

  // ---- connected devices
  const [devBusy, setDevBusy] = useState(false)
  const [hidDevs, setHidDevs] = useState<HidDeviceInfo[]>([])
  const [ports, setPorts] = useState<PortRow[]>([])
  const [usbDevs, setUsbDevs] = useState<PortRow[] | null>(null)
  const [win, setWin] = useState<WinReport | null>(null)
  const [devErr, setDevErr] = useState('')
  const refreshDevices = useCallback(async () => {
    setDevBusy(true)
    setDevErr('')
    try {
      setHidDevs(await hidScanner.list())
      const nav = navigator as unknown as { serial?: { getPorts(): Promise<{ getInfo?: () => { usbVendorId?: number; usbProductId?: number } }[]> }; usb?: { getDevices(): Promise<{ productName?: string; vendorId: number; productId: number }[]> } }
      setPorts(nav.serial ? (await nav.serial.getPorts().catch(() => [])).map((p, i) => ({ name: `Serial port ${i + 1}`, vid: p.getInfo?.().usbVendorId, pid: p.getInfo?.().usbProductId })) : [])
      setUsbDevs(nav.usb ? (await nav.usb.getDevices().catch(() => [])).map((d) => ({ name: d.productName || 'USB device', vid: d.vendorId, pid: d.productId })) : null)
      setWin(await call<WinReport>('pos', 'scannerDevices'))
    } catch (e) {
      setDevErr(errMsg(e))
    } finally {
      setDevBusy(false)
    }
  }, [])
  useEffect(() => { void refreshDevices() }, [refreshDevices])

  const prefixValue = ['', 'Enter', 'Tab'].includes(cfg.prefix) ? cfg.prefix : 'custom'
  const learned = loadLearned()
  const heard = wiz.analysis?.length ?? 0

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <Card title="Detect my reader" actions={wiz.state === 'listening' ? <Button size="sm" onClick={cancelWizard}>Cancel</Button> : undefined}>
        <p className="muted" style={{ marginBottom: 10 }}>
          Press the button, then scan <strong>any barcode</strong> with your reader. The app records exactly what the reader sends (every key, its timing, the ending key, any prefix, keyboard-layout and Caps Lock trouble), works out the best settings and saves them.
        </p>
        {wiz.state === 'idle' && <Button variant="primary" onClick={startWizard} data-testid="wizard-start">Detect my reader</Button>}
        {wiz.state === 'listening' && (
          <div role="status" data-testid="wizard-listening" style={{ padding: 12, border: '2px dashed var(--accent, #c0392b)', borderRadius: 8, fontWeight: 600 }}>
            Listening... scan any barcode now. (Nothing you scan is typed anywhere while this is on.)
          </div>
        )}
        {wiz.state === 'done' && wiz.analysis && (
          <div data-testid="wizard-result" style={{ display: 'grid', gap: 8 }}>
            {wiz.analysis.ok ? (
              <>
                <div style={{ fontSize: 20, fontWeight: 700, wordBreak: 'break-all' }}>Reader code: <span data-testid="wizard-code">{wiz.analysis.code}</span></div>
                <div className="muted" data-testid="wizard-summary">
                  {wiz.analysis.length} characters · speed {wiz.analysis.speedLabel}, {wiz.analysis.medianGapMs} ms per key · ends with {wiz.analysis.suffix === 'none' ? 'nothing (pause)' : `${wiz.analysis.suffix} key`}
                  {wiz.analysis.prefixKey ? ` · starts with ${wiz.analysis.prefixKey} key` : ''}{wiz.analysis.prefixChars ? ` · starts with "${wiz.analysis.prefixChars}"` : ''}
                </div>
                <div className="pos-good" data-testid="wizard-saved" style={{ fontWeight: 600 }}>
                  Saved: ends with {String(wiz.analysis.proposal.suffix)}, max gap {wiz.analysis.proposal.maxGapMs} ms, keyboard layout {String(wiz.analysis.proposal.layout)}, shortest code {wiz.analysis.proposal.minLength}.
                </div>
              </>
            ) : <div className="pos-bad" style={{ fontWeight: 700 }}>The app heard nothing usable from the reader.</div>}
            <ul style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 4 }}>
              {wiz.analysis.findings.map((f, i) => <li key={i} className={f.level === 'warn' ? 'pos-warn' : f.level === 'ok' ? 'pos-good' : 'muted'} style={f.level === 'warn' ? { fontWeight: 400, fontSize: 'inherit' } : undefined}>{f.text}</li>)}
            </ul>
            {!wiz.analysis.ok && <p className="pos-bad">Go to "If the scanner still does not work" below: it tells you what to check, depending on what Windows can see.</p>}
            <div className="row">
              <Button variant="primary" onClick={startWizard}>Scan another to double-check</Button>
              {wiz.analysis.ok && <Button onClick={undoWizard}>Undo these settings</Button>}
              <Button variant="ghost" onClick={() => setWiz({ state: 'idle' })}>Close</Button>
            </div>
            {heard === 0 && null}
          </div>
        )}
      </Card>

      <Card title="Barcode scanner">
        <p className="muted" style={{ marginBottom: 10 }}>
          USB and Bluetooth scanners that act like a keyboard work without any setup: on the billing screen a scan is added to the bill whether the cursor is in the scan box or not.
          These options are saved on this computer. Use the test box below to check your scanner.
        </p>
        <Toggle checked={cfg.enabled} onChange={(v) => update({ enabled: v })} label="Detect barcode scanners (keyboard-wedge, USB / Bluetooth)" />
        <div style={{ height: 8 }} />
        <FormGrid cols={3}>
          <Field label="Scanner sends before the code (prefix)" hint="Most scanners send nothing">
            <Select value={prefixValue} onChange={(e) => { const v = e.target.value; if (v === 'custom') update({ prefix: customPrefix || '~' }); else update({ prefix: v }) }}>
              {PREFIX_PRESETS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              <option value="custom">Characters...</option>
            </Select>
            {prefixValue === 'custom' && <Input style={{ marginTop: 6 }} value={cfg.prefix} maxLength={6} onChange={(e) => { setCustomPrefix(e.target.value); update({ prefix: e.target.value }) }} aria-label="Prefix characters" />}
          </Field>
          <Field label="Scanner sends after the code (suffix)" hint="Enter is the factory default">
            <Select value={cfg.suffix} onChange={(e) => update({ suffix: e.target.value as Terminator })}>
              <option value="any">Enter or Tab (either)</option><option value="Enter">Enter key</option><option value="Tab">Tab key</option><option value="none">Nothing (detect by pause)</option>
            </Select>
          </Field>
          <Field label="Shortest barcode (characters)" hint="Shorter bursts are treated as typing">
            <Input inputMode="numeric" value={String(cfg.minLength)} onChange={(e) => update({ minLength: Number(e.target.value.replace(/\D/g, '')) || 1 })} />
          </Field>
          <Field label="Max time between characters (ms)" hint="USB ~40; slow Bluetooth scanners may need 80-250. Typing by hand is far slower. Learned automatically too.">
            <Input inputMode="numeric" value={String(cfg.maxGapMs)} onChange={(e) => update({ maxGapMs: Number(e.target.value.replace(/\D/g, '')) || DEFAULT_SCANNER.maxGapMs })} />
          </Field>
          <Field label="Pause that ends a code (ms)" hint="Only when the scanner sends no suffix">
            <Input inputMode="numeric" value={String(cfg.idleMs)} disabled={cfg.suffix !== 'none'} onChange={(e) => update({ idleMs: Number(e.target.value.replace(/\D/g, '')) || DEFAULT_SCANNER.idleMs })} />
          </Field>
          <Field label="Keyboard layout of the scanner" hint="Auto repairs shifted / French-style / Tamil-Hindi layouts">
            <Select value={cfg.layout} onChange={(e) => update({ layout: e.target.value as ScannerConfig['layout'] })}>
              <option value="auto">Automatic</option><option value="us">US keyboard (use physical keys)</option><option value="native">Use characters as typed</option>
            </Select>
          </Field>
          <Field label="Letter case" hint="Auto follows the scanner and fixes Caps Lock">
            <Select value={cfg.caseMode} onChange={(e) => update({ caseMode: e.target.value as ScannerConfig['caseMode'] })}>
              <option value="auto">Automatic</option><option value="upper">Always CAPITALS</option><option value="lower">always small letters</option>
            </Select>
          </Field>
        </FormGrid>
        <div style={{ display: 'grid', gap: 8, marginTop: 10 }}>
          <Toggle checked={cfg.adaptive} onChange={(v) => update({ adaptive: v })} label={`Learn my reader's speed automatically${learned.length ? ` (learned from ${learned.length} scan${learned.length === 1 ? '' : 's'})` : ''}`} />
          <Toggle checked={cfg.sound} onChange={(v) => update({ sound: v })} label="Beep on every scan (low buzz when the product is not found)" />
          <Toggle checked={cfg.scanToSearch} onChange={(v) => update({ scanToSearch: v })} label="Scan-to-search mode: a scan fills the search box and lists matching products instead of adding to the bill" />
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <Button onClick={() => { setCfg({ ...DEFAULT_SCANNER }); saveScannerConfig(DEFAULT_SCANNER); clearLearned(); setCustomPrefix('') }}>Reset to defaults</Button>
        </div>
      </Card>

      <Card title="Connected devices" actions={<Button size="sm" onClick={() => void refreshDevices()} disabled={devBusy}>{devBusy ? 'Checking...' : 'Refresh'}</Button>}>
        <p className="muted" style={{ marginBottom: 8 }}>What this computer and the app can see right now. A normal USB reader that types like a keyboard shows up only as a keyboard or HID device in the Windows list.</p>
        {devErr && <p className="pos-bad">{devErr}</p>}
        <DiagnosisBanner win={win} />
        <div style={{ display: 'grid', gap: 10, marginTop: 8 }}>
          <div>
            <strong>Windows device list</strong>
            {!win ? <p className="muted">Checking...</p> : !win.supported ? <p className="muted">Only available on Windows.</p> : win.error ? <p className="pos-bad">{win.error}</p> : (
              <ul data-testid="win-devices" style={{ margin: '4px 0 0', paddingLeft: 18, maxHeight: 180, overflow: 'auto', fontSize: 13 }}>
                {win.devices.filter((d) => !/hub|root|composite|generic usb|usb input device$/i.test(d.name) || d.problemCode !== 0).slice(0, 40).map((d) => (
                  <li key={d.instanceId} className={d.problemCode !== 0 ? 'pos-bad' : undefined}>
                    {d.name || '(no name)'} {d.vid && <span className="muted">VID {d.vid} / PID {d.pid}</span>} {d.problemCode !== 0 && <strong> - problem code {d.problemCode}</strong>}
                    {win.readers.includes(d) && <Badge tone="good">looks like a reader</Badge>}
                  </li>
                ))}
                {win.devices.length === 0 && <li className="muted">Windows returned no USB / HID devices.</li>}
              </ul>
            )}
          </div>
          <div>
            <strong>HID readers the app can open</strong> <span className="muted">(HID POS / vendor mode)</span>
            {!hidSupported() ? <p className="muted">WebHID is not available in this build.</p> : hidDevs.length === 0 ? <p className="muted">None connected yet. Use "Connect HID reader" below if your reader is in HID POS mode.</p> : (
              <ul style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: 13 }}>{hidDevs.map((d, i) => <li key={i}>{d.name} <span className="muted">VID {hex4(d.vendorId)} / PID {hex4(d.productId)}{d.opened ? ' · open' : ''}{d.looksLikeScanner ? ' · scanner usage' : ''}</span></li>)}</ul>
            )}
          </div>
          <div>
            <strong>Serial (COM) ports the app can open</strong>
            {ports.length === 0 ? <p className="muted">None connected yet.</p> : <ul style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: 13 }}>{ports.map((p, i) => <li key={i}>{p.name} {p.vid != null && <span className="muted">VID {hex4(p.vid)} / PID {hex4(p.pid ?? 0)}</span>}</li>)}</ul>}
            {usbDevs && usbDevs.length > 0 && <><strong style={{ display: 'block', marginTop: 6 }}>USB devices granted to the app</strong><ul style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: 13 }}>{usbDevs.map((p, i) => <li key={i}>{p.name} <span className="muted">VID {hex4(p.vid ?? 0)} / PID {hex4(p.pid ?? 0)}</span></li>)}</ul></>}
          </div>
        </div>
      </Card>

      <Card title="If the scanner still does not work">
        <Troubleshooting win={win} />
      </Card>

      <Card title="HID reader (HID POS / vendor HID mode)">
        <p className="muted" style={{ marginBottom: 10 }}>
          For readers that do NOT type into the screen because they were set to "HID POS", "USB HID barcode scanner (non-keyboard)" or a vendor mode. Connect once; the app reconnects by itself next time.
        </p>
        {!hidSupported() ? <p className="pos-warn">This computer / app build does not support HID readers.</p> : (
          <div className="row">
            {hid.state === 'connected'
              ? <Button onClick={() => void hidScanner.disconnect()}>Disconnect</Button>
              : <Button variant="primary" disabled={hid.state === 'connecting'} onClick={() => void hidScanner.connect().then(refreshDevices)}>Connect HID reader</Button>}
            <Badge tone={hid.state === 'connected' ? 'good' : hid.state === 'error' ? 'bad' : 'neutral'}>{hid.state === 'connected' ? `Connected: ${hid.device}` : hid.state === 'connecting' ? 'Connecting...' : hid.state === 'error' ? 'Error' : 'Not connected'}</Badge>
            <Toggle checked={cfg.hidAutoConnect} onChange={(v) => update({ hidAutoConnect: v })} label="Reconnect automatically on the billing screen" />
          </div>
        )}
        {hid.message && <p className="muted" style={{ marginTop: 6 }}>{hid.message}</p>}
      </Card>

      <Card title="Serial (COM port) scanner">
        <p className="muted" style={{ marginBottom: 10 }}>
          For scanners that appear as a COM port (RS-232 / USB virtual serial) instead of a keyboard. Pick the speed set in the scanner (9600 or 115200 are the usual ones), then connect.
        </p>
        {!serialSupported() ? <p className="pos-warn">This computer / app build does not support serial scanners.</p> : (
          <div className="row">
            <Select style={{ width: 150 }} value={String(cfg.serialBaud)} onChange={(e) => update({ serialBaud: Number(e.target.value) })} aria-label="Baud rate">
              {[1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200].map((b) => <option key={b} value={b}>{b} baud</option>)}
            </Select>
            {serial.state === 'connected'
              ? <Button onClick={() => void serialScanner.disconnect()}>Disconnect</Button>
              : <Button variant="primary" disabled={serial.state === 'connecting'} onClick={() => void serialScanner.connect(cfg.serialBaud).then(refreshDevices)}>Connect serial scanner</Button>}
            <Badge tone={serial.state === 'connected' ? 'good' : serial.state === 'error' ? 'bad' : 'neutral'}>{serial.state === 'connected' ? `Connected at ${serial.baud}` : serial.state === 'connecting' ? 'Connecting...' : serial.state === 'error' ? 'Error' : 'Not connected'}</Badge>
            <Toggle checked={cfg.serialAutoConnect} onChange={(v) => update({ serialAutoConnect: v })} label="Reconnect automatically on the billing screen" />
          </div>
        )}
        {serial.message && <p className="muted" style={{ marginTop: 6 }}>{serial.message}</p>}
      </Card>

      <Card title="Scanner test" actions={<Button size="sm" onClick={() => { keyLog.current?.clear(); setLast(null); setFound(null); setScanCount(0) }}>Clear</Button>}>
        <p className="muted" style={{ marginBottom: 10 }}>
          Scan any barcode now (no need to click anywhere). Typing by hand is shown in the key list but is not counted as a scan. Scans detected: <strong data-testid="scan-count">{scanCount}</strong>.
        </p>
        <div className="grid2" style={{ gridTemplateColumns: 'minmax(260px, 1fr) minmax(260px, 1fr)', alignItems: 'start' }}>
          <div>
            <strong>Detected scan</strong>
            {last ? (
              <div data-testid="scan-result" style={{ marginTop: 6, display: 'grid', gap: 2 }}>
                <div style={{ fontSize: 22, fontWeight: 700, wordBreak: 'break-all' }} data-testid="scan-code">{last.scan.code}</div>
                <div className="muted">{last.scan.length} characters in {Math.round(last.scan.durationMs)} ms · average gap {last.scan.avgGapMs} ms · slowest gap {Math.round(last.scan.maxGapMs)} ms</div>
                <div className="muted">Ended by: {last.scan.terminator === 'idle' ? 'pause (no suffix)' : last.scan.terminator === 'serial' ? 'serial line end' : last.scan.terminator === 'hid' ? 'HID report' : `${last.scan.terminator} key`}{last.scan.typed !== last.scan.code && <> · typed as <code>{visibleCode(last.scan.typed)}</code> (repaired)</>}</div>
              </div>
            ) : <p className="muted">Nothing scanned yet.</p>}
            <div style={{ marginTop: 12 }}>
              <strong>Product lookup</strong>
              {!found ? <p className="muted">The scanned code is looked up in your products.</p> : found.items.length === 0 ? (
                <p className="pos-bad" data-testid="scan-lookup">Not found in catalog: {visibleCode(found.code)}{found.error ? ` (${found.error})` : ''}</p>
              ) : (
                <ul style={{ margin: '6px 0 0', paddingLeft: 18 }} data-testid="scan-lookup">
                  {found.items.slice(0, 8).map((v) => <li key={v.variantId}><strong>{v.displayName}</strong> <span className="muted">{v.sku}{v.barcode ? ` · ${v.barcode}` : ''}</span> {formatINR(v.price)} <span className="muted">· stock {v.trackStock ? v.stock : 'n/a'}</span></li>)}
                </ul>
              )}
            </div>
          </div>
          <div>
            <strong>Keys received</strong> <span className="muted">(key · physical key · ms since previous)</span>
            <KeyLog handle={keyLog} maxGapMs={cfg.maxGapMs} />
          </div>
        </div>
      </Card>
    </div>
  )
}

interface KeyLogHandle { push(row: KeyRow): void; clear(): void }
/**
 * The raw key list owns its own state, so a key press re-renders only this small list and not the whole (large) settings page:
 * a 13-key scan must not be slowed by 13 full-page renders (that made even the page itself look like a "slow reader").
 */
function KeyLog({ handle, maxGapMs }: { handle: { current: KeyLogHandle | null }; maxGapMs: number }) {
  const [keys, setKeys] = useState<KeyRow[]>([])
  useEffect(() => {
    handle.current = { push: (row) => setKeys((k) => [...k.slice(-39), row]), clear: () => setKeys([]) }
    return () => { handle.current = null }
  }, [handle])
  return (
    <>
      <div style={{ marginTop: 6, maxHeight: 220, overflow: 'auto', fontFamily: 'Consolas, monospace', fontSize: 12, border: '1px solid var(--line)', borderRadius: 6, padding: 6 }} data-testid="key-log">
        {keys.length === 0 ? <span className="muted">Waiting for keys...</span> : keys.map((k) => (
          <div key={k.n} style={{ color: k.gap > 0 && k.gap <= maxGapMs ? 'var(--good)' : undefined }}>{k.key.padEnd(8)} {k.code.padEnd(12)} {k.gap ? `${k.gap} ms` : 'first'}</div>
        ))}
      </div>
      <p className="muted" style={{ marginTop: 4 }}>Green = fast enough to be part of a scan (max {maxGapMs} ms).</p>
    </>
  )
}

/** One-line verdict from what Windows reports. */
function DiagnosisBanner({ win }: { win: WinReport | null }) {
  if (!win || !win.supported || win.error) return null
  if (win.problems.length > 0) {
    const p = win.problems[0]
    return (
      <p className="pos-bad" role="alert" data-testid="diag-problem" style={{ fontWeight: 600 }}>
        Windows sees a USB device that failed to start: "{p.name}"{p.problemCode ? ` (problem code ${p.problemCode})` : ''}. This is typically the barcode reader on a bad port or cable: Windows itself cannot talk to it, so no program can. Try another USB port (use a port directly on the computer, not a hub), another cable, then Refresh.
      </p>
    )
  }
  if (win.readers.length > 0) return <p className="pos-good" data-testid="diag-reader" style={{ fontWeight: 600 }}>Windows sees a reader-like device: {win.readers[0].name}. If scanning does nothing in the app, follow the checklist below.</p>
  return <p className="pos-warn" data-testid="diag-none" style={{ fontWeight: 600, fontSize: 13 }}>Windows lists no device that looks like a barcode reader. If your reader is plugged in, see "Windows does not see the reader at all" below.</p>
}

function Troubleshooting({ win }: { win: WinReport | null }) {
  const hasProblem = !!win && win.problems.length > 0
  const item = (open: boolean, title: string, children: React.ReactNode) => (
    <details open={open} style={{ border: '1px solid var(--line)', borderRadius: 8, padding: '6px 10px' }}>
      <summary style={{ cursor: 'pointer', fontWeight: 600 }}>{title}</summary>
      <div style={{ marginTop: 6, display: 'grid', gap: 4, fontSize: 13 }}>{children}</div>
    </details>
  )
  return (
    <div style={{ display: 'grid', gap: 8 }} data-testid="troubleshooting">
      {item(hasProblem, '1. Windows does not see the reader at all', <>
        <p>Signs: the reader does not beep or light up when plugged in, it does not type into Notepad either, or Device Manager shows "Unknown USB Device (Device Descriptor Request Failed)".</p>
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          <li>Try a different USB port, directly on the computer (not a hub or a front-panel extension).</li>
          <li>Try a different USB cable (readers with a detachable cable often fail because of the cable).</li>
          <li>Unplug the reader for 10 seconds, plug it back in. Listen for the power-up beep / look for the LED.</li>
          <li>Open Device Manager (right-click Start): look under "Universal Serial Bus controllers" for "Unknown USB Device (Device Descriptor Request Failed)". If it is there, Windows cannot talk to the device: it is a port, cable or reader hardware problem, not a software setting.</li>
          <li>Try the reader on another computer. If it fails there too, the reader or its cable is faulty.</li>
        </ul>
      </>)}
      {item(false, '2. The reader types into Notepad but not into this app', <>
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          <li>Click "Detect my reader" at the top of this page and scan a barcode. It checks the speed, ending key and keyboard layout, and saves the right settings.</li>
          <li>Make sure the Windows keyboard language is English (US / India), not Tamil or Hindi (press Windows+Space to switch). The app repairs most layout problems, but English is safest.</li>
          <li>If the code appears but the product is "not found in catalog", compare it with the number under the barcode: extra or missing digits mean the reader adds/strips characters (check digit, leading zero, "]E0" prefix, "*" stars). The red message on the billing screen shows exactly what the reader sent.</li>
          <li>Click the scan box on the billing screen once and scan again.</li>
        </ul>
      </>)}
      {item(false, '3. The reader is in HID-POS or serial mode (does not type)', <>
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          <li>Windows sees the reader but nothing appears in Notepad and "Detect my reader" hears nothing: the reader is probably in "HID POS", "USB HID (non-keyboard)" or "USB serial / virtual COM" mode.</li>
          <li>Easiest fix: scan the manufacturer's <strong>"USB HID Keyboard"</strong> (sometimes "USB keyboard mode" or "HID keyboard emulation") configuration barcode from the reader's manual. The reader then types like a keyboard and works everywhere.</li>
          <li>Or keep that mode and use "Connect HID reader" (HID POS) or "Connect serial scanner" (COM port) in the cards on this page.</li>
          <li>Honeywell / Metrologic: "USB HID Keyboard" code is in the User Guide under "USB Interface". Zebra / Symbol: "USB HID Keyboard Emulation (Host)". Datalogic: "USB-KBD". Cheap generic readers: the little leaflet usually has "USB keyboard" / "USB COM" barcodes.</li>
        </ul>
      </>)}
      {item(false, '4. The reader needs an Enter suffix', <>
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          <li>Signs: the code appears in the scan box but is not added until you press Enter yourself.</li>
          <li>Scan the "Add Enter suffix" / "Add CR suffix" configuration barcode from the manual. Many readers also have "Add Tab suffix": the app understands Enter, Tab or none (it then waits for a short pause).</li>
          <li>"Detect my reader" tells you which ending your reader sends and saves it.</li>
        </ul>
      </>)}
    </div>
  )
}

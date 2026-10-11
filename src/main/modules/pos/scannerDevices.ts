import { execFile } from 'node:child_process'

/**
 * "What does Windows itself see?" for Settings > Scanner. Chromium can only list devices it may talk to (HID POS, serial);
 * a normal keyboard-wedge reader is just a keyboard to it, and a reader that Windows failed to enumerate is invisible to it.
 * This asks Windows (Win32_PnPEntity) so the troubleshooting page can tell "Windows does not see the reader at all"
 * (a USB device with "Device Descriptor Request Failed", problem code 43) from "Windows sees a keyboard but the app gets nothing".
 */
export interface WinDevice {
  name: string
  instanceId: string
  pnpClass: string
  status: string
  /** Windows Device Manager problem code, 0 = fine (43 = device reported problems, e.g. "Device Descriptor Request Failed") */
  problemCode: number
  vid: string
  pid: string
}

export interface DeviceReport {
  supported: boolean
  devices: WinDevice[]
  /** devices that look like a barcode reader / keyboard-wedge reader */
  readers: WinDevice[]
  /** USB devices Windows could not start (the reader on a dead port / bad cable shows up like this) */
  problems: WinDevice[]
  error?: string
}

/** Vendor ids of common barcode-reader makers (hex, upper case) and the generic chips cheap readers use. */
const READER_VIDS = new Set([
  '0C2E', '200F', // Honeywell / Metrologic
  '05E0', '1504', // Zebra / Symbol / Motorola
  '05F9', '0536', // Datalogic / PSC / Hand Held Products
  '1EAB', // Newland
  '065A', // Opticon
  '0483', // STMicroelectronics (many cheap HID keyboard-mode readers, e.g. 0483:0011)
  '1A86', '067B', '10C4', '0403', // CH340 / Prolific / CP210x / FTDI serial bridges (serial-mode readers)
  '0C45', '1D57', '04B4', '0B05', '0E6A', '1C4F', '28E9', '13BA', '2DD6', '27DD', '1FC9' // assorted OEM keyboard-type readers
])

const SCRIPT =
  "$ErrorActionPreference='SilentlyContinue';" +
  "Get-CimInstance Win32_PnPEntity -Filter \"PNPDeviceID LIKE 'USB%' OR PNPDeviceID LIKE 'HID%' OR PNPDeviceID LIKE 'FTDIBUS%' OR ConfigManagerErrorCode <> 0\" |" +
  ' Select-Object Name,PNPDeviceID,PNPClass,Status,ConfigManagerErrorCode | ConvertTo-Json -Compress'

export function parseDeviceJson(text: string): WinDevice[] {
  const t = text.trim()
  if (!t) return []
  let raw: unknown
  try { raw = JSON.parse(t) } catch { return [] }
  const arr = Array.isArray(raw) ? raw : [raw]
  return arr.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object').map((r) => {
    const id = String(r.PNPDeviceID ?? '')
    const vid = /VID_([0-9A-F]{4})/i.exec(id)?.[1]?.toUpperCase() ?? ''
    const pid = /PID_([0-9A-F]{4})/i.exec(id)?.[1]?.toUpperCase() ?? ''
    return {
      name: String(r.Name ?? ''), instanceId: id, pnpClass: String(r.PNPClass ?? ''), status: String(r.Status ?? ''),
      problemCode: Number(r.ConfigManagerErrorCode ?? 0) || 0, vid, pid
    }
  })
}

export function classifyDevices(devices: WinDevice[]): Pick<DeviceReport, 'readers' | 'problems'> {
  const problems = devices.filter((d) => d.problemCode !== 0 || /device descriptor request failed|unknown usb device/i.test(d.name))
  const readers = devices.filter((d) => {
    if (d.problemCode !== 0) return false
    if (/scan|barcode|bar code|reader|symbol|honeywell|zebra|datalogic|newland|opticon/i.test(d.name)) return true
    if (/^HID\\/i.test(d.instanceId) && /VID_/i.test(d.instanceId) && READER_VIDS.has(d.vid)) return true
    if (/^USB\\/i.test(d.instanceId) && /VID_/i.test(d.instanceId) && READER_VIDS.has(d.vid) && !/hub|root|composite/i.test(d.name)) return true
    return false
  })
  return { readers, problems }
}

export function listWindowsDevices(timeoutMs = 12_000): Promise<DeviceReport> {
  if (process.platform !== 'win32') return Promise.resolve({ supported: false, devices: [], readers: [], problems: [] })
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SCRIPT], { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err && !stdout) return resolve({ supported: true, devices: [], readers: [], problems: [], error: `Could not ask Windows for the device list (${(err as Error).message.split('\n')[0]})` })
      const devices = parseDeviceJson(String(stdout))
      resolve({ supported: true, devices, ...classifyDevices(devices) })
    })
  })
}

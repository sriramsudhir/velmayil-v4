import { createRequire } from 'node:module'

/**
 * Main-process side of the optional non-keyboard barcode readers (Chromium device APIs inside Electron):
 *   - Web Serial  (navigator.serial)  : COM-port / "USB virtual serial" readers        -> select-serial-port
 *   - WebHID      (navigator.hid)     : readers in "HID POS" / vendor HID mode         -> select-hid-device
 * Electron has no built-in device chooser, so the main process answers the `select-*` events (a small native dialog that lists
 * the devices with their VID/PID), and a SINGLE device-permission handler grants every device kind we support. All of it lives
 * in this one module and is installed once, so the handlers can never overwrite each other (session.setDevicePermissionHandler
 * and setPermissionCheckHandler hold only ONE function per session).
 * No-op outside Electron (tests, plain node). Never throws. The real-device paths cannot be exercised without hardware.
 */
let installed = false

/** Device kinds the renderer may use. Add a kind here, never call setDevicePermissionHandler anywhere else. */
export const GRANTED_DEVICE_TYPES = new Set(['serial', 'hid'])

interface SerialInfo { portId: string; displayName?: string; portName?: string; vendorId?: string; productId?: string }
interface HidInfo { deviceId: string; name?: string; vendorId?: number; productId?: number; serialNumber?: string }

const hex4 = (n: number | string | undefined) => (n == null || n === '' ? '????' : Number(n).toString(16).toUpperCase().padStart(4, '0'))

export const describeSerialPort = (p: SerialInfo): string =>
  `${p.displayName || p.portName || `Port ${p.portId}`}${p.vendorId ? `  (VID ${hex4(p.vendorId)} / PID ${hex4(p.productId)})` : ''}`

export const describeHidDevice = (d: HidInfo): string =>
  `${d.name || 'HID device'}  (VID ${hex4(d.vendorId)} / PID ${hex4(d.productId)})`

export function installDevicePermissionHandlers(): void {
  if (installed || !process.versions.electron) return
  installed = true
  try {
    const el = createRequire(process.execPath)('electron') as typeof import('electron')
    void el.app.whenReady().then(() => {
      const ses = el.session.defaultSession
      const choose = (title: string, message: string, labels: string[]): Promise<number> =>
        el.dialog
          .showMessageBox({ type: 'question', title, message, buttons: [...labels.slice(0, 9), 'Cancel'], cancelId: Math.min(labels.length, 9) })
          .then((r) => (r.response < Math.min(labels.length, 9) ? r.response : -1))
          .catch(() => -1)

      ses.on('select-serial-port', (event, ports: SerialInfo[], _wc, callback) => {
        event.preventDefault()
        if (!ports.length) return callback('')
        if (ports.length === 1) return callback(ports[0].portId)
        void choose('Serial scanner', 'Which port is the barcode scanner on?', ports.map(describeSerialPort)).then((i) => callback(i >= 0 ? ports[i].portId : ''))
      })

      // WebHID: the renderer asks with navigator.hid.requestDevice({filters:[]}); we list every non-protected HID device
      // (keyboards/mice are hidden by Chromium on purpose: a reader that TYPES like a keyboard needs no connection at all).
      ses.on('select-hid-device', (event, details: { deviceList: HidInfo[] }, callback) => {
        event.preventDefault()
        const list = details.deviceList ?? []
        if (!list.length) return callback('')
        if (list.length === 1) return callback(list[0].deviceId)
        void choose('HID barcode reader', 'Which device is the barcode reader?', list.map(describeHidDevice)).then((i) => callback(i >= 0 ? list[i].deviceId : ''))
      })

      // One handler for all device kinds (a second setDevicePermissionHandler call would silently replace this one).
      ses.setDevicePermissionHandler((d) => GRANTED_DEVICE_TYPES.has(d.deviceType))
      // Permission checks default to "allowed"; keep that for everything else so installing this can never lock another feature out.
      // (file:// pages need an explicit 'hid'/'serial' yes in the check handler; the rest is Electron's default = allowed.)
      ses.setPermissionCheckHandler(() => true)
    })
  } catch {
    /* serial / HID readers simply stay unavailable */
  }
}

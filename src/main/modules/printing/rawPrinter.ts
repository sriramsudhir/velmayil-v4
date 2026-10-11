import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { LogoDecoder } from './escpos'

/**
 * RAW printing: send ESC/POS bytes straight to a Windows printer queue (no driver rendering).
 *
 * Route chosen: the Windows print spooler API (winspool.drv: OpenPrinter / StartDocPrinter with datatype "RAW" /
 * WritePrinter), invoked through a small PowerShell script (Add-Type P/Invoke). Reasons: it works for any installed
 * printer (USB, serial, network, Bluetooth) without sharing it, goes through the spooler (so jobs queue and survive a
 * busy printer) and needs no native Node module. Alternatives rejected: `copy /b file \\host\share` needs the printer
 * shared; `print /d:` mangles binary data; direct USB/serial needs native modules.
 *
 * Honest limits: Windows only; needs powershell.exe (5.1 ships with Windows) and Add-Type must be allowed (it is
 * blocked in PowerShell "Constrained Language Mode" / some AV policies); the printer's driver must accept the RAW data
 * type (Generic/Text Only and the vendor ESC/POS drivers do; GDI-only or XPS-only "printers" such as PDF/OneNote reject it);
 * "success" means the spooler accepted the bytes, not that paper came out. Every failure is returned as {ok:false,error}.
 */

export interface RawPrintAdapter {
  /** deviceName '' = the Windows default printer */
  sendRaw(deviceName: string, bytes: Buffer): Promise<{ ok: boolean; error?: string }>
}

export const RAW_PS_SCRIPT = `param([string]$Printer, [string]$File)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class PosRawSpool {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public class DOCINFO { [MarshalAs(UnmanagedType.LPWStr)] public string pDocName; [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile; [MarshalAs(UnmanagedType.LPWStr)] public string pDataType; }
  [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool OpenPrinter(string n, out IntPtr h, IntPtr d);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool ClosePrinter(IntPtr h);
  [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool StartDocPrinter(IntPtr h, int level, [In] DOCINFO di);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool EndDocPrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool WritePrinter(IntPtr h, byte[] b, int c, out int w);
  [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool GetDefaultPrinter(StringBuilder b, ref int size);
  public static string Send(string printer, byte[] data) {
    if (String.IsNullOrEmpty(printer)) {
      int size = 520; StringBuilder sb = new StringBuilder(size);
      if (!GetDefaultPrinter(sb, ref size)) return "No default printer is set in Windows";
      printer = sb.ToString();
    }
    IntPtr h;
    if (!OpenPrinter(printer, out h, IntPtr.Zero)) return "Cannot open printer '" + printer + "' (error " + Marshal.GetLastWin32Error() + ")";
    try {
      DOCINFO di = new DOCINFO(); di.pDocName = "POS receipt"; di.pDataType = "RAW";
      if (!StartDocPrinter(h, 1, di)) return "The printer driver does not accept RAW jobs (error " + Marshal.GetLastWin32Error() + ")";
      try {
        if (!StartPagePrinter(h)) return "StartPagePrinter failed (error " + Marshal.GetLastWin32Error() + ")";
        int written;
        bool ok = WritePrinter(h, data, data.Length, out written);
        EndPagePrinter(h);
        if (!ok || written != data.Length) return "WritePrinter failed (error " + Marshal.GetLastWin32Error() + ", wrote " + written + " of " + data.Length + ")";
      } finally { EndDocPrinter(h); }
    } finally { ClosePrinter(h); }
    return "";
  }
}
"@
$bytes = [System.IO.File]::ReadAllBytes($File)
$r = [PosRawSpool]::Send($Printer, $bytes)
if ($r) { [Console]::Error.WriteLine($r); exit 2 }
`

export type ExecFileFn = (file: string, args: string[], opts: { timeout: number; windowsHide: boolean }, cb: (err: (Error & { code?: unknown; killed?: boolean }) | null, stdout: string, stderr: string) => void) => unknown

export interface WindowsRawOptions {
  /** where the temporary job + script files go */
  tmpDir: string
  platform?: NodeJS.Platform
  exec?: ExecFileFn
  timeoutMs?: number
}

export class WindowsRawPrinter implements RawPrintAdapter {
  constructor(private o: WindowsRawOptions) {}

  async sendRaw(deviceName: string, bytes: Buffer): Promise<{ ok: boolean; error?: string }> {
    const platform = this.o.platform ?? process.platform
    if (platform !== 'win32') return { ok: false, error: 'Raw ESC/POS printing is only available on Windows.' }
    if (!bytes.length) return { ok: false, error: 'Nothing to print.' }
    const id = randomUUID()
    const dir = this.o.tmpDir
    const job = join(dir, `raw-${id}.bin`)
    const script = join(dir, `raw-${id}.ps1`)
    try {
      mkdirSync(dir, { recursive: true })
      writeFileSync(job, bytes)
      writeFileSync(script, RAW_PS_SCRIPT, 'utf8')
    } catch (e) {
      return { ok: false, error: `Could not prepare the raw print job: ${e instanceof Error ? e.message : String(e)}` }
    }
    const exec = this.o.exec ?? (execFile as unknown as ExecFileFn)
    const timeout = this.o.timeoutMs ?? 20_000
    try {
      return await new Promise<{ ok: boolean; error?: string }>((resolve) => {
        try {
          exec(
            'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...(deviceName ? ['-Printer', deviceName] : []), '-File', job],
            { timeout, windowsHide: true },
            (err, _out, stderr) => {
              if (!err) return resolve({ ok: true })
              if (err.killed) return resolve({ ok: false, error: `Raw printing timed out after ${Math.round(timeout / 1000)} s (PowerShell did not finish).` })
              if (err.code === 'ENOENT') return resolve({ ok: false, error: 'PowerShell was not found, so raw printing is unavailable on this PC.' })
              const msg = String(stderr || '').trim().split(/\r?\n/)[0] || err.message
              resolve({ ok: false, error: `Raw printing failed: ${msg}` })
            }
          )
        } catch (e) {
          resolve({ ok: false, error: `Could not start PowerShell: ${e instanceof Error ? e.message : String(e)}` })
        }
      })
    } finally {
      for (const f of [job, script]) {
        try { rmSync(f, { force: true }) } catch { /* ignore */ }
      }
    }
  }
}

/** Logo decoding through Electron's nativeImage (main process). Returns null outside Electron: the logo is skipped. */
export const electronLogoDecoder: LogoDecoder = (image, maxWidthPx) => {
  try {
    if (!process.versions.electron) return null
    const { nativeImage } = createRequire(process.execPath)('electron') as typeof import('electron')
    let img = nativeImage.createFromBuffer(image)
    if (img.isEmpty()) return null
    const size = img.getSize()
    if (size.width > maxWidthPx) img = img.resize({ width: maxWidthPx, quality: 'best' })
    const s = img.getSize()
    return { width: s.width, height: s.height, pixels: img.toBitmap(), order: 'bgra' }
  } catch {
    return null
  }
}

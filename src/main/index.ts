import { app as electronApp, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { App, coalesceChanges } from './core/app'
import { registerAllModules } from './core/modules'
import { ensureDefaultSettings } from './core/settings'
import { toAppError } from './core/validate'
import { AppError, IPC_CHANNEL, LIVE_CHANNEL, type IpcResult } from '@shared/ipc'

let core: App | null = null
let mainWindow: BrowserWindow | null = null
let shuttingDown = false
let logFile: string | null = null

const LOG_MAX_BYTES = 2 * 1024 * 1024

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v)
  } catch {
    return String(v)
  }
}

/**
 * The packaged app has no console: problems are appended to <data folder>/logs/main.log (one older file is kept).
 * Never throws: logging must not be able to take the POS down.
 */
function logError(what: string, e?: unknown): void {
  const detail = e === undefined ? '' : e instanceof Error ? e.stack ?? e.message : typeof e === 'string' ? e : safeJson(e)
  console.error(what, e ?? '')
  if (!logFile) return
  try {
    try {
      if (statSync(logFile).size > LOG_MAX_BYTES) renameSync(logFile, logFile.replace(/\.log$/, '.old.log'))
    } catch {
      /* no log yet */
    }
    appendFileSync(logFile, `${new Date().toISOString()} ${what}${detail ? ' ' + detail : ''}\n`)
  } catch {
    /* disk full / folder not writable: nothing more we can do */
  }
}

/** Plain page shown instead of a blank window when the UI cannot be loaded or keeps crashing. */
function showFailurePage(win: BrowserWindow, title: string, detail: string): void {
  const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const html =
    `<!doctype html><meta charset="utf-8"><title>Velmayil POS</title><body style="font:15px Segoe UI,Arial,sans-serif;margin:48px;color:#222">` +
    `<h2>${esc(title)}</h2><p>Your saved bills and stock are safe. Close this window and start Velmayil POS again.</p>` +
    `<p>If this keeps happening, send this to support:</p>` +
    `<pre style="white-space:pre-wrap;background:#f3f3f3;padding:12px;border-radius:6px">${esc(detail)}${logFile ? '\n\nLog file: ' + esc(logFile) : ''}</pre></body>`
  if (!win.isDestroyed()) void win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html)).catch(() => undefined)
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1366,
    height: 820,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    title: 'Velmayil POS',
    webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: false }
  })
  mainWindow = win
  win.once('ready-to-show', () => win.show())
  // 'ready-to-show' never fires when the page fails to load: never leave the shop with an invisible window
  const showAnyway = setTimeout(() => {
    if (!win.isDestroyed() && !win.isVisible()) win.show()
  }, 8000)
  win.once('show', () => clearTimeout(showAnyway))
  win.on('closed', () => {
    clearTimeout(showAnyway)
    if (mainWindow === win) mainWindow = null
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  // A screen with unsaved edits registers 'beforeunload'. Electron then silently refuses to close the window (there is
  // no built-in prompt), so ask here; "Close anyway" lets the unload go ahead.
  win.webContents.on('will-prevent-unload', (e) => {
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question', buttons: ['Stay', 'Close anyway'], defaultId: 0, cancelId: 0, noLink: true,
      title: 'Unsaved changes', message: 'You have unsaved changes on this screen.', detail: 'If you close now, those changes are lost.'
    })
    if (choice === 1) e.preventDefault()
  })
  let crashes = 0
  win.webContents.on('render-process-gone', (_e, d) => {
    logError('renderer gone:', `${d.reason} (exit code ${d.exitCode})`)
    if (d.reason === 'clean-exit' || shuttingDown || win.isDestroyed()) return
    // one crash: reload the UI (the database lives in this process, nothing saved is lost); repeated crashes: explain
    if (++crashes <= 2) win.webContents.reload()
    else showFailurePage(win, 'The screen stopped working', `Renderer process ended: ${d.reason}`)
  })
  win.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return // -3 = aborted (a newer navigation replaced this one)
    logError('window failed to load:', `${code} ${desc} ${url}`)
    if (!url.startsWith('data:')) showFailurePage(win, 'Velmayil POS could not load its screen', `${desc} (${code})\n${url}`)
    if (!win.isDestroyed() && !win.isVisible()) win.show()
  })
  win.on('unresponsive', () => logError('window unresponsive'))
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL).catch(() => undefined)
  else void win.loadFile(join(__dirname, '../renderer/index.html')).catch(() => undefined)
}

/** `details` cross IPC by structured clone: anything that cannot be cloned (functions, class instances) would reject the whole reply. */
function cloneable(details: unknown): unknown {
  if (details === undefined) return undefined
  try {
    return JSON.parse(JSON.stringify(details))
  } catch {
    return undefined
  }
}

function toError(e: unknown, where = ''): IpcResult<never> {
  if (!(e instanceof AppError)) logError(`service error ${where}`.trim() + ':', e)
  const err = toAppError(e)
  return { ok: false, error: { code: err.code, message: err.message || 'Unexpected error', details: cloneable(err.details) } }
}

/** Flush and close the database exactly once. Safe to call repeatedly. */
function shutdown(): void {
  if (shuttingDown) return
  shuttingDown = true
  try {
    core?.close()
  } catch (e) {
    logError('Error closing database', e)
  }
  core = null
}

function bootstrap(): void {
  // Test/E2E hook: VELMAYIL_DATA_DIR isolates a run's database from the real one.
  const userData = process.env.VELMAYIL_DATA_DIR ?? electronApp.getPath('userData')
  try {
    mkdirSync(userData, { recursive: true })
  } catch (e) {
    dialog.showErrorBox('Velmayil POS cannot use its data folder', `${(e as Error).message}\n\nData folder: ${userData}\n\nCheck that this Windows user may write to that folder.`)
    electronApp.exit(1)
    return
  }
  try {
    mkdirSync(join(userData, 'logs'), { recursive: true })
    logFile = join(userData, 'logs', 'main.log')
  } catch {
    logFile = null // keep running without a log file
  }
  try {
    core = new App({ dbPath: join(userData, 'velmayil.db'), userDataDir: userData })
  } catch (e) {
    logError('cannot open database:', e)
    dialog.showErrorBox('Velmayil POS cannot open its database', `${(e as Error).message}\n\nData folder: ${userData}\n\nRestore a backup or contact support.`)
    electronApp.exit(1)
    return
  }

  const failures: string[] = []
  registerAllModules(core, { onError: (f) => (logError('module failed to start:', f.error), failures.push(`${f.module}: ${f.error.message}`)) })
  try {
    ensureDefaultSettings(core)
  } catch (e) {
    failures.push(`settings: ${(e as Error).message}`)
  }
  if (failures.length) {
    dialog.showErrorBox('Some modules failed to start', failures.join('\n\n'))
    // A half-started POS is unsafe to sell with: only keep running unpackaged (development).
    if (electronApp.isPackaged) {
      shutdown()
      electronApp.exit(1)
      return
    }
  }

  ipcMain.handle(IPC_CHANNEL, async (_e, service: string, method: string, args: unknown): Promise<IpcResult> => {
    try {
      if (!core) throw new AppError('INTERNAL', 'Application is shutting down')
      return { ok: true, data: await core.call(service, method, args) }
    } catch (e) {
      return toError(e, `${service}.${method}`)
    }
  })
  // Live data bus: push committed changes to every window (coalesced), incl. out-of-band writes such as sync applies.
  coalesceChanges(core, 50, (events) => {
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(LIVE_CHANNEL, events)
  })
  core.startChangeWatcher(1000)
  createWindow()
}

// Set explicit userData path if VELMAYIL_DATA_DIR is not set
if (!process.env.VELMAYIL_DATA_DIR) {
  try {
    electronApp.setPath('userData', join(electronApp.getPath('appData'), 'VelmayilPOSData'))
  } catch (e) {
    logError('Error setting userData path', e)
  }
}

// Only one instance may own the SQLite database.
const gotLock = electronApp.requestSingleInstanceLock()
if (!gotLock) {
  electronApp.quit()
} else {
  electronApp.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  })
  electronApp.whenReady().then(bootstrap).catch((e) => {
    logError('failed to start:', e)
    dialog.showErrorBox('Velmayil POS failed to start', String((e as Error)?.stack ?? e))
    electronApp.exit(1)
  })
  electronApp.on('activate', () => core && BrowserWindow.getAllWindows().length === 0 && createWindow())
  electronApp.on('before-quit', shutdown)
  electronApp.on('will-quit', shutdown)
  electronApp.on('window-all-closed', () => {
    if (process.platform !== 'darwin') electronApp.quit()
  })
  process.on('uncaughtException', (e) => logError('uncaughtException', e))
  process.on('unhandledRejection', (e) => logError('unhandledRejection', e))
}

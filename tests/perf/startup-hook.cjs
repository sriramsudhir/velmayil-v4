// Preloaded into the Electron main process by startup-trace.mjs (electron -r). Logs slow top-level require() calls.
const Module = require('node:module')
const fs = require('node:fs')
const out = process.env.HOOK_OUT
const t00 = Date.now()
const orig = Module.prototype.require
let depth = 0
Module.prototype.require = function (id) {
  const t = performance.now()
  depth++
  try { return orig.apply(this, arguments) } finally {
    depth--
    const d = performance.now() - t
    if (depth === 0 && d > 15) fs.appendFileSync(out, `require(${id}) ${d.toFixed(0)}ms at +${Date.now() - t00}ms\n`)
  }
}
fs.appendFileSync(out, 'hook loaded uptime ' + Math.round(process.uptime() * 1000) + 'ms\n')
const { app } = require('electron')
app.on('ready', () => fs.appendFileSync(out, `app ready at uptime ${Math.round(process.uptime() * 1000)}ms (+${Date.now() - t00})\n`))
app.on('browser-window-created', () => fs.appendFileSync(out, `window created uptime ${Math.round(process.uptime() * 1000)}ms\n`))

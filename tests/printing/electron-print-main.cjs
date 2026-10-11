// Electron main script used by electron-print.test.ts (opt-in). For every *.html in the folder (named <tag>__<W>x<H>.html):
//  - prints it to PDF at the page size W x H mm exactly as the print adapter does and reports the page count and page box
//  - reports what Chromium computed for the print-darkness CSS (text stroke, logo filter, barcode / QR untouched)
//  - loads it in a preview frame (srcdoc iframe of the preview width) and reports whether the frame would scroll
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')
const dir = process.argv[process.argv.length - 2]
const outFile = process.argv[process.argv.length - 1]
app.on('window-all-closed', () => {})
process.on('uncaughtException', (e) => { fs.writeFileSync(outFile, JSON.stringify([{ file: 'ERROR', error: e.stack }])); process.exit(1) })
app.whenReady().then(async () => {
  const out = []
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.html'))) {
    const m = /__(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)(L?)\./.exec(f)
    const pw = Number(m[1]), ph = Number(m[2]), landscape = m[3] === 'L'
    const html = fs.readFileSync(path.join(dir, f), 'utf8')
    const win = new BrowserWindow({ show: false, width: 900, height: 1200, webPreferences: { sandbox: true } })
    await win.loadFile(path.join(dir, f))
    const css = await win.webContents.executeJavaScript(`(function(){
      var q = function(s){ return document.querySelector(s) }, cs = function(e){ return e ? getComputedStyle(e) : null };
      var text = q('.shop-name') || q('.pname') || q('p') || document.body, img = q('img.logo'), bar = q('svg.barcode rect:last-child') || q('svg.barcode rect'), bc = q('svg.barcode'), qr = q('svg.qr');
      return {
        strokePx: parseFloat(cs(text).webkitTextStrokeWidth), strokeColor: cs(text).webkitTextStrokeColor, textColor: cs(text).color,
        imgFilter: img ? cs(img).filter : null,
        barFilter: bc ? cs(bc).filter : null, barStroke: bar ? cs(bar).stroke : null, barFill: bar ? cs(bar).fill : null, barRendering: bc ? cs(bc).shapeRendering : null,
        qrFilter: qr ? cs(qr).filter : null,
        contentMm: Math.ceil(document.documentElement.scrollHeight) * 25.4 / 96
      }
    })()`)
    const h = ph > 0 ? ph : Math.max(30, Math.ceil(css.contentMm) + 4)
    const size = landscape ? { width: Math.min(pw, h) / 25.4, height: Math.max(pw, h) / 25.4 } : { width: pw / 25.4, height: h / 25.4 }
    const pdf = (await win.webContents.printToPDF({ printBackground: true, landscape, margins: { top: 0, bottom: 0, left: 0, right: 0 }, pageSize: size })).toString('latin1')
    const box = /\/MediaBox\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\]/.exec(pdf)
    win.destroy()

    // preview frame: the document as PrintPreview shows it (the test wrote the preview variant next to it as <name>.preview)
    let frame = null
    const pv = path.join(dir, f + '.preview')
    if (fs.existsSync(pv)) {
      const widthPx = Math.ceil(pw * 96 / 25.4 - 0.01)
      const host = new BrowserWindow({ show: false, width: 1000, height: 900, webPreferences: { sandbox: true } })
      await host.loadURL('data:text/html,<!doctype html><html><body style="margin:0"></body></html>')
      frame = await host.webContents.executeJavaScript(`new Promise(function(resolve){
        var f = document.createElement('iframe'); f.setAttribute('sandbox','allow-same-origin'); f.style.cssText = 'width:${widthPx}px;height:300px;border:0;display:block';
        f.onload = function(){ var d = f.contentDocument, de = d.documentElement; resolve({ framePx: ${widthPx}, clientWidth: de.clientWidth, scrollWidth: de.scrollWidth, bodyWidth: d.body.getBoundingClientRect().width, overflow: getComputedStyle(de).overflowY }) };
        f.srcdoc = ${JSON.stringify(fs.readFileSync(pv, 'utf8'))}; document.body.appendChild(f)
      })`)
      host.destroy()
    }
    out.push({ file: f, pages: (pdf.match(/\/Type\s*\/Page\b(?!s)/g) || []).length, boxMm: box ? [Math.round((Number(box[3]) / 72) * 25.4 * 10) / 10, Math.round((Number(box[4]) / 72) * 25.4 * 10) / 10] : null, css, frame, hasDarkness: html.includes('id="darkness"') })
  }
  fs.writeFileSync(outFile, JSON.stringify(out))
  app.exit(0)
})

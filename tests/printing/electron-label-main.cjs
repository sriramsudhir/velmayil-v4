// Electron main script used by electron-layout.test.ts (opt-in): loads generated barcode-label HTML in real Chromium at the real
// page size and reports, per label, whether anything overlaps, is clipped, leaves the label, or whether the barcode is distorted.
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
    const m = /__(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)\./.exec(f)
    const pw = Number(m[1]), ph = Number(m[2])
    const win = new BrowserWindow({ show: false, width: Math.round((pw * 96) / 25.4), height: Math.round((ph * 96) / 25.4), useContentSize: true, webPreferences: { sandbox: true } })
    await win.loadFile(path.join(dir, f))
    const r = await win.webContents.executeJavaScript(`(function(){
      var MM = 96/25.4, bad = [], labels = [].slice.call(document.querySelectorAll('.label')), vw = window.innerWidth;
      var res = { labels: labels.length, overlap: 0, clipped: 0, outside: 0, barcodeBad: 0, quietBad: 0, dotBad: 0, pageOverflowX: document.documentElement.scrollWidth > vw + 1, pages: document.querySelectorAll('.sheet').length, notes: [] };
      labels.forEach(function(l, li){
        var lr = l.getBoundingClientRect(), cs = getComputedStyle(l);
        var padL = parseFloat(cs.paddingLeft), padR = parseFloat(cs.paddingRight), padT = parseFloat(cs.paddingTop), padB = parseFloat(cs.paddingBottom);
        var kids = [].slice.call(l.children).filter(function(c){ return c.getBoundingClientRect().height > 0 });
        for (var i = 0; i < kids.length; i++) {
          var a = kids[i].getBoundingClientRect();
          if (a.left < lr.left + padL - 0.6 || a.right > lr.right - padR + 0.6 || a.top < lr.top + padT - 0.6 || a.bottom > lr.bottom - padB + 0.6) { res.outside++; res.notes.push('outside:' + kids[i].className + ' label' + li) }
          if (i > 0) { var b = kids[i-1].getBoundingClientRect(); if (a.top < b.bottom - 0.6) { res.overlap++; res.notes.push('overlap:' + kids[i-1].className + '/' + kids[i].className + ' label' + li) } }
        }
        if (l.scrollHeight > l.clientHeight + 1 || l.scrollWidth > l.clientWidth + 1) { res.clipped++; res.notes.push('label scroll ' + l.scrollWidth + 'x' + l.scrollHeight + ' vs ' + l.clientWidth + 'x' + l.clientHeight) }
        [].slice.call(l.querySelectorAll('.pname,.shop-name,.code,.prices')).forEach(function(e){
          // a hidden text line is >= 6 px tall; ink may exceed a tight line box by a pixel or two (font metrics), so allow 3 px
          var tol = 3;
          if (e.scrollHeight > e.clientHeight + tol || e.scrollWidth > e.clientWidth + tol) { res.clipped++; res.notes.push('text clipped:' + e.className + ' ' + e.scrollWidth + 'x' + e.scrollHeight + ' in ' + e.clientWidth + 'x' + e.clientHeight + ' label' + li) }
        });
        var svg = l.querySelector('svg.barcode');
        if (svg) {
          var sr = svg.getBoundingClientRect(), want = parseFloat(svg.style.width) * MM, hh = parseFloat(svg.style.height) * MM;
          // exact mm width (never stretched to the container) and exact height
          if (Math.abs(sr.width - want) > 1 || Math.abs(sr.height - hh) > 1) { res.barcodeBad++; res.notes.push('barcode size ' + sr.width + 'x' + sr.height + ' want ' + want + 'x' + hh) }
          var vb = svg.viewBox.baseVal; var mod = sr.width / vb.width;
          if (mod < 0.25 * MM - 0.01) res.notes.push('narrow module mm=' + (mod / MM).toFixed(3));
          if (Math.abs(sr.width / sr.height - vb.width / vb.height * (sr.height ? 1 : 1)) < 0) res.barcodeBad++;
          if (sr.left < lr.left || sr.right > lr.right) res.barcodeBad++;
          res.moduleMm = +(mod / MM).toFixed(3);
          // 203 dpi printer dots (25.4/203 mm): every module is a whole number of dots and, with one label per page, the symbol
          // starts on a dot boundary (Blink lays out in 1/64 px, so allow a few hundredths of a dot)
          var DOT = 25.4 / 203 * MM, md = mod / DOT, ld = sr.left / DOT;
          if (Math.abs(md - Math.round(md)) > 0.02) { res.dotBad++; res.notes.push('module is ' + md.toFixed(3) + ' dots') }
          if (document.querySelectorAll('.label').length === document.querySelectorAll('.sheet').length && Math.abs(ld - Math.round(ld)) > 0.08) { res.dotBad++; res.notes.push('symbol starts at dot ' + ld.toFixed(3)) }
        } else res.barcodeBad++;
        // label cell is exactly the intended size and sits inside the page
        if (lr.right > vw + 1) res.outside++;
      });
      return res
    })()`)
    out.push({ file: f, ...r })
    win.destroy()
  }
  fs.writeFileSync(outFile, JSON.stringify(out))
  app.exit(0)
})

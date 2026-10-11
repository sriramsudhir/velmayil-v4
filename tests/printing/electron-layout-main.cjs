// Electron main script used by electron-layout.test.ts (opt-in). Loads generated print HTML in a real Chromium page at the
// real paper width and reports horizontal overflow / overlap of the shop name with the logo / clipped text.
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
    const kind = f.split('__')[0]
    const w = kind === 'receipt58' ? 58 : kind === 'receipt80' ? 80 : kind === 'invoiceA4' ? 210 : 148
    const win = new BrowserWindow({ show: false, width: Math.round((w * 96) / 25.4), height: 900, useContentSize: true, webPreferences: { sandbox: true } })
    await win.loadFile(path.join(dir, f))
    const r = await win.webContents.executeJavaScript(`(function(){
      var de=document.documentElement, vw=window.innerWidth;
      var logo=document.querySelector('img.logo'), name=document.querySelector('.shop-name');
      var nr=name.getBoundingClientRect(), lr=logo?logo.getBoundingClientRect():null;
      var overlap = lr && !(nr.right<=lr.left+0.5||nr.left>=lr.right-0.5||nr.bottom<=lr.top+0.5||nr.top>=lr.bottom-0.5);
      var all=[].slice.call(document.querySelectorAll('.shop-name,.legal,.addr,.iname'));
      var clipped=all.filter(function(e){return e.scrollWidth>e.clientWidth+1}).length;
      var outside=[].slice.call(document.querySelectorAll('body *')).filter(function(e){var b=e.getBoundingClientRect();return b.right>vw+1&&b.width>0}).length;
      var want=logo?parseFloat(logo.style.width)*96/25.4:0; var ratioOk=logo?Math.abs((lr.height/lr.width)-(logo.naturalHeight/logo.naturalWidth))<0.01:true; return {overflowX:de.scrollWidth>vw+1, overlap:!!overlap, clipped:clipped, outside:outside, nameH:Math.round(nr.height), logoOk: logo?Math.abs(lr.width-want)<1.5:true, logoW:logo?Math.round(lr.width):0, ratioOk:ratioOk, lw:logo?lr.width:0, lh:logo?lr.height:0}
    })()`)
    out.push({ file: f, ...r })
    win.destroy()
  }
  fs.writeFileSync(outFile, JSON.stringify(out))
  app.exit(0)
})

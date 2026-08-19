// Electron-backed renderer for build.py, used when Google Chrome is absent.
// Chromium either way; Electron is already a dependency, Chrome is not.
//
// Usage: electron render.js <input.html> <output.png> <width> <height>
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')

const [input, output, width, height] = process.argv.slice(2)

app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: Number(width),
    height: Number(height),
    useContentSize: true,
    show: false,
    frame: false,
    backgroundColor: '#0a0a0a',
    webPreferences: { offscreen: true, deviceScaleFactor: 1 },
  })

  await win.loadFile(path.resolve(input))
  // Webfonts and the base64 screenshot both resolve after load fires.
  await win.webContents.executeJavaScript(
    'document.fonts.ready.then(() => new Promise((r) => setTimeout(r, 400)))'
  )

  // On a Retina display the capture comes back at 2x; downscaling to the
  // requested size supersamples the text rather than merely shrinking it.
  const image = await win.webContents.capturePage()
  const sized = image.resize({
    width: Number(width),
    height: Number(height),
    quality: 'best',
  })
  fs.writeFileSync(path.resolve(output), sized.toPNG())
  app.exit(0)
})

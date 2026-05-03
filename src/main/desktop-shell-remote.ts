// Electron remote-mode shell.
//
// When `HARNESS_REMOTE_URL` is set, src/main/index.ts hands off to this
// module instead of constructing the local backend. The renderer
// connects to a remote harness-server over WebSocket (see
// src/preload/index.ts: when --harness-remote-url= is in argv it swaps
// in WebSocketClientTransport), so locally we only need to:
//   - Open a BrowserWindow pointing at the regular renderer entry.
//   - Pass the remote URL to the preload via webPreferences.additionalArguments.
//   - Build a slimmed-down menu (the full menu's "Settings…",
//     "Performance Monitor", etc. items send signals through the local
//     transport, which doesn't exist here).
//   - Run the auto-updater so Harness itself can update without the
//     user reaching for the App Store.
//
// We deliberately do NOT spin up: the store, PtyManager, JsonClaudeManager,
// transports, IPC handlers, PR poller, FSMs, control server, or
// activity deriver. Those services all live on the remote backend now.
// Reconnection on disconnect and saved-remote management are out of
// scope for v1 — restart the app to pick a new URL.

import { app, autoUpdater as nativeAutoUpdater, BrowserWindow, Menu, screen, shell } from 'electron'
import { autoUpdater } from 'electron-updater'
import { join } from 'path'
import { applyDevModeOverride } from './desktop-shell'
import { log, getLogFilePath } from './debug'

export function bootRemote(remoteUrl: string): void {
  // Same dev-mode userData split the desktop shell uses, so a dev
  // remote-mode session writes its debug.log + log files into the
  // Harness (Dev) folder instead of fighting the installed prod app.
  applyDevModeOverride()

  log('app', `remote mode boot, target: ${redactToken(remoteUrl)}`)

  function createRemoteWindow(): BrowserWindow {
    const work = screen.getPrimaryDisplay().workAreaSize
    const win = new BrowserWindow({
      width: Math.min(1600, work.width - 40),
      height: Math.min(1000, work.height - 40),
      title: 'Harness',
      icon: join(__dirname, '../../resources/icon.png'),
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 12, y: 12 },
      backgroundColor: '#0a0a0a',
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // The preload reads this back via process.argv to decide
        // whether to construct WebSocketClientTransport instead of
        // ElectronClientTransport. Keep the flag-name in sync with
        // src/preload/find-remote-url.ts.
        additionalArguments: [`--harness-remote-url=${remoteUrl}`]
      }
    })

    win.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('mailto:')) {
        shell.openExternal(url)
      }
      return { action: 'deny' }
    })

    win.webContents.on('console-message', (_event, level, message) => {
      const levelName = ['verbose', 'info', 'warn', 'error'][level] || 'log'
      log('renderer', `[remote win${win.id}] [${levelName}] ${message}`)
    })

    if (process.env['ELECTRON_RENDERER_URL']) {
      win.loadURL(process.env['ELECTRON_RENDERER_URL'])
    } else {
      win.loadFile(join(__dirname, '../renderer/index.html'))
    }

    return win
  }

  function buildRemoteMenu(): void {
    // Slimmed from desktop-shell.ts: every item that called
    // `transport.sendSignal(...)` has been dropped (no transport in
    // remote mode). The remaining roles are pure OS-level affordances
    // (cut/copy/paste, reload, devtools, etc.) plus a debug-log opener.
    const template: Electron.MenuItemConstructorOptions[] = [
      {
        label: app.name,
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' }
        ]
      },
      {
        label: 'File',
        submenu: [
          {
            label: 'New Window',
            accelerator: 'CmdOrCtrl+Shift+N',
            click: () => createRemoteWindow()
          },
          { role: 'close' }
        ]
      },
      {
        label: 'Edit',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'selectAll' }
        ]
      },
      {
        label: 'View',
        submenu: [
          { role: 'reload' },
          { role: 'forceReload' },
          { role: 'toggleDevTools' },
          { type: 'separator' },
          { role: 'togglefullscreen' }
        ]
      },
      {
        label: 'Window',
        submenu: [
          { role: 'minimize' },
          { role: 'zoom' },
          { type: 'separator' },
          { role: 'front' }
        ]
      },
      {
        label: 'Help',
        submenu: [
          {
            label: 'Debug: Open Local Debug Log',
            click: () => {
              void shell.openPath(getLogFilePath())
            }
          }
        ]
      }
    ]
    Menu.setApplicationMenu(Menu.buildFromTemplate(template))
  }

  function setupAutoUpdater(): void {
    if (!app.isPackaged) return

    autoUpdater.logger = {
      info: (msg: string) => log('updater', msg),
      warn: (msg: string) => log('updater', `[warn] ${msg}`),
      error: (msg: string) => log('updater', `[error] ${msg}`),
      debug: () => {}
    }

    autoUpdater.on('error', (err) => log('updater', 'error', err.message))
    autoUpdater.on('update-downloaded', (info) =>
      log('updater', 'update downloaded', info.version)
    )

    if (process.platform === 'darwin') {
      nativeAutoUpdater.on('error', (err) => {
        log('updater', `[error] Squirrel.Mac: ${err.message}`)
      })
    }

    autoUpdater.checkForUpdates().catch((err) => log('updater', 'check failed', err.message))
    setInterval(() => {
      autoUpdater.checkForUpdates().catch(() => {})
    }, 10 * 60 * 1000)
  }

  app.whenReady().then(() => {
    if (process.platform === 'darwin' && app.dock) {
      try {
        app.dock.setIcon(join(__dirname, '../../resources/icon.png'))
      } catch (err) {
        log('app', 'failed to set dock icon', err instanceof Error ? err.message : err)
      }
    }
    buildRemoteMenu()
    createRemoteWindow()
    setupAutoUpdater()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createRemoteWindow()
      }
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })
}

/** Replace the `?token=...` query value with `***` so debug logs don't
 *  leak the shared secret. The full token still lives in the env var
 *  the user invoked the app with — this just keeps it out of the
 *  rolling debug.log. */
function redactToken(rawUrl: string): string {
  try {
    const u = new URL(rawUrl)
    if (u.searchParams.has('token')) u.searchParams.set('token', '***')
    return u.toString()
  } catch {
    return rawUrl
  }
}

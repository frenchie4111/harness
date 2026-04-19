// Electron desktop shell.
//
// Everything in this file is Electron-only — BrowserWindow, dialog, Menu,
// the WebContentsView-backed BrowserManager, electron-updater, the IPC
// handlers that touch any of those. index.ts loads this module via a
// runtime require under `if (runtime === 'electron')`, so the headless
// build never pulls electron through this path.
//
// The split with index.ts:
//   - index.ts owns the mode-agnostic boot — store construction, FSMs,
//     PTY manager, WS transport, control server, hook installer, the
//     bulk of the IPC handler registrations.
//   - This file owns the desktop window + menu, the BrowserManager
//     (WebContentsView), the auto-updater, and the small set of IPC
//     handlers that are inherently desktop-bound (native folder picker,
//     `BrowserWindow`-aware browser:setBounds, updater RPCs).
//
// Construction split:
//   - `createDesktopShell` runs synchronously, before anything that
//     reads `userDataDir()` is touched. It applies the dev-mode userData
//     override (so persistence/secrets/debug all see "Harness (Dev)"),
//     creates the BrowserManager, and wires the ElectronServerTransport.
//   - `startDesktopShell` is called after index.ts has registered all
//     mode-agnostic IPC handlers. It registers the desktop-only
//     handlers, builds the menu, opens the first window, kicks off the
//     auto-updater, and hands back lifecycle hooks (start/stop auto
//     update checks) for the few shared handlers that need to call into
//     the desktop side.

import { app, autoUpdater as nativeAutoUpdater, BrowserWindow, dialog, Menu, screen, shell } from 'electron'
import { autoUpdater } from 'electron-updater'
import { join } from 'path'
import { BrowserManager } from './browser-manager'
import { ElectronServerTransport } from './transport-electron'
import type { Store } from './store'
import type { PerfMonitor } from './perf-monitor'
import type { CompoundServerTransport } from './transport-compound'
import type { PtyManager } from './pty-manager'
import type { WorktreesFSM } from './worktrees-fsm'
import type { Config } from './persistence'
import { saveConfig, saveConfigSync, DEFAULT_THEME, THEME_APP_BG } from './persistence'
import { loadRepoConfig } from './repo-config'
import { sealAllActive } from './activity'
import { log } from './debug'

export interface DesktopShellInit {
  store: Store
  perfMonitor: PerfMonitor
  /** Mutable config object — saveBounds writes into it directly. */
  config: Config
}

export interface DesktopShellEarlyHandle {
  browserManager: BrowserManager
  transport: ElectronServerTransport
}

/** Where the web-client bundle lives at runtime. Differs between
 *  packaged builds (asar-relative) and dev / unpacked (sibling of the
 *  main bundle output). Lives here so index.ts doesn't need to call
 *  `app.getAppPath()` directly. */
export function resolveWebClientDir(): string {
  return app.isPackaged
    ? join(app.getAppPath(), 'out/web-client')
    : join(__dirname, '../web-client')
}

/** First call. Applies the dev-mode userData override before anything in
 *  main reads paths, then constructs the BrowserManager + Electron
 *  transport that index.ts wires into the compound transport. */
export function createDesktopShell(init: DesktopShellInit): DesktopShellEarlyHandle {
  // Dev mode uses a sibling userData dir so a running dev instance doesn't
  // fight with the installed prod app over config.json / activity.json /
  // etc. Must run before any module reads userDataDir(); index.ts calls
  // this before loadConfig().
  if (!app.isPackaged) {
    app.setPath('userData', join(app.getPath('appData'), 'Harness (Dev)'))
  }
  const browserManager = new BrowserManager()
  const transport = new ElectronServerTransport(init.store, init.perfMonitor)
  return { browserManager, transport }
}

export interface DesktopShellStartDeps {
  store: Store
  transport: CompoundServerTransport
  ptyManager: PtyManager
  browserManager: BrowserManager
  worktreesFSM: WorktreesFSM
  config: Config
  /** Async boot work that runs inside app.whenReady — restoring panes,
   *  starting pollers, etc. Owned by index.ts because most of it is
   *  mode-agnostic. */
  runBoot: () => Promise<void> | void
  /** Reference held by index.ts so its handlers can stop the watcher
   *  during quitAndInstall. */
  getStopWatchingStatus: () => (() => void) | null
  setStopWatchingStatus: (next: (() => void) | null) => void
  /** index.ts owns the loaded RepoConfig dispatch path; we need to fire
   *  it for any folder added via the native picker. */
  onRepoAdded: (repoRoot: string) => void
}

export interface DesktopShellStartHandle {
  startAutoUpdateChecks: () => void
  stopAutoUpdateChecks: () => void
}

/** Second call. After index.ts has wired its mode-agnostic IPC handlers,
 *  this hooks app lifecycle, builds the menu, opens the first window,
 *  registers the desktop-only IPC handlers, and starts the auto-updater. */
export function startDesktopShell(deps: DesktopShellStartDeps): DesktopShellStartHandle {
  const {
    store,
    transport,
    ptyManager,
    browserManager,
    worktreesFSM,
    config,
    runBoot,
    getStopWatchingStatus,
    setStopWatchingStatus,
    onRepoAdded
  } = deps

  registerDesktopHandlers()

  let autoUpdateTimer: NodeJS.Timeout | null = null

  function startAutoUpdateChecks(): void {
    if (!app.isPackaged) return
    if (config.autoUpdateEnabled === false) return
    if (autoUpdateTimer) return
    // Check on startup, then every 10 minutes. We use checkForUpdates (not
    // checkForUpdatesAndNotify) so there's no native OS notification — the
    // renderer shows an in-app banner based on the updater:status events.
    autoUpdater.checkForUpdates().catch((err) => log('updater', 'check failed', err.message))
    autoUpdateTimer = setInterval(() => {
      autoUpdater.checkForUpdates().catch(() => {})
    }, 10 * 60 * 1000)
  }

  function stopAutoUpdateChecks(): void {
    if (autoUpdateTimer) {
      clearInterval(autoUpdateTimer)
      autoUpdateTimer = null
    }
  }

  function setupAutoUpdater(): void {
    if (!app.isPackaged) return // No-op in dev

    autoUpdater.logger = {
      info: (msg: string) => log('updater', msg),
      warn: (msg: string) => log('updater', `[warn] ${msg}`),
      error: (msg: string) => log('updater', `[error] ${msg}`),
      debug: () => {}
    }

    autoUpdater.on('checking-for-update', () => {
      log('updater', 'checking for update')
      store.dispatch({ type: 'updater/statusChanged', payload: { state: 'checking' } })
    })
    autoUpdater.on('update-available', (info) => {
      log('updater', 'update available', info.version)
      store.dispatch({
        type: 'updater/statusChanged',
        payload: { state: 'available', version: info.version }
      })
    })
    autoUpdater.on('update-not-available', () => {
      log('updater', 'no update available')
      store.dispatch({
        type: 'updater/statusChanged',
        payload: { state: 'not-available' }
      })
    })
    autoUpdater.on('error', (err) => {
      log('updater', 'error', err.message)
      store.dispatch({
        type: 'updater/statusChanged',
        payload: { state: 'error', error: err.message }
      })
    })
    autoUpdater.on('download-progress', (p) => {
      store.dispatch({
        type: 'updater/statusChanged',
        payload: { state: 'downloading', percent: p.percent }
      })
    })
    autoUpdater.on('update-downloaded', (info) => {
      log('updater', 'update downloaded', info.version)
      store.dispatch({
        type: 'updater/statusChanged',
        payload: { state: 'downloaded', version: info.version }
      })
    })

    if (process.platform === 'darwin') {
      nativeAutoUpdater.on('error', (err) => {
        log('updater', `[error] Squirrel.Mac: ${err.message}`)
      })
    }

    startAutoUpdateChecks()
  }

  function createWindow(): BrowserWindow {
    // First-launch defaults: aim for 1600x1000, but clamp to the primary
    // display's work area so smaller screens (13" MBP = 1440x900 native)
    // don't get a window that spills off-screen. Returning users' saved
    // windowBounds pass through untouched.
    const work = screen.getPrimaryDisplay().workAreaSize
    const bounds = config.windowBounds || {
      width: Math.min(1600, work.width - 40),
      height: Math.min(1000, work.height - 40),
      x: undefined!,
      y: undefined!
    }

    const win = new BrowserWindow({
      width: bounds.width,
      height: bounds.height,
      ...(bounds.x != null ? { x: bounds.x, y: bounds.y } : {}),
      title: 'Harness',
      icon: join(__dirname, '../../resources/icon.png'),
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 12, y: 12 },
      backgroundColor: THEME_APP_BG[config.theme || DEFAULT_THEME] || THEME_APP_BG[DEFAULT_THEME],
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
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
      log('renderer', `[win${win.id}] [${levelName}] ${message}`)
    })

    const saveBounds = (): void => {
      if (win.isDestroyed()) return
      config.windowBounds = win.getBounds()
      saveConfig(config)
    }
    win.on('resize', saveBounds)
    win.on('move', saveBounds)

    if (process.env['ELECTRON_RENDERER_URL']) {
      win.loadURL(process.env['ELECTRON_RENDERER_URL'])
    } else {
      win.loadFile(join(__dirname, '../renderer/index.html'))
    }

    return win
  }

  function buildMenu(): void {
    const template: Electron.MenuItemConstructorOptions[] = [
      {
        label: app.name,
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          {
            label: 'Settings…',
            accelerator: 'CmdOrCtrl+,',
            click: () => transport.sendSignal('app:openSettings')
          },
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
            label: 'New Project…',
            accelerator: 'CmdOrCtrl+N',
            click: () => transport.sendSignal('menu:newProject')
          },
          {
            label: 'New Window',
            accelerator: 'CmdOrCtrl+Shift+N',
            click: () => createWindow()
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
          { role: 'togglefullscreen' },
          { type: 'separator' },
          {
            label: 'Performance Monitor',
            accelerator: 'CmdOrCtrl+Shift+D',
            click: () => transport.sendSignal('app:togglePerfMonitor')
          }
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
            label: 'Keyboard Shortcuts',
            click: () => transport.sendSignal('app:openKeyboardShortcuts')
          },
          { type: 'separator' },
          {
            label: 'Report an Issue…',
            click: () => transport.sendSignal('app:openReportIssue')
          },
          { type: 'separator' },
          {
            label: 'Debug: Crash Focused Tab',
            click: () => transport.sendSignal('app:debugCrashFocusedTab')
          }
        ]
      }
    ]
    Menu.setApplicationMenu(Menu.buildFromTemplate(template))
  }

  function registerDesktopHandlers(): void {
    transport.onRequest('repo:add', async (_ctx) => {
      const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
      const result = await dialog.showOpenDialog(win!, {
        properties: ['openDirectory'],
        title: 'Open Git Repository'
      })
      if (result.canceled || result.filePaths.length === 0) return null
      const repoRoot = result.filePaths[0]
      if (!config.repoRoots.includes(repoRoot)) {
        config.repoRoots.push(repoRoot)
        saveConfig(config)
        worktreesFSM.dispatchRepos([...config.repoRoots])
        store.dispatch({
          type: 'repoConfigs/changed',
          payload: { repoRoot, config: loadRepoConfig(repoRoot) }
        })
        onRepoAdded(repoRoot)
      }
      return repoRoot
    })

    transport.onRequest(
      'dialog:pickDirectory',
      async (_ctx, opts?: { defaultPath?: string; title?: string }) => {
        const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
        const result = await dialog.showOpenDialog(win!, {
          properties: ['openDirectory', 'createDirectory'],
          defaultPath: opts?.defaultPath,
          title: opts?.title ?? 'Pick a folder'
        })
        if (result.canceled || result.filePaths.length === 0) return null
        return result.filePaths[0]
      }
    )

    transport.onRequest('updater:getVersion', (_ctx) => {
      return app.getVersion()
    })

    transport.onRequest('updater:checkForUpdates', async (_ctx) => {
      if (!app.isPackaged) {
        return { ok: false, error: 'Updates are only available in packaged builds' }
      }
      try {
        const result = await autoUpdater.checkForUpdates()
        if (!result) {
          store.dispatch({
            type: 'updater/statusChanged',
            payload: { state: 'not-available' }
          })
          return { ok: true, available: false }
        }
        const updateInfo = result.updateInfo
        const current = app.getVersion()
        return {
          ok: true,
          available: updateInfo.version !== current,
          version: updateInfo.version,
          releaseDate: updateInfo.releaseDate
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        store.dispatch({
          type: 'updater/statusChanged',
          payload: { state: 'error', error: message }
        })
        return { ok: false, error: message }
      }
    })

    transport.onRequest('updater:quitAndInstall', (_ctx) => {
      log('updater', 'quitAndInstall requested — tearing down before handing off to Squirrel')
      try {
        getStopWatchingStatus()?.()
        setStopWatchingStatus(null)
      } catch (err) {
        log('updater', 'stopWatchingStatus failed', err instanceof Error ? err.message : String(err))
      }
      try {
        ptyManager.killAll('SIGKILL')
      } catch (err) {
        log('updater', 'ptyManager.killAll failed', err instanceof Error ? err.message : String(err))
      }
      try {
        sealAllActive()
        saveConfigSync(config)
      } catch (err) {
        log('updater', 'final persistence failed', err instanceof Error ? err.message : String(err))
      }

      app.removeAllListeners('before-quit')
      autoUpdater.quitAndInstall(true, true)
      return true
    })

    transport.onSignal('shell:openExternal', (_ctx, url: string) => {
      shell.openExternal(url)
    })

    transport.onSignal(
      'browser:setBounds',
      (_ctx, tabId: string, bounds: { x: number; y: number; width: number; height: number } | null) => {
        if (!bounds) {
          browserManager.hide(tabId)
          return
        }
        const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
        if (!win) return
        browserManager.setBounds(tabId, win, bounds)
      }
    )
  }

  app.whenReady().then(() => {
    if (process.platform === 'darwin' && app.dock) {
      try {
        app.dock.setIcon(join(__dirname, '../../resources/icon.png'))
      } catch (err) {
        log('app', 'failed to set dock icon', err instanceof Error ? err.message : err)
      }
    }
    buildMenu()
    void runBoot()
    createWindow()
    setupAutoUpdater()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow()
      }
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })

  app.on('before-quit', () => {
    getStopWatchingStatus()?.()
    setStopWatchingStatus(null)
    ptyManager.killAll('SIGKILL')
    browserManager.destroyAll()
    sealAllActive()
    saveConfigSync(config)
  })

  return {
    startAutoUpdateChecks,
    stopAutoUpdateChecks
  }
}

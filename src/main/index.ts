import { app, BrowserWindow, ipcMain, dialog, Menu, shell } from 'electron'
import { autoUpdater } from 'electron-updater'
import { join } from 'path'
import { PtyManager } from './pty-manager'
import { listWorktrees, listBranches, addWorktree, removeWorktree, isWorktreeDirty, defaultWorktreeDir, getChangedFiles, getFileDiff } from './worktree'
import { getPRStatus, testToken } from './github'
import { setSecret, hasSecret, deleteSecret } from './secrets'
import { loadConfig, saveConfig, saveConfigSync } from './persistence'
import { hooksInstalled, installHooks, watchStatusDir } from './hooks'
import { log, getLogFilePath } from './debug'

const ptyManager = new PtyManager()
let config = loadConfig()
let stopWatchingStatus: (() => void) | null = null

// Track repo root per window
const windowRepoRoots = new Map<number, string>()

function getWindowFromEvent(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender)
}

function createWindow(repoRoot?: string): BrowserWindow {
  const bounds = config.windowBounds || { width: 1400, height: 900, x: undefined!, y: undefined! }

  const win = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    ...(bounds.x != null ? { x: bounds.x, y: bounds.y } : {}),
    title: 'Harness',
    icon: join(__dirname, '../../resources/icon.png'),
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 12, y: 12 },
    backgroundColor: '#0a0a0a',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  if (repoRoot) {
    windowRepoRoots.set(win.id, repoRoot)
  }

  // Forward renderer console logs to debug log
  win.webContents.on('console-message', (_event, level, message) => {
    const levelName = ['verbose', 'info', 'warn', 'error'][level] || 'log'
    log('renderer', `[win${win.id}] [${levelName}] ${message}`)
  })

  // Save window bounds on move/resize
  const saveBounds = (): void => {
    if (win.isDestroyed()) return
    config.windowBounds = win.getBounds()
    saveConfig(config)
  }
  win.on('resize', saveBounds)
  win.on('move', saveBounds)

  win.on('closed', () => {
    windowRepoRoots.delete(win.id)
  })

  // Load renderer
  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

function registerIpcHandlers(): void {
  // Worktree handlers — scoped to the calling window's repo root
  ipcMain.handle('worktree:list', async (event) => {
    const win = getWindowFromEvent(event)
    const repoRoot = win ? windowRepoRoots.get(win.id) : null
    if (!repoRoot) return []
    return listWorktrees(repoRoot)
  })

  ipcMain.handle('worktree:branches', async (event) => {
    const win = getWindowFromEvent(event)
    const repoRoot = win ? windowRepoRoots.get(win.id) : null
    if (!repoRoot) return []
    return listBranches(repoRoot)
  })

  ipcMain.handle('worktree:add', async (event, branchName: string, baseBranch?: string) => {
    const win = getWindowFromEvent(event)
    const repoRoot = win ? windowRepoRoots.get(win.id) : null
    if (!repoRoot) throw new Error('No repo root configured')
    const wtDir = defaultWorktreeDir(repoRoot)
    return addWorktree(repoRoot, wtDir, branchName, baseBranch)
  })

  ipcMain.handle('worktree:isDirty', async (_, path: string) => {
    return isWorktreeDirty(path)
  })

  ipcMain.handle('worktree:remove', async (event, path: string, force?: boolean) => {
    const win = getWindowFromEvent(event)
    const repoRoot = win ? windowRepoRoots.get(win.id) : null
    if (!repoRoot) throw new Error('No repo root configured')
    return removeWorktree(repoRoot, path, force)
  })

  ipcMain.handle('worktree:dir', async (event) => {
    const win = getWindowFromEvent(event)
    const repoRoot = win ? windowRepoRoots.get(win.id) : null
    if (!repoRoot) return ''
    return defaultWorktreeDir(repoRoot)
  })

  ipcMain.handle('repo:select', async (event) => {
    const win = getWindowFromEvent(event)
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
      title: 'Select Git Repository Root'
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const repoRoot = result.filePaths[0]
    windowRepoRoots.set(win.id, repoRoot)
    // Track in config for reopening
    if (!config.repoRoots.includes(repoRoot)) {
      config.repoRoots.push(repoRoot)
      saveConfig(config)
    }
    return repoRoot
  })

  ipcMain.handle('repo:getRoot', (event) => {
    const win = getWindowFromEvent(event)
    return win ? windowRepoRoots.get(win.id) || null : null
  })

  // Changed files
  ipcMain.handle('worktree:changedFiles', async (_, worktreePath: string) => {
    return getChangedFiles(worktreePath)
  })

  ipcMain.handle('worktree:fileDiff', async (_, worktreePath: string, filePath: string, staged: boolean) => {
    return getFileDiff(worktreePath, filePath, staged)
  })

  ipcMain.handle('worktree:prStatus', async (_, worktreePath: string) => {
    return getPRStatus(worktreePath)
  })


  // Config
  ipcMain.handle('config:getHotkeys', () => {
    return config.hotkeys || null
  })

  // Settings: GitHub token
  ipcMain.handle('settings:hasGithubToken', () => {
    return hasSecret('githubToken')
  })

  ipcMain.handle('settings:setGithubToken', async (_, token: string) => {
    const trimmed = token.trim()
    if (!trimmed) {
      deleteSecret('githubToken')
      return { ok: true }
    }
    // Validate the token first by hitting /user
    const test = await testToken(trimmed)
    if (!test.ok) return { ok: false, error: test.error }
    setSecret('githubToken', trimmed)
    return { ok: true, username: test.username }
  })

  ipcMain.handle('settings:clearGithubToken', () => {
    deleteSecret('githubToken')
    return true
  })

  // Hooks
  ipcMain.handle('hooks:check', (_, worktreePath: string) => {
    return hooksInstalled(worktreePath)
  })

  ipcMain.handle('hooks:install', async (_, worktreePath: string) => {
    installHooks(worktreePath)
    return true
  })

  // Shell
  ipcMain.on('shell:openExternal', (_, url: string) => {
    shell.openExternal(url)
  })

  // PTY handlers — route to the calling window
  ipcMain.on('pty:create', (event, id: string, cwd: string, cmd: string, args: string[]) => {
    const win = getWindowFromEvent(event)
    if (win) ptyManager.create(id, cwd, cmd, args, win)
  })

  ipcMain.on('pty:write', (_, id: string, data: string) => {
    ptyManager.write(id, data)
  })

  ipcMain.on('pty:resize', (_, id: string, cols: number, rows: number) => {
    ptyManager.resize(id, cols, rows)
  })

  ipcMain.on('pty:kill', (_, id: string) => {
    ptyManager.kill(id)
  })
}

function buildMenu(): void {
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
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function setupAutoUpdater(): void {
  if (!app.isPackaged) return // No-op in dev

  autoUpdater.logger = {
    info: (msg: string) => log('updater', msg),
    warn: (msg: string) => log('updater', `[warn] ${msg}`),
    error: (msg: string) => log('updater', `[error] ${msg}`),
    debug: () => {}
  } as Electron.Logger

  autoUpdater.on('checking-for-update', () => log('updater', 'checking for update'))
  autoUpdater.on('update-available', (info) => log('updater', 'update available', info.version))
  autoUpdater.on('update-not-available', () => log('updater', 'no update available'))
  autoUpdater.on('error', (err) => log('updater', 'error', err.message))
  autoUpdater.on('download-progress', (p) => log('updater', `downloading ${Math.round(p.percent)}%`))
  autoUpdater.on('update-downloaded', (info) => {
    log('updater', 'update downloaded', info.version)
    // Prompt the user to install
    dialog.showMessageBox({
      type: 'info',
      buttons: ['Restart Now', 'Later'],
      defaultId: 0,
      title: 'Update Available',
      message: `Harness ${info.version} has been downloaded.`,
      detail: 'Restart the app to apply the update.'
    }).then((result) => {
      if (result.response === 0) autoUpdater.quitAndInstall()
    })
  })

  // Check on startup, then every hour
  autoUpdater.checkForUpdatesAndNotify().catch((err) => log('updater', 'check failed', err.message))
  setInterval(() => {
    autoUpdater.checkForUpdatesAndNotify().catch(() => {})
  }, 60 * 60 * 1000)
}

app.whenReady().then(() => {
  log('app', `started, log file: ${getLogFilePath()}`)

  // Set dock icon (macOS dev mode — packaged builds use the .icns from the app bundle)
  if (process.platform === 'darwin' && app.dock) {
    try {
      app.dock.setIcon(join(__dirname, '../../resources/icon.png'))
    } catch (err) {
      log('app', 'failed to set dock icon', err instanceof Error ? err.message : err)
    }
  }

  buildMenu()
  registerIpcHandlers()

  // Watch status dir globally — route to correct window via ptyManager
  stopWatchingStatus = watchStatusDir((id) => ptyManager.getWindowForTerminal(id))

  // Open a window for each saved repo root, or one empty window
  if (config.repoRoots.length > 0) {
    for (const root of config.repoRoots) {
      createWindow(root)
    }
  } else {
    createWindow()
  }

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
  stopWatchingStatus?.()
  ptyManager.killAll()
  saveConfigSync(config)
})

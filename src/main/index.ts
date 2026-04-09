import { app, BrowserWindow, ipcMain, dialog, Menu } from 'electron'
import { join } from 'path'
import { PtyManager } from './pty-manager'
import { listWorktrees, addWorktree, removeWorktree } from './worktree'
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
    title: 'Claude Harness',
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

  ipcMain.handle('worktree:add', async (event, name: string) => {
    const win = getWindowFromEvent(event)
    const repoRoot = win ? windowRepoRoots.get(win.id) : null
    if (!repoRoot) throw new Error('No repo root configured')
    return addWorktree(repoRoot, name)
  })

  ipcMain.handle('worktree:remove', async (event, path: string) => {
    const win = getWindowFromEvent(event)
    const repoRoot = win ? windowRepoRoots.get(win.id) : null
    if (!repoRoot) throw new Error('No repo root configured')
    return removeWorktree(repoRoot, path)
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

  // Hooks
  ipcMain.handle('hooks:check', (_, worktreePath: string) => {
    return hooksInstalled(worktreePath)
  })

  ipcMain.handle('hooks:install', async (_, worktreePath: string) => {
    installHooks(worktreePath)
    return true
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
          accelerator: 'CmdOrCtrl+N',
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

app.whenReady().then(() => {
  log('app', `started, log file: ${getLogFilePath()}`)
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

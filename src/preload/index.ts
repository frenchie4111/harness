import { contextBridge, ipcRenderer } from 'electron'

type StatusCallback = (id: string, status: string) => void
type DataCallback = (id: string, data: string) => void

contextBridge.exposeInMainWorld('api', {
  // Worktrees
  listWorktrees: () => ipcRenderer.invoke('worktree:list'),
  listBranches: () => ipcRenderer.invoke('worktree:branches'),
  addWorktree: (branchName: string, baseBranch?: string) => ipcRenderer.invoke('worktree:add', branchName, baseBranch),
  isWorktreeDirty: (path: string) => ipcRenderer.invoke('worktree:isDirty', path),
  removeWorktree: (path: string, force?: boolean) => ipcRenderer.invoke('worktree:remove', path, force),
  getWorktreeDir: () => ipcRenderer.invoke('worktree:dir'),
  selectRepoRoot: () => ipcRenderer.invoke('repo:select'),
  getRepoRoot: () => ipcRenderer.invoke('repo:getRoot'),

  // Changed files
  getChangedFiles: (worktreePath: string) => ipcRenderer.invoke('worktree:changedFiles', worktreePath),
  getFileDiff: (worktreePath: string, filePath: string, staged: boolean) => ipcRenderer.invoke('worktree:fileDiff', worktreePath, filePath, staged),
  getPRStatus: (worktreePath: string) => ipcRenderer.invoke('worktree:prStatus', worktreePath),

  // Config
  getHotkeyOverrides: () => ipcRenderer.invoke('config:getHotkeys'),
  setHotkeyOverrides: (hotkeys: Record<string, string>) => ipcRenderer.invoke('config:setHotkeys', hotkeys),
  resetHotkeyOverrides: () => ipcRenderer.invoke('config:resetHotkeys'),
  onHotkeysChanged: (callback: (hotkeys: Record<string, string> | null) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, hotkeys: Record<string, string> | null): void => {
      callback(hotkeys)
    }
    ipcRenderer.on('config:hotkeysChanged', handler)
    return () => ipcRenderer.removeListener('config:hotkeysChanged', handler)
  },
  getClaudeCommand: () => ipcRenderer.invoke('config:getClaudeCommand'),
  setClaudeCommand: (command: string) => ipcRenderer.invoke('config:setClaudeCommand', command),
  getDefaultClaudeCommand: () => ipcRenderer.invoke('config:getDefaultClaudeCommand'),
  onClaudeCommandChanged: (callback: (command: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, command: string): void => {
      callback(command)
    }
    ipcRenderer.on('config:claudeCommandChanged', handler)
    return () => ipcRenderer.removeListener('config:claudeCommandChanged', handler)
  },

  // Settings
  hasGithubToken: () => ipcRenderer.invoke('settings:hasGithubToken'),
  setGithubToken: (token: string, options?: { starRepo?: boolean }) => ipcRenderer.invoke('settings:setGithubToken', token, options),
  clearGithubToken: () => ipcRenderer.invoke('settings:clearGithubToken'),

  // Updater
  getVersion: () => ipcRenderer.invoke('updater:getVersion'),
  checkForUpdates: () => ipcRenderer.invoke('updater:checkForUpdates'),
  quitAndInstall: () => ipcRenderer.invoke('updater:quitAndInstall'),
  onUpdaterStatus: (callback: (status: Record<string, unknown>) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: Record<string, unknown>): void => {
      callback(status)
    }
    ipcRenderer.on('updater:status', handler)
    return () => ipcRenderer.removeListener('updater:status', handler)
  },

  // Shell
  openExternal: (url: string) => ipcRenderer.send('shell:openExternal', url),

  // Hooks
  checkHooks: (worktreePath: string) => ipcRenderer.invoke('hooks:check', worktreePath),
  installHooks: (worktreePath: string) => ipcRenderer.invoke('hooks:install', worktreePath),

  // PTY
  createTerminal: (id: string, cwd: string, cmd: string, args: string[]) => {
    ipcRenderer.send('pty:create', id, cwd, cmd, args)
  },
  writeTerminal: (id: string, data: string) => {
    ipcRenderer.send('pty:write', id, data)
  },
  resizeTerminal: (id: string, cols: number, rows: number) => {
    ipcRenderer.send('pty:resize', id, cols, rows)
  },
  killTerminal: (id: string) => {
    ipcRenderer.send('pty:kill', id)
  },
  onTerminalData: (callback: DataCallback) => {
    const handler = (_event: Electron.IpcRendererEvent, id: string, data: string): void => {
      callback(id, data)
    }
    ipcRenderer.on('terminal:data', handler)
    return () => ipcRenderer.removeListener('terminal:data', handler)
  },
  onStatusChange: (callback: StatusCallback) => {
    const handler = (_event: Electron.IpcRendererEvent, id: string, status: string): void => {
      callback(id, status)
    }
    ipcRenderer.on('terminal:status', handler)
    return () => ipcRenderer.removeListener('terminal:status', handler)
  }
})

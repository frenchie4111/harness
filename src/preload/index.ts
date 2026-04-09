import { contextBridge, ipcRenderer } from 'electron'

type StatusCallback = (id: string, status: string) => void
type DataCallback = (id: string, data: string) => void

contextBridge.exposeInMainWorld('api', {
  // Worktrees
  listWorktrees: () => ipcRenderer.invoke('worktree:list'),
  addWorktree: (name: string) => ipcRenderer.invoke('worktree:add', name),
  removeWorktree: (path: string) => ipcRenderer.invoke('worktree:remove', path),
  selectRepoRoot: () => ipcRenderer.invoke('repo:select'),
  getRepoRoot: () => ipcRenderer.invoke('repo:getRoot'),

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

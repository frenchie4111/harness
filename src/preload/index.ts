import { contextBridge, ipcRenderer } from 'electron'

type StatusCallback = (id: string, status: string) => void
type DataCallback = (id: string, data: string) => void
type ExitCallback = (id: string, exitCode: number) => void

contextBridge.exposeInMainWorld('api', {
  // Worktrees
  listWorktrees: () => ipcRenderer.invoke('worktree:list'),
  listBranches: () => ipcRenderer.invoke('worktree:branches'),
  addWorktree: (branchName: string, baseBranch?: string) => ipcRenderer.invoke('worktree:add', branchName, baseBranch),
  continueWorktree: (worktreePath: string, newBranchName: string, baseBranch?: string) =>
    ipcRenderer.invoke('worktree:continue', worktreePath, newBranchName, baseBranch),
  isWorktreeDirty: (path: string) => ipcRenderer.invoke('worktree:isDirty', path),
  removeWorktree: (path: string, force?: boolean) => ipcRenderer.invoke('worktree:remove', path, force),
  getWorktreeDir: () => ipcRenderer.invoke('worktree:dir'),
  selectRepoRoot: () => ipcRenderer.invoke('repo:select'),
  getRepoRoot: () => ipcRenderer.invoke('repo:getRoot'),

  // Changed files
  getChangedFiles: (worktreePath: string, mode?: 'working' | 'branch') =>
    ipcRenderer.invoke('worktree:changedFiles', worktreePath, mode),
  getFileDiff: (worktreePath: string, filePath: string, staged: boolean, mode?: 'working' | 'branch') =>
    ipcRenderer.invoke('worktree:fileDiff', worktreePath, filePath, staged, mode),
  getBranchCommits: (worktreePath: string) => ipcRenderer.invoke('worktree:branchCommits', worktreePath),
  getCommitDiff: (worktreePath: string, hash: string) =>
    ipcRenderer.invoke('worktree:commitDiff', worktreePath, hash),
  getPRStatus: (worktreePath: string) => ipcRenderer.invoke('worktree:prStatus', worktreePath),
  getMainWorktreeStatus: () => ipcRenderer.invoke('worktree:mainStatus'),
  prepareMainForMerge: () => ipcRenderer.invoke('worktree:prepareMain'),
  previewMergeConflicts: (sourceBranch: string) =>
    ipcRenderer.invoke('worktree:previewMerge', sourceBranch),
  mergeWorktreeLocally: (sourceBranch: string, strategy: 'squash' | 'merge-commit' | 'fast-forward') =>
    ipcRenderer.invoke('worktree:mergeLocal', sourceBranch, strategy),
  getMergedStatus: () => ipcRenderer.invoke('worktree:mergedStatus'),

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
  getTheme: () => ipcRenderer.invoke('config:getTheme'),
  setTheme: (theme: string) => ipcRenderer.invoke('config:setTheme', theme),
  getAvailableThemes: () => ipcRenderer.invoke('config:getAvailableThemes'),
  onThemeChanged: (callback: (theme: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, theme: string): void => {
      callback(theme)
    }
    ipcRenderer.on('config:themeChanged', handler)
    return () => ipcRenderer.removeListener('config:themeChanged', handler)
  },
  getWorkspacePanes: () => ipcRenderer.invoke('config:getPanes'),
  setWorkspacePanes: (panes: unknown) =>
    ipcRenderer.invoke('config:setPanes', panes),
  saveTerminalHistory: (id: string, content: string) =>
    ipcRenderer.invoke('terminal:saveHistory', id, content),
  saveTerminalHistorySync: (id: string, content: string) => {
    ipcRenderer.sendSync('terminal:saveHistorySync', id, content)
  },
  loadTerminalHistory: (id: string) => ipcRenderer.invoke('terminal:loadHistory', id),
  clearTerminalHistory: (id: string) => ipcRenderer.invoke('terminal:clearHistory', id),
  claudeSessionFileExists: (cwd: string, sessionId: string) =>
    ipcRenderer.invoke('claude:sessionFileExists', cwd, sessionId),
  getLatestClaudeSessionId: (cwd: string) => ipcRenderer.invoke('claude:latestSessionId', cwd),
  onClaudeCommandChanged: (callback: (command: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, command: string): void => {
      callback(command)
    }
    ipcRenderer.on('config:claudeCommandChanged', handler)
    return () => ipcRenderer.removeListener('config:claudeCommandChanged', handler)
  },

  // Onboarding quest
  getOnboarding: () => ipcRenderer.invoke('config:getOnboarding'),
  setOnboardingQuest: (quest: string) => ipcRenderer.invoke('config:setOnboardingQuest', quest),

  // Worktree base
  getWorktreeBase: () => ipcRenderer.invoke('config:getWorktreeBase'),
  setWorktreeBase: (mode: 'remote' | 'local') =>
    ipcRenderer.invoke('config:setWorktreeBase', mode),
  getMergeStrategy: () => ipcRenderer.invoke('config:getMergeStrategy'),
  setMergeStrategy: (strategy: 'squash' | 'merge-commit' | 'fast-forward') =>
    ipcRenderer.invoke('config:setMergeStrategy', strategy),

  // External editor
  getEditor: () => ipcRenderer.invoke('config:getEditor'),
  setEditor: (editorId: string) => ipcRenderer.invoke('config:setEditor', editorId),
  getAvailableEditors: () => ipcRenderer.invoke('config:getAvailableEditors'),
  openInEditor: (worktreePath: string, filePath?: string) =>
    ipcRenderer.invoke('editor:open', worktreePath, filePath),
  onEditorChanged: (callback: (editorId: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, editorId: string): void => {
      callback(editorId)
    }
    ipcRenderer.on('config:editorChanged', handler)
    return () => ipcRenderer.removeListener('config:editorChanged', handler)
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

  // App-level events from menu
  onOpenSettings: (callback: () => void) => {
    const handler = (): void => callback()
    ipcRenderer.on('app:openSettings', handler)
    return () => ipcRenderer.removeListener('app:openSettings', handler)
  },

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
  },
  // Activity log
  recordActivity: (worktreePath: string, state: string) => {
    ipcRenderer.send('activity:record', worktreePath, state)
  },
  getActivityLog: () => ipcRenderer.invoke('activity:get'),
  clearActivityLog: (worktreePath?: string) => ipcRenderer.invoke('activity:clear', worktreePath),

  onTerminalExit: (callback: ExitCallback) => {
    const handler = (_event: Electron.IpcRendererEvent, id: string, exitCode: number): void => {
      callback(id, exitCode)
    }
    ipcRenderer.on('terminal:exit', handler)
    return () => ipcRenderer.removeListener('terminal:exit', handler)
  }
})

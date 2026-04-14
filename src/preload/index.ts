import { contextBridge, ipcRenderer, webUtils } from 'electron'

interface PendingToolShape {
  name: string
  input: Record<string, unknown>
}
type StatusCallback = (
  id: string,
  status: string,
  pendingTool: PendingToolShape | null
) => void
type DataCallback = (id: string, data: string) => void
type ExitCallback = (id: string, exitCode: number) => void

contextBridge.exposeInMainWorld('api', {
  // Worktrees — every call takes repoRoot explicitly so a window can host multiple repos.
  listWorktrees: (repoRoot: string) => ipcRenderer.invoke('worktree:list', repoRoot),
  listBranches: (repoRoot: string) => ipcRenderer.invoke('worktree:branches', repoRoot),
  addWorktree: (repoRoot: string, branchName: string, baseBranch?: string, runId?: string) =>
    ipcRenderer.invoke('worktree:add', repoRoot, branchName, baseBranch, runId),
  onWorktreeScriptEvent: (
    callback: (event: {
      runId: string
      phase: 'setup' | 'teardown'
      type: 'start' | 'output' | 'end'
      stream?: 'stdout' | 'stderr'
      data?: string
      ok?: boolean
      exitCode?: number
    }) => void
  ) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: Parameters<typeof callback>[0]): void => {
      callback(payload)
    }
    ipcRenderer.on('worktree:scriptEvent', handler)
    return () => ipcRenderer.removeListener('worktree:scriptEvent', handler)
  },
  continueWorktree: (repoRoot: string, worktreePath: string, newBranchName: string, baseBranch?: string) =>
    ipcRenderer.invoke('worktree:continue', repoRoot, worktreePath, newBranchName, baseBranch),
  isWorktreeDirty: (path: string) => ipcRenderer.invoke('worktree:isDirty', path),
  removeWorktree: (
    repoRoot: string,
    path: string,
    force?: boolean,
    removeMeta?: { prNumber?: number; prState?: 'open' | 'draft' | 'merged' | 'closed' }
  ) => ipcRenderer.invoke('worktree:remove', repoRoot, path, force, removeMeta),
  getWorktreeDir: (repoRoot: string) => ipcRenderer.invoke('worktree:dir', repoRoot),
  // Repos (multi-repo session state)
  listRepos: () => ipcRenderer.invoke('repo:list'),
  addRepo: () => ipcRenderer.invoke('repo:add'),
  removeRepo: (repoRoot: string) => ipcRenderer.invoke('repo:remove', repoRoot),
  onReposChanged: (callback: (repos: string[]) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, repos: string[]): void => callback(repos)
    ipcRenderer.on('repo:listChanged', handler)
    return () => ipcRenderer.removeListener('repo:listChanged', handler)
  },

  // All files (tracked + untracked, respecting .gitignore)
  listAllFiles: (worktreePath: string) => ipcRenderer.invoke('worktree:listFiles', worktreePath),
  readWorktreeFile: (worktreePath: string, filePath: string) =>
    ipcRenderer.invoke('worktree:readFile', worktreePath, filePath),

  // Changed files
  getChangedFiles: (worktreePath: string, mode?: 'working' | 'branch') =>
    ipcRenderer.invoke('worktree:changedFiles', worktreePath, mode),
  getFileDiff: (worktreePath: string, filePath: string, staged: boolean, mode?: 'working' | 'branch') =>
    ipcRenderer.invoke('worktree:fileDiff', worktreePath, filePath, staged, mode),
  getBranchCommits: (worktreePath: string) => ipcRenderer.invoke('worktree:branchCommits', worktreePath),
  getCommitDiff: (worktreePath: string, hash: string) =>
    ipcRenderer.invoke('worktree:commitDiff', worktreePath, hash),
  getPRStatus: (worktreePath: string) => ipcRenderer.invoke('worktree:prStatus', worktreePath),
  getMainWorktreeStatus: (repoRoot: string) => ipcRenderer.invoke('worktree:mainStatus', repoRoot),
  prepareMainForMerge: (repoRoot: string) => ipcRenderer.invoke('worktree:prepareMain', repoRoot),
  previewMergeConflicts: (repoRoot: string, sourceBranch: string) =>
    ipcRenderer.invoke('worktree:previewMerge', repoRoot, sourceBranch),
  mergeWorktreeLocally: (repoRoot: string, sourceBranch: string, strategy: 'squash' | 'merge-commit' | 'fast-forward') =>
    ipcRenderer.invoke('worktree:mergeLocal', repoRoot, sourceBranch, strategy),
  getMergedStatus: (repoRoot: string) => ipcRenderer.invoke('worktree:mergedStatus', repoRoot),

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
  getWorktreeScripts: () => ipcRenderer.invoke('config:getWorktreeScripts'),
  setWorktreeScripts: (scripts: { setup?: string; teardown?: string }) =>
    ipcRenderer.invoke('config:setWorktreeScripts', scripts),
  getRepoConfig: (repoRoot: string) => ipcRenderer.invoke('repoConfig:get', repoRoot),
  setRepoConfig: (repoRoot: string, next: Record<string, unknown>) =>
    ipcRenderer.invoke('repoConfig:set', repoRoot, next),
  getEffectiveMergeStrategy: (repoRoot: string) =>
    ipcRenderer.invoke('repoConfig:getEffectiveMergeStrategy', repoRoot),
  onRepoConfigChanged: (
    callback: (payload: { repoRoot: string; config: Record<string, unknown> }) => void
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      payload: { repoRoot: string; config: Record<string, unknown> }
    ): void => callback(payload)
    ipcRenderer.on('repoConfig:changed', handler)
    return () => ipcRenderer.removeListener('repoConfig:changed', handler)
  },
  getClaudeEnvVars: () => ipcRenderer.invoke('config:getClaudeEnvVars'),
  setClaudeEnvVars: (vars: Record<string, string>) => ipcRenderer.invoke('config:setClaudeEnvVars', vars),
  onClaudeEnvVarsChanged: (callback: (vars: Record<string, string>) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, vars: Record<string, string>): void => {
      callback(vars)
    }
    ipcRenderer.on('config:claudeEnvVarsChanged', handler)
    return () => ipcRenderer.removeListener('config:claudeEnvVarsChanged', handler)
  },
  getHarnessMcpEnabled: () => ipcRenderer.invoke('config:getHarnessMcpEnabled'),
  setHarnessMcpEnabled: (enabled: boolean) =>
    ipcRenderer.invoke('config:setHarnessMcpEnabled', enabled),
  onHarnessMcpEnabledChanged: (callback: (enabled: boolean) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, enabled: boolean): void => {
      callback(enabled)
    }
    ipcRenderer.on('config:harnessMcpEnabledChanged', handler)
    return () => ipcRenderer.removeListener('config:harnessMcpEnabledChanged', handler)
  },
  prepareMcpForTerminal: (terminalId: string): Promise<string | null> =>
    ipcRenderer.invoke('mcp:prepareForTerminal', terminalId),
  onWorktreesExternalCreate: (
    callback: (payload: { repoRoot: string; worktree: unknown; initialPrompt?: string }) => void
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      payload: { repoRoot: string; worktree: unknown; initialPrompt?: string }
    ): void => {
      callback(payload)
    }
    ipcRenderer.on('worktrees:externalCreate', handler)
    return () => ipcRenderer.removeListener('worktrees:externalCreate', handler)
  },
  getNameClaudeSessions: () => ipcRenderer.invoke('config:getNameClaudeSessions'),
  setNameClaudeSessions: (enabled: boolean) => ipcRenderer.invoke('config:setNameClaudeSessions', enabled),
  onNameClaudeSessionsChanged: (callback: (enabled: boolean) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, enabled: boolean): void => {
      callback(enabled)
    }
    ipcRenderer.on('config:nameClaudeSessionsChanged', handler)
    return () => ipcRenderer.removeListener('config:nameClaudeSessionsChanged', handler)
  },
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
  getTerminalFontFamily: () => ipcRenderer.invoke('config:getTerminalFontFamily'),
  setTerminalFontFamily: (fontFamily: string) =>
    ipcRenderer.invoke('config:setTerminalFontFamily', fontFamily),
  getDefaultTerminalFontFamily: () => ipcRenderer.invoke('config:getDefaultTerminalFontFamily'),
  onTerminalFontFamilyChanged: (callback: (fontFamily: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, fontFamily: string): void => {
      callback(fontFamily)
    }
    ipcRenderer.on('config:terminalFontFamilyChanged', handler)
    return () => ipcRenderer.removeListener('config:terminalFontFamilyChanged', handler)
  },
  getTerminalFontSize: () => ipcRenderer.invoke('config:getTerminalFontSize'),
  setTerminalFontSize: (fontSize: number) =>
    ipcRenderer.invoke('config:setTerminalFontSize', fontSize),
  onTerminalFontSizeChanged: (callback: (fontSize: number) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, fontSize: number): void => {
      callback(fontSize)
    }
    ipcRenderer.on('config:terminalFontSizeChanged', handler)
    return () => ipcRenderer.removeListener('config:terminalFontSizeChanged', handler)
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

  // Resolve a dropped File's absolute path. File.path was removed in Electron 32+.
  getFilePath: (file: File) => webUtils.getPathForFile(file),

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
  createTerminal: (id: string, cwd: string, cmd: string, args: string[], isClaude?: boolean) => {
    ipcRenderer.send('pty:create', id, cwd, cmd, args, isClaude)
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
    const handler = (
      _event: Electron.IpcRendererEvent,
      id: string,
      status: string,
      pendingTool?: PendingToolShape | null
    ): void => {
      callback(id, status, pendingTool ?? null)
    }
    ipcRenderer.on('terminal:status', handler)
    return () => ipcRenderer.removeListener('terminal:status', handler)
  },
  onShellActivity: (
    callback: (id: string, payload: { active: boolean; processName?: string }) => void
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      id: string,
      payload: { active: boolean; processName?: string }
    ): void => {
      callback(id, payload)
    }
    ipcRenderer.on('terminal:shell-activity', handler)
    return () => ipcRenderer.removeListener('terminal:shell-activity', handler)
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

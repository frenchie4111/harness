import { contextBridge, ipcRenderer, webUtils } from 'electron'

type DataCallback = (id: string, data: string) => void
type ExitCallback = (id: string, exitCode: number) => void

contextBridge.exposeInMainWorld('api', {
  // Worktrees — list/branches stay as one-shot queries; the flat list lives
  // in the main-process store (see src/main/worktrees-fsm.ts) and is read
  // via useWorktrees() in the renderer.
  listWorktrees: (repoRoot: string) => ipcRenderer.invoke('worktree:list', repoRoot),
  listBranches: (repoRoot: string) => ipcRenderer.invoke('worktree:branches', repoRoot),

  // Pending-creation FSM. The renderer awaits runPendingWorktree end-to-end
  // for its final outcome (needed to stage initial prompts + route focus),
  // while main dispatches state transitions for the in-progress screens.
  runPendingWorktree: (params: {
    id: string
    repoRoot: string
    branchName: string
    initialPrompt?: string
    teleportSessionId?: string
  }) => ipcRenderer.invoke('worktrees:runPending', params),
  retryPendingWorktree: (id: string) =>
    ipcRenderer.invoke('worktrees:retryPending', id),
  dismissPendingWorktree: (id: string) =>
    ipcRenderer.invoke('worktrees:dismissPending', id),
  refreshWorktreesList: () => ipcRenderer.invoke('worktrees:refreshList'),

  continueWorktree: (repoRoot: string, worktreePath: string, newBranchName: string, baseBranch?: string) =>
    ipcRenderer.invoke('worktree:continue', repoRoot, worktreePath, newBranchName, baseBranch),
  isWorktreeDirty: (path: string) => ipcRenderer.invoke('worktree:isDirty', path),
  removeWorktree: (
    repoRoot: string,
    path: string,
    force?: boolean,
    removeMeta?: { prNumber?: number; prState?: 'open' | 'draft' | 'merged' | 'closed' }
  ) => ipcRenderer.invoke('worktree:remove', repoRoot, path, force, removeMeta),
  dismissPendingDeletion: (path: string) =>
    ipcRenderer.invoke('worktree:dismissPendingDeletion', path),
  getWorktreeDir: (repoRoot: string) => ipcRenderer.invoke('worktree:dir', repoRoot),
  // Repos (multi-repo session state)
  listRepos: () => ipcRenderer.invoke('repo:list'),
  addRepo: () => ipcRenderer.invoke('repo:add'),
  removeRepo: (repoRoot: string) => ipcRenderer.invoke('repo:remove', repoRoot),

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
  getMainWorktreeStatus: (repoRoot: string) => ipcRenderer.invoke('worktree:mainStatus', repoRoot),
  prepareMainForMerge: (repoRoot: string) => ipcRenderer.invoke('worktree:prepareMain', repoRoot),
  previewMergeConflicts: (repoRoot: string, sourceBranch: string) =>
    ipcRenderer.invoke('worktree:previewMerge', repoRoot, sourceBranch),
  mergeWorktreeLocally: (repoRoot: string, sourceBranch: string, strategy: 'squash' | 'merge-commit' | 'fast-forward') =>
    ipcRenderer.invoke('worktree:mergeLocal', repoRoot, sourceBranch, strategy),

  // PR status lives in the main-process store (see src/main/pr-poller.ts).
  // Consumers read via useSyncExternalStore in the renderer store; these
  // methods trigger on-demand refreshes.
  refreshPRsAll: () => ipcRenderer.invoke('prs:refreshAll'),
  refreshPRsAllIfStale: () => ipcRenderer.invoke('prs:refreshAllIfStale'),
  refreshPRsOne: (worktreePath: string) =>
    ipcRenderer.invoke('prs:refreshOne', worktreePath),
  refreshPRsOneIfStale: (worktreePath: string) =>
    ipcRenderer.invoke('prs:refreshOneIfStale', worktreePath),

  // Config — getters for store-backed settings are gone. Renderer reads
  // via useSettings() / useRepoConfigs() / useOnboarding() etc. The set*
  // methods stay because they're how the renderer asks main to mutate.
  setHotkeyOverrides: (hotkeys: Record<string, string>) => ipcRenderer.invoke('config:setHotkeys', hotkeys),
  resetHotkeyOverrides: () => ipcRenderer.invoke('config:resetHotkeys'),
  setClaudeCommand: (command: string) => ipcRenderer.invoke('config:setClaudeCommand', command),
  getDefaultClaudeCommand: () => ipcRenderer.invoke('config:getDefaultClaudeCommand'),
  setWorktreeScripts: (scripts: { setup?: string; teardown?: string }) =>
    ipcRenderer.invoke('config:setWorktreeScripts', scripts),
  setRepoConfig: (repoRoot: string, next: Record<string, unknown>) =>
    ipcRenderer.invoke('repoConfig:set', repoRoot, next),
  setClaudeEnvVars: (vars: Record<string, string>) => ipcRenderer.invoke('config:setClaudeEnvVars', vars),
  setHarnessMcpEnabled: (enabled: boolean) =>
    ipcRenderer.invoke('config:setHarnessMcpEnabled', enabled),
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
  setNameClaudeSessions: (enabled: boolean) => ipcRenderer.invoke('config:setNameClaudeSessions', enabled),
  setTheme: (theme: string) => ipcRenderer.invoke('config:setTheme', theme),
  getAvailableThemes: () => ipcRenderer.invoke('config:getAvailableThemes'),
  setTerminalFontFamily: (fontFamily: string) =>
    ipcRenderer.invoke('config:setTerminalFontFamily', fontFamily),
  getDefaultTerminalFontFamily: () => ipcRenderer.invoke('config:getDefaultTerminalFontFamily'),
  setTerminalFontSize: (fontSize: number) =>
    ipcRenderer.invoke('config:setTerminalFontSize', fontSize),

  // Panes — the pane/tab tree lives in the main-process store. Renderer
  // dispatches every operation as a method call instead of computing
  // local state.
  panesAddTab: (wtPath: string, tab: unknown, paneId?: string) =>
    ipcRenderer.invoke('panes:addTab', wtPath, tab, paneId),
  panesCloseTab: (wtPath: string, tabId: string) =>
    ipcRenderer.invoke('panes:closeTab', wtPath, tabId),
  panesRestartClaudeTab: (wtPath: string, tabId: string, newId: string) =>
    ipcRenderer.invoke('panes:restartClaudeTab', wtPath, tabId, newId),
  panesSelectTab: (wtPath: string, paneId: string, tabId: string) =>
    ipcRenderer.invoke('panes:selectTab', wtPath, paneId, tabId),
  panesReorderTabs: (
    wtPath: string,
    paneId: string,
    fromId: string,
    toId: string
  ) => ipcRenderer.invoke('panes:reorderTabs', wtPath, paneId, fromId, toId),
  panesMoveTabToPane: (
    wtPath: string,
    tabId: string,
    toPaneId: string,
    toIndex?: number
  ) =>
    ipcRenderer.invoke('panes:moveTabToPane', wtPath, tabId, toPaneId, toIndex),
  panesSplitPane: (wtPath: string, fromPaneId: string) =>
    ipcRenderer.invoke('panes:splitPane', wtPath, fromPaneId),
  panesClearForWorktree: (wtPath: string) =>
    ipcRenderer.invoke('panes:clearForWorktree', wtPath),

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

  // Onboarding quest
  setOnboardingQuest: (quest: string) => ipcRenderer.invoke('config:setOnboardingQuest', quest),

  // Worktree base
  setWorktreeBase: (mode: 'remote' | 'local') =>
    ipcRenderer.invoke('config:setWorktreeBase', mode),
  setMergeStrategy: (strategy: 'squash' | 'merge-commit' | 'fast-forward') =>
    ipcRenderer.invoke('config:setMergeStrategy', strategy),

  // External editor
  setEditor: (editorId: string) => ipcRenderer.invoke('config:setEditor', editorId),
  getAvailableEditors: () => ipcRenderer.invoke('config:getAvailableEditors'),
  openInEditor: (worktreePath: string, filePath?: string) =>
    ipcRenderer.invoke('editor:open', worktreePath, filePath),

  // Settings
  hasGithubToken: () => ipcRenderer.invoke('settings:hasGithubToken'),
  setGithubToken: (token: string) => ipcRenderer.invoke('settings:setGithubToken', token),
  clearGithubToken: () => ipcRenderer.invoke('settings:clearGithubToken'),
  setHarnessStarred: (starred: boolean) => ipcRenderer.invoke('settings:setHarnessStarred', starred),

  // Updater
  getVersion: () => ipcRenderer.invoke('updater:getVersion'),
  checkForUpdates: () => ipcRenderer.invoke('updater:checkForUpdates'),
  quitAndInstall: () => ipcRenderer.invoke('updater:quitAndInstall'),

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
  acceptHooks: () => ipcRenderer.invoke('hooks:acceptAll'),
  declineHooks: () => ipcRenderer.invoke('hooks:decline'),
  dismissHooksJustInstalled: () => ipcRenderer.invoke('hooks:dismissJustInstalled'),

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
  // Terminal status + shell activity live in the main-process store now;
  // consumers read via useTerminals() in the renderer. terminal:data and
  // terminal:exit stay on direct channels.
  // Activity log — recordActivity is fully main-driven now (see
  // activity-deriver.ts); the renderer only reads the persisted log.
  getActivityLog: () => ipcRenderer.invoke('activity:get'),
  clearActivityLog: (worktreePath?: string) => ipcRenderer.invoke('activity:clear', worktreePath),

  onTerminalExit: (callback: ExitCallback) => {
    const handler = (_event: Electron.IpcRendererEvent, id: string, exitCode: number): void => {
      callback(id, exitCode)
    }
    ipcRenderer.on('terminal:exit', handler)
    return () => ipcRenderer.removeListener('terminal:exit', handler)
  },

  // State transport (snapshot + event stream). Replaces ad-hoc per-field
  // getters and onXChanged subscriptions one slice at a time.
  getStateSnapshot: () => ipcRenderer.invoke('state:getSnapshot'),
  onStateEvent: (callback: (event: unknown, seq: number) => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      stateEvent: unknown,
      seq: number
    ): void => {
      callback(stateEvent, seq)
    }
    ipcRenderer.on('state:event', handler)
    return () => ipcRenderer.removeListener('state:event', handler)
  }
})

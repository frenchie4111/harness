import { contextBridge, webUtils } from 'electron'
import { ElectronClientTransport } from './transport-electron'

// Every window.api method is a thin wrapper over the client transport.
// The transport owns all ipcRenderer interaction; this file just
// declares the named channels + arg shapes that make up the
// renderer/main contract. Swapping transports (WebSocket, SSH stdio)
// means constructing a different ClientTransport here — no other change
// is needed above this layer.

const transport = new ElectronClientTransport()

type DataCallback = (id: string, data: string) => void
type ExitCallback = (id: string, exitCode: number) => void

const req = (name: string, ...args: unknown[]): Promise<unknown> =>
  transport.request(name, ...args)
const sig = (name: string, ...args: unknown[]): void => transport.send(name, ...args)

contextBridge.exposeInMainWorld('api', {
  // Worktrees — list/branches stay as one-shot queries; the flat list lives
  // in the main-process store (see src/main/worktrees-fsm.ts) and is read
  // via useWorktrees() in the renderer.
  listWorktrees: (repoRoot: string) => req('worktree:list', repoRoot),
  listBranches: (repoRoot: string) => req('worktree:branches', repoRoot),

  // Pending-creation FSM. The renderer awaits runPendingWorktree end-to-end
  // for its final outcome (needed to stage initial prompts + route focus),
  // while main dispatches state transitions for the in-progress screens.
  runPendingWorktree: (params: {
    id: string
    repoRoot: string
    branchName: string
    initialPrompt?: string
    teleportSessionId?: string
  }) => req('worktrees:runPending', params),
  retryPendingWorktree: (id: string) => req('worktrees:retryPending', id),
  dismissPendingWorktree: (id: string) => req('worktrees:dismissPending', id),
  refreshWorktreesList: () => req('worktrees:refreshList'),

  continueWorktree: (
    repoRoot: string,
    worktreePath: string,
    newBranchName: string,
    baseBranch?: string
  ) => req('worktree:continue', repoRoot, worktreePath, newBranchName, baseBranch),
  isWorktreeDirty: (path: string) => req('worktree:isDirty', path),
  removeWorktree: (
    repoRoot: string,
    path: string,
    force?: boolean,
    removeMeta?: { prNumber?: number; prState?: 'open' | 'draft' | 'merged' | 'closed' }
  ) => req('worktree:remove', repoRoot, path, force, removeMeta),
  dismissPendingDeletion: (path: string) => req('worktree:dismissPendingDeletion', path),
  getWorktreeDir: (repoRoot: string) => req('worktree:dir', repoRoot),
  // Repos (multi-repo session state)
  listRepos: () => req('repo:list'),
  addRepo: () => req('repo:add'),
  removeRepo: (repoRoot: string) => req('repo:remove', repoRoot),

  // All files (tracked + untracked, respecting .gitignore)
  listAllFiles: (worktreePath: string) => req('worktree:listFiles', worktreePath),
  readWorktreeFile: (worktreePath: string, filePath: string) =>
    req('worktree:readFile', worktreePath, filePath),
  writeWorktreeFile: (worktreePath: string, filePath: string, contents: string) =>
    req('worktree:writeFile', worktreePath, filePath, contents),

  // Changed files
  getChangedFiles: (worktreePath: string, mode?: 'working' | 'branch') =>
    req('worktree:changedFiles', worktreePath, mode),
  getFileDiff: (
    worktreePath: string,
    filePath: string,
    staged: boolean,
    mode?: 'working' | 'branch'
  ) => req('worktree:fileDiff', worktreePath, filePath, staged, mode),
  getFileDiffSides: (
    worktreePath: string,
    filePath: string,
    staged: boolean,
    mode?: 'working' | 'branch'
  ) => req('worktree:fileDiffSides', worktreePath, filePath, staged, mode),
  getBranchCommits: (worktreePath: string) => req('worktree:branchCommits', worktreePath),
  getCommitDiff: (worktreePath: string, hash: string) =>
    req('worktree:commitDiff', worktreePath, hash),
  getCommitChangedFiles: (worktreePath: string, hash: string) =>
    req('worktree:commitChangedFiles', worktreePath, hash),
  getCommitFileDiffSides: (worktreePath: string, hash: string, filePath: string) =>
    req('worktree:commitFileDiffSides', worktreePath, hash, filePath),
  getMainWorktreeStatus: (repoRoot: string) => req('worktree:mainStatus', repoRoot),
  prepareMainForMerge: (repoRoot: string) => req('worktree:prepareMain', repoRoot),
  previewMergeConflicts: (repoRoot: string, sourceBranch: string, worktreePath?: string) =>
    req('worktree:previewMerge', repoRoot, sourceBranch, worktreePath),
  mergeWorktreeLocally: (
    repoRoot: string,
    sourceBranch: string,
    strategy: 'squash' | 'merge-commit' | 'fast-forward',
    worktreePath?: string
  ) => req('worktree:mergeLocal', repoRoot, sourceBranch, strategy, worktreePath),

  // PR status lives in the main-process store (see src/main/pr-poller.ts).
  // Consumers read via useSyncExternalStore in the renderer store; these
  // methods trigger on-demand refreshes.
  refreshPRsAll: () => req('prs:refreshAll'),
  refreshPRsAllIfStale: () => req('prs:refreshAllIfStale'),
  refreshPRsOne: (worktreePath: string) => req('prs:refreshOne', worktreePath),
  refreshPRsOneIfStale: (worktreePath: string) => req('prs:refreshOneIfStale', worktreePath),

  // Config — getters for store-backed settings are gone. Renderer reads
  // via useSettings() / useRepoConfigs() / useOnboarding() etc. The set*
  // methods stay because they're how the renderer asks main to mutate.
  setHotkeyOverrides: (hotkeys: Record<string, string>) => req('config:setHotkeys', hotkeys),
  resetHotkeyOverrides: () => req('config:resetHotkeys'),
  setClaudeCommand: (command: string) => req('config:setClaudeCommand', command),
  getDefaultClaudeCommand: () => req('config:getDefaultClaudeCommand'),
  setWorktreeScripts: (scripts: { setup?: string; teardown?: string }) =>
    req('config:setWorktreeScripts', scripts),
  setRepoConfig: (repoRoot: string, next: Record<string, unknown>) =>
    req('repoConfig:set', repoRoot, next),
  setClaudeEnvVars: (vars: Record<string, string>) => req('config:setClaudeEnvVars', vars),
  setDefaultAgent: (agent: string) => req('config:setDefaultAgent', agent),
  setCodexCommand: (command: string) => req('config:setCodexCommand', command),
  setClaudeModel: (model: string | null) => req('config:setClaudeModel', model),
  setCodexModel: (model: string | null) => req('config:setCodexModel', model),
  setCodexEnvVars: (vars: Record<string, string>) => req('config:setCodexEnvVars', vars),
  setHarnessMcpEnabled: (enabled: boolean) => req('config:setHarnessMcpEnabled', enabled),
  setClaudeTuiFullscreen: (enabled: boolean) => req('config:setClaudeTuiFullscreen', enabled),
  setAutoUpdateEnabled: (enabled: boolean) => req('config:setAutoUpdateEnabled', enabled),
  setShareClaudeSettings: (enabled: boolean) => req('config:setShareClaudeSettings', enabled),
  setHarnessSystemPromptEnabled: (enabled: boolean) => req('config:setHarnessSystemPromptEnabled', enabled),
  setHarnessSystemPrompt: (prompt: string) => req('config:setHarnessSystemPrompt', prompt),
  setHarnessSystemPromptMain: (prompt: string) => req('config:setHarnessSystemPromptMain', prompt),
  prepareMcpForTerminal: (terminalId: string): Promise<string | null> =>
    req('mcp:prepareForTerminal', terminalId) as Promise<string | null>,
  onWorktreesExternalCreate: (
    callback: (payload: { repoRoot: string; worktree: unknown; initialPrompt?: string }) => void
  ) =>
    transport.onSignal('worktrees:externalCreate', (payload) => {
      callback(payload as { repoRoot: string; worktree: unknown; initialPrompt?: string })
    }),
  setNameClaudeSessions: (enabled: boolean) => req('config:setNameClaudeSessions', enabled),
  setTheme: (theme: string) => req('config:setTheme', theme),
  getAvailableThemes: () => req('config:getAvailableThemes'),
  setTerminalFontFamily: (fontFamily: string) => req('config:setTerminalFontFamily', fontFamily),
  getDefaultTerminalFontFamily: () => req('config:getDefaultTerminalFontFamily'),
  setTerminalFontSize: (fontSize: number) => req('config:setTerminalFontSize', fontSize),

  // Panes — the pane/tab tree lives in the main-process store. Renderer
  // dispatches every operation as a method call instead of computing
  // local state.
  panesAddTab: (wtPath: string, tab: unknown, paneId?: string) =>
    req('panes:addTab', wtPath, tab, paneId),
  panesCloseTab: (wtPath: string, tabId: string) => req('panes:closeTab', wtPath, tabId),
  panesRestartAgentTab: (wtPath: string, tabId: string, newId: string) =>
    req('panes:restartAgentTab', wtPath, tabId, newId),
  panesSelectTab: (wtPath: string, paneId: string, tabId: string) =>
    req('panes:selectTab', wtPath, paneId, tabId),
  panesReorderTabs: (wtPath: string, paneId: string, fromId: string, toId: string) =>
    req('panes:reorderTabs', wtPath, paneId, fromId, toId),
  panesMoveTabToPane: (wtPath: string, tabId: string, toPaneId: string, toIndex?: number) =>
    req('panes:moveTabToPane', wtPath, tabId, toPaneId, toIndex),
  panesSplitPane: (wtPath: string, fromPaneId: string, direction?: 'horizontal' | 'vertical') =>
    req('panes:splitPane', wtPath, fromPaneId, direction),
  panesSetRatio: (wtPath: string, splitId: string, ratio: number) =>
    req('panes:setRatio', wtPath, splitId, ratio),
  panesClearForWorktree: (wtPath: string) => req('panes:clearForWorktree', wtPath),
  panesEnsureInitialized: (wtPath: string) => req('panes:ensureInitialized', wtPath),

  getTerminalHistory: (id: string) => req('terminal:getHistory', id),
  clearTerminalHistory: (id: string) => req('terminal:forgetHistory', id),
  agentSessionFileExists: (cwd: string, sessionId: string, agentKind?: string) =>
    req('agent:sessionFileExists', cwd, sessionId, agentKind),
  getLatestAgentSessionId: (cwd: string, agentKind?: string) =>
    req('agent:latestSessionId', cwd, agentKind),
  buildAgentSpawnArgs: (agentKind: string, opts: {
    terminalId: string; cwd: string; sessionId?: string;
    initialPrompt?: string; teleportSessionId?: string; sessionName?: string
  }) => req('agent:buildSpawnArgs', agentKind, opts),

  // Onboarding quest
  setOnboardingQuest: (quest: string) => req('config:setOnboardingQuest', quest),

  // Worktree base
  setWorktreeBase: (mode: 'remote' | 'local') => req('config:setWorktreeBase', mode),
  setMergeStrategy: (strategy: 'squash' | 'merge-commit' | 'fast-forward') =>
    req('config:setMergeStrategy', strategy),

  // External editor
  setEditor: (editorId: string) => req('config:setEditor', editorId),
  getAvailableEditors: () => req('config:getAvailableEditors'),
  openInEditor: (worktreePath: string, filePath?: string) =>
    req('editor:open', worktreePath, filePath),

  // Settings
  hasGithubToken: () => req('settings:hasGithubToken'),
  setGithubToken: (token: string) => req('settings:setGithubToken', token),
  clearGithubToken: () => req('settings:clearGithubToken'),
  setHarnessStarred: (starred: boolean) => req('settings:setHarnessStarred', starred),

  // Updater
  getVersion: () => req('updater:getVersion'),
  checkForUpdates: () => req('updater:checkForUpdates'),
  quitAndInstall: () => req('updater:quitAndInstall'),

  // Shell
  openExternal: (url: string) => sig('shell:openExternal', url),

  // Resolve a dropped File's absolute path. File.path was removed in Electron 32+.
  getFilePath: (file: File) => webUtils.getPathForFile(file),

  // Performance monitor
  getPerfMetrics: () => req('perf:getMetrics'),

  // App-level events from menu
  onOpenSettings: (callback: () => void) => transport.onSignal('app:openSettings', () => callback()),
  onTogglePerfMonitor: (callback: () => void) => transport.onSignal('app:togglePerfMonitor', () => callback()),
  onOpenKeyboardShortcuts: (callback: () => void) => transport.onSignal('app:openKeyboardShortcuts', () => callback()),

  // Hooks
  acceptHooks: () => req('hooks:accept'),
  declineHooks: () => req('hooks:decline'),
  uninstallHooks: () => req('hooks:uninstall'),

  // PTY
  createTerminal: (
    id: string,
    cwd: string,
    cmd: string,
    args: string[],
    agentKind?: string,
    cols?: number,
    rows?: number
  ) => {
    sig('pty:create', id, cwd, cmd, args, agentKind, cols, rows)
  },
  writeTerminal: (id: string, data: string) => {
    sig('pty:write', id, data)
  },
  resizeTerminal: (id: string, cols: number, rows: number) => {
    sig('pty:resize', id, cols, rows)
  },
  killTerminal: (id: string) => {
    sig('pty:kill', id)
  },
  onTerminalData: (callback: DataCallback) =>
    transport.onSignal('terminal:data', (id, data) => {
      callback(id as string, data as string)
    }),
  // Terminal status + shell activity live in the main-process store now;
  // consumers read via useTerminals() in the renderer. terminal:data and
  // terminal:exit stay on direct channels.
  // Activity log — recordActivity is fully main-driven now (see
  // activity-deriver.ts); the renderer only reads the persisted log.
  getActivityLog: () => req('activity:get'),
  clearActivityLog: (worktreePath?: string) => req('activity:clear', worktreePath),

  onTerminalExit: (callback: ExitCallback) =>
    transport.onSignal('terminal:exit', (id, exitCode) => {
      callback(id as string, exitCode as number)
    }),

  // State transport (snapshot + event stream). Replaces ad-hoc per-field
  // getters and onXChanged subscriptions one slice at a time.
  getStateSnapshot: () => transport.getStateSnapshot(),
  onStateEvent: (callback: (event: unknown, seq: number) => void) =>
    transport.onStateEvent((event, seq) => callback(event, seq))
})

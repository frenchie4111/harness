import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { ElectronClientTransport } from './transport-electron'
import { WebSocketClientTransport } from '../shared/transport/transport-websocket'
import { findRemoteUrl, splitRemoteUrl } from './find-remote-url'
import type { ClientTransport } from '../shared/transport/transport'

// Every window.api method is a thin wrapper over the client transport.
// The transport owns all ipcRenderer interaction; this file just
// declares the named channels + arg shapes that make up the
// renderer/main contract. Swapping transports (WebSocket, SSH stdio)
// means constructing a different ClientTransport here — no other change
// is needed above this layer.
//
// Remote mode: if the BrowserWindow was launched with
// `--harness-remote-url=<ws-url>` (set by desktop-shell-remote.ts when
// HARNESS_REMOTE_URL is in the environment), swap in the WebSocket
// transport so the renderer drives a remote harness-server instead of a
// local main process. The api surface above the transport stays
// identical; the connection failure UI is handled in renderer/main.tsx
// when initStore() rejects.

const remoteUrlRaw = findRemoteUrl(process.argv)
const isRemote = !!remoteUrlRaw
let transport: ClientTransport
if (remoteUrlRaw) {
  const split = splitRemoteUrl(remoteUrlRaw)
  if (!split) {
    throw new Error(`HARNESS_REMOTE_URL is not a valid URL: ${remoteUrlRaw}`)
  }
  transport = new WebSocketClientTransport({ url: split.url, token: split.token })
} else {
  transport = new ElectronClientTransport()
}

// Multi-backend (Tier 1): expose the local transport as a plain object
// so the renderer's BackendsRegistry can wire it up directly to the
// local backend's mirrored ClientStore. Remote backends construct their
// own WebSocketClientTransport in renderer code; this handle only ever
// fronts the in-process Electron main.
//
// The plain-object shape is identical to the ClientTransport interface
// — duck-typed across the contextBridge so the renderer can treat it as
// one without importing the class. Same underlying instance as the
// `window.api` transport below, so events fan out cleanly.
import type { LocalTransportHandle } from '../shared/transport/transport'
const localTransportHandle: LocalTransportHandle = {
  getStateSnapshot: () => transport.getStateSnapshot(),
  onStateEvent: (cb) => transport.onStateEvent((event, seq) => cb(event, seq)),
  request: (name, ...args) => transport.request(name, ...args),
  send: (name, ...args) => transport.send(name, ...args),
  onSignal: (name, handler) => transport.onSignal(name, handler),
  getClientId: () => transport.getClientId()
}
contextBridge.exposeInMainWorld('__harness_local_transport', localTransportHandle)

// Active routing target for window.api (Tier 1 multi-backend UX).
// Starts as the local transport; the renderer's BackendsRegistry calls
// __harness_setActiveTransport() when the user switches backends so that
// every window.api.X(...) call goes to the right backend without
// callers needing to know.
//
// Caveat: existing onStateEvent / onSignal subscriptions captured the
// transport handle at registration time, so they keep firing for the
// PREVIOUS active transport after a swap. With only the local backend
// in the registry today this never fires; rebind/fan-out logic for
// multi-backend signals lands with the chip strip + add-backend wiring
// (step 7). See plans/tier-1-multi-backend-ux.md §L.
let currentImpl: LocalTransportHandle = localTransportHandle
contextBridge.exposeInMainWorld('__harness_setActiveTransport', (impl: LocalTransportHandle) => {
  currentImpl = impl
})

// Mark the renderer as running against a remote backend so existing
// `window.__HARNESS_WEB__` branches (RemoteFilePicker, playwright
// browser screenshot view, etc.) light up the same way they do in the
// browser web-client. The flag name predates remote-Electron mode but
// the meaning is the same: "no local Electron backend reachable, route
// everything through the transport."
contextBridge.exposeInMainWorld('__HARNESS_WEB__', isRemote)

// Local platform of the Electron host (always the machine running the
// BrowserWindow, even in remote-Electron mode where the transport routes
// to a remote server). Used by the renderer to render Linux-only window
// controls in the top-left when the OS frame is hidden.
contextBridge.exposeInMainWorld('__HARNESS_PLATFORM__', process.platform)

type DataCallback = (id: string, data: string) => void
type ExitCallback = (id: string, exitCode: number) => void

const req = (name: string, ...args: unknown[]): Promise<unknown> =>
  currentImpl.request(name, ...args)
const sig = (name: string, ...args: unknown[]): void => currentImpl.send(name, ...args)
// Always-local path for renderer-shell concerns (the connections list).
// Bypasses currentImpl so flipping the active backend never changes
// where these go — see plans/tier-1-multi-backend-ux.md §C/§G.
const reqLocal = (name: string, ...args: unknown[]): Promise<unknown> =>
  localTransportHandle.request(name, ...args)

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
  addRepoAtPath: (repoRoot: string) => req('repo:addAtPath', repoRoot),
  removeRepo: (repoRoot: string) => req('repo:remove', repoRoot),
  createNewProject: (opts: {
    parentDir: string
    name: string
    includeReadme: boolean
    gitignorePreset: 'none' | 'node' | 'python' | 'macos'
  }) => req('repo:createNewProject', opts),
  pickDirectory: (opts?: { defaultPath?: string; title?: string }) =>
    req('dialog:pickDirectory', opts),

  // Cross-runtime filesystem browsing (used by RemoteFilePicker over WS).
  listDir: (path: string, opts?: { showHidden?: boolean }) =>
    req('fs:listDir', path, opts),
  resolveHome: () => req('fs:resolveHome'),
  isGitRepo: (path: string) => req('fs:isGitRepo', path),

  // All files (tracked + untracked, respecting .gitignore)
  listAllFiles: (worktreePath: string) => req('worktree:listFiles', worktreePath),
  readWorktreeFile: (worktreePath: string, filePath: string) =>
    req('worktree:readFile', worktreePath, filePath),
  readWorktreeFileBinary: (worktreePath: string, filePath: string) =>
    req('worktree:readFileBinary', worktreePath, filePath),
  writeWorktreeFile: (worktreePath: string, filePath: string, contents: string) =>
    req('worktree:writeFile', worktreePath, filePath, contents),

  // Changed files
  getChangedFiles: (worktreePath: string, mode?: 'working' | 'branch') =>
    req('worktree:changedFiles', worktreePath, mode),
  watchChangedFiles: (worktreePath: string) =>
    sig('worktree:watchChangedFiles', worktreePath),
  unwatchChangedFiles: (worktreePath: string) =>
    sig('worktree:unwatchChangedFiles', worktreePath),
  onChangedFilesInvalidated: (callback: (worktreePath: string) => void) =>
    currentImpl.onSignal('worktree:changedFilesInvalidated', (path) => {
      callback(path as string)
    }),
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

  getWeeklyStats: () => req('stats:getWeekly'),

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
  setAutoApprovePermissions: (enabled: boolean) =>
    req('config:setAutoApprovePermissions', enabled),
  setAutoApproveSteerInstructions: (text: string) =>
    req('config:setAutoApproveSteerInstructions', text),
  setClaudeTuiFullscreen: (enabled: boolean) => req('config:setClaudeTuiFullscreen', enabled),
  setWsTransportEnabled: (enabled: boolean) => req('config:setWsTransportEnabled', enabled),
  setWsTransportPort: (port: number) => req('config:setWsTransportPort', port),
  setWsTransportHost: (host: string) => req('config:setWsTransportHost', host),
  getWsTransportInfo: () => req('config:getWsTransportInfo'),
  rotateWsToken: () => req('config:rotateWsToken'),
  getLanAddresses: () => req('net:getLanAddresses'),
  setBrowserToolsEnabled: (enabled: boolean) => req('config:setBrowserToolsEnabled', enabled),
  setBrowserToolsMode: (mode: 'view' | 'full') => req('config:setBrowserToolsMode', mode),
  setJsonModeClaudeTabs: (enabled: boolean) => req('config:setJsonModeClaudeTabs', enabled),
  setDefaultClaudeTabType: (value: 'xterm' | 'json') =>
    req('config:setDefaultClaudeTabType', value),
  setJsonModeChatDensity: (value: 'compact' | 'comfy') =>
    req('config:setJsonModeChatDensity', value),
  setJsonModeDefaultPermissionMode: (value: 'default' | 'acceptEdits' | 'plan') =>
    req('config:setJsonModeDefaultPermissionMode', value),
  setAutoSleepMinutes: (value: number) => req('config:setAutoSleepMinutes', value),
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
    currentImpl.onSignal('worktrees:externalCreate', (payload) => {
      callback(payload as { repoRoot: string; worktree: unknown; initialPrompt?: string })
    }),
  setNameClaudeSessions: (enabled: boolean) => req('config:setNameClaudeSessions', enabled),
  setTheme: (theme: string) => req('config:setTheme', theme),
  setCostsInterest: (expanded: boolean) => req('costs:setInterest', expanded),
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
  panesConvertTabType: (
    wtPath: string,
    tabId: string,
    newType: 'agent' | 'json-claude'
  ) => req('panes:convertTabType', wtPath, tabId, newType),
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
  panesSleepTab: (wtPath: string, tabId: string) => req('panes:sleepTab', wtPath, tabId),
  panesWakeTab: (wtPath: string, tabId: string) => req('panes:wakeTab', wtPath, tabId),

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
  readRecentLog: (maxLines?: number) => req('debug:readRecentLog', maxLines),
  checkForUpdates: () => req('updater:checkForUpdates'),
  quitAndInstall: () => req('updater:quitAndInstall'),

  // Shell — in remote mode, route through window.open so the URL opens on
  // the viewing client's machine (intercepted by setWindowOpenHandler in
  // desktop-shell-remote.ts, or handled natively by the browser in the
  // web client). In native mode, signal main to call shell.openExternal.
  openExternal: (url: string) => {
    if (isRemote) {
      window.open(url, '_blank', 'noopener,noreferrer')
    } else {
      sig('shell:openExternal', url)
    }
  },
  openDebugLog: () => req('debug:openLog'),
  showDebugLogInFolder: () => req('debug:showLogInFolder'),

  // Resolve a dropped File's absolute path. File.path was removed in Electron 32+.
  getFilePath: (file: File) => webUtils.getPathForFile(file),

  // Performance monitor
  getPerfMetrics: () => req('perf:getMetrics'),
  perfLogSlowRender: (id: string, ms: number, phase: string) =>
    sig('perf:logSlowRender', id, ms, phase),

  // Renderer error-boundary reporting. Error + ErrorInfo don't cross
  // structured-clone cleanly, so we flatten to strings here.
  logError: (
    label: string,
    error: { name?: string; message?: string; stack?: string },
    info?: { componentStack?: string | null }
  ) =>
    req(
      'debug:logError',
      label,
      error?.name ?? 'Error',
      error?.message ?? '',
      error?.stack ?? '',
      info?.componentStack ?? ''
    ),

  // Window controls — bypass the transport because in remote-Electron
  // mode the transport routes to the remote harness-server, but the
  // BrowserWindow being controlled is local. Always reaches local main
  // via ipcRenderer.
  windowMinimize: () => ipcRenderer.send('window:minimize'),
  windowToggleMaximize: () => ipcRenderer.send('window:toggleMaximize'),
  windowClose: () => ipcRenderer.send('window:close'),

  // App-level events from menu — always-local: only the local Electron's
  // Menu fires these (a remote `harness-server` has no menu). Bind to
  // localTransportHandle directly so they keep working regardless of
  // which backend is active.
  onOpenSettings: (callback: () => void) =>
    localTransportHandle.onSignal('app:openSettings', () => callback()),
  onTogglePerfMonitor: (callback: () => void) =>
    localTransportHandle.onSignal('app:togglePerfMonitor', () => callback()),
  onOpenKeyboardShortcuts: (callback: () => void) =>
    localTransportHandle.onSignal('app:openKeyboardShortcuts', () => callback()),
  onOpenNewProject: (callback: () => void) =>
    localTransportHandle.onSignal('menu:newProject', () => callback()),
  onOpenReportIssue: (callback: () => void) =>
    localTransportHandle.onSignal('app:openReportIssue', () => callback()),
  onDebugCrashFocusedTab: (callback: () => void) =>
    localTransportHandle.onSignal('app:debugCrashFocusedTab', () => callback()),

  // Hooks
  acceptHooks: () => req('hooks:accept'),
  declineHooks: () => req('hooks:decline'),
  uninstallHooks: () => req('hooks:uninstall'),

  // Browser tabs (WebContentsView-backed)
  browserNavigate: (tabId: string, url: string) => req('browser:navigate', tabId, url),
  browserBack: (tabId: string) => req('browser:back', tabId),
  browserForward: (tabId: string) => req('browser:forward', tabId),
  browserReload: (tabId: string) => req('browser:reload', tabId),
  browserOpenDevTools: (tabId: string) => req('browser:openDevTools', tabId),
  browserSetBounds: (
    tabId: string,
    bounds: { x: number; y: number; width: number; height: number } | null
  ) => {
    sig('browser:setBounds', tabId, bounds)
  },
  browserHide: (tabId: string) => {
    sig('browser:hide', tabId)
  },
  browserScreenshot: (
    tabId: string,
    opts?: { format?: 'jpeg' | 'png'; quality?: number }
  ) => req('browser:screenshot', tabId, opts),
  browserClick: (
    tabId: string,
    x: number,
    y: number,
    opts?: { button?: 'left' | 'right' | 'middle'; clickCount?: number }
  ) => req('browser:click', tabId, x, y, opts),
  browserType: (tabId: string, text: string, key?: string) =>
    req('browser:type', tabId, text, key),
  browserScroll: (tabId: string, dx: number, dy: number) =>
    req('browser:scroll', tabId, dx, dy),

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
  // tmux-style session control — see src/shared/state/terminals.ts sessions map.
  joinTerminal: (id: string) => {
    sig('terminal:join', id)
  },
  leaveTerminal: (id: string) => {
    sig('terminal:leave', id)
  },
  takeTerminalControl: (id: string, cols: number, rows: number) => {
    sig('terminal:takeControl', id, cols, rows)
  },
  onTerminalData: (callback: DataCallback) =>
    currentImpl.onSignal('terminal:data', (id, data) => {
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
    currentImpl.onSignal('terminal:exit', (id, exitCode) => {
      callback(id as string, exitCode as number)
    }),

  // JSON-mode Claude — approval bridge + session lifecycle.
  resolveJsonClaudeApproval: (
    requestId: string,
    result: {
      behavior: 'allow' | 'deny'
      updatedInput?: Record<string, unknown>
      updatedPermissions?: unknown[]
      message?: string
      interrupt?: boolean
    }
  ) => req('jsonClaude:resolveApproval', requestId, result),
  rerunJsonClaudeAutoApprovalReview: (requestId: string) =>
    req('jsonClaude:rerunAutoApprovalReview', requestId),
  startJsonClaude: (id: string, cwd: string) =>
    req('jsonClaude:start', id, cwd),
  sendJsonClaudeMessage: (
    id: string,
    text: string,
    images?: Array<{ mediaType: string; data: string; path: string }>
  ) => sig('jsonClaude:send', id, text, images),
  cancelQueuedJsonClaudeMessage: (id: string, messageId: string) =>
    sig('jsonClaude:cancelQueued', id, messageId),
  writeJsonClaudeAttachmentImage: (
    base64: string,
    mediaType: string
  ): Promise<string | null> =>
    req('jsonClaude:writeAttachmentImage', base64, mediaType) as Promise<
      string | null
    >,
  readJsonClaudeAttachmentImage: (path: string): Promise<string | null> =>
    req('jsonClaude:readAttachmentImage', path) as Promise<string | null>,
  getJsonClaudeEntries: (sessionId: string) =>
    req('jsonClaude:getEntries', sessionId),
  killJsonClaude: (id: string) => req('jsonClaude:kill', id),
  interruptJsonClaude: (id: string) => req('jsonClaude:interrupt', id),
  openJsonClaudeAuthLoginTab: (worktreePath: string) =>
    req('jsonClaude:openAuthLoginTab', worktreePath),
  setJsonClaudePermissionMode: (
    id: string,
    mode: 'default' | 'acceptEdits' | 'plan'
  ) => req('jsonClaude:setPermissionMode', id, mode),
  grantJsonClaudeSessionToolApprovals: (id: string, toolNames: string[]) =>
    req('jsonClaude:grantSessionToolApprovals', id, toolNames),
  clearJsonClaudeSessionToolApprovals: (id: string, toolNames?: string[]) =>
    req('jsonClaude:clearSessionToolApprovals', id, toolNames),

  // State transport (snapshot + event stream). Routes to active backend
  // so XTerminal's font cache and similar listeners follow active. The
  // BackendsRegistry uses the lower-level __harness_local_transport
  // handle directly to wire each backend's store, independent of
  // routing.
  getStateSnapshot: () => currentImpl.getStateSnapshot(),
  onStateEvent: (callback: (event: unknown, seq: number) => void) =>
    currentImpl.onStateEvent((event, seq) => callback(event, seq)),

  // Server-assigned identity of this client wrt the active backend.
  getClientId: () => currentImpl.getClientId(),

  // Multi-backend connections list (Tier 1). These always route to the
  // local Electron's transport since the connections list is renderer-
  // shell-owned (see plans/tier-1-multi-backend-ux.md §C/§G). Never
  // forwarded to remote backends — they don't manage other backends.
  connectionsList: () => reqLocal('connections:list'),
  connectionsAdd: (
    input: { label: string; url: string; kind: 'remote'; color?: string; initials?: string },
    token: string
  ) => reqLocal('connections:add', input, token),
  connectionsRemove: (id: string) => reqLocal('connections:remove', id),
  connectionsRename: (id: string, label: string) =>
    reqLocal('connections:rename', id, label),
  connectionsSetActive: (id: string) => reqLocal('connections:setActive', id),
  connectionsSetLastConnected: (id: string, when?: number) =>
    reqLocal('connections:setLastConnected', id, when),
  connectionsGetToken: (id: string) => reqLocal('connections:getToken', id),
  connectionsHasToken: (id: string) => reqLocal('connections:hasToken', id)
})

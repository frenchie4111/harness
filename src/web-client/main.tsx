// Web-client entry point. Drives the existing renderer App over a
// WebSocket connection to a remote Harness main process.
//
// This file constructs a `window.api` shim that satisfies the
// ElectronAPI contract using `WebSocketClientTransport.request/send`
// for everything that has a WS-level handler in main, and stubs
// (no-ops + console.warn) for surfaces that genuinely require Electron
// (native dialogs, WebContentsView browser tabs, drag-drop file paths,
// in-app menu triggers driven from the user's local OS menu bar).
//
// The shape of the wire calls mirrors `src/preload/index.ts` exactly —
// every channel name + arg list is the same. Maintaining parity by
// copying the file's structure is intentional: the contract lives in
// channel names, not in a shared TS interface, so reading the two
// side-by-side is the easiest way to verify completeness.

import '../renderer/styles.css'
import { Profiler, type ProfilerOnRenderCallback } from 'react'
import { createRoot } from 'react-dom/client'
import App from '../renderer/App'
import { initStore } from '../renderer/store'
import { defineHarnessTheme } from '../renderer/monaco-setup'
import { renderMetrics } from '../renderer/render-metrics'
import { ErrorBoundary } from '../renderer/components/ErrorBoundary'
import { WebSocketClientTransport } from '../renderer/transport-websocket'
import type { ElectronAPI } from '../renderer/types'

declare global {
  interface Window {
    /** True when the renderer is running in the WS-connected web client
     *  (vs. the Electron preload). Components can branch on this to hide
     *  Electron-only affordances. */
    __HARNESS_WEB__?: boolean
  }
}

const onRender: ProfilerOnRenderCallback = (_id, _phase, actualDuration) => {
  renderMetrics.record(actualDuration)
}

function readToken(): string | null {
  const meta = document.querySelector(
    'meta[name="harness-ws-token"]'
  ) as HTMLMetaElement | null
  if (meta?.content) return meta.content
  const url = new URL(window.location.href)
  return url.searchParams.get('token')
}

function buildApi(transport: WebSocketClientTransport): ElectronAPI {
  const req = (name: string, ...args: unknown[]): Promise<unknown> =>
    transport.request(name, ...args)
  const sig = (name: string, ...args: unknown[]): void =>
    transport.send(name, ...args)
  const onSig = (name: string, handler: (...args: unknown[]) => void): (() => void) =>
    transport.onSignal(name, handler)

  // Stub helper: log once per channel + return the given fallback. Used
  // for Electron-only surfaces that have no WS equivalent. The goal is
  // "boots and doesn't throw," not feature parity.
  const warned = new Set<string>()
  function unavailable<T>(name: string, fallback: T): T {
    if (!warned.has(name)) {
      warned.add(name)
      // eslint-disable-next-line no-console
      console.warn(`[harness-web] '${name}' is unavailable in the web client`)
    }
    return fallback
  }

  const api: ElectronAPI = {
    listWorktrees: (repoRoot) => req('worktree:list', repoRoot) as ReturnType<ElectronAPI['listWorktrees']>,
    listBranches: (repoRoot) => req('worktree:branches', repoRoot) as ReturnType<ElectronAPI['listBranches']>,

    runPendingWorktree: (params) =>
      req('worktrees:runPending', params) as ReturnType<ElectronAPI['runPendingWorktree']>,
    retryPendingWorktree: (id) =>
      req('worktrees:retryPending', id) as ReturnType<ElectronAPI['retryPendingWorktree']>,
    dismissPendingWorktree: (id) =>
      req('worktrees:dismissPending', id) as Promise<boolean>,
    refreshWorktreesList: () => req('worktrees:refreshList') as Promise<boolean>,

    continueWorktree: (repoRoot, worktreePath, newBranchName, baseBranch) =>
      req('worktree:continue', repoRoot, worktreePath, newBranchName, baseBranch) as ReturnType<
        ElectronAPI['continueWorktree']
      >,
    isWorktreeDirty: (path) => req('worktree:isDirty', path) as Promise<boolean>,
    removeWorktree: (repoRoot, path, force, removeMeta) =>
      req('worktree:remove', repoRoot, path, force, removeMeta) as ReturnType<
        ElectronAPI['removeWorktree']
      >,
    dismissPendingDeletion: (path) =>
      req('worktree:dismissPendingDeletion', path) as Promise<boolean>,
    getWorktreeDir: (repoRoot) => req('worktree:dir', repoRoot) as Promise<string>,

    listRepos: () => req('repo:list') as Promise<string[]>,
    // TODO(web): Electron's native folder picker is unreachable from a
    // browser. Long-term: serve a directory-listing API from main and
    // build an in-app picker UI; for v1 the user sets repo roots from
    // the desktop window before connecting from a browser.
    addRepo: () => Promise.resolve(unavailable('addRepo', null)),
    removeRepo: (repoRoot) => req('repo:remove', repoRoot) as Promise<boolean>,
    createNewProject: (opts) =>
      req('repo:createNewProject', opts) as ReturnType<ElectronAPI['createNewProject']>,
    // TODO(web): same as addRepo — needs a custom in-browser folder picker.
    pickDirectory: () => Promise.resolve(unavailable('pickDirectory', null)),

    getMainWorktreeStatus: (repoRoot) =>
      req('worktree:mainStatus', repoRoot) as ReturnType<ElectronAPI['getMainWorktreeStatus']>,
    prepareMainForMerge: (repoRoot) =>
      req('worktree:prepareMain', repoRoot) as ReturnType<ElectronAPI['prepareMainForMerge']>,
    previewMergeConflicts: (repoRoot, sourceBranch, worktreePath) =>
      req('worktree:previewMerge', repoRoot, sourceBranch, worktreePath) as ReturnType<
        ElectronAPI['previewMergeConflicts']
      >,
    mergeWorktreeLocally: (repoRoot, sourceBranch, strategy, worktreePath) =>
      req(
        'worktree:mergeLocal',
        repoRoot,
        sourceBranch,
        strategy,
        worktreePath
      ) as ReturnType<ElectronAPI['mergeWorktreeLocally']>,

    refreshPRsAll: () => req('prs:refreshAll') as Promise<boolean>,
    refreshPRsAllIfStale: () => req('prs:refreshAllIfStale') as Promise<boolean>,
    refreshPRsOne: (worktreePath) => req('prs:refreshOne', worktreePath) as Promise<boolean>,
    refreshPRsOneIfStale: (worktreePath) =>
      req('prs:refreshOneIfStale', worktreePath) as Promise<boolean>,

    getBranchCommits: (worktreePath) =>
      req('worktree:branchCommits', worktreePath) as ReturnType<ElectronAPI['getBranchCommits']>,
    getCommitDiff: (worktreePath, hash) =>
      req('worktree:commitDiff', worktreePath, hash) as ReturnType<ElectronAPI['getCommitDiff']>,
    getCommitChangedFiles: (worktreePath, hash) =>
      req('worktree:commitChangedFiles', worktreePath, hash) as ReturnType<
        ElectronAPI['getCommitChangedFiles']
      >,
    getCommitFileDiffSides: (worktreePath, hash, filePath) =>
      req('worktree:commitFileDiffSides', worktreePath, hash, filePath) as ReturnType<
        ElectronAPI['getCommitFileDiffSides']
      >,
    listAllFiles: (worktreePath) =>
      req('worktree:listFiles', worktreePath) as Promise<string[]>,
    readWorktreeFile: (worktreePath, filePath) =>
      req('worktree:readFile', worktreePath, filePath) as ReturnType<
        ElectronAPI['readWorktreeFile']
      >,
    writeWorktreeFile: (worktreePath, filePath, contents) =>
      req('worktree:writeFile', worktreePath, filePath, contents) as ReturnType<
        ElectronAPI['writeWorktreeFile']
      >,
    getChangedFiles: (worktreePath, mode) =>
      req('worktree:changedFiles', worktreePath, mode) as ReturnType<
        ElectronAPI['getChangedFiles']
      >,
    getFileDiff: (worktreePath, filePath, staged, mode) =>
      req(
        'worktree:fileDiff',
        worktreePath,
        filePath,
        staged,
        mode
      ) as Promise<string>,
    getFileDiffSides: (worktreePath, filePath, staged, mode) =>
      req(
        'worktree:fileDiffSides',
        worktreePath,
        filePath,
        staged,
        mode
      ) as ReturnType<ElectronAPI['getFileDiffSides']>,

    setHotkeyOverrides: (hotkeys) =>
      req('config:setHotkeys', hotkeys) as Promise<boolean>,
    resetHotkeyOverrides: () => req('config:resetHotkeys') as Promise<boolean>,
    setClaudeCommand: (command) =>
      req('config:setClaudeCommand', command) as Promise<boolean>,
    getDefaultClaudeCommand: () =>
      req('config:getDefaultClaudeCommand') as Promise<string>,
    setHarnessMcpEnabled: (enabled) =>
      req('config:setHarnessMcpEnabled', enabled) as Promise<boolean>,
    setClaudeTuiFullscreen: (enabled) =>
      req('config:setClaudeTuiFullscreen', enabled) as Promise<boolean>,
    setWsTransportEnabled: (enabled) =>
      req('config:setWsTransportEnabled', enabled) as Promise<boolean>,
    setWsTransportPort: (port) =>
      req('config:setWsTransportPort', port) as Promise<number>,
    setWsTransportHost: (host) =>
      req('config:setWsTransportHost', host) as Promise<string>,
    getWsTransportInfo: () =>
      req('config:getWsTransportInfo') as ReturnType<ElectronAPI['getWsTransportInfo']>,
    setBrowserToolsEnabled: (enabled) =>
      req('config:setBrowserToolsEnabled', enabled) as Promise<boolean>,
    setBrowserToolsMode: (mode) =>
      req('config:setBrowserToolsMode', mode) as Promise<boolean>,
    setAutoUpdateEnabled: (enabled) =>
      req('config:setAutoUpdateEnabled', enabled) as Promise<boolean>,
    setShareClaudeSettings: (enabled) =>
      req('config:setShareClaudeSettings', enabled) as Promise<boolean>,
    setHarnessSystemPromptEnabled: (enabled) =>
      req('config:setHarnessSystemPromptEnabled', enabled) as Promise<boolean>,
    setHarnessSystemPrompt: (prompt) =>
      req('config:setHarnessSystemPrompt', prompt) as Promise<boolean>,
    setHarnessSystemPromptMain: (prompt) =>
      req('config:setHarnessSystemPromptMain', prompt) as Promise<boolean>,
    prepareMcpForTerminal: (terminalId) =>
      req('mcp:prepareForTerminal', terminalId) as Promise<string | null>,
    onWorktreesExternalCreate: (callback) =>
      onSig('worktrees:externalCreate', (payload) =>
        callback(
          payload as { repoRoot: string; worktree: ReturnType<ElectronAPI['listWorktrees']> extends Promise<infer A> ? A extends Array<infer W> ? W : never : never; initialPrompt?: string }
        )
      ),
    setClaudeEnvVars: (vars) =>
      req('config:setClaudeEnvVars', vars) as Promise<boolean>,
    setDefaultAgent: (agent) =>
      req('config:setDefaultAgent', agent) as Promise<boolean>,
    setCodexCommand: (command) =>
      req('config:setCodexCommand', command) as Promise<boolean>,
    setClaudeModel: (model) =>
      req('config:setClaudeModel', model) as Promise<boolean>,
    setCodexModel: (model) =>
      req('config:setCodexModel', model) as Promise<boolean>,
    setCodexEnvVars: (vars) =>
      req('config:setCodexEnvVars', vars) as Promise<boolean>,
    setNameClaudeSessions: (enabled) =>
      req('config:setNameClaudeSessions', enabled) as Promise<boolean>,
    setTheme: (theme) => req('config:setTheme', theme) as Promise<boolean>,
    getAvailableThemes: () =>
      req('config:getAvailableThemes') as Promise<readonly string[]>,
    setTerminalFontFamily: (fontFamily) =>
      req('config:setTerminalFontFamily', fontFamily) as Promise<boolean>,
    getDefaultTerminalFontFamily: () =>
      req('config:getDefaultTerminalFontFamily') as Promise<string>,
    setTerminalFontSize: (fontSize) =>
      req('config:setTerminalFontSize', fontSize) as Promise<boolean>,
    setOnboardingQuest: (quest) =>
      req('config:setOnboardingQuest', quest) as Promise<boolean>,
    setWorktreeScripts: (scripts) =>
      req('config:setWorktreeScripts', scripts) as Promise<boolean>,
    setRepoConfig: (repoRoot, next) =>
      req('repoConfig:set', repoRoot, next) as ReturnType<ElectronAPI['setRepoConfig']>,
    setWorktreeBase: (mode) =>
      req('config:setWorktreeBase', mode) as Promise<boolean>,
    setMergeStrategy: (strategy) =>
      req('config:setMergeStrategy', strategy) as Promise<boolean>,
    setEditor: (editorId) => req('config:setEditor', editorId) as Promise<boolean>,
    getAvailableEditors: () =>
      req('config:getAvailableEditors') as ReturnType<ElectronAPI['getAvailableEditors']>,
    // TODO(web): the editor:open handler shells out on the host machine
    // — opening it from a browser would launch the editor on whichever
    // box is *running main*, not the one the user is sitting at. The
    // current behavior (open on the host) is probably what most users
    // want for a remote driver, so we still forward.
    openInEditor: (worktreePath, filePath) =>
      req('editor:open', worktreePath, filePath) as ReturnType<
        ElectronAPI['openInEditor']
      >,

    panesAddTab: (wtPath, tab, paneId) =>
      req('panes:addTab', wtPath, tab, paneId) as Promise<boolean>,
    panesCloseTab: (wtPath, tabId) =>
      req('panes:closeTab', wtPath, tabId) as Promise<boolean>,
    panesRestartAgentTab: (wtPath, tabId, newId) =>
      req('panes:restartAgentTab', wtPath, tabId, newId) as Promise<boolean>,
    panesSelectTab: (wtPath, paneId, tabId) =>
      req('panes:selectTab', wtPath, paneId, tabId) as Promise<boolean>,
    panesReorderTabs: (wtPath, paneId, fromId, toId) =>
      req('panes:reorderTabs', wtPath, paneId, fromId, toId) as Promise<boolean>,
    panesMoveTabToPane: (wtPath, tabId, toPaneId, toIndex) =>
      req('panes:moveTabToPane', wtPath, tabId, toPaneId, toIndex) as Promise<boolean>,
    panesSplitPane: (wtPath, fromPaneId, direction) =>
      req('panes:splitPane', wtPath, fromPaneId, direction) as ReturnType<
        ElectronAPI['panesSplitPane']
      >,
    panesSetRatio: (wtPath, splitId, ratio) =>
      req('panes:setRatio', wtPath, splitId, ratio) as Promise<boolean>,
    panesClearForWorktree: (wtPath) =>
      req('panes:clearForWorktree', wtPath) as Promise<boolean>,
    panesEnsureInitialized: (wtPath) =>
      req('panes:ensureInitialized', wtPath) as Promise<boolean>,
    getTerminalHistory: (id) => req('terminal:getHistory', id) as Promise<string>,
    clearTerminalHistory: (id) =>
      req('terminal:forgetHistory', id) as Promise<boolean>,
    agentSessionFileExists: (cwd, sessionId, agentKind) =>
      req('agent:sessionFileExists', cwd, sessionId, agentKind) as Promise<boolean>,
    getLatestAgentSessionId: (cwd, agentKind) =>
      req('agent:latestSessionId', cwd, agentKind) as Promise<string | null>,
    buildAgentSpawnArgs: (agentKind, opts) =>
      req('agent:buildSpawnArgs', agentKind, opts) as Promise<string>,

    hasGithubToken: () => req('settings:hasGithubToken') as Promise<boolean>,
    setGithubToken: (token) =>
      req('settings:setGithubToken', token) as ReturnType<ElectronAPI['setGithubToken']>,
    clearGithubToken: () => req('settings:clearGithubToken') as Promise<boolean>,
    setHarnessStarred: (starred) =>
      req('settings:setHarnessStarred', starred) as ReturnType<
        ElectronAPI['setHarnessStarred']
      >,

    getVersion: () => req('updater:getVersion') as Promise<string>,
    readRecentLog: (maxLines) =>
      req('debug:readRecentLog', maxLines) as Promise<string>,
    checkForUpdates: () =>
      req('updater:checkForUpdates') as ReturnType<ElectronAPI['checkForUpdates']>,
    quitAndInstall: () => req('updater:quitAndInstall') as Promise<boolean>,

    getPerfMetrics: () =>
      req('perf:getMetrics') as ReturnType<ElectronAPI['getPerfMetrics']>,

    logError: (label, error, info) =>
      req(
        'debug:logError',
        label,
        error?.name ?? 'Error',
        error?.message ?? '',
        error?.stack ?? '',
        info?.componentStack ?? ''
      ) as Promise<boolean>,

    // External link clicks: window.open is the closest browser equivalent
    // to shell.openExternal. We avoid forwarding to main because main
    // would open the link on the *host's* desktop, not the viewer's.
    openExternal: (url) => {
      try {
        window.open(url, '_blank', 'noopener,noreferrer')
      } catch {
        unavailable('openExternal', undefined)
      }
    },
    // TODO(web): file drag-drop in a browser exposes File objects that
    // don't have a real on-disk path. A future iteration could upload
    // the dropped contents to main; for v1 callers see an empty string
    // and the drop is effectively a no-op.
    getFilePath: () => unavailable('getFilePath', ''),

    // App-level menu signals — broadcast by main when the user picks an
    // item from the OS menu bar in the desktop app. The web client also
    // subscribes so it stays in sync if a menu action fires while a
    // browser is connected.
    onOpenSettings: (callback) => onSig('app:openSettings', () => callback()),
    onTogglePerfMonitor: (callback) =>
      onSig('app:togglePerfMonitor', () => callback()),
    onOpenKeyboardShortcuts: (callback) =>
      onSig('app:openKeyboardShortcuts', () => callback()),
    onOpenNewProject: (callback) => onSig('menu:newProject', () => callback()),
    onOpenReportIssue: (callback) =>
      onSig('app:openReportIssue', () => callback()),
    onDebugCrashFocusedTab: (callback) =>
      onSig('app:debugCrashFocusedTab', () => callback()),

    acceptHooks: () => req('hooks:accept') as Promise<boolean>,
    declineHooks: () => req('hooks:decline') as Promise<boolean>,
    uninstallHooks: () => req('hooks:uninstall') as Promise<boolean>,

    // TODO(web): Browser tabs are backed by Electron WebContentsView and
    // have no equivalent in a browser. A future iteration could swap in
    // an iframe-based substitute for non-X-Frame-Options pages, but it's
    // a separate worktree. For now: navigate is forwarded so the URL
    // gets persisted on the desktop side, but bounds/hide/devtools are
    // no-ops and the BrowserPanel will render empty in the web client.
    browserNavigate: (tabId, url) =>
      req('browser:navigate', tabId, url) as Promise<boolean>,
    browserBack: (tabId) => req('browser:back', tabId) as Promise<boolean>,
    browserForward: (tabId) => req('browser:forward', tabId) as Promise<boolean>,
    browserReload: (tabId) => req('browser:reload', tabId) as Promise<boolean>,
    browserOpenDevTools: (tabId) =>
      Promise.resolve(unavailable(`browserOpenDevTools(${tabId})`, true)),
    browserSetBounds: (_tabId, _bounds) => {
      // No-op in web mode — the bounds drive a native overlay window.
    },
    browserHide: (_tabId) => {
      // No-op in web mode.
    },

    createTerminal: (id, cwd, cmd, args, agentKind, cols, rows) => {
      sig('pty:create', id, cwd, cmd, args, agentKind, cols, rows)
    },
    writeTerminal: (id, data) => {
      sig('pty:write', id, data)
    },
    resizeTerminal: (id, cols, rows) => {
      sig('pty:resize', id, cols, rows)
    },
    killTerminal: (id) => {
      sig('pty:kill', id)
    },
    onTerminalData: (callback) =>
      onSig('terminal:data', (id, data) =>
        callback(id as string, data as string)
      ),
    onTerminalExit: (callback) =>
      onSig('terminal:exit', (id, exitCode) =>
        callback(id as string, exitCode as number)
      ),

    getActivityLog: () =>
      req('activity:get') as ReturnType<ElectronAPI['getActivityLog']>,
    clearActivityLog: (worktreePath) =>
      req('activity:clear', worktreePath) as Promise<boolean>,

    getStateSnapshot: () => transport.getStateSnapshot(),
    onStateEvent: (callback) =>
      transport.onStateEvent((event, seq) => callback(event, seq))
  }

  return api
}

async function boot(): Promise<void> {
  const token = readToken()
  if (!token) {
    document.body.innerHTML =
      '<pre style="padding:24px;color:#fff;background:#222;font-family:monospace;">' +
      'No Harness auth token. Open this page from the URL printed by the main process,\n' +
      'e.g. http://&lt;host&gt;:37291/?token=&lt;token&gt;.</pre>'
    return
  }

  const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const wsUrl = `${wsProto}//${window.location.host}/`

  const transport = new WebSocketClientTransport({ url: wsUrl, token })
  // Connect up front so the first getStateSnapshot() inside initStore()
  // doesn't race the open handshake.
  await transport.connect()

  window.__HARNESS_WEB__ = true
  window.api = buildApi(transport)

  await initStore()
  defineHarnessTheme()
  createRoot(document.getElementById('root')!).render(
    <ErrorBoundary label="app:root" showReload>
      <Profiler id="app" onRender={onRender}>
        <App />
      </Profiler>
    </ErrorBoundary>
  )
}

void boot()

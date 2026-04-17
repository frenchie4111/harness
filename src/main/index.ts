import { app, autoUpdater as nativeAutoUpdater, BrowserWindow, dialog, Menu, screen, shell } from 'electron'
import { autoUpdater } from 'electron-updater'
import { existsSync, readdirSync, statSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { PtyManager } from './pty-manager'
import { Store } from './store'
import { ElectronServerTransport } from './transport-electron'
import { PerfMonitor } from './perf-monitor'
import { PRPoller } from './pr-poller'
import { WorktreesFSM } from './worktrees-fsm'
import { WorktreeDeletionFSM } from './worktree-deletion-fsm'
import { PanesFSM, stripTransientTabFields } from './panes-fsm'
import { ActivityDeriver } from './activity-deriver'
import type { TerminalTab, WorkspacePane } from '../shared/state/terminals'
import { listWorktrees, listBranches, continueWorktree, isWorktreeDirty, defaultWorktreeDir, getChangedFiles, getFileDiff, getBranchCommits, getCommitDiff, getMainWorktreeStatus, prepareMainForMerge, mergeWorktreeLocally, getBranchSha, previewMergeConflicts, getBranchDiffStats, listAllFiles, readWorktreeFile, writeWorktreeFile, getFileDiffSides, type MergeStrategy } from './worktree'
import { getPRStatus, testToken, starRepo, unstarRepo, isRepoStarred } from './github'
import { AVAILABLE_EDITORS, DEFAULT_EDITOR_ID, openInEditor } from './editor'
import { setSecret, hasSecret, deleteSecret } from './secrets'
import { resolveGitHubToken, getTokenSource, invalidateTokenCache, getCachedToken } from './github-auth'
import {
  loadConfig,
  saveConfig,
  saveConfigSync,
  DEFAULT_CLAUDE_COMMAND,
  DEFAULT_THEME,
  AVAILABLE_THEMES,
  THEME_APP_BG,
  DEFAULT_TERMINAL_FONT_FAMILY,
  DEFAULT_TERMINAL_FONT_SIZE,
  DEFAULT_WORKTREE_BASE,
  DEFAULT_MERGE_STRATEGY,
  pruneTerminalHistory,
  type PersistedPane,
  type QuestStep
} from './persistence'
import { loadRepoConfig, saveRepoConfig, type RepoConfig } from './repo-config'
import { isWorktreeMerged } from '../shared/state/prs'
import { watchStatusDir } from './hooks'
import { getAgent, type AgentKind } from './agents'

function toAgentKind(value: string | undefined): AgentKind {
  return value === 'codex' ? 'codex' : 'claude'
}
import { CostTracker } from './cost-tracker'
import { startControlServer } from './control-server'
import { writeMcpConfigForTerminal, pruneMcpConfigs } from './mcp-config'
import { recordActivity, getActivityLog, clearAllActivity, clearActivityForWorktree, sealAllActive, touchActivityMeta, finalizeActivity, type ActivityState, type PRState } from './activity'
import { log, getLogFilePath } from './debug'
import { buildInitialAppState } from './build-initial-state'

// In dev, use a separate userData dir so a running dev instance doesn't
// fight with the installed prod app over config.json / activity.json / etc.
if (!app.isPackaged) {
  app.setPath('userData', join(app.getPath('appData'), 'Harness (Dev)'))
}

const ptyManager = new PtyManager()
let config = loadConfig()
let stopWatchingStatus: (() => void) | null = null

const store = new Store(buildInitialAppState(config, { hasGithubToken: hasSecret('githubToken') }))
const perfMonitor = new PerfMonitor()
const transport = new ElectronServerTransport(store, perfMonitor)
transport.start()

// Tails Claude Code session jsonl transcripts on Stop hook events,
// sums per-model usage, and dispatches costs/usageUpdated. See
// src/main/cost-tracker.ts and src/shared/state/costs.ts.
const costTracker = new CostTracker(store)
costTracker.start()

// Auto-persist the costs slice to config.json on each change. Debounced
// inside saveConfig; cheap to fire on every dispatch.
store.subscribe((event) => {
  if (event.type.startsWith('costs/')) {
    config.costs = store.getSnapshot().state.costs
    saveConfig(config)
  }
})

// When a session ID is discovered from a hook event (e.g. Codex assigns
// its own session ID), persist panes immediately so the ID survives a quit.
store.subscribe((event) => {
  if (event.type === 'terminals/sessionIdDiscovered') {
    persistPanes(store.getSnapshot().state.terminals.panes)
  }
})

/** Query the harness star state, dispatch it to the slice, and auto-star
 *  exactly once per user (sticky so manual unstars survive reboots). Safe
 *  to call after any token resolution — boot, PAT save, etc. */
async function refreshHarnessStarState(): Promise<void> {
  const token = getCachedToken()
  if (!token) {
    store.dispatch({ type: 'settings/harnessStarredChanged', payload: null })
    return
  }
  const starred = await isRepoStarred(token, 'frenchie4111', 'harness')
  if (starred === false && !config.harnessAutoStarred) {
    const result = await starRepo(token, 'frenchie4111', 'harness')
    if (result.ok) {
      config.harnessAutoStarred = true
      saveConfig(config)
      store.dispatch({ type: 'settings/harnessStarredChanged', payload: true })
      log('app', 'auto-starred harness on first GitHub connection')
      return
    }
    log('app', 'auto-star failed', result.error)
  }
  store.dispatch({ type: 'settings/harnessStarredChanged', payload: starred })
}

const prPoller = new PRPoller(store, {
  getRepoRoots: () => config.repoRoots || [],
  getLocallyMerged: () => config.locallyMerged || {},
  setLocallyMerged: (next) => {
    if (Object.keys(next).length === 0) {
      delete config.locallyMerged
    } else {
      config.locallyMerged = next
    }
    saveConfig(config)
  }
})

ptyManager.setStore(store)
ptyManager.setSendSignal((channel, ...args) => transport.sendSignal(channel, ...args))
ptyManager.setPerfMonitor(perfMonitor)
perfMonitor.start(store, () => ptyManager.getActivePtyCount())

// Persist panes back to config in the existing nested-by-repo shape, so the
// on-disk format stays compatible with persistence-migrations. Strip
// transient (in-memory only) tab fields like initialPrompt before saving.
function persistPanes(panes: Record<string, WorkspacePane[]>): void {
  const nested: Record<string, Record<string, PersistedPane[]>> = {}
  for (const [wtPath, paneList] of Object.entries(panes)) {
    // Find which repo this worktree belongs to. Use the live worktree list
    // first; fall back to '__orphan__' for entries we can't map.
    const wt = store.getSnapshot().state.worktrees.list.find((w) => w.path === wtPath)
    const repoRoot = wt?.repoRoot || '__orphan__'
    const persistedPanes: PersistedPane[] = paneList
      .map((pane) => {
        const tabs = pane.tabs
          .filter((t) => t.type === 'agent' || t.type === 'shell')
          .map((t) => {
            const stripped = stripTransientTabFields(t as TerminalTab)
            return {
              id: stripped.id,
              type: stripped.type as 'agent' | 'shell',
              label: stripped.label,
              agentKind: stripped.agentKind,
              sessionId: stripped.sessionId
            }
          })
        if (tabs.length === 0) return null
        const validActive = tabs.some((t) => t.id === pane.activeTabId)
          ? pane.activeTabId
          : tabs[0].id
        return { id: pane.id, tabs, activeTabId: validActive }
      })
      .filter((p): p is NonNullable<typeof p> => p !== null)
    if (persistedPanes.length > 0) {
      if (!nested[repoRoot]) nested[repoRoot] = {}
      nested[repoRoot][wtPath] = persistedPanes
    }
  }
  config.panes = nested
  saveConfig(config)
}

// IMPORTANT — construction order is load-bearing.
//
// PanesFSM must be constructed BEFORE WorktreesFSM because WorktreesFSM's
// onWorktreeCreated callback (defined below) closes over `panesFSM`.
// JavaScript doesn't blow up at construction time because the closure
// only runs later, but if you reorder these and panesFSM is in the
// temporal dead zone when the callback fires, you'll get a
// ReferenceError that only surfaces when a worktree is created.
//
// The conceptual coupling — "creating a worktree triggers pane
// initialization" — used to live visibly in App.tsx where the renderer
// orchestrated both. After the state migration, it became an implicit
// contract between two main-side modules that this file wires together.
// If you ever refactor this further, consider inverting: have PanesFSM
// subscribe to `worktrees/listChanged` itself and call ensureInitialized
// on any new worktree. That would make the dependency direction explicit
// and remove the construction-order requirement.
const panesFSM = new PanesFSM(store, {
  persist: persistPanes,
  getRepoRootForWorktree: (wtPath) => {
    const wt = store.getSnapshot().state.worktrees.list.find((w) => w.path === wtPath)
    return wt?.repoRoot
  },
  getLatestClaudeSessionId: async (wtPath) => {
    const kind = store.getSnapshot().state.settings.defaultAgent ?? 'claude'
    return getAgent(kind).latestSessionId(wtPath)
  },
  getDefaultAgentKind: () => toAgentKind(store.getSnapshot().state.settings.defaultAgent)
})

const worktreesFSM = new WorktreesFSM(store, {
  getRepoRoots: () => config.repoRoots || [],
  getWorktreeSetupCmd: () => config.worktreeSetupCommand || '',
  getWorktreeBaseMode: () => config.worktreeBase || DEFAULT_WORKTREE_BASE,
  onWorktreeCreated: ({ createdPath, initialPrompt, teleportSessionId }) => {
    void prPoller.refreshAll()
    panesFSM.ensureInitialized(createdPath, { initialPrompt, teleportSessionId })
  }
})

const worktreeDeletionFSM = new WorktreeDeletionFSM(store, {
  getGlobalTeardownCmd: () => config.worktreeTeardownCommand || '',
  worktreesFSM
})

const activityDeriver = new ActivityDeriver(store)

/** Install agent status hooks at the user-scope settings file for both
 *  supported agents. Called once when consent flips to 'accepted'. The
 *  hook command is env-gated on $HARNESS_TERMINAL_ID, so it no-ops for
 *  sessions started outside Harness. */
function installHooksGlobally(): void {
  for (const agent of [getAgent('claude'), getAgent('codex')]) {
    if (!agent.hooksInstalled()) agent.installHooks()
  }
}

function uninstallHooksGlobally(): void {
  for (const agent of [getAgent('claude'), getAgent('codex')]) {
    agent.uninstallHooks()
  }
}

// Sleep-on-boot for merged worktrees.
//
// At boot, we don't want to spin up a Claude process for every worktree
// the user has lying around — most users have many old merged branches
// they'll never look at again. Instead, we wait for the first PR-poller
// pass to land (so we know which worktrees are merged), then init only
// the non-merged ones. Merged worktrees stay "asleep" until the user
// explicitly clicks them (the renderer fires panes:ensureInitialized on
// activation — see the useEffect on activeWorktreeId in App.tsx).
//
// Three cases the state machine has to handle:
//   1. Boot drain on prs/mergedChanged — happy path with a token + GH
//      reachable. Init non-merged paths from the pending queue.
//   2. Boot drain on 3s timeout — no token, no network, brand-new repo,
//      etc. Init everything in the pending queue unconditionally so we
//      don't strand the user.
//   3. Post-boot worktrees/listChanged — a repo is added later. Mirror
//      the previous behavior and init every wt unconditionally so any
//      newly-appearing worktree gets the default Claude+Shell pair.
//
// Rule: this only prevents *starting* Claude for merged-at-boot
// worktrees. If a PR flips to merged mid-session, the already-running
// Claude is left alone (the activity-deriver handles the visual merged
// treatment separately).
const BOOT_INIT_TIMEOUT_MS = 3000
let bootDrained = false
const pendingBootInit = new Set<string>()
let bootTimer: NodeJS.Timeout | null = null

function drainBootInit(force: boolean): void {
  if (bootDrained) return
  bootDrained = true
  if (bootTimer) {
    clearTimeout(bootTimer)
    bootTimer = null
  }
  const state = store.getSnapshot().state
  for (const path of pendingBootInit) {
    if (force || !isWorktreeMerged(state.prs, path)) {
      panesFSM.ensureInitialized(path)
    }
  }
  pendingBootInit.clear()
}

store.subscribe((event) => {
  if (event.type === 'worktrees/listChanged') {
    const list = store.getSnapshot().state.worktrees.list
    if (bootDrained) {
      for (const wt of list) panesFSM.ensureInitialized(wt.path)
      return
    }
    for (const wt of list) pendingBootInit.add(wt.path)
    if (!bootTimer) {
      bootTimer = setTimeout(() => drainBootInit(true), BOOT_INIT_TIMEOUT_MS)
    }
    return
  }
  if (event.type === 'prs/mergedChanged' && !bootDrained) {
    drainBootInit(false)
  }
})

function createWindow(): BrowserWindow {
  // First-launch defaults: aim for 1600x1000, but clamp to the primary
  // display's work area so smaller screens (13" MBP = 1440x900 native)
  // don't get a window that spills off-screen. Returning users' saved
  // windowBounds pass through untouched.
  const work = screen.getPrimaryDisplay().workAreaSize
  const bounds = config.windowBounds || {
    width: Math.min(1600, work.width - 40),
    height: Math.min(1000, work.height - 40),
    x: undefined!,
    y: undefined!
  }

  const win = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    ...(bounds.x != null ? { x: bounds.x, y: bounds.y } : {}),
    title: 'Harness',
    icon: join(__dirname, '../../resources/icon.png'),
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 12, y: 12 },
    backgroundColor: THEME_APP_BG[config.theme || DEFAULT_THEME] || THEME_APP_BG[DEFAULT_THEME],
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  // Route link clicks (xterm OSC 8 hyperlinks, anchor tags) to the system browser
  // instead of letting Electron spawn an in-app popup window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('mailto:')) {
      shell.openExternal(url)
    }
    return { action: 'deny' }
  })

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

  // Load renderer
  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

function registerIpcHandlers(): void {
  // Worktree handlers — every call takes an explicit repoRoot, since a single
  // window now shows worktrees from multiple repos at once.
  transport.onRequest('worktree:list', async (repoRoot: string) => {
    if (!repoRoot) return []
    const trees = await listWorktrees(repoRoot)
    for (const wt of trees) {
      touchActivityMeta(wt.path, { branch: wt.branch, repoRoot })
    }
    return trees
  })

  transport.onRequest('worktree:branches', async (repoRoot: string) => {
    if (!repoRoot) return []
    return listBranches(repoRoot)
  })

  // Worktree creation flows through the WorktreesFSM in main; main also
  // creates the default Claude+Shell pane pair (with the initial prompt
  // embedded) before the call returns. Renderer just awaits + focuses.
  transport.onRequest(
    'worktrees:runPending',
    async (params: {
      id: string
      repoRoot: string
      branchName: string
      initialPrompt?: string
      teleportSessionId?: string
    }) => {
      return worktreesFSM.runPending(params)
    }
  )
  transport.onRequest('worktrees:retryPending', async (id: string) => {
    return worktreesFSM.retryPending(id)
  })
  transport.onRequest('worktrees:dismissPending', (id: string) => {
    worktreesFSM.dismissPending(id)
    return true
  })
  transport.onRequest('worktrees:refreshList', async () => {
    await worktreesFSM.refreshList()
    return true
  })

  transport.onRequest(
    'worktree:continue',
    async (repoRoot: string, worktreePath: string, newBranchName: string, baseBranch?: string) => {
      if (!repoRoot) throw new Error('No repo root provided')
      const mode = config.worktreeBase || DEFAULT_WORKTREE_BASE
      return continueWorktree(repoRoot, worktreePath, newBranchName, {
        baseBranch,
        fetchRemote: !baseBranch && mode === 'remote'
      })
    }
  )

  transport.onRequest('worktree:isDirty', async (path: string) => {
    return isWorktreeDirty(path)
  })

  transport.onRequest('worktree:remove', async (
    repoRoot: string,
    path: string,
    force?: boolean,
    removeMeta?: { prNumber?: number; prState?: PRState }
  ) => {
    if (!repoRoot) throw new Error('No repo root provided')
    // Drop any locally-merged flag for the branch at this path. We still
    // need the worktree record for its branch name *before* kicking off
    // the async deletion.
    const trees = await listWorktrees(repoRoot)
    const wt = trees.find((t) => t.path === path)
    if (wt && config.locallyMerged && wt.branch && config.locallyMerged[wt.branch]) {
      delete config.locallyMerged[wt.branch]
      saveConfig(config)
    }
    // Capture final stats *before* the working tree is gone.
    const diffStats = await getBranchDiffStats(path)
    if (wt) touchActivityMeta(path, { branch: wt.branch, repoRoot })
    finalizeActivity(path, {
      diffStats,
      prNumber: removeMeta?.prNumber,
      prState: removeMeta?.prState
    })
    // Fire-and-forget: the WorktreeDeletionFSM runs the teardown script
    // and git worktree remove in the background, streaming progress
    // through the store. Returns immediately so the renderer can animate
    // the deletion card instead of freezing on the row.
    worktreeDeletionFSM.enqueue({
      repoRoot,
      path,
      branch: wt?.branch || '',
      force
    })
    return { queued: true }
  })

  transport.onRequest('worktree:dismissPendingDeletion', (path: string) => {
    worktreeDeletionFSM.dismiss(path)
    return true
  })

  transport.onRequest('worktree:dir', async (repoRoot: string) => {
    if (!repoRoot) return ''
    return defaultWorktreeDir(repoRoot)
  })

  transport.onRequest('repo:list', () => {
    return config.repoRoots
  })

  transport.onRequest('repo:add', async () => {
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
    const result = await dialog.showOpenDialog(win!, {
      properties: ['openDirectory'],
      title: 'Open Git Repository'
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const repoRoot = result.filePaths[0]
    if (!config.repoRoots.includes(repoRoot)) {
      config.repoRoots.push(repoRoot)
      saveConfig(config)
      worktreesFSM.dispatchRepos([...config.repoRoots])
      // Hydrate the new repo's config into the store.
      store.dispatch({
        type: 'repoConfigs/changed',
        payload: { repoRoot, config: loadRepoConfig(repoRoot) }
      })
      void worktreesFSM.refreshList()
    }
    return repoRoot
  })

  transport.onRequest('repo:remove', (repoRoot: string) => {
    const idx = config.repoRoots.indexOf(repoRoot)
    if (idx === -1) return false
    config.repoRoots.splice(idx, 1)
    // Also drop any persisted panes for the removed repo so they don't
    // linger as orphans.
    if (config.panes && config.panes[repoRoot]) {
      delete config.panes[repoRoot]
    }
    saveConfig(config)
    worktreesFSM.dispatchRepos([...config.repoRoots])
    store.dispatch({ type: 'repoConfigs/removed', payload: repoRoot })
    void worktreesFSM.refreshList()
    return true
  })

  // Changed files
  transport.onRequest('worktree:changedFiles', async (worktreePath: string, mode?: 'working' | 'branch') => {
    return getChangedFiles(worktreePath, mode ?? 'working')
  })

  transport.onRequest(
    'worktree:fileDiff',
    async (
      worktreePath: string,
      filePath: string,
      staged: boolean,
      mode?: 'working' | 'branch'
    ) => {
      return getFileDiff(worktreePath, filePath, staged, mode ?? 'working')
    }
  )

  transport.onRequest('worktree:listFiles', async (worktreePath: string) => {
    return listAllFiles(worktreePath)
  })

  transport.onRequest('worktree:readFile', async (worktreePath: string, filePath: string) => {
    return readWorktreeFile(worktreePath, filePath)
  })

  transport.onRequest(
    'worktree:writeFile',
    async (worktreePath: string, filePath: string, contents: string) => {
      return writeWorktreeFile(worktreePath, filePath, contents)
    }
  )

  transport.onRequest(
    'worktree:fileDiffSides',
    async (
      worktreePath: string,
      filePath: string,
      staged: boolean,
      mode?: 'working' | 'branch'
    ) => {
      return getFileDiffSides(worktreePath, filePath, staged, mode ?? 'working')
    }
  )

  transport.onRequest('worktree:branchCommits', async (worktreePath: string) => {
    return getBranchCommits(worktreePath)
  })

  transport.onRequest('worktree:commitDiff', async (worktreePath: string, hash: string) => {
    return getCommitDiff(worktreePath, hash)
  })

  // PR status lives in the main-process store, polled by PRPoller. Renderers
  // subscribe via the state event stream; these methods trigger on-demand
  // refreshes (new worktree created, window focus, worktree activate,
  // terminal entered 'waiting' state).
  transport.onRequest('prs:refreshAll', async () => {
    await prPoller.refreshAll()
    return true
  })
  transport.onRequest('prs:refreshAllIfStale', () => {
    prPoller.refreshAllIfStale()
    return true
  })
  transport.onRequest('prs:refreshOne', async (worktreePath: string) => {
    await prPoller.refreshOne(worktreePath)
    return true
  })
  transport.onRequest('prs:refreshOneIfStale', (worktreePath: string) => {
    prPoller.refreshOneIfStale(worktreePath)
    return true
  })

  transport.onRequest('worktree:mainStatus', async (repoRoot: string) => {
    if (!repoRoot) throw new Error('No repo root provided')
    return getMainWorktreeStatus(repoRoot)
  })

  transport.onRequest('worktree:previewMerge', async (repoRoot: string, sourceBranch: string) => {
    if (!repoRoot) throw new Error('No repo root provided')
    const status = await getMainWorktreeStatus(repoRoot)
    return previewMergeConflicts(repoRoot, sourceBranch, status.baseBranch)
  })

  transport.onRequest('worktree:prepareMain', async (repoRoot: string) => {
    if (!repoRoot) throw new Error('No repo root provided')
    return prepareMainForMerge(repoRoot)
  })

  transport.onRequest(
    'worktree:mergeLocal',
    async (repoRoot: string, sourceBranch: string, strategy: MergeStrategy) => {
      if (!repoRoot) throw new Error('No repo root provided')
      const result = await mergeWorktreeLocally(repoRoot, sourceBranch, strategy)
      // Record the branch as locally merged at its current tip sha. If new
      // commits are pushed to the branch later, the PRPoller will detect
      // the SHA drift on the next refresh and clear the flag.
      const sha = await getBranchSha(repoRoot, sourceBranch)
      if (sha) {
        if (!config.locallyMerged) config.locallyMerged = {}
        config.locallyMerged[sourceBranch] = sha
        saveConfig(config)
      }
      // Kick the poller so the UI picks up the new merged flag immediately.
      void prPoller.refreshAll()
      return result
    }
  )

  // Legacy worktree:mergedStatus handler is gone — the computation is now
  // inlined in PRPoller.refreshAll, which runs across all roots in one pass
  // and dispatches prs/mergedChanged.

  // Config — the renderer reads via useSettings() etc.; only mutation
  // handlers and a few constant-accessors live on the IPC.
  transport.onRequest('config:setHotkeys', (hotkeys: Record<string, string>) => {
    config.hotkeys = hotkeys
    saveConfig(config)
    store.dispatch({ type: 'settings/hotkeysChanged', payload: hotkeys })
    return true
  })

  transport.onRequest('config:resetHotkeys', () => {
    delete config.hotkeys
    saveConfig(config)
    store.dispatch({ type: 'settings/hotkeysChanged', payload: null })
    return true
  })

  transport.onRequest('config:setClaudeCommand', (command: string) => {
    const trimmed = command.trim()
    if (!trimmed || trimmed === DEFAULT_CLAUDE_COMMAND) {
      delete config.claudeCommand
    } else {
      config.claudeCommand = trimmed
    }
    saveConfig(config)
    store.dispatch({
      type: 'settings/claudeCommandChanged',
      payload: config.claudeCommand || DEFAULT_CLAUDE_COMMAND
    })
    return true
  })

  transport.onRequest('config:getDefaultClaudeCommand', () => {
    return DEFAULT_CLAUDE_COMMAND
  })

  transport.onRequest('config:setDefaultAgent', (agent: string) => {
    const kind = agent === 'codex' ? 'codex' : 'claude'
    config.defaultAgent = kind
    saveConfig(config)
    store.dispatch({ type: 'settings/defaultAgentChanged', payload: kind })
    return true
  })

  transport.onRequest('config:setCodexCommand', (command: string) => {
    const trimmed = command.trim()
    if (!trimmed || trimmed === 'codex') {
      delete config.codexCommand
    } else {
      config.codexCommand = trimmed
    }
    saveConfig(config)
    store.dispatch({
      type: 'settings/codexCommandChanged',
      payload: config.codexCommand || 'codex'
    })
    return true
  })

  transport.onRequest('config:setClaudeModel', (model: string | null) => {
    if (model) {
      config.claudeModel = model
    } else {
      delete config.claudeModel
    }
    saveConfig(config)
    store.dispatch({ type: 'settings/claudeModelChanged', payload: model })
    return true
  })

  transport.onRequest('config:setCodexModel', (model: string | null) => {
    if (model) {
      config.codexModel = model
    } else {
      delete config.codexModel
    }
    saveConfig(config)
    store.dispatch({ type: 'settings/codexModelChanged', payload: model })
    return true
  })

  transport.onRequest('config:setCodexEnvVars', (vars: Record<string, string>) => {
    if (!vars || Object.keys(vars).length === 0) {
      delete config.codexEnvVars
    } else {
      config.codexEnvVars = vars
    }
    saveConfig(config)
    store.dispatch({ type: 'settings/codexEnvVarsChanged', payload: config.codexEnvVars || {} })
    return true
  })

  transport.onRequest('repoConfig:set', (repoRoot: string, next: Record<string, unknown>) => {
    if (!repoRoot) return null
    const current = loadRepoConfig(repoRoot)
    const merged: RepoConfig = { ...current }
    for (const [k, v] of Object.entries(next || {})) {
      if (v === null || v === undefined) {
        delete (merged as Record<string, unknown>)[k]
      } else {
        ;(merged as Record<string, unknown>)[k] = v
      }
    }
    const saved = saveRepoConfig(repoRoot, merged)
    store.dispatch({
      type: 'repoConfigs/changed',
      payload: { repoRoot, config: saved }
    })
    return saved
  })

  transport.onRequest(
    'config:setWorktreeScripts',
    (scripts: { setup?: string; teardown?: string }) => {
      const setup = (scripts?.setup || '').trim()
      const teardown = (scripts?.teardown || '').trim()
      if (setup) config.worktreeSetupCommand = setup
      else delete config.worktreeSetupCommand
      if (teardown) config.worktreeTeardownCommand = teardown
      else delete config.worktreeTeardownCommand
      saveConfig(config)
      store.dispatch({
        type: 'settings/worktreeScriptsChanged',
        payload: { setup, teardown }
      })
      return true
    }
  )

  transport.onRequest('config:setClaudeEnvVars', (vars: Record<string, string>) => {
    const cleaned: Record<string, string> = {}
    if (vars && typeof vars === 'object') {
      for (const [rawKey, rawVal] of Object.entries(vars)) {
        const key = String(rawKey).trim()
        if (!key) continue
        // POSIX-ish name check — letters, digits, underscore, not starting with a digit.
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
        cleaned[key] = rawVal == null ? '' : String(rawVal)
      }
    }
    if (Object.keys(cleaned).length === 0) {
      delete config.claudeEnvVars
    } else {
      config.claudeEnvVars = cleaned
    }
    saveConfig(config)
    store.dispatch({ type: 'settings/claudeEnvVarsChanged', payload: cleaned })
    return true
  })

  transport.onRequest('config:setAutoUpdateEnabled', (enabled: boolean) => {
    if (enabled) {
      delete config.autoUpdateEnabled
    } else {
      config.autoUpdateEnabled = false
    }
    saveConfig(config)
    store.dispatch({
      type: 'settings/autoUpdateEnabledChanged',
      payload: config.autoUpdateEnabled !== false
    })
    if (config.autoUpdateEnabled === false) {
      stopAutoUpdateChecks()
    } else {
      startAutoUpdateChecks()
    }
    return true
  })

  transport.onRequest('config:setHarnessMcpEnabled', (enabled: boolean) => {
    if (enabled) {
      delete config.harnessMcpEnabled
    } else {
      config.harnessMcpEnabled = false
    }
    saveConfig(config)
    store.dispatch({
      type: 'settings/harnessMcpEnabledChanged',
      payload: config.harnessMcpEnabled !== false
    })
    return true
  })

  transport.onRequest('mcp:prepareForTerminal', (terminalId: string): string | null => {
    if (config.harnessMcpEnabled === false) return null
    if (!terminalId) return null
    return writeMcpConfigForTerminal(terminalId)
  })

  transport.onRequest('config:setNameClaudeSessions', (enabled: boolean) => {
    if (enabled) {
      config.nameClaudeSessions = true
    } else {
      delete config.nameClaudeSessions
    }
    saveConfig(config)
    store.dispatch({
      type: 'settings/nameClaudeSessionsChanged',
      payload: !!config.nameClaudeSessions
    })
    return true
  })
  transport.onRequest('config:setTheme', (theme: string) => {
    if (!AVAILABLE_THEMES.includes(theme as (typeof AVAILABLE_THEMES)[number])) {
      return false
    }
    if (theme === DEFAULT_THEME) {
      delete config.theme
    } else {
      config.theme = theme
    }
    saveConfig(config)
    store.dispatch({ type: 'settings/themeChanged', payload: theme })
    return true
  })

  transport.onRequest('config:setTerminalFontFamily', (fontFamily: string) => {
    const trimmed = (fontFamily || '').trim()
    if (!trimmed || trimmed === DEFAULT_TERMINAL_FONT_FAMILY) {
      delete config.terminalFontFamily
    } else {
      config.terminalFontFamily = trimmed
    }
    saveConfig(config)
    store.dispatch({
      type: 'settings/terminalFontFamilyChanged',
      payload: config.terminalFontFamily || DEFAULT_TERMINAL_FONT_FAMILY
    })
    return true
  })

  transport.onRequest('config:getDefaultTerminalFontFamily', () => DEFAULT_TERMINAL_FONT_FAMILY)

  transport.onRequest('config:setTerminalFontSize', (fontSize: number) => {
    const n = Number(fontSize)
    if (!Number.isFinite(n) || n < 8 || n > 48) return false
    const rounded = Math.round(n)
    if (rounded === DEFAULT_TERMINAL_FONT_SIZE) {
      delete config.terminalFontSize
    } else {
      config.terminalFontSize = rounded
    }
    saveConfig(config)
    store.dispatch({
      type: 'settings/terminalFontSizeChanged',
      payload: config.terminalFontSize || DEFAULT_TERMINAL_FONT_SIZE
    })
    return true
  })

  transport.onRequest('config:setEditor', (editorId: string) => {
    if (!AVAILABLE_EDITORS.some((e) => e.id === editorId)) return false
    if (editorId === DEFAULT_EDITOR_ID) {
      delete config.editor
    } else {
      config.editor = editorId
    }
    saveConfig(config)
    store.dispatch({ type: 'settings/editorChanged', payload: editorId })
    return true
  })

  transport.onRequest('config:getAvailableEditors', () => {
    return AVAILABLE_EDITORS.map(({ id, name }) => ({ id, name }))
  })

  transport.onRequest('editor:open', (worktreePath: string, filePath?: string) => {
    const editorId = config.editor || DEFAULT_EDITOR_ID
    return openInEditor(editorId, worktreePath, filePath)
  })

  transport.onRequest('config:setWorktreeBase', (mode: 'remote' | 'local') => {
    if (mode !== 'remote' && mode !== 'local') return false
    if (mode === DEFAULT_WORKTREE_BASE) {
      delete config.worktreeBase
    } else {
      config.worktreeBase = mode
    }
    saveConfig(config)
    store.dispatch({ type: 'settings/worktreeBaseChanged', payload: mode })
    return true
  })

  transport.onRequest(
    'config:setMergeStrategy',
    (strategy: 'squash' | 'merge-commit' | 'fast-forward') => {
      if (
        strategy !== 'squash' &&
        strategy !== 'merge-commit' &&
        strategy !== 'fast-forward'
      ) {
        return false
      }
      config.mergeStrategy = strategy
      saveConfig(config)
      store.dispatch({ type: 'settings/mergeStrategyChanged', payload: strategy })
      return true
    }
  )

  transport.onRequest('config:getAvailableThemes', () => {
    return AVAILABLE_THEMES
  })

  transport.onRequest('config:setOnboardingQuest', (quest: string) => {
    const valid = ['hidden', 'spawn-second', 'switch-between', 'finale', 'done']
    if (!valid.includes(quest)) return false
    config.onboarding = { ...(config.onboarding || {}), quest: quest as QuestStep }
    saveConfig(config)
    store.dispatch({
      type: 'onboarding/questChanged',
      payload: quest as QuestStep
    })
    return true
  })

  // Pane / tab tree — fully main-owned via PanesFSM. Renderers call these
  // methods instead of computing pane state locally. ensureInitialized is
  // not exposed: main calls it directly from worktree creation paths.
  transport.onRequest(
    'panes:addTab',
    (wtPath: string, tab: TerminalTab, paneId?: string) => {
      panesFSM.addTab(wtPath, tab, paneId)
      return true
    }
  )
  transport.onRequest('panes:closeTab', (wtPath: string, tabId: string) => {
    panesFSM.closeTab(wtPath, tabId)
    return true
  })
  transport.onRequest(
    'panes:restartAgentTab',
    (wtPath: string, tabId: string, newId: string) => {
      panesFSM.restartAgentTab(wtPath, tabId, newId)
      return true
    }
  )
  transport.onRequest(
    'panes:selectTab',
    (wtPath: string, paneId: string, tabId: string) => {
      panesFSM.selectTab(wtPath, paneId, tabId)
      return true
    }
  )
  transport.onRequest(
    'panes:reorderTabs',
    (wtPath: string, paneId: string, fromId: string, toId: string) => {
      panesFSM.reorderTabs(wtPath, paneId, fromId, toId)
      return true
    }
  )
  transport.onRequest(
    'panes:moveTabToPane',
    (
      wtPath: string,
      tabId: string,
      toPaneId: string,
      toIndex?: number
    ) => {
      panesFSM.moveTabToPane(wtPath, tabId, toPaneId, toIndex)
      return true
    }
  )
  transport.onRequest(
    'panes:splitPane',
    (wtPath: string, fromPaneId: string, direction?: 'horizontal' | 'vertical') => {
      if (direction) {
        store.dispatch({
          type: 'terminals/splitDirectionChanged',
          payload: { worktreePath: wtPath, direction }
        })
        config.paneSplitDirections = {
          ...config.paneSplitDirections,
          [wtPath]: direction
        }
        saveConfig(config)
      }
      return panesFSM.splitPane(wtPath, fromPaneId)
    }
  )
  transport.onRequest(
    'panes:setSplitDirection',
    (wtPath: string, direction: 'horizontal' | 'vertical') => {
      store.dispatch({
        type: 'terminals/splitDirectionChanged',
        payload: { worktreePath: wtPath, direction }
      })
      config.paneSplitDirections = {
        ...config.paneSplitDirections,
        [wtPath]: direction
      }
      saveConfig(config)
      return true
    }
  )
  transport.onRequest('panes:clearForWorktree', (wtPath: string) => {
    panesFSM.clearForWorktree(wtPath)
    return true
  })
  // Wake-on-activation. Renderer fires this whenever the user focuses a
  // worktree (sidebar click, hotkey, command palette). Boot-time sleep
  // skips merged worktrees, so this is the only path that wakes them.
  // No-op for paths that already have panes.
  transport.onRequest('panes:ensureInitialized', (wtPath: string) => {
    panesFSM.ensureInitialized(wtPath)
    return true
  })

  // Activity log — per-worktree status transition history for the Activity view.
  // The activity-deriver in main now calls recordActivity directly when it
  // observes status changes; this IPC stays for any direct-from-renderer
  // pings that haven't been migrated yet.
  transport.onSignal('activity:record', (worktreePath: string, state: ActivityState) => {
    recordActivity(worktreePath, state)
  })

  transport.onRequest('activity:get', () => {
    return getActivityLog()
  })

  transport.onRequest('activity:clear', (worktreePath?: string) => {
    if (worktreePath) clearActivityForWorktree(worktreePath)
    else clearAllActivity()
    return true
  })

  // Terminal scrollback — owned entirely by main. PtyManager tees the PTY
  // onData stream into a per-id ring buffer, persists it on a 30s cadence and
  // on before-quit, and hands it back here on request. Renderer replays it
  // into a fresh xterm instance before wiring up live data.
  transport.onRequest('terminal:getHistory', (id: string) => {
    return ptyManager.getHistory(id)
  })

  transport.onRequest('terminal:forgetHistory', (id: string) => {
    ptyManager.forgetHistory(id)
    return true
  })

  transport.onRequest('agent:sessionFileExists', (cwd: string, sessionId: string, agentKind?: string): boolean => {
    const kind = toAgentKind(agentKind)
    return getAgent(kind).sessionFileExists(cwd, sessionId)
  })

  transport.onRequest('agent:latestSessionId', (cwd: string, agentKind?: string): string | null => {
    const kind = toAgentKind(agentKind)
    return getAgent(kind).latestSessionId(cwd)
  })

  transport.onRequest(
    'agent:buildSpawnArgs',
    (agentKind: string, opts: {
      terminalId: string; cwd: string; sessionId?: string;
      initialPrompt?: string; teleportSessionId?: string;
      sessionName?: string
    }): string => {
      const kind = toAgentKind(agentKind)
      const agent = getAgent(kind)
      const command = kind === 'claude'
        ? (config.claudeCommand || agent.defaultCommand)
        : (config.codexCommand || agent.defaultCommand)
      const model = kind === 'claude' ? (config.claudeModel || null) : (config.codexModel || null)
      const mcpConfigPath = writeMcpConfigForTerminal(opts.terminalId)
      return agent.buildSpawnArgs({ ...opts, command, mcpConfigPath, model })
    }
  )

  // Settings: GitHub token
  transport.onRequest('settings:hasGithubToken', () => {
    return store.getSnapshot().state.settings.hasGithubToken
  })

  transport.onRequest('settings:setGithubToken', async (token: string) => {
    const trimmed = token.trim()
    if (!trimmed) {
      deleteSecret('githubToken')
      store.dispatch({ type: 'settings/hasGithubTokenChanged', payload: false })
      invalidateTokenCache()
      await resolveGitHubToken()
      store.dispatch({ type: 'settings/githubAuthSourceChanged', payload: getTokenSource() })
      await refreshHarnessStarState()
      return { ok: true }
    }
    // Validate the token first by hitting /user
    const test = await testToken(trimmed)
    if (!test.ok) return { ok: false, error: test.error }
    setSecret('githubToken', trimmed)
    store.dispatch({ type: 'settings/hasGithubTokenChanged', payload: true })
    invalidateTokenCache()
    await resolveGitHubToken()
    store.dispatch({ type: 'settings/githubAuthSourceChanged', payload: getTokenSource() })
    await refreshHarnessStarState()
    return { ok: true, username: test.username }
  })

  transport.onRequest('settings:clearGithubToken', async () => {
    deleteSecret('githubToken')
    store.dispatch({ type: 'settings/hasGithubTokenChanged', payload: false })
    invalidateTokenCache()
    await resolveGitHubToken()
    store.dispatch({ type: 'settings/githubAuthSourceChanged', payload: getTokenSource() })
    await refreshHarnessStarState()
    return true
  })

  transport.onRequest('settings:setHarnessStarred', async (starred: boolean) => {
    const token = getCachedToken()
    if (!token) return { ok: false, error: 'No GitHub token' }
    const result = starred
      ? await starRepo(token, 'frenchie4111', 'harness')
      : await unstarRepo(token, 'frenchie4111', 'harness')
    if (result.ok) {
      store.dispatch({ type: 'settings/harnessStarredChanged', payload: starred })
    }
    return result
  })

  // Updater
  transport.onRequest('updater:getVersion', () => {
    return app.getVersion()
  })

  transport.onRequest('updater:checkForUpdates', async () => {
    if (!app.isPackaged) {
      return { ok: false, error: 'Updates are only available in packaged builds' }
    }
    try {
      const result = await autoUpdater.checkForUpdates()
      if (!result) {
        store.dispatch({
          type: 'updater/statusChanged',
          payload: { state: 'not-available' }
        })
        return { ok: true, available: false }
      }
      const updateInfo = result.updateInfo
      const current = app.getVersion()
      return {
        ok: true,
        available: updateInfo.version !== current,
        version: updateInfo.version,
        releaseDate: updateInfo.releaseDate
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      store.dispatch({
        type: 'updater/statusChanged',
        payload: { state: 'error', error: message }
      })
      return { ok: false, error: message }
    }
  })

  transport.onRequest('updater:quitAndInstall', () => {
    log('updater', 'quitAndInstall requested — tearing down before handing off to Squirrel')
    try {
      stopWatchingStatus?.()
      stopWatchingStatus = null
    } catch (err) {
      log('updater', 'stopWatchingStatus failed', err instanceof Error ? err.message : String(err))
    }
    try {
      // Kill the whole PTY process group (zsh + claude + any grandchildren),
      // not just the direct shell child. Leaving descendants alive keeps
      // libuv handles attached on our side, which makes Electron's quit
      // sequence hang — and Squirrel.Mac then bails with "original process
      // did not end" before ShipIt swaps the bundle.
      ptyManager.killAll('SIGKILL')
    } catch (err) {
      log('updater', 'ptyManager.killAll failed', err instanceof Error ? err.message : String(err))
    }
    try {
      sealAllActive()
      saveConfigSync(config)
    } catch (err) {
      log('updater', 'final persistence failed', err instanceof Error ? err.message : String(err))
    }

    // Skip our before-quit handler — we just did its work above.
    app.removeAllListeners('before-quit')

    autoUpdater.quitAndInstall(true, true)
    return true
  })

  // Performance monitor
  transport.onRequest('perf:getMetrics', () => perfMonitor.getMetrics())

  // Hooks. Install/uninstall happen once at user scope — the hook command
  // is env-gated on $HARNESS_TERMINAL_ID so sessions spawned outside
  // Harness are unaffected.
  transport.onRequest('hooks:accept', () => {
    installHooksGlobally()
    config.hooksConsent = 'accepted'
    saveConfig(config)
    store.dispatch({ type: 'hooks/consentChanged', payload: 'accepted' })
    return true
  })

  transport.onRequest('hooks:decline', () => {
    config.hooksConsent = 'declined'
    saveConfig(config)
    store.dispatch({ type: 'hooks/consentChanged', payload: 'declined' })
    return true
  })

  transport.onRequest('hooks:uninstall', () => {
    uninstallHooksGlobally()
    config.hooksConsent = 'pending'
    saveConfig(config)
    store.dispatch({ type: 'hooks/consentChanged', payload: 'pending' })
    return true
  })

  // Shell
  transport.onSignal('shell:openExternal', (url: string) => {
    shell.openExternal(url)
  })

  transport.onSignal('pty:create', (id: string, cwd: string, cmd: string, args: string[], agentKind?: string, cols?: number, rows?: number) => {
    const isAgent = !!agentKind
    const extraEnv = agentKind === 'claude' ? config.claudeEnvVars
      : agentKind === 'codex' ? config.codexEnvVars
      : undefined
    ptyManager.create(id, cwd, cmd, args, extraEnv, !isAgent, cols, rows)
  })

  transport.onSignal('pty:write', (id: string, data: string) => {
    ptyManager.write(id, data)
  })

  transport.onSignal('pty:resize', (id: string, cols: number, rows: number) => {
    ptyManager.resize(id, cols, rows)
  })

  transport.onSignal('pty:kill', (id: string) => {
    ptyManager.kill(id)
  })
}

function openSettingsInFocusedWindow(): void {
  transport.sendSignal('app:openSettings')
}

function togglePerfMonitorInFocusedWindow(): void {
  transport.sendSignal('app:togglePerfMonitor')
}

function openKeyboardShortcutsInFocusedWindow(): void {
  transport.sendSignal('app:openKeyboardShortcuts')
}

function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          label: 'Settings…',
          accelerator: 'CmdOrCtrl+,',
          click: openSettingsInFocusedWindow
        },
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
        { role: 'togglefullscreen' },
        { type: 'separator' },
        {
          label: 'Performance Monitor',
          accelerator: 'CmdOrCtrl+Shift+D',
          click: () => togglePerfMonitorInFocusedWindow()
        }
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
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Keyboard Shortcuts',
          click: openKeyboardShortcutsInFocusedWindow
        }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function broadcastToAllWindows(channel: string, ...args: unknown[]): void {
  transport.sendSignal(channel, ...args)
}

function setupAutoUpdater(): void {
  if (!app.isPackaged) return // No-op in dev

  autoUpdater.logger = {
    info: (msg: string) => log('updater', msg),
    warn: (msg: string) => log('updater', `[warn] ${msg}`),
    error: (msg: string) => log('updater', `[error] ${msg}`),
    debug: () => {}
  } as Electron.Logger

  autoUpdater.on('checking-for-update', () => {
    log('updater', 'checking for update')
    store.dispatch({ type: 'updater/statusChanged', payload: { state: 'checking' } })
  })
  autoUpdater.on('update-available', (info) => {
    log('updater', 'update available', info.version)
    store.dispatch({
      type: 'updater/statusChanged',
      payload: { state: 'available', version: info.version }
    })
  })
  autoUpdater.on('update-not-available', () => {
    log('updater', 'no update available')
    store.dispatch({
      type: 'updater/statusChanged',
      payload: { state: 'not-available' }
    })
  })
  autoUpdater.on('error', (err) => {
    log('updater', 'error', err.message)
    store.dispatch({
      type: 'updater/statusChanged',
      payload: { state: 'error', error: err.message }
    })
  })
  autoUpdater.on('download-progress', (p) => {
    store.dispatch({
      type: 'updater/statusChanged',
      payload: { state: 'downloading', percent: p.percent }
    })
  })
  autoUpdater.on('update-downloaded', (info) => {
    log('updater', 'update downloaded', info.version)
    store.dispatch({
      type: 'updater/statusChanged',
      payload: { state: 'downloaded', version: info.version }
    })
  })

  // Also log native Squirrel.Mac errors. electron-updater wraps Squirrel via
  // its own MacUpdater but doesn't surface errors from the native side, so
  // things like "target app still running" or codesign mismatches would
  // otherwise be invisible. These are the errors that would have diagnosed
  // previous OTA loops in one glance.
  if (process.platform === 'darwin') {
    nativeAutoUpdater.on('error', (err) => {
      log('updater', `[error] Squirrel.Mac: ${err.message}`)
    })
  }

  // Background polling is gated on the autoUpdateEnabled setting so users
  // can opt out. The manual "Check for updates" button in Settings remains
  // available regardless.
  startAutoUpdateChecks()
}

let autoUpdateTimer: NodeJS.Timeout | null = null

function startAutoUpdateChecks(): void {
  if (!app.isPackaged) return
  if (config.autoUpdateEnabled === false) return
  if (autoUpdateTimer) return
  // Check on startup, then every 10 minutes. We use checkForUpdates (not
  // checkForUpdatesAndNotify) so there's no native OS notification — the
  // renderer shows an in-app banner based on the updater:status events.
  autoUpdater.checkForUpdates().catch((err) => log('updater', 'check failed', err.message))
  autoUpdateTimer = setInterval(() => {
    autoUpdater.checkForUpdates().catch(() => {})
  }, 10 * 60 * 1000)
}

function stopAutoUpdateChecks(): void {
  if (autoUpdateTimer) {
    clearInterval(autoUpdateTimer)
    autoUpdateTimer = null
  }
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

  // Seed the store's flat worktree list before the renderer hydrates, so
  // App.tsx's first render already has the real data. Pane init for the
  // discovered worktrees is handled by the sleep-on-boot subscriber above
  // — refreshList() dispatches `worktrees/listChanged`, which queues every
  // path for init pending the first PR-poller pass (or a 3s timeout).
  void (async () => {
    await panesFSM.restoreFromConfig(config.panes)
    await worktreesFSM.refreshList()
  })()

  // Seed per-repo config slice from each repo's .harness.json file.
  const initialRepoConfigsMap: Record<string, RepoConfig> = {}
  for (const root of config.repoRoots || []) {
    initialRepoConfigsMap[root] = loadRepoConfig(root)
  }
  store.dispatch({ type: 'repoConfigs/loaded', payload: initialRepoConfigsMap })

  // Start the activity deriver — it observes terminals/prs/panes events
  // and writes recordActivity + lastActive without renderer involvement.
  activityDeriver.start()

  // Resolve the GitHub token (PAT → gh CLI → none) before the PR poller
  // makes its first call. The poller's initial refreshAll waits on this.
  void (async () => {
    await resolveGitHubToken()
    const source = getTokenSource()
    store.dispatch({ type: 'settings/githubAuthSourceChanged', payload: source })
    prPoller.start()
    void prPoller.refreshAll()

    await refreshHarnessStarState()
  })()

  // Seed hooks.consent from disk and migrate legacy per-worktree hooks
  // to a single user-scope install. Runs once per app install; migrated
  // state sticks via config.hooksMigratedToGlobal.
  void (async () => {
    const claudeAgent = getAgent('claude')
    const codexAgent = getAgent('codex')

    // 1. Decide what the user's previous consent was.
    //    - Explicit persisted value wins (including 'declined').
    //    - Otherwise infer from the current state of disk: any global
    //      install implies 'accepted'; otherwise scan worktrees for
    //      legacy per-worktree markers as evidence of a prior accept.
    let consent: 'pending' | 'accepted' | 'declined' | undefined = config.hooksConsent
    if (!consent) {
      if (claudeAgent.hooksInstalled() || codexAgent.hooksInstalled()) {
        consent = 'accepted'
      } else {
        let foundLegacy = false
        for (const root of config.repoRoots || []) {
          const trees = await listWorktrees(root).catch(() => [])
          for (const wt of trees) {
            // Probe via strip helper dry-run: we check existence of the
            // per-worktree file + its contents cheaply here by attempting
            // a strip and rolling back mentally — actually easier to just
            // run the strip and treat the "changed" bit as evidence.
            if (claudeAgent.stripHooksFromWorktree(wt.path)) foundLegacy = true
            if (codexAgent.stripHooksFromWorktree(wt.path)) foundLegacy = true
          }
        }
        consent = foundLegacy ? 'accepted' : 'pending'
        if (foundLegacy) {
          // Migration already happened above as a side-effect.
          config.hooksMigratedToGlobal = true
        }
      }
      config.hooksConsent = consent
      saveConfig(config)
    }

    // 2. If user previously accepted but the global install is missing
    //    (fresh upgrade), install now so status tracking keeps working.
    if (consent === 'accepted') {
      installHooksGlobally()
    }

    // 3. Run the one-shot migration sweep to strip legacy per-worktree
    //    hooks — needed when config.hooksConsent was already persisted
    //    (explicit path above didn't run the sweep) but we haven't
    //    swept yet.
    if (!config.hooksMigratedToGlobal) {
      for (const root of config.repoRoots || []) {
        const trees = await listWorktrees(root).catch(() => [])
        for (const wt of trees) {
          claudeAgent.stripHooksFromWorktree(wt.path)
          codexAgent.stripHooksFromWorktree(wt.path)
        }
      }
      config.hooksMigratedToGlobal = true
      saveConfig(config)
    }

    store.dispatch({ type: 'hooks/consentChanged', payload: consent })
  })()

  // Prune terminal history files not referenced by any persisted tab
  const keepIds = new Set<string>()
  for (const byRepo of Object.values(config.panes || {})) {
    for (const panes of Object.values(byRepo)) {
      for (const pane of panes) {
        for (const tab of pane.tabs) keepIds.add(tab.id)
      }
    }
  }
  pruneTerminalHistory(keepIds)
  pruneMcpConfigs(keepIds)

  // Local HTTP control server for the bundled harness-control MCP bridge.
  startControlServer({
    getRepoRoots: () => config.repoRoots,
    getWorktreeBase: () => config.worktreeBase || DEFAULT_WORKTREE_BASE,
    broadcast: (channel, payload) => {
      if (channel === 'worktrees:externalCreate') {
        // Seed panes with the initial prompt BEFORE refreshList — the
        // worktrees/listChanged subscriber also calls ensureInitialized
        // (without opts) for every worktree in the new list, and whoever
        // gets there first wins. Prime the pane with the prompt, then
        // refresh the list so subsequent ensureInitialized calls are
        // no-ops, then tell the renderer to focus the new path.
        const p = payload as {
          repoRoot: string
          worktree: { path: string }
          initialPrompt?: string
        }
        panesFSM.ensureInitialized(p.worktree.path, {
          initialPrompt: p.initialPrompt
        })
        void worktreesFSM.refreshList().then(() => {
          broadcastToAllWindows(channel, payload)
        })
        void prPoller.refreshAll()
        return
      }
      broadcastToAllWindows(channel, payload)
    }
  }).catch((err) => log('control', 'failed to start', err instanceof Error ? err.message : err))

  // Watch status dir globally — hook events become terminals/statusChanged
  // dispatches on the store, which the state transport fans out to all
  // clients.
  stopWatchingStatus = watchStatusDir(store)

  // One window shows all repos. The renderer reads `config.repoRoots` via
  // `repo:list` and opens each one on mount.
  createWindow()

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
  stopWatchingStatus = null
  // SIGKILL the whole PTY process group so zsh + claude + grandchildren
  // all die immediately and release their libuv handles. Without this the
  // main process can hang draining fds and Squirrel.Mac will abort an
  // in-flight bundle swap with "original process did not end".
  ptyManager.killAll('SIGKILL')
  sealAllActive()
  saveConfigSync(config)
})

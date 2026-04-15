import { app, autoUpdater as nativeAutoUpdater, BrowserWindow, ipcMain, dialog, Menu, shell } from 'electron'
import { autoUpdater } from 'electron-updater'
import { existsSync, readdirSync, statSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { PtyManager } from './pty-manager'
import { Store } from './store'
import { registerStateTransport } from './transport-electron'
import { isDemoMode } from './demo-mode'
import { DemoDriver } from './demo-driver'
import { PRPoller } from './pr-poller'
import { WorktreesFSM } from './worktrees-fsm'
import { WorktreeDeletionFSM } from './worktree-deletion-fsm'
import { PanesFSM, stripTransientTabFields } from './panes-fsm'
import { ActivityDeriver } from './activity-deriver'
import type { TerminalTab, WorkspacePane } from '../shared/state/terminals'
import { listWorktrees, listBranches, continueWorktree, isWorktreeDirty, defaultWorktreeDir, getChangedFiles, getFileDiff, getBranchCommits, getCommitDiff, getMainWorktreeStatus, prepareMainForMerge, mergeWorktreeLocally, getBranchSha, previewMergeConflicts, getBranchDiffStats, listAllFiles, readWorktreeFile, type MergeStrategy } from './worktree'
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
  saveTerminalHistory,
  loadTerminalHistory,
  clearTerminalHistory,
  pruneTerminalHistory,
  type PersistedPane,
  type QuestStep
} from './persistence'
import { loadRepoConfig, saveRepoConfig, type RepoConfig } from './repo-config'
import { isWorktreeMerged } from '../shared/state/prs'
import { hooksInstalled, installHooks, watchStatusDir } from './hooks'
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

function latestClaudeSessionId(cwd: string): string | null {
  try {
    const encoded = cwd.replace(/[^a-zA-Z0-9]/g, '-')
    const dir = join(homedir(), '.claude', 'projects', encoded)
    const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
    if (files.length === 0) return null
    let bestId: string | null = null
    let bestMtime = -Infinity
    for (const file of files) {
      const mtime = statSync(join(dir, file)).mtimeMs
      if (mtime > bestMtime) {
        bestMtime = mtime
        bestId = file.replace(/\.jsonl$/, '')
      }
    }
    return bestId
  } catch {
    return null
  }
}

const ptyManager = new PtyManager()
let config = loadConfig()
let stopWatchingStatus: (() => void) | null = null

const store = new Store(buildInitialAppState(config, { hasGithubToken: hasSecret('githubToken') }))
registerStateTransport(store)

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

// Persist panes back to config in the existing nested-by-repo shape, so the
// on-disk format stays compatible with persistence-migrations. Strip
// transient (in-memory only) tab fields like initialPrompt before saving.
function persistPanes(panes: Record<string, WorkspacePane[]>): void {
  // Demo mode never touches config.json — fake panes stay in memory only.
  if (isDemoMode) return
  const nested: Record<string, Record<string, PersistedPane[]>> = {}
  for (const [wtPath, paneList] of Object.entries(panes)) {
    // Find which repo this worktree belongs to. Use the live worktree list
    // first; fall back to '__orphan__' for entries we can't map.
    const wt = store.getSnapshot().state.worktrees.list.find((w) => w.path === wtPath)
    const repoRoot = wt?.repoRoot || '__orphan__'
    const persistedPanes: PersistedPane[] = paneList
      .map((pane) => {
        const tabs = pane.tabs
          .filter((t) => t.type === 'claude' || t.type === 'shell')
          .map((t) => {
            const stripped = stripTransientTabFields(t as TerminalTab)
            return {
              id: stripped.id,
              type: stripped.type as 'claude' | 'shell',
              label: stripped.label,
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
  getLatestClaudeSessionId: async (wtPath) => latestClaudeSessionId(wtPath)
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

/** Install Claude Code hooks into any worktree that's missing them, but only
 * if the user has accepted the consent prompt. Subscribes to the store and
 * fires on worktrees/listChanged + hooks/consentChanged. */
function installHooksForAcceptedWorktrees(): void {
  // Demo mode uses fake on-disk paths — installing hooks would mkdir into
  // /demo/... and crash. The driver dispatches consent='accepted' anyway
  // so the renderer skips the consent banner.
  if (isDemoMode) return
  const state = store.getSnapshot().state
  if (state.hooks.consent !== 'accepted') return
  for (const wt of state.worktrees.list) {
    if (!hooksInstalled(wt.path)) {
      installHooks(wt.path)
    }
  }
}
store.subscribe((event) => {
  if (
    event.type === 'worktrees/listChanged' ||
    event.type === 'hooks/consentChanged'
  ) {
    installHooksForAcceptedWorktrees()
  }
})

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
  // Demo mode: DemoDriver hand-seeds panes for the hero worktree only and
  // leaves the other rows paneless on purpose. The auto-init would
  // overwrite the seeded fix-auth pane with a fresh one (different id) and
  // create real default panes for /demo/... paths, causing the renderer to
  // spawn xterm components for them.
  if (isDemoMode) return
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
  const bounds = config.windowBounds || { width: 1400, height: 900, x: undefined!, y: undefined! }

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
      sandbox: false
    }
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
  ipcMain.handle('worktree:list', async (_, repoRoot: string) => {
    if (!repoRoot) return []
    const trees = await listWorktrees(repoRoot)
    for (const wt of trees) {
      touchActivityMeta(wt.path, { branch: wt.branch, repoRoot })
    }
    return trees
  })

  ipcMain.handle('worktree:branches', async (_, repoRoot: string) => {
    if (!repoRoot) return []
    return listBranches(repoRoot)
  })

  // Worktree creation flows through the WorktreesFSM in main; main also
  // creates the default Claude+Shell pane pair (with the initial prompt
  // embedded) before the call returns. Renderer just awaits + focuses.
  ipcMain.handle(
    'worktrees:runPending',
    async (
      _,
      params: {
        id: string
        repoRoot: string
        branchName: string
        initialPrompt?: string
        teleportSessionId?: string
      }
    ) => {
      return worktreesFSM.runPending(params)
    }
  )
  ipcMain.handle('worktrees:retryPending', async (_, id: string) => {
    return worktreesFSM.retryPending(id)
  })
  ipcMain.handle('worktrees:dismissPending', (_, id: string) => {
    worktreesFSM.dismissPending(id)
    return true
  })
  ipcMain.handle('worktrees:refreshList', async () => {
    // Demo mode: the renderer fires this on mount and on focus. Letting it
    // through would call listWorktrees() against config.repoRoots and
    // dispatch a fresh worktrees/listChanged that wipes the demo seed.
    if (isDemoMode) return true
    await worktreesFSM.refreshList()
    return true
  })

  ipcMain.handle(
    'worktree:continue',
    async (_, repoRoot: string, worktreePath: string, newBranchName: string, baseBranch?: string) => {
      if (!repoRoot) throw new Error('No repo root provided')
      const mode = config.worktreeBase || DEFAULT_WORKTREE_BASE
      return continueWorktree(repoRoot, worktreePath, newBranchName, {
        baseBranch,
        fetchRemote: !baseBranch && mode === 'remote'
      })
    }
  )

  ipcMain.handle('worktree:isDirty', async (_, path: string) => {
    if (isDemoMode) return false
    return isWorktreeDirty(path)
  })

  ipcMain.handle('worktree:remove', async (
    _,
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

  ipcMain.handle('worktree:dismissPendingDeletion', (_, path: string) => {
    worktreeDeletionFSM.dismiss(path)
    return true
  })

  ipcMain.handle('worktree:dir', async (_, repoRoot: string) => {
    if (!repoRoot) return ''
    return defaultWorktreeDir(repoRoot)
  })

  ipcMain.handle('repo:list', () => {
    return config.repoRoots
  })

  ipcMain.handle('repo:add', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
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

  ipcMain.handle('repo:remove', (_, repoRoot: string) => {
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
  ipcMain.handle('worktree:changedFiles', async (_, worktreePath: string, mode?: 'working' | 'branch') => {
    if (isDemoMode) return []
    return getChangedFiles(worktreePath, mode ?? 'working')
  })

  ipcMain.handle(
    'worktree:fileDiff',
    async (
      _,
      worktreePath: string,
      filePath: string,
      staged: boolean,
      mode?: 'working' | 'branch'
    ) => {
      return getFileDiff(worktreePath, filePath, staged, mode ?? 'working')
    }
  )

  ipcMain.handle('worktree:listFiles', async (_, worktreePath: string) => {
    if (isDemoMode) return []
    return listAllFiles(worktreePath)
  })

  ipcMain.handle('worktree:readFile', async (_, worktreePath: string, filePath: string) => {
    return readWorktreeFile(worktreePath, filePath)
  })

  ipcMain.handle('worktree:branchCommits', async (_, worktreePath: string) => {
    if (isDemoMode) return []
    return getBranchCommits(worktreePath)
  })

  ipcMain.handle('worktree:commitDiff', async (_, worktreePath: string, hash: string) => {
    return getCommitDiff(worktreePath, hash)
  })

  // PR status lives in the main-process store, polled by PRPoller. Renderers
  // subscribe via the state event stream; these methods trigger on-demand
  // refreshes (new worktree created, window focus, worktree activate,
  // terminal entered 'waiting' state).
  ipcMain.handle('prs:refreshAll', async () => {
    await prPoller.refreshAll()
    return true
  })
  ipcMain.handle('prs:refreshAllIfStale', () => {
    prPoller.refreshAllIfStale()
    return true
  })
  ipcMain.handle('prs:refreshOne', async (_, worktreePath: string) => {
    await prPoller.refreshOne(worktreePath)
    return true
  })
  ipcMain.handle('prs:refreshOneIfStale', (_, worktreePath: string) => {
    prPoller.refreshOneIfStale(worktreePath)
    return true
  })

  ipcMain.handle('worktree:mainStatus', async (_, repoRoot: string) => {
    if (isDemoMode) {
      return {
        path: repoRoot,
        currentBranch: 'main',
        baseBranch: 'main',
        isOnBase: true,
        isDirty: false,
        ready: true
      }
    }
    if (!repoRoot) throw new Error('No repo root provided')
    return getMainWorktreeStatus(repoRoot)
  })

  ipcMain.handle('worktree:previewMerge', async (_, repoRoot: string, sourceBranch: string) => {
    if (isDemoMode) return { hasConflict: false, files: [] }
    if (!repoRoot) throw new Error('No repo root provided')
    const status = await getMainWorktreeStatus(repoRoot)
    return previewMergeConflicts(repoRoot, sourceBranch, status.baseBranch)
  })

  ipcMain.handle('worktree:prepareMain', async (_, repoRoot: string) => {
    if (!repoRoot) throw new Error('No repo root provided')
    return prepareMainForMerge(repoRoot)
  })

  ipcMain.handle(
    'worktree:mergeLocal',
    async (_, repoRoot: string, sourceBranch: string, strategy: MergeStrategy) => {
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
  ipcMain.handle('config:setHotkeys', (_, hotkeys: Record<string, string>) => {
    config.hotkeys = hotkeys
    saveConfig(config)
    store.dispatch({ type: 'settings/hotkeysChanged', payload: hotkeys })
    return true
  })

  ipcMain.handle('config:resetHotkeys', () => {
    delete config.hotkeys
    saveConfig(config)
    store.dispatch({ type: 'settings/hotkeysChanged', payload: null })
    return true
  })

  ipcMain.handle('config:setClaudeCommand', (_, command: string) => {
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

  ipcMain.handle('config:getDefaultClaudeCommand', () => {
    return DEFAULT_CLAUDE_COMMAND
  })

  ipcMain.handle('repoConfig:set', (_, repoRoot: string, next: Record<string, unknown>) => {
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

  ipcMain.handle(
    'config:setWorktreeScripts',
    (_, scripts: { setup?: string; teardown?: string }) => {
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

  ipcMain.handle('config:setClaudeEnvVars', (_, vars: Record<string, string>) => {
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

  ipcMain.handle('config:setHarnessMcpEnabled', (_, enabled: boolean) => {
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

  ipcMain.handle('mcp:prepareForTerminal', (_, terminalId: string): string | null => {
    if (config.harnessMcpEnabled === false) return null
    if (!terminalId) return null
    return writeMcpConfigForTerminal(terminalId)
  })

  ipcMain.handle('config:setNameClaudeSessions', (_, enabled: boolean) => {
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
  ipcMain.handle('config:setTheme', (_, theme: string) => {
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

  ipcMain.handle('config:setTerminalFontFamily', (_, fontFamily: string) => {
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

  ipcMain.handle('config:getDefaultTerminalFontFamily', () => DEFAULT_TERMINAL_FONT_FAMILY)

  ipcMain.handle('config:setTerminalFontSize', (_, fontSize: number) => {
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

  ipcMain.handle('config:setEditor', (_, editorId: string) => {
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

  ipcMain.handle('config:getAvailableEditors', () => {
    return AVAILABLE_EDITORS.map(({ id, name }) => ({ id, name }))
  })

  ipcMain.handle('editor:open', (_, worktreePath: string, filePath?: string) => {
    const editorId = config.editor || DEFAULT_EDITOR_ID
    return openInEditor(editorId, worktreePath, filePath)
  })

  ipcMain.handle('config:setWorktreeBase', (_, mode: 'remote' | 'local') => {
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

  ipcMain.handle(
    'config:setMergeStrategy',
    (_, strategy: 'squash' | 'merge-commit' | 'fast-forward') => {
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

  ipcMain.handle('config:getAvailableThemes', () => {
    return AVAILABLE_THEMES
  })

  ipcMain.handle('config:setOnboardingQuest', (_, quest: string) => {
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
  ipcMain.handle(
    'panes:addTab',
    (_, wtPath: string, tab: TerminalTab, paneId?: string) => {
      panesFSM.addTab(wtPath, tab, paneId)
      return true
    }
  )
  ipcMain.handle('panes:closeTab', (_, wtPath: string, tabId: string) => {
    panesFSM.closeTab(wtPath, tabId)
    return true
  })
  ipcMain.handle(
    'panes:restartClaudeTab',
    (_, wtPath: string, tabId: string, newId: string) => {
      panesFSM.restartClaudeTab(wtPath, tabId, newId)
      return true
    }
  )
  ipcMain.handle(
    'panes:selectTab',
    (_, wtPath: string, paneId: string, tabId: string) => {
      panesFSM.selectTab(wtPath, paneId, tabId)
      return true
    }
  )
  ipcMain.handle(
    'panes:reorderTabs',
    (_, wtPath: string, paneId: string, fromId: string, toId: string) => {
      panesFSM.reorderTabs(wtPath, paneId, fromId, toId)
      return true
    }
  )
  ipcMain.handle(
    'panes:moveTabToPane',
    (
      _,
      wtPath: string,
      tabId: string,
      toPaneId: string,
      toIndex?: number
    ) => {
      panesFSM.moveTabToPane(wtPath, tabId, toPaneId, toIndex)
      return true
    }
  )
  ipcMain.handle('panes:splitPane', (_, wtPath: string, fromPaneId: string) => {
    return panesFSM.splitPane(wtPath, fromPaneId)
  })
  ipcMain.handle('panes:clearForWorktree', (_, wtPath: string) => {
    panesFSM.clearForWorktree(wtPath)
    return true
  })
  // Wake-on-activation. Renderer fires this whenever the user focuses a
  // worktree (sidebar click, hotkey, command palette). Boot-time sleep
  // skips merged worktrees, so this is the only path that wakes them.
  // No-op for paths that already have panes.
  ipcMain.handle('panes:ensureInitialized', (_, wtPath: string) => {
    if (isDemoMode) return true
    panesFSM.ensureInitialized(wtPath)
    return true
  })

  // Activity log — per-worktree status transition history for the Activity view.
  // The activity-deriver in main now calls recordActivity directly when it
  // observes status changes; this IPC stays for any direct-from-renderer
  // pings that haven't been migrated yet.
  ipcMain.on('activity:record', (_, worktreePath: string, state: ActivityState) => {
    recordActivity(worktreePath, state)
  })

  ipcMain.handle('activity:get', () => {
    return getActivityLog()
  })

  ipcMain.handle('activity:clear', (_, worktreePath?: string) => {
    if (worktreePath) clearActivityForWorktree(worktreePath)
    else clearAllActivity()
    return true
  })

  // Terminal scrollback persistence
  ipcMain.handle('terminal:saveHistory', (_, id: string, content: string) => {
    saveTerminalHistory(id, content)
    return true
  })

  // Sync variant used by beforeunload so writes complete before window closes
  ipcMain.on('terminal:saveHistorySync', (event, id: string, content: string) => {
    saveTerminalHistory(id, content)
    event.returnValue = true
  })

  ipcMain.handle('terminal:loadHistory', (_, id: string) => {
    return loadTerminalHistory(id)
  })

  ipcMain.handle('terminal:clearHistory', (_, id: string) => {
    clearTerminalHistory(id)
    return true
  })

  // Check whether a Claude session file already exists on disk for
  // `<cwd>/<sessionId>.jsonl`. When it does, the tab should spawn with
  // `--resume <id>` instead of `--session-id <id>` — claude refuses the
  // latter on an existing session file with "is already in use".
  ipcMain.handle('claude:sessionFileExists', (_, cwd: string, sessionId: string): boolean => {
    try {
      const encoded = cwd.replace(/[^a-zA-Z0-9]/g, '-')
      return existsSync(join(homedir(), '.claude', 'projects', encoded, `${sessionId}.jsonl`))
    } catch {
      return false
    }
  })

  // Find the most recent Claude Code session ID for a given worktree path,
  // by reading ~/.claude/projects/<encoded-cwd>/*.jsonl sorted by mtime.
  // Used to migrate legacy Claude tabs (which resumed via `--continue`) onto
  // the new per-tab scheme without losing their session — the spawn path
  // uses `--resume` when the file exists.
  ipcMain.handle('claude:latestSessionId', (_, cwd: string): string | null => {
    return latestClaudeSessionId(cwd)
  })

  // Settings: GitHub token
  ipcMain.handle('settings:hasGithubToken', () => {
    return store.getSnapshot().state.settings.hasGithubToken
  })

  ipcMain.handle('settings:setGithubToken', async (_, token: string) => {
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

  ipcMain.handle('settings:clearGithubToken', async () => {
    deleteSecret('githubToken')
    store.dispatch({ type: 'settings/hasGithubTokenChanged', payload: false })
    invalidateTokenCache()
    await resolveGitHubToken()
    store.dispatch({ type: 'settings/githubAuthSourceChanged', payload: getTokenSource() })
    await refreshHarnessStarState()
    return true
  })

  ipcMain.handle('settings:setHarnessStarred', async (_, starred: boolean) => {
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
  ipcMain.handle('updater:getVersion', () => {
    return app.getVersion()
  })

  ipcMain.handle('updater:checkForUpdates', async () => {
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

  ipcMain.handle('updater:quitAndInstall', () => {
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

  // Hooks. check + install are no longer exposed: per-worktree installation
  // happens automatically in the store subscription (see
  // installHooksForAcceptedWorktrees) whenever the worktree list changes
  // or the user accepts consent.

  // Bulk-install hooks into every known worktree and flip consent='accepted'
  // + justInstalled=true in a single round trip. Replaces the old
  // renderer-side loop that walked worktrees one by one.
  ipcMain.handle('hooks:acceptAll', async () => {
    const roots = config.repoRoots || []
    for (const root of roots) {
      const trees = await listWorktrees(root).catch(() => [])
      for (const wt of trees) {
        if (!hooksInstalled(wt.path)) installHooks(wt.path)
      }
    }
    store.dispatch({ type: 'hooks/consentChanged', payload: 'accepted' })
    store.dispatch({ type: 'hooks/justInstalledChanged', payload: true })
    return true
  })

  ipcMain.handle('hooks:decline', () => {
    store.dispatch({ type: 'hooks/consentChanged', payload: 'declined' })
    return true
  })

  ipcMain.handle('hooks:dismissJustInstalled', () => {
    store.dispatch({ type: 'hooks/justInstalledChanged', payload: false })
    return true
  })

  // Shell
  ipcMain.on('shell:openExternal', (_, url: string) => {
    shell.openExternal(url)
  })

  // PTY handlers — route to the calling window
  ipcMain.on('pty:create', (event, id: string, cwd: string, cmd: string, args: string[], isClaude?: boolean) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    // Demo mode: don't spawn a real pty. The DemoDriver pushes terminal:data
    // directly to the window for hero terminals; other tabs stay blank.
    if (isDemoMode) return
    const extraEnv = isClaude ? config.claudeEnvVars : undefined
    ptyManager.create(id, cwd, cmd, args, win, extraEnv, !isClaude)
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

function openSettingsInFocusedWindow(): void {
  const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
  if (win && !win.isDestroyed()) {
    win.webContents.send('app:openSettings')
  }
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

function broadcastToAllWindows(channel: string, ...args: unknown[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, ...args)
  }
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

  // Check on startup, then every 10 minutes. We use checkForUpdates (not
  // checkForUpdatesAndNotify) so there's no native OS notification — the
  // renderer shows an in-app banner based on the updater:status events.
  autoUpdater.checkForUpdates().catch((err) => log('updater', 'check failed', err.message))
  setInterval(() => {
    autoUpdater.checkForUpdates().catch(() => {})
  }, 10 * 60 * 1000)
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
  // Skipped in demo mode — DemoDriver owns the worktree list and panes.
  // restoreFromConfig would re-hydrate prior real worktrees from the dev
  // config.json into the demo store.
  if (!isDemoMode) {
    void (async () => {
      await panesFSM.restoreFromConfig(config.panes)
      await worktreesFSM.refreshList()
    })()
  }

  // Seed per-repo config slice from each repo's .harness.json file.
  const initialRepoConfigsMap: Record<string, RepoConfig> = {}
  for (const root of config.repoRoots || []) {
    initialRepoConfigsMap[root] = loadRepoConfig(root)
  }
  store.dispatch({ type: 'repoConfigs/loaded', payload: initialRepoConfigsMap })

  // Start the activity deriver — it observes terminals/prs/panes events
  // and writes recordActivity + lastActive without renderer involvement.
  // Skipped in demo mode: it would persist fake worktree paths to the
  // activity log on disk.
  if (!isDemoMode) {
    activityDeriver.start()
  }

  // Resolve the GitHub token (PAT → gh CLI → none) before the PR poller
  // makes its first call. The poller's initial refreshAll waits on this.
  // Skipped in demo mode — DemoDriver owns PR state.
  if (!isDemoMode) {
    void (async () => {
      await resolveGitHubToken()
      const source = getTokenSource()
      store.dispatch({ type: 'settings/githubAuthSourceChanged', payload: source })
      prPoller.start()
      void prPoller.refreshAll()

      await refreshHarnessStarState()
    })()
  }

  // Seed hooks.consent from disk. If any known worktree already has the
  // hooks installed, the user must have accepted at some point — remember
  // that and skip the consent banner on boot. Skipped in demo mode —
  // DemoDriver dispatches hooks/consentChanged='accepted' itself.
  if (!isDemoMode) {
    void (async () => {
      const roots = config.repoRoots || []
      for (const root of roots) {
        const trees = await listWorktrees(root).catch(() => [])
        for (const wt of trees) {
          if (hooksInstalled(wt.path)) {
            store.dispatch({ type: 'hooks/consentChanged', payload: 'accepted' })
            return
          }
        }
      }
    })()
  }

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
      broadcastToAllWindows(channel, payload)
      if (channel === 'worktrees:externalCreate') {
        // Refresh the store's list and seed default panes for the new
        // worktree (with the initial prompt embedded). Renderer just
        // focuses the new path when its onWorktreesExternalCreate
        // listener fires.
        const p = payload as {
          repoRoot: string
          worktree: { path: string }
          initialPrompt?: string
        }
        void worktreesFSM.refreshList().then(() => {
          panesFSM.ensureInitialized(p.worktree.path, {
            initialPrompt: p.initialPrompt
          })
        })
        void prPoller.refreshAll()
      }
    }
  }).catch((err) => log('control', 'failed to start', err instanceof Error ? err.message : err))

  // Watch status dir globally — hook events become terminals/statusChanged
  // dispatches on the store, which the state transport fans out to all
  // clients. Skipped in demo mode — DemoDriver dispatches statuses directly.
  if (!isDemoMode) {
    stopWatchingStatus = watchStatusDir(store)
  }

  // One window shows all repos. The renderer reads `config.repoRoots` via
  // `repo:list` and opens each one on mount.
  const mainWindow = createWindow()

  if (isDemoMode) {
    log('demo', 'demo mode active — starting DemoDriver after renderer loads')
    const driver = new DemoDriver(store, () => {
      const wins = BrowserWindow.getAllWindows()
      return wins.find((w) => !w.isDestroyed()) || null
    })
    // Wait for the renderer to subscribe to state:event before dispatching,
    // otherwise the seed events fire into the void.
    mainWindow.webContents.once('did-finish-load', () => {
      driver.start()
    })
  }

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

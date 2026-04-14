import { app, autoUpdater as nativeAutoUpdater, BrowserWindow, ipcMain, dialog, Menu, shell } from 'electron'
import { autoUpdater } from 'electron-updater'
import { existsSync, readdirSync, statSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { PtyManager } from './pty-manager'
import { Store } from './store'
import { registerStateTransport } from './transport-electron'
import { PRPoller } from './pr-poller'
import { WorktreesFSM } from './worktrees-fsm'
import { listWorktrees, listBranches, continueWorktree, removeWorktree, isWorktreeDirty, defaultWorktreeDir, getChangedFiles, getFileDiff, getBranchCommits, getCommitDiff, getMainWorktreeStatus, prepareMainForMerge, mergeWorktreeLocally, getBranchSha, previewMergeConflicts, getBranchDiffStats, listAllFiles, readWorktreeFile, runWorktreeScript, type MergeStrategy } from './worktree'
import { getPRStatus, testToken, starRepo } from './github'
import { AVAILABLE_EDITORS, DEFAULT_EDITOR_ID, openInEditor } from './editor'
import { setSecret, hasSecret, deleteSecret } from './secrets'
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
import { hooksInstalled, installHooks, watchStatusDir } from './hooks'
import { startControlServer } from './control-server'
import { writeMcpConfigForTerminal, pruneMcpConfigs } from './mcp-config'
import { recordActivity, getActivityLog, clearAllActivity, clearActivityForWorktree, sealAllActive, touchActivityMeta, finalizeActivity, type ActivityState, type PRState } from './activity'
import { log, getLogFilePath } from './debug'

// In dev, use a separate userData dir so a running dev instance doesn't
// fight with the installed prod app over config.json / activity.json / etc.
if (!app.isPackaged) {
  app.setPath('userData', join(app.getPath('appData'), 'Harness (Dev)'))
}

const ptyManager = new PtyManager()
let config = loadConfig()
let stopWatchingStatus: (() => void) | null = null

const store = new Store({
  prs: {
    byPath: {},
    mergedByPath: {},
    loading: false
  },
  onboarding: {
    quest: config.onboarding?.quest ?? 'hidden'
  },
  hooks: {
    consent: 'pending',
    justInstalled: false
  },
  worktrees: {
    list: [],
    repoRoots: config.repoRoots || [],
    pending: []
  },
  settings: {
    theme: config.theme || DEFAULT_THEME,
    hotkeys: config.hotkeys || null,
    claudeCommand: config.claudeCommand || DEFAULT_CLAUDE_COMMAND,
    worktreeScripts: {
      setup: config.worktreeSetupCommand || '',
      teardown: config.worktreeTeardownCommand || ''
    },
    claudeEnvVars: config.claudeEnvVars || {},
    harnessMcpEnabled: config.harnessMcpEnabled !== false,
    nameClaudeSessions: config.nameClaudeSessions ?? false,
    terminalFontFamily: config.terminalFontFamily || DEFAULT_TERMINAL_FONT_FAMILY,
    terminalFontSize: config.terminalFontSize || DEFAULT_TERMINAL_FONT_SIZE,
    editor: config.editor || DEFAULT_EDITOR_ID,
    worktreeBase: config.worktreeBase || DEFAULT_WORKTREE_BASE,
    mergeStrategy: config.mergeStrategy || DEFAULT_MERGE_STRATEGY,
    hasGithubToken: hasSecret('githubToken')
  }
})
registerStateTransport(store)

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

const worktreesFSM = new WorktreesFSM(store, {
  getRepoRoots: () => config.repoRoots || [],
  getWorktreeSetupCmd: () => config.worktreeSetupCommand || '',
  getWorktreeBaseMode: () => config.worktreeBase || DEFAULT_WORKTREE_BASE,
  onWorktreeCreated: () => {
    void prPoller.refreshAll()
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

  // Worktree creation flows through the WorktreesFSM in main; the renderer
  // awaits runPending end-to-end and uses the returned outcome to stage
  // initial prompts and route focus.
  ipcMain.handle(
    'worktrees:runPending',
    async (_, params: { id: string; repoRoot: string; branchName: string }) => {
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
    // Drop any locally-merged flag for the branch at this path
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
    const teardownRepoCfg = loadRepoConfig(repoRoot)
    const teardownCmd = teardownRepoCfg.teardownCommand || config.worktreeTeardownCommand || ''
    if (teardownCmd) {
      await runWorktreeScript('teardown', teardownCmd, {
        worktreePath: path,
        branch: wt?.branch || '',
        repoRoot
      })
    }
    const result = await removeWorktree(repoRoot, path, force)
    void worktreesFSM.refreshList()
    return result
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
      void worktreesFSM.refreshList()
      broadcastToAllWindows('repo:listChanged', config.repoRoots)
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
    void worktreesFSM.refreshList()
    broadcastToAllWindows('repo:listChanged', config.repoRoots)
    return true
  })

  // Changed files
  ipcMain.handle('worktree:changedFiles', async (_, worktreePath: string, mode?: 'working' | 'branch') => {
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
    return listAllFiles(worktreePath)
  })

  ipcMain.handle('worktree:readFile', async (_, worktreePath: string, filePath: string) => {
    return readWorktreeFile(worktreePath, filePath)
  })

  ipcMain.handle('worktree:branchCommits', async (_, worktreePath: string) => {
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
    if (!repoRoot) throw new Error('No repo root provided')
    return getMainWorktreeStatus(repoRoot)
  })

  ipcMain.handle('worktree:previewMerge', async (_, repoRoot: string, sourceBranch: string) => {
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

  // Config
  ipcMain.handle('config:getHotkeys', () => {
    return store.getSnapshot().state.settings.hotkeys
  })

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

  ipcMain.handle('config:getClaudeCommand', () => {
    return store.getSnapshot().state.settings.claudeCommand
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

  ipcMain.handle('repoConfig:get', (_, repoRoot: string) => {
    if (!repoRoot) return {}
    return loadRepoConfig(repoRoot)
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
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed())
        win.webContents.send('repoConfig:changed', { repoRoot, config: saved })
    }
    return saved
  })

  ipcMain.handle('repoConfig:getEffectiveMergeStrategy', (_, repoRoot: string) => {
    const repo = loadRepoConfig(repoRoot)
    return repo.mergeStrategy || config.mergeStrategy || DEFAULT_MERGE_STRATEGY
  })

  ipcMain.handle('config:getWorktreeScripts', () => {
    return store.getSnapshot().state.settings.worktreeScripts
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

  ipcMain.handle('config:getClaudeEnvVars', () => {
    return store.getSnapshot().state.settings.claudeEnvVars
  })

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

  ipcMain.handle('config:getHarnessMcpEnabled', () => {
    return store.getSnapshot().state.settings.harnessMcpEnabled
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

  ipcMain.handle('config:getNameClaudeSessions', () => {
    return store.getSnapshot().state.settings.nameClaudeSessions
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
  ipcMain.handle('config:getTheme', () => {
    return store.getSnapshot().state.settings.theme
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

  ipcMain.handle('config:getTerminalFontFamily', () => {
    return store.getSnapshot().state.settings.terminalFontFamily
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

  ipcMain.handle('config:getTerminalFontSize', () => {
    return store.getSnapshot().state.settings.terminalFontSize
  })

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

  ipcMain.handle('config:getEditor', () => {
    return store.getSnapshot().state.settings.editor
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

  ipcMain.handle('config:getWorktreeBase', () => {
    return store.getSnapshot().state.settings.worktreeBase
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

  ipcMain.handle('config:getMergeStrategy', () => {
    return store.getSnapshot().state.settings.mergeStrategy
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

  ipcMain.handle('config:getOnboarding', () => {
    return { quest: store.getSnapshot().state.onboarding.quest }
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

  // Persisted workspace panes (tabs per pane, per worktree, per repo).
  ipcMain.handle('config:getPanes', () => {
    return config.panes || {}
  })

  ipcMain.handle(
    'config:setPanes',
    (_, panes: Record<string, Record<string, PersistedPane[]>>) => {
      config.panes = panes
      saveConfig(config)
      return true
    }
  )

  // Activity log — per-worktree status transition history for the Activity view
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
  })

  // Settings: GitHub token
  ipcMain.handle('settings:hasGithubToken', () => {
    return store.getSnapshot().state.settings.hasGithubToken
  })

  ipcMain.handle('settings:setGithubToken', async (_, token: string, options?: { starRepo?: boolean }) => {
    const trimmed = token.trim()
    if (!trimmed) {
      deleteSecret('githubToken')
      store.dispatch({ type: 'settings/hasGithubTokenChanged', payload: false })
      return { ok: true }
    }
    // Validate the token first by hitting /user
    const test = await testToken(trimmed)
    if (!test.ok) return { ok: false, error: test.error }
    setSecret('githubToken', trimmed)
    store.dispatch({ type: 'settings/hasGithubTokenChanged', payload: true })

    // Optionally star the repo — fire and forget, don't fail token save if this fails
    let starred = false
    if (options?.starRepo) {
      const result = await starRepo(trimmed, 'frenchie4111', 'harness')
      starred = result.ok
      if (!result.ok) log('app', 'failed to star repo', result.error)
    }

    return { ok: true, username: test.username, starred }
  })

  ipcMain.handle('settings:clearGithubToken', () => {
    deleteSecret('githubToken')
    store.dispatch({ type: 'settings/hasGithubTokenChanged', payload: false })
    return true
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
      if (!result) return { ok: true, available: false }
      const updateInfo = result.updateInfo
      const current = app.getVersion()
      return {
        ok: true,
        available: updateInfo.version !== current,
        version: updateInfo.version,
        releaseDate: updateInfo.releaseDate
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
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

  // Hooks
  ipcMain.handle('hooks:check', (_, worktreePath: string) => {
    return hooksInstalled(worktreePath)
  })

  ipcMain.handle('hooks:install', async (_, worktreePath: string) => {
    installHooks(worktreePath)
    return true
  })

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
    broadcastToAllWindows('updater:status', { state: 'checking' })
  })
  autoUpdater.on('update-available', (info) => {
    log('updater', 'update available', info.version)
    broadcastToAllWindows('updater:status', { state: 'available', version: info.version })
  })
  autoUpdater.on('update-not-available', () => {
    log('updater', 'no update available')
    broadcastToAllWindows('updater:status', { state: 'not-available' })
  })
  autoUpdater.on('error', (err) => {
    log('updater', 'error', err.message)
    broadcastToAllWindows('updater:status', { state: 'error', error: err.message })
  })
  autoUpdater.on('download-progress', (p) => {
    broadcastToAllWindows('updater:status', { state: 'downloading', percent: p.percent })
  })
  autoUpdater.on('update-downloaded', (info) => {
    log('updater', 'update downloaded', info.version)
    broadcastToAllWindows('updater:status', { state: 'downloaded', version: info.version })
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
  // App.tsx's first render already has the real data.
  void worktreesFSM.refreshList()

  // Kick off the PR poller. An initial refreshAll() runs immediately and
  // then on a 5-minute interval.
  prPoller.start()
  void prPoller.refreshAll()

  // Seed hooks.consent from disk. If any known worktree already has the
  // hooks installed, the user must have accepted at some point — remember
  // that and skip the consent banner on boot.
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
        // Refresh the store's list so all clients see the new worktree.
        void worktreesFSM.refreshList()
        void prPoller.refreshAll()
      }
    }
  }).catch((err) => log('control', 'failed to start', err instanceof Error ? err.message : err))

  // Watch status dir globally — route to correct window via ptyManager
  stopWatchingStatus = watchStatusDir((id) => ptyManager.getWindowForTerminal(id))

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

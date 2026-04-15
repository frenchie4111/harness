import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useSettings, usePrs, useOnboarding, useHooks, useWorktrees, useTerminals, usePanes, useLastActive, useUpdater, useRepoConfigs } from './store'
import { useTailLineBuffer } from './hooks/useTailLineBuffer'
import { useTabHandlers } from './hooks/useTabHandlers'
import { useHotkeyHandlers } from './hooks/useHotkeyHandlers'
import { useWorktreeHandlers } from './hooks/useWorktreeHandlers'
import type { Worktree, TerminalTab, PtyStatus, PendingTool, QuestStep, PendingWorktree, UpdaterStatus, RepoConfig } from './types'
import { HotkeysProvider } from './components/Tooltip'
import { Sidebar } from './components/Sidebar'
import { ResizeHandle } from './components/ResizeHandle'
import { NewWorktreeScreen } from './components/NewWorktreeScreen'
import { CreatingWorktreeScreen } from './components/CreatingWorktreeScreen'
import { DeletingWorktreeScreen } from './components/DeletingWorktreeScreen'
import { QuestCard } from './components/QuestCard'
import { WorkspaceView } from './components/WorkspaceView'
import { RightColumn } from './components/RightColumn'
import { Settings } from './components/Settings'
import { Guide } from './components/Guide'
import { Activity } from './components/Activity'
import { Cleanup } from './components/Cleanup'
import { CommandCenter } from './components/CommandCenter'
import { CommandPalette } from './components/CommandPalette'
import iconUrl from '../../resources/icon.png'
import { focusTerminalById, flushAllTerminalHistory } from './components/XTerminal'
import { type GroupKey } from './worktree-sort'

function isPendingId(id: string | null | undefined): id is string {
  return typeof id === 'string' && id.startsWith('pending:')
}

export default function App(): JSX.Element {
  // Worktree list, repoRoots, and pending-creation FSM all live in the
  // main-process store. activeWorktreeId stays local — it's per-client view
  // focus that eventually becomes per-window.
  const wtState = useWorktrees()
  const worktrees = wtState.list
  const pendingWorktrees = wtState.pending
  const pendingDeletions = wtState.pendingDeletions ?? []
  const pendingDeletionByPath = useMemo(() => {
    const m: Record<string, (typeof pendingDeletions)[number]> = {}
    for (const d of pendingDeletions) m[d.path] = d
    return m
  }, [pendingDeletions])
  const worktreeRepoByPath = useMemo(() => {
    const m: Record<string, string> = {}
    for (const w of worktrees) m[w.path] = w.repoRoot
    return m
  }, [worktrees])
  // Initial focus = first worktree in the already-hydrated store.
  const [activeWorktreeId, setActiveWorktreeId] = useState<string | null>(
    () => worktrees[0]?.path ?? null
  )
  // Pane / tab tree lives in the main-process store; the renderer reads it
  // and dispatches every mutation as an IPC method call. Per-client UI
  // focus (which pane in each worktree the user last interacted with) is
  // still renderer-local — like activeWorktreeId.
  const panes = usePanes()
  const [activePaneId, setActivePaneId] = useState<Record<string, string>>({})

  // Derived flat-tab views — preserved so the read-heavy parts of the app
  // (status aggregation, hotkeys, PR refresh) don't need pane awareness.
  const terminalTabs = useMemo<Record<string, TerminalTab[]>>(() => {
    const out: Record<string, TerminalTab[]> = {}
    for (const [wtPath, paneList] of Object.entries(panes)) {
      out[wtPath] = paneList.flatMap((p) => p.tabs)
    }
    return out
  }, [panes])
  const activeTabId = useMemo<Record<string, string>>(() => {
    const out: Record<string, string> = {}
    for (const [wtPath, paneList] of Object.entries(panes)) {
      const focusedId = activePaneId[wtPath] ?? paneList[0]?.id
      const focused = paneList.find((p) => p.id === focusedId) || paneList[0]
      if (focused) out[wtPath] = focused.activeTabId
    }
    return out
  }, [panes, activePaneId])
  // Per-terminal status/pendingTool/shellActivity all live in the
  // main-process store. Hooks in main/hooks.ts (status) and
  // main/pty-manager.ts (shellActivity, exit) dispatch through the store;
  // we read via useTerminals().
  const terminals = useTerminals()
  const statuses = terminals.statuses
  const pendingTools = terminals.pendingTools
  const shellActivity = terminals.shellActivity
  // PR state lives in the main-process store (see src/main/pr-poller.ts).
  // Polling, on-focus refresh, and stale dedup all live there.
  const prs = usePrs()
  const prStatuses = prs.byPath
  const mergedPaths = prs.mergedByPath
  const prLoading = prs.loading
  // Per-worktree last-active timestamps — derived in main by the
  // activity-deriver, dispatched as terminals/lastActiveChanged events.
  const lastActive = useLastActive()
  const repoRoots = wtState.repoRoots
  // Per-repo config lives in the main-process store. Active repo derived
  // below from the focused worktree.
  const repoConfigs = useRepoConfigs()
  // Map of worktree path → repoRoot for quick lookups outside of `worktrees`.
  // Populated whenever the worktree list refreshes.
  // Hooks consent + justInstalled live in the main-process store.
  // Accept/decline dispatch through dedicated methods; the boot-time
  // "already installed?" detection lives in main.
  const { consent: hooksConsent, justInstalled: hooksJustInstalled } = useHooks()
  const updaterStatus = useUpdater().status
  const [updateBannerDismissed, setUpdateBannerDismissed] = useState(false)
  const [sidebarVisible, setSidebarVisible] = useState(true)
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem('harness:sidebarWidth'))
    return Number.isFinite(saved) && saved > 0 ? saved : 224
  })
  const [rightPanelWidth, setRightPanelWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem('harness:rightPanelWidth'))
    return Number.isFinite(saved) && saved > 0 ? saved : 256
  })
  useEffect(() => {
    localStorage.setItem('harness:sidebarWidth', String(sidebarWidth))
  }, [sidebarWidth])
  useEffect(() => {
    localStorage.setItem('harness:rightPanelWidth', String(rightPanelWidth))
  }, [rightPanelWidth])
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({})
  const [collapsedRepos, setCollapsedRepos] = useState<Record<string, boolean>>({})
  const [unifiedRepos, setUnifiedRepos] = useState<boolean>(() => {
    const saved = localStorage.getItem('harness:unifiedRepos')
    return saved === null ? true : saved === '1'
  })
  useEffect(() => {
    localStorage.setItem('harness:unifiedRepos', unifiedRepos ? '1' : '0')
  }, [unifiedRepos])
  const isGroupCollapsed = useCallback(
    (scope: string, key: GroupKey): boolean => {
      const composite = `${scope}:${key}`
      if (composite in collapsedGroups) return collapsedGroups[composite]
      return key === 'merged'
    },
    [collapsedGroups]
  )
  const toggleGroup = useCallback((scope: string, key: GroupKey) => {
    const composite = `${scope}:${key}`
    setCollapsedGroups((prev) => {
      const current = composite in prev ? prev[composite] : key === 'merged'
      return { ...prev, [composite]: !current }
    })
  }, [])
  const toggleRepo = useCallback((repoRoot: string) => {
    setCollapsedRepos((prev) => ({ ...prev, [repoRoot]: !prev[repoRoot] }))
  }, [])
  const handleSidebarResize = useCallback((delta: number) => {
    setSidebarWidth((w) => Math.max(160, Math.min(500, w + delta)))
  }, [])
  const handleRightPanelResize = useCallback((delta: number) => {
    setRightPanelWidth((w) => Math.max(180, Math.min(600, w - delta)))
  }, [])
  const [showNewWorktree, setShowNewWorktree] = useState(false)
  // Worktrees whose git creation is still running (or has errored). They
  // show in the sidebar immediately on submit so the user sees the new entry
  // right away instead of waiting on the modal.
  const [showSettings, setShowSettings] = useState(false)
  const [settingsInitialSection, setSettingsInitialSection] = useState<'github' | undefined>(undefined)
  const [showGuide, setShowGuide] = useState(false)
  const [showActivity, setShowActivity] = useState(false)
  const [showCleanup, setShowCleanup] = useState(false)
  const [showCommandCenter, setShowCommandCenter] = useState(false)
  const [showCommandPalette, setShowCommandPalette] = useState(false)
  const tailLines = useTailLineBuffer()
  const settings = useSettings()
  const { hasGithubToken: hasGithubPat, githubAuthSource, claudeCommand, nameClaudeSessions } = settings
  const hasGithubToken = hasGithubPat || githubAuthSource === 'gh-cli'
  const hotkeyOverrides = settings.hotkeys ?? undefined
  // Onboarding parallelism quest — see QuestCard.tsx for the steps.
  // Quest state lives in the main-process store; its value is seeded from
  // config on boot so it's already correct on first render.
  const { quest: questStep } = useOnboarding()
  const questVisitedRef = useRef<Set<string>>(new Set())

  // Count of "real" worktrees the user has spawned — main repo doesn't count
  // as an agent. Used by empty state + quest advancement.
  const agentWorktreeCount = useMemo(
    () => worktrees.filter((w) => !w.isMain).length,
    [worktrees]
  )
  // Track which worktrees already have hooks installed so we only prompt once

const setQuestStep = useCallback((next: QuestStep) => {
    window.api.setOnboardingQuest(next).catch(() => {})
  }, [])

  // Advance the quest based on how many agent worktrees exist (main excluded).
  // No loaded-guard needed — the store is hydrated before App mounts, so
  // questStep is already the persisted value on first render.
  useEffect(() => {
    if (questStep === 'done' || questStep === 'finale') return
    if (questStep === 'hidden' && agentWorktreeCount >= 1) {
      setQuestStep(agentWorktreeCount >= 2 ? 'switch-between' : 'spawn-second')
      return
    }
    if (questStep === 'spawn-second' && agentWorktreeCount >= 2) {
      setQuestStep('switch-between')
    }
  }, [agentWorktreeCount, questStep, setQuestStep])

  // Advance the quest when the user switches between two different worktrees
  useEffect(() => {
    if (questStep !== 'switch-between' || !activeWorktreeId) return
    questVisitedRef.current.add(activeWorktreeId)
    if (questVisitedRef.current.size >= 2) {
      setQuestStep('finale')
    }
  }, [activeWorktreeId, questStep, setQuestStep])

  // Panes + repos + worktrees are all hydrated from the main-process store
  // before App mounts. The only thing we still need to do at mount is ask
  // main for a fresh worktree list in case anything changed on disk.
  useEffect(() => {
    void window.api.refreshWorktreesList()
  }, [])

  // Flush all terminal scrollback to disk when the window is about to close
  useEffect(() => {
    const handler = (): void => flushAllTerminalHistory()
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme
  }, [settings.theme])

  // Open Settings from the menu (Cmd+,)
  useEffect(() => {
    const cleanup = window.api.onOpenSettings(() => setShowSettings(true))
    return cleanup
  }, [])

  // Trigger a full PR refresh in main. Used by the sidebar refresh button
  // and after worktree creation/removal.
  const fetchAllPRStatuses = useCallback(() => {
    void window.api.refreshPRsAll()
  }, [])

  const activeRepoRoot = activeWorktreeId
    ? worktrees.find((w) => w.path === activeWorktreeId)?.repoRoot ?? worktreeRepoByPath[activeWorktreeId] ?? null
    : null
  // Derive activeRepoConfig from the store. Updates propagate automatically
  // when any client commits a setRepoConfig.
  const activeRepoConfig: RepoConfig | null = activeRepoRoot
    ? repoConfigs[activeRepoRoot] ?? null
    : null

  // After a local merge, kick the poller so the merged flag and PR state
  // propagate to the UI without waiting for the 5-min interval.
  const refreshMergedStatus = useCallback(() => {
    void window.api.refreshPRsAll()
  }, [])

  // Ask main for a single-worktree PR refresh. Used by the activity observer
  // when a terminal enters the "waiting" state (likely just pushed).
  const fetchPRStatus = useCallback((wtPath: string) => {
    void window.api.refreshPRsOne(wtPath)
  }, [])

  // Ask main for a stale-only single-worktree refresh. Used when the user
  // activates a worktree — main dedups internally so rapid switching won't
  // hammer the GitHub API.
  const fetchPRStatusIfStale = useCallback((wtPath: string) => {
    void window.api.refreshPRsOneIfStale(wtPath)
  }, [])

  // On window focus, ask main for a stale-only bulk refresh. Main dedups
  // against its own lastAllFetchAt clock.
  useEffect(() => {
    const onFocus = (): void => {
      void window.api.refreshPRsAllIfStale()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])

  // Map a terminal ID back to its worktree path
  const terminalToWorktree = useCallback((terminalId: string): string | null => {
    for (const [wtPath, tabs] of Object.entries(terminalTabs)) {
      if (tabs.some((t) => t.id === terminalId)) return wtPath
    }
    return null
  }, [terminalTabs])

  // Observe terminal status transitions to trigger PR refresh when a Claude
  // tab finishes a turn ('waiting'). lastActive timestamps are now derived
  // in main by the activity-deriver, so we don't need to track them here.
  const prevStatusesRef = useRef<Record<string, PtyStatus>>({})
  useEffect(() => {
    const prev = prevStatusesRef.current
    for (const [id, status] of Object.entries(statuses)) {
      if (prev[id] === status) continue
      if (status === 'waiting') {
        const wtPath = terminalToWorktree(id)
        if (wtPath) fetchPRStatus(wtPath)
      }
    }
    prevStatusesRef.current = statuses
  }, [statuses, terminalToWorktree, fetchPRStatus])

  // Auto-focus the active terminal when switching worktrees so the user can
  // start typing immediately. Deferred to the next frame so the xterm layer
  // is visible (TerminalPanels use display:none for inactive worktrees).
  useEffect(() => {
    if (!activeWorktreeId) return
    const tabId = activeTabId[activeWorktreeId]
    if (!tabId || tabId.startsWith('diff-')) return
    const raf = requestAnimationFrame(() => focusTerminalById(tabId))
    return () => cancelAnimationFrame(raf)
  }, [activeWorktreeId, activeTabId])

  // When a worktree becomes active, refresh its PR status if stale. Hooks
  // installation and pane initialization both run in main now (see
  // installHooksForAcceptedWorktrees + WorktreesFSM in src/main/index.ts).
  useEffect(() => {
    if (!activeWorktreeId) return
    if (isPendingId(activeWorktreeId)) return
    fetchPRStatusIfStale(activeWorktreeId)
  }, [activeWorktreeId, fetchPRStatusIfStale])

  // Wake-on-activation: merged worktrees stay asleep at boot, so we need
  // to force pane init on first focus. No-op for paths that already have
  // panes (ensureInitialized in main returns early).
  useEffect(() => {
    if (!activeWorktreeId) return
    if (isPendingId(activeWorktreeId)) return
    void window.api.panesEnsureInitialized(activeWorktreeId)
  }, [activeWorktreeId])

  // If the active id points at something that no longer exists — a
  // finished deletion, a dismissed pending creation, a stale focus after
  // a refresh — route focus to a neighbor so the center pane doesn't
  // collapse into an empty region.
  useEffect(() => {
    if (!activeWorktreeId) return
    if (isPendingId(activeWorktreeId)) {
      if (pendingWorktrees.some((p) => p.id === activeWorktreeId)) return
    } else {
      if (worktrees.some((w) => w.path === activeWorktreeId)) return
      if (pendingDeletions.some((d) => d.path === activeWorktreeId)) return
    }
    setActiveWorktreeId(worktrees[0]?.path ?? null)
  }, [activeWorktreeId, worktrees, pendingWorktrees, pendingDeletions])

  const handleAcceptHooks = useCallback(() => {
    void window.api.acceptHooks()
  }, [])

  const handleDeclineHooks = useCallback(() => {
    void window.api.declineHooks()
  }, [])

  // Re-show the update banner if a new download arrives after a prior dismiss.
  useEffect(() => {
    if (updaterStatus?.state === 'downloaded') setUpdateBannerDismissed(false)
  }, [updaterStatus?.state])

  const handleUpdateRestart = useCallback(() => {
    void window.api.quitAndInstall()
  }, [])

  // All worktree + repo + pending-creation handlers. Also subscribes to
  // external-create events from the harness-control MCP and routes focus
  // to the new path.
  const {
    handleAddRepo,
    handleRemoveRepo,
    handleRefreshWorktrees,
    handleSubmitNewWorktree,
    handleRetryPendingWorktree,
    handleDismissPendingWorktree,
    handleContinuePendingWorktree,
    handleContinueWorktree,
    handleDeleteWorktree,
    handleBulkDeleteWorktrees,
    handleDismissPendingDeletion
  } = useWorktreeHandlers({
    worktrees,
    pendingWorktrees,
    repoRoots,
    worktreeRepoByPath,
    terminalTabs,
    prStatuses,
    activeWorktreeId,
    setActiveWorktreeId,
    setActivePaneId,
    setShowNewWorktree
  })

  // All tab/pane mutation handlers (addTab, closeTab, restartClaude,
  // selectTab, openCommit/File/Diff, reorder, move, split, sendToClaude).
  // Each handler dispatches an IPC method to main; per-client UI focus
  // updates happen here.
  const {
    appendTabToPane,
    handleAddTerminalTab,
    handleAddClaudeTab,
    handleCloseTab,
    handleRestartClaudeTab,
    handleRestartAllClaudeTabs,
    handleSelectTab,
    handleOpenCommit,
    handleReorderTabs,
    handleMoveTabToPane,
    handleSplitPane,
    handleSendToClaude,
    handleOpenFile,
    handleOpenDiff
  } = useTabHandlers({
    panes,
    activePaneId,
    setActivePaneId,
    activeWorktreeId,
    setActiveWorktreeId
  })

  // Sidebar-aware hotkey handlers + the resolved binding map for tooltips.
  // The hook also subscribes to keystrokes via useHotkeys internally.
  const { hotkeyActions, resolvedHotkeys } = useHotkeyHandlers({
    worktrees,
    repoRoots,
    unifiedRepos,
    prStatuses,
    mergedPaths,
    collapsedRepos,
    setCollapsedRepos,
    setCollapsedGroups,
    isGroupCollapsed,
    activeWorktreeId,
    setActiveWorktreeId,
    panes,
    activePaneId,
    terminalTabs,
    activeTabId,
    hotkeyOverrides,
    setSidebarVisible,
    setShowNewWorktree,
    setShowCommandCenter,
    setShowCommandPalette,
    handleAddTerminalTab,
    handleCloseTab,
    handleSelectTab,
    handleSplitPane,
    handleRefreshWorktrees
  })

  // Compute aggregate status per worktree (worst status wins)
  const worktreeStatuses: Record<string, PtyStatus> = {}
  const worktreePendingTools: Record<string, PendingTool | null> = {}
  for (const wt of worktrees) {
    const tabs = terminalTabs[wt.path] || []
    let worstStatus: PtyStatus = 'idle'
    let pending: PendingTool | null = null
    for (const tab of tabs) {
      const s = statuses[tab.id]
      if (s === 'needs-approval') {
        worstStatus = 'needs-approval'
        pending = pendingTools[tab.id] || null
        break
      }
      if (s === 'waiting' && worstStatus !== 'needs-approval') worstStatus = 'waiting'
      if (s === 'processing' && worstStatus === 'idle') worstStatus = 'processing'
    }
    worktreeStatuses[wt.path] = worstStatus
    worktreePendingTools[wt.path] = pending
  }

  const worktreeShellActivity: Record<string, boolean> = {}
  for (const wt of worktrees) {
    const tabs = terminalTabs[wt.path] || []
    worktreeShellActivity[wt.path] = tabs.some(
      (tab) => tab.type === 'shell' && shellActivity[tab.id]?.active
    )
  }

  // Activity-log transitions are recorded by main's activity-deriver
  // (see src/main/activity-deriver.ts). The renderer no longer pings
  // recordActivity directly.

  if (showGuide) {
    return <Guide onClose={() => setShowGuide(false)} />
  }

  const settingsOverlay = showSettings ? (
    <div className="fixed inset-0 z-50">
      <Settings
        onClose={() => {
          setShowSettings(false)
          setSettingsInitialSection(undefined)
        }}
        onOpenGuide={() => {
          setShowSettings(false)
          setSettingsInitialSection(undefined)
          setShowGuide(true)
        }}
        initialSection={settingsInitialSection}
      />
    </div>
  ) : null

  if (repoRoots.length === 0) {
    return (
      <HotkeysProvider bindings={resolvedHotkeys}>
      <div className="flex h-full flex-col">
        <div className="drag-region h-10 shrink-0" />
        <div className="flex flex-1 items-center justify-center">
        <div className="text-center">
          <img
            src={iconUrl}
            alt="Harness"
            className="w-28 h-28 mx-auto rounded-3xl mb-8"
            style={{ boxShadow: '0 0 60px rgba(245, 158, 11, 0.15)' }}
          />
          <h1 className="gradient-text text-4xl font-extrabold tracking-tight mb-4">Harness</h1>
          <p className="text-dim mb-6">Select a git repository to get started</p>
          <button
            onClick={handleAddRepo}
            className="px-6 py-3 bg-surface hover:bg-surface-hover rounded-lg text-fg-bright transition-colors cursor-pointer"
          >
            Open Repository
          </button>
          <div className="mt-8 pt-8 border-t border-border/60 max-w-sm mx-auto">
            <p className="text-xs text-dim mb-2">New to multi-agent workflows?</p>
            <button
              onClick={() => setShowGuide(true)}
              className="text-sm text-accent hover:underline cursor-pointer"
            >
              Read the worktree guide →
            </button>
          </div>
        </div>
        </div>
      </div>
      {settingsOverlay}
      </HotkeysProvider>
    )
  }

  return (
    <HotkeysProvider bindings={resolvedHotkeys}>
    <div className="flex h-full flex-col">
      {/* Update-ready banner */}
      {updaterStatus?.state === 'downloaded' && !updateBannerDismissed && (
        <div className="bg-success/15 border-b border-success/30 pl-20 pr-4 py-2.5 drag-region flex items-center gap-3 shrink-0">
          <span className="text-success text-sm flex-1">
            Harness {updaterStatus.version} is ready to install. Restart to update.
          </span>
          <button
            onClick={handleUpdateRestart}
            className="px-3 py-1 bg-success/30 hover:bg-success/40 rounded text-sm text-success transition-colors shrink-0 cursor-pointer no-drag"
          >
            Restart &amp; install
          </button>
          <button
            onClick={() => setUpdateBannerDismissed(true)}
            className="px-3 py-1 text-success/80 hover:text-success text-sm transition-colors shrink-0 cursor-pointer no-drag"
          >
            Later
          </button>
        </div>
      )}

      {/* Hooks consent banner */}
      {hooksConsent === 'pending' && (
        <div className="bg-warning/15 border-b border-warning/30 pl-20 pr-4 py-2.5 drag-region flex items-center gap-3 shrink-0">
          <span className="text-warning text-sm flex-1">
            Claude Harness needs to install hooks in your worktrees to detect Claude's status
            (waiting, processing, needs approval) — without them the sidebar status dots and
            command center won't work. This adds entries to each worktree's{' '}
            <code className="bg-warning/20 px-1 rounded text-xs">.claude/settings.local.json</code>.
          </span>
          <button
            onClick={handleAcceptHooks}
            className="px-3 py-1 bg-warning/30 hover:bg-warning/40 rounded text-sm text-warning transition-colors shrink-0 cursor-pointer no-drag"
          >
            Enable
          </button>
          <button
            onClick={handleDeclineHooks}
            className="px-3 py-1 text-warning/80 hover:text-warning text-sm transition-colors shrink-0 cursor-pointer no-drag"
          >
            Skip
          </button>
        </div>
      )}

      {/* Hooks installed — prompt to restart Claude tabs */}
      {hooksJustInstalled && (
        <div className="bg-success/15 border-b border-success/30 pl-20 pr-4 py-2.5 drag-region flex items-center gap-3 shrink-0">
          <span className="text-success text-sm flex-1">
            Hooks installed! You will need to restart any active Claude instances to see the changes.
          </span>
          <button
            onClick={handleRestartAllClaudeTabs}
            className="px-3 py-1 bg-success/30 hover:bg-success/40 rounded text-sm text-success transition-colors shrink-0 cursor-pointer no-drag"
          >
            Restart Claude tabs
          </button>
          <button
            onClick={() => void window.api.dismissHooksJustInstalled()}
            className="px-3 py-1 text-success/80 hover:text-success text-sm transition-colors shrink-0 cursor-pointer no-drag"
          >
            Dismiss
          </button>
        </div>
      )}

      <div className="flex flex-1 min-h-0">
        {sidebarVisible && (
          <Sidebar
            worktrees={worktrees}
            pendingWorktrees={pendingWorktrees}
            pendingDeletions={pendingDeletions}
            activeWorktreeId={activeWorktreeId}
            statuses={worktreeStatuses}
            pendingTools={worktreePendingTools}
            shellActivity={worktreeShellActivity}
            prStatuses={prStatuses}
            mergedPaths={mergedPaths}
            prLoading={prLoading}
            agentCount={agentWorktreeCount}
            onSelectWorktree={(path) => {
              setShowNewWorktree(false)
              setShowActivity(false)
              setShowCleanup(false)
              setShowCommandCenter(false)
              setActiveWorktreeId(path)
            }}
            onDismissPendingWorktree={handleDismissPendingWorktree}
            onNewWorktree={() => setShowNewWorktree(true)}
            onContinueWorktree={handleContinueWorktree}
            onDeleteWorktree={handleDeleteWorktree}
            onRefresh={handleRefreshWorktrees}
            repoRoots={repoRoots}
            onAddRepo={handleAddRepo}
            onRemoveRepo={handleRemoveRepo}
            onOpenSettings={() => setShowSettings(true)}
            onOpenActivity={() => setShowActivity(true)}
            onOpenCleanup={() => setShowCleanup(true)}
            onOpenCommandCenter={() => {
              setShowNewWorktree(false)
              setShowActivity(false)
              setShowCleanup(false)
              setShowCommandCenter(true)
            }}
            commandCenterActive={showCommandCenter}
            width={sidebarWidth}
            collapsedGroups={collapsedGroups}
            onToggleGroup={toggleGroup}
            isGroupCollapsed={isGroupCollapsed}
            collapsedRepos={collapsedRepos}
            onToggleRepo={toggleRepo}
            unifiedRepos={unifiedRepos}
            onToggleUnifiedRepos={() => setUnifiedRepos((v) => !v)}
          />
        )}
        {sidebarVisible && <ResizeHandle onDelta={handleSidebarResize} />}
        {/* Render ALL worktrees' terminals to keep PTYs alive across switches */}
        {worktrees.map((wt) => {
          const paneList = panes[wt.path]
          if (!paneList || paneList.length === 0) return null
          const isVisible = !showNewWorktree && !showActivity && !showCleanup && !showCommandCenter && wt.path === activeWorktreeId && !pendingDeletionByPath[wt.path]
          return (
            <div
              key={wt.path}
              className="flex-1 min-w-0"
              style={{ display: isVisible ? 'flex' : 'none' }}
            >
              <WorkspaceView
                worktreePath={wt.path}
                repoLabel={wt.repoRoot.split('/').pop() || wt.repoRoot}
                branch={wt.branch}
                panes={paneList}
                focusedPaneId={activePaneId[wt.path] || paneList[0]?.id || ''}
                statuses={statuses}
                shellActivity={shellActivity}
                visible={isVisible}
                claudeCommand={claudeCommand}
                nameClaudeSessions={nameClaudeSessions}
                onSelectTab={handleSelectTab}
                onAddTab={handleAddTerminalTab}
                onAddClaudeTab={handleAddClaudeTab}
                onCloseTab={handleCloseTab}
                onRestartClaudeTab={handleRestartClaudeTab}
                onReorderTabs={handleReorderTabs}
                onMoveTabToPane={handleMoveTabToPane}
                onSplitPane={handleSplitPane}
                onSendToClaude={handleSendToClaude}
              />
            </div>
          )
        })}
        {showNewWorktree && (
          <NewWorktreeScreen
            onSubmit={handleSubmitNewWorktree}
            onCancel={() => setShowNewWorktree(false)}
            repoRoots={repoRoots}
            defaultRepoRoot={activeWorktreeId ? worktreeRepoByPath[activeWorktreeId] : undefined}
          />
        )}
        {showActivity && (
          <div className="flex-1 min-w-0 flex">
            <Activity
              onClose={() => setShowActivity(false)}
              worktrees={worktrees}
              prStatuses={prStatuses}
              mergedPaths={mergedPaths}
            />
          </div>
        )}
        {showCleanup && (
          <div className="flex-1 min-w-0 flex">
            <Cleanup
              onClose={() => setShowCleanup(false)}
              worktrees={worktrees}
              prStatuses={prStatuses}
              mergedPaths={mergedPaths}
              lastActive={lastActive}
              onBulkDelete={handleBulkDeleteWorktrees}
            />
          </div>
        )}
        {showCommandCenter && (
          <CommandCenter
            worktrees={worktrees}
            worktreeStatuses={worktreeStatuses}
            worktreePendingTools={worktreePendingTools}
            prStatuses={prStatuses}
            mergedPaths={mergedPaths}
            lastActive={lastActive}
            tailLines={tailLines}
            terminalTabs={terminalTabs}
            onClose={() => setShowCommandCenter(false)}
            onSelect={(path) => {
              setShowCommandCenter(false)
              setShowNewWorktree(false)
              setShowActivity(false)
              setShowCleanup(false)
              setActiveWorktreeId(path)
            }}
          />
        )}
        {!showNewWorktree && !showActivity && !showCleanup && !showCommandCenter && !activeWorktreeId && worktrees.length > 0 && (
          <div className="flex-1 flex items-center justify-center text-dim">
            Select a worktree to begin
          </div>
        )}
        {!showNewWorktree && !showActivity && !showCleanup && !showCommandCenter && isPendingId(activeWorktreeId) && (() => {
          const pending = pendingWorktrees.find((p) => p.id === activeWorktreeId)
          if (!pending) return null
          return (
            <CreatingWorktreeScreen
              pending={pending}
              onRetry={handleRetryPendingWorktree}
              onDismiss={handleDismissPendingWorktree}
              onContinue={handleContinuePendingWorktree}
            />
          )
        })()}
        {!showNewWorktree && !showActivity && !showCleanup && !showCommandCenter && activeWorktreeId && pendingDeletionByPath[activeWorktreeId] && (
          <DeletingWorktreeScreen
            deletion={pendingDeletionByPath[activeWorktreeId]}
            onDismiss={handleDismissPendingDeletion}
          />
        )}
        <QuestCard
          step={questStep}
          onDismiss={() => setQuestStep('done')}
          onFinish={() => setQuestStep('done')}
        />
        {/* Right panel — hidden on the new-worktree screen so the form gets the full width */}
        {!showNewWorktree && !showActivity && !showCleanup && !showCommandCenter && (
          <ResizeHandle onDelta={handleRightPanelResize} />
        )}
        {!showNewWorktree && !showActivity && !showCleanup && !showCommandCenter && (
          <RightColumn
            width={rightPanelWidth}
            activeWorktreeId={activeWorktreeId}
            worktrees={worktrees}
            prStatuses={prStatuses}
            prLoading={prLoading}
            hasGithubToken={hasGithubToken}
            activeRepoConfig={activeRepoConfig}
            onRefreshPRs={fetchAllPRStatuses}
            onOpenGithubSettings={() => {
              setSettingsInitialSection('github')
              setShowSettings(true)
            }}
            onMerged={refreshMergedStatus}
            onRemoveWorktree={handleDeleteWorktree}
            onOpenCommit={handleOpenCommit}
            onOpenDiff={handleOpenDiff}
            onOpenFile={handleOpenFile}
            onSendToClaude={handleSendToClaude}
          />
        )}
      </div>
    </div>
    {settingsOverlay}
    {showCommandPalette && (
      <CommandPalette
        worktrees={worktrees}
        worktreeStatuses={worktreeStatuses}
        prStatuses={prStatuses}
        mergedPaths={mergedPaths}
        activeWorktreeId={activeWorktreeId}
        resolvedHotkeys={resolvedHotkeys}
        onClose={() => setShowCommandPalette(false)}
        onSelectWorktree={(path) => {
          setShowNewWorktree(false)
          setShowActivity(false)
          setShowCleanup(false)
          setShowCommandCenter(false)
          setActiveWorktreeId(path)
        }}
        onAction={(action) => {
          const handler = hotkeyActions[action]
          if (handler) handler()
        }}
      />
    )}
    </HotkeysProvider>
  )
}

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useSettings, usePrs, useOnboarding, useHooks, useWorktrees, useTerminals, usePanes, useLastActive, useUpdater, useRepoConfigs } from './store'
import { useTailLineBuffer } from './hooks/useTailLineBuffer'
import { useTabHandlers } from './hooks/useTabHandlers'
import { useHotkeyHandlers } from './hooks/useHotkeyHandlers'
import { useWorktreeHandlers } from './hooks/useWorktreeHandlers'
import type { Worktree, TerminalTab, PtyStatus, PendingTool, QuestStep, PendingWorktree, UpdaterStatus, RepoConfig, PaneNode } from './types'
import { getLeaves, findLeaf } from '../shared/state/terminals'
import { CheckCircle2, FolderOpen } from 'lucide-react'
import { THEME_OPTIONS } from './themes'
import { HotkeysProvider, Tooltip } from './components/Tooltip'
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
import { AGENT_REGISTRY } from '../shared/agent-registry'
import { AgentIcon } from './components/AgentIcon'
import { Activity } from './components/Activity'
import { Cleanup } from './components/Cleanup'
import { CommandCenter } from './components/CommandCenter'
import { ReviewScreen } from './components/ReviewScreen'
import { CommandPalette } from './components/CommandPalette'
import { HotkeyCheatsheet } from './components/HotkeyCheatsheet'
import { NewProjectScreen } from './components/NewProjectScreen'
import { ReportIssueModal, onOpenReportIssue, type OpenReportIssueDetail } from './components/ReportIssueModal'
import iconUrl from '../../resources/icon.png'
import { PerfMonitorHUD } from './components/PerfMonitorHUD'
import { focusTerminalById } from './components/XTerminal'
import { ErrorBoundary } from './components/ErrorBoundary'
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
    for (const [wtPath, tree] of Object.entries(panes)) {
      out[wtPath] = getLeaves(tree).flatMap((l) => l.tabs)
    }
    return out
  }, [panes])
  const activeTabId = useMemo<Record<string, string>>(() => {
    const out: Record<string, string> = {}
    for (const [wtPath, tree] of Object.entries(panes)) {
      const leaves = getLeaves(tree)
      const focusedId = activePaneId[wtPath] ?? leaves[0]?.id
      const focused = findLeaf(tree, focusedId) || leaves[0]
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
  // Hooks consent lives in the main-process store. Accept/decline
  // dispatch through dedicated methods; the boot-time "already installed?"
  // detection lives in main.
  const { consent: hooksConsent } = useHooks()
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
  const [rightColumnHidden, setRightColumnHidden] = useState<boolean>(() => {
    return localStorage.getItem('harness:rightColumnHidden') === '1'
  })
  useEffect(() => {
    localStorage.setItem('harness:rightColumnHidden', rightColumnHidden ? '1' : '0')
  }, [rightColumnHidden])
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
  const [showReview, setShowReview] = useState(false)
  const [reviewMode, setReviewMode] = useState<'working' | 'branch'>('branch')
  const [reviewCommit, setReviewCommit] = useState<{ hash: string; shortHash: string; subject: string } | undefined>(undefined)
  const [showCommandPalette, setShowCommandPalette] = useState(false)
  const [commandPaletteMode, setCommandPaletteMode] = useState<'root' | 'files'>('root')
  const [showPerfMonitor, setShowPerfMonitor] = useState(false)
  const [showHotkeyCheatsheet, setShowHotkeyCheatsheet] = useState(false)
  const [showNewProject, setShowNewProject] = useState(false)
  const [reportIssueState, setReportIssueState] = useState<OpenReportIssueDetail | null>(null)
  // `theme` and `defaultAgent` are both seeded at init, so we track
  // explicit confirmation separately for the onboarding step checkmarks.
  const [themeChosen, setThemeChosen] = useState(false)
  const [agentChosen, setAgentChosen] = useState(false)
  const tailLines = useTailLineBuffer()
  const settings = useSettings()
  const { hasGithubToken: hasGithubPat, githubAuthSource, nameClaudeSessions, defaultAgent, theme: activeTheme } = settings
  const nameAgentSessions = nameClaudeSessions
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

  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme
  }, [settings.theme])

  // Open Settings from the menu (Cmd+,)
  useEffect(() => {
    const cleanup = window.api.onOpenSettings(() => setShowSettings(true))
    return cleanup
  }, [])

  // Toggle perf monitor from the menu (Cmd+Shift+D)
  useEffect(() => {
    const cleanup = window.api.onTogglePerfMonitor(() => setShowPerfMonitor((v) => !v))
    return cleanup
  }, [])

  // Open Keyboard Shortcuts from the menu
  useEffect(() => {
    const cleanup = window.api.onOpenKeyboardShortcuts(() => setShowHotkeyCheatsheet(true))
    return cleanup
  }, [])

  // File → New Project… (Cmd+N)
  useEffect(() => {
    const cleanup = window.api.onOpenNewProject(() => setShowNewProject(true))
    return cleanup
  }, [])

  // Report Issue — triggered from the Help menu and from the
  // openReportIssueFor() helper (used by the error boundary).
  useEffect(() => {
    const cleanupMenu = window.api.onOpenReportIssue(() => setReportIssueState({}))
    const cleanupBus = onOpenReportIssue((detail) => setReportIssueState(detail))
    return () => {
      cleanupMenu()
      cleanupBus()
    }
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
    handleAddAgentTab,
    handleAddBrowserTab,
    handleCloseTab,
    handleRestartAgentTab,
    handleSelectTab,
    handleReorderTabs,
    handleMoveTabToPane,
    handleSplitPane,
    handleSendToAgent,
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
    setRightColumnHidden,
    setShowNewWorktree,
    setShowCommandCenter,
    setShowCommandPalette,
    setCommandPaletteMode,
    setShowPerfMonitor,
    setShowHotkeyCheatsheet,
    setShowReview,
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
      if (s === 'waiting') worstStatus = 'waiting'
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

  if (showNewProject) {
    return (
      <NewProjectScreen
        onCancel={() => setShowNewProject(false)}
        onCreated={(createdPath) => {
          setShowNewProject(false)
          const main =
            worktrees.find((w) => w.repoRoot === createdPath && w.isMain) ||
            worktrees.find((w) => w.repoRoot === createdPath)
          if (main) setActiveWorktreeId(main.path)
        }}
      />
    )
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
    const step1Complete = themeChosen
    const step2Complete = agentChosen
    const step3Complete = hooksConsent !== 'pending'
    const activeStep: 1 | 2 | 3 | 4 = !step1Complete
      ? 1
      : !step2Complete
        ? 2
        : !step3Complete
          ? 3
          : 4
    return (
      <HotkeysProvider bindings={resolvedHotkeys}>
      <div className="flex h-full flex-col">
        <div className="drag-region h-10 shrink-0" />
        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-xl w-full px-6 py-6">
            <div className="text-center mb-6">
              <img
                src={iconUrl}
                alt="Harness"
                className="w-16 h-16 mx-auto rounded-2xl mb-4 brand-glow-amber"
              />
              <h1 className="gradient-text text-3xl font-extrabold tracking-tight mb-2">Harness</h1>
              <p className="text-fg text-sm leading-relaxed max-w-md mx-auto">
                Run many coding agents in parallel — one window, isolated git worktrees,
                clear status on who needs you.
              </p>
            </div>

            <div className="grid grid-cols-3 gap-2 mb-8">
              <div className="rounded-lg border border-border bg-panel p-3">
                <div className="h-14 mb-3 flex flex-col justify-center gap-1.5 bg-app/50 rounded border border-border px-2 py-1.5">
                  <div className="flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-success shrink-0" />
                    <span className="text-[9px] font-mono text-muted flex-1 truncate">feat/onboarding</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-warning shrink-0" />
                    <span className="text-[9px] font-mono text-muted flex-1 truncate">fix/login-flash</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-success shrink-0" />
                    <span className="text-[9px] font-mono text-muted flex-1 truncate">refactor/auth</span>
                  </div>
                </div>
                <div className="text-xs text-fg-bright font-medium mb-0.5">Parallel agents</div>
                <div className="text-[11px] text-dim leading-snug">One window, many sessions</div>
              </div>
              <div className="rounded-lg border border-border bg-panel p-3">
                <div className="h-14 mb-3 flex items-center justify-center bg-app/50 rounded border border-border">
                  <div className="flex flex-col items-center">
                    <div className="px-1.5 py-0.5 rounded bg-surface border border-border-strong text-[8px] font-mono text-fg-bright">.git</div>
                    <svg width="60" height="12" viewBox="0 0 60 12" className="text-faint">
                      <path d="M30 0 L30 5 L10 5 L10 12 M30 5 L30 12 M30 5 L50 5 L50 12" stroke="currentColor" strokeWidth="1" fill="none" />
                    </svg>
                    <div className="flex gap-1.5">
                      <div className="w-2.5 h-2.5 rounded bg-success/20 border border-success/50" />
                      <div className="w-2.5 h-2.5 rounded bg-info/20 border border-info/50" />
                      <div className="w-2.5 h-2.5 rounded bg-warning/20 border border-warning/50" />
                    </div>
                  </div>
                </div>
                <div className="text-xs text-fg-bright font-medium mb-0.5">Worktrees handled</div>
                <div className="text-[11px] text-dim leading-snug">Your original repo stays clean</div>
              </div>
              <div className="rounded-lg border border-border bg-panel p-3">
                <div className="h-14 mb-3 flex flex-col items-center justify-center gap-1 bg-app/50 rounded border border-border px-2">
                  <div className="flex items-center gap-1.5 w-full">
                    <span className="w-1.5 h-1.5 rounded-full bg-success shrink-0" />
                    <span className="text-[9px] text-muted font-mono">working</span>
                  </div>
                  <div className="flex items-center gap-1.5 w-full">
                    <span className="w-1.5 h-1.5 rounded-full bg-warning shrink-0" />
                    <span className="text-[9px] text-muted font-mono">waiting</span>
                  </div>
                  <div className="flex items-center gap-1.5 w-full">
                    <span className="w-1.5 h-1.5 rounded-full bg-danger shrink-0" />
                    <span className="text-[9px] text-muted font-mono">approve</span>
                  </div>
                </div>
                <div className="text-xs text-fg-bright font-medium mb-0.5">Status at a glance</div>
                <div className="text-[11px] text-dim leading-snug">Dots show who's waiting</div>
              </div>
            </div>

            <div className="space-y-3">
              <div
                className={`rounded-xl border bg-panel p-4 transition-colors ${
                  activeStep === 1
                    ? 'border-accent/50 ring-1 ring-accent/25'
                    : 'border-border'
                }`}
              >
                <div className="flex items-start gap-3 mb-3">
                  {step1Complete ? (
                    <CheckCircle2 className="w-5 h-5 text-success shrink-0 mt-0.5" />
                  ) : (
                    <div
                      className={`w-5 h-5 rounded-full border-2 text-[11px] font-bold flex items-center justify-center shrink-0 mt-0.5 ${
                        activeStep === 1 ? 'border-accent text-accent' : 'border-border-strong text-dim'
                      }`}
                    >
                      1
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="text-fg-bright text-sm font-medium">Pick a theme</div>
                    <div className="text-xs text-dim mt-0.5">Obviously the most important step. And for the love of god don't pick a light theme.</div>
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-1.5 ml-8">
                  {THEME_OPTIONS.map((opt) => {
                    const isActive = activeTheme === opt.id && themeChosen
                    return (
                      <button
                        key={opt.id}
                        onClick={() => {
                          window.api.setTheme(opt.id)
                          setThemeChosen(true)
                        }}
                        className={`flex items-center gap-2 px-2 py-1.5 rounded-lg border transition-colors cursor-pointer ${
                          isActive
                            ? 'bg-surface text-fg-bright border-fg'
                            : 'bg-panel border-border text-dim hover:text-fg hover:border-border-strong'
                        }`}
                      >
                        <div className="flex gap-0.5 shrink-0">
                          {opt.swatches.map((c) => (
                            <span
                              key={c}
                              className="w-2.5 h-2.5 rounded-sm border border-border-strong"
                              style={{ backgroundColor: c }}
                            />
                          ))}
                        </div>
                        <span className="text-[11px] font-medium truncate">{opt.label}</span>
                      </button>
                    )
                  })}
                </div>
              </div>

              <div
                className={`rounded-xl border bg-panel p-4 transition-colors ${
                  activeStep === 2
                    ? 'border-accent/50 ring-1 ring-accent/25'
                    : 'border-border'
                }`}
              >
                <div className="flex items-start gap-3 mb-3">
                  {step2Complete ? (
                    <CheckCircle2 className="w-5 h-5 text-success shrink-0 mt-0.5" />
                  ) : (
                    <div
                      className={`w-5 h-5 rounded-full border-2 text-[11px] font-bold flex items-center justify-center shrink-0 mt-0.5 ${
                        activeStep === 2 ? 'border-accent text-accent' : 'border-border-strong text-dim'
                      }`}
                    >
                      2
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="text-fg-bright text-sm font-medium">Choose your default agent</div>
                    <div className="text-xs text-dim mt-0.5">This is what new tabs will spawn. You can change it later in Settings.</div>
                  </div>
                </div>
                <div className="flex gap-2 ml-8">
                  {AGENT_REGISTRY.map((agent) => (
                    <button
                      key={agent.kind}
                      onClick={() => {
                        window.api.setDefaultAgent(agent.kind)
                        setAgentChosen(true)
                      }}
                      className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors cursor-pointer ${
                        defaultAgent === agent.kind && agentChosen
                          ? 'bg-surface text-fg-bright border border-fg'
                          : 'bg-panel border border-border text-dim hover:text-fg hover:border-border-strong'
                      }`}
                    >
                      <AgentIcon kind={agent.kind} size={14} />
                      {agent.displayName}
                    </button>
                  ))}
                </div>
              </div>

              <div
                className={`rounded-xl border bg-panel p-4 transition-colors ${
                  activeStep === 3
                    ? 'border-accent/50 ring-1 ring-accent/25'
                    : 'border-border'
                }`}
              >
                <div className="flex items-start gap-3 mb-3">
                  {step3Complete ? (
                    <CheckCircle2 className="w-5 h-5 text-success shrink-0 mt-0.5" />
                  ) : (
                    <div
                      className={`w-5 h-5 rounded-full border-2 text-[11px] font-bold flex items-center justify-center shrink-0 mt-0.5 ${
                        activeStep === 3 ? 'border-accent text-accent' : 'border-border-strong text-dim'
                      }`}
                    >
                      3
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="text-fg-bright text-sm font-medium">Install status hooks</div>
                    <div className="text-xs text-dim mt-0.5">
                      Adds a small hook at <code className="bg-app/50 px-1 rounded">~/.claude/settings.json</code> (and the Codex equivalent) so Harness can tell when an agent is{' '}
                      <span className="inline-flex items-center gap-1 whitespace-nowrap">
                        <span className="w-1.5 h-1.5 rounded-full bg-success" />
                        <span className="text-fg">working</span>
                      </span>,{' '}
                      <span className="inline-flex items-center gap-1 whitespace-nowrap">
                        <span className="w-1.5 h-1.5 rounded-full bg-warning" />
                        <span className="text-fg">waiting</span>
                      </span>, or{' '}
                      <span className="inline-flex items-center gap-1 whitespace-nowrap">
                        <span className="w-1.5 h-1.5 rounded-full bg-danger" />
                        <span className="text-fg">asking for approval</span>
                      </span>. Only fires for sessions Harness launches — others are untouched.
                    </div>
                  </div>
                </div>
                <div className="flex gap-2 ml-8">
                  <button
                    onClick={handleAcceptHooks}
                    className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors cursor-pointer ${
                      hooksConsent === 'accepted'
                        ? 'bg-surface text-fg-bright border border-fg'
                        : activeStep === 3
                          ? 'bg-accent/20 hover:bg-accent/30 text-fg-bright border border-accent/40'
                          : 'bg-panel border border-border text-dim hover:text-fg hover:border-border-strong'
                    }`}
                  >
                    Install hooks
                  </button>
                  <button
                    onClick={handleDeclineHooks}
                    className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors cursor-pointer ${
                      hooksConsent === 'declined'
                        ? 'bg-surface text-fg-bright border border-fg'
                        : 'bg-panel border border-border text-dim hover:text-fg hover:border-border-strong'
                    }`}
                  >
                    Not now
                  </button>
                </div>
              </div>

              <div
                className={`rounded-xl border bg-panel p-4 transition-colors ${
                  activeStep === 4
                    ? 'border-accent/50 ring-1 ring-accent/25'
                    : 'border-border'
                }`}
              >
                <div className="flex items-start gap-3 mb-3">
                  <div
                    className={`w-5 h-5 rounded-full border-2 text-[11px] font-bold flex items-center justify-center shrink-0 mt-0.5 ${
                      activeStep === 4 ? 'border-accent text-accent' : 'border-border-strong text-dim'
                    }`}
                  >
                    4
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-fg-bright text-sm font-medium">Open a git repository</div>
                    <div className="text-xs text-dim mt-0.5">Harness creates worktrees inside a sibling folder — your original repo stays untouched.</div>
                  </div>
                </div>
                <div className="ml-8 flex items-center gap-3 flex-wrap">
                  <button
                    onClick={handleAddRepo}
                    className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors cursor-pointer bg-fg-bright text-app hover:bg-fg border border-fg-bright"
                  >
                    <FolderOpen className="w-4 h-4" />
                    Open Repository
                  </button>
                  <span className="text-xs text-dim">
                    or{' '}
                    <button
                      onClick={() => setShowNewProject(true)}
                      className="text-fg-bright hover:underline cursor-pointer"
                    >
                      start a new project
                    </button>
                  </span>
                </div>
              </div>
            </div>

            <div className="mt-6 pt-5 border-t border-border/60 text-center">
              <button
                onClick={() => setShowGuide(true)}
                className="text-xs text-accent hover:underline cursor-pointer"
              >
                New to multi-agent workflows? Read the worktree guide →
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

      {/* Hooks consent banner — one-time prompt at first launch. Harness
          installs agent status hooks at ~/.claude/settings.json (+ Codex
          equivalent). The hook command is gated on $HARNESS_TERMINAL_ID
          so sessions spawned outside Harness are unaffected. */}
      {hooksConsent === 'pending' && (
        <div className="bg-warning/15 border-b border-warning/30 pl-20 pr-4 py-2.5 drag-region flex items-center gap-3 shrink-0">
          <span className="text-warning text-sm flex-1">
            Harness installs status hooks at <code className="text-xs">~/.claude/settings.json</code> to detect
            agent state (waiting, processing, needs approval). They only fire for agents you
            launch inside Harness and can be removed at any time from Settings.
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
            onOpenHotkeyCheatsheet={() => setShowHotkeyCheatsheet(true)}
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
          const paneTree = panes[wt.path]
          if (!paneTree) return null
          const leaves = getLeaves(paneTree)
          if (leaves.length === 0 || !leaves.some((l) => l.tabs.length > 0)) return null
          const isVisible = !showNewWorktree && !showActivity && !showCleanup && !showCommandCenter && !showReview && wt.path === activeWorktreeId && !pendingDeletionByPath[wt.path]
          return (
            <div
              key={wt.path}
              className="flex-1 min-w-0"
              style={{ display: isVisible ? 'flex' : 'none' }}
            >
              <ErrorBoundary label={`worktree:${wt.path}`}>
                <WorkspaceView
                  worktreePath={wt.path}
                  repoLabel={wt.repoRoot.split('/').pop() || wt.repoRoot}
                  branch={wt.branch}
                  paneTree={paneTree}
                  focusedPaneId={activePaneId[wt.path] || leaves[0]?.id || ''}
                  statuses={statuses}
                  shellActivity={shellActivity}
                  visible={isVisible}
                  nameAgentSessions={nameAgentSessions}
                  onSelectTab={handleSelectTab}
                  onAddTab={handleAddTerminalTab}
                  defaultAgent={defaultAgent ?? 'claude'}
                  onAddAgentTab={(wt, kind, paneId) => handleAddAgentTab(wt, kind ?? defaultAgent ?? 'claude', paneId)}
                  onAddBrowserTab={handleAddBrowserTab}
                  onCloseTab={handleCloseTab}
                  onRestartAgentTab={handleRestartAgentTab}
                  onReorderTabs={handleReorderTabs}
                  onMoveTabToPane={handleMoveTabToPane}
                  onSplitPane={handleSplitPane}
                  onSendToAgent={handleSendToAgent}
                  rightColumnHidden={rightColumnHidden}
                  onShowRightColumn={() => setRightColumnHidden(false)}
                />
              </ErrorBoundary>
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
        {showReview && activeWorktreeId && (() => {
          const reviewWt = worktrees.find((w) => w.path === activeWorktreeId)
          return (
            <div className="flex-1 min-w-0 flex">
              <ReviewScreen
                worktreePath={activeWorktreeId}
                branchName={reviewWt?.branch ?? 'unknown'}
                repoLabel={reviewWt ? (reviewWt.repoRoot.split('/').pop() || reviewWt.repoRoot) : ''}
                mode={reviewMode}
                commit={reviewCommit}
                onClose={() => {
                  setShowReview(false)
                  setReviewCommit(undefined)
                }}
                onSendToAgent={handleSendToAgent}
              />
            </div>
          )
        })()}
        {!showNewWorktree && !showActivity && !showCleanup && !showCommandCenter && !showReview && !activeWorktreeId && worktrees.length > 0 && (
          <div className="flex-1 flex items-center justify-center text-dim">
            Select a worktree to begin
          </div>
        )}
        {!showNewWorktree && !showActivity && !showCleanup && !showCommandCenter && !showReview && isPendingId(activeWorktreeId) && (() => {
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
        {!showNewWorktree && !showActivity && !showCleanup && !showCommandCenter && !showReview && activeWorktreeId && pendingDeletionByPath[activeWorktreeId] && (
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
        {!showNewWorktree && !showActivity && !showCleanup && !showCommandCenter && !showReview && !rightColumnHidden && (
          <ResizeHandle onDelta={handleRightPanelResize} />
        )}
        {!showNewWorktree && !showActivity && !showCleanup && !showCommandCenter && !showReview && !rightColumnHidden && (
          <RightColumn
            width={rightPanelWidth}
            activeWorktreeId={activeWorktreeId}
            activeRepoRoot={activeRepoRoot}
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
            onOpenDiff={handleOpenDiff}
            onOpenFile={handleOpenFile}
            onSendToAgent={handleSendToAgent}
            onOpenReview={() => {
              setReviewMode('branch')
              setReviewCommit(undefined)
              setShowReview(true)
            }}
            onOpenCommitReview={(hash, shortHash, subject) => {
              setReviewMode('branch')
              setReviewCommit({ hash, shortHash, subject })
              setShowReview(true)
            }}
            onCollapse={() => setRightColumnHidden(true)}
          />
        )}
      </div>
    </div>
    {settingsOverlay}
    {showPerfMonitor && <PerfMonitorHUD onClose={() => setShowPerfMonitor(false)} />}
    {showCommandPalette && (
      <CommandPalette
        worktrees={worktrees}
        worktreeStatuses={worktreeStatuses}
        prStatuses={prStatuses}
        mergedPaths={mergedPaths}
        activeWorktreeId={activeWorktreeId}
        resolvedHotkeys={resolvedHotkeys}
        initialMode={commandPaletteMode}
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
        onOpenFile={(filePath) => handleOpenFile(filePath)}
      />
    )}
    {showHotkeyCheatsheet && (
      <HotkeyCheatsheet
        resolvedHotkeys={resolvedHotkeys}
        onClose={() => setShowHotkeyCheatsheet(false)}
        onOpenCommandPalette={() => {
          setCommandPaletteMode('root')
          setShowCommandPalette(true)
        }}
      />
    )}
    <ReportIssueModal
      open={reportIssueState !== null}
      onClose={() => setReportIssueState(null)}
      initialKind={reportIssueState?.kind}
      initialTitle={reportIssueState?.title}
      initialBody={reportIssueState?.body}
      prefilledContext={reportIssueState?.context}
    />
    </HotkeysProvider>
  )
}

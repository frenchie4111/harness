import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useSettings, usePrs, useOnboarding, useHooks, useWorktrees, useTerminals, usePanes, useLastActive, useUpdater } from './store'
import type { Worktree, TerminalTab, PtyStatus, PendingTool, QuestStep, PendingWorktree, UpdaterStatus, RepoConfig } from './types'
import type { Action } from './hotkeys'
import { resolveHotkeys } from './hotkeys'
import { HotkeysProvider } from './components/Tooltip'
import { Sidebar } from './components/Sidebar'
import { ResizeHandle } from './components/ResizeHandle'
import { NewWorktreeScreen } from './components/NewWorktreeScreen'
import { CreatingWorktreeScreen } from './components/CreatingWorktreeScreen'
import { QuestCard } from './components/QuestCard'
import { WorkspaceView } from './components/WorkspaceView'
import { ChangedFilesPanel } from './components/ChangedFilesPanel'
import { AllFilesPanel } from './components/AllFilesPanel'
import { BranchCommitsPanel } from './components/BranchCommitsPanel'
import { PRStatusPanel, MergeLocallyPanel } from './components/PRStatusPanel'
import { Settings } from './components/Settings'
import { Guide } from './components/Guide'
import { Activity } from './components/Activity'
import { Cleanup } from './components/Cleanup'
import { CommandCenter } from './components/CommandCenter'
import { CommandPalette } from './components/CommandPalette'
import iconUrl from '../../resources/icon.png'
import { focusTerminalById, flushAllTerminalHistory, markTerminalClosing } from './components/XTerminal'
import { useHotkeys } from './hooks/useHotkeys'
import { groupWorktrees, getGroupKey, type GroupKey } from './worktree-sort'

/** Create a filesystem-safe terminal ID from a worktree path */
function makeTerminalId(prefix: string, worktreePath: string): string {
  // Replace path separators with dashes, collapse multiple dashes
  const safe = worktreePath.replace(/[/\\]/g, '-').replace(/^-+/, '').replace(/-+/g, '-')
  return `${prefix}-${safe}`
}

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
  const [activeRepoConfig, setActiveRepoConfig] = useState<RepoConfig | null>(null)
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
  const [tailLines, setTailLines] = useState<Record<string, string>>({})
  const settings = useSettings()
  const { hasGithubToken, claudeCommand, nameClaudeSessions } = settings
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
  const hooksChecked = useRef(new Set<string>())

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
  useEffect(() => {
    if (!activeRepoRoot) {
      setActiveRepoConfig(null)
      return
    }
    let cancelled = false
    const load = (): void => {
      window.api.getRepoConfig(activeRepoRoot).then((cfg) => {
        if (!cancelled) setActiveRepoConfig(cfg ?? {})
      })
    }
    load()
    const unsub = window.api.onRepoConfigChanged((payload) => {
      if (payload.repoRoot === activeRepoRoot) load()
    })
    return () => {
      cancelled = true
      unsub()
    }
  }, [activeRepoRoot])

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

  // Rolling last-line-of-output cache per terminal, for the CommandCenter preview.
  // Tap terminal:data in the renderer — the main process already broadcasts it,
  // so no IPC additions are needed. Buffer in a ref, flush to state every 500ms.
  const tailBuffersRef = useRef<Record<string, string>>({})
  const tailDirtyRef = useRef(false)
  useEffect(() => {
    const stripAnsi = (s: string): string =>
      // eslint-disable-next-line no-control-regex
      s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    const cleanup = window.api.onTerminalData((id, data) => {
      const prev = tailBuffersRef.current[id] || ''
      const next = (prev + data).slice(-4096)
      tailBuffersRef.current[id] = next
      tailDirtyRef.current = true
    })
    const flush = setInterval(() => {
      if (!tailDirtyRef.current) return
      tailDirtyRef.current = false
      const out: Record<string, string> = {}
      const isMeaningful = (line: string): boolean => {
        const stripped = line.replace(/[\u2500-\u257F\u2580-\u259F]/g, '')
        const wordChars = stripped.match(/[\p{L}\p{N}]/gu)
        return !!wordChars && wordChars.length >= 3
      }
      for (const [id, buf] of Object.entries(tailBuffersRef.current)) {
        const stripped = stripAnsi(buf).replace(/\r/g, '')
        const lines = stripped
          .split('\n')
          .map((l) => l.replace(/[\u2500-\u257F\u2580-\u259F]+/g, ' ').replace(/\s+/g, ' ').trim())
          .filter(isMeaningful)
        const last = lines.slice(-4).map((l) => l.slice(0, 240))
        out[id] = last.join('\n')
      }
      setTailLines(out)
    }, 500)
    return () => {
      cleanup()
      clearInterval(flush)
    }
  }, [])

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

  // When a worktree becomes active, check hooks and set up tabs
  useEffect(() => {
    if (!activeWorktreeId) return
    // Pending ids refer to worktrees that don't exist on disk yet — skip
    // hooks + tab creation until the real path takes over.
    if (isPendingId(activeWorktreeId)) return

    // Refresh PR status on focus (throttled)
    fetchPRStatusIfStale(activeWorktreeId)

    // Check and install hooks if needed
    if (!hooksChecked.current.has(activeWorktreeId)) {
      hooksChecked.current.add(activeWorktreeId)
      ;(async () => {
        const installed = await window.api.checkHooks(activeWorktreeId)
        if (!installed && hooksConsent === 'pending') {
          // Will show the consent banner — don't install yet
          return
        }
        if (!installed && hooksConsent === 'accepted') {
          await window.api.installHooks(activeWorktreeId)
        }
      })()
    }

    // Pane initialization is handled in main now: WorktreesFSM creates
    // the default Claude+Shell pair when a worktree is created (with any
    // initial prompt embedded), and the boot-time pass + control-server
    // create path do the same for pre-existing and external worktrees.
    // The renderer just renders whatever the store has.
  }, [activeWorktreeId, hooksConsent])

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

  const handleAddRepo = useCallback(async () => {
    const root = await window.api.addRepo()
    // Main dispatches worktrees/reposChanged and refreshes the list; all we
    // do here is focus the new repo's main worktree once the store updates.
    // The effect below watches worktrees.list for the added repoRoot.
    if (root) {
      // The store will re-dispatch shortly; poll the already-live list once
      // it settles by using a microtask. Simpler: set a pending target and
      // let a focus effect pick it up. For now, just read the current list
      // — if the store has already updated by the time we reach here, this
      // works; otherwise the first worktree from the list will be shown
      // until the user clicks it.
      const added =
        worktrees.find((w) => w.repoRoot === root && w.isMain) ||
        worktrees.find((w) => w.repoRoot === root)
      if (added) setActiveWorktreeId(added.path)
    }
  }, [worktrees])

  // External worktree creation (from the harness-control MCP). Main
  // refreshes the store list AND seeds default panes (with the prompt
  // embedded) before emitting this event, so we just focus the new path.
  useEffect(() => {
    const off = window.api.onWorktreesExternalCreate(({ repoRoot, worktree }) => {
      if (!repoRoots.includes(repoRoot)) return
      setActiveWorktreeId(worktree.path)
    })
    return off
  }, [repoRoots])

  const handleRemoveRepo = useCallback(
    async (root: string) => {
      await window.api.removeRepo(root)
      // Main dispatches reposChanged + listChanged. If our current focus is
      // about to disappear, switch to whatever's first in the remaining list.
      if (activeWorktreeId) {
        const stillExists = worktrees.some(
          (w) => w.path === activeWorktreeId && w.repoRoot !== root
        )
        if (!stillExists) {
          const next = worktrees.find((w) => w.repoRoot !== root)
          setActiveWorktreeId(next?.path ?? null)
        }
      }
    },
    [activeWorktreeId, worktrees]
  )

  const handleRefreshWorktrees = useCallback(async () => {
    await window.api.refreshWorktreesList()
  }, [])

  const handleSubmitNewWorktree = useCallback(
    async (repoRoot: string, branchName: string, initialPrompt: string, teleportSessionId?: string) => {
      const id = `pending:${crypto.randomUUID()}`
      setActiveWorktreeId(id)
      setShowNewWorktree(false)

      // Main handles everything: addWorktree → setup script → ensureInitialized
      // (with the prompt embedded in the new Claude tab) → outcome.
      const result = await window.api.runPendingWorktree({
        id,
        repoRoot,
        branchName,
        initialPrompt: initialPrompt || undefined,
        teleportSessionId
      })

      if (result.outcome === 'success') {
        setActiveWorktreeId((prev) => (prev === id ? result.createdPath : prev))
      }
      // On 'setup-failed' we stay on the pending id; the user can click
      // "Continue anyway" which transitions to result.createdPath.
      // On 'error' we stay on the pending id so the error screen shows.
    },
    []
  )

  const handleRetryPendingWorktree = useCallback((id: string) => {
    void window.api.retryPendingWorktree(id)
  }, [])

  const handleDismissPendingWorktree = useCallback(
    (id: string) => {
      void window.api.dismissPendingWorktree(id)
      setActiveWorktreeId((prev) => (prev === id ? null : prev))
    },
    []
  )

  const handleContinuePendingWorktree = useCallback(
    (id: string) => {
      // "Continue anyway" from a setup-failed screen. Main already recorded
      // createdPath on the pending entry.
      const entry = pendingWorktrees.find((p) => p.id === id)
      void window.api.dismissPendingWorktree(id)
      if (entry?.createdPath) {
        setActiveWorktreeId(entry.createdPath)
      } else {
        setActiveWorktreeId((prev) => (prev === id ? null : prev))
      }
  }, [])

  const handleContinueWorktree = useCallback(async (path: string, newBranchName: string) => {
    const repoRoot = worktreeRepoByPath[path]
    if (!repoRoot) return
    const result = await window.api.continueWorktree(repoRoot, path, newBranchName)
    // Main's worktree:continue handler doesn't refresh the store yet — ask
    // for a list refresh so the new branch name shows up.
    void window.api.refreshWorktreesList()
    // Branch changed — re-fetch PR status for this worktree.
    void window.api.refreshPRsOne(path)
    if (result.stashConflict) {
      window.alert(
        `Checked out ${newBranchName}, but your uncommitted changes did not apply cleanly and are still in the stash.\n\nRun \`git stash pop\` inside the worktree after resolving conflicts.`
      )
    }
  }, [worktreeRepoByPath])

  const handleDeleteWorktree = useCallback(async (path: string) => {
    // Check for dirty changes
    const dirty = await window.api.isWorktreeDirty(path)
    if (dirty) {
      const confirmed = window.confirm(
        'This worktree has uncommitted changes that will be lost. Delete anyway?'
      )
      if (!confirmed) return
    }

    // Kill any terminals running in this worktree and drop their history
    const tabs = terminalTabs[path] || []
    for (const tab of tabs) {
      if (tab.type !== 'diff' && tab.type !== 'file') markTerminalClosing(tab.id)
      window.api.killTerminal(tab.id)
    }
    // Clean up pane state — main owns the panes map
    void window.api.panesClearForWorktree(path)
    setActivePaneId((prev) => {
      const next = { ...prev }
      delete next[path]
      return next
    })

    // Force remove if dirty (user already confirmed), normal remove otherwise
    const pr = prStatuses[path]
    const repoRoot = worktreeRepoByPath[path]
    if (!repoRoot) return
    await window.api.removeWorktree(repoRoot, path, dirty, pr ? { prNumber: pr.number, prState: pr.state } : undefined)
    // Main's worktree:remove handler calls worktreesFSM.refreshList(),
    // which will dispatch listChanged. Switch focus if necessary.
    if (path === activeWorktreeId) {
      const next = worktrees.find((w) => w.path !== path)
      setActiveWorktreeId(next?.path ?? null)
    }
  }, [terminalTabs, activeWorktreeId, prStatuses, worktreeRepoByPath, worktrees])

  // Bulk delete used by the Cleanup screen. Skips per-path confirmation — the
  // Cleanup UI owns the single confirm — and removes each worktree sequentially
  // so git operations don't race each other.
  const handleBulkDeleteWorktrees = useCallback(
    async (
      paths: string[],
      force: boolean,
      onProgress?: (path: string, phase: 'start' | 'done') => void
    ) => {
      for (const path of paths) {
        onProgress?.(path, 'start')
        const tabs = terminalTabs[path] || []
        for (const tab of tabs) {
          if (tab.type !== 'diff' && tab.type !== 'file') markTerminalClosing(tab.id)
          window.api.killTerminal(tab.id)
        }
        void window.api.panesClearForWorktree(path)
        setActivePaneId((prev) => {
          const next = { ...prev }
          delete next[path]
          return next
        })
        try {
          const pr = prStatuses[path]
          const repoRoot = worktreeRepoByPath[path]
          if (repoRoot) {
            await window.api.removeWorktree(repoRoot, path, force, pr ? { prNumber: pr.number, prState: pr.state } : undefined)
          }
        } catch (err) {
          console.error('Failed to remove worktree', path, err)
        }
        onProgress?.(path, 'done')
      }
      // Main dispatched listChanged on each removeWorktree. Route focus off
      // the deleted set if necessary.
      if (activeWorktreeId && paths.includes(activeWorktreeId)) {
        const next = worktrees.find((w) => !paths.includes(w.path))
        setActiveWorktreeId(next?.path ?? null)
      }
    },
    [terminalTabs, activeWorktreeId, prStatuses, worktreeRepoByPath, worktrees]
  )

  // Append a tab to a specific pane (or the focused pane if paneId is omitted).
  // Creates an initial pane if the worktree has none. Main owns the pane
  // tree; we resolve the target pane id locally and pass it through.
  const appendTabToPane = useCallback(
    (worktreePath: string, tab: TerminalTab, paneId?: string) => {
      const list = panes[worktreePath] || []
      const targetId = paneId || activePaneId[worktreePath] || list[0]?.id
      void window.api.panesAddTab(worktreePath, tab, targetId)
      if (targetId) {
        setActivePaneId((prev) => ({ ...prev, [worktreePath]: targetId }))
      }
    },
    [activePaneId, panes]
  )

  const handleAddTerminalTab = useCallback(
    (worktreePath: string, paneId?: string) => {
      const id = `shell-${Date.now()}`
      appendTabToPane(worktreePath, { id, type: 'shell', label: 'Shell' }, paneId)
    },
    [appendTabToPane]
  )

  const handleAddClaudeTab = useCallback(
    (worktreePath: string, paneId?: string) => {
      const id = `${makeTerminalId('claude', worktreePath)}-${Date.now()}`
      appendTabToPane(
        worktreePath,
        { id, type: 'claude', label: 'Claude', sessionId: crypto.randomUUID() },
        paneId
      )
    },
    [appendTabToPane]
  )

  const handleCloseTab = useCallback(
    (worktreePath: string, tabId: string) => {
      // Only kill PTY for terminal tabs, not diff/file viewer tabs
      if (!tabId.startsWith('diff-') && !tabId.startsWith('file-')) {
        markTerminalClosing(tabId)
        window.api.killTerminal(tabId)
      }
      void window.api.panesCloseTab(worktreePath, tabId)
    },
    []
  )

  const handleRestartClaudeTab = useCallback(
    (worktreePath: string, tabId: string) => {
      markTerminalClosing(tabId)
      window.api.killTerminal(tabId)
      window.api.clearTerminalHistory(tabId)
      const newId = `${makeTerminalId('claude', worktreePath)}-${Date.now()}`
      const newSessionId = crypto.randomUUID()
      void window.api.panesRestartClaudeTab(worktreePath, tabId, newId, newSessionId)
    },
    []
  )

  const handleRestartAllClaudeTabs = useCallback(() => {
    for (const [worktreePath, paneList] of Object.entries(panes)) {
      for (const pane of paneList) {
        for (const tab of pane.tabs) {
          if (tab.type === 'claude') {
            handleRestartClaudeTab(worktreePath, tab.id)
          }
        }
      }
    }
    void window.api.dismissHooksJustInstalled()
  }, [panes, handleRestartClaudeTab])

  const handleSelectTab = useCallback(
    (worktreePath: string, paneId: string, tabId: string) => {
      void window.api.panesSelectTab(worktreePath, paneId, tabId)
      setActivePaneId((prev) => ({ ...prev, [worktreePath]: paneId }))
    },
    []
  )

  const handleOpenCommit = useCallback(
    (hash: string, shortHash: string, subject: string) => {
      if (!activeWorktreeId) return
      const tabId = `diff-commit-${shortHash}`
      const list = panes[activeWorktreeId] || []
      const existingPane = list.find((p) => p.tabs.some((t) => t.id === tabId))
      if (existingPane) {
        handleSelectTab(activeWorktreeId, existingPane.id, tabId)
        return
      }
      const tab: TerminalTab = {
        id: tabId,
        type: 'diff',
        label: `${shortHash} ${subject}`,
        commitHash: hash
      }
      appendTabToPane(activeWorktreeId, tab)
    },
    [activeWorktreeId, panes, handleSelectTab, appendTabToPane]
  )

  const handleReorderTabs = useCallback(
    (worktreePath: string, paneId: string, fromId: string, toId: string) => {
      if (fromId === toId) return
      void window.api.panesReorderTabs(worktreePath, paneId, fromId, toId)
    },
    []
  )

  // Move a tab from one pane to another (or to a different index within the same pane).
  // If toIndex is undefined, appends at the end.
  const handleMoveTabToPane = useCallback(
    (worktreePath: string, tabId: string, toPaneId: string, toIndex?: number) => {
      void window.api.panesMoveTabToPane(worktreePath, tabId, toPaneId, toIndex)
      setActivePaneId((prev) => ({ ...prev, [worktreePath]: toPaneId }))
    },
    []
  )

  // Split: create a new pane to the right of `fromPaneId`. Main figures out
  // the new pane's type (claude → shell, otherwise mirror) and returns the
  // new pane object so we can route per-client focus to it.
  const handleSplitPane = useCallback(
    async (worktreePath: string, fromPaneId: string) => {
      const newPane = await window.api.panesSplitPane(worktreePath, fromPaneId)
      if (newPane) {
        setActivePaneId((prev) => ({ ...prev, [worktreePath]: newPane.id }))
      }
    },
    []
  )

  const handleSendToClaude = useCallback(
    (worktreePath: string, text: string) => {
      const paneList = panes[worktreePath] || []
      let targetPaneId: string | undefined
      let targetTabId: string | undefined
      // Prefer a pane whose active tab is already a claude tab
      for (const pane of paneList) {
        const active = pane.tabs.find((t) => t.id === pane.activeTabId)
        if (active?.type === 'claude') {
          targetPaneId = pane.id
          targetTabId = active.id
          break
        }
      }
      // Otherwise pick the first claude tab we can find
      if (!targetTabId) {
        for (const pane of paneList) {
          const c = pane.tabs.find((t) => t.type === 'claude')
          if (c) {
            targetPaneId = pane.id
            targetTabId = c.id
            break
          }
        }
      }
      if (!targetPaneId || !targetTabId) return
      setActiveWorktreeId(worktreePath)
      handleSelectTab(worktreePath, targetPaneId, targetTabId)
      const id = targetTabId
      requestAnimationFrame(() => {
        window.api.writeTerminal(id, '\x1b[200~' + text + '\x1b[201~')
        focusTerminalById(id)
      })
    },
    [panes, handleSelectTab]
  )

  const handleOpenFile = useCallback(
    (filePath: string) => {
      if (!activeWorktreeId) return
      const tabId = `file-${filePath}`
      const list = panes[activeWorktreeId] || []
      const existingPane = list.find((p) => p.tabs.some((t) => t.id === tabId))
      if (existingPane) {
        handleSelectTab(activeWorktreeId, existingPane.id, tabId)
        return
      }
      const fileName = filePath.split('/').pop() || filePath
      const tab: TerminalTab = {
        id: tabId,
        type: 'file',
        label: fileName,
        filePath
      }
      appendTabToPane(activeWorktreeId, tab)
    },
    [activeWorktreeId, panes, handleSelectTab, appendTabToPane]
  )

  const handleOpenDiff = useCallback(
    (filePath: string, staged: boolean, mode: 'working' | 'branch' = 'working') => {
      if (!activeWorktreeId) return
      const branchDiff = mode === 'branch'
      const kind = branchDiff ? 'branch' : staged ? 'staged' : 'unstaged'
      const tabId = `diff-${kind}-${filePath}`
      const list = panes[activeWorktreeId] || []
      const existingPane = list.find((p) => p.tabs.some((t) => t.id === tabId))
      if (existingPane) {
        handleSelectTab(activeWorktreeId, existingPane.id, tabId)
        return
      }
      const fileName = filePath.split('/').pop() || filePath
      const tab: TerminalTab = {
        id: tabId,
        type: 'diff',
        label: fileName,
        filePath,
        staged,
        branchDiff
      }
      appendTabToPane(activeWorktreeId, tab)
    },
    [activeWorktreeId, panes, handleSelectTab, appendTabToPane]
  )

  // --- Hotkey action handlers ---
  // Mirror the sidebar's grouping/rendering order so hotkey navigation matches what's on screen.
  const byRepoGroups = useMemo(() => {
    if (unifiedRepos && repoRoots.length > 1) {
      return [{ repoRoot: '__unified__', groups: groupWorktrees(worktrees, prStatuses, mergedPaths) }]
    }
    const map = new Map<string, Worktree[]>()
    for (const root of repoRoots) map.set(root, [])
    for (const wt of worktrees) {
      if (!map.has(wt.repoRoot)) map.set(wt.repoRoot, [])
      map.get(wt.repoRoot)!.push(wt)
    }
    return Array.from(map.entries()).map(([repoRoot, wts]) => ({
      repoRoot,
      groups: groupWorktrees(wts, prStatuses, mergedPaths)
    }))
  }, [unifiedRepos, repoRoots, worktrees, prStatuses, mergedPaths])

  const allOrderedWorktrees = useMemo(() => {
    const out: Worktree[] = []
    for (const { groups } of byRepoGroups) {
      for (const group of groups) out.push(...group.worktrees)
    }
    return out
  }, [byRepoGroups])

  const visibleWorktrees = useMemo(() => {
    const out: Worktree[] = []
    for (const { repoRoot, groups } of byRepoGroups) {
      if (collapsedRepos[repoRoot]) continue
      for (const group of groups) {
        if (isGroupCollapsed(repoRoot, group.key)) continue
        out.push(...group.worktrees)
      }
    }
    return out
  }, [byRepoGroups, collapsedRepos, isGroupCollapsed])

  const scopeForWorktree = useCallback(
    (wt: Worktree): string =>
      unifiedRepos && repoRoots.length > 1 ? '__unified__' : wt.repoRoot,
    [unifiedRepos, repoRoots]
  )

  const ensureWorktreeVisible = useCallback(
    (wt: Worktree) => {
      const scope = scopeForWorktree(wt)
      const key = getGroupKey(wt, prStatuses[wt.path], mergedPaths?.[wt.path])
      if (isGroupCollapsed(scope, key)) {
        setCollapsedGroups((prev) => ({ ...prev, [`${scope}:${key}`]: false }))
      }
      if (scope !== '__unified__' && collapsedRepos[scope]) {
        setCollapsedRepos((prev) => ({ ...prev, [scope]: false }))
      }
    },
    [scopeForWorktree, prStatuses, mergedPaths, isGroupCollapsed, collapsedRepos]
  )

  const switchToWorktreeByIndex = useCallback(
    (index: number) => {
      if (index < visibleWorktrees.length) {
        setActiveWorktreeId(visibleWorktrees[index].path)
      }
    },
    [visibleWorktrees]
  )

  const cycleWorktree = useCallback(
    (delta: number) => {
      if (allOrderedWorktrees.length === 0) return
      const currentIdx = allOrderedWorktrees.findIndex((w) => w.path === activeWorktreeId)
      const nextIdx =
        (currentIdx + delta + allOrderedWorktrees.length) % allOrderedWorktrees.length
      const next = allOrderedWorktrees[nextIdx]
      ensureWorktreeVisible(next)
      setActiveWorktreeId(next.path)
    },
    [allOrderedWorktrees, activeWorktreeId, ensureWorktreeVisible]
  )

  // Cycle tabs within the focused pane of the active worktree.
  const cycleTab = useCallback(
    (delta: number) => {
      if (!activeWorktreeId) return
      const list = panes[activeWorktreeId] || []
      if (list.length === 0) return
      const paneId = activePaneId[activeWorktreeId] || list[0].id
      const pane = list.find((p) => p.id === paneId) || list[0]
      if (pane.tabs.length === 0) return
      const currentIdx = pane.tabs.findIndex((t) => t.id === pane.activeTabId)
      const nextIdx = (currentIdx + delta + pane.tabs.length) % pane.tabs.length
      handleSelectTab(activeWorktreeId, pane.id, pane.tabs[nextIdx].id)
    },
    [activeWorktreeId, panes, activePaneId, handleSelectTab]
  )

  const hotkeyActions = useMemo<Partial<Record<Action, () => void>>>(
    () => ({
      nextWorktree: () => cycleWorktree(1),
      prevWorktree: () => cycleWorktree(-1),
      worktree1: () => switchToWorktreeByIndex(0),
      worktree2: () => switchToWorktreeByIndex(1),
      worktree3: () => switchToWorktreeByIndex(2),
      worktree4: () => switchToWorktreeByIndex(3),
      worktree5: () => switchToWorktreeByIndex(4),
      worktree6: () => switchToWorktreeByIndex(5),
      worktree7: () => switchToWorktreeByIndex(6),
      worktree8: () => switchToWorktreeByIndex(7),
      worktree9: () => switchToWorktreeByIndex(8),
      newShellTab: () => {
        if (activeWorktreeId) handleAddTerminalTab(activeWorktreeId)
      },
      closeTab: () => {
        if (!activeWorktreeId) return
        const tabs = terminalTabs[activeWorktreeId] || []
        const currentTabId = activeTabId[activeWorktreeId]
        if (tabs.length > 1 && currentTabId) {
          handleCloseTab(activeWorktreeId, currentTabId)
        }
      },
      nextTab: () => cycleTab(1),
      prevTab: () => cycleTab(-1),
      newWorktree: () => setShowNewWorktree(true),
      refreshWorktrees: handleRefreshWorktrees,
      focusTerminal: () => {
        if (!activeWorktreeId) return
        const currentTabId = activeTabId[activeWorktreeId]
        if (currentTabId) focusTerminalById(currentTabId)
      },
      toggleSidebar: () => setSidebarVisible((v) => !v),
      openPR: () => {
        if (!activeWorktreeId) return
        const pr = prStatuses[activeWorktreeId]
        if (pr?.url) window.api.openExternal(pr.url)
      },
      openInEditor: () => {
        if (!activeWorktreeId) return
        window.api.openInEditor(activeWorktreeId)
      },
      toggleCommandCenter: () => setShowCommandCenter((v) => !v),
      commandPalette: () => setShowCommandPalette((v) => !v),
      splitPaneRight: () => {
        if (!activeWorktreeId) return
        const list = panes[activeWorktreeId] || []
        if (list.length === 0) return
        const fromPaneId = activePaneId[activeWorktreeId] || list[list.length - 1].id
        handleSplitPane(activeWorktreeId, fromPaneId)
      },
    }),
    [
      cycleWorktree,
      switchToWorktreeByIndex,
      cycleTab,
      activeWorktreeId,
      terminalTabs,
      activeTabId,
      handleAddTerminalTab,
      handleCloseTab,
      handleRefreshWorktrees,
      prStatuses,
      panes,
      activePaneId,
      handleSplitPane,
    ]
  )

  useHotkeys(hotkeyActions, hotkeyOverrides)

  const resolvedHotkeys = useMemo(() => resolveHotkeys(hotkeyOverrides), [hotkeyOverrides])

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
          const isVisible = !showNewWorktree && !showActivity && !showCleanup && !showCommandCenter && wt.path === activeWorktreeId
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
          <div
            className="shrink-0 h-full flex flex-col bg-panel"
            style={{ width: rightPanelWidth }}
          >
            {!activeRepoConfig?.hideMergePanel && (
              <MergeLocallyPanel
                pr={activeWorktreeId ? prStatuses[activeWorktreeId] : null}
                worktree={worktrees.find((w) => w.path === activeWorktreeId) || null}
                hasGithubToken={hasGithubToken}
                onMerged={refreshMergedStatus}
                onRemoveWorktree={handleDeleteWorktree}
              />
            )}
            {!activeRepoConfig?.hidePrPanel && (
              <PRStatusPanel
                pr={activeWorktreeId ? prStatuses[activeWorktreeId] : null}
                hasGithubToken={hasGithubToken}
                loading={prLoading}
                onRefresh={fetchAllPRStatuses}
                onConnectGithub={() => {
                  setSettingsInitialSection('github')
                  setShowSettings(true)
                }}
              />
            )}
            <BranchCommitsPanel worktreePath={activeWorktreeId} onOpenCommit={handleOpenCommit} />
            <ChangedFilesPanel
              worktreePath={activeWorktreeId}
              onOpenDiff={handleOpenDiff}
              onSendToClaude={
                activeWorktreeId
                  ? (text) => handleSendToClaude(activeWorktreeId, text)
                  : undefined
              }
            />
            <AllFilesPanel
              worktreePath={activeWorktreeId}
              onOpenFile={handleOpenFile}
              onSendToClaude={
                activeWorktreeId
                  ? (text) => handleSendToClaude(activeWorktreeId, text)
                  : undefined
              }
            />
          </div>
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

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import type { Worktree, TerminalTab, PtyStatus, PRStatus, QuestStep, WorkspacePane } from './types'
import type { Action } from './hotkeys'
import { resolveHotkeys } from './hotkeys'
import { HotkeysProvider } from './components/Tooltip'
import { Sidebar } from './components/Sidebar'
import { NewWorktreeScreen } from './components/NewWorktreeScreen'
import { QuestCard } from './components/QuestCard'
import { WorkspaceView } from './components/WorkspaceView'
import { ChangedFilesPanel } from './components/ChangedFilesPanel'
import { BranchCommitsPanel } from './components/BranchCommitsPanel'
import { PRStatusPanel } from './components/PRStatusPanel'
import { Settings } from './components/Settings'
import { Guide } from './components/Guide'
import { Activity } from './components/Activity'
import { Cleanup } from './components/Cleanup'
import { CommandCenter } from './components/CommandCenter'
import iconUrl from '../../resources/icon.png'
import { focusTerminalById, flushAllTerminalHistory, markTerminalClosing } from './components/XTerminal'
import { useHotkeys } from './hooks/useHotkeys'
import { sortedWorktrees } from './worktree-sort'

/** Create a filesystem-safe terminal ID from a worktree path */
function makeTerminalId(prefix: string, worktreePath: string): string {
  // Replace path separators with dashes, collapse multiple dashes
  const safe = worktreePath.replace(/[/\\]/g, '-').replace(/^-+/, '').replace(/-+/g, '-')
  return `${prefix}-${safe}`
}

function newPaneId(): string {
  return `pane-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export default function App(): JSX.Element {
  const [worktrees, setWorktrees] = useState<Worktree[]>([])
  const [activeWorktreeId, setActiveWorktreeId] = useState<string | null>(null)
  const [panes, setPanes] = useState<Record<string, WorkspacePane[]>>({})
  // Which pane in each worktree is the "focused" one for hotkeys (newTab, closeTab, cycleTab).
  // Tracks the last pane the user interacted with; defaults to the first pane.
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
  const [statuses, setStatuses] = useState<Record<string, PtyStatus>>({})
  const [prStatuses, setPrStatuses] = useState<Record<string, PRStatus | null>>({})
  const [mergedPaths, setMergedPaths] = useState<Record<string, boolean>>({})
  const [prLoading, setPrLoading] = useState(false)
  const [lastActive, setLastActive] = useState<Record<string, number>>({})
  const [repoRoot, setRepoRoot] = useState<string | null>(null)
  const [hooksConsent, setHooksConsent] = useState<'pending' | 'accepted' | 'declined'>('pending')
  const [sidebarVisible, setSidebarVisible] = useState(true)
  const [showNewWorktree, setShowNewWorktree] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [settingsInitialSection, setSettingsInitialSection] = useState<'github' | undefined>(undefined)
  const [showGuide, setShowGuide] = useState(false)
  const [showActivity, setShowActivity] = useState(false)
  const [showCleanup, setShowCleanup] = useState(false)
  const [showCommandCenter, setShowCommandCenter] = useState(false)
  const [tailLines, setTailLines] = useState<Record<string, string>>({})
  const [hasGithubToken, setHasGithubToken] = useState<boolean | null>(null)
  const [hotkeyOverrides, setHotkeyOverrides] = useState<Record<string, string> | undefined>(undefined)
  const [claudeCommand, setClaudeCommand] = useState<string>('')
  // Onboarding parallelism quest — see QuestCard.tsx for the steps.
  const [questStep, setQuestStepRaw] = useState<QuestStep>('hidden')
  const questLoadedRef = useRef(false)
  const questVisitedRef = useRef<Set<string>>(new Set())

  // Count of "real" worktrees the user has spawned — main repo doesn't count
  // as an agent. Used by empty state + quest advancement.
  const agentWorktreeCount = useMemo(
    () => worktrees.filter((w) => !w.isMain).length,
    [worktrees]
  )
  // Flipped to true after persisted tabs finish loading, so the persist effect
  // below doesn't overwrite the on-disk state with empty initial React state.
  const tabsLoadedRef = useRef(false)
  // Track which worktrees already have hooks installed so we only prompt once
  const hooksChecked = useRef(new Set<string>())
  // Kickoff prompts staged by the new-worktree screen. Consumed (and deleted)
  // by the effect that sets up the initial Claude tab for a fresh worktree.
  const pendingPromptsRef = useRef<Record<string, string>>({})
  // Same idea, but for --teleport session ids pasted in the new-worktree screen.
  const pendingTeleportRef = useRef<Record<string, string>>({})

  // Check GitHub token presence (on mount and whenever Settings is closed)
  useEffect(() => {
    if (showSettings) return
    window.api.hasGithubToken().then(setHasGithubToken).catch(() => setHasGithubToken(null))
  }, [showSettings])

const setQuestStep = useCallback((next: QuestStep) => {
    setQuestStepRaw(next)
    window.api.setOnboardingQuest(next).catch(() => {})
  }, [])

  // Load persisted quest state on mount
  useEffect(() => {
    window.api
      .getOnboarding()
      .then((o) => {
        setQuestStepRaw(o?.quest ?? 'hidden')
      })
      .catch(() => {})
      .finally(() => {
        questLoadedRef.current = true
      })
  }, [])

  // Advance the quest based on how many agent worktrees exist (main excluded)
  useEffect(() => {
    if (!questLoadedRef.current) return
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

  // Load repo root, worktrees, and config on mount
  useEffect(() => {
    (async () => {
      const [root, overrides, cmd, persistedPanes] = await Promise.all([
        window.api.getRepoRoot(),
        window.api.getHotkeyOverrides(),
        window.api.getClaudeCommand(),
        window.api.getWorkspacePanes()
      ])
      if (overrides) setHotkeyOverrides(overrides)
      setClaudeCommand(cmd)
      // Restore persisted panes, backfilling sessionId for any Claude tab
      // missing one (legacy tabs from before per-tab session IDs existed).
      // For the first legacy claude tab in each worktree, try to reuse the
      // most recent session on disk so the user's existing conversation
      // carries over — the spawn path will use `--resume` when the file
      // exists.
      if (persistedPanes) {
        const restored: Record<string, WorkspacePane[]> = {}
        for (const [wtPath, paneList] of Object.entries(persistedPanes)) {
          const allTabs = paneList.flatMap((p) => p.tabs)
          const needsBackfill = allTabs.some((t) => t.type === 'claude' && !t.sessionId)
          const latest = needsBackfill
            ? await window.api.getLatestClaudeSessionId(wtPath)
            : null
          let claimedLatest = false
          restored[wtPath] = paneList.map((pane) => ({
            id: pane.id,
            activeTabId: pane.activeTabId,
            tabs: pane.tabs.map((t) => {
              if (t.type !== 'claude' || t.sessionId) return t as TerminalTab
              if (latest && !claimedLatest) {
                claimedLatest = true
                return { ...t, sessionId: latest }
              }
              return { ...t, sessionId: crypto.randomUUID() }
            })
          }))
        }
        setPanes(restored)
      }
      tabsLoadedRef.current = true
      if (root) {
        setRepoRoot(root)
        const trees = await window.api.listWorktrees()
        setWorktrees(trees)
        if (trees.length > 0) {
          setActiveWorktreeId(trees[0].path)
        }
      }
    })()
  }, [])

  // Persist terminal tab metadata whenever it changes (claude + shell only —
  // diff tabs are transient and derived from file state). Waits for the
  // initial load to finish so we don't clobber on-disk state with empty
  // initial React state.
  useEffect(() => {
    if (!tabsLoadedRef.current) return
    const persistable: Record<string, { id: string; tabs: { id: string; type: 'claude' | 'shell'; label: string; sessionId?: string }[]; activeTabId: string }[]> = {}
    for (const [wtPath, paneList] of Object.entries(panes)) {
      const persistedPanes = paneList
        .map((pane) => {
          // Drop diff tabs and the transient `initialPrompt` field.
          const tabs = pane.tabs
            .filter((t) => t.type !== 'diff')
            .map((t) => ({
              id: t.id,
              type: t.type as 'claude' | 'shell',
              label: t.label,
              sessionId: t.sessionId
            }))
          if (tabs.length === 0) return null
          const validActive = tabs.some((t) => t.id === pane.activeTabId)
            ? pane.activeTabId
            : tabs[0].id
          return { id: pane.id, tabs, activeTabId: validActive }
        })
        .filter((p): p is NonNullable<typeof p> => p !== null)
      if (persistedPanes.length > 0) persistable[wtPath] = persistedPanes
    }
    window.api.setWorkspacePanes(persistable)
  }, [panes])

  // Flush all terminal scrollback to disk when the window is about to close
  useEffect(() => {
    const handler = (): void => flushAllTerminalHistory()
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [])

  // Live-reload hotkeys when changed in settings
  useEffect(() => {
    const cleanup = window.api.onHotkeysChanged((hotkeys) => {
      setHotkeyOverrides(hotkeys || undefined)
    })
    return cleanup
  }, [])

  // Live-reload claude command when changed in settings
  useEffect(() => {
    const cleanup = window.api.onClaudeCommandChanged((cmd) => {
      setClaudeCommand(cmd)
    })
    return cleanup
  }, [])

  // Load theme on mount and apply to <html data-theme="...">
  useEffect(() => {
    window.api.getTheme().then((theme) => {
      document.documentElement.dataset.theme = theme
    })
    const cleanup = window.api.onThemeChanged((theme) => {
      document.documentElement.dataset.theme = theme
    })
    return cleanup
  }, [])

  // Open Settings from the menu (Cmd+,)
  useEffect(() => {
    const cleanup = window.api.onOpenSettings(() => setShowSettings(true))
    return cleanup
  }, [])

  // Fetch PR status for all worktrees in parallel (on initial load)
  const fetchAllPRStatuses = useCallback(async () => {
    if (worktrees.length === 0) return
    setPrLoading(true)
    try {
      const results = await Promise.all(
        worktrees.map(async (wt) => {
          try {
            const status = await window.api.getPRStatus(wt.path)
            return [wt.path, status] as const
          } catch {
            return [wt.path, null] as const
          }
        })
      )
      setPrStatuses(Object.fromEntries(results))
    } finally {
      setPrLoading(false)
    }
    try {
      const merged = await window.api.getMergedStatus()
      setMergedPaths(merged)
    } catch {
      // ignore
    }
  }, [worktrees])

  const refreshMergedStatus = useCallback(async () => {
    try {
      const merged = await window.api.getMergedStatus()
      setMergedPaths(merged)
    } catch {
      // ignore
    }
  }, [])

  // Fetch a single worktree's PR status
  const fetchPRStatus = useCallback(async (wtPath: string) => {
    try {
      const status = await window.api.getPRStatus(wtPath)
      setPrStatuses((prev) => ({ ...prev, [wtPath]: status }))
    } catch {
      // ignore
    }
  }, [])

  // Initial load
  useEffect(() => {
    fetchAllPRStatuses()
  }, [fetchAllPRStatuses])

  // Map a terminal ID back to its worktree path
  const terminalToWorktree = useCallback((terminalId: string): string | null => {
    for (const [wtPath, tabs] of Object.entries(terminalTabs)) {
      if (tabs.some((t) => t.id === terminalId)) return wtPath
    }
    return null
  }, [terminalTabs])

  // Mark a worktree as recently active (debounced to avoid thrashing on rapid PTY output)
  const activityTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  const markActive = useCallback((wtPath: string) => {
    if (activityTimers.current[wtPath]) return // already scheduled
    activityTimers.current[wtPath] = setTimeout(() => {
      delete activityTimers.current[wtPath]
      setLastActive((prev) => ({ ...prev, [wtPath]: Date.now() }))
    }, 2000) // debounce: update at most every 2s per worktree
  }, [])

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
      const next = (prev + data).slice(-1024)
      tailBuffersRef.current[id] = next
      tailDirtyRef.current = true
    })
    const flush = setInterval(() => {
      if (!tailDirtyRef.current) return
      tailDirtyRef.current = false
      const out: Record<string, string> = {}
      for (const [id, buf] of Object.entries(tailBuffersRef.current)) {
        const stripped = stripAnsi(buf).replace(/\r/g, '')
        const lines = stripped.split('\n').map((l) => l.trim()).filter(Boolean)
        out[id] = lines.length ? lines[lines.length - 1].slice(0, 240) : ''
      }
      setTailLines(out)
    }, 500)
    return () => {
      cleanup()
      clearInterval(flush)
    }
  }, [])

  // Listen for status changes from main process
  useEffect(() => {
    const cleanup = window.api.onStatusChange((id, status) => {
      console.log(`[status] received: id=${id} status=${status}`)
      setStatuses((prev) => ({ ...prev, [id]: status as PtyStatus }))
      const wtPath = terminalToWorktree(id)
      if (wtPath) {
        markActive(wtPath)
        // Refresh PR status when Claude finishes a turn (may have pushed/created PR)
        if (status === 'waiting') fetchPRStatus(wtPath)
      }
    })
    return cleanup
  }, [terminalToWorktree, markActive, fetchPRStatus])

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

    // Refresh PR status on focus
    fetchPRStatus(activeWorktreeId)

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

    setPanes((prev) => {
      const existing = prev[activeWorktreeId] || []
      if (existing.some((p) => p.tabs.length > 0)) return prev
      const claudeTabId = makeTerminalId('claude', activeWorktreeId)
      const pendingPrompt = pendingPromptsRef.current[activeWorktreeId]
      delete pendingPromptsRef.current[activeWorktreeId]
      const pendingTeleport = pendingTeleportRef.current[activeWorktreeId]
      delete pendingTeleportRef.current[activeWorktreeId]
      const shellTabId = `shell-${activeWorktreeId}-${Date.now()}`
      const tabs: TerminalTab[] = [
        {
          id: claudeTabId,
          type: 'claude',
          label: 'Claude',
          // Generate a UUID even in teleport mode — we pass it to
          // `claude --teleport <id> --session-id <uuid>` so the replayed
          // history lands in a known local session file. Reloads then resume
          // via the standard `--resume` path.
          sessionId: crypto.randomUUID(),
          initialPrompt: pendingTeleport ? undefined : (pendingPrompt || undefined),
          teleportSessionId: pendingTeleport || undefined
        },
        {
          id: shellTabId,
          type: 'shell',
          label: 'Shell'
        }
      ]
      const pane: WorkspacePane = { id: newPaneId(), tabs, activeTabId: claudeTabId }
      return { ...prev, [activeWorktreeId]: [pane] }
    })
  }, [activeWorktreeId, hooksConsent])

  const handleAcceptHooks = useCallback(async () => {
    setHooksConsent('accepted')
    // Install hooks in all known worktrees
    for (const wt of worktrees) {
      const installed = await window.api.checkHooks(wt.path)
      if (!installed) {
        await window.api.installHooks(wt.path)
      }
    }
  }, [worktrees])

  const handleDeclineHooks = useCallback(() => {
    setHooksConsent('declined')
  }, [])

  // Check on mount if any worktree already has our hooks (user already consented before)
  useEffect(() => {
    if (worktrees.length === 0) return
    ;(async () => {
      for (const wt of worktrees) {
        const installed = await window.api.checkHooks(wt.path)
        if (installed) {
          setHooksConsent('accepted')
          return
        }
      }
    })()
  }, [worktrees])

  const handleSelectRepo = useCallback(async () => {
    const root = await window.api.selectRepoRoot()
    if (root) {
      setRepoRoot(root)
      const trees = await window.api.listWorktrees()
      setWorktrees(trees)
      if (trees.length > 0) {
        setActiveWorktreeId(trees[0].path)
      }
    }
  }, [])

  const handleRefreshWorktrees = useCallback(async () => {
    const trees = await window.api.listWorktrees()
    setWorktrees(trees)
  }, [])


  const handleSubmitNewWorktree = useCallback(
    async (branchName: string, initialPrompt: string, teleportSessionId?: string) => {
      const created = await window.api.addWorktree(branchName)
      if (teleportSessionId) {
        pendingTeleportRef.current[created.path] = teleportSessionId
      } else if (initialPrompt) {
        pendingPromptsRef.current[created.path] = initialPrompt
      }
      const trees = await window.api.listWorktrees()
      setWorktrees(trees)
      setActiveWorktreeId(created.path)
      setShowNewWorktree(false)
    },
    []
  )

  const handleContinueWorktree = useCallback(async (path: string, newBranchName: string) => {
    const result = await window.api.continueWorktree(path, newBranchName)
    const trees = await window.api.listWorktrees()
    setWorktrees(trees)
    // Clear cached PR status — the old branch/PR no longer belongs to this worktree
    setPrStatuses((prev) => ({ ...prev, [path]: null }))
    if (result.stashConflict) {
      window.alert(
        `Checked out ${newBranchName}, but your uncommitted changes did not apply cleanly and are still in the stash.\n\nRun \`git stash pop\` inside the worktree after resolving conflicts.`
      )
    }
  }, [])

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
      if (tab.type !== 'diff') markTerminalClosing(tab.id)
      window.api.killTerminal(tab.id)
    }
    // Clean up pane state
    setPanes((prev) => {
      const next = { ...prev }
      delete next[path]
      return next
    })
    setActivePaneId((prev) => {
      const next = { ...prev }
      delete next[path]
      return next
    })

    // Force remove if dirty (user already confirmed), normal remove otherwise
    const pr = prStatuses[path]
    await window.api.removeWorktree(path, dirty, pr ? { prNumber: pr.number, prState: pr.state } : undefined)

    const trees = await window.api.listWorktrees()
    setWorktrees(trees)
    if (path === activeWorktreeId) {
      setActiveWorktreeId(trees.length > 0 ? trees[0].path : null)
    }
  }, [terminalTabs, activeWorktreeId, prStatuses])

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
          if (tab.type !== 'diff') markTerminalClosing(tab.id)
          window.api.killTerminal(tab.id)
        }
        setPanes((prev) => {
          const next = { ...prev }
          delete next[path]
          return next
        })
        setActivePaneId((prev) => {
          const next = { ...prev }
          delete next[path]
          return next
        })
        try {
          const pr = prStatuses[path]
          await window.api.removeWorktree(path, force, pr ? { prNumber: pr.number, prState: pr.state } : undefined)
        } catch (err) {
          console.error('Failed to remove worktree', path, err)
        }
        onProgress?.(path, 'done')
      }
      const trees = await window.api.listWorktrees()
      setWorktrees(trees)
      if (activeWorktreeId && paths.includes(activeWorktreeId)) {
        setActiveWorktreeId(trees.length > 0 ? trees[0].path : null)
      }
    },
    [terminalTabs, activeWorktreeId, prStatuses]
  )

  // Append a tab to a specific pane (or the focused pane if paneId is omitted).
  // Creates an initial pane if the worktree has none.
  const appendTabToPane = useCallback(
    (worktreePath: string, tab: TerminalTab, paneId?: string) => {
      setPanes((prev) => {
        const list = prev[worktreePath] || []
        if (list.length === 0) {
          const pane: WorkspacePane = { id: newPaneId(), tabs: [tab], activeTabId: tab.id }
          return { ...prev, [worktreePath]: [pane] }
        }
        const targetId = paneId || activePaneId[worktreePath] || list[0].id
        const nextList = list.map((p) =>
          p.id === targetId
            ? { ...p, tabs: [...p.tabs, tab], activeTabId: tab.id }
            : p
        )
        return { ...prev, [worktreePath]: nextList }
      })
      setActivePaneId((prev) => {
        const list = panes[worktreePath] || []
        const target = paneId || prev[worktreePath] || list[0]?.id
        return target ? { ...prev, [worktreePath]: target } : prev
      })
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
      // Only kill PTY for terminal tabs, not diff tabs
      if (!tabId.startsWith('diff-')) {
        markTerminalClosing(tabId)
        window.api.killTerminal(tabId)
      }
      setPanes((prev) => {
        const list = prev[worktreePath] || []
        const nextList: WorkspacePane[] = []
        for (const pane of list) {
          if (!pane.tabs.some((t) => t.id === tabId)) {
            nextList.push(pane)
            continue
          }
          const remaining = pane.tabs.filter((t) => t.id !== tabId)
          if (remaining.length === 0) {
            // Drop empty panes — unless this is the worktree's only pane,
            // in which case keep it empty so a fresh Claude tab can spawn.
            if (list.length === 1) nextList.push({ ...pane, tabs: [], activeTabId: '' })
            continue
          }
          const newActive =
            pane.activeTabId === tabId ? remaining[0].id : pane.activeTabId
          nextList.push({ ...pane, tabs: remaining, activeTabId: newActive })
        }
        return { ...prev, [worktreePath]: nextList }
      })
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
      setPanes((prev) => {
        const list = prev[worktreePath] || []
        const nextList = list.map((pane) => {
          if (!pane.tabs.some((t) => t.id === tabId)) return pane
          const tabs = pane.tabs.map((t) =>
            t.id === tabId && t.type === 'claude'
              ? { ...t, id: newId, sessionId: newSessionId }
              : t
          )
          const activeTabId = pane.activeTabId === tabId ? newId : pane.activeTabId
          return { ...pane, tabs, activeTabId }
        })
        return { ...prev, [worktreePath]: nextList }
      })
    },
    []
  )

  const handleSelectTab = useCallback(
    (worktreePath: string, paneId: string, tabId: string) => {
      setPanes((prev) => {
        const list = prev[worktreePath] || []
        if (!list.some((p) => p.id === paneId)) return prev
        const nextList = list.map((p) =>
          p.id === paneId ? { ...p, activeTabId: tabId } : p
        )
        return { ...prev, [worktreePath]: nextList }
      })
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
      setPanes((prev) => {
        const list = prev[worktreePath] || []
        const nextList = list.map((pane) => {
          if (pane.id !== paneId) return pane
          const fromIdx = pane.tabs.findIndex((t) => t.id === fromId)
          const toIdx = pane.tabs.findIndex((t) => t.id === toId)
          if (fromIdx === -1 || toIdx === -1) return pane
          const tabs = pane.tabs.slice()
          const [moved] = tabs.splice(fromIdx, 1)
          tabs.splice(toIdx, 0, moved)
          return { ...pane, tabs }
        })
        return { ...prev, [worktreePath]: nextList }
      })
    },
    []
  )

  // Move a tab from one pane to another (or to a different index within the same pane).
  // If toIndex is undefined, appends at the end.
  const handleMoveTabToPane = useCallback(
    (worktreePath: string, tabId: string, toPaneId: string, toIndex?: number) => {
      setPanes((prev) => {
        const list = prev[worktreePath] || []
        let moved: TerminalTab | null = null
        // First pass: remove from source pane
        const stripped = list.map((pane) => {
          const idx = pane.tabs.findIndex((t) => t.id === tabId)
          if (idx === -1) return pane
          moved = pane.tabs[idx]
          const tabs = pane.tabs.slice()
          tabs.splice(idx, 1)
          const activeTabId =
            pane.activeTabId === tabId ? tabs[0]?.id || '' : pane.activeTabId
          return { ...pane, tabs, activeTabId }
        })
        if (!moved) return prev
        // Second pass: insert into target pane. Drop any now-empty source
        // panes unless it's the only pane in the worktree.
        const filtered =
          stripped.length > 1 ? stripped.filter((p) => p.tabs.length > 0 || p.id === toPaneId) : stripped
        const nextList = filtered.map((pane) => {
          if (pane.id !== toPaneId) return pane
          const tabs = pane.tabs.slice()
          const insertAt = toIndex ?? tabs.length
          tabs.splice(insertAt, 0, moved!)
          return { ...pane, tabs, activeTabId: moved!.id }
        })
        return { ...prev, [worktreePath]: nextList }
      })
      setActivePaneId((prev) => ({ ...prev, [worktreePath]: toPaneId }))
    },
    []
  )

  // Split: create a new pane to the right of `fromPaneId` containing a fresh Claude tab.
  const handleSplitPane = useCallback(
    (worktreePath: string, fromPaneId: string) => {
      const tabId = `${makeTerminalId('claude', worktreePath)}-${Date.now()}`
      const tab: TerminalTab = {
        id: tabId,
        type: 'claude',
        label: 'Claude',
        sessionId: crypto.randomUUID()
      }
      const newPane: WorkspacePane = { id: newPaneId(), tabs: [tab], activeTabId: tabId }
      setPanes((prev) => {
        const list = prev[worktreePath] || []
        const idx = list.findIndex((p) => p.id === fromPaneId)
        const insertAt = idx === -1 ? list.length : idx + 1
        const nextList = list.slice()
        nextList.splice(insertAt, 0, newPane)
        return { ...prev, [worktreePath]: nextList }
      })
      setActivePaneId((prev) => ({ ...prev, [worktreePath]: newPane.id }))
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
  // Use the same sort order as the sidebar for navigation
  const orderedWorktrees = useMemo(
    () => sortedWorktrees(worktrees, prStatuses, lastActive, mergedPaths),
    [worktrees, prStatuses, lastActive, mergedPaths]
  )

  const switchToWorktreeByIndex = useCallback(
    (index: number) => {
      if (index < orderedWorktrees.length) {
        setActiveWorktreeId(orderedWorktrees[index].path)
      }
    },
    [orderedWorktrees]
  )

  const cycleWorktree = useCallback(
    (delta: number) => {
      if (orderedWorktrees.length === 0) return
      const currentIdx = orderedWorktrees.findIndex((w) => w.path === activeWorktreeId)
      const nextIdx = (currentIdx + delta + orderedWorktrees.length) % orderedWorktrees.length
      setActiveWorktreeId(orderedWorktrees[nextIdx].path)
    },
    [orderedWorktrees, activeWorktreeId]
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
    ]
  )

  useHotkeys(hotkeyActions, hotkeyOverrides)

  const resolvedHotkeys = useMemo(() => resolveHotkeys(hotkeyOverrides), [hotkeyOverrides])

  // Compute aggregate status per worktree (worst status wins)
  const worktreeStatuses: Record<string, PtyStatus> = {}
  for (const wt of worktrees) {
    const tabs = terminalTabs[wt.path] || []
    let worstStatus: PtyStatus = 'idle'
    for (const tab of tabs) {
      const s = statuses[tab.id]
      if (s === 'needs-approval') {
        worstStatus = 'needs-approval'
        break
      }
      if (s === 'waiting' && worstStatus !== 'needs-approval') worstStatus = 'waiting'
      if (s === 'processing' && worstStatus === 'idle') worstStatus = 'processing'
    }
    worktreeStatuses[wt.path] = worstStatus
  }

  // Record activity-log transitions whenever a worktree's effective state changes.
  // Merged worktrees are terminal — once we've recorded 'merged' we stop
  // overwriting with pty state so the timeline keeps the purple tail.
  const lastRecordedActivity = useRef<Record<string, PtyStatus | 'merged'>>({})
  useEffect(() => {
    for (const [path, state] of Object.entries(worktreeStatuses)) {
      const isMerged =
        mergedPaths[path] ||
        prStatuses[path]?.state === 'merged' ||
        prStatuses[path]?.state === 'closed'
      const next: PtyStatus | 'merged' = isMerged ? 'merged' : state
      if (lastRecordedActivity.current[path] !== next) {
        lastRecordedActivity.current[path] = next
        window.api.recordActivity(path, next)
      }
    }
  }, [worktreeStatuses, prStatuses, mergedPaths])

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

  if (!repoRoot) {
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
            onClick={handleSelectRepo}
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
      {/* Hooks consent banner */}
      {hooksConsent === 'pending' && (
        <div className="bg-warning/15 border-b border-warning/30 pl-20 pr-4 py-2.5 drag-region flex items-center gap-3 shrink-0">
          <span className="text-warning text-sm flex-1">
            Claude Harness can install hooks in your worktrees to reliably detect Claude's status
            (waiting, processing, needs approval). This adds entries to each worktree's{' '}
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

      <div className="flex flex-1 min-h-0">
        {sidebarVisible && (
          <Sidebar
            worktrees={worktrees}
            activeWorktreeId={activeWorktreeId}
            statuses={worktreeStatuses}
            prStatuses={prStatuses}
            mergedPaths={mergedPaths}
            lastActive={lastActive}
            prLoading={prLoading}
            agentCount={agentWorktreeCount}
            onSelectWorktree={(path) => {
              setShowNewWorktree(false)
              setShowActivity(false)
              setShowCleanup(false)
              setShowCommandCenter(false)
              setActiveWorktreeId(path)
            }}
            onNewWorktree={() => setShowNewWorktree(true)}
            onContinueWorktree={handleContinueWorktree}
            onDeleteWorktree={handleDeleteWorktree}
            onRefresh={handleRefreshWorktrees}
            onSelectRepo={handleSelectRepo}
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
          />
        )}
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
                panes={paneList}
                focusedPaneId={activePaneId[wt.path] || paneList[0]?.id || ''}
                statuses={statuses}
                visible={isVisible}
                claudeCommand={claudeCommand}
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
        <QuestCard
          step={questStep}
          onDismiss={() => setQuestStep('done')}
          onFinish={() => setQuestStep('done')}
        />
        {/* Right panel — hidden on the new-worktree screen so the form gets the full width */}
        {!showNewWorktree && !showActivity && !showCleanup && !showCommandCenter && (
          <div className="w-64 shrink-0 h-full flex flex-col border-l border-border bg-panel">
            <PRStatusPanel
              pr={activeWorktreeId ? prStatuses[activeWorktreeId] : null}
              worktree={worktrees.find((w) => w.path === activeWorktreeId) || null}
              onMerged={refreshMergedStatus}
              onRemoveWorktree={handleDeleteWorktree}
              hasGithubToken={hasGithubToken}
              onConnectGithub={() => {
                setSettingsInitialSection('github')
                setShowSettings(true)
              }}
            />
            <BranchCommitsPanel worktreePath={activeWorktreeId} onOpenCommit={handleOpenCommit} />
            <div className="flex-1 min-h-0">
              <ChangedFilesPanel
                worktreePath={activeWorktreeId}
                onOpenDiff={handleOpenDiff}
                onSendToClaude={
                  activeWorktreeId
                    ? (text) => handleSendToClaude(activeWorktreeId, text)
                    : undefined
                }
              />
            </div>
          </div>
        )}
      </div>
    </div>
    {settingsOverlay}
    </HotkeysProvider>
  )
}

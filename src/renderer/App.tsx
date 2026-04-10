import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import type { Worktree, TerminalTab, PtyStatus, PRStatus } from './types'
import type { Action } from './hotkeys'
import { Sidebar } from './components/Sidebar'
import { TerminalPanel } from './components/TerminalPanel'
import { ChangedFilesPanel } from './components/ChangedFilesPanel'
import { PRStatusPanel } from './components/PRStatusPanel'
import { Settings } from './components/Settings'
import { focusTerminalById } from './components/XTerminal'
import { useHotkeys } from './hooks/useHotkeys'
import { sortedWorktrees } from './worktree-sort'

/** Create a filesystem-safe terminal ID from a worktree path */
function makeTerminalId(prefix: string, worktreePath: string): string {
  // Replace path separators with dashes, collapse multiple dashes
  const safe = worktreePath.replace(/[/\\]/g, '-').replace(/^-+/, '').replace(/-+/g, '-')
  return `${prefix}-${safe}`
}

export default function App(): JSX.Element {
  const [worktrees, setWorktrees] = useState<Worktree[]>([])
  const [activeWorktreeId, setActiveWorktreeId] = useState<string | null>(null)
  const [terminalTabs, setTerminalTabs] = useState<Record<string, TerminalTab[]>>({})
  const [activeTabId, setActiveTabId] = useState<Record<string, string>>({})
  const [statuses, setStatuses] = useState<Record<string, PtyStatus>>({})
  const [prStatuses, setPrStatuses] = useState<Record<string, PRStatus | null>>({})
  const [prLoading, setPrLoading] = useState(false)
  const [lastActive, setLastActive] = useState<Record<string, number>>({})
  const [repoRoot, setRepoRoot] = useState<string | null>(null)
  const [hooksConsent, setHooksConsent] = useState<'pending' | 'accepted' | 'declined'>('pending')
  const [sidebarVisible, setSidebarVisible] = useState(true)
  const [showSettings, setShowSettings] = useState(false)
  const [hasGithubToken, setHasGithubToken] = useState<boolean | null>(null)
  const [githubBannerDismissed, setGithubBannerDismissed] = useState(
    () => localStorage.getItem('githubBannerDismissed') === '1'
  )
  const [hotkeyOverrides, setHotkeyOverrides] = useState<Record<string, string> | undefined>(undefined)
  const [claudeCommand, setClaudeCommand] = useState<string>('')
  // Track which worktrees already have hooks installed so we only prompt once
  const hooksChecked = useRef(new Set<string>())
  // Ref to the sidebar's create-worktree trigger
  const createWorktreeRef = useRef<(() => void) | null>(null)

  // Check GitHub token presence (on mount and whenever Settings is closed)
  useEffect(() => {
    if (showSettings) return
    window.api.hasGithubToken().then(setHasGithubToken).catch(() => setHasGithubToken(null))
  }, [showSettings])

  const handleDismissGithubBanner = useCallback(() => {
    localStorage.setItem('githubBannerDismissed', '1')
    setGithubBannerDismissed(true)
  }, [])

  // Load repo root, worktrees, and config on mount
  useEffect(() => {
    (async () => {
      const [root, overrides, cmd] = await Promise.all([
        window.api.getRepoRoot(),
        window.api.getHotkeyOverrides(),
        window.api.getClaudeCommand()
      ])
      if (overrides) setHotkeyOverrides(overrides)
      setClaudeCommand(cmd)
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
  }, [worktrees])

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

    setTerminalTabs((prev) => {
      if (prev[activeWorktreeId] && prev[activeWorktreeId].length > 0) return prev
      const claudeTabId = makeTerminalId('claude', activeWorktreeId)
      const tabs: TerminalTab[] = [{ id: claudeTabId, type: 'claude', label: 'Claude' }]
      return { ...prev, [activeWorktreeId]: tabs }
    })

    setActiveTabId((prev) => {
      if (prev[activeWorktreeId]) return prev
      return { ...prev, [activeWorktreeId]: makeTerminalId('claude', activeWorktreeId) }
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


  const handleCreateWorktree = useCallback(async (branchName: string) => {
    await window.api.addWorktree(branchName)
    const trees = await window.api.listWorktrees()
    setWorktrees(trees)
    // Select the new worktree
    const created = trees.find((t) => t.branch === branchName)
    if (created) {
      setActiveWorktreeId(created.path)
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

    // Kill any terminals running in this worktree
    const tabs = terminalTabs[path] || []
    for (const tab of tabs) {
      window.api.killTerminal(tab.id)
    }
    // Clean up terminal state
    setTerminalTabs((prev) => {
      const next = { ...prev }
      delete next[path]
      return next
    })
    setActiveTabId((prev) => {
      const next = { ...prev }
      delete next[path]
      return next
    })

    // Force remove if dirty (user already confirmed), normal remove otherwise
    await window.api.removeWorktree(path, dirty)

    const trees = await window.api.listWorktrees()
    setWorktrees(trees)
    if (path === activeWorktreeId) {
      setActiveWorktreeId(trees.length > 0 ? trees[0].path : null)
    }
  }, [terminalTabs, activeWorktreeId])

  const handleAddTerminalTab = useCallback(
    (worktreePath: string) => {
      const id = `shell-${Date.now()}`
      const tab: TerminalTab = { id, type: 'shell', label: 'Shell' }
      setTerminalTabs((prev) => ({
        ...prev,
        [worktreePath]: [...(prev[worktreePath] || []), tab]
      }))
      setActiveTabId((prev) => ({ ...prev, [worktreePath]: id }))
    },
    []
  )

  const handleCloseTab = useCallback(
    (worktreePath: string, tabId: string) => {
      // Only kill PTY for terminal tabs, not diff tabs
      if (!tabId.startsWith('diff-')) {
        window.api.killTerminal(tabId)
      }
      setTerminalTabs((prev) => {
        const tabs = (prev[worktreePath] || []).filter((t) => t.id !== tabId)
        return { ...prev, [worktreePath]: tabs }
      })
      setActiveTabId((prev) => {
        if (prev[worktreePath] === tabId) {
          const remaining = (terminalTabs[worktreePath] || []).filter((t) => t.id !== tabId)
          return { ...prev, [worktreePath]: remaining[0]?.id || '' }
        }
        return prev
      })
    },
    [terminalTabs]
  )

  const handleSelectTab = useCallback((worktreePath: string, tabId: string) => {
    setActiveTabId((prev) => ({ ...prev, [worktreePath]: tabId }))
  }, [])

  const handleOpenDiff = useCallback(
    (filePath: string, staged: boolean) => {
      if (!activeWorktreeId) return
      const tabId = `diff-${staged ? 'staged' : 'unstaged'}-${filePath}`
      // If tab already exists, just switch to it
      const existing = (terminalTabs[activeWorktreeId] || []).find((t) => t.id === tabId)
      if (existing) {
        setActiveTabId((prev) => ({ ...prev, [activeWorktreeId!]: tabId }))
        return
      }
      // Extract just the filename for the tab label
      const fileName = filePath.split('/').pop() || filePath
      const tab: TerminalTab = { id: tabId, type: 'diff', label: fileName, filePath, staged }
      setTerminalTabs((prev) => ({
        ...prev,
        [activeWorktreeId!]: [...(prev[activeWorktreeId!] || []), tab]
      }))
      setActiveTabId((prev) => ({ ...prev, [activeWorktreeId!]: tabId }))
    },
    [activeWorktreeId, terminalTabs]
  )

  // --- Hotkey action handlers ---
  // Use the same sort order as the sidebar for navigation
  const orderedWorktrees = useMemo(
    () => sortedWorktrees(worktrees, prStatuses, lastActive),
    [worktrees, prStatuses, lastActive]
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
    [worktrees, activeWorktreeId]
  )

  const cycleTab = useCallback(
    (delta: number) => {
      if (!activeWorktreeId) return
      const tabs = terminalTabs[activeWorktreeId] || []
      if (tabs.length === 0) return
      const currentTabId = activeTabId[activeWorktreeId]
      const currentIdx = tabs.findIndex((t) => t.id === currentTabId)
      const nextIdx = (currentIdx + delta + tabs.length) % tabs.length
      setActiveTabId((prev) => ({ ...prev, [activeWorktreeId]: tabs[nextIdx].id }))
    },
    [activeWorktreeId, terminalTabs, activeTabId]
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
      newWorktree: () => createWorktreeRef.current?.(),
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

  if (showSettings) {
    return <Settings onClose={() => setShowSettings(false)} />
  }

  if (!repoRoot) {
    return (
      <div className="flex h-full flex-col">
        <div className="drag-region h-10 shrink-0" />
        <div className="flex flex-1 items-center justify-center">
        <div className="text-center">
          <h1 className="text-2xl font-semibold text-neutral-200 mb-4">Harness</h1>
          <p className="text-neutral-500 mb-6">Select a git repository to get started</p>
          <button
            onClick={handleSelectRepo}
            className="px-6 py-3 bg-neutral-800 hover:bg-neutral-700 rounded-lg text-neutral-200 transition-colors cursor-pointer"
          >
            Open Repository
          </button>
        </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      {/* Hooks consent banner */}
      {hooksConsent === 'pending' && (
        <div className="bg-amber-950 border-b border-amber-800 pl-20 pr-4 py-2.5 drag-region flex items-center gap-3 shrink-0">
          <span className="text-amber-200 text-sm flex-1">
            Claude Harness can install hooks in your worktrees to reliably detect Claude's status
            (waiting, processing, needs approval). This adds entries to each worktree's{' '}
            <code className="bg-amber-900 px-1 rounded text-xs">.claude/settings.local.json</code>.
          </span>
          <button
            onClick={handleAcceptHooks}
            className="px-3 py-1 bg-amber-700 hover:bg-amber-600 rounded text-sm text-amber-100 transition-colors shrink-0 cursor-pointer no-drag"
          >
            Enable
          </button>
          <button
            onClick={handleDeclineHooks}
            className="px-3 py-1 text-amber-400 hover:text-amber-200 text-sm transition-colors shrink-0 cursor-pointer no-drag"
          >
            Skip
          </button>
        </div>
      )}

      {/* GitHub setup banner */}
      {hasGithubToken === false && !githubBannerDismissed && (
        <div className="bg-blue-950 border-b border-blue-800 pl-20 pr-4 py-2.5 drag-region flex items-center gap-3 shrink-0">
          <span className="text-blue-200 text-sm flex-1">
            Connect a GitHub token to see PR status and open pull requests from Harness.
          </span>
          <button
            onClick={() => setShowSettings(true)}
            className="px-3 py-1 bg-blue-700 hover:bg-blue-600 rounded text-sm text-blue-100 transition-colors shrink-0 cursor-pointer no-drag"
          >
            Set up GitHub
          </button>
          <button
            onClick={handleDismissGithubBanner}
            className="px-3 py-1 text-blue-400 hover:text-blue-200 text-sm transition-colors shrink-0 cursor-pointer no-drag"
          >
            Dismiss
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
            lastActive={lastActive}
            prLoading={prLoading}
            onSelectWorktree={setActiveWorktreeId}
            onCreateWorktree={handleCreateWorktree}
            onDeleteWorktree={handleDeleteWorktree}
            onRefresh={handleRefreshWorktrees}
            onSelectRepo={handleSelectRepo}
            onOpenSettings={() => setShowSettings(true)}
            onRegisterCreate={(trigger) => { createWorktreeRef.current = trigger }}
          />
        )}
        {/* Render ALL worktrees' terminals to keep PTYs alive across switches */}
        {worktrees.map((wt) => {
          const tabs = terminalTabs[wt.path]
          if (!tabs || tabs.length === 0) return null
          return (
            <div
              key={wt.path}
              className="flex-1 min-w-0"
              style={{ display: wt.path === activeWorktreeId ? 'flex' : 'none' }}
            >
              <TerminalPanel
                worktreePath={wt.path}
                tabs={tabs}
                activeTabId={activeTabId[wt.path] || ''}
                statuses={statuses}
                onSelectTab={handleSelectTab}
                onAddTab={handleAddTerminalTab}
                onCloseTab={handleCloseTab}
                visible={wt.path === activeWorktreeId}
                claudeCommand={claudeCommand}
              />
            </div>
          )
        })}
        {!activeWorktreeId && worktrees.length > 0 && (
          <div className="flex-1 flex items-center justify-center text-neutral-500">
            Select a worktree to begin
          </div>
        )}
        {/* Right panel */}
        <div className="w-64 shrink-0 h-full flex flex-col border-l border-neutral-800 bg-neutral-950">
          <PRStatusPanel pr={activeWorktreeId ? prStatuses[activeWorktreeId] : null} />
          <div className="flex-1 min-h-0">
            <ChangedFilesPanel worktreePath={activeWorktreeId} onOpenDiff={handleOpenDiff} />
          </div>
        </div>
      </div>
    </div>
  )
}

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import type { Worktree, TerminalTab, PtyStatus } from './types'
import type { Action } from './hotkeys'
import { Sidebar } from './components/Sidebar'
import { TerminalPanel } from './components/TerminalPanel'
import { focusTerminalById } from './components/XTerminal'
import { useHotkeys } from './hooks/useHotkeys'

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
  const [repoRoot, setRepoRoot] = useState<string | null>(null)
  const [hooksConsent, setHooksConsent] = useState<'pending' | 'accepted' | 'declined'>('pending')
  const [sidebarVisible, setSidebarVisible] = useState(true)
  const [hotkeyOverrides, setHotkeyOverrides] = useState<Record<string, string> | undefined>(undefined)
  // Track which worktrees already have hooks installed so we only prompt once
  const hooksChecked = useRef(new Set<string>())
  // Ref to the sidebar's create-worktree trigger
  const createWorktreeRef = useRef<(() => void) | null>(null)

  // Load repo root, worktrees, and hotkey config on mount
  useEffect(() => {
    (async () => {
      const [root, overrides] = await Promise.all([
        window.api.getRepoRoot(),
        window.api.getHotkeyOverrides()
      ])
      if (overrides) setHotkeyOverrides(overrides)
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

  // Listen for status changes from main process
  useEffect(() => {
    const cleanup = window.api.onStatusChange((id, status) => {
      console.log(`[status] received: id=${id} status=${status}`)
      setStatuses((prev) => ({ ...prev, [id]: status as PtyStatus }))
    })
    return cleanup
  }, [])

  // When a worktree becomes active, check hooks and set up tabs
  useEffect(() => {
    if (!activeWorktreeId) return

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

    try {
      await window.api.removeWorktree(path)
    } catch {
      // If normal remove fails, try force
      await window.api.removeWorktree(path, true)
    }

    const trees = await window.api.listWorktrees()
    setWorktrees(trees)
    // If we deleted the active worktree, switch to first available
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
      window.api.killTerminal(tabId)
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

  // --- Hotkey action handlers ---
  const switchToWorktreeByIndex = useCallback(
    (index: number) => {
      if (index < worktrees.length) {
        setActiveWorktreeId(worktrees[index].path)
      }
    },
    [worktrees]
  )

  const cycleWorktree = useCallback(
    (delta: number) => {
      if (worktrees.length === 0) return
      const currentIdx = worktrees.findIndex((w) => w.path === activeWorktreeId)
      const nextIdx = (currentIdx + delta + worktrees.length) % worktrees.length
      setActiveWorktreeId(worktrees[nextIdx].path)
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

  if (!repoRoot) {
    return (
      <div className="flex h-full flex-col">
        <div className="drag-region h-10 shrink-0" />
        <div className="flex flex-1 items-center justify-center">
        <div className="text-center">
          <h1 className="text-2xl font-semibold text-neutral-200 mb-4">Claude Harness</h1>
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
        <div className="bg-amber-950 border-b border-amber-800 px-4 py-2.5 flex items-center gap-3 shrink-0">
          <span className="text-amber-200 text-sm flex-1">
            Claude Harness can install hooks in your worktrees to reliably detect Claude's status
            (waiting, processing, needs approval). This adds entries to each worktree's{' '}
            <code className="bg-amber-900 px-1 rounded text-xs">.claude/settings.local.json</code>.
          </span>
          <button
            onClick={handleAcceptHooks}
            className="px-3 py-1 bg-amber-700 hover:bg-amber-600 rounded text-sm text-amber-100 transition-colors shrink-0 cursor-pointer"
          >
            Enable
          </button>
          <button
            onClick={handleDeclineHooks}
            className="px-3 py-1 text-amber-400 hover:text-amber-200 text-sm transition-colors shrink-0 cursor-pointer"
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
            onSelectWorktree={setActiveWorktreeId}
            onCreateWorktree={handleCreateWorktree}
            onDeleteWorktree={handleDeleteWorktree}
            onRefresh={handleRefreshWorktrees}
            onSelectRepo={handleSelectRepo}
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
              />
            </div>
          )
        })}
        {!activeWorktreeId && worktrees.length > 0 && (
          <div className="flex-1 flex items-center justify-center text-neutral-500">
            Select a worktree to begin
          </div>
        )}
      </div>
    </div>
  )
}

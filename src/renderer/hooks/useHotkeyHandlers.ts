import { useCallback, useMemo } from 'react'
import type { Worktree, PRStatus, WorkspacePane, TerminalTab } from '../types'
import { resolveHotkeys, type Action, type HotkeyBinding } from '../hotkeys'
import { useHotkeys } from './useHotkeys'
import { groupWorktrees, getGroupKey, type GroupKey } from '../worktree-sort'
import { focusTerminalById } from '../components/XTerminal'

interface UseHotkeyHandlersArgs {
  worktrees: Worktree[]
  repoRoots: string[]
  unifiedRepos: boolean
  prStatuses: Record<string, PRStatus | null>
  mergedPaths: Record<string, boolean>
  collapsedRepos: Record<string, boolean>
  setCollapsedRepos: React.Dispatch<React.SetStateAction<Record<string, boolean>>>
  setCollapsedGroups: React.Dispatch<React.SetStateAction<Record<string, boolean>>>
  isGroupCollapsed: (scope: string, key: GroupKey) => boolean
  activeWorktreeId: string | null
  setActiveWorktreeId: React.Dispatch<React.SetStateAction<string | null>>
  panes: Record<string, WorkspacePane[]>
  activePaneId: Record<string, string>
  terminalTabs: Record<string, TerminalTab[]>
  activeTabId: Record<string, string>
  hotkeyOverrides: Record<string, string> | undefined
  setSidebarVisible: React.Dispatch<React.SetStateAction<boolean>>
  setRightColumnHidden: React.Dispatch<React.SetStateAction<boolean>>
  setShowNewWorktree: React.Dispatch<React.SetStateAction<boolean>>
  setShowCommandCenter: React.Dispatch<React.SetStateAction<boolean>>
  setShowCommandPalette: React.Dispatch<React.SetStateAction<boolean>>
  setCommandPaletteMode: React.Dispatch<React.SetStateAction<'root' | 'files'>>
  setShowPerfMonitor: React.Dispatch<React.SetStateAction<boolean>>
  setShowHotkeyCheatsheet: React.Dispatch<React.SetStateAction<boolean>>
  // Imperative hooks into other handlers — passed in to avoid this hook
  // depending on useTabHandlers + useWorktreeHandlers directly.
  handleAddTerminalTab: (worktreePath: string, paneId?: string) => void
  handleCloseTab: (worktreePath: string, tabId: string) => void
  handleSelectTab: (worktreePath: string, paneId: string, tabId: string) => void
  handleSplitPane: (worktreePath: string, fromPaneId: string) => void
  handleRefreshWorktrees: () => void
}

/** Sidebar-aware hotkey handler block. Computes the visible/ordered
 * worktree lists, the cycle helpers, and the action map; subscribes to
 * keystrokes via useHotkeys; returns the action map (for tooltip
 * dispatch) and the resolved binding map (for the HotkeysProvider). */
export function useHotkeyHandlers(args: UseHotkeyHandlersArgs): {
  hotkeyActions: Partial<Record<Action, () => void>>
  resolvedHotkeys: Record<Action, HotkeyBinding>
} {
  const {
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
    handleAddTerminalTab,
    handleCloseTab,
    handleSelectTab,
    handleSplitPane,
    handleRefreshWorktrees
  } = args

  // Mirror the sidebar's grouping/rendering order so hotkey navigation
  // matches what's on screen.
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
    [scopeForWorktree, prStatuses, mergedPaths, isGroupCollapsed, collapsedRepos, setCollapsedGroups, setCollapsedRepos]
  )

  const switchToWorktreeByIndex = useCallback(
    (index: number) => {
      if (index < visibleWorktrees.length) {
        setActiveWorktreeId(visibleWorktrees[index].path)
      }
    },
    [visibleWorktrees, setActiveWorktreeId]
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
    [allOrderedWorktrees, activeWorktreeId, ensureWorktreeVisible, setActiveWorktreeId]
  )

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
      toggleRightColumn: () => setRightColumnHidden((v) => !v),
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
      commandPalette: () => {
        setCommandPaletteMode('root')
        setShowCommandPalette((v) => !v)
      },
      fileQuickOpen: () => {
        setCommandPaletteMode('files')
        setShowCommandPalette(true)
      },
      splitPaneRight: () => {
        if (!activeWorktreeId) return
        const list = panes[activeWorktreeId] || []
        if (list.length === 0) return
        const fromPaneId = activePaneId[activeWorktreeId] || list[list.length - 1].id
        handleSplitPane(activeWorktreeId, fromPaneId)
      },
      togglePerfMonitor: () => setShowPerfMonitor((v) => !v),
      hotkeyCheatsheet: () => setShowHotkeyCheatsheet((v) => !v)
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
      setSidebarVisible,
      setRightColumnHidden,
      setShowNewWorktree,
      setShowCommandCenter,
      setShowCommandPalette,
      setCommandPaletteMode,
      setShowPerfMonitor,
      setShowHotkeyCheatsheet
    ]
  )

  useHotkeys(hotkeyActions, hotkeyOverrides)

  const resolvedHotkeys = useMemo(() => resolveHotkeys(hotkeyOverrides), [hotkeyOverrides])

  return { hotkeyActions, resolvedHotkeys }
}

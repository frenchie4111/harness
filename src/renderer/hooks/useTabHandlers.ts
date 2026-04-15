import { useCallback } from 'react'
import type { TerminalTab, WorkspacePane } from '../types'
import { focusTerminalById, markTerminalClosing } from '../components/XTerminal'

/** Create a filesystem-safe terminal ID from a worktree path. */
function makeTerminalId(prefix: string, worktreePath: string): string {
  const safe = worktreePath.replace(/[/\\]/g, '-').replace(/^-+/, '').replace(/-+/g, '-')
  return `${prefix}-${safe}`
}

interface UseTabHandlersArgs {
  panes: Record<string, WorkspacePane[]>
  activePaneId: Record<string, string>
  setActivePaneId: React.Dispatch<React.SetStateAction<Record<string, string>>>
  activeWorktreeId: string | null
  setActiveWorktreeId: React.Dispatch<React.SetStateAction<string | null>>
}

/** Pane / tab orchestration handlers. Every operation dispatches an IPC
 * method to main (which owns the pane state) and updates the per-client
 * activePaneId focus map locally. */
export function useTabHandlers({
  panes,
  activePaneId,
  setActivePaneId,
  activeWorktreeId,
  setActiveWorktreeId
}: UseTabHandlersArgs) {
  const appendTabToPane = useCallback(
    (worktreePath: string, tab: TerminalTab, paneId?: string) => {
      const list = panes[worktreePath] || []
      const targetId = paneId || activePaneId[worktreePath] || list[0]?.id
      void window.api.panesAddTab(worktreePath, tab, targetId)
      if (targetId) {
        setActivePaneId((prev) => ({ ...prev, [worktreePath]: targetId }))
      }
    },
    [activePaneId, panes, setActivePaneId]
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

  const handleAddJsonClaudeTab = useCallback(
    (worktreePath: string, paneId?: string) => {
      const id = `json-claude-${Date.now()}`
      appendTabToPane(
        worktreePath,
        { id, type: 'json-claude', label: 'Claude (JSON)' },
        paneId
      )
    },
    [appendTabToPane]
  )

  const handleCloseTab = useCallback(
    (worktreePath: string, tabId: string) => {
      // Only kill PTY for terminal tabs, not diff/file viewer tabs
      if (tabId.startsWith('json-claude-')) {
        window.api.killJsonClaude(tabId)
      } else if (!tabId.startsWith('diff-') && !tabId.startsWith('file-')) {
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
      // Mint a new tab id so React remounts XTerminal and respawns the pty,
      // but keep the existing sessionId so the new Claude resumes the same
      // conversation via `--resume`.
      const newId = `${makeTerminalId('claude', worktreePath)}-${Date.now()}`
      void window.api.panesRestartClaudeTab(worktreePath, tabId, newId)
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
    [setActivePaneId]
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

  const handleMoveTabToPane = useCallback(
    (worktreePath: string, tabId: string, toPaneId: string, toIndex?: number) => {
      void window.api.panesMoveTabToPane(worktreePath, tabId, toPaneId, toIndex)
      setActivePaneId((prev) => ({ ...prev, [worktreePath]: toPaneId }))
    },
    [setActivePaneId]
  )

  const handleSplitPane = useCallback(
    async (worktreePath: string, fromPaneId: string) => {
      const newPane = await window.api.panesSplitPane(worktreePath, fromPaneId)
      if (newPane) {
        setActivePaneId((prev) => ({ ...prev, [worktreePath]: newPane.id }))
      }
    },
    [setActivePaneId]
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
    [panes, handleSelectTab, setActiveWorktreeId]
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

  return {
    appendTabToPane,
    handleAddTerminalTab,
    handleAddClaudeTab,
    handleAddJsonClaudeTab,
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
  }
}

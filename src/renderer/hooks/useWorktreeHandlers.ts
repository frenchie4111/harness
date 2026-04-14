import { useCallback, useEffect } from 'react'
import type { Worktree, PendingWorktree, PRStatus, TerminalTab } from '../types'
import { markTerminalClosing } from '../components/XTerminal'

interface UseWorktreeHandlersArgs {
  worktrees: Worktree[]
  pendingWorktrees: PendingWorktree[]
  repoRoots: string[]
  worktreeRepoByPath: Record<string, string>
  terminalTabs: Record<string, TerminalTab[]>
  prStatuses: Record<string, PRStatus | null>
  activeWorktreeId: string | null
  setActiveWorktreeId: React.Dispatch<React.SetStateAction<string | null>>
  setActivePaneId: React.Dispatch<React.SetStateAction<Record<string, string>>>
  setShowNewWorktree: React.Dispatch<React.SetStateAction<boolean>>
}

/** Worktree + repo + pending-creation handlers. Repo add/remove,
 * worktree creation FSM dispatch (runPending/retry/dismiss/continue),
 * single-path delete + bulk delete. Also subscribes to external-create
 * events from the harness-control MCP and routes focus to the new path. */
export function useWorktreeHandlers(args: UseWorktreeHandlersArgs) {
  const {
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
  } = args

  const handleAddRepo = useCallback(async () => {
    const root = await window.api.addRepo()
    // Main dispatches worktrees/reposChanged + listChanged; we just route
    // focus to the new repo's main worktree once it lands in the store.
    if (root) {
      const added =
        worktrees.find((w) => w.repoRoot === root && w.isMain) ||
        worktrees.find((w) => w.repoRoot === root)
      if (added) setActiveWorktreeId(added.path)
    }
  }, [worktrees, setActiveWorktreeId])

  // External worktree creation (from the harness-control MCP). Main
  // refreshes the store list AND seeds default panes (with the prompt
  // embedded) before emitting this event, so we just focus the new path.
  useEffect(() => {
    const off = window.api.onWorktreesExternalCreate(({ repoRoot, worktree }) => {
      if (!repoRoots.includes(repoRoot)) return
      setActiveWorktreeId(worktree.path)
    })
    return off
  }, [repoRoots, setActiveWorktreeId])

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
    [activeWorktreeId, worktrees, setActiveWorktreeId]
  )

  const handleRefreshWorktrees = useCallback(async () => {
    await window.api.refreshWorktreesList()
  }, [])

  const handleSubmitNewWorktree = useCallback(
    async (
      repoRoot: string,
      branchName: string,
      initialPrompt: string,
      teleportSessionId?: string
    ) => {
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
    [setActiveWorktreeId, setShowNewWorktree]
  )

  const handleRetryPendingWorktree = useCallback((id: string) => {
    void window.api.retryPendingWorktree(id)
  }, [])

  const handleDismissPendingWorktree = useCallback(
    (id: string) => {
      void window.api.dismissPendingWorktree(id)
      setActiveWorktreeId((prev) => (prev === id ? null : prev))
    },
    [setActiveWorktreeId]
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
    },
    [pendingWorktrees, setActiveWorktreeId]
  )

  const handleContinueWorktree = useCallback(
    async (path: string, newBranchName: string) => {
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
    },
    [worktreeRepoByPath]
  )

  const handleDeleteWorktree = useCallback(
    async (path: string) => {
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
      await window.api.removeWorktree(
        repoRoot,
        path,
        dirty,
        pr ? { prNumber: pr.number, prState: pr.state } : undefined
      )
      // Main's worktree:remove handler calls worktreesFSM.refreshList(),
      // which will dispatch listChanged. Switch focus if necessary.
      if (path === activeWorktreeId) {
        const next = worktrees.find((w) => w.path !== path)
        setActiveWorktreeId(next?.path ?? null)
      }
    },
    [
      terminalTabs,
      activeWorktreeId,
      prStatuses,
      worktreeRepoByPath,
      worktrees,
      setActiveWorktreeId,
      setActivePaneId
    ]
  )

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
            await window.api.removeWorktree(
              repoRoot,
              path,
              force,
              pr ? { prNumber: pr.number, prState: pr.state } : undefined
            )
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
    [
      terminalTabs,
      activeWorktreeId,
      prStatuses,
      worktreeRepoByPath,
      worktrees,
      setActiveWorktreeId,
      setActivePaneId
    ]
  )

  return {
    handleAddRepo,
    handleRemoveRepo,
    handleRefreshWorktrees,
    handleSubmitNewWorktree,
    handleRetryPendingWorktree,
    handleDismissPendingWorktree,
    handleContinuePendingWorktree,
    handleContinueWorktree,
    handleDeleteWorktree,
    handleBulkDeleteWorktrees
  }
}

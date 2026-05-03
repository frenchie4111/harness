import { useCallback, useEffect, useState } from 'react'
import type { Worktree, PendingWorktree, PRStatus, TerminalTab } from '../types'
import { markTerminalClosing } from '../components/XTerminal'

declare global {
  interface Window {
    __HARNESS_WEB__?: boolean
  }
}

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

  const [repoPickerOpen, setRepoPickerOpen] = useState(false)

  const focusNewRepo = useCallback(
    (root: string) => {
      const added =
        worktrees.find((w) => w.repoRoot === root && w.isMain) ||
        worktrees.find((w) => w.repoRoot === root)
      if (added) setActiveWorktreeId(added.path)
    },
    [worktrees, setActiveWorktreeId]
  )

  const handleAddRepo = useCallback(async () => {
    // Web/headless mode: native dialog runs on the user's laptop, but the
    // repos live on the remote box. Open the in-app RemoteFilePicker
    // instead and let it call repo:addAtPath when the user selects.
    if (window.__HARNESS_WEB__) {
      setRepoPickerOpen(true)
      return
    }
    const root = await window.api.addRepo()
    // Main dispatches worktrees/reposChanged + listChanged; we just route
    // focus to the new repo's main worktree once it lands in the store.
    if (root) focusNewRepo(root)
  }, [focusNewRepo])

  const handleRepoPickerSelect = useCallback(
    async (path: string) => {
      const root = await window.api.addRepoAtPath(path)
      setRepoPickerOpen(false)
      if (root) focusNewRepo(root)
    },
    [focusNewRepo]
  )

  const handleRepoPickerCancel = useCallback(() => {
    setRepoPickerOpen(false)
  }, [])

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

      // Fire-and-forget: the main-side WorktreeDeletionFSM streams phase +
      // teardown output through the store. We route focus off the deleted
      // path immediately so the neighbor is selectable while deletion runs
      // in the background.
      const pr = prStatuses[path]
      const repoRoot = worktreeRepoByPath[path]
      if (!repoRoot) return
      void window.api.removeWorktree(
        repoRoot,
        path,
        dirty,
        pr ? { prNumber: pr.number, prState: pr.state } : undefined
      )
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

  // Bulk delete used by the Cleanup screen. Fires all deletions in parallel
  // — each one becomes its own pending-deletion entry and the main-side FSM
  // handles the lifecycle independently. The `done` progress callback fires
  // immediately after queueing; the user sees the actual teardown progress
  // via the per-worktree DeletingWorktreeScreen cards.
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
        const pr = prStatuses[path]
        const repoRoot = worktreeRepoByPath[path]
        if (repoRoot) {
          void window.api.removeWorktree(
            repoRoot,
            path,
            force,
            pr ? { prNumber: pr.number, prState: pr.state } : undefined
          )
        }
        onProgress?.(path, 'done')
      }
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

  const handleDismissPendingDeletion = useCallback(
    (path: string) => {
      void window.api.dismissPendingDeletion(path)
      setActiveWorktreeId((prev) => {
        if (prev !== path) return prev
        const next = worktrees.find((w) => w.path !== path)
        return next?.path ?? null
      })
    },
    [worktrees, setActiveWorktreeId]
  )

  return {
    handleDismissPendingDeletion,
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
    repoPickerOpen,
    handleRepoPickerSelect,
    handleRepoPickerCancel
  }
}

import { useState, useCallback, useEffect } from 'react'
import type { Worktree, PtyStatus } from '../types'
import { WorktreeTab } from './WorktreeTab'

interface SidebarProps {
  worktrees: Worktree[]
  activeWorktreeId: string | null
  statuses: Record<string, PtyStatus>
  onSelectWorktree: (path: string) => void
  onCreateWorktree: (branchName: string) => Promise<void>
  onDeleteWorktree: (path: string) => Promise<void>
  onRefresh: () => void
  onSelectRepo: () => void
  onRegisterCreate?: (trigger: () => void) => void
}

export function Sidebar({
  worktrees,
  activeWorktreeId,
  statuses,
  onSelectWorktree,
  onCreateWorktree,
  onDeleteWorktree,
  onRefresh,
  onSelectRepo,
  onRegisterCreate
}: SidebarProps): JSX.Element {
  const [showCreate, setShowCreate] = useState(false)
  const [branchName, setBranchName] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleCreate = useCallback(async () => {
    const name = branchName.trim()
    if (!name) return
    setCreating(true)
    setError(null)
    try {
      await onCreateWorktree(name)
      setBranchName('')
      setShowCreate(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create worktree')
    } finally {
      setCreating(false)
    }
  }, [branchName, onCreateWorktree])

  // Register the create trigger for external callers (hotkeys)
  useEffect(() => {
    onRegisterCreate?.(() => setShowCreate(true))
  }, [onRegisterCreate])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') handleCreate()
      if (e.key === 'Escape') {
        setShowCreate(false)
        setBranchName('')
        setError(null)
      }
    },
    [handleCreate]
  )

  return (
    <div className="w-56 bg-neutral-950 border-r border-neutral-800 flex flex-col h-full">
      {/* Title bar drag region */}
      <div className="drag-region h-10 flex items-center px-4 pt-1 shrink-0">
        <span className="text-xs font-medium text-neutral-500 pl-16">WORKTREES</span>
      </div>

      {/* Worktree list */}
      <div className="flex-1 overflow-y-auto py-1">
        {worktrees.map((wt) => (
          <WorktreeTab
            key={wt.path}
            worktree={wt}
            isActive={wt.path === activeWorktreeId}
            status={statuses[wt.path] || 'idle'}
            onClick={() => onSelectWorktree(wt.path)}
            onDelete={wt.isMain ? undefined : () => onDeleteWorktree(wt.path)}
          />
        ))}
        {worktrees.length === 0 && (
          <div className="px-4 py-3 text-xs text-neutral-600">
            No worktrees found
          </div>
        )}
      </div>

      {/* Create worktree form */}
      {showCreate && (
        <div className="border-t border-neutral-800 p-2">
          <input
            type="text"
            value={branchName}
            onChange={(e) => setBranchName(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="branch-name"
            autoFocus
            disabled={creating}
            className="w-full bg-neutral-900 border border-neutral-700 rounded px-2 py-1.5 text-xs text-neutral-200 placeholder-neutral-600 outline-none focus:border-neutral-500"
          />
          {error && (
            <div className="text-xs text-red-400 mt-1 px-1 truncate" title={error}>
              {error}
            </div>
          )}
          <div className="flex gap-1 mt-1.5">
            <button
              onClick={handleCreate}
              disabled={creating || !branchName.trim()}
              className="flex-1 text-xs bg-neutral-800 hover:bg-neutral-700 disabled:opacity-40 rounded px-2 py-1 text-neutral-200 transition-colors cursor-pointer"
            >
              {creating ? 'Creating...' : 'Create'}
            </button>
            <button
              onClick={() => {
                setShowCreate(false)
                setBranchName('')
                setError(null)
              }}
              className="text-xs text-neutral-500 hover:text-neutral-300 px-2 py-1 transition-colors cursor-pointer"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Bottom actions */}
      <div className="border-t border-neutral-800 p-2 flex gap-1 shrink-0">
        <button
          onClick={() => setShowCreate(!showCreate)}
          className="flex-1 text-xs text-neutral-500 hover:text-neutral-300 hover:bg-neutral-800 rounded px-2 py-1.5 transition-colors cursor-pointer"
          title="New worktree"
        >
          + New
        </button>
        <button
          onClick={onRefresh}
          className="flex-1 text-xs text-neutral-500 hover:text-neutral-300 hover:bg-neutral-800 rounded px-2 py-1.5 transition-colors cursor-pointer"
          title="Refresh worktrees"
        >
          Refresh
        </button>
        <button
          onClick={onSelectRepo}
          className="flex-1 text-xs text-neutral-500 hover:text-neutral-300 hover:bg-neutral-800 rounded px-2 py-1.5 transition-colors cursor-pointer"
          title="Change repository"
        >
          Repo
        </button>
      </div>
    </div>
  )
}

import { useState, useCallback, useEffect, useMemo } from 'react'
import { ChevronDown, ChevronRight, Plus, RefreshCw, FolderOpen, Loader2, Settings as SettingsIcon } from 'lucide-react'
import type { Worktree, PtyStatus, PRStatus } from '../types'
import type { GroupKey } from '../worktree-sort'
import { groupWorktrees } from '../worktree-sort'
import { WorktreeTab } from './WorktreeTab'

interface SidebarProps {
  worktrees: Worktree[]
  activeWorktreeId: string | null
  statuses: Record<string, PtyStatus>
  prStatuses: Record<string, PRStatus | null>
  lastActive: Record<string, number>
  prLoading: boolean
  onSelectWorktree: (path: string) => void
  onCreateWorktree: (branchName: string) => Promise<void>
  onDeleteWorktree: (path: string) => Promise<void>
  onRefresh: () => void
  onSelectRepo: () => void
  onOpenSettings: () => void
  onRegisterCreate?: (trigger: () => void) => void
}

export function Sidebar({
  worktrees,
  activeWorktreeId,
  statuses,
  prStatuses,
  lastActive,
  prLoading,
  onSelectWorktree,
  onCreateWorktree,
  onDeleteWorktree,
  onRefresh,
  onSelectRepo,
  onOpenSettings,
  onRegisterCreate
}: SidebarProps): JSX.Element {
  const [showCreate, setShowCreate] = useState(false)
  const [branchName, setBranchName] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<Record<GroupKey, boolean>>({ 'needs-attention': false, active: false, 'no-pr': false, merged: true })

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

  const toggleGroup = useCallback((key: GroupKey) => {
    setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }))
  }, [])

  const groups = useMemo(() => groupWorktrees(worktrees, prStatuses, lastActive), [worktrees, prStatuses, lastActive])

  return (
    <div className="w-56 bg-panel border-r border-border flex flex-col h-full">
      {/* Title bar drag region with app name — vertically aligned with traffic lights at y:12 */}
      <div className="drag-region h-10 relative shrink-0">
        <span className="text-xs font-semibold text-muted absolute left-20 top-[11px]">Harness</span>
      </div>

      {/* Worktrees header */}
      <div className="px-3 py-1.5 flex items-center gap-2 shrink-0">
        <span className="text-xs font-medium text-dim">WORKTREES</span>
        {prLoading && <Loader2 size={10} className="text-faint animate-spin" />}
      </div>

      {/* Worktree list grouped by PR status */}
      <div className="flex-1 overflow-y-auto py-1">
        {groups.map((group) => (
          <div key={group.key}>
            <button
              onClick={() => toggleGroup(group.key)}
              className="w-full flex items-center gap-1 px-3 py-1.5 text-xs text-dim hover:text-fg transition-colors cursor-pointer"
            >
              {collapsed[group.key]
                ? <ChevronRight size={12} className="shrink-0" />
                : <ChevronDown size={12} className="shrink-0" />
              }
              <span className="font-medium">{group.label}</span>
              <span className="text-faint ml-auto">{group.worktrees.length}</span>
            </button>
            {!collapsed[group.key] && group.worktrees.map((wt) => (
              <WorktreeTab
                key={wt.path}
                worktree={wt}
                isActive={wt.path === activeWorktreeId}
                status={statuses[wt.path] || 'idle'}
                prStatus={prStatuses[wt.path]}
                onClick={() => onSelectWorktree(wt.path)}
                onDelete={wt.isMain ? undefined : () => onDeleteWorktree(wt.path)}
              />
            ))}
          </div>
        ))}
        {worktrees.length === 0 && (
          <div className="px-4 py-3 text-xs text-faint">
            No worktrees found
          </div>
        )}
      </div>

      {/* Create worktree form */}
      {showCreate && (
        <div className="border-t border-border p-2">
          <input
            type="text"
            value={branchName}
            onChange={(e) => setBranchName(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="branch-name"
            autoFocus
            disabled={creating}
            className="w-full bg-panel-raised border border-border-strong rounded px-2 py-1.5 text-xs text-fg-bright placeholder-faint outline-none focus:border-fg"
          />
          {error && (
            <div className="text-xs text-danger mt-1 px-1 truncate" title={error}>
              {error}
            </div>
          )}
          <div className="flex gap-1 mt-1.5">
            <button
              onClick={handleCreate}
              disabled={creating || !branchName.trim()}
              className="flex-1 text-xs bg-surface hover:bg-surface-hover disabled:opacity-40 rounded px-2 py-1 text-fg-bright transition-colors cursor-pointer"
            >
              {creating ? 'Creating...' : 'Create'}
            </button>
            <button
              onClick={() => {
                setShowCreate(false)
                setBranchName('')
                setError(null)
              }}
              className="text-xs text-dim hover:text-fg px-2 py-1 transition-colors cursor-pointer"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Bottom actions */}
      <div className="border-t border-border p-2 flex justify-center gap-1 shrink-0">
        <button
          onClick={() => setShowCreate(!showCreate)}
          className="text-dim hover:text-fg hover:bg-surface rounded p-1.5 transition-colors cursor-pointer"
          title="New worktree"
        >
          <Plus size={14} />
        </button>
        <button
          onClick={onRefresh}
          className="text-dim hover:text-fg hover:bg-surface rounded p-1.5 transition-colors cursor-pointer"
          title="Refresh worktrees"
        >
          <RefreshCw size={14} />
        </button>
        <button
          onClick={onSelectRepo}
          className="text-dim hover:text-fg hover:bg-surface rounded p-1.5 transition-colors cursor-pointer"
          title="Change repository"
        >
          <FolderOpen size={14} />
        </button>
        <button
          onClick={onOpenSettings}
          className="text-dim hover:text-fg hover:bg-surface rounded p-1.5 transition-colors cursor-pointer"
          title="Settings"
        >
          <SettingsIcon size={14} />
        </button>
      </div>
    </div>
  )
}

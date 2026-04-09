import type { Worktree, PtyStatus } from '../types'
import { WorktreeTab } from './WorktreeTab'

interface SidebarProps {
  worktrees: Worktree[]
  activeWorktreeId: string | null
  statuses: Record<string, PtyStatus>
  onSelectWorktree: (path: string) => void
  onRefresh: () => void
  onSelectRepo: () => void
}

export function Sidebar({
  worktrees,
  activeWorktreeId,
  statuses,
  onSelectWorktree,
  onRefresh,
  onSelectRepo
}: SidebarProps): JSX.Element {
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
          />
        ))}
        {worktrees.length === 0 && (
          <div className="px-4 py-3 text-xs text-neutral-600">
            No worktrees found
          </div>
        )}
      </div>

      {/* Bottom actions */}
      <div className="border-t border-neutral-800 p-2 flex gap-1 shrink-0">
        <button
          onClick={onRefresh}
          className="flex-1 text-xs text-neutral-500 hover:text-neutral-300 hover:bg-neutral-800 rounded px-2 py-1.5 transition-colors"
          title="Refresh worktrees"
        >
          Refresh
        </button>
        <button
          onClick={onSelectRepo}
          className="flex-1 text-xs text-neutral-500 hover:text-neutral-300 hover:bg-neutral-800 rounded px-2 py-1.5 transition-colors"
          title="Change repository"
        >
          Change Repo
        </button>
      </div>
    </div>
  )
}

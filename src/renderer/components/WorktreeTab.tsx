import type { Worktree, PtyStatus } from '../types'

interface WorktreeTabProps {
  worktree: Worktree
  isActive: boolean
  status: PtyStatus
  onClick: () => void
}

const STATUS_COLORS: Record<PtyStatus, string> = {
  idle: 'bg-neutral-600',
  processing: 'bg-green-500 animate-pulse',
  waiting: 'bg-amber-400',
  'needs-approval': 'bg-red-500 animate-pulse'
}

const STATUS_LABELS: Record<PtyStatus, string> = {
  idle: 'Idle',
  processing: 'Working...',
  waiting: 'Waiting for input',
  'needs-approval': 'Needs approval'
}

export function WorktreeTab({ worktree, isActive, status, onClick }: WorktreeTabProps): JSX.Element {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-3 py-2 flex items-center gap-2 transition-colors cursor-pointer ${
        isActive
          ? 'bg-neutral-800 text-neutral-100'
          : 'text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200'
      }`}
    >
      <span
        className={`w-2 h-2 rounded-full shrink-0 ${STATUS_COLORS[status]}`}
        title={STATUS_LABELS[status]}
      />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium truncate">{worktree.branch}</div>
        <div className="text-xs text-neutral-600 truncate">
          {worktree.path.split('/').slice(-2).join('/')}
        </div>
      </div>
    </button>
  )
}

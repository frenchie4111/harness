import { GitPullRequest } from 'lucide-react'
import type { Worktree, PtyStatus, PRStatus } from '../types'

interface WorktreeTabProps {
  worktree: Worktree
  isActive: boolean
  status: PtyStatus
  prStatus?: PRStatus | null
  onClick: () => void
  onDelete?: () => void
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

const PR_ICON_COLOR: Record<string, string> = {
  success: 'text-green-400',
  failure: 'text-red-400',
  pending: 'text-amber-400',
  none: 'text-neutral-500'
}

const PR_STATE_COLOR: Record<string, string> = {
  open: 'text-green-400',
  draft: 'text-neutral-500',
  merged: 'text-purple-400',
  closed: 'text-red-400'
}

export function WorktreeTab({ worktree, isActive, status, prStatus, onClick, onDelete }: WorktreeTabProps): JSX.Element {
  // Use check status color if available, otherwise use PR state color
  const iconColor = prStatus
    ? (prStatus.checksOverall !== 'none' ? PR_ICON_COLOR[prStatus.checksOverall] : PR_STATE_COLOR[prStatus.state])
    : ''

  return (
    <div
      onClick={onClick}
      className={`group w-full text-left px-3 py-2 flex items-center gap-2 transition-colors cursor-pointer ${
        isActive
          ? 'bg-neutral-800 text-neutral-100'
          : 'text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200'
      }`}
    >
      <span
        className={`w-2 h-2 rounded-full shrink-0 ${STATUS_COLORS[status]}`}
        title={STATUS_LABELS[status]}
      />
      {prStatus && (
        <GitPullRequest
          size={13}
          className={`shrink-0 ${iconColor}`}
          title={`PR #${prStatus.number}${prStatus.checksOverall !== 'none' ? ` \u2014 checks ${prStatus.checksOverall}` : ''}`}
        />
      )}
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium truncate">{worktree.branch}</div>
        <div className="text-xs text-neutral-600 truncate">
          {worktree.path.split('/').slice(-2).join('/')}
        </div>
      </div>
      {onDelete && (
        <button
          onClick={(e) => {
            e.stopPropagation()
            onDelete()
          }}
          className="opacity-0 group-hover:opacity-100 text-neutral-600 hover:text-red-400 text-xs transition-all shrink-0 cursor-pointer"
          title="Remove worktree"
        >
          x
        </button>
      )}
    </div>
  )
}

import { GitPullRequest, RotateCw, Trash2 } from 'lucide-react'
import type { Worktree, PtyStatus, PRStatus } from '../types'
import { Tooltip } from './Tooltip'

interface WorktreeTabProps {
  worktree: Worktree
  isActive: boolean
  status: PtyStatus
  prStatus?: PRStatus | null
  onClick: () => void
  onDelete?: () => void
  onContinue?: () => void
}

const STATUS_COLORS: Record<PtyStatus, string> = {
  idle: 'bg-faint',
  processing: 'bg-success animate-pulse',
  waiting: 'bg-warning',
  'needs-approval': 'bg-danger animate-pulse'
}

const STATUS_LABELS: Record<PtyStatus, string> = {
  idle: 'Idle',
  processing: 'Working...',
  waiting: 'Waiting for input',
  'needs-approval': 'Needs approval'
}

const PR_ICON_COLOR: Record<string, string> = {
  success: 'text-success',
  failure: 'text-danger',
  pending: 'text-warning',
  none: 'text-dim'
}

const PR_STATE_COLOR: Record<string, string> = {
  open: 'text-success',
  draft: 'text-dim',
  merged: 'text-accent',
  closed: 'text-danger'
}

export function WorktreeTab({ worktree, isActive, status, prStatus, onClick, onDelete, onContinue }: WorktreeTabProps): JSX.Element {
  const canContinue = !!onContinue && (prStatus?.state === 'merged' || prStatus?.state === 'closed')
  // Priority: merged/closed state always wins, then merge conflict, then check
  // status, then PR state
  let iconColor = ''
  let iconTitleSuffix = ''
  if (prStatus) {
    if (prStatus.state === 'merged') iconColor = PR_STATE_COLOR.merged
    else if (prStatus.state === 'closed') iconColor = PR_STATE_COLOR.closed
    else if (prStatus.hasConflict === true) {
      iconColor = PR_ICON_COLOR.failure
      iconTitleSuffix = ' \u2014 merge conflict'
    }
    else if (prStatus.checksOverall === 'failure') iconColor = PR_ICON_COLOR.failure
    else if (prStatus.checksOverall === 'pending') iconColor = PR_ICON_COLOR.pending
    else if (prStatus.checksOverall === 'success') iconColor = PR_ICON_COLOR.success
    else iconColor = PR_STATE_COLOR[prStatus.state]
  }

  return (
    <div
      onClick={onClick}
      className={`group w-full text-left px-3 py-2 flex items-center gap-2 transition-colors cursor-pointer ${
        isActive
          ? 'bg-surface text-fg-bright'
          : 'text-muted hover:bg-panel-raised hover:text-fg'
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
          title={`PR #${prStatus.number}${prStatus.checksOverall !== 'none' ? ` \u2014 checks ${prStatus.checksOverall}` : ''}${iconTitleSuffix}`}
        />
      )}
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium truncate">{worktree.branch}</div>
        <div className="text-xs text-faint truncate">
          {worktree.path.split('/').slice(-2).join('/')}
        </div>
      </div>
      {canContinue && (
        <Tooltip label="Continue on a new branch off main" side="left">
          <button
            onClick={(e) => {
              e.stopPropagation()
              onContinue!()
            }}
            className="opacity-0 group-hover:opacity-100 text-faint hover:text-accent transition-all shrink-0 cursor-pointer"
          >
            <RotateCw size={12} />
          </button>
        </Tooltip>
      )}
      {onDelete && (
        <Tooltip label="Remove worktree" side="left">
          <button
            onClick={(e) => {
              e.stopPropagation()
              onDelete()
            }}
            className="opacity-0 group-hover:opacity-100 text-faint hover:text-danger transition-all shrink-0 cursor-pointer"
          >
            <Trash2 size={12} />
          </button>
        </Tooltip>
      )}
    </div>
  )
}

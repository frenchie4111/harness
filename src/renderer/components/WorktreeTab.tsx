import { GitPullRequest, RotateCw, Trash2, Loader2 } from 'lucide-react'
import type { Worktree, PtyStatus, PendingTool, PRStatus } from '../types'
import { isPRMerged } from '../../shared/state/prs'
import { Tooltip } from './Tooltip'
import { repoNameColor } from './RepoIcon'
import { formatPendingTool } from '../pending-tool'
import { HotkeyBadge } from './HotkeyBadge'
import { useMetaHeld } from '../hooks/useMetaHeld'
import type { Action } from '../hotkeys'

interface WorktreeTabProps {
  worktree: Worktree
  isActive: boolean
  status: PtyStatus
  pendingTool?: PendingTool | null
  shellActive?: boolean
  prStatus?: PRStatus | null
  isMerged?: boolean
  /** When set, shows a small repo hint next to the branch name. Used in
   *  unified-repo mode so two branches with the same name stay distinguishable. */
  repoLabel?: string
  /** 1-based position in the Cmd+1..9 switch order. Undefined if this
   *  worktree isn't bound to a numeric switch hotkey. */
  cmdOrdinal?: number
  /** When true, the worktree is in the middle of being deleted — show an
   * inert spinner + dim the row, hide action buttons. */
  deleting?: boolean
  onClick: () => void
  onDelete?: () => void
  onContinue?: () => void
}

const STATUS_COLORS: Record<PtyStatus | 'merged', string> = {
  idle: 'bg-faint',
  processing: 'bg-success animate-pulse',
  waiting: 'bg-warning',
  'needs-approval': 'bg-danger animate-pulse',
  merged: 'bg-accent'
}

const STATUS_LABELS: Record<PtyStatus | 'merged', string> = {
  idle: 'Idle',
  processing: 'Working...',
  waiting: 'Waiting for input',
  'needs-approval': 'Needs approval',
  merged: 'Merged'
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

export function WorktreeTab({ worktree, isActive, status, pendingTool, shellActive, prStatus, isMerged, repoLabel, cmdOrdinal, deleting, onClick, onDelete, onContinue }: WorktreeTabProps): JSX.Element {
  const metaHeld = useMetaHeld()
  const displayStatus: PtyStatus | 'merged' = isMerged ? 'merged' : status
  const showPendingTool = displayStatus === 'needs-approval' && pendingTool
  const canContinue = !!onContinue && isPRMerged(prStatus)
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
        deleting ? 'opacity-60 italic' : ''
      } ${
        isActive
          ? 'bg-surface text-fg-bright'
          : 'text-muted hover:bg-panel-raised hover:text-fg'
      }`}
    >
      {deleting ? (
        <Loader2
          size={11}
          className="animate-spin text-danger shrink-0"
          aria-label="Deleting worktree"
        />
      ) : (
        <span
          className={`w-2 h-2 rounded-full shrink-0 ${STATUS_COLORS[displayStatus]}`}
          title={STATUS_LABELS[displayStatus]}
        />
      )}
      {shellActive && (
        <Loader2
          size={11}
          className="animate-spin text-fg-bright shrink-0"
          aria-label="Shell activity"
        />
      )}
      {prStatus && (
        <span className="relative shrink-0">
          <GitPullRequest
            size={13}
            className={iconColor}
            title={`PR #${prStatus.number}${prStatus.checksOverall !== 'none' ? ` \u2014 checks ${prStatus.checksOverall}` : ''}${iconTitleSuffix}${prStatus.reviewDecision === 'approved' ? ' \u2014 approved' : prStatus.reviewDecision === 'changes_requested' ? ' \u2014 changes requested' : ''}`}
          />
          {prStatus.reviewDecision === 'approved' && (
            <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-success ring-1 ring-panel" />
          )}
          {prStatus.reviewDecision === 'changes_requested' && (
            <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-warning ring-1 ring-panel" />
          )}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium truncate">{worktree.branch}</div>
        {showPendingTool ? (
          <div className="text-xs text-danger truncate font-mono" title={formatPendingTool(pendingTool!)}>
            {formatPendingTool(pendingTool!)}
          </div>
        ) : (
          <div className="text-xs text-faint truncate">
            {repoLabel ? (
              <span className="inline-flex items-center gap-1">
                <span className={repoNameColor(repoLabel)}>{repoLabel}</span>
                <span className="mx-0.5">·</span>
                {worktree.path.split('/').pop()}
              </span>
            ) : (
              worktree.path.split('/').slice(-2).join('/')
            )}
          </div>
        )}
      </div>
      {canContinue && (
        <Tooltip label="Continue on a new branch off main" side="left">
          <button
            onClick={(e) => {
              e.stopPropagation()
              onContinue!()
            }}
            className="hidden group-hover:flex text-faint hover:text-accent transition-colors shrink-0 cursor-pointer"
          >
            <RotateCw size={12} />
          </button>
        </Tooltip>
      )}
      {prStatus && typeof prStatus.additions === 'number' && typeof prStatus.deletions === 'number' && (
        <span
          className="text-[10px] font-mono shrink-0 leading-none group-hover:hidden"
          title={`+${prStatus.additions} additions, −${prStatus.deletions} deletions`}
        >
          <span className="text-success">+{prStatus.additions}</span>
          <span className="text-danger ml-0.5">−{prStatus.deletions}</span>
        </span>
      )}
      {onDelete && (
        <Tooltip label="Remove worktree" side="left">
          <button
            onClick={(e) => {
              e.stopPropagation()
              onDelete()
            }}
            className="hidden group-hover:flex text-faint hover:text-danger transition-colors shrink-0 cursor-pointer"
          >
            <Trash2 size={12} />
          </button>
        </Tooltip>
      )}
      {metaHeld && cmdOrdinal !== undefined && (
        <HotkeyBadge
          action={`worktree${cmdOrdinal}` as Action}
          variant="strong"
          className="shrink-0"
        />
      )}
    </div>
  )
}

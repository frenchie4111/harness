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

const PR_INDICATOR: Record<string, { symbol: string; color: string; label: string }> = {
  open: { symbol: '\u25CB', color: 'text-green-400', label: 'PR open' },
  draft: { symbol: '\u25CB', color: 'text-neutral-500', label: 'PR draft' },
  merged: { symbol: '\u25CF', color: 'text-purple-400', label: 'PR merged' },
  closed: { symbol: '\u25CF', color: 'text-red-400', label: 'PR closed' }
}

const CHECKS_INDICATOR: Record<string, string> = {
  success: 'text-green-400',
  failure: 'text-red-400',
  pending: 'text-amber-400',
  none: ''
}

export function WorktreeTab({ worktree, isActive, status, prStatus, onClick, onDelete }: WorktreeTabProps): JSX.Element {
  const prInfo = prStatus ? PR_INDICATOR[prStatus.state] : null
  const checksColor = prStatus ? CHECKS_INDICATOR[prStatus.checksOverall] : ''

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
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium truncate flex items-center gap-1.5">
          {worktree.branch}
          {prInfo && (
            <span
              className={`text-[10px] shrink-0 ${checksColor || prInfo.color}`}
              title={`${prInfo.label} #${prStatus!.number}${prStatus!.checksOverall !== 'none' ? ` \u2014 checks ${prStatus!.checksOverall}` : ''}`}
            >
              PR
            </span>
          )}
        </div>
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

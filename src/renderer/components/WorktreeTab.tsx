import { useEffect } from 'react'
import { GitPullRequest, RotateCw, Trash2, Loader2, Moon, TriangleAlert, AlarmClock, Ghost } from 'lucide-react'
import type { Worktree, PtyStatus, PendingTool, PRStatus } from '../types'
import { isPRMerged } from '../../shared/state/prs'
import { formatWakeAt } from '../../shared/state/snooze'
import { useAppState } from '../store'
import { Tooltip } from './Tooltip'
import { formatWorktreeAge } from './worktree-detail'
import { useWorktreeDetailOverride } from '../worktree-detail-override'
import { repoNameColor } from './RepoIcon'
import { formatPendingTool } from '../pending-tool'
import { HotkeyBadge } from './HotkeyBadge'
import { useMetaHeld } from '../hooks/useMetaHeld'
import type { Action } from '../hotkeys'
import { TicketProviderIcon } from './TicketProvidersSettings'
import { useCachedTicket, useTicketProviders, useWorktreeLinkedTicket } from '../store'
import { useBackend } from '../backend'
import type { WorktreeTicketLink } from '../../shared/tickets'

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
  isSnoozed?: boolean
  /** Wake-up timestamp (ms). Only meaningful when isSnoozed is true; used
   *  to render a "Wakes …" tooltip. */
  snoozeWakeAt?: number
  onClick: () => void
  onDelete?: () => void
  onContinue?: () => void
  /** Plain click → snooze for default duration. Option-click → open calendar
   *  popover at the row. The handler receives the original event so the
   *  caller can decide based on altKey. */
  onSnooze?: (e: React.MouseEvent) => void
  onUnsnooze?: () => void
  /** Only present when `worktree.prunable === true`. Invokes
   *  `git worktree prune` at the repo root and refreshes the list. */
  onPrune?: () => void
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

const DETACHED_LIKE_PREFIXES = ['rebasing', 'bisecting', 'cherry-picking']

function detachedLikeTooltip(branch: string): string | null {
  if (branch === '(detached)') return 'Detached HEAD'
  for (const prefix of DETACHED_LIKE_PREFIXES) {
    if (branch === prefix || branch.startsWith(`${prefix} `) || branch.startsWith(`${prefix}(`)) {
      return `In progress: ${branch}`
    }
  }
  return null
}

const PR_STATE_COLOR: Record<string, string> = {
  open: 'text-success',
  draft: 'text-dim',
  merged: 'text-accent',
  closed: 'text-danger'
}

export function WorktreeTab({ worktree, isActive, status, pendingTool, shellActive, prStatus, isMerged, repoLabel, cmdOrdinal, deleting, isSnoozed, snoozeWakeAt, onClick, onDelete, onContinue, onSnooze, onUnsnooze, onPrune }: WorktreeTabProps): JSX.Element {
  const metaHeld = useMetaHeld()
  const configuredWorktreeDetail = useAppState((s) => s.settings.worktreeDetail)
  const worktreeDetailOverride = useWorktreeDetailOverride()
  const worktreeDetail = worktreeDetailOverride ?? configuredWorktreeDetail
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
          className="icon-xs animate-spin text-danger shrink-0"
          aria-label="Deleting worktree" />
      ) : (
        <span
          className={`w-2 h-2 rounded-full shrink-0 ${STATUS_COLORS[displayStatus]}`}
          title={STATUS_LABELS[displayStatus]}
        />
      )}
      {shellActive && (
        <Loader2
          className="icon-xs animate-spin text-fg-bright shrink-0"
          aria-label="Shell activity" />
      )}
      {prStatus && (
        <span
          className="relative shrink-0"
          title={`PR #${prStatus.number}${prStatus.checksOverall !== 'none' ? ` \u2014 checks ${prStatus.checksOverall}` : ''}${iconTitleSuffix}${prStatus.reviewDecision === 'approved' ? ' \u2014 approved' : prStatus.reviewDecision === 'changes_requested' ? ' \u2014 changes requested' : ''}`}
        >
          <GitPullRequest className={`icon-sm ${iconColor}`} />
          {prStatus.reviewDecision === 'approved' && (
            <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-success ring-1 ring-panel" />
          )}
          {prStatus.reviewDecision === 'changes_requested' && (
            <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-warning ring-1 ring-panel" />
          )}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium truncate flex items-center gap-1">
          {(() => {
            const tip = detachedLikeTooltip(worktree.branch)
            return tip ? (
              <span className="shrink-0 inline-flex" title={tip} aria-label={tip}>
                <TriangleAlert className="icon-xs text-warning" />
              </span>
            ) : null
          })()}
          <span className={`truncate ${worktree.prunable ? 'line-through text-dim' : ''}`}>
            {worktree.branch}
          </span>
          {worktree.prunable && (
            <span
              className="shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm bg-warning/15 text-warning text-[10px] uppercase tracking-wide"
              title={worktree.prunableReason || 'On-disk directory missing — click the ghost icon to run `git worktree prune`.'}
            >
              <Ghost className="icon-2xs" />
              stale
            </span>
          )}
          <LinkedTicketChip worktreePath={worktree.path} />
        </div>
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
            <RotateCw className="icon-xs" />
          </button>
        </Tooltip>
      )}
      {worktreeDetail === 'diff' && prStatus && typeof prStatus.additions === 'number' && typeof prStatus.deletions === 'number' && (
        <span
          className="text-xs font-mono shrink-0 leading-none group-hover:hidden"
          title={`+${prStatus.additions} additions, −${prStatus.deletions} deletions`}
        >
          <span className="text-success">+{prStatus.additions}</span>
          <span className="text-danger ml-0.5">−{prStatus.deletions}</span>
        </span>
      )}
      {worktreeDetail === 'age' && (
        <span
          className="text-xs font-mono shrink-0 leading-none text-dim group-hover:hidden"
          title={worktree.createdAt ? `Created ${new Date(worktree.createdAt).toLocaleString()}` : 'Creation time unknown'}
        >
          {formatWorktreeAge(worktree.createdAt)}
        </span>
      )}
      {worktreeDetail === 'pr' && prStatus && (
        <span className="inline-flex items-center gap-1.5 shrink-0 group-hover:hidden">
          {prStatus.milestone && (
            <span
              className="text-xs text-dim truncate max-w-[6rem]"
              title={`Milestone: ${prStatus.milestone.title}`}
            >
              {prStatus.milestone.title}
            </span>
          )}
          <span
            className="text-xs font-mono leading-none px-1.5 py-0.5 rounded-full bg-panel border border-border-strong text-fg-bright"
            title={`PR #${prStatus.number}`}
          >
            #{prStatus.number}
          </span>
          {prStatus.assignees[0] && (
            <img
              src={prStatus.assignees[0].avatarUrl}
              alt=""
              title={`Assignee: ${prStatus.assignees[0].login}${prStatus.assignees.length > 1 ? ` (+${prStatus.assignees.length - 1})` : ''}`}
              className="w-3.5 h-3.5 rounded-full shrink-0"
            />
          )}
        </span>
      )}
      {(onSnooze || onUnsnooze) && !worktree.isMain && (
        <Tooltip
          label={
            isSnoozed
              ? typeof snoozeWakeAt === 'number'
                ? `Wakes ${formatWakeAt(snoozeWakeAt)} — click to wake up`
                : 'Wake up'
              : 'Snooze (⌥-click to pick a date)'
          }
          side="left"
        >
          <button
            onClick={(e) => {
              e.stopPropagation()
              if (isSnoozed) {
                onUnsnooze?.()
              } else {
                onSnooze?.(e)
              }
            }}
            className="hidden group-hover:flex text-faint hover:text-accent transition-colors shrink-0 cursor-pointer"
          >
            {isSnoozed ? <AlarmClock className="icon-xs" /> : <Moon className="icon-xs" />}
          </button>
        </Tooltip>
      )}
      {onPrune && worktree.prunable && (
        <Tooltip label="Prune stale worktree (git worktree prune)" side="left">
          <button
            onClick={(e) => {
              e.stopPropagation()
              onPrune()
            }}
            className="hidden group-hover:flex text-warning hover:text-fg-bright transition-colors shrink-0 cursor-pointer"
          >
            <Trash2 className="icon-xs" />
          </button>
        </Tooltip>
      )}
      {onDelete && !worktree.prunable && (
        <Tooltip label="Remove worktree" side="left">
          <button
            onClick={(e) => {
              e.stopPropagation()
              onDelete()
            }}
            className="hidden group-hover:flex text-faint hover:text-danger transition-colors shrink-0 cursor-pointer"
          >
            <Trash2 className="icon-xs" />
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

interface LinkedTicketChipProps {
  worktreePath: string
}

/** Inline chip rendered next to the worktree's branch name when the
 *  worktree was spawned from a ticket. Clicking opens the ticket in its
 *  native UI via the OS browser. Hovers shows the full title + provider
 *  + external id; while the ticket cache is cold we still show the
 *  external id so the chip isn't empty. */
function LinkedTicketChip({ worktreePath }: LinkedTicketChipProps): JSX.Element | null {
  const link = useWorktreeLinkedTicket(worktreePath)
  const cached = useCachedTicket(link)
  const providers = useTicketProviders()
  const backend = useBackend()

  // Fetch the ticket lazily if we have a link but no cache entry yet.
  // This populates the cache the first time the row mounts, regardless
  // of whether the picker primed it on creation. Re-runs only when the
  // link target changes — re-renders that don't change `link` no-op
  // because the link object reference comes from the stub's per-key
  // selector.
  useEffect(() => {
    if (link && !cached) {
      void backend.ticketsGet(link.providerId, link.externalId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [link])

  if (!link) return null
  const provider = providers.find((p) => p.id === link.providerId) ?? null
  const title = cached?.title ?? `#${link.externalId}`
  const tooltipBody = cached
    ? `${cached.title} (${link.externalId}${provider ? ` · ${provider.label}` : ''})`
    : `${link.externalId}${provider ? ` · ${provider.label}` : ''}`

  const handleClick = (e: React.MouseEvent): void => {
    e.stopPropagation()
    // Prefer the cached url; fall back to the external id only as a
    // last resort — without a url we can't do much, so just no-op.
    if (cached?.url) backend.openExternal(cached.url)
  }

  return (
    <Tooltip label={tooltipBody} side="bottom">
      <button
        type="button"
        onClick={handleClick}
        className="ml-1 inline-flex items-center gap-1 max-w-[8rem] shrink min-w-0 rounded-full px-1.5 py-0.5 text-xs bg-panel-raised border border-border-strong text-dim hover:text-fg hover:border-accent transition-colors cursor-pointer"
        aria-label={`Linked ticket: ${tooltipBody}`}
      >
        {provider ? (
          <TicketProviderIcon type={provider.type} className="icon-2xs shrink-0" />
        ) : (
          <span className="w-2 h-2 rounded-full bg-dim shrink-0" />
        )}
        <span className="truncate">{title}</span>
      </button>
    </Tooltip>
  )
}

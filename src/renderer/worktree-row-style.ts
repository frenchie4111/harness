import type { PtyStatus, PRStatus } from './types'

/** Presentation vocabulary for a worktree row's status dot and PR icon.
 *  Pure + framework-free so the desktop sidebar, the touch picker, and the
 *  command palette all render the same colors from the same source. */

export type DisplayStatus = PtyStatus | 'merged'

export const STATUS_COLORS: Record<DisplayStatus, string> = {
  idle: 'bg-faint',
  processing: 'bg-success animate-pulse',
  waiting: 'bg-warning',
  'needs-approval': 'bg-danger animate-pulse',
  merged: 'bg-accent'
}

export const STATUS_LABELS: Record<DisplayStatus, string> = {
  idle: 'Idle',
  processing: 'Working...',
  waiting: 'Waiting for input',
  'needs-approval': 'Needs approval',
  merged: 'Merged'
}

const PR_CHECK_COLOR: Record<string, string> = {
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

export interface PRIconStyle {
  /** Tailwind text-color class for the GitPullRequest glyph. Empty when
   *  there's no PR at all. */
  iconColor: string
  /** Extra clause appended to the icon's title attribute. Only non-empty
   *  for the merge-conflict case. */
  titleSuffix: string
}

/** Colour ladder for the PR icon. Priority order matters and is load-bearing:
 *  a merged/closed PR always reads as merged/closed even if its last check
 *  run failed, and an open PR with a merge conflict reads as failing even
 *  when CI is green. */
export function prIconStyle(prStatus: PRStatus | null | undefined): PRIconStyle {
  if (!prStatus) return { iconColor: '', titleSuffix: '' }
  if (prStatus.state === 'merged') return { iconColor: PR_STATE_COLOR.merged, titleSuffix: '' }
  if (prStatus.state === 'closed') return { iconColor: PR_STATE_COLOR.closed, titleSuffix: '' }
  if (prStatus.hasConflict === true) {
    return { iconColor: PR_CHECK_COLOR.failure, titleSuffix: ' — merge conflict' }
  }
  if (prStatus.checksOverall === 'failure') return { iconColor: PR_CHECK_COLOR.failure, titleSuffix: '' }
  if (prStatus.checksOverall === 'pending') return { iconColor: PR_CHECK_COLOR.pending, titleSuffix: '' }
  if (prStatus.checksOverall === 'success') return { iconColor: PR_CHECK_COLOR.success, titleSuffix: '' }
  return { iconColor: PR_STATE_COLOR[prStatus.state] ?? '', titleSuffix: '' }
}

export function prIconTitle(prStatus: PRStatus): string {
  const { titleSuffix } = prIconStyle(prStatus)
  const checks = prStatus.checksOverall !== 'none' ? ` — checks ${prStatus.checksOverall}` : ''
  const review =
    prStatus.reviewDecision === 'approved'
      ? ' — approved'
      : prStatus.reviewDecision === 'changes_requested'
        ? ' — changes requested'
        : ''
  return `PR #${prStatus.number}${checks}${titleSuffix}${review}`
}

const DETACHED_LIKE_PREFIXES = ['rebasing', 'bisecting', 'cherry-picking']

/** Tooltip for branch strings git reports during an in-progress operation
 *  (detached HEAD, rebase, bisect, cherry-pick). Null for normal branches. */
export function detachedLikeTooltip(branch: string): string | null {
  if (branch === '(detached)') return 'Detached HEAD'
  for (const prefix of DETACHED_LIKE_PREFIXES) {
    if (branch === prefix || branch.startsWith(`${prefix} `) || branch.startsWith(`${prefix}(`)) {
      return `In progress: ${branch}`
    }
  }
  return null
}

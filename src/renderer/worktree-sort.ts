import type { Worktree, PRStatus } from './types'
import { isPRMerged } from '../shared/state/prs'

export type GroupKey = 'needs-attention' | 'reviewing' | 'active' | 'no-pr' | 'snoozed' | 'merged'

export interface WorktreeGroup {
  key: GroupKey
  label: string
  worktrees: Worktree[]
}

export function getGroupKey(
  wt: Worktree,
  pr: PRStatus | null | undefined,
  locallyMerged?: boolean,
  isSnoozed?: boolean,
  viewerLogin?: string | null
): GroupKey {
  void wt
  if (isSnoozed) return 'snoozed'
  if (locallyMerged) return 'merged'
  if (!pr) return 'no-pr'
  if (isPRMerged(pr)) return 'merged'
  // PR is open: if we know the viewer's login and this PR was authored
  // by somebody else, it's something we're reviewing. The 'needs-attention'
  // signals (failing checks, conflicts, changes requested) apply to PRs
  // we own — for reviews the user doesn't have to fix anything.
  if (viewerLogin && pr.author && pr.author.login !== viewerLogin) return 'reviewing'
  if (pr.checksOverall === 'failure' || pr.hasConflict === true || pr.reviewDecision === 'changes_requested') return 'needs-attention'
  return 'active'
}

export const GROUP_ORDER: GroupKey[] = ['needs-attention', 'reviewing', 'active', 'no-pr', 'snoozed', 'merged']

export const GROUP_LABELS: Record<GroupKey, string> = {
  'needs-attention': 'Needs Attention',
  reviewing: 'Reviewing',
  active: 'Open PRs',
  'no-pr': 'Active',
  merged: 'Merged / Closed',
  snoozed: 'Snoozed'
}

/** Sort worktrees within a group by creation time (newest first). Main worktree pinned to top. */
function sortByCreatedAt(worktrees: Worktree[]): Worktree[] {
  return [...worktrees].sort((a, b) => {
    if (a.isMain !== b.isMain) return a.isMain ? -1 : 1
    return (b.createdAt || 0) - (a.createdAt || 0)
  })
}

/** Group worktrees by PR status, sorted by creation time within each group */
export function groupWorktrees(
  worktrees: Worktree[],
  prStatuses: Record<string, PRStatus | null>,
  mergedPaths?: Record<string, boolean>,
  snoozedPaths?: Record<string, true>,
  viewerLogin?: string | null
): WorktreeGroup[] {
  const grouped: Record<GroupKey, Worktree[]> = {
    'needs-attention': [],
    reviewing: [],
    active: [],
    'no-pr': [],
    merged: [],
    snoozed: []
  }

  for (const wt of worktrees) {
    const key = getGroupKey(
      wt,
      prStatuses[wt.path],
      mergedPaths?.[wt.path],
      snoozedPaths?.[wt.path],
      viewerLogin
    )
    grouped[key].push(wt)
  }

  return GROUP_ORDER
    .filter((key) => grouped[key].length > 0)
    .map((key) => ({
      key,
      label: GROUP_LABELS[key],
      worktrees: sortByCreatedAt(grouped[key])
    }))
}

/** Flatten grouped worktrees into a single ordered list (matching sidebar display order) */
export function sortedWorktrees(
  worktrees: Worktree[],
  prStatuses: Record<string, PRStatus | null>,
  mergedPaths?: Record<string, boolean>,
  snoozedPaths?: Record<string, true>,
  viewerLogin?: string | null
): Worktree[] {
  return groupWorktrees(worktrees, prStatuses, mergedPaths, snoozedPaths, viewerLogin).flatMap(
    (g) => g.worktrees
  )
}

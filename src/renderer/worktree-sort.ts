import type { Worktree, PRStatus } from './types'

export type GroupKey = 'needs-attention' | 'active' | 'no-pr' | 'merged'

export interface WorktreeGroup {
  key: GroupKey
  label: string
  worktrees: Worktree[]
}

export function getGroupKey(
  wt: Worktree,
  pr: PRStatus | null | undefined,
  locallyMerged?: boolean
): GroupKey {
  if (locallyMerged) return 'merged'
  if (!pr) return 'no-pr'
  if (pr.state === 'merged' || pr.state === 'closed') return 'merged'
  if (pr.checksOverall === 'failure' || pr.hasConflict === true || pr.reviewDecision === 'changes_requested') return 'needs-attention'
  return 'active'
}

export const GROUP_ORDER: GroupKey[] = ['needs-attention', 'active', 'no-pr', 'merged']

export const GROUP_LABELS: Record<GroupKey, string> = {
  'needs-attention': 'Needs Attention',
  active: 'Open PRs',
  'no-pr': 'Active',
  merged: 'Merged / Closed'
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
  mergedPaths?: Record<string, boolean>
): WorktreeGroup[] {
  const grouped: Record<GroupKey, Worktree[]> = {
    'needs-attention': [],
    active: [],
    'no-pr': [],
    merged: []
  }

  for (const wt of worktrees) {
    const key = getGroupKey(wt, prStatuses[wt.path], mergedPaths?.[wt.path])
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
  mergedPaths?: Record<string, boolean>
): Worktree[] {
  return groupWorktrees(worktrees, prStatuses, mergedPaths).flatMap((g) => g.worktrees)
}

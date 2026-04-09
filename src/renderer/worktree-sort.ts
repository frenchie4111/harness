import type { Worktree, PRStatus } from './types'

export type GroupKey = 'needs-attention' | 'active' | 'no-pr' | 'merged'

export interface WorktreeGroup {
  key: GroupKey
  label: string
  worktrees: Worktree[]
}

export function getGroupKey(wt: Worktree, pr: PRStatus | null | undefined): GroupKey {
  if (!pr) return 'no-pr'
  if (pr.state === 'merged' || pr.state === 'closed') return 'merged'
  if (pr.checksOverall === 'failure') return 'needs-attention'
  return 'active'
}

export const GROUP_ORDER: GroupKey[] = ['needs-attention', 'active', 'no-pr', 'merged']

export const GROUP_LABELS: Record<GroupKey, string> = {
  'needs-attention': 'Needs Attention',
  active: 'Active PRs',
  'no-pr': 'No PR',
  merged: 'Merged / Closed'
}

/** Group worktrees by PR status, returning groups in display order */
export function groupWorktrees(
  worktrees: Worktree[],
  prStatuses: Record<string, PRStatus | null>
): WorktreeGroup[] {
  const grouped: Record<GroupKey, Worktree[]> = {
    'needs-attention': [],
    active: [],
    'no-pr': [],
    merged: []
  }

  for (const wt of worktrees) {
    const key = getGroupKey(wt, prStatuses[wt.path])
    grouped[key].push(wt)
  }

  return GROUP_ORDER
    .filter((key) => grouped[key].length > 0)
    .map((key) => ({ key, label: GROUP_LABELS[key], worktrees: grouped[key] }))
}

/** Flatten grouped worktrees into a single ordered list (matching sidebar display order) */
export function sortedWorktrees(
  worktrees: Worktree[],
  prStatuses: Record<string, PRStatus | null>
): Worktree[] {
  return groupWorktrees(worktrees, prStatuses).flatMap((g) => g.worktrees)
}

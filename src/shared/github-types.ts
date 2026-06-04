export interface PRSummary {
  number: number
  title: string
  author: { login: string; avatarUrl: string } | null
  baseBranch: string
  headBranch: string
  headSha: string
  /** Owner/repo of the head — same as base for in-repo PRs, fork's repo for fork PRs. */
  headRepoFullName: string | null
  /** True when head.repo.full_name !== base.repo.full_name. */
  isFork: boolean
  updatedAt: string
  url: string
  draft: boolean
  /** Users currently requested as reviewers (no review submitted yet). */
  requestedReviewers: { login: string; avatarUrl: string }[]
  /** Latest review per reviewer, deduped by login, most-recent state per user. */
  reviewerStates: {
    login: string
    avatarUrl: string
    state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED'
  }[]
  /** GitHub labels. Color is 6-char hex without '#'. */
  labels: { name: string; color: string }[]
  /** Overall check rollup. Undefined when we couldn't determine
   *  (no rollup data on the head commit yet). */
  checksOverall?: 'success' | 'failure' | 'pending' | 'none'
}

export type PRMetadata = PRSummary

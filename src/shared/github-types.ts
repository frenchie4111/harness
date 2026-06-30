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
  /** Open/closed/merged. Only populated by the single-PR lookup
   *  (getOpenPRByNumber); list/poller producers leave it undefined. */
  state?: 'open' | 'closed' | 'merged'
}

export type PRMetadata = PRSummary

/** Result of looking up a single PR by number for the add-worktree flow.
 *  Discriminated so the UI can distinguish a missing PR / missing token
 *  from a generic failure. Mirrors MergePRResult's shape. */
export type PRLookupResult =
  | { ok: true; pr: PRSummary }
  | { ok: false; reason: 'not-found' | 'no-token' | 'error'; message?: string }

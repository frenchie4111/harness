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

/** A review comment shuttled between the renderer and GitHub. lineNumber is
 *  the 1-based modified-side line; 0 means a file-level comment. remoteId is
 *  the GitHub review-comment id — present once the comment has been posted
 *  or fetched, absent for a local comment that still needs pushing. */
export interface ReviewSyncComment {
  filePath: string
  lineNumber: number
  body: string
  remoteId?: number
  author?: string
  authorAvatarUrl?: string
  /** ISO timestamp the comment was created (from GitHub). */
  createdAt?: string
  /** Link to the comment on GitHub. */
  htmlUrl?: string
  /** True for a comment on an unsubmitted (pending) review. */
  draft?: boolean
}

export interface ReviewSyncInput {
  comments: ReviewSyncComment[]
  reviewedFiles: string[]
  files: string[]
  /** Pull only — fetch PR comments without pushing local comments or viewed
   *  state. Used by the auto-sync on review open so it can't clobber GitHub
   *  state from an empty local review. */
  pullOnly?: boolean
}

export interface ReviewSyncResult {
  ok: boolean
  error?: string
  /** The reconciled comment set: everything now on the PR, plus any local
   *  comments that failed to post (so they're not lost). */
  comments: ReviewSyncComment[]
  reviewedFiles: string[]
  pushed: number
  failed: number
}

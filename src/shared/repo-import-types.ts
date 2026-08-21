/** Wire types for repo-scoped bulk import: adopting a repo's existing Claude
 *  Code history as Ness worktrees. Lives in shared/ because the renderer
 *  reads these and never imports from main/. */

/** One branch of a repo that has chat history on disk and could become a
 *  Ness worktree. */
export interface RepoImportCandidate {
  branch: string
  /** Sessions recorded against this branch, most recent first. */
  sessionIds: string[]
  sessionCount: number
  /** Most recent chat activity — the signal for "am I still working here". */
  latestActivityMs: number
  /** Tip commit date, or null when no local ref exists. */
  lastCommitMs: number | null
  /** Ancestor-of-base only, so it under-reports on squash/rebase merges.
   *  A badge, never a filter — see buildRepoImportPlan. */
  merged: boolean
  prNumber: number | null
  /** Best available chat title — reads as "what this branch was for". */
  latestTitle: string | null
  /** Whether Ness pre-checks this row. */
  recommended: boolean
}

export interface RepoImportPlan {
  repoRoot: string
  repoLabel: string
  candidates: RepoImportCandidate[]
  /** Chats whose branch no longer has a local ref, so they can't become a
   *  worktree. Surfaced as a count so the number never silently shrinks. */
  strandedSessionCount: number
  /** Branches Ness already has open as worktrees, so there is nothing to
   *  import. Counted rather than listed — see buildRepoImportPlan. */
  alreadyOpenCount: number
  totalSessionCount: number
  recommendedCount: number
}

/** How many chats to open as tabs in each newly created worktree. */
export type ChatDepth = 'latest' | 'all'

export interface RepoImportRequest {
  repoRoot: string
  branches: string[]
  chatDepth: ChatDepth
}

export interface RepoImportBranchResult {
  branch: string
  ok: boolean
  worktreePath: string | null
  importedChats: number
  error: string | null
}

export interface RepoImportResult {
  ok: boolean
  created: number
  importedChats: number
  branches: RepoImportBranchResult[]
}

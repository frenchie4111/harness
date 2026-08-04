// Slice for PRs assigned to the viewer as a requested reviewer, grouped by
// Harness repo root. Populated by PRPoller.refreshAssignedPRs when the
// `settings.showAssignedPRs` flag is on. The sidebar reads this slice and
// injects phantom entries into the Reviewing group, deduped against
// existing worktrees for the same PR.

export interface AssignedPR {
  /** PR number on the upstream repo (the one PRs are opened against). */
  number: number
  title: string
  url: string
  /** Head branch name — used to dedup against existing worktrees. */
  branch: string
  /** Repo root path from `worktrees.repoRoots` — this PR belongs to that
   *  repo's Harness entry. Used both as the dedup key and the "which
   *  bucket in split-by-repo view" key. */
  repoRoot: string
  /** owner/name of the upstream repo the PR was opened against.
   *  Displayed in tooltips and used to disambiguate when the same branch
   *  name exists in multiple repos. */
  repoNameWithOwner: string
  author: { login: string; avatarUrl?: string } | null
  isDraft: boolean
  updatedAt: string
}

export interface AssignedPRsState {
  /** repoRoot → PRs assigned to the viewer for that repo. */
  byRepo: Record<string, AssignedPR[]>
  loading: boolean
  /** Wall-clock time of the last successful refresh, or null if none yet. */
  lastFetchAt: number | null
}

export const initialAssignedPRs: AssignedPRsState = {
  byRepo: {},
  loading: false,
  lastFetchAt: null
}

export type AssignedPRsEvent =
  | { type: 'assignedPRs/loadingChanged'; payload: boolean }
  | { type: 'assignedPRs/dataUpdated'; payload: { byRepo: Record<string, AssignedPR[]>; fetchedAt: number } }
  | { type: 'assignedPRs/cleared' }

export function assignedPRsReducer(
  state: AssignedPRsState,
  event: AssignedPRsEvent
): AssignedPRsState {
  switch (event.type) {
    case 'assignedPRs/loadingChanged':
      if (state.loading === event.payload) return state
      return { ...state, loading: event.payload }
    case 'assignedPRs/dataUpdated':
      return {
        ...state,
        byRepo: event.payload.byRepo,
        lastFetchAt: event.payload.fetchedAt
      }
    case 'assignedPRs/cleared':
      if (
        Object.keys(state.byRepo).length === 0 &&
        state.lastFetchAt === null &&
        !state.loading
      ) {
        return state
      }
      return { byRepo: {}, loading: false, lastFetchAt: null }
    default: {
      const _exhaustive: never = event
      void _exhaustive
      return state
    }
  }
}

export interface CheckStatus {
  name: string
  state: 'success' | 'failure' | 'pending' | 'neutral' | 'skipped' | 'error'
  description: string
  /** Longer failure summary from the check's output (markdown, may be multi-line) */
  summary?: string
  /** External URL to the check's log / details page */
  detailsUrl?: string
}

export interface PRReview {
  user: string
  avatarUrl: string
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING'
  body: string
  submittedAt: string
  htmlUrl: string
}

export interface PRStatus {
  number: number
  title: string
  state: 'open' | 'draft' | 'merged' | 'closed'
  url: string
  branch: string
  checks: CheckStatus[]
  checksOverall: 'success' | 'failure' | 'pending' | 'none'
  /** true = has conflicts with base, false = mergeable, null = still computing */
  hasConflict: boolean | null
  reviews: PRReview[]
  reviewDecision: 'approved' | 'changes_requested' | 'review_required' | 'none'
  additions?: number
  deletions?: number
}

export interface PRsState {
  /** PR status per worktree path. null = "we looked and there's no PR yet". */
  byPath: Record<string, PRStatus | null>
  /** Locally-merged flag per worktree path. Replaced wholesale on poll. */
  mergedByPath: Record<string, boolean>
  /** True while a full refresh is in flight. */
  loading: boolean
}

export type PRsEvent =
  | { type: 'prs/statusChanged'; payload: { path: string; status: PRStatus | null } }
  | { type: 'prs/bulkStatusChanged'; payload: Record<string, PRStatus | null> }
  | { type: 'prs/mergedChanged'; payload: Record<string, boolean> }
  | { type: 'prs/loadingChanged'; payload: boolean }

export const initialPRs: PRsState = {
  byPath: {},
  mergedByPath: {},
  loading: false
}

export function prsReducer(state: PRsState, event: PRsEvent): PRsState {
  switch (event.type) {
    case 'prs/statusChanged':
      return {
        ...state,
        byPath: { ...state.byPath, [event.payload.path]: event.payload.status }
      }
    case 'prs/bulkStatusChanged':
      return { ...state, byPath: event.payload }
    case 'prs/mergedChanged':
      return { ...state, mergedByPath: event.payload }
    case 'prs/loadingChanged':
      return { ...state, loading: event.payload }
    default: {
      const _exhaustive: never = event
      void _exhaustive
      return state
    }
  }
}

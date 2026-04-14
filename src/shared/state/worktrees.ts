export interface Worktree {
  path: string
  branch: string
  head: string
  isBare: boolean
  isMain: boolean
  /** Directory birthtime in ms since epoch; 0 if unavailable. */
  createdAt: number
  /** Repo this worktree belongs to. Set after a cross-repo listWorktrees merge. */
  repoRoot: string
}

export type PendingStatus = 'creating' | 'setup' | 'setup-failed' | 'error'

export interface PendingWorktree {
  /** Prefixed id like `pending:<uuid>` so the renderer can use it as an
   * activeWorktreeId during the creating/setup screens. */
  id: string
  repoRoot: string
  branchName: string
  status: PendingStatus
  error?: string
  setupLog?: string
  setupExitCode?: number
  /** Real on-disk path once addWorktree resolves. Set before status
   * transitions to 'setup-failed' so the "Continue anyway" path knows
   * where to jump. Also included in the runPending IPC return value on
   * the success path. */
  createdPath?: string
}

export interface WorktreesState {
  /** Flat list of worktrees across every known repo. */
  list: Worktree[]
  repoRoots: string[]
  pending: PendingWorktree[]
}

export type WorktreesEvent =
  | { type: 'worktrees/listChanged'; payload: Worktree[] }
  | { type: 'worktrees/reposChanged'; payload: string[] }
  | { type: 'worktrees/pendingAdded'; payload: PendingWorktree }
  | {
      type: 'worktrees/pendingUpdated'
      payload: { id: string; patch: Partial<PendingWorktree> }
    }
  | { type: 'worktrees/pendingRemoved'; payload: string }

export const initialWorktrees: WorktreesState = {
  list: [],
  repoRoots: [],
  pending: []
}

export function worktreesReducer(
  state: WorktreesState,
  event: WorktreesEvent
): WorktreesState {
  switch (event.type) {
    case 'worktrees/listChanged':
      return { ...state, list: event.payload }
    case 'worktrees/reposChanged':
      return { ...state, repoRoots: event.payload }
    case 'worktrees/pendingAdded':
      return { ...state, pending: [...state.pending, event.payload] }
    case 'worktrees/pendingUpdated':
      return {
        ...state,
        pending: state.pending.map((p) =>
          p.id === event.payload.id ? { ...p, ...event.payload.patch } : p
        )
      }
    case 'worktrees/pendingRemoved':
      return { ...state, pending: state.pending.filter((p) => p.id !== event.payload) }
    default: {
      const _exhaustive: never = event
      void _exhaustive
      return state
    }
  }
}

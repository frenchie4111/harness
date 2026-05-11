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
  /** One-shot kickoff prompt for the new Claude tab. In-memory only —
   * stripped before persistence. */
  initialPrompt?: string
  /** One-shot teleport session id for the new Claude tab. In-memory only. */
  teleportSessionId?: string
}

export type PendingDeletionPhase =
  | 'running-teardown'
  | 'removing-worktree'
  | 'failed'

export interface PendingDeletion {
  /** The worktree path being deleted — used as the key. */
  path: string
  repoRoot: string
  branch: string
  phase: PendingDeletionPhase
  /** Accumulated teardown script output. Undefined when the repo has no
   * teardown command configured — the renderer uses that to hide the log
   * panel entirely. */
  teardownLog?: string
  /** Teardown script exit code once it has finished. */
  teardownExitCode?: number
  error?: string
}

export interface WorktreesState {
  /** Flat list of worktrees across every known repo. */
  list: Worktree[]
  repoRoots: string[]
  pending: PendingWorktree[]
  /** In-flight deletions, keyed by worktree path. Lives in the store so
   * the UI can animate + stream teardown output and the FSM keeps running
   * if the user navigates away. */
  pendingDeletions: PendingDeletion[]
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
  | { type: 'worktrees/pendingDeletionStarted'; payload: PendingDeletion }
  | {
      type: 'worktrees/pendingDeletionUpdated'
      payload: { path: string; patch: Partial<PendingDeletion> }
    }
  | { type: 'worktrees/pendingDeletionRemoved'; payload: string }

export const initialWorktrees: WorktreesState = {
  list: [],
  repoRoots: [],
  pending: [],
  pendingDeletions: []
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
    case 'worktrees/pendingUpdated': {
      const i = state.pending.findIndex((p) => p.id === event.payload.id)
      if (i === -1) return state
      const patched = { ...state.pending[i], ...event.payload.patch }
      return {
        ...state,
        pending: [
          ...state.pending.slice(0, i),
          patched,
          ...state.pending.slice(i + 1)
        ]
      }
    }
    case 'worktrees/pendingRemoved':
      return { ...state, pending: state.pending.filter((p) => p.id !== event.payload) }
    case 'worktrees/pendingDeletionStarted':
      return {
        ...state,
        pendingDeletions: [
          ...state.pendingDeletions.filter((d) => d.path !== event.payload.path),
          event.payload
        ]
      }
    case 'worktrees/pendingDeletionUpdated': {
      const i = state.pendingDeletions.findIndex(
        (d) => d.path === event.payload.path
      )
      if (i === -1) return state
      const patched = { ...state.pendingDeletions[i], ...event.payload.patch }
      return {
        ...state,
        pendingDeletions: [
          ...state.pendingDeletions.slice(0, i),
          patched,
          ...state.pendingDeletions.slice(i + 1)
        ]
      }
    }
    case 'worktrees/pendingDeletionRemoved':
      return {
        ...state,
        pendingDeletions: state.pendingDeletions.filter((d) => d.path !== event.payload)
      }
    default: {
      const _exhaustive: never = event
      void _exhaustive
      return state
    }
  }
}

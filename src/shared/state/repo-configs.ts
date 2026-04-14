export interface RepoConfig {
  version?: number
  setupCommand?: string
  teardownCommand?: string
  mergeStrategy?: 'squash' | 'merge-commit' | 'fast-forward'
  hideMergePanel?: boolean
  hidePrPanel?: boolean
}

export interface RepoConfigsState {
  /** Per-repo config keyed by repoRoot. Hydrated at boot from each repo's
   * .harness.json file and updated whenever a setRepoConfig call commits. */
  byRepo: Record<string, RepoConfig>
}

export type RepoConfigsEvent =
  | { type: 'repoConfigs/loaded'; payload: Record<string, RepoConfig> }
  | { type: 'repoConfigs/changed'; payload: { repoRoot: string; config: RepoConfig } }
  | { type: 'repoConfigs/removed'; payload: string }

export const initialRepoConfigs: RepoConfigsState = {
  byRepo: {}
}

export function repoConfigsReducer(
  state: RepoConfigsState,
  event: RepoConfigsEvent
): RepoConfigsState {
  switch (event.type) {
    case 'repoConfigs/loaded':
      return { ...state, byRepo: event.payload }
    case 'repoConfigs/changed':
      return {
        ...state,
        byRepo: { ...state.byRepo, [event.payload.repoRoot]: event.payload.config }
      }
    case 'repoConfigs/removed': {
      if (!(event.payload in state.byRepo)) return state
      const { [event.payload]: _dropped, ...rest } = state.byRepo
      void _dropped
      return { ...state, byRepo: rest }
    }
    default: {
      const _exhaustive: never = event
      void _exhaustive
      return state
    }
  }
}

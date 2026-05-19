import type { Store } from './store'
import type { Config } from './persistence'
import { saveConfig } from './persistence'
import { loadRepoConfig } from './repo-config'
import type { WorktreesFSM } from './worktrees-fsm'

interface RegisterRepoDeps {
  config: Config
  store: Store
  worktreesFSM: WorktreesFSM
}

/** Append a repo root to the app config, persist, and emit the store
 *  events sidebar / PR poller / repo-configs slice listen for.
 *  Idempotent — returns false if `repoRoot` was already registered, so
 *  callers can skip post-add work (focusing, refreshing) accordingly. */
export function registerRepoRoot(
  repoRoot: string,
  deps: RegisterRepoDeps
): boolean {
  if (deps.config.repoRoots.includes(repoRoot)) return false
  deps.config.repoRoots.push(repoRoot)
  saveConfig(deps.config)
  deps.worktreesFSM.dispatchRepos([...deps.config.repoRoots])
  deps.store.dispatch({
    type: 'repoConfigs/changed',
    payload: { repoRoot, config: loadRepoConfig(repoRoot) }
  })
  return true
}

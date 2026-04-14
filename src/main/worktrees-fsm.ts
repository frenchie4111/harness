import {
  addWorktree,
  defaultWorktreeDir,
  listWorktrees,
  runWorktreeScript
} from './worktree'
import { loadRepoConfig } from './repo-config'
import { log } from './debug'
import type { Store } from './store'
import type { Worktree, PendingWorktree } from '../shared/state/worktrees'

export type PendingOutcome =
  | { id: string; outcome: 'success'; createdPath: string }
  | { id: string; outcome: 'setup-failed'; createdPath: string }
  | { id: string; outcome: 'error'; error: string }

interface WorktreesFSMOptions {
  getRepoRoots: () => string[]
  getWorktreeSetupCmd: () => string
  getWorktreeBaseMode: () => 'remote' | 'local'
  onWorktreeCreated: () => void
}

/** Owns the pending-creation state machine plus the "refresh the flat
 * worktree list across every known repo" operation. All writes go through
 * the Store. Designed so the renderer awaits `runPending(…)` end-to-end;
 * in-progress status transitions are visible via the usual state events. */
export class WorktreesFSM {
  private store: Store
  private opts: WorktreesFSMOptions

  constructor(store: Store, opts: WorktreesFSMOptions) {
    this.store = store
    this.opts = opts
  }

  /** Walk all known repos, list worktrees, flatten, and dispatch
   * worktrees/listChanged. Safe to call repeatedly. */
  async refreshList(): Promise<Worktree[]> {
    const roots = this.opts.getRepoRoots()
    const results = await Promise.all(
      roots.map((r) =>
        listWorktrees(r).catch((err) => {
          log('worktrees-fsm', `listWorktrees failed for ${r}`, err instanceof Error ? err.message : err)
          return [] as Worktree[]
        })
      )
    )
    const flat = results.flat()
    this.store.dispatch({ type: 'worktrees/listChanged', payload: flat })
    return flat
  }

  dispatchRepos(roots: string[]): void {
    this.store.dispatch({ type: 'worktrees/reposChanged', payload: roots })
  }

  /** Drive the creation FSM to completion. Dispatches state transitions as
   * it goes so the pending screens stay live, and resolves with a terminal
   * outcome that the renderer uses to route focus + stage initial prompts. */
  async runPending(params: {
    id: string
    repoRoot: string
    branchName: string
  }): Promise<PendingOutcome> {
    const { id, repoRoot, branchName } = params
    const pending: PendingWorktree = {
      id,
      repoRoot,
      branchName,
      status: 'creating'
    }
    this.store.dispatch({ type: 'worktrees/pendingAdded', payload: pending })

    try {
      const wtDir = defaultWorktreeDir(repoRoot)
      const mode = this.opts.getWorktreeBaseMode()
      const created = await addWorktree(repoRoot, wtDir, branchName, {
        fetchRemote: mode === 'remote'
      })

      const repoCfg = loadRepoConfig(repoRoot)
      const setupCmd = repoCfg.setupCommand || this.opts.getWorktreeSetupCmd() || ''
      let setupFailed = false
      if (setupCmd) {
        this.store.dispatch({
          type: 'worktrees/pendingUpdated',
          payload: { id, patch: { status: 'setup', setupLog: '' } }
        })
        let buffered = ''
        const result = await runWorktreeScript(
          'setup',
          setupCmd,
          { worktreePath: created.path, branch: created.branch, repoRoot },
          (_stream, chunk) => {
            buffered += chunk
            this.store.dispatch({
              type: 'worktrees/pendingUpdated',
              payload: { id, patch: { setupLog: buffered } }
            })
          }
        )
        setupFailed = !result.ok
        this.store.dispatch({
          type: 'worktrees/pendingUpdated',
          payload: { id, patch: { setupExitCode: result.exitCode } }
        })
      }

      // Worktree exists on disk regardless of script outcome — pick it up.
      this.opts.onWorktreeCreated()
      await this.refreshList()

      if (setupFailed) {
        this.store.dispatch({
          type: 'worktrees/pendingUpdated',
          payload: { id, patch: { status: 'setup-failed', createdPath: created.path } }
        })
        return { id, outcome: 'setup-failed', createdPath: created.path }
      }

      this.store.dispatch({ type: 'worktrees/pendingRemoved', payload: id })
      return { id, outcome: 'success', createdPath: created.path }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.store.dispatch({
        type: 'worktrees/pendingUpdated',
        payload: { id, patch: { status: 'error', error: message } }
      })
      return { id, outcome: 'error', error: message }
    }
  }

  async retryPending(id: string): Promise<PendingOutcome> {
    const current = this.store
      .getSnapshot()
      .state.worktrees.pending.find((p) => p.id === id)
    if (!current) {
      return { id, outcome: 'error', error: 'Pending entry not found' }
    }
    // Clear the terminal-state flags so status transitions look right.
    this.store.dispatch({
      type: 'worktrees/pendingUpdated',
      payload: {
        id,
        patch: { status: 'creating', error: undefined, setupLog: undefined, setupExitCode: undefined, createdPath: undefined }
      }
    })
    // Re-run. Note: if the worktree was already created on disk the first
    // time, addWorktree will error — the user should dismiss+recreate in
    // that case. We preserve the existing behavior (retry was already
    // fragile in the old renderer code).
    return this.runPending({
      id,
      repoRoot: current.repoRoot,
      branchName: current.branchName
    })
  }

  dismissPending(id: string): void {
    this.store.dispatch({ type: 'worktrees/pendingRemoved', payload: id })
  }
}

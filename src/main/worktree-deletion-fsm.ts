import { removeWorktree, runWorktreeScript } from './worktree'
import { loadRepoConfig } from './repo-config'
import { log } from './debug'
import type { Store } from './store'
import type { WorktreesFSM } from './worktrees-fsm'
import type { PendingDeletion } from '../shared/state/worktrees'

interface WorktreeDeletionFSMOptions {
  getGlobalTeardownCmd: () => string
  worktreesFSM: WorktreesFSM
}

/** Owns the pending-deletion state machine. Each enqueue runs independently
 * (parallel deletions are fine — they touch disjoint paths), streams
 * teardown script output into the store, and refreshes the worktree list
 * on completion. Lives entirely in main so deletions keep running if the
 * user navigates away; the renderer just reads state. */
export class WorktreeDeletionFSM {
  private store: Store
  private opts: WorktreeDeletionFSMOptions

  constructor(store: Store, opts: WorktreeDeletionFSMOptions) {
    this.store = store
    this.opts = opts
  }

  /** Kick off a deletion. Returns immediately after seeding the pending
   * entry; the actual work runs in the background. */
  enqueue(params: {
    repoRoot: string
    path: string
    branch: string
    force?: boolean
  }): void {
    void this.run(params)
  }

  dismiss(path: string): void {
    this.store.dispatch({ type: 'worktrees/pendingDeletionRemoved', payload: path })
  }

  private async run(params: {
    repoRoot: string
    path: string
    branch: string
    force?: boolean
  }): Promise<void> {
    const { repoRoot, path, branch, force } = params
    const repoCfg = loadRepoConfig(repoRoot)
    const teardownCmd = repoCfg.teardownCommand || this.opts.getGlobalTeardownCmd() || ''
    const hasTeardown = Boolean(teardownCmd.trim())

    const initial: PendingDeletion = {
      path,
      repoRoot,
      branch,
      phase: hasTeardown ? 'running-teardown' : 'removing-worktree',
      teardownLog: hasTeardown ? '' : undefined
    }
    this.store.dispatch({ type: 'worktrees/pendingDeletionStarted', payload: initial })

    try {
      if (hasTeardown) {
        let buffered = ''
        const result = await runWorktreeScript(
          'teardown',
          teardownCmd,
          { worktreePath: path, branch, repoRoot },
          (_stream, chunk) => {
            buffered += chunk
            this.store.dispatch({
              type: 'worktrees/pendingDeletionUpdated',
              payload: { path, patch: { teardownLog: buffered } }
            })
          }
        )
        this.store.dispatch({
          type: 'worktrees/pendingDeletionUpdated',
          payload: { path, patch: { teardownExitCode: result.exitCode } }
        })
        // Teardown failure is non-fatal — we still want to remove the
        // worktree, matching the previous synchronous behavior.
      }

      this.store.dispatch({
        type: 'worktrees/pendingDeletionUpdated',
        payload: { path, patch: { phase: 'removing-worktree' } }
      })
      await removeWorktree(repoRoot, path, force)

      // Clear the pending entry and refresh the list so the sidebar row
      // disappears in one render.
      this.store.dispatch({ type: 'worktrees/pendingDeletionRemoved', payload: path })
      await this.opts.worktreesFSM.refreshList()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log('worktree-deletion-fsm', `deletion failed for ${path}: ${message}`)
      this.store.dispatch({
        type: 'worktrees/pendingDeletionUpdated',
        payload: { path, patch: { phase: 'failed', error: message } }
      })
    }
  }
}

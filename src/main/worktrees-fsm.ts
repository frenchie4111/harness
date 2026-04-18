import {
  addWorktree,
  defaultWorktreeDir,
  listWorktrees,
  runWorktreeScript,
  symlinkClaudeSettings
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
  /** Called after a worktree has been created on disk (and its setup
   * script has run, regardless of script outcome). The host wires this
   * to (a) PR poller refresh and (b) PanesFSM.ensureInitialized so the
   * default Claude+Shell pair is created with the initial prompt. */
  onWorktreeCreated: (params: {
    createdPath: string
    initialPrompt?: string
    teleportSessionId?: string
  }) => void
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
   * outcome that the renderer uses to route focus. The initialPrompt /
   * teleportSessionId are carried through to onWorktreeCreated so the
   * panes layer can embed them in the new Claude tab — the renderer
   * never has to stage them locally. */
  async runPending(params: {
    id: string
    repoRoot: string
    branchName: string
    initialPrompt?: string
    teleportSessionId?: string
  }): Promise<PendingOutcome> {
    const { id, repoRoot, branchName, initialPrompt, teleportSessionId } = params
    const pending: PendingWorktree = {
      id,
      repoRoot,
      branchName,
      status: 'creating',
      initialPrompt,
      teleportSessionId
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

      // Share .claude/settings.local.json with the main worktree so
      // "Don't ask again" permissions granted in any worktree apply to
      // all of them. Best-effort — log and continue on failure.
      const snapshot = this.store.getSnapshot().state
      if (snapshot.settings.shareClaudeSettings) {
        try {
          const mainWt = snapshot.worktrees.list.find(
            (w) => w.repoRoot === repoRoot && w.isMain
          )
          if (mainWt && mainWt.path !== created.path) {
            symlinkClaudeSettings(mainWt.path, created.path)
          }
        } catch (err) {
          log('hooks', `symlinkClaudeSettings failed for ${created.path}`, err instanceof Error ? err.message : err)
        }
      }

      // Worktree exists on disk regardless of script outcome. Pick it up,
      // refresh the worktree list, and seed its default panes.
      this.opts.onWorktreeCreated({
        createdPath: created.path,
        initialPrompt,
        teleportSessionId
      })
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
      branchName: current.branchName,
      initialPrompt: current.initialPrompt,
      teleportSessionId: current.teleportSessionId
    })
  }

  dismissPending(id: string): void {
    this.store.dispatch({ type: 'worktrees/pendingRemoved', payload: id })
  }
}

import {
  addWorktree,
  defaultWorktreeDir,
  fetchPullRequestRef,
  listWorktrees,
  localBranchExists,
  runWorktreeScript,
  symlinkClaudeSettings,
  type WorktreeInfo
} from './worktree'
import { getPRMetadata } from './github'
import { loadRepoConfig } from './repo-config'
import { log } from './debug'
import type { Store } from './store'
import type { Worktree, PendingWorktree } from '../shared/state/worktrees'

/** Sanitize a PR's head branch into a name that's safe as both a git
 *  branch (we're not strict here since git accepts most things) and a
 *  filesystem path component. Slashes survive — git accepts them and
 *  `git worktree add` is happy to nest dirs the same way fresh-start
 *  worktrees do for branches like `feature/foo`. */
export function sanitizeHeadBranchForLocal(headBranch: string): string {
  const cleaned = headBranch
    .replace(/[~^:?*\[\]\\\x00-\x1f\x7f]/g, '')
    .replace(/\.{2,}/g, '.')
    .replace(/@\{/g, '')
    .replace(/^[-.]+|[-.]+$/g, '')
  return cleaned
}

/** Pick a local branch name for a PR's head. Prefers the upstream head
 *  ref directly so the PR poller's ref-match logic just works; falls
 *  back to a `<head>-pr-<N>` suffix when a local branch with that name
 *  already exists (e.g. the user has their own work on that ref). */
export async function chooseLocalPRBranchName(
  repoRoot: string,
  headBranch: string,
  prNumber: number
): Promise<string> {
  const sanitized = sanitizeHeadBranchForLocal(headBranch)
  const candidate = sanitized || `pr-${prNumber}`
  if (await localBranchExists(repoRoot, candidate)) {
    return `${candidate}-pr-${prNumber}`
  }
  return candidate
}

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
      return await this.finishCreate({
        id,
        repoRoot,
        created,
        initialPrompt,
        teleportSessionId
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.store.dispatch({
        type: 'worktrees/pendingUpdated',
        payload: { id, patch: { status: 'error', error: message } }
      })
      return { id, outcome: 'error', error: message }
    }
  }

  /** Open someone else's PR as a worktree. Fetches the PR head into a
   * local branch named after the PR's actual head ref (or `<head>-pr-<N>`
   * if that name is taken locally), so the PR poller's ref-match logic
   * just works — no per-worktree marker needed. */
  async runPendingPR(params: {
    id: string
    repoRoot: string
    prNumber: number
  }): Promise<PendingOutcome> {
    const { id, repoRoot, prNumber } = params
    // Show *something* while we go ask GitHub for the head ref name.
    let branchName = `pr-${prNumber}`
    const pending: PendingWorktree = {
      id,
      repoRoot,
      branchName,
      status: 'creating'
    }
    this.store.dispatch({ type: 'worktrees/pendingAdded', payload: pending })

    try {
      const meta = await getPRMetadata(repoRoot, prNumber)
      if (!meta) throw new Error(`Couldn't fetch PR #${prNumber} from GitHub`)

      branchName = await chooseLocalPRBranchName(repoRoot, meta.headBranch, prNumber)
      if (branchName !== pending.branchName) {
        this.store.dispatch({
          type: 'worktrees/pendingUpdated',
          payload: { id, patch: { branchName } }
        })
      }

      await fetchPullRequestRef(repoRoot, prNumber, branchName)

      const wtDir = defaultWorktreeDir(repoRoot)
      const created = await addWorktree(repoRoot, wtDir, branchName, {
        checkoutExisting: true
      })

      return await this.finishCreate({
        id,
        repoRoot,
        created
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.store.dispatch({
        type: 'worktrees/pendingUpdated',
        payload: { id, patch: { status: 'error', error: message } }
      })
      return { id, outcome: 'error', error: message }
    }
  }

  /** Shared post-creation steps: setup script + .claude symlink +
   * onWorktreeCreated callback + refreshList + final pending outcome. */
  private async finishCreate(args: {
    id: string
    repoRoot: string
    created: WorktreeInfo
    initialPrompt?: string
    teleportSessionId?: string
  }): Promise<PendingOutcome> {
    const { id, repoRoot, created, initialPrompt, teleportSessionId } = args

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
  }

  /** Run the setup script for a worktree that was created outside the FSM
   * (e.g. via the MCP create_worktree tool). No-op if no script is configured. */
  async runWorktreeSetup(ctx: { repoRoot: string; worktreePath: string; branch: string }): Promise<void> {
    const repoCfg = loadRepoConfig(ctx.repoRoot)
    const setupCmd = repoCfg.setupCommand || this.opts.getWorktreeSetupCmd() || ''
    if (!setupCmd) return
    await runWorktreeScript('setup', setupCmd, {
      worktreePath: ctx.worktreePath,
      branch: ctx.branch,
      repoRoot: ctx.repoRoot
    })
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

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
import {
  mergeWorktreesPreservingFailures,
  worktreeListsEqual,
  type Worktree,
  type PendingWorktree
} from '../shared/state/worktrees'

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
    agentKind?: 'claude' | 'codex'
    model?: string
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
   * worktrees/listChanged. Safe to call repeatedly. A repo whose lookup
   * throws (transient FS error, network drive glitch) preserves its
   * previously-known worktrees so the UI doesn't flicker — successful
   * results still replace their repo's slice, so deletions propagate. */
  async refreshList(): Promise<Worktree[]> {
    const roots = this.opts.getRepoRoots()
    const perRoot = await Promise.all(
      roots.map((r) =>
        listWorktrees(r).catch((err) => {
          log('worktrees-fsm', `listWorktrees failed for ${r}`, err instanceof Error ? err.message : err)
          return null
        })
      )
    )
    const previous = this.store.getSnapshot().state.worktrees.list
    const flat = mergeWorktreesPreservingFailures(roots, perRoot, previous)
    this.applyList(flat)
    return flat
  }

  /** Replace the flat worktree list, but only dispatch when it actually
   * differs from what's in the store. Lets the PR poller and the branch
   * watcher re-derive branch labels on a tick / fs event without churning
   * the array reference (and re-rendering the world) when nothing moved.
   * Returns whether a dispatch was emitted. */
  applyList(flat: Worktree[]): boolean {
    const current = this.store.getSnapshot().state.worktrees.list
    if (worktreeListsEqual(current, flat)) return false
    this.store.dispatch({ type: 'worktrees/listChanged', payload: flat })
    return true
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
    agentKind?: 'claude' | 'codex'
    model?: string
    /** When set, check out an existing branch instead of creating one
     * with `-b`. Used when the user picks from the existing-branches
     * dropdown — git resolves names like `origin/foo` to a local
     * tracking branch correctly, whereas `-b origin/foo` would create
     * a literally-named local branch. */
    checkoutExisting?: boolean
    /** When set (the "Any Git Ref" tab), the new branch `branchName` is
     * forked from this ref via `git worktree add -b <branchName> <baseRef>`
     * instead of from the repo's default base. */
    baseRef?: string
  }): Promise<PendingOutcome> {
    const { id, repoRoot, branchName, initialPrompt, teleportSessionId, agentKind, model, checkoutExisting, baseRef } = params
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
        // An explicit baseRef (Ref tab) wins over default-base resolution,
        // so skip the remote fetch when one is supplied.
        fetchRemote: mode === 'remote' && !baseRef,
        checkoutExisting,
        baseBranch: baseRef
      })
      return await this.finishCreate({
        id,
        repoRoot,
        created,
        initialPrompt,
        teleportSessionId,
        agentKind,
        model
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
    initialPrompt?: string
    agentKind?: 'claude' | 'codex'
    model?: string
  }): Promise<PendingOutcome> {
    const { id, repoRoot, prNumber, initialPrompt, agentKind, model } = params
    // Show *something* while we go ask GitHub for the head ref name.
    let branchName = `pr-${prNumber}`
    const pending: PendingWorktree = {
      id,
      repoRoot,
      branchName,
      status: 'creating',
      initialPrompt
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
        created,
        initialPrompt,
        agentKind,
        model
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
    agentKind?: 'claude' | 'codex'
    model?: string
  }): Promise<PendingOutcome> {
    const { id, repoRoot, created, initialPrompt, teleportSessionId, agentKind, model } = args

    const setupCmd = this.resolveSetupCmd(repoRoot)
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

    this.applySharedClaudeSettings(repoRoot, created.path)

    this.opts.onWorktreeCreated({
      createdPath: created.path,
      initialPrompt,
      teleportSessionId,
      agentKind,
      model
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

  /** Post-creation work for externally-created worktrees (e.g. the MCP
   * create_worktree tool): symlink shared Claude settings synchronously,
   * then run the setup script. The symlink runs before the first await
   * so callers can fire-and-forget and still rely on it being in place
   * before they spawn the Claude tab. */
  async runWorktreeSetup(ctx: { repoRoot: string; worktreePath: string; branch: string }): Promise<void> {
    this.applySharedClaudeSettings(ctx.repoRoot, ctx.worktreePath)
    const setupCmd = this.resolveSetupCmd(ctx.repoRoot)
    if (!setupCmd) return
    await runWorktreeScript('setup', setupCmd, {
      worktreePath: ctx.worktreePath,
      branch: ctx.branch,
      repoRoot: ctx.repoRoot
    })
  }

  /** Symlink the new worktree's .claude/settings.local.json to main's copy
   * when `shareClaudeSettings` is enabled. Synchronous — callers should
   * invoke this BEFORE spawning the Claude tab so it sees shared settings
   * from its first read. */
  applySharedClaudeSettings(repoRoot: string, worktreePath: string): void {
    const snapshot = this.store.getSnapshot().state
    if (!snapshot.settings.shareClaudeSettings) return
    try {
      const mainWt = snapshot.worktrees.list.find(
        (w) => w.repoRoot === repoRoot && w.isMain
      )
      if (mainWt && mainWt.path !== worktreePath) {
        symlinkClaudeSettings(mainWt.path, worktreePath)
      }
    } catch (err) {
      log('hooks', `symlinkClaudeSettings failed for ${worktreePath}`, err instanceof Error ? err.message : err)
    }
  }

  private resolveSetupCmd(repoRoot: string): string {
    const repoCfg = loadRepoConfig(repoRoot)
    return repoCfg.setupCommand || this.opts.getWorktreeSetupCmd() || ''
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

import { listWorktrees, getBranchSha } from './worktree'
import { isOnRealBranch } from './git-ops-state'
import {
  getRepoContext,
  fetchPRStatusesForRepo,
  fetchPRStatusByNumber,
  type PRStatusRequest,
  type RepoContext
} from './github'
import { log, formatErr } from './debug'
import type { Store } from './store'
import type { PRStatus } from '../shared/state/prs'

const POLL_INTERVAL_MS = 5 * 60 * 1000
const STALE_WINDOW_MS = 60 * 1000

interface PRPollerOptions {
  getRepoRoots: () => string[]
  /** Current persisted "locallyMerged" map (branch → SHA at merge time). */
  getLocallyMerged: () => Record<string, string>
  /** Called with a pruned map whenever stale entries are detected, so the
   * caller can persist the change. */
  setLocallyMerged: (next: Record<string, string>) => void
}

/** Owns background PR-status polling and on-demand refresh. All writes go
 * through the Store; consumers subscribe via the state event stream. */
export class PRPoller {
  private store: Store
  private opts: PRPollerOptions
  private timer: NodeJS.Timeout | null = null
  private lastAllFetchAt = 0
  private lastFetchAtByPath = new Map<string, number>()
  private inFlightAll = false

  constructor(store: Store, opts: PRPollerOptions) {
    this.store = store
    this.opts = opts
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.refreshAll()
    }, POLL_INTERVAL_MS)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** Refresh every worktree across every known repo root.
   *
   * One batched GraphQL call per repo: aliased `pullRequests(headRefName)`
   * sub-queries find each worktree's PR by branch — no 100-most-recent
   * limit, and stale long-lived branches show up correctly.
   *
   * Network-failure handling: per-repo fetches are tagged ok/failed. The
   * new `byPath` map starts from the current snapshot (restricted to
   * worktrees that still exist), then successful results overlay. Failed
   * fetches preserve the previously-cached status — so a wifi blip
   * doesn't flip every worktree into the "no PR" sidebar group. */
  async refreshAll(): Promise<void> {
    if (this.inFlightAll) return
    const roots = this.opts.getRepoRoots()
    if (roots.length === 0) return
    this.inFlightAll = true
    this.store.dispatch({ type: 'prs/loadingChanged', payload: true })
    try {
      const treesByRoot = await Promise.all(
        roots.map((r) => listWorktrees(r).catch(() => []))
      )
      const allWorktrees = treesByRoot.flat()
      const now = Date.now()
      this.lastAllFetchAt = now
      for (const wt of allWorktrees) this.lastFetchAtByPath.set(wt.path, now)

      // Per-repo: resolve origin/upstream context, then make one GraphQL
      // call carrying every worktree's branch. ok=false means a transport
      // failure — every worktree in that repo will preserve its cached
      // status.
      type RepoBatch =
        | { root: string; ok: true; statuses: Map<string, PRStatus | null> }
        | { root: string; ok: false }
      const repoBatches: RepoBatch[] = await Promise.all(
        roots.map(async (root, idx): Promise<RepoBatch> => {
          const wts = treesByRoot[idx]
          try {
            const ctx = await getRepoContext(root)
            if (!ctx) {
              const empty = new Map<string, PRStatus | null>()
              for (const wt of wts) empty.set(wt.path, null)
              return { root, ok: true, statuses: empty }
            }
            const requests: PRStatusRequest[] = wts.map((wt) => ({
              worktreePath: wt.path,
              branch: wt.branch,
              headSha: wt.head
            }))
            const statuses = await fetchPRStatusesForRepo(ctx, requests)
            return { root, ok: true, statuses }
          } catch (err) {
            log('pr-poller', `PR batch failed for ${root}`, formatErr(err))
            return { root, ok: false }
          }
        })
      )

      const currentByPath = this.store.getSnapshot().state.prs.byPath
      const allowedPaths = new Set(allWorktrees.map((wt) => wt.path))
      const newByPath: Record<string, PRStatus | null> = {}
      for (const path of Object.keys(currentByPath)) {
        if (allowedPaths.has(path)) newByPath[path] = currentByPath[path]
      }
      for (const batch of repoBatches) {
        if (!batch.ok) continue
        for (const [path, status] of batch.statuses) {
          newByPath[path] = status
        }
      }

      // Branch-name lookup goes blind on a PR whose head branch was
      // deleted post-merge: the per-branch GraphQL hit returns nothing
      // and the worktree would slide into "Active". Look those up by
      // their previously-known PR number so the terminal state sticks.
      type Followup = { path: string; root: string; branch: string; prNumber: number }
      const followups: Followup[] = []
      for (const wt of allWorktrees) {
        const prev = currentByPath[wt.path]
        const next = newByPath[wt.path]
        if (
          prev &&
          next === null &&
          prev.state !== 'merged' &&
          prev.state !== 'closed'
        ) {
          followups.push({
            path: wt.path,
            root: wt.repoRoot,
            branch: wt.branch,
            prNumber: prev.number
          })
        }
      }
      if (followups.length > 0) {
        const ctxByRoot = new Map<string, RepoContext | null>()
        await Promise.all(
          Array.from(new Set(followups.map((f) => f.root))).map(async (root) => {
            ctxByRoot.set(root, await getRepoContext(root).catch(() => null))
          })
        )
        const followupResults = await Promise.all(
          followups.map(async (f) => {
            const ctx = ctxByRoot.get(f.root)
            if (!ctx) return { path: f.path, status: null as PRStatus | null }
            try {
              const status = await fetchPRStatusByNumber(ctx, f.prNumber, f.path, f.branch)
              return { path: f.path, status }
            } catch (err) {
              log('pr-poller', `followup PR #${f.prNumber} failed for ${f.path}`, formatErr(err))
              return { path: f.path, status: null }
            }
          })
        )
        for (const r of followupResults) {
          if (r.status && (r.status.state === 'merged' || r.status.state === 'closed')) {
            newByPath[r.path] = r.status
          }
        }
      }
      this.store.dispatch({
        type: 'prs/bulkStatusChanged',
        payload: newByPath
      })

      // Merged status per repo, then flatten. Stale branches get pruned from
      // the persisted locallyMerged map. Two passes: collect the worktrees
      // that need a `git rev-parse` lookup, fire them all in parallel, then
      // walk results. The serial-await version stalled boot by ~30ms × N at
      // typical worktree counts.
      const persisted = { ...this.opts.getLocallyMerged() }
      const mergedAll: Record<string, boolean> = {}
      let prunedAny = false
      type ShaJob = { root: string; path: string; branch: string; recordedSha: string }
      const shaJobs: ShaJob[] = []
      for (let i = 0; i < roots.length; i++) {
        const root = roots[i]
        const trees = treesByRoot[i]
        for (const wt of trees) {
          if (wt.isMain) continue
          if (!isOnRealBranch(wt.branch)) continue
          const recordedSha = persisted[wt.branch]
          if (!recordedSha) {
            mergedAll[wt.path] = false
            continue
          }
          shaJobs.push({ root, path: wt.path, branch: wt.branch, recordedSha })
        }
      }
      const shaResults = await Promise.all(
        shaJobs.map((j) => getBranchSha(j.root, j.branch).catch(() => null))
      )
      for (let k = 0; k < shaJobs.length; k++) {
        const job = shaJobs[k]
        const branchSha = shaResults[k]
        if (branchSha && branchSha === job.recordedSha) {
          mergedAll[job.path] = true
        } else {
          delete persisted[job.branch]
          prunedAny = true
          mergedAll[job.path] = false
        }
      }
      if (prunedAny) this.opts.setLocallyMerged(persisted)
      this.store.dispatch({ type: 'prs/mergedChanged', payload: mergedAll })
    } finally {
      this.inFlightAll = false
      this.store.dispatch({ type: 'prs/loadingChanged', payload: false })
    }
  }

  /** Refresh a single worktree's PR status. Used when a Claude terminal
   * reaches the "waiting" state (likely just pushed) or when the user
   * activates a stale worktree.
   *
   * One GraphQL call against the worktree's branch — no list-then-match. */
  async refreshOne(wtPath: string): Promise<void> {
    try {
      const wt = this.store
        .getSnapshot()
        .state.worktrees.list.find((w) => w.path === wtPath)
      if (!wt) return
      const ctx = await getRepoContext(wt.repoRoot)
      let status: PRStatus | null = null
      if (ctx) {
        const statuses = await fetchPRStatusesForRepo(ctx, [
          { worktreePath: wt.path, branch: wt.branch, headSha: wt.head }
        ])
        status = statuses.get(wt.path) ?? null
        if (!status) {
          const prev = this.store.getSnapshot().state.prs.byPath[wtPath]
          if (prev && prev.state !== 'merged' && prev.state !== 'closed') {
            const followup = await fetchPRStatusByNumber(ctx, prev.number, wt.path, wt.branch).catch(() => null)
            if (followup && (followup.state === 'merged' || followup.state === 'closed')) {
              status = followup
            }
          }
        }
      }
      this.lastFetchAtByPath.set(wtPath, Date.now())
      this.store.dispatch({
        type: 'prs/statusChanged',
        payload: { path: wtPath, status }
      })
    } catch (err) {
      log('pr-poller', `refreshOne failed for ${wtPath}`, formatErr(err))
    }
  }

  refreshOneIfStale(wtPath: string): void {
    const last = this.lastFetchAtByPath.get(wtPath) ?? 0
    if (Date.now() - last > STALE_WINDOW_MS) {
      void this.refreshOne(wtPath)
    }
  }

  /** Refresh all only if the last full refresh was more than STALE_WINDOW_MS
   * ago. Used on window focus so rapid alt-tabbing doesn't hammer GitHub. */
  refreshAllIfStale(): void {
    if (Date.now() - this.lastAllFetchAt > STALE_WINDOW_MS) {
      void this.refreshAll()
    }
  }
}

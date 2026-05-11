import { listWorktrees, getBranchSha } from './worktree'
import {
  getRepoInfo,
  listPullRequests,
  loadPRStatusForItem,
  type PRListItem
} from './github'
import { log } from './debug'
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

interface WorktreeForMatch {
  path: string
  branch: string
  /** Current HEAD SHA — used as the disambiguator for fork PRs where
   *  multiple PRs could share the same `head.ref`. */
  head: string
}

/** Pick the best PR for a worktree from a list. Prefers SHA match
 *  (handles forks; survives renames), then falls back to (head.ref +
 *  same-repo head). Returns null if nothing matches. */
export function pickPRForWorktree(
  wt: WorktreeForMatch,
  prs: PRListItem[],
  baseRepoFullName: string
): PRListItem | null {
  if (!prs.length) return null
  // SHA match is the strongest signal — distinguishes between same-named
  // branches on different forks, and survives the "user named their own
  // branch the same as a PR head" case.
  if (wt.head) {
    for (const pr of prs) {
      if (pr.headSha && pr.headSha === wt.head) return pr
    }
  }
  // Fall back to ref+repo match. Restricted to same-repo PRs because a
  // fork PR's head.ref alone could collide (two forkers both having
  // `feature/foo`); SHA above already covered the fork case.
  if (wt.branch) {
    for (const pr of prs) {
      if (
        pr.headRef === wt.branch &&
        pr.headRepoFullName === baseRepoFullName
      ) {
        return pr
      }
    }
  }
  return null
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

  /** Refresh every worktree across every known repo root. Bulk-replaces
   * `prs.byPath` and `prs.mergedByPath`.
   *
   * One `listPullRequests` call per repo instead of one
   * `pulls?head=…` call per worktree — fewer round-trips when worktrees
   * outnumber PRs, and fork PRs become naturally findable because each
   * list item carries `head.repo.full_name`. */
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

      // Per-repo: fetch the PR list + the base repo's full_name once.
      // Both are stable for the lifetime of the refresh, so we cache them
      // by repoRoot for the per-worktree match step below.
      const repoData = await Promise.all(
        roots.map(async (root) => {
          const [info, prs] = await Promise.all([
            getRepoInfo(root),
            listPullRequests(root)
          ])
          return { root, info, prs }
        })
      )
      const prsByRoot = new Map<
        string,
        { info: { owner: string; repo: string } | null; prs: PRListItem[] | null }
      >()
      for (const r of repoData) {
        prsByRoot.set(r.root, { info: r.info, prs: r.prs })
      }

      const statusResults = await Promise.all(
        allWorktrees.map(async (wt) => {
          try {
            const status = await this.statusForWorktree(wt, prsByRoot)
            return [wt.path, status] as const
          } catch (err) {
            log('pr-poller', `status fetch failed for ${wt.path}`, err instanceof Error ? err.message : err)
            return [wt.path, null] as const
          }
        })
      )
      this.store.dispatch({
        type: 'prs/bulkStatusChanged',
        payload: Object.fromEntries(statusResults)
      })

      // Merged status per repo, then flatten. Stale branches get pruned from
      // the persisted locallyMerged map.
      const persisted = { ...this.opts.getLocallyMerged() }
      const mergedAll: Record<string, boolean> = {}
      let prunedAny = false
      for (let i = 0; i < roots.length; i++) {
        const root = roots[i]
        const trees = treesByRoot[i]
        for (const wt of trees) {
          if (wt.isMain) continue
          if (wt.branch === '(detached)') continue
          const recordedSha = persisted[wt.branch]
          if (!recordedSha) {
            mergedAll[wt.path] = false
            continue
          }
          const branchSha = await getBranchSha(root, wt.branch).catch(() => null)
          if (branchSha && branchSha === recordedSha) {
            mergedAll[wt.path] = true
          } else {
            delete persisted[wt.branch]
            prunedAny = true
            mergedAll[wt.path] = false
          }
        }
      }
      if (prunedAny) this.opts.setLocallyMerged(persisted)
      this.store.dispatch({ type: 'prs/mergedChanged', payload: mergedAll })
    } finally {
      this.inFlightAll = false
      this.store.dispatch({ type: 'prs/loadingChanged', payload: false })
    }
  }

  private async statusForWorktree(
    wt: { path: string; branch: string; head: string; repoRoot: string },
    prsByRoot: Map<
      string,
      { info: { owner: string; repo: string } | null; prs: PRListItem[] | null }
    >
  ): Promise<PRStatus | null> {
    const entry = prsByRoot.get(wt.repoRoot)
    if (!entry || !entry.info || !entry.prs) return null
    const baseFull = `${entry.info.owner}/${entry.info.repo}`
    const item = pickPRForWorktree(
      { path: wt.path, branch: wt.branch, head: wt.head },
      entry.prs,
      baseFull
    )
    if (!item) return null
    return loadPRStatusForItem(wt.path, item, entry.info)
  }

  /** Refresh a single worktree's PR status. Used when a Claude terminal
   * reaches the "waiting" state (likely just pushed) or when the user
   * activates a stale worktree.
   *
   * Reads (or fetches) the repo's PR list, matches this worktree, and
   * loads details. Cheaper than the per-worktree branch-filter call we
   * used to make. */
  async refreshOne(wtPath: string): Promise<void> {
    try {
      const wt = this.store
        .getSnapshot()
        .state.worktrees.list.find((w) => w.path === wtPath)
      if (!wt) return
      const [info, prs] = await Promise.all([
        getRepoInfo(wt.repoRoot),
        listPullRequests(wt.repoRoot)
      ])
      let status: PRStatus | null = null
      if (info && prs) {
        const baseFull = `${info.owner}/${info.repo}`
        const item = pickPRForWorktree(
          { path: wt.path, branch: wt.branch, head: wt.head },
          prs,
          baseFull
        )
        if (item) {
          status = await loadPRStatusForItem(wt.path, item, info)
        }
      }
      this.lastFetchAtByPath.set(wtPath, Date.now())
      this.store.dispatch({
        type: 'prs/statusChanged',
        payload: { path: wtPath, status }
      })
    } catch (err) {
      log('pr-poller', `refreshOne failed for ${wtPath}`, err instanceof Error ? err.message : err)
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

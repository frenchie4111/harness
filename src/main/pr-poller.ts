import { listWorktrees, getBranchSha } from './worktree'
import { getPRStatus } from './github'
import { log } from './debug'
import type { Store } from './store'

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

  /** Refresh every worktree across every known repo root. Bulk-replaces
   * `prs.byPath` and `prs.mergedByPath`. */
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

      const statusResults = await Promise.all(
        allWorktrees.map(async (wt) => {
          try {
            return [wt.path, await getPRStatus(wt.path)] as const
          } catch (err) {
            log('pr-poller', `getPRStatus failed for ${wt.path}`, err instanceof Error ? err.message : err)
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

  /** Refresh a single worktree's PR status. Used when a Claude terminal
   * reaches the "waiting" state (likely just pushed) or when the user
   * activates a stale worktree. */
  async refreshOne(wtPath: string): Promise<void> {
    try {
      const status = await getPRStatus(wtPath)
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

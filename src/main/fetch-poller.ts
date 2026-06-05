import { fetchAllRemotes } from './worktree'
import { log, formatErr } from './debug'

const FETCH_INTERVAL_MS = 3 * 60 * 1000

interface FetchPollerOptions {
  getRepoRoots: () => string[]
  /** Whether the background fetch is enabled. Re-read every tick so a
   *  settings toggle takes effect without restarting the poller. */
  isEnabled: () => boolean
}

/** Periodically runs `git fetch --all` on every known repo so worktrees
 *  stay current with their remotes without a manual fetch. One fetch per
 *  repo root (a fetch from the root updates the shared object store that
 *  all of its worktrees read). Failures are swallowed per-repo — an
 *  offline remote or auth prompt on one repo doesn't stop the others, and
 *  the next tick simply tries again. */
export class FetchPoller {
  private opts: FetchPollerOptions
  private timer: NodeJS.Timeout | null = null
  private inFlight = false

  constructor(opts: FetchPollerOptions) {
    this.opts = opts
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.fetchAll()
    }, FETCH_INTERVAL_MS)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** Fetch every repo's remotes once. No-op while disabled or when a
   *  previous sweep is still running (a slow network shouldn't let ticks
   *  pile up). */
  async fetchAll(): Promise<void> {
    if (this.inFlight) return
    if (!this.opts.isEnabled()) return
    const roots = this.opts.getRepoRoots()
    if (roots.length === 0) return
    this.inFlight = true
    try {
      await Promise.all(
        roots.map((root) =>
          fetchAllRemotes(root).catch((err) => {
            log('fetch-poller', `fetch --all failed for ${root}`, formatErr(err))
          })
        )
      )
    } finally {
      this.inFlight = false
    }
  }
}

// Concurrency gate for read-only git subprocesses.
//
// Every panel read here is I/O-bound, not CPU-bound: a cold `git status
// --porcelain` in a large monorepo stats thousands of files at ~35% CPU while
// the main process sits idle. That makes the interesting number *not* total
// throughput but how long any one read waits behind the others.
//
// Measured on the reference monorepo (18 worktrees, `git status --porcelain`
// in each, warm cache), varying only the concurrency cap:
//
//   cap=1   total 1626ms   p50   49ms   max  463ms
//   cap=4   total  741ms   p50   77ms   max  495ms
//   cap=8   total  718ms   p50  155ms   max  534ms
//   cap=16  total  732ms   p50  274ms   max  619ms
//   cap=64  total  766ms   p50  220ms   max  621ms
//
// Total wall time plateaus at cap=4 — past that, extra parallelism buys no
// throughput and only inflates per-call latency (p50 77ms → 274ms), because
// each read now shares the disk with 15 others instead of 3. So the cap is
// close to free, which is what makes the second half of this module possible.
//
// The second half is priority. A cap alone doesn't help an interactive read
// that lands behind a 66-worktree bulk sweep — it still waits for the queue to
// drain. Interactive work is dequeued ahead of bulk work, so a background scan
// yields to a panel the user is actually looking at. Strict priority is safe
// here because interactive load is inherently finite and short-lived (a bounded
// set of mounted panels, each firing a handful of reads per switch or per 30s
// poll), so bulk always drains once the burst passes.
//
// Writes deliberately do NOT go through this gate. Merges, fetches, and
// `worktree add` are user-initiated, rare, and long — queueing them behind a
// background sweep would be strictly worse, and they call read helpers
// internally, which under a shared cap is a deadlock waiting to happen.

export type GitPriority = 'interactive' | 'bulk'

/** The throughput plateau from the table above. */
export const MAX_CONCURRENT_GIT_READS = 4

interface Waiter {
  resolve: () => void
}

const queues: Record<GitPriority, Waiter[]> = {
  interactive: [],
  bulk: []
}

let active = 0

function next(): void {
  const waiter = queues.interactive.shift() ?? queues.bulk.shift()
  if (!waiter) return
  active++
  waiter.resolve()
}

function acquire(priority: GitPriority): Promise<void> {
  if (active < MAX_CONCURRENT_GIT_READS) {
    active++
    return Promise.resolve()
  }
  return new Promise<void>((resolve) => {
    queues[priority].push({ resolve })
  })
}

function release(): void {
  active--
  next()
}

/** Run a read-only git operation under the concurrency gate. The permit is
 *  held only for the duration of `fn`, so a caller that runs several reads in
 *  sequence takes and returns a permit per read rather than holding one across
 *  the whole sequence — that's what keeps nested helpers deadlock-free. */
export async function runGitRead<T>(
  priority: GitPriority,
  fn: () => Promise<T>
): Promise<T> {
  await acquire(priority)
  try {
    return await fn()
  } finally {
    release()
  }
}

/** Test-only: observable queue depth. */
export function gitLimiterStats(): {
  active: number
  interactiveQueued: number
  bulkQueued: number
} {
  return {
    active,
    interactiveQueued: queues.interactive.length,
    bulkQueued: queues.bulk.length
  }
}

/** Test-only: drop all state between cases. */
export function resetGitLimiter(): void {
  queues.interactive.length = 0
  queues.bulk.length = 0
  active = 0
}

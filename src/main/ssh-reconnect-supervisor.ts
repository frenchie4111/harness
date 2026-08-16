// Retry loop for SSH backends whose tunnel dropped.
//
// SshTunnelManager notices the link died and calls `notifyDropped`; this
// class owns everything after that — backoff, jitter, cancellation, and
// the per-attempt bookkeeping. Keeping it out of the manager means the
// manager stays a registry with registry-shaped tests, and the retry
// policy is testable with injected timers instead of real clocks.
//
// Retries continue indefinitely as long as the backend is still in the
// connections list. A laptop that sleeps for a weekend should find its
// remote back when it wakes, not a chip that gave up after five tries.

/** Opaque timer handle. Widened past `ReturnType<typeof setTimeout>` so
 *  an injected fake timer (which hands back a plain number) type-checks
 *  against the same field the real one uses. */
type TimerHandle = ReturnType<typeof setTimeout> | number

const BASE_DELAY_MS = 1_000
const MAX_DELAY_MS = 30_000

export interface SshReconnectSupervisorDeps {
  /** Re-establish the tunnel. Should reuse the previous local port and
   *  skip install when the remote server is already running. Rejects on
   *  failure, which schedules the next attempt. */
  reconnect: (backendId: string) => Promise<void>
  /** Whether this backend still exists in the persisted connections
   *  list. Returning false stops the loop — the user removed it. */
  connectionExists: (backendId: string) => boolean
  /** Progress hook so the caller can dispatch into the sshBootstrap
   *  slice without this module importing the store. */
  onAttemptState?: (
    backendId: string,
    state: { phase: 'disconnected' | 'reconnecting'; attempt: number; delayMs?: number }
  ) => void
  /** Injected for tests. */
  setTimer?: (cb: () => void, ms: number) => TimerHandle
  clearTimer?: (handle: TimerHandle) => void
  random?: () => number
}

interface PendingRetry {
  attempt: number
  timer: TimerHandle | null
  cancelled: boolean
}

export class SshReconnectSupervisor {
  private pending = new Map<string, PendingRetry>()

  constructor(private deps: SshReconnectSupervisorDeps) {}

  /** Full-jitter exponential backoff: 1s doubling to a 30s cap, then a
   *  uniform random pick in [0, cap]. Jitter matters here because a
   *  laptop waking from sleep drops every tunnel at once — without it
   *  they'd all retry in lockstep and hammer the same sshd. */
  private delayFor(attempt: number): number {
    const ceiling = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt)
    const rand = this.deps.random ?? Math.random
    return Math.max(BASE_DELAY_MS, Math.floor(rand() * ceiling))
  }

  /** Called by SshTunnelManager when a link dies. Idempotent — a repeat
   *  call for a backend that's already retrying is a no-op. */
  notifyDropped(backendId: string): void {
    if (this.pending.has(backendId)) return
    if (!this.deps.connectionExists(backendId)) return
    const state: PendingRetry = {
      attempt: 0,
      timer: null,
      cancelled: false
    }
    this.pending.set(backendId, state)
    this.schedule(backendId, state)
  }

  /** Stop retrying this backend and drop any armed timer. Called on
   *  `connections:remove` and after a successful manual reconnect. */
  cancel(backendId: string): void {
    const state = this.pending.get(backendId)
    if (!state) return
    state.cancelled = true
    if (state.timer) {
      const clear = this.deps.clearTimer ?? clearTimeout
      clear(state.timer)
      state.timer = null
    }
    this.pending.delete(backendId)
  }

  /** Cancel every pending retry. Called from the before-quit hook so no
   *  timer keeps the process alive past shutdown. */
  cancelAll(): void {
    for (const backendId of [...this.pending.keys()]) {
      this.cancel(backendId)
    }
  }

  /** Test/diagnostic accessor: is a retry loop armed for this backend? */
  isRetrying(backendId: string): boolean {
    return this.pending.has(backendId)
  }

  private schedule(backendId: string, state: PendingRetry): void {
    const delayMs = this.delayFor(state.attempt)
    this.deps.onAttemptState?.(backendId, {
      phase: 'disconnected',
      attempt: state.attempt,
      delayMs
    })
    const set = this.deps.setTimer ?? setTimeout
    state.timer = set(() => {
      state.timer = null
      void this.attempt(backendId, state)
    }, delayMs)
  }

  private async attempt(backendId: string, state: PendingRetry): Promise<void> {
    if (state.cancelled) return
    if (!this.deps.connectionExists(backendId)) {
      this.pending.delete(backendId)
      return
    }
    this.deps.onAttemptState?.(backendId, {
      phase: 'reconnecting',
      attempt: state.attempt
    })
    try {
      await this.deps.reconnect(backendId)
      // Success. Drop the loop; if this tunnel dies again the manager
      // fires a fresh notifyDropped and the backoff restarts at 1s.
      if (!state.cancelled) this.pending.delete(backendId)
    } catch {
      if (state.cancelled) return
      state.attempt += 1
      this.schedule(backendId, state)
    }
  }
}

import type { Store } from './store'
import type { AppState, StateEvent } from '../shared/state'
import type { PRStatus } from '../shared/state/prs'
import { getLeaves } from '../shared/state/terminals'
import { isCiNotifyEnabled } from '../shared/state/ci-notify'
import { log } from './debug'

type ChecksOverall = PRStatus['checksOverall']

export interface CiNotifierOptions {
  /** Injects a user turn into a running json-mode chat session. */
  send: (sessionId: string, text: string) => void
  /** True when the session has a live subprocess to receive the message. */
  hasSession: (sessionId: string) => boolean
  /** Re-spawns a slept json-claude tab's subprocess. Synchronous — the
   *  session is live by the time this returns (or the spawn failed). */
  wake: (worktreePath: string, tabId: string) => void
}

const MAX_LISTED_CHECKS = 10

/** Compose the message injected into the agent chat. Exported for tests. */
export function buildCiFailureMessage(pr: PRStatus): string {
  const failing = pr.checks.filter(
    (c) => c.state === 'failure' || c.state === 'error'
  )
  const lines = [
    `CI is failing on PR #${pr.number} (${pr.branch}). Please investigate and fix.`,
    ''
  ]
  if (failing.length === 0) {
    lines.push('No individual failing check was reported — see ' + pr.url)
    return lines.join('\n')
  }
  lines.push('Failing checks:')
  for (const check of failing.slice(0, MAX_LISTED_CHECKS)) {
    const detail = check.description?.trim()
    const parts = [`- ${check.name}`]
    if (detail) parts.push(`: ${detail}`)
    if (check.detailsUrl) parts.push(` — ${check.detailsUrl}`)
    lines.push(parts.join(''))
  }
  if (failing.length > MAX_LISTED_CHECKS) {
    lines.push(`- …and ${failing.length - MAX_LISTED_CHECKS} more`)
  }
  return lines.join('\n')
}

/** Subscribes to the store and injects a "CI is failing" message into a
 *  worktree's agent chat when its PR checks transition into failure.
 *
 *  Lives here rather than in PRPoller so the poller stays ignorant of chat
 *  sessions — it only knows how to fetch PR status and dispatch it.
 *
 *  Two independent guards keep this from spamming:
 *
 *  - `lastOverall` tracks the previously-seen `checksOverall` per worktree
 *    so we only act on an actual transition INTO 'failure'. A path we've
 *    never seen before is recorded without notifying, which is what
 *    suppresses a burst on the first poll after boot for PRs that were
 *    already red before Harness started.
 *  - `notifiedSha` records the head commit we last notified about, so a
 *    failure that flaps (failure → pending → failure on a re-run) notifies
 *    once, while a fresh push that also fails notifies again.
 *
 *  Delivery wakes a slept chat tab when it has to — see `deliver`. */
export class CiNotifier {
  private store: Store
  private opts: CiNotifierOptions
  private lastOverall = new Map<string, ChecksOverall>()
  private notifiedSha = new Map<string, string>()
  private unsubscribe: (() => void) | null = null

  constructor(store: Store, opts: CiNotifierOptions) {
    this.store = store
    this.opts = opts
  }

  start(): void {
    if (this.unsubscribe) return
    // Seed from whatever the store already knows so a poll that landed
    // before we subscribed doesn't read as a fresh transition.
    const byPath = this.store.getSnapshot().state.prs.byPath
    for (const [path, status] of Object.entries(byPath)) {
      if (status) this.lastOverall.set(path, status.checksOverall)
    }
    this.unsubscribe = this.store.subscribe((event) => this.onEvent(event))
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  private onEvent(event: StateEvent): void {
    if (event.type === 'prs/statusChanged') {
      this.consider(event.payload.path, event.payload.status)
      return
    }
    if (event.type === 'prs/bulkStatusChanged') {
      // Sweeping the whole payload is inherent to this event — it replaces
      // prs.byPath wholesale — and PR polls are minutes apart, so the cost
      // is negligible. The per-path caches below keep the sweep from
      // turning into repeated work.
      for (const path of Object.keys(event.payload)) {
        this.consider(path, event.payload[path])
      }
      for (const path of this.lastOverall.keys()) {
        if (!(path in event.payload)) {
          this.lastOverall.delete(path)
          this.notifiedSha.delete(path)
        }
      }
      return
    }
  }

  private consider(path: string, status: PRStatus | null): void {
    if (!status) {
      this.lastOverall.delete(path)
      this.notifiedSha.delete(path)
      return
    }
    const prev = this.lastOverall.get(path)
    this.lastOverall.set(path, status.checksOverall)
    if (status.checksOverall !== 'failure') return
    // First observation of this worktree — record only. Otherwise every
    // launch would re-announce PRs that were already red.
    if (prev === undefined || prev === 'failure') return

    const state = this.store.getSnapshot().state
    if (!isCiNotifyEnabled(state.ciNotify, path, state.settings.notifyChatOnCiFailure)) {
      return
    }

    // Statuses cached by an older build carry no headSha; fall back to the
    // PR number so dedup still collapses a flapping check to one message.
    const shaKey = status.headSha || `pr-${status.number}`
    if (this.notifiedSha.get(path) === shaKey) return

    // Claim the commit before delivering. Delivery is deferred off the
    // dispatch fan-out (below), so without claiming now a second poll
    // landing in that window would notify twice.
    this.notifiedSha.set(path, shaKey)
    const message = buildCiFailureMessage(status)
    // Waking a tab spawns a subprocess and replays its transcript from
    // disk. That's far too much work to run inside a store listener, so
    // hop off the fan-out first.
    setImmediate(() => this.deliver(path, message, shaKey))
  }

  /** Route the message to a chat session, waking a slept tab if that's
   *  what it takes. Every persisted json-claude tab hydrates as 'asleep'
   *  at app launch and the auto-sleep monitor puts idle ones back to
   *  sleep, so "no live session" is the *normal* state for exactly the
   *  worktrees this feature exists to serve — refusing to wake would
   *  make it fire almost never. */
  private deliver(worktreePath: string, message: string, shaKey: string): void {
    const state = this.store.getSnapshot().state
    let sessionId = this.pickLiveSession(state, worktreePath)
    if (!sessionId) {
      const slept = this.pickSleptTab(state, worktreePath)
      if (!slept) {
        // No chat tab at all (terminal-only worktree). Nothing to do —
        // the PR pane already shows the red checks.
        this.notifiedSha.delete(worktreePath)
        return
      }
      this.opts.wake(worktreePath, slept)
      if (!this.opts.hasSession(slept)) {
        log('ci-notifier', `wake failed for tab=${slept} wt=${worktreePath}`)
        this.notifiedSha.delete(worktreePath)
        return
      }
      log('ci-notifier', `woke tab=${slept} wt=${worktreePath} to report CI failure`)
      sessionId = slept
    }
    this.opts.send(sessionId, message)
    log('ci-notifier', `notified ${sessionId} of CI failure on ${worktreePath} @ ${shaKey}`)
  }

  /** Most recently active session for this worktree that still has a live
   *  subprocess. */
  private pickLiveSession(state: AppState, worktreePath: string): string | null {
    let best: string | null = null
    let bestTs = -1
    for (const [sessionId, session] of Object.entries(state.jsonClaude.sessions)) {
      if (session.worktreePath !== worktreePath) continue
      if (!this.opts.hasSession(sessionId)) continue
      const last = session.entries[session.entries.length - 1]
      const ts = last?.timestamp ?? 0
      if (ts > bestTs || (ts === bestTs && (best === null || sessionId < best))) {
        best = sessionId
        bestTs = ts
      }
    }
    return best
  }

  /** A slept json-claude tab to wake, preferring whichever tab its pane
   *  had focused. Only genuinely-asleep tabs qualify: a tab marked awake
   *  with a dead subprocess is the renderer's to respawn on focus, and
   *  racing it here would double-spawn. */
  private pickSleptTab(state: AppState, worktreePath: string): string | null {
    const tree = state.terminals.panes[worktreePath]
    if (!tree) return null
    let fallback: string | null = null
    for (const leaf of getLeaves(tree)) {
      for (const tab of leaf.tabs) {
        if (tab.type !== 'json-claude') continue
        if ((tab.mode ?? 'awake') !== 'asleep') continue
        if (tab.id === leaf.activeTabId) return tab.id
        fallback ??= tab.id
      }
    }
    return fallback
  }
}

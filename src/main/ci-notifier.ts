import type { Store } from './store'
import type { AppState, StateEvent } from '../shared/state'
import type { PRStatus } from '../shared/state/prs'
import { isCiNotifyEnabled } from '../shared/state/ci-notify'
import { log } from './debug'

type ChecksOverall = PRStatus['checksOverall']

export interface CiNotifierOptions {
  /** Injects a user turn into a running json-mode chat session. */
  send: (sessionId: string, text: string) => void
  /** True when the session has a live subprocess to receive the message. */
  hasSession: (sessionId: string) => boolean
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
 *    once, while a fresh push that also fails notifies again. */
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

    const sessionId = this.pickSession(state, path)
    if (!sessionId) return

    this.notifiedSha.set(path, shaKey)
    this.opts.send(sessionId, buildCiFailureMessage(status))
    log('ci-notifier', `notified ${sessionId} of CI failure on ${path} @ ${shaKey}`)
  }

  /** The chat session that should receive the message: the most recently
   *  active live session for this worktree. Worktrees with no live chat
   *  (terminal-only, or a slept tab) are skipped silently — there's
   *  nowhere to put the message, and the PR pane already shows the red
   *  checks. */
  private pickSession(state: AppState, worktreePath: string): string | null {
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
}

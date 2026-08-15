import type { Store } from './store'
import type { StateEvent } from '../shared/state'
import type { PRStatus } from '../shared/state/prs'
import { isCiNotifyEnabled } from '../shared/state/ci-notify'
import { wrapAutomatedMessage } from '../shared/state/json-claude'
import { deliverToWorktreeChat, type ChatDeliveryDeps } from './chat-delivery'
import { log } from './debug'

/** Identity of a failure. Statuses cached by an older build carry no
 *  headSha; falling back to the PR number still collapses a flapping
 *  check down to one message. */
function shaKeyFor(status: PRStatus): string {
  return status.headSha || `pr-${status.number}`
}

export type CiNotifierOptions = ChatDeliveryDeps

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
  } else {
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
  }
  return wrapAutomatedMessage('ci-failure', lines.join('\n'))
}

/** Subscribes to the store and injects a "CI is failing" message into a
 *  worktree's agent chat when its PR checks transition into failure.
 *
 *  Lives here rather than in PRPoller so the poller stays ignorant of chat
 *  sessions — it only knows how to fetch PR status and dispatch it.
 *
 *  The head commit is the identity of a failure: `handledSha` records the
 *  commit we last made a decision about, so a failure that flaps
 *  (failure → pending → failure on a re-run) notifies once while a fresh
 *  push that also fails notifies again. Deliberately NOT keyed on a
 *  transition in `checksOverall` — a push whose CI fails before the poller
 *  ever observes a non-failure state is still a new failure, and with
 *  multi-minute poll intervals that's the common case, not the edge.
 *
 *  `seen` exists only to suppress a burst on the first poll after boot,
 *  where every already-red PR would otherwise read as fresh.
 *
 *  Delivery wakes a slept chat tab when it has to — see `deliver`. */
export class CiNotifier {
  private store: Store
  private opts: CiNotifierOptions
  private seen = new Set<string>()
  private handledSha = new Map<string, string>()
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
      if (!status) continue
      this.seen.add(path)
      // Claim an already-red commit so boot stays quiet until a NEW one
      // fails. Marking the path seen isn't enough on its own — the next
      // poll would read as a fresh failure.
      if (status.checksOverall === 'failure') {
        this.handledSha.set(path, shaKeyFor(status))
      }
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
      for (const path of this.seen) {
        if (!(path in event.payload)) {
          this.seen.delete(path)
          this.handledSha.delete(path)
        }
      }
      return
    }
  }

  private consider(path: string, status: PRStatus | null): void {
    if (!status) {
      this.seen.delete(path)
      this.handledSha.delete(path)
      return
    }
    const firstObservation = !this.seen.has(path)
    this.seen.add(path)
    if (status.checksOverall !== 'failure') return

    const shaKey = shaKeyFor(status)
    if (this.handledSha.get(path) === shaKey) return
    // Claim the commit before deciding anything else, so there's exactly
    // one decision per head commit. That stops a poll landing during the
    // deferred delivery below from notifying twice, and bounds the
    // decline logging to one line per commit.
    this.handledSha.set(path, shaKey)

    if (firstObservation) {
      // Already red the first time we looked. Staying quiet here is what
      // keeps a launch from re-announcing every red PR in the workspace.
      log('ci-notifier', `skip ${path} @ ${shaKey}: already failing at first poll`)
      return
    }

    const state = this.store.getSnapshot().state
    if (!isCiNotifyEnabled(state.ciNotify, path, state.settings.notifyChatOnCiFailure)) {
      log('ci-notifier', `skip ${path} @ ${shaKey}: notifications off for this worktree`)
      return
    }

    const message = buildCiFailureMessage(status)
    // Waking a tab spawns a subprocess and replays its transcript from
    // disk. That's far too much work to run inside a store listener, so
    // hop off the fan-out first.
    setImmediate(() => this.deliver(path, message, shaKey))
  }

  /** Hand the message to the shared chat router. A failure to deliver
   *  releases the commit claim so a later poll can retry — the tab may
   *  have been asleep mid-spawn, or the worktree may not have had a chat
   *  tab yet. */
  private deliver(worktreePath: string, message: string, shaKey: string): void {
    const state = this.store.getSnapshot().state
    const result = deliverToWorktreeChat(state, this.opts, worktreePath, message)
    if (!result.ok) {
      // No chat tab (terminal-only worktree) is not a problem to solve
      // here — the PR pane already shows the red checks.
      log('ci-notifier', `skip ${worktreePath} @ ${shaKey}: ${result.reason}`)
      this.handledSha.delete(worktreePath)
      return
    }
    if (result.woke) {
      log('ci-notifier', `woke tab=${result.sessionId} wt=${worktreePath} to report CI failure`)
    }
    log('ci-notifier', `notified ${result.sessionId} of CI failure on ${worktreePath} @ ${shaKey}`)
  }
}

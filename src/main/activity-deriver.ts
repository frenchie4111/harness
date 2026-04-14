import type { Store } from './store'
import type { AppState, StateEvent } from '../shared/state'
import type { PtyStatus } from '../shared/state/terminals'
import type { ActivityState } from './activity'
import { recordActivity } from './activity'

const DEBOUNCE_MS = 2000

const STATUS_RANK: Record<PtyStatus | 'merged', number> = {
  idle: 0,
  processing: 1,
  waiting: 2,
  'needs-approval': 3,
  merged: 4
}

/** Aggregate the worst (highest-rank) status across the tabs of a worktree.
 * Mirrors the renderer's prior worktreeStatuses derivation. */
function aggregateWorktreeStatus(
  state: AppState,
  worktreePath: string
): PtyStatus {
  const panes = state.terminals.panes[worktreePath] || []
  let worst: PtyStatus = 'idle'
  for (const pane of panes) {
    for (const tab of pane.tabs) {
      if (tab.type !== 'claude' && tab.type !== 'shell') continue
      const s = state.terminals.statuses[tab.id]
      if (!s) continue
      if (STATUS_RANK[s] > STATUS_RANK[worst]) worst = s
    }
  }
  return worst
}

/** Override pty status with 'merged' when the worktree's PR is merged or
 * closed locally. */
function effectiveActivityState(
  state: AppState,
  worktreePath: string
): ActivityState {
  const merged =
    state.prs.mergedByPath[worktreePath] ||
    state.prs.byPath[worktreePath]?.state === 'merged' ||
    state.prs.byPath[worktreePath]?.state === 'closed'
  if (merged) return 'merged'
  return aggregateWorktreeStatus(state, worktreePath)
}

/** Subscribes to the store and writes derived activity (recordActivity log
 * entries + lastActive timestamps) without any renderer involvement.
 *
 * This is the only main-side module that *consumes* state across multiple
 * slices to derive a third thing. It reads from `terminals` (statuses,
 * panes) AND `prs` (mergedByPath, byPath state) to compute "what's the
 * effective state of worktree X right now?", then writes back to
 * `terminals.lastActive` AND to the activity log on disk.
 *
 * Before the state migration, this logic lived in App.tsx as a
 * `useEffect` that read `worktreeStatuses` + `mergedPaths` + `prStatuses`
 * and called `window.api.recordActivity`. Pulling it into main
 * eliminated (a) the dedup and debounce refs that were in the renderer
 * and (b) duplicated calls if there were ever multiple clients of the
 * same workspace. The trade-off is that "what triggers an activity log
 * entry" is now invisible from the renderer — if you're debugging
 * missing log entries, look here, not in App.tsx. */
export class ActivityDeriver {
  private store: Store
  private debounceTimers = new Map<string, NodeJS.Timeout>()
  private lastRecorded = new Map<string, ActivityState>()
  private unsubscribe: (() => void) | null = null

  constructor(store: Store) {
    this.store = store
  }

  start(): void {
    if (this.unsubscribe) return
    this.unsubscribe = this.store.subscribe((event) => this.onEvent(event))
  }

  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe()
      this.unsubscribe = null
    }
    for (const t of this.debounceTimers.values()) clearTimeout(t)
    this.debounceTimers.clear()
  }

  /** Decide which worktrees to re-derive based on the event type. */
  private onEvent(event: StateEvent): void {
    const state = this.store.getSnapshot().state
    if (
      event.type === 'terminals/statusChanged' ||
      event.type === 'terminals/shellActivityChanged'
    ) {
      // Find which worktree owns this terminal id and re-derive just that one.
      const id = event.payload.id
      const wtPath = this.findWorktreeForTerminal(state, id)
      if (wtPath) this.deriveAndRecord(wtPath)
      return
    }
    if (event.type === 'terminals/removed') {
      const wtPath = this.findWorktreeForTerminal(state, event.payload)
      if (wtPath) this.deriveAndRecord(wtPath)
      return
    }
    if (
      event.type === 'terminals/panesReplaced' ||
      event.type === 'terminals/panesForWorktreeChanged' ||
      event.type === 'terminals/panesForWorktreeCleared'
    ) {
      // Pane membership changed — re-derive everything affected.
      for (const wtPath of Object.keys(state.terminals.panes)) {
        this.deriveAndRecord(wtPath)
      }
      return
    }
    if (
      event.type === 'prs/statusChanged' ||
      event.type === 'prs/bulkStatusChanged' ||
      event.type === 'prs/mergedChanged'
    ) {
      // PR state can flip a worktree to 'merged'; re-derive everything.
      for (const wtPath of Object.keys(state.terminals.panes)) {
        this.deriveAndRecord(wtPath)
      }
      return
    }
  }

  private findWorktreeForTerminal(
    state: AppState,
    terminalId: string
  ): string | null {
    for (const [wtPath, panes] of Object.entries(state.terminals.panes)) {
      for (const pane of panes) {
        if (pane.tabs.some((t) => t.id === terminalId)) return wtPath
      }
    }
    return null
  }

  private deriveAndRecord(wtPath: string): void {
    const state = this.store.getSnapshot().state
    const next = effectiveActivityState(state, wtPath)

    // Dedup recordActivity — only call when the effective state actually
    // changes for this worktree.
    if (this.lastRecorded.get(wtPath) !== next) {
      this.lastRecorded.set(wtPath, next)
      recordActivity(wtPath, next)
    }

    // Debounce lastActive updates per worktree (2s window) so rapid status
    // churn doesn't thrash the sidebar sort.
    if (this.debounceTimers.has(wtPath)) return
    const timer = setTimeout(() => {
      this.debounceTimers.delete(wtPath)
      this.store.dispatch({
        type: 'terminals/lastActiveChanged',
        payload: { worktreePath: wtPath, ts: Date.now() }
      })
    }, DEBOUNCE_MS)
    this.debounceTimers.set(wtPath, timer)
  }
}

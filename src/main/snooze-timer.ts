import type { Store } from './store'
import { MAX_WAKE } from '../shared/state/snooze'

const SAFETY_SCAN_MS = 60_000

/** Watches `state.snooze.byPath` and clears entries when their `wakeAt` arrives.
 *
 *  Uses a single rolling setTimeout pinned to the soonest wakeAt; rescheduled
 *  whenever the snooze map changes. A 60s safety scan covers laptop-sleep
 *  scenarios where the timer fires late or not at all. */
export class SnoozeTimer {
  private store: Store
  private unsubscribe: (() => void) | null = null
  private wakeTimer: ReturnType<typeof setTimeout> | null = null
  private safetyTimer: ReturnType<typeof setInterval> | null = null

  constructor(store: Store) {
    this.store = store
  }

  start(): void {
    if (this.unsubscribe) return
    this.unsubscribe = this.store.subscribe((event) => {
      if (event.type === 'snooze/set' || event.type === 'snooze/clear') {
        this.reschedule()
      }
    })
    this.safetyTimer = setInterval(() => this.scan(), SAFETY_SCAN_MS)
    this.scan()
    this.reschedule()
  }

  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe()
      this.unsubscribe = null
    }
    if (this.wakeTimer) {
      clearTimeout(this.wakeTimer)
      this.wakeTimer = null
    }
    if (this.safetyTimer) {
      clearInterval(this.safetyTimer)
      this.safetyTimer = null
    }
  }

  private scan(): void {
    const now = Date.now()
    const byPath = this.store.getSnapshot().state.snooze.byPath
    for (const entry of Object.values(byPath)) {
      if (entry.wakeAt !== MAX_WAKE && now >= entry.wakeAt) {
        this.store.dispatch({ type: 'snooze/clear', payload: entry.path })
      }
    }
  }

  private reschedule(): void {
    if (this.wakeTimer) {
      clearTimeout(this.wakeTimer)
      this.wakeTimer = null
    }
    const byPath = this.store.getSnapshot().state.snooze.byPath
    let soonest = Infinity
    for (const entry of Object.values(byPath)) {
      if (entry.wakeAt === MAX_WAKE) continue
      if (entry.wakeAt < soonest) soonest = entry.wakeAt
    }
    if (!Number.isFinite(soonest)) return
    const delay = Math.max(0, soonest - Date.now())
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = null
      this.scan()
      this.reschedule()
    }, delay)
  }
}

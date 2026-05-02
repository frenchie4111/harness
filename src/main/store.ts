// The authoritative state store. There's exactly one instance of this in
// the main process. Every mutation to shared world state goes through
// `dispatch`, which runs the shared root reducer, bumps `seq`, and
// notifies subscribers.
//
// Subscribers fall into two camps:
// - The Electron transport (`transport-electron.ts`), which forwards
//   each event over the `state:event` IPC channel to all renderer
//   windows. The renderer applies the SAME reducer to its local mirror,
//   so renderer state is automatically in sync with no glue code.
// - Internal main-side reactors (e.g. `ActivityDeriver`,
//   `installHooksForAcceptedWorktrees`) that observe specific events
//   to do side effects.
//
// The `seq` field exists so a future networked client can resync after
// a reconnect — request "everything since seq N" and replay any missed
// events. The Electron transport ignores it because IPC doesn't drop
// messages, but the field is part of the wire format anyway.
//
// Dispatches that take longer than SLOW_DISPATCH_MS (reducer + listener
// fan-out combined) are written to perf.log so production lag can be
// debugged after the fact. See src/main/perf-log.ts.
//
// The dispatch is also instrumented for cascades: when a single root
// dispatch causes more than CASCADE_THRESHOLD nested dispatches in its
// listener fan-out, we log a `[cascade]` line. This is the diagnostic
// for subscribers that iterate-and-dispatch per entity instead of
// scoping to the affected one.

import {
  initialState,
  rootReducer,
  type AppState,
  type StateEvent,
  type StateSnapshot
} from '../shared/state'
import { perfLog } from './perf-log'

type Listener = (event: StateEvent, seq: number) => void

const SLOW_DISPATCH_MS = 5
// Threshold for logging a cascade. Most legitimate bulk operations
// (PR poller discovering N merged worktrees, panes FSM initializing N
// worktrees) fan out one dispatch per affected entity, which can
// reasonably reach 10–15 in normal use. Above 15 starts to suggest
// an unscoped subscriber sweeping a large collection.
const CASCADE_THRESHOLD = 15

export class Store {
  private state: AppState
  private seq = 0
  private listeners = new Set<Listener>()
  private dispatchDepth = 0
  private cascadeRootEventType: string | null = null
  private cascadeChildCount = 0

  constructor(initial: AppState = initialState) {
    this.state = initial
  }

  getSnapshot(): StateSnapshot {
    return { state: this.state, seq: this.seq }
  }

  dispatch(event: StateEvent): void {
    this.dispatchDepth++
    if (this.dispatchDepth === 1) {
      this.cascadeRootEventType = event.type
      this.cascadeChildCount = 0
    } else {
      this.cascadeChildCount++
    }
    const t0 = performance.now()
    try {
      this.state = rootReducer(this.state, event)
      const t1 = performance.now()
      this.seq += 1
      for (const listener of this.listeners) {
        listener(event, this.seq)
      }
      const t2 = performance.now()
      const totalMs = t2 - t0
      if (totalMs >= SLOW_DISPATCH_MS) {
        const reducerMs = t1 - t0
        perfLog(
          'store-slow',
          `${event.type} reducer=${reducerMs.toFixed(1)}ms total=${totalMs.toFixed(1)}ms`,
          {
            type: event.type,
            reducerMs: +reducerMs.toFixed(2),
            listenerMs: +(totalMs - reducerMs).toFixed(2),
            totalMs: +totalMs.toFixed(2)
          }
        )
      }
    } finally {
      this.dispatchDepth--
      if (this.dispatchDepth === 0) {
        const rootType = this.cascadeRootEventType
        const childCount = this.cascadeChildCount
        this.cascadeRootEventType = null
        this.cascadeChildCount = 0
        if (childCount > CASCADE_THRESHOLD && rootType !== null) {
          perfLog(
            'cascade',
            `${rootType} caused ${childCount} nested dispatches`,
            { rootEvent: rootType, childCount }
          )
        }
      }
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
}

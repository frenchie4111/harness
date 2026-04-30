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

export class Store {
  private state: AppState
  private seq = 0
  private listeners = new Set<Listener>()

  constructor(initial: AppState = initialState) {
    this.state = initial
  }

  getSnapshot(): StateSnapshot {
    return { state: this.state, seq: this.seq }
  }

  dispatch(event: StateEvent): void {
    const t0 = performance.now()
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
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
}

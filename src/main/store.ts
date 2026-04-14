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

import {
  initialState,
  rootReducer,
  type AppState,
  type StateEvent,
  type StateSnapshot
} from '../shared/state'

type Listener = (event: StateEvent, seq: number) => void

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
    this.state = rootReducer(this.state, event)
    this.seq += 1
    for (const listener of this.listeners) {
      listener(event, this.seq)
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
}

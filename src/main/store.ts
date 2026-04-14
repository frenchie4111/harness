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

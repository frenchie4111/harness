import { useSyncExternalStore } from 'react'
import {
  initialState,
  rootReducer,
  type AppState,
  type StateEvent
} from '../shared/state'

let state: AppState = initialState
const listeners = new Set<() => void>()

function notify(): void {
  for (const l of listeners) l()
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

export async function initStore(): Promise<void> {
  const snapshot = await window.api.getStateSnapshot()
  state = snapshot.state
  window.api.onStateEvent((event, _seq) => {
    state = rootReducer(state, event)
    notify()
  })
  notify()
}

function getState(): AppState {
  return state
}

export function useAppState<T>(selector: (s: AppState) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => selector(getState()),
    () => selector(initialState)
  )
}

export function useSettings() {
  return useAppState((s) => s.settings)
}

export type { AppState, StateEvent }

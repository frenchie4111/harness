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

export function usePrs() {
  return useAppState((s) => s.prs)
}

export function useOnboarding() {
  return useAppState((s) => s.onboarding)
}

export function useHooks() {
  return useAppState((s) => s.hooks)
}

export function useWorktrees() {
  return useAppState((s) => s.worktrees)
}

export function useTerminals() {
  return useAppState((s) => s.terminals)
}

export function usePanes() {
  return useAppState((s) => s.terminals.panes)
}

export function useLastActive() {
  return useAppState((s) => s.terminals.lastActive)
}

export type { AppState, StateEvent }

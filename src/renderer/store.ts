// Renderer-side mirror of the main-process store. This is intentionally
// a passive view: the renderer NEVER originates a mutation here. Every
// change comes from a `state:event` IPC message that we apply via the
// SHARED reducer (the same code main runs), guaranteeing the two stay
// in sync without any custom diffing.
//
// To mutate state, call the corresponding window.api method (e.g.
// `window.api.setTheme(...)`). That goes to main, which dispatches
// through its store, which broadcasts the event back here, which
// re-renders any component reading via `useSettings()` etc.
//
// The hooks below (`useSettings`, `usePrs`, `usePanes`, …) are how
// components read state. They use `useSyncExternalStore` so React's
// concurrent rendering sees a consistent snapshot per render. If you
// need a new slice's value, add a hook here following the same
// pattern; don't reach into the store directly.

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

// Server-assigned identity for this renderer. Hydrated once at boot so
// synchronous reads (e.g. in useMemo selectors that compare
// controllerClientId to "me") don't need to await an RPC. Stays constant
// for the life of the window — if the transport reconnects under us, a
// full reload is required and this is re-requested at the top of init.
let clientId: string | null = null

export function getClientId(): string | null {
  return clientId
}

export async function initStore(): Promise<void> {
  const [snapshot, id] = await Promise.all([
    window.api.getStateSnapshot(),
    window.api.getClientId()
  ])
  state = snapshot.state
  clientId = id
  // eslint-disable-next-line no-console
  console.log(`[take-control] initStore myClientId=${id}`)
  window.api.onStateEvent((event, _seq) => {
    state = rootReducer(state, event)
    // Diagnostic for the controller/spectator flow. If the UI is ever
    // stuck on the wrong controller, grep console for `[take-control]`
    // — the renderer should log one of these for every roster event
    // that lands, with the post-reducer controllerClientId.
    if (
      event.type === 'terminals/controlTaken' ||
      event.type === 'terminals/controlReleased' ||
      event.type === 'terminals/clientJoined' ||
      event.type === 'terminals/clientDisconnected'
    ) {
      const payload = event.payload as { terminalId?: string }
      const tid = payload.terminalId
      const session = tid ? state.terminals.sessions[tid] : undefined
      // eslint-disable-next-line no-console
      console.log(
        `[take-control] applied event=${event.type} payload=${JSON.stringify(event.payload)} myClientId=${clientId} postController=${session?.controllerClientId ?? 'null'}`
      )
    }
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

export function useUpdater() {
  return useAppState((s) => s.updater)
}

export function useRepoConfigs() {
  return useAppState((s) => s.repoConfigs.byRepo)
}

export function useCosts() {
  return useAppState((s) => s.costs)
}

export function useBrowser() {
  return useAppState((s) => s.browser)
}

/** Session roster (controller + spectators) for a given terminal id.
 *  Re-renders only when that terminal's entry changes. Returns null if
 *  the terminal hasn't been joined yet (e.g. right after pane create
 *  but before the XTerminal mount dispatches terminal:join). */
export function useTerminalSession(terminalId: string) {
  return useAppState((s) => s.terminals.sessions[terminalId] ?? null)
}

export function useJsonClaude() {
  return useAppState((s) => s.jsonClaude)
}

export type { AppState, StateEvent }

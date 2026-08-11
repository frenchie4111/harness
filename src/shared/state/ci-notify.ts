// Per-worktree override for "inject a message into the agent chat when CI
// fails". Absence from `byPath` means "inherit settings.notifyChatOnCiFailure";
// presence means the user made an explicit per-worktree choice.

export interface CiNotifyState {
  byPath: Record<string, boolean>
}

export type CiNotifyEvent =
  | { type: 'ciNotify/set'; payload: { path: string; enabled: boolean } }
  | { type: 'ciNotify/clear'; payload: string }

export const initialCiNotify: CiNotifyState = {
  byPath: {}
}

/** Effective per-worktree value: explicit override wins, otherwise the
 *  global default. */
export function isCiNotifyEnabled(
  state: CiNotifyState,
  path: string,
  globalDefault: boolean
): boolean {
  return state.byPath[path] ?? globalDefault
}

export function ciNotifyReducer(
  state: CiNotifyState,
  event: CiNotifyEvent
): CiNotifyState {
  switch (event.type) {
    case 'ciNotify/set':
      if (state.byPath[event.payload.path] === event.payload.enabled) return state
      return {
        ...state,
        byPath: { ...state.byPath, [event.payload.path]: event.payload.enabled }
      }
    case 'ciNotify/clear': {
      if (!(event.payload in state.byPath)) return state
      const next = { ...state.byPath }
      delete next[event.payload]
      return { ...state, byPath: next }
    }
    default: {
      const _exhaustive: never = event
      void _exhaustive
      return state
    }
  }
}

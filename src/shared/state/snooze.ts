export const MAX_WAKE = Number.MAX_SAFE_INTEGER

export interface SnoozeEntry {
  path: string
  snoozedAt: number
  wakeAt: number
}

export interface SnoozeState {
  byPath: Record<string, SnoozeEntry>
}

export type SnoozeEvent =
  | { type: 'snooze/set'; payload: SnoozeEntry }
  | { type: 'snooze/clear'; payload: string }

export const initialSnooze: SnoozeState = {
  byPath: {}
}

export function snoozeReducer(state: SnoozeState, event: SnoozeEvent): SnoozeState {
  switch (event.type) {
    case 'snooze/set':
      return {
        ...state,
        byPath: { ...state.byPath, [event.payload.path]: event.payload }
      }
    case 'snooze/clear': {
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

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

/** Human-readable label for a wake-up time, used in tooltips.
 *  Returns just the time portion (e.g. "Soon", "30m", "5h", "Tomorrow",
 *  "Mar 15"). Caller can prefix with "Wakes " etc. as needed. */
export function formatWakeAt(wakeAt: number, now: number = Date.now()): string {
  if (wakeAt >= MAX_WAKE) return 'Never'
  const diff = wakeAt - now
  if (diff < 60_000) return 'Soon'
  if (diff < 3_600_000) {
    const m = Math.round(diff / 60_000)
    return `${m}m`
  }
  if (diff < 12 * 3_600_000) {
    const h = Math.round(diff / 3_600_000)
    return `${h}h`
  }
  if (diff < 25 * 3_600_000) return 'Tomorrow'
  const d = new Date(wakeAt)
  const sameYear = d.getFullYear() === new Date(now).getFullYear()
  return d.toLocaleDateString(undefined, sameYear
    ? { month: 'short', day: 'numeric' }
    : { month: 'short', day: 'numeric', year: 'numeric' })
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

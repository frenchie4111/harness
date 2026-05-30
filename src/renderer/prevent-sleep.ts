import type { PreventSleepMode } from '../shared/state/settings'

/** Duration of the temporary "+1h" overlay engaged by the cycle hotkey. */
export const PREVENT_SLEEP_TEMPORARY_MS = 60 * 60 * 1000

/** showToast dedup key — rapid cycling replaces the toast in place. */
export const PREVENT_SLEEP_TOAST_KEY = 'prevent-sleep'

/** Opaque icon key — the renderer maps these to lucide glyphs in
 *  `components/prevent-sleep-icons.tsx`. 'off' has no glyph. */
export type PreventSleepIcon = 'agents' | 'always' | 'temporary'

/** The discrete states the cycle hotkey steps through. Equal to the
 *  modes plus the transient 'temporary' overlay. */
export type PreventSleepStep = PreventSleepMode | 'temporary'

/** Cycle order for Cmd+Shift+U: off → while agents run → always →
 *  temporary 1h → off … */
const CYCLE: PreventSleepStep[] = ['off', 'while-agents-running', 'always', 'temporary']

export interface PreventSleepStepMeta {
  /** Short label for the status-icon tooltip and Settings. */
  label: string
  /** Sentence shown in the cycle toast. */
  toast: string
  /** Glyph key, or null for 'off' (no icon). */
  icon: PreventSleepIcon | null
}

export const PREVENT_SLEEP_META: Record<PreventSleepStep, PreventSleepStepMeta> = {
  off: { label: 'Off', toast: 'Allow sleep', icon: null },
  'while-agents-running': {
    label: 'While agents are running',
    toast: 'Do not sleep if agents are working',
    icon: 'agents'
  },
  always: { label: 'Always', toast: 'Do not sleep', icon: 'always' },
  temporary: { label: 'For 1 hour', toast: 'Do not sleep for 1 hour', icon: 'temporary' }
}

/** The step currently in effect, given the persisted mode + live timer. The
 *  timer overlay wins for display purposes while it's running. */
export function currentPreventSleepStep(
  mode: PreventSleepMode,
  until: number | null,
  nowMs: number
): PreventSleepStep {
  if (until !== null && nowMs < until) return 'temporary'
  return mode
}

/** The next step in the cycle after `current`. */
export function nextPreventSleepStep(current: PreventSleepStep): PreventSleepStep {
  const i = CYCLE.indexOf(current)
  return CYCLE[(i + 1) % CYCLE.length]
}

/** The subset of `window.api` the cycle needs. */
export interface PreventSleepBackend {
  setPreventSleepMode(value: PreventSleepMode): Promise<boolean>
  setPreventSleepUntil(value: number | null): Promise<boolean>
}

/** Advance the cycle one step from the current (mode, timer) and apply it
 *  via the backend. 'temporary' arms the 1h timer (and clears the mode so
 *  it self-reverts to off); every other step sets the mode and clears any
 *  running timer. Returns the new step so the caller can toast it. Shared
 *  by the Cmd+Shift+U hotkey and the status-icon click. */
export function advancePreventSleep(
  mode: PreventSleepMode,
  until: number | null,
  nowMs: number,
  backend: PreventSleepBackend
): PreventSleepStep {
  const next = nextPreventSleepStep(currentPreventSleepStep(mode, until, nowMs))
  if (next === 'temporary') {
    void backend.setPreventSleepMode('off')
    void backend.setPreventSleepUntil(nowMs + PREVENT_SLEEP_TEMPORARY_MS)
  } else {
    void backend.setPreventSleepUntil(null)
    void backend.setPreventSleepMode(next)
  }
  return next
}

import { useEffect, useState } from 'react'
import { useAppState, useSettings } from '../store'
import { useBackend } from '../backend'
import {
  advancePreventSleep,
  currentPreventSleepStep,
  nextPreventSleepStep,
  PREVENT_SLEEP_META,
  PREVENT_SLEEP_TOAST_KEY
} from '../prevent-sleep'
import { showToast } from '../toast'
import { Tooltip } from './Tooltip'
import { PreventSleepGlyph } from './prevent-sleep-icons'

/** Sidebar-footer glyph showing the active prevent-sleep mode. Always
 *  renders (a Moon glyph when off). Solid (accent) when the wake-lock is
 *  actually engaged right now; dimmed when off, or when the mode is
 *  configured but idle ("while agents run" with nothing processing). Click
 *  to advance the cycle — same action as the Cmd+Shift+U hotkey. */
export function PreventSleepStatusIcon(): JSX.Element {
  const { preventSleepMode, preventSleepUntil } = useSettings()
  // Selector returns a stable boolean, so a status flipping between
  // 'processing' and 'processing' (adjacent streaming tokens) doesn't
  // re-render this component — only true→false transitions do.
  const agentsActive = useAppState((s) => {
    for (const id in s.terminals.statuses) {
      if (s.terminals.statuses[id] === 'processing') return true
    }
    return false
  })
  const backend = useBackend()
  const [nowMs, setNowMs] = useState(() => Date.now())

  // While a temporary timer is running, re-render every second so the
  // remaining-time tooltip stays fresh and the icon reverts on expiry even
  // before the main controller clears the deadline.
  useEffect(() => {
    if (preventSleepUntil === null) return
    const t = setInterval(() => setNowMs(Date.now()), 1000)
    return () => clearInterval(t)
  }, [preventSleepUntil])

  const step = currentPreventSleepStep(preventSleepMode, preventSleepUntil, nowMs)
  const meta = PREVENT_SLEEP_META[step]

  // Only 'while-agents-running' can be configured-but-idle; 'always' and
  // the temporary timer are always engaged. 'off' is never engaged.
  let engaged: boolean
  if (step === 'off') engaged = false
  else if (step === 'while-agents-running') engaged = agentsActive
  else engaged = true

  let currentLabel: string
  if (step === 'temporary') {
    const mins = Math.max(0, Math.ceil(((preventSleepUntil ?? nowMs) - nowMs) / 60000))
    currentLabel = `Do not sleep — ${mins}m remaining`
  } else if (step === 'always') {
    currentLabel = 'Do not sleep'
  } else if (step === 'while-agents-running') {
    currentLabel = engaged
      ? 'Do not sleep — agents are working'
      : 'Do not sleep while agents run'
  } else {
    currentLabel = 'Allow sleep'
  }
  const nextLabel = PREVENT_SLEEP_META[nextPreventSleepStep(step)].toast
  const tooltipLabel = (
    <span className="flex flex-col gap-0.5">
      <span>{currentLabel}</span>
      <span className="text-dim">Click: {nextLabel}</span>
    </span>
  )

  return (
    <Tooltip label={tooltipLabel} action="cyclePreventSleep" side="top">
      <button
        type="button"
        aria-label={currentLabel}
        onClick={() => {
          const next = advancePreventSleep(
            preventSleepMode,
            preventSleepUntil,
            Date.now(),
            backend
          )
          showToast(PREVENT_SLEEP_META[next].toast, next, PREVENT_SLEEP_TOAST_KEY)
        }}
        className={`${engaged ? 'text-accent hover:text-accent' : 'text-dim hover:text-fg'} hover:bg-surface rounded p-1.5 transition-colors cursor-pointer`}
      >
        <PreventSleepGlyph icon={meta.icon} className="icon-sm" />
      </button>
    </Tooltip>
  )
}

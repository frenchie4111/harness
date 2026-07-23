import { useEffect, useState } from 'react'
import { useSettings } from '../store'
import { useBackend } from '../backend'
import {
  advancePreventSleep,
  currentPreventSleepStep,
  PREVENT_SLEEP_META,
  PREVENT_SLEEP_TOAST_KEY
} from '../prevent-sleep'
import { showToast } from '../toast'
import { resolveHotkeys, bindingToString, formatBindingGlyphs } from '../hotkeys'
import { PreventSleepGlyph } from './prevent-sleep-icons'

/** Upper-right glyph showing the active prevent-sleep mode. Renders nothing
 *  when off. Solid (accent) when the wake-lock is actually engaged right
 *  now; dimmed when the mode is configured but idle ("while agents run" with
 *  nothing processing). Click to advance the cycle — same action as the
 *  Cmd+Shift+U hotkey. */
export function PreventSleepStatusIcon({
  agentsActive
}: {
  agentsActive: boolean
}): JSX.Element | null {
  const { preventSleepMode, preventSleepUntil, hotkeys } = useSettings()
  const backend = useBackend()
  const [nowMs, setNowMs] = useState(() => Date.now())

  // While a temporary timer is running, re-render every second so the
  // remaining-time tooltip stays fresh and the icon disappears on expiry
  // even before the main controller clears the deadline.
  useEffect(() => {
    if (preventSleepUntil === null) return
    const t = setInterval(() => setNowMs(Date.now()), 1000)
    return () => clearInterval(t)
  }, [preventSleepUntil])

  const step = currentPreventSleepStep(preventSleepMode, preventSleepUntil, nowMs)
  const meta = PREVENT_SLEEP_META[step]
  if (!meta.icon) return null // 'off' — no icon

  // Only 'while-agents-running' can be configured-but-idle; 'always' and the
  // temporary timer are always engaged while shown.
  const engaged = step === 'while-agents-running' ? agentsActive : true

  const hotkey = formatBindingGlyphs(
    bindingToString(resolveHotkeys(hotkeys ?? undefined).cyclePreventSleep)
  )

  let label: string
  if (step === 'temporary') {
    const mins = Math.max(0, Math.ceil(((preventSleepUntil ?? nowMs) - nowMs) / 60000))
    label = `Do not sleep - ${mins}m remaining`
  } else if (step === 'always') {
    label = 'Do not sleep'
  } else {
    label = engaged ? 'Do not sleep - agents are working' : 'Allow sleep'
  }
  const tooltip = `${label} (${hotkey})`

  return (
    <button
      type="button"
      title={tooltip}
      aria-label={tooltip}
      onClick={() => {
        const next = advancePreventSleep(
          preventSleepMode,
          preventSleepUntil,
          Date.now(),
          backend
        )
        showToast(PREVENT_SLEEP_META[next].toast, next, PREVENT_SLEEP_TOAST_KEY)
      }}
      className="no-drag fixed right-3 top-2 z-40 flex items-center justify-center rounded p-1 hover:bg-panel-raised cursor-pointer"
    >
      <PreventSleepGlyph
        icon={meta.icon}
        className={`icon-base ${engaged ? 'text-accent' : 'text-faint'}`}
      />
    </button>
  )
}

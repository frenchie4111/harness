import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Check } from 'lucide-react'
import { useAppState, useSettings } from '../store'
import { useBackend } from '../backend'
import {
  currentPreventSleepStep,
  PREVENT_SLEEP_META,
  PREVENT_SLEEP_TEMPORARY_MS,
  PREVENT_SLEEP_TOAST_KEY,
  type PreventSleepStep
} from '../prevent-sleep'
import { showToast } from '../toast'
import { Tooltip } from './Tooltip'
import { PreventSleepGlyph } from './prevent-sleep-icons'

interface StepDescriptor {
  step: PreventSleepStep
  title: string
  description: string
}

const STEPS: StepDescriptor[] = [
  { step: 'off', title: 'Off', description: 'Allow the computer to sleep normally.' },
  {
    step: 'while-agents-running',
    title: 'While agents are running',
    description: 'Stay awake whenever a session is processing.'
  },
  { step: 'always', title: 'Always', description: 'Stay awake while Harness is open.' },
  {
    step: 'temporary',
    title: 'For 1 hour',
    description: 'One-off hold; reverts to Off when it expires.'
  }
]

const POPOVER_MIN_W = 280
const POPOVER_GAP = 8

/** Sidebar-footer glyph showing the active prevent-sleep mode. Always
 *  renders (a Moon glyph when off). Solid (accent) when the wake-lock is
 *  actually engaged; dim when off, or when the mode is configured but idle
 *  ("while agents run" with nothing processing). Click to open a popover
 *  listing all four options — the current one is checkmarked. The
 *  Cmd+Shift+U hotkey still cycles through them without opening the
 *  popover. */
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
  const [menuOpen, setMenuOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  // Fixed-positioned coords, computed from the button's rect at open time.
  // Popover uses `position: fixed` (not `absolute`) so it escapes the
  // sidebar's stacking context and renders above the chat/terminal panels.
  const [pos, setPos] = useState<{ bottom: number; left: number } | null>(null)

  // While a temporary timer is running, re-render every second so the
  // countdown row stays fresh and the icon reverts on expiry even before
  // the main controller clears the deadline.
  useEffect(() => {
    if (preventSleepUntil === null) return
    const t = setInterval(() => setNowMs(Date.now()), 1000)
    return () => clearInterval(t)
  }, [preventSleepUntil])

  useLayoutEffect(() => {
    if (!menuOpen) {
      setPos(null)
      return
    }
    if (!buttonRef.current) return
    const rect = buttonRef.current.getBoundingClientRect()
    // Anchor the popover so its bottom edge sits POPOVER_GAP px above the
    // button, and its left edge aligns to the button's left. Clamp left so
    // the popover doesn't slide off-screen on narrow windows.
    const left = Math.max(
      8,
      Math.min(rect.left, window.innerWidth - POPOVER_MIN_W - 8)
    )
    setPos({ bottom: window.innerHeight - rect.top + POPOVER_GAP, left })
  }, [menuOpen])

  useEffect(() => {
    if (!menuOpen) return
    const onDocClick = (e: MouseEvent): void => {
      const target = e.target as Node
      if (buttonRef.current?.contains(target)) return
      if (popoverRef.current?.contains(target)) return
      setMenuOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    // Recompute on resize; scroll changes to the window rarely apply here
    // (sidebar footer is pinned) but a resize can move the button.
    const onResize = (): void => setMenuOpen(false)
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onResize)
    }
  }, [menuOpen])

  const step = currentPreventSleepStep(preventSleepMode, preventSleepUntil, nowMs)
  const meta = PREVENT_SLEEP_META[step]

  // Only 'while-agents-running' can be configured-but-idle; 'always' and
  // the temporary timer are always engaged. 'off' is never engaged.
  let engaged: boolean
  if (step === 'off') engaged = false
  else if (step === 'while-agents-running') engaged = agentsActive
  else engaged = true

  let tooltipLabel: string
  if (step === 'temporary') {
    const mins = Math.max(0, Math.ceil(((preventSleepUntil ?? nowMs) - nowMs) / 60000))
    tooltipLabel = `Do not sleep — ${mins}m remaining`
  } else if (step === 'always') {
    tooltipLabel = 'Do not sleep'
  } else if (step === 'while-agents-running') {
    tooltipLabel = engaged ? 'Do not sleep — agents are working' : 'Do not sleep while agents run'
  } else {
    tooltipLabel = 'Allow sleep'
  }

  const pick = (target: PreventSleepStep): void => {
    if (target === 'temporary') {
      void backend.setPreventSleepMode('off')
      void backend.setPreventSleepUntil(Date.now() + PREVENT_SLEEP_TEMPORARY_MS)
    } else {
      void backend.setPreventSleepUntil(null)
      void backend.setPreventSleepMode(target)
    }
    showToast(PREVENT_SLEEP_META[target].toast, target, PREVENT_SLEEP_TOAST_KEY)
    setMenuOpen(false)
  }

  return (
    <>
      <Tooltip label={tooltipLabel} action="cyclePreventSleep" side="top">
        <button
          ref={buttonRef}
          type="button"
          aria-label={tooltipLabel}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((v) => !v)}
          className={`no-drag ${engaged ? 'text-accent hover:text-accent' : 'text-dim hover:text-fg'} hover:bg-surface rounded p-1.5 transition-colors cursor-pointer`}
        >
          <PreventSleepGlyph icon={meta.icon} className="icon-sm" />
        </button>
      </Tooltip>
      {menuOpen && pos && (
        <div
          ref={popoverRef}
          role="menu"
          className="fixed z-50 min-w-[280px] rounded border border-border bg-panel-raised shadow-lg py-1"
          style={{ bottom: pos.bottom, left: pos.left }}
        >
          <div className="px-3 pt-2 pb-1 text-xs uppercase tracking-wide text-faint font-medium">
            Prevent system sleep
          </div>
          {STEPS.map((s) => {
            const isCurrent = s.step === step
            const glyph = PREVENT_SLEEP_META[s.step].icon
            const title =
              s.step === 'temporary' && isCurrent
                ? `For 1 hour — ${Math.max(0, Math.ceil(((preventSleepUntil ?? nowMs) - nowMs) / 60000))}m left`
                : s.title
            return (
              <button
                key={s.step}
                role="menuitemradio"
                aria-checked={isCurrent}
                onClick={() => pick(s.step)}
                className="w-full flex items-start gap-3 px-3 py-2 text-left hover:bg-panel/60 cursor-pointer"
              >
                <PreventSleepGlyph
                  icon={glyph}
                  className={`icon-sm mt-0.5 shrink-0 ${isCurrent ? 'text-accent' : 'text-dim'}`}
                />
                <div className="flex-1 min-w-0">
                  <div className={`text-xs ${isCurrent ? 'text-fg-bright font-medium' : 'text-fg'}`}>
                    {title}
                  </div>
                  <div className="text-xs text-dim">{s.description}</div>
                </div>
                <span className="w-3 h-3 flex items-center justify-center shrink-0 mt-0.5">
                  {isCurrent && <Check className="icon-xs text-accent" />}
                </span>
              </button>
            )
          })}
          <div className="px-3 pt-1 pb-2 text-xs text-faint border-t border-border mt-1">
            The display can still sleep — only the CPU is kept awake.
          </div>
        </div>
      )}
    </>
  )
}

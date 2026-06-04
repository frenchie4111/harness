import { useEffect, useRef, useState } from 'react'
import { getBackend } from '../backend'

export type HoldToQuitPhase = 'idle' | 'holding' | 'fading'

export interface HoldToQuitState {
  /** 'holding' while ⌘Q is held, 'fading' for the linger after a cancel,
   * 'idle' once the toast is gone. */
  phase: HoldToQuitPhase
  /** Bumps on each fresh hold so App can `key` the overlay and restart the
   * fill animation from 0 (it stays mounted through a fade, so without a
   * new key a hold started mid-fade wouldn't replay). */
  holdId: number
}

/** ms the toast lingers and fades after a cancel. A quick ⌘Q tap fires
 * start then cancel almost instantly; without this the toast just flashed.
 * Must match the CSS fade duration (`.hold-to-quit-toast.is-fading` in
 * styles.css). */
const FADE_OUT_MS = 1500

/**
 * Chrome-style "Hold ⌘Q to Quit".
 *
 * The entire gesture — keydown/keyup detection and the hold timer — lives
 * in the MAIN process (desktop-shell.ts, via `before-input-event`) so it
 * works even when an embedded browser tab is focused. This hook is purely
 * a view binding: it mirrors the main-driven start/cancel signals into
 * render state so App can show the overlay. In the web client these
 * signals never fire, so it stays inert.
 *
 * On cancel we don't drop straight to 'idle' — we hold the toast on screen
 * for {@link FADE_OUT_MS} and fade it out, so a quick tap still leaves the
 * "Hold ⌘Q to Quit" hint up long enough to read.
 */
export function useHoldToQuit(): HoldToQuitState {
  const [phase, setPhase] = useState<HoldToQuitPhase>('idle')
  const [holdId, setHoldId] = useState(0)
  const phaseRef = useRef<HoldToQuitPhase>('idle')
  const fadeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const backend = getBackend()
    const clearFade = (): void => {
      if (fadeTimer.current) {
        clearTimeout(fadeTimer.current)
        fadeTimer.current = null
      }
    }
    const set = (next: HoldToQuitPhase): void => {
      phaseRef.current = next
      setPhase(next)
    }
    const offStart = backend.onHoldToQuitStart(() => {
      clearFade()
      setHoldId((n) => n + 1)
      set('holding')
    })
    const offCancel = backend.onHoldToQuitCancel(() => {
      if (phaseRef.current !== 'holding') return // already fading/idle
      set('fading')
      fadeTimer.current = setTimeout(() => {
        fadeTimer.current = null
        set('idle')
      }, FADE_OUT_MS)
    })
    return () => {
      offStart()
      offCancel()
      clearFade()
    }
  }, [])

  return { phase, holdId }
}

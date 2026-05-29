import { useEffect, useState } from 'react'
import { getBackend } from '../backend'

/**
 * Chrome-style "Hold ⌘Q to Quit".
 *
 * The entire gesture — keydown/keyup detection and the hold timer — lives
 * in the MAIN process (desktop-shell.ts, via `before-input-event`) so it
 * works even when an embedded browser tab is focused. This hook is purely
 * a view binding: it mirrors the main-driven start/cancel signals into
 * render state so App can show the overlay. In the web client these
 * signals never fire, so it stays inert.
 */
export function useHoldToQuit(): boolean {
  const [holding, setHolding] = useState(false)

  useEffect(() => {
    const backend = getBackend()
    const offStart = backend.onHoldToQuitStart(() => setHolding(true))
    const offCancel = backend.onHoldToQuitCancel(() => setHolding(false))
    return () => {
      offStart()
      offCancel()
    }
  }, [])

  return holding
}

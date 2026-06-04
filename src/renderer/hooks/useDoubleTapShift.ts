import { useEffect, useRef } from 'react'

// Detects a double-tap of the Shift key — press, release, press, release —
// within a short window with nothing else pressed in between, and fires
// `onDoubleTap`. Modeled on the IDE "double-shift" gesture.
//
// "Lone Shift" only: auto-repeat, Shift held alongside another modifier, or
// any non-Shift keydown all reset the sequence, so it never fires mid-typing
// (you're always pressing other keys then). Times off `event.timeStamp`
// (a monotonic DOMHighResTimeStamp) rather than the clock.
const WINDOW_MS = 300

export function useDoubleTapShift(onDoubleTap: () => void): void {
  const cbRef = useRef(onDoubleTap)
  cbRef.current = onDoubleTap

  useEffect(() => {
    // A lone Shift is down and nothing has broken the sequence yet.
    let armed = false
    // Timestamp of the previous completed lone-Shift tap (0 = none pending).
    let lastTapUp = 0

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Shift') {
        // Ignore key-repeat and Shift combined with another modifier.
        if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) {
          armed = false
          lastTapUp = 0
        } else {
          armed = true
        }
        return
      }
      // Any other key breaks an in-flight double-tap.
      armed = false
      lastTapUp = 0
    }

    const onKeyUp = (e: KeyboardEvent): void => {
      if (e.key !== 'Shift') return
      if (!armed) {
        lastTapUp = 0
        return
      }
      armed = false
      if (lastTapUp && e.timeStamp - lastTapUp <= WINDOW_MS) {
        lastTapUp = 0
        cbRef.current()
      } else {
        lastTapUp = e.timeStamp
      }
    }

    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('keyup', onKeyUp, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keyup', onKeyUp, true)
    }
  }, [])
}

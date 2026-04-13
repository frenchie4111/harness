import { useEffect, useState } from 'react'

export function useMetaHeld(): boolean {
  const [held, setHeld] = useState(false)

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (e.metaKey) setHeld(true)
    }
    function onKeyUp(e: KeyboardEvent): void {
      if (!e.metaKey) setHeld(false)
    }
    function onBlur(): void {
      setHeld(false)
    }
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('keyup', onKeyUp, true)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keyup', onKeyUp, true)
      window.removeEventListener('blur', onBlur)
    }
  }, [])

  return held
}

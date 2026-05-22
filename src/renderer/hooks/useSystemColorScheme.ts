import { useEffect, useState } from 'react'

// Tracks the OS color scheme so `themeMode: 'system'` resolves to a concrete
// theme on the renderer side. Headless / remote backends honor the renderer's
// matchMedia by design — the user's local OS, not the server's — see the
// theme plan and CLAUDE.md §"Headless / remote split-brain on System mode".

function getInitialScheme(): 'light' | 'dark' {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return 'dark'
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function useSystemColorScheme(): 'light' | 'dark' {
  const [scheme, setScheme] = useState<'light' | 'dark'>(getInitialScheme)
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mql = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (e: MediaQueryListEvent): void => {
      setScheme(e.matches ? 'dark' : 'light')
    }
    mql.addEventListener('change', onChange)
    return () => {
      mql.removeEventListener('change', onChange)
    }
  }, [])
  return scheme
}

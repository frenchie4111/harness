import { useSyncExternalStore } from 'react'

const MOBILE_BREAKPOINT = 768

interface ViewportSnapshot {
  isMobile: boolean
  isTouch: boolean
  orientation: 'portrait' | 'landscape'
  /** Visible viewport height (excludes the on-screen keyboard when it
   * opens, on browsers that expose visualViewport). Components can read
   * this to keep the active terminal line above the keyboard. */
  viewportHeight: number
}

function readSnapshot(): ViewportSnapshot {
  const w = typeof window !== 'undefined' ? window : null
  if (!w) {
    return { isMobile: false, isTouch: false, orientation: 'landscape', viewportHeight: 0 }
  }
  const width = w.innerWidth || 0
  const visualHeight = w.visualViewport?.height ?? w.innerHeight ?? 0
  const orientation: ViewportSnapshot['orientation'] = width >= w.innerHeight ? 'landscape' : 'portrait'
  return {
    isMobile: width < MOBILE_BREAKPOINT,
    isTouch: 'ontouchstart' in w || (w.navigator?.maxTouchPoints ?? 0) > 0,
    orientation,
    viewportHeight: Math.round(visualHeight)
  }
}

let cached: ViewportSnapshot = readSnapshot()
const listeners = new Set<() => void>()

function refresh(): void {
  const next = readSnapshot()
  if (
    next.isMobile === cached.isMobile &&
    next.isTouch === cached.isTouch &&
    next.orientation === cached.orientation &&
    next.viewportHeight === cached.viewportHeight
  ) {
    return
  }
  cached = next
  for (const l of listeners) l()
}

let scheduled = false
function scheduleRefresh(): void {
  if (scheduled) return
  scheduled = true
  requestAnimationFrame(() => {
    scheduled = false
    refresh()
  })
}

let installed = false
function install(): void {
  if (installed || typeof window === 'undefined') return
  installed = true
  window.addEventListener('resize', scheduleRefresh)
  window.addEventListener('orientationchange', scheduleRefresh)
  window.visualViewport?.addEventListener('resize', scheduleRefresh)
  window.visualViewport?.addEventListener('scroll', scheduleRefresh)
}

function subscribe(cb: () => void): () => void {
  install()
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

function getSnapshot(): ViewportSnapshot {
  return cached
}

const SSR_FALLBACK: ViewportSnapshot = {
  isMobile: false,
  isTouch: false,
  orientation: 'landscape',
  viewportHeight: 0
}

export function useViewport(): ViewportSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, () => SSR_FALLBACK)
}

export function getViewportSnapshot(): ViewportSnapshot {
  return cached
}

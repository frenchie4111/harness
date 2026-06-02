import { useEffect, useRef } from 'react'

// The "Harness" wordmark plus — in dev builds — the active branch, rendered
// as one block. Used in every spot the app title appears (workspace top bar,
// empty-state fallback bar, onboarding), so the wordmark + dev-branch suffix,
// styling, and width are defined exactly once. The width is load-bearing: the
// left sidebar's max width is capped to this block's right edge, so the
// min-width gives the expanded sidebar's toolbar room to fit comfortably.
//
// `onEdge` (when provided) reports the block's right edge in window-x via a
// ResizeObserver — branch name and uiScale both resize the block. Whichever
// bar is on screen (workspace or empty-state) reports, so the cap always
// tracks the title actually visible. Only pass it for the *visible* instance:
// a hidden (display:none) block measures as zero width.
export function AppTitleSegment({
  className,
  onEdge
}: {
  className?: string
  onEdge?: (px: number) => void
}): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = ref.current
    if (!el || !onEdge) return
    const report = (): void => onEdge(el.getBoundingClientRect().right)
    report()
    const ro = new ResizeObserver(report)
    ro.observe(el)
    return () => ro.disconnect()
  }, [onEdge])
  return (
    <div
      ref={ref}
      className={`shrink-0 flex items-center h-full min-w-[17.46rem] px-3 text-sm font-semibold whitespace-nowrap border-r border-border bg-app/40${
        className ? ` ${className}` : ''
      }`}
    >
      <span className="gradient-text">Harness</span>
      {import.meta.env.DEV && __HARNESS_DEV_BRANCH__ && (
        <span className="text-faint font-normal text-xs ml-1">({__HARNESS_DEV_BRANCH__})</span>
      )}
    </div>
  )
}

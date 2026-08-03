// The "Harness" wordmark plus — in dev builds — the active branch, rendered
// as one block. Used in every spot the app title appears (above the sidebar,
// workspace top bar when sidebar is hidden, empty-state fallback bar,
// onboarding), so the wordmark + dev-branch suffix and styling are defined
// exactly once.
//
// `fillParent` lets the parent control width — used above the sidebar so the
// title segment's right edge lines up with the sidebar's right edge. Without
// it, the segment has a fixed min-width sized to fit the dev-branch suffix
// comfortably (used in the top-bar / fallback / onboarding spots).
export function AppTitleSegment({
  className,
  fillParent = false
}: {
  className?: string
  fillParent?: boolean
}): JSX.Element {
  const sizing = fillParent
    ? 'flex-1 min-w-0'
    : 'shrink-0 min-w-[17.46rem] border-r border-border'
  return (
    <div
      className={`${sizing} flex items-center h-full px-3 text-sm font-semibold whitespace-nowrap bg-app/40${
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

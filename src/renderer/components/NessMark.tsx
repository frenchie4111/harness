// The Ness mark, as renderer-side artwork. resources/icon.svg is the master
// (every raster icon is generated from it by scripts/build-icons.sh); this is
// the same three paths for use inside the app. If the mark ever changes, both
// have to move together.
//
// Path data lives here rather than being pasted at each callsite — it was
// already duplicated between the app icon and the tool-card icon, and a third
// copy in the title bar is where that starts going wrong.

export const NESS_MARK_PATHS = [
  'M7.6 38C8.1 33.4 10.6 30.6 14.4 30.8C18.1 31 20.6 33.8 21.6 38Z',
  'M19.4 38C20.4 32.4 23.3 28.2 27.8 27.9C32.6 27.6 36 31.4 37.4 38Z',
  'M39.4 38C38.9 30.2 39 22.4 41 17.8C43.1 13 47.7 10.4 51.6 11.6C55 12.7 56.8 15.4 56.5 17.9C56.2 20.2 53.5 21.2 50.3 20.9C48 20.7 47 22.2 47.3 25.2C47.7 29.6 48.5 33.7 49.4 38Z'
]

// viewBox is the mark's own bounding box (x 7.6–56.8, y 10.4–38) plus a little
// air, not the 0 0 64 64 the paths were authored in — otherwise the art floats
// in the dead space above and below the creature and sizing it by height gets
// unpredictable. Roughly 1.68:1, so give it a height and let width follow.
export function NessMark({ className }: { className?: string }): JSX.Element {
  return (
    <svg
      viewBox="5.6 8.4 53.2 31.6"
      className={className}
      fill="currentColor"
      aria-hidden="true"
    >
      {NESS_MARK_PATHS.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  )
}

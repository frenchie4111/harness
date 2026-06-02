/**
 * Translucent "Hold ⌘Q to Quit" toast, anchored upper-center. Mounted
 * by App while {@link useHoldToQuit} reports a non-idle phase. App `key`s
 * it by holdId so the fill animation restarts cleanly on every fresh hold.
 * The fill duration is set in CSS (`.hold-to-quit-fill`) to match
 * HOLD_TO_QUIT_MS; on cancel App passes `fading` so the toast lingers and
 * fades (`.hold-to-quit-toast.is-fading`) instead of vanishing — a quick
 * ⌘Q tap still leaves the hint up long enough to read.
 */
export function HoldToQuitOverlay({ fading = false }: { fading?: boolean }): React.JSX.Element {
  return (
    <div className="fixed inset-x-0 top-24 z-[2000] flex justify-center pointer-events-none">
      <div
        className={`hold-to-quit-toast${fading ? ' is-fading' : ''} flex flex-col items-center gap-2 rounded-xl bg-black/75 px-5 py-3 shadow-lg backdrop-blur-md`}
      >
        <div className="text-sm text-white/90">
          Hold{' '}
          <kbd className="rounded border border-white/30 bg-white/10 px-1.5 py-0.5 text-xs font-medium">
            ⌘Q
          </kbd>{' '}
          to Quit
        </div>
        <div className="h-1 w-40 overflow-hidden rounded-full bg-white/20">
          <div className="hold-to-quit-fill h-full rounded-full bg-white/85" />
        </div>
      </div>
    </div>
  )
}

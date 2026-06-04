import { useEffect } from 'react'

interface ConfirmCloseTabModalProps {
  /** Tab label, shown so the user knows which tab they're about to kill. */
  tabLabel: string
  /** Why the tab is considered busy, e.g. "still working" / "running a
   * process" — completes the sentence "<label> is <reason>." */
  reason: string
  onConfirm: () => void
  onCancel: () => void
}

/**
 * Guard shown when ⌘W (or a tab's × button) would close a tab that's still
 * running — an agent mid-turn or a shell with a live process. Catches the
 * common ⌘W-meant-for-⌘Q fat-finger from killing work by accident. Esc /
 * backdrop cancel; Enter (or a second ⌘W) confirms the close.
 */
export function ConfirmCloseTabModal({
  tabLabel,
  reason,
  onConfirm,
  onCancel
}: ConfirmCloseTabModalProps): JSX.Element {
  // Capture phase: when focus is inside an xterm terminal, xterm's own keydown
  // handler stops propagation of Enter/Esc before they bubble to window, so a
  // bubble-phase listener never fires unless the user first clicks the dialog.
  // Listening in the capture phase intercepts the keys on the way down — before
  // xterm sees them — and stopPropagation keeps the keystroke out of the PTY.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onCancel()
      } else if (e.key === 'Enter') {
        e.preventDefault()
        e.stopPropagation()
        onConfirm()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onConfirm, onCancel])

  return (
    <div
      className="fixed inset-0 z-[70] flex items-start justify-center pt-[15vh] bg-black/40"
      onClick={onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-close-tab-title"
        className="w-full max-w-md bg-surface rounded-xl shadow-2xl border border-border overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-3.5 border-b border-border">
          <h2 id="confirm-close-tab-title" className="text-sm font-semibold text-fg-bright">
            Close this tab?
          </h2>
        </div>
        <div className="px-5 py-4 text-sm text-fg">
          <span className="font-medium text-fg-bright">{tabLabel}</span> is {reason}.
          Closing the tab will stop it.
        </div>
        <div className="px-5 py-3 border-t border-border flex items-center justify-end gap-2">
          <button
            onClick={onCancel}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-dim hover:text-fg cursor-pointer transition-colors"
          >
            Cancel
            <kbd className="text-xs text-faint bg-bg px-1.5 py-0.5 rounded border border-border font-mono">
              Esc
            </kbd>
          </button>
          <button
            autoFocus
            onClick={onConfirm}
            className="flex items-center gap-1.5 px-4 py-1.5 text-xs font-medium rounded bg-accent/20 hover:bg-accent/30 text-fg-bright border border-accent/40 cursor-pointer transition-colors"
          >
            Close tab
            <kbd className="text-xs text-fg-bright bg-bg px-1.5 py-0.5 rounded border border-border font-mono">
              ↵
            </kbd>
          </button>
        </div>
      </div>
    </div>
  )
}

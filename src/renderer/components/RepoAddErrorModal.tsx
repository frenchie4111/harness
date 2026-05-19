import { useEffect } from 'react'

interface RepoAddErrorModalProps {
  message: string
  onDismiss: () => void
}

export function RepoAddErrorModal({
  message,
  onDismiss
}: RepoAddErrorModalProps): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' || e.key === 'Enter') {
        e.preventDefault()
        onDismiss()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onDismiss])

  return (
    <div
      className="fixed inset-0 z-[70] flex items-start justify-center pt-[15vh] bg-black/40"
      onClick={onDismiss}
    >
      <div
        className="w-full max-w-md bg-surface rounded-xl shadow-2xl border border-border overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-3.5 border-b border-border">
          <h2 className="text-sm font-semibold text-fg-bright">Can't add repository</h2>
        </div>
        <div className="px-5 py-4 text-sm text-fg break-all">{message}</div>
        <div className="px-5 py-3 border-t border-border flex items-center justify-end gap-2">
          <button
            onClick={onDismiss}
            className="px-4 py-1.5 text-xs font-medium rounded bg-accent/20 hover:bg-accent/30 text-fg-bright border border-accent/40 cursor-pointer transition-colors"
          >
            OK
          </button>
        </div>
      </div>
    </div>
  )
}

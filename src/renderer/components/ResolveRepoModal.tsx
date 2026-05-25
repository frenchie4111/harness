import { useEffect } from 'react'
import { AlertTriangle, FolderTree, X } from 'lucide-react'

interface ResolveRepoModalProps {
  picked: string
  resolved: string
  onConfirm: () => void
  onCancel: () => void
}

/** Shown when the user picked a folder that isn't itself a git repo, but
 *  git's upward discovery found a real repo at an ancestor (often
 *  `$HOME`). Surfaces both paths so the user can confirm they actually
 *  want to manage the resolved repo — otherwise we'd silently register
 *  whatever ancestor happens to be a repo. */
export function ResolveRepoModal({
  picked,
  resolved,
  onConfirm,
  onCancel
}: ResolveRepoModalProps): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
      } else if (e.key === 'Enter') {
        e.preventDefault()
        onConfirm()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel, onConfirm])

  return (
    <div
      className="fixed inset-0 z-[70] flex items-start justify-center pt-[15vh] bg-black/40"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-lg bg-surface rounded-xl shadow-2xl border border-border overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-border">
          <div className="flex items-center gap-2">
            <AlertTriangle size={14} className="text-warning" />
            <h2 className="text-sm font-semibold text-fg-bright">
              Folder isn't a git repository
            </h2>
          </div>
          <button
            onClick={onCancel}
            title="Cancel (Esc)"
            className="text-dim hover:text-fg p-1 rounded transition-colors cursor-pointer"
          >
            <X size={16} />
          </button>
        </div>

        <div className="px-5 py-4 flex flex-col gap-3 text-sm text-fg">
          <p className="text-dim">
            The folder you picked doesn't have a <code className="text-fg-bright">.git</code>{' '}
            of its own, but it's inside a git repository. Add the repository at the resolved
            path instead?
          </p>

          <div className="flex flex-col gap-2">
            <div className="text-xs uppercase tracking-wide text-faint">You picked</div>
            <div className="flex items-start gap-2 bg-app/40 border border-border rounded px-2.5 py-2 font-mono text-xs text-dim break-all">
              <FolderTree size={12} className="text-faint shrink-0 mt-0.5" />
              {picked}
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <div className="text-xs uppercase tracking-wide text-faint">Resolved repository</div>
            <div className="flex items-start gap-2 bg-app/40 border border-accent/40 rounded px-2.5 py-2 font-mono text-xs text-fg-bright break-all">
              <FolderTree size={12} className="text-accent shrink-0 mt-0.5" />
              {resolved}
            </div>
          </div>
        </div>

        <div className="px-5 py-3 border-t border-border flex items-center justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-xs text-dim hover:text-fg cursor-pointer transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="px-4 py-1.5 text-xs font-medium rounded bg-accent/20 hover:bg-accent/30 text-fg-bright border border-accent/40 cursor-pointer transition-colors"
          >
            Add resolved repository
          </button>
        </div>
      </div>
    </div>
  )
}

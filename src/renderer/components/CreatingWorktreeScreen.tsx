import { AlertCircle } from 'lucide-react'
import type { PendingWorktree } from '../types'

interface CreatingWorktreeScreenProps {
  pending: PendingWorktree
  onRetry: (id: string) => void
  onDismiss: (id: string) => void
}

function Loader(): JSX.Element {
  return (
    <div className="claude-loader" aria-label="Creating worktree">
      <div className="claude-loader-halo" />
      <div className="claude-loader-pulser">
        <div className="claude-loader-rotator">
          <svg viewBox="0 0 56 56" width="56" height="56">
            <defs>
              <linearGradient id="creatingWtGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="#f59e0b" />
                <stop offset="55%" stopColor="#ef4444" />
                <stop offset="100%" stopColor="#a855f7" />
              </linearGradient>
            </defs>
            <g fill="url(#creatingWtGrad)" transform="translate(28 28)">
              {[0, 45, 90, 135].map((deg) => (
                <path
                  key={deg}
                  d="M 0 -24 Q 3 0 0 24 Q -3 0 0 -24 Z"
                  transform={`rotate(${deg})`}
                />
              ))}
            </g>
          </svg>
        </div>
      </div>
    </div>
  )
}

export function CreatingWorktreeScreen({
  pending,
  onRetry,
  onDismiss
}: CreatingWorktreeScreenProps): JSX.Element {
  if (pending.status === 'error') {
    return (
      <div className="flex-1 min-w-0 flex items-center justify-center p-8">
        <div className="max-w-md w-full bg-panel-raised border border-border-strong rounded-lg p-6">
          <div className="flex items-center gap-2 mb-3">
            <AlertCircle size={18} className="text-danger" />
            <div className="text-sm font-semibold text-fg-bright">
              Couldn't create <span className="font-mono">{pending.branchName}</span>
            </div>
          </div>
          {pending.error && (
            <pre className="text-xs text-muted bg-app rounded p-3 mb-4 whitespace-pre-wrap break-words max-h-64 overflow-auto">
              {pending.error}
            </pre>
          )}
          <div className="flex gap-2 justify-end">
            <button
              onClick={() => onDismiss(pending.id)}
              className="text-xs text-dim hover:text-fg px-3 py-1.5 transition-colors cursor-pointer"
            >
              Dismiss
            </button>
            <button
              onClick={() => onRetry(pending.id)}
              className="text-xs bg-accent hover:opacity-90 rounded px-3 py-1.5 text-app font-semibold transition-opacity cursor-pointer"
            >
              Retry
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 min-w-0 flex flex-col items-center justify-center gap-4">
      <Loader />
      <div className="text-sm text-muted">
        Creating worktree <span className="font-mono text-fg">{pending.branchName}</span>…
      </div>
    </div>
  )
}

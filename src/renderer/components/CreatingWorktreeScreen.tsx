import { useEffect, useRef, useState } from 'react'
import { AlertCircle, ChevronDown, ChevronRight, Terminal as TerminalIcon } from 'lucide-react'
import type { PendingWorktree } from '../types'

interface CreatingWorktreeScreenProps {
  pending: PendingWorktree
  onRetry: (id: string) => void
  onDismiss: (id: string) => void
  onContinue: (id: string) => void
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

function SetupLogViewer({ log }: { log: string }): JSX.Element {
  const ref = useRef<HTMLPreElement>(null)
  useEffect(() => {
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
  }, [log])
  return (
    <pre
      ref={ref}
      className="text-[11px] leading-snug text-muted bg-app border border-border rounded p-3 whitespace-pre-wrap break-words max-h-72 overflow-auto font-mono"
    >
      {log || <span className="text-faint">Waiting for output…</span>}
    </pre>
  )
}

export function CreatingWorktreeScreen({
  pending,
  onRetry,
  onDismiss,
  onContinue
}: CreatingWorktreeScreenProps): JSX.Element {
  const [logsOpen, setLogsOpen] = useState(true)

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

  if (pending.status === 'setup-failed') {
    return (
      <div className="flex-1 min-w-0 flex items-center justify-center p-8">
        <div className="max-w-2xl w-full bg-panel-raised border border-border-strong rounded-lg p-6">
          <div className="flex items-center gap-2 mb-1">
            <AlertCircle size={18} className="text-warning" />
            <div className="text-sm font-semibold text-fg-bright">
              Setup script failed
              {typeof pending.setupExitCode === 'number' && (
                <span className="text-dim font-normal"> (exit {pending.setupExitCode})</span>
              )}
            </div>
          </div>
          <p className="text-xs text-dim mb-3">
            <span className="font-mono text-fg">{pending.branchName}</span> was
            created successfully, but the setup command didn't exit cleanly. You
            can continue into the worktree or dismiss this screen.
          </p>
          <SetupLogViewer log={pending.setupLog || ''} />
          <div className="flex gap-2 justify-end mt-4">
            <button
              onClick={() => onDismiss(pending.id)}
              className="text-xs text-dim hover:text-fg px-3 py-1.5 transition-colors cursor-pointer"
            >
              Dismiss
            </button>
            <button
              onClick={() => onContinue(pending.id)}
              className="text-xs bg-accent hover:opacity-90 rounded px-3 py-1.5 text-app font-semibold transition-opacity cursor-pointer"
            >
              Continue anyway
            </button>
          </div>
        </div>
      </div>
    )
  }

  const inSetup = pending.status === 'setup'

  return (
    <div className="flex-1 min-w-0 flex flex-col items-center justify-center gap-4 p-8">
      <Loader />
      <div className="text-sm text-muted text-center">
        {inSetup ? (
          <>
            Running setup for <span className="font-mono text-fg">{pending.branchName}</span>…
          </>
        ) : (
          <>
            Creating worktree <span className="font-mono text-fg">{pending.branchName}</span>…
          </>
        )}
      </div>
      {inSetup && (
        <div className="w-full max-w-2xl">
          <button
            onClick={() => setLogsOpen((v) => !v)}
            className="flex items-center gap-1.5 text-xs text-dim hover:text-fg transition-colors cursor-pointer mb-2"
          >
            {logsOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <TerminalIcon size={12} />
            {logsOpen ? 'Hide setup logs' : 'Show setup logs'}
          </button>
          {logsOpen && <SetupLogViewer log={pending.setupLog || ''} />}
        </div>
      )}
    </div>
  )
}

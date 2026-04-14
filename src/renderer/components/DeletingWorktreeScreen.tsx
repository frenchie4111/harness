import { useState } from 'react'
import { AlertCircle, ChevronDown, ChevronRight, Terminal as TerminalIcon } from 'lucide-react'
import type { PendingDeletion } from '../types'
import { PendingLoader, ScriptLogViewer } from './PendingScreenParts'

interface DeletingWorktreeScreenProps {
  deletion: PendingDeletion
  onDismiss: (path: string) => void
}

export function DeletingWorktreeScreen({
  deletion,
  onDismiss
}: DeletingWorktreeScreenProps): JSX.Element {
  const [logsOpen, setLogsOpen] = useState(true)

  if (deletion.phase === 'failed') {
    return (
      <div className="flex-1 min-w-0 flex items-center justify-center p-8">
        <div className="max-w-2xl w-full bg-panel-raised border border-border-strong rounded-lg p-6">
          <div className="flex items-center gap-2 mb-1">
            <AlertCircle size={18} className="text-danger" />
            <div className="text-sm font-semibold text-fg-bright">
              Couldn't delete <span className="font-mono">{deletion.branch || deletion.path}</span>
            </div>
          </div>
          <p className="text-xs text-dim mb-3">
            Something failed while tearing down the worktree. The directory
            may still exist on disk — try again once you've resolved the
            underlying issue.
          </p>
          {deletion.error && (
            <pre className="text-xs text-muted bg-app rounded p-3 mb-3 whitespace-pre-wrap break-words max-h-48 overflow-auto">
              {deletion.error}
            </pre>
          )}
          {deletion.teardownLog !== undefined && (
            <ScriptLogViewer log={deletion.teardownLog} />
          )}
          <div className="flex gap-2 justify-end mt-4">
            <button
              onClick={() => onDismiss(deletion.path)}
              className="text-xs bg-accent hover:opacity-90 rounded px-3 py-1.5 text-app font-semibold transition-opacity cursor-pointer"
            >
              Dismiss
            </button>
          </div>
        </div>
      </div>
    )
  }

  const phaseLabel =
    deletion.phase === 'running-teardown'
      ? 'Running teardown script…'
      : 'Removing worktree…'

  return (
    <div className="flex-1 min-w-0 flex flex-col items-center justify-center gap-4 p-8">
      <PendingLoader label="Deleting worktree" />
      <div className="text-sm text-muted text-center">
        {phaseLabel}{' '}
        <span className="font-mono text-fg">{deletion.branch || deletion.path}</span>
      </div>
      {deletion.teardownLog !== undefined && (
        <div className="w-full max-w-2xl">
          <button
            onClick={() => setLogsOpen((v) => !v)}
            className="flex items-center gap-1.5 text-xs text-dim hover:text-fg transition-colors cursor-pointer mb-2"
          >
            {logsOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <TerminalIcon size={12} />
            {logsOpen ? 'Hide teardown logs' : 'Show teardown logs'}
          </button>
          {logsOpen && <ScriptLogViewer log={deletion.teardownLog} />}
        </div>
      )}
    </div>
  )
}

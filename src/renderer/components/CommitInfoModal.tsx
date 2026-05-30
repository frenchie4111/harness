import { useEffect, useState } from 'react'
import { GitCommitHorizontal, Copy, Check, X, Loader2 } from 'lucide-react'
import { getBackend } from '../backend'
import type { ChangedFile, CommitMeta } from '../types'

interface CommitInfoModalProps {
  worktreePath: string
  /** Full or abbreviated SHA to render. */
  sha: string
  /** Viewport coordinates of the click, used to anchor the popover. */
  anchor: { x: number; y: number }
  onClose: () => void
}

// Popover dimensions used to clamp it inside the viewport.
const POPOVER_WIDTH = 540
const POPOVER_MAX_HEIGHT_FRAC = 0.6

const STATUS_LABEL: Record<ChangedFile['status'], string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  untracked: 'U'
}
const STATUS_COLOR: Record<ChangedFile['status'], string> = {
  added: 'text-success',
  modified: 'text-warning',
  deleted: 'text-danger',
  renamed: 'text-info',
  untracked: 'text-dim'
}

function FileRow({ file }: { file: ChangedFile }): JSX.Element {
  const lastSlash = file.path.lastIndexOf('/')
  const dir = lastSlash >= 0 ? file.path.slice(0, lastSlash + 1) : ''
  const name = lastSlash >= 0 ? file.path.slice(lastSlash + 1) : file.path
  return (
    <div className="flex items-center gap-2 py-0.5 text-xs">
      <span className={`shrink-0 w-3 font-mono ${STATUS_COLOR[file.status]}`}>
        {STATUS_LABEL[file.status]}
      </span>
      <span className="truncate min-w-0 flex-1 font-mono">
        {dir && <span className="text-faint">{dir}</span>}
        <span className="text-fg">{name}</span>
      </span>
      {(file.additions || file.deletions) && (
        <span className="shrink-0 font-mono tabular-nums">
          {file.additions ? <span className="text-success">+{file.additions}</span> : null}
          {file.deletions ? <span className="text-danger ml-1">−{file.deletions}</span> : null}
        </span>
      )}
    </div>
  )
}

export function CommitInfoModal({
  worktreePath,
  sha,
  anchor,
  onClose
}: CommitInfoModalProps): JSX.Element {
  const [meta, setMeta] = useState<CommitMeta | null>(null)
  const [files, setFiles] = useState<ChangedFile[]>([])
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let cancelled = false
    setState('loading')
    const backend = getBackend()
    void Promise.all([
      backend.getCommitMeta(worktreePath, sha),
      backend.getCommitChangedFiles(worktreePath, sha)
    ])
      .then(([m, f]) => {
        if (cancelled) return
        if (m) {
          setMeta(m)
          setFiles(f)
          setState('ready')
        } else {
          setState('error')
        }
      })
      .catch(() => {
        if (!cancelled) setState('error')
      })
    return () => {
      cancelled = true
    }
  }, [worktreePath, sha])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        // Consume it: the terminal still has focus, so without stopping
        // propagation the Escape would also be sent to the agent/PTY.
        e.stopPropagation()
        onClose()
      }
    }
    // Capture phase: xterm's textarea handler calls stopPropagation() on keys
    // it handles (Escape → \x1b), so a bubble-phase listener never fires while
    // the terminal is focused. Capturing runs us first.
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const copySha = (): void => {
    const full = meta?.hash ?? sha
    void navigator.clipboard?.writeText(full).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    })
  }

  const shortSha = meta?.shortHash ?? sha.slice(0, 10)

  // Anchor below-right of the click, clamped into the viewport.
  const maxHeight = Math.round(window.innerHeight * POPOVER_MAX_HEIGHT_FRAC)
  const left = Math.max(8, Math.min(anchor.x, window.innerWidth - POPOVER_WIDTH - 8))
  const top = Math.max(8, Math.min(anchor.y + 10, window.innerHeight - maxHeight - 8))

  return (
    // Transparent full-screen catcher: any click outside the popover closes it.
    <div className="fixed inset-0 z-[70]" onClick={onClose}>
      <div
        className="fixed bg-panel-raised border border-border-strong rounded-lg shadow-xl overflow-hidden flex flex-col"
        style={{ left, top, width: POPOVER_WIDTH, maxHeight }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-3 py-2 border-b border-border flex items-center gap-2 shrink-0">
          <GitCommitHorizontal className="icon-sm text-accent shrink-0" />
          <button
            onClick={copySha}
            title="Copy full SHA"
            className="flex items-center gap-1 text-xs font-mono text-fg hover:text-fg-bright cursor-pointer shrink-0"
          >
            {shortSha}
            {copied ? (
              <Check className="icon-2xs text-success" />
            ) : (
              <Copy className="icon-2xs opacity-60" />
            )}
          </button>
          {state === 'ready' && meta && (
            <span className="text-xs font-medium text-fg-bright truncate min-w-0">
              {meta.subject}
            </span>
          )}
          <button
            onClick={onClose}
            title="Close"
            className="ml-auto p-0.5 rounded hover:bg-surface-hover text-faint hover:text-fg-bright cursor-pointer shrink-0"
          >
            <X className="icon-xs" />
          </button>
        </div>

        {state === 'loading' && (
          <div className="px-3 py-6 flex items-center justify-center gap-2 text-xs text-faint">
            <Loader2 className="icon-xs animate-spin" />
            Loading…
          </div>
        )}

        {state === 'error' && (
          <div className="px-3 py-6 text-xs text-faint text-center">
            Couldn't load commit <span className="font-mono text-fg">{sha}</span>.
          </div>
        )}

        {state === 'ready' && meta && (
          <div className="overflow-y-auto flex flex-col min-h-0">
            <div className="px-3 py-1.5 border-b border-border text-xs text-faint shrink-0 truncate">
              <span className="text-fg">{meta.author}</span>
              {meta.date && <span> · {new Date(meta.date).toLocaleString()}</span>}
            </div>
            {meta.body.trim() !== '' && (
              <div className="px-3 py-1.5 border-b border-border text-xs text-fg whitespace-pre-wrap shrink-0">
                {meta.body.trim()}
              </div>
            )}
            <div className="px-3 py-2">
              <div className="text-xs text-faint mb-1">
                {files.length} {files.length === 1 ? 'file' : 'files'} changed
              </div>
              {files.map((file) => (
                <FileRow key={file.path} file={file} />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

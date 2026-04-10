import { useState, useEffect, useCallback } from 'react'
import { RefreshCw, FileEdit, GitBranch, Code2 } from 'lucide-react'
import type { ChangedFile } from '../types'

type Mode = 'working' | 'branch'

interface ChangedFilesPanelProps {
  worktreePath: string | null
  onOpenDiff: (filePath: string, staged: boolean, mode: Mode) => void
}

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

export function ChangedFilesPanel({ worktreePath, onOpenDiff }: ChangedFilesPanelProps): JSX.Element {
  const [files, setFiles] = useState<ChangedFile[]>([])
  const [loading, setLoading] = useState(false)
  const [mode, setMode] = useState<Mode>('working')

  const refresh = useCallback(async () => {
    if (!worktreePath) return
    setLoading(true)
    try {
      const result = await window.api.getChangedFiles(worktreePath, mode)
      setFiles(result)
    } catch (err) {
      console.error('Failed to get changed files:', err)
      setFiles([])
    } finally {
      setLoading(false)
    }
  }, [worktreePath, mode])

  useEffect(() => {
    refresh()
    // Poll for changes every 3 seconds
    const interval = setInterval(refresh, 3000)
    return () => clearInterval(interval)
  }, [refresh])

  const stagedFiles = files.filter((f) => f.staged)
  const unstagedFiles = files.filter((f) => !f.staged)

  return (
    <div className="flex flex-col h-full bg-panel">
      {/* Header */}
      <div className="drag-region flex items-center justify-between h-10 px-3 border-b border-border shrink-0 gap-2">
        <span className="no-drag text-xs font-medium text-muted uppercase tracking-wide">
          Changed Files
        </span>
        <div className="no-drag flex items-center gap-2">
          <div className="flex items-center rounded border border-border-strong bg-panel-raised/50 p-0.5">
            <button
              onClick={() => setMode('working')}
              className={`flex items-center rounded px-1.5 py-0.5 transition-colors cursor-pointer ${
                mode === 'working' ? 'bg-surface text-fg' : 'text-faint hover:text-fg'
              }`}
              title="Working tree — uncommitted staged, unstaged, and untracked changes"
            >
              <FileEdit size={12} />
            </button>
            <button
              onClick={() => setMode('branch')}
              className={`flex items-center rounded px-1.5 py-0.5 transition-colors cursor-pointer ${
                mode === 'branch' ? 'bg-surface text-fg' : 'text-faint hover:text-fg'
              }`}
              title="Branch diff — all files this branch changes vs. the base branch (same as the PR)"
            >
              <GitBranch size={12} />
            </button>
          </div>
          <button
            onClick={refresh}
            className="text-faint hover:text-fg transition-colors cursor-pointer"
            title="Refresh"
          >
            <RefreshCw size={12} />
          </button>
        </div>
      </div>

      {/* File list */}
      <div className="flex-1 overflow-y-auto min-h-0 text-xs">
        {!worktreePath && (
          <div className="p-3 text-faint">No worktree selected</div>
        )}

        {worktreePath && files.length === 0 && !loading && (
          <div className="p-3 text-faint">
            {mode === 'branch' ? 'No commits on this branch yet' : 'No changes'}
          </div>
        )}

        {mode === 'branch' && files.length > 0 && (
          <div>
            {files.map((file) => (
              <FileRow
                key={`branch-${file.path}`}
                file={file}
                worktreePath={worktreePath}
                onClick={() => onOpenDiff(file.path, false, 'branch')}
              />
            ))}
          </div>
        )}

        {mode === 'working' && stagedFiles.length > 0 && (
          <div>
            <div className="px-3 py-1.5 text-[10px] font-medium text-dim uppercase tracking-wider bg-panel-raised/50">
              Staged
            </div>
            {stagedFiles.map((file) => (
              <FileRow
                key={`staged-${file.path}`}
                file={file}
                worktreePath={worktreePath}
                onClick={() => onOpenDiff(file.path, true, 'working')}
              />
            ))}
          </div>
        )}

        {mode === 'working' && unstagedFiles.length > 0 && (
          <div>
            <div className="px-3 py-1.5 text-[10px] font-medium text-dim uppercase tracking-wider bg-panel-raised/50">
              {stagedFiles.length > 0 ? 'Unstaged' : 'Changes'}
            </div>
            {unstagedFiles.map((file) => (
              <FileRow
                key={`unstaged-${file.path}`}
                file={file}
                worktreePath={worktreePath}
                onClick={() => onOpenDiff(file.path, false, 'working')}
              />
            ))}
          </div>
        )}
      </div>

      {/* Footer summary */}
      {files.length > 0 && (
        <div className="px-3 py-1.5 border-t border-border text-[10px] text-faint shrink-0">
          {files.length} file{files.length !== 1 ? 's' : ''} changed
        </div>
      )}
    </div>
  )
}

function FileRow({
  file,
  worktreePath,
  onClick
}: {
  file: ChangedFile
  worktreePath: string | null
  onClick: () => void
}): JSX.Element {
  // Show just the filename, with directory path dimmed
  const lastSlash = file.path.lastIndexOf('/')
  const dir = lastSlash >= 0 ? file.path.slice(0, lastSlash + 1) : ''
  const name = lastSlash >= 0 ? file.path.slice(lastSlash + 1) : file.path

  return (
    <div className="flex items-center gap-2 px-3 py-1 hover:bg-panel-raised cursor-pointer group" onClick={onClick}>
      <span className={`shrink-0 w-3 font-mono ${STATUS_COLOR[file.status]}`}>
        {STATUS_LABEL[file.status]}
      </span>
      <span className="truncate min-w-0 flex-1">
        {dir && <span className="text-faint">{dir}</span>}
        <span className="text-fg">{name}</span>
      </span>
      {worktreePath && (
        <button
          onClick={(e) => {
            e.stopPropagation()
            window.api.openInEditor(worktreePath, file.path)
          }}
          className="shrink-0 opacity-0 group-hover:opacity-100 text-faint hover:text-fg transition-all cursor-pointer"
          title="Open file in editor"
        >
          <Code2 size={11} />
        </button>
      )}
    </div>
  )
}

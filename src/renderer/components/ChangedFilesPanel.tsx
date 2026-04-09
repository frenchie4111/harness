import { useState, useEffect, useCallback } from 'react'
import type { ChangedFile } from '../types'

interface ChangedFilesPanelProps {
  worktreePath: string | null
  onOpenDiff: (filePath: string, staged: boolean) => void
}

const STATUS_LABEL: Record<ChangedFile['status'], string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  untracked: 'U'
}

const STATUS_COLOR: Record<ChangedFile['status'], string> = {
  added: 'text-green-400',
  modified: 'text-amber-400',
  deleted: 'text-red-400',
  renamed: 'text-blue-400',
  untracked: 'text-neutral-500'
}

export function ChangedFilesPanel({ worktreePath, onOpenDiff }: ChangedFilesPanelProps): JSX.Element {
  const [files, setFiles] = useState<ChangedFile[]>([])
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async () => {
    if (!worktreePath) return
    setLoading(true)
    try {
      const result = await window.api.getChangedFiles(worktreePath)
      setFiles(result)
    } catch (err) {
      console.error('Failed to get changed files:', err)
      setFiles([])
    } finally {
      setLoading(false)
    }
  }, [worktreePath])

  useEffect(() => {
    refresh()
    // Poll for changes every 3 seconds
    const interval = setInterval(refresh, 3000)
    return () => clearInterval(interval)
  }, [refresh])

  const stagedFiles = files.filter((f) => f.staged)
  const unstagedFiles = files.filter((f) => !f.staged)

  return (
    <div className="flex flex-col h-full bg-neutral-950">
      {/* Header */}
      <div className="drag-region flex items-center justify-between h-10 px-3 border-b border-neutral-800 shrink-0">
        <span className="no-drag text-xs font-medium text-neutral-400 uppercase tracking-wide">
          Changed Files
        </span>
        <button
          onClick={refresh}
          className="no-drag text-neutral-600 hover:text-neutral-300 text-xs transition-colors cursor-pointer"
          title="Refresh"
        >
          ↻
        </button>
      </div>

      {/* File list */}
      <div className="flex-1 overflow-y-auto min-h-0 text-xs">
        {!worktreePath && (
          <div className="p-3 text-neutral-600">No worktree selected</div>
        )}

        {worktreePath && files.length === 0 && !loading && (
          <div className="p-3 text-neutral-600">No changes</div>
        )}

        {stagedFiles.length > 0 && (
          <div>
            <div className="px-3 py-1.5 text-[10px] font-medium text-neutral-500 uppercase tracking-wider bg-neutral-900/50">
              Staged
            </div>
            {stagedFiles.map((file) => (
              <FileRow key={`staged-${file.path}`} file={file} onClick={() => onOpenDiff(file.path, true)} />
            ))}
          </div>
        )}

        {unstagedFiles.length > 0 && (
          <div>
            <div className="px-3 py-1.5 text-[10px] font-medium text-neutral-500 uppercase tracking-wider bg-neutral-900/50">
              {stagedFiles.length > 0 ? 'Unstaged' : 'Changes'}
            </div>
            {unstagedFiles.map((file) => (
              <FileRow key={`unstaged-${file.path}`} file={file} onClick={() => onOpenDiff(file.path, false)} />
            ))}
          </div>
        )}
      </div>

      {/* Footer summary */}
      {files.length > 0 && (
        <div className="px-3 py-1.5 border-t border-neutral-800 text-[10px] text-neutral-600 shrink-0">
          {files.length} file{files.length !== 1 ? 's' : ''} changed
        </div>
      )}
    </div>
  )
}

function FileRow({ file, onClick }: { file: ChangedFile; onClick: () => void }): JSX.Element {
  // Show just the filename, with directory path dimmed
  const lastSlash = file.path.lastIndexOf('/')
  const dir = lastSlash >= 0 ? file.path.slice(0, lastSlash + 1) : ''
  const name = lastSlash >= 0 ? file.path.slice(lastSlash + 1) : file.path

  return (
    <div className="flex items-center gap-2 px-3 py-1 hover:bg-neutral-900 cursor-pointer group" onClick={onClick}>
      <span className={`shrink-0 w-3 font-mono ${STATUS_COLOR[file.status]}`}>
        {STATUS_LABEL[file.status]}
      </span>
      <span className="truncate min-w-0">
        {dir && <span className="text-neutral-600">{dir}</span>}
        <span className="text-neutral-300">{name}</span>
      </span>
    </div>
  )
}

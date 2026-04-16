import { useState, useEffect, useCallback } from 'react'
import { RefreshCw, FileEdit, GitBranch, Code2, AtSign, ClipboardCheck } from 'lucide-react'
import type { ChangedFile } from '../types'
import { Tooltip } from './Tooltip'
import { RightPanel } from './RightPanel'

type Mode = 'working' | 'branch'

interface ChangedFilesPanelProps {
  worktreePath: string | null
  onOpenDiff: (filePath: string, staged: boolean, mode: Mode) => void
  onSendToAgent?: (text: string) => void
  onOpenReview?: (mode: Mode) => void
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

export function ChangedFilesPanel({ worktreePath, onOpenDiff, onSendToAgent, onOpenReview }: ChangedFilesPanelProps): JSX.Element {
  const [files, setFiles] = useState<ChangedFile[]>([])
  const [hasLoaded, setHasLoaded] = useState(false)
  const [mode, setMode] = useState<Mode>('working')

  const refresh = useCallback(async () => {
    if (!worktreePath) return
    try {
      const result = await window.api.getChangedFiles(worktreePath, mode)
      setFiles(result)
    } catch (err) {
      console.error('Failed to get changed files:', err)
      setFiles([])
    } finally {
      setHasLoaded(true)
    }
  }, [worktreePath, mode])

  // Reset loaded flag when the worktree or mode changes so the initial fetch
  // doesn't flash a stale empty state from the previous selection.
  useEffect(() => {
    setHasLoaded(false)
  }, [worktreePath, mode])

  useEffect(() => {
    refresh()
    // Poll for changes every 3 seconds
    const interval = setInterval(refresh, 3000)
    return () => clearInterval(interval)
  }, [refresh])

  const stagedFiles = files.filter((f) => f.staged)
  const unstagedFiles = files.filter((f) => !f.staged)

  const actions = (
    <>
      <div className="flex items-center rounded border border-border-strong bg-panel-raised/50 p-0.5">
        <Tooltip label="Working tree — uncommitted changes">
          <button
            onClick={(e) => {
              e.stopPropagation()
              setMode('working')
            }}
            className={`flex items-center rounded px-1.5 py-0.5 transition-colors cursor-pointer ${
              mode === 'working' ? 'bg-surface text-fg' : 'text-faint hover:text-fg'
            }`}
          >
            <FileEdit size={12} />
          </button>
        </Tooltip>
        <Tooltip label="Branch diff — files changed vs. the base branch (same as the PR)">
          <button
            onClick={(e) => {
              e.stopPropagation()
              setMode('branch')
            }}
            className={`flex items-center rounded px-1.5 py-0.5 transition-colors cursor-pointer ${
              mode === 'branch' ? 'bg-surface text-fg' : 'text-faint hover:text-fg'
            }`}
          >
            <GitBranch size={12} />
          </button>
        </Tooltip>
      </div>
      <Tooltip label="Refresh">
        <button
          onClick={(e) => {
            e.stopPropagation()
            refresh()
          }}
          className="text-faint hover:text-fg transition-colors cursor-pointer"
        >
          <RefreshCw size={12} />
        </button>
      </Tooltip>
      {onOpenReview && files.length > 0 && (
        <button
          onClick={(e) => {
            e.stopPropagation()
            onOpenReview(mode)
          }}
          className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-accent text-fg text-[10px] font-medium hover:bg-accent/80 transition-colors cursor-pointer"
        >
          <ClipboardCheck size={10} />
          Review
        </button>
      )}
    </>
  )

  return (
    <RightPanel id="changed-files" title="Changed Files" actions={actions} grow>
      {/* File list */}
      <div className="flex-1 overflow-y-auto min-h-0 text-xs">
        {!worktreePath && (
          <div className="p-3 text-faint">No worktree selected</div>
        )}

        {worktreePath && files.length === 0 && hasLoaded && (
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
                onSendToAgent={onSendToAgent}
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
                onSendToAgent={onSendToAgent}
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
                onSendToAgent={onSendToAgent}
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
    </RightPanel>
  )
}

function FileRow({
  file,
  worktreePath,
  onClick,
  onSendToAgent
}: {
  file: ChangedFile
  worktreePath: string | null
  onClick: () => void
  onSendToAgent?: (text: string) => void
}): JSX.Element {
  const lastSlash = file.path.lastIndexOf('/')
  const dir = lastSlash >= 0 ? file.path.slice(0, lastSlash + 1) : ''
  const name = lastSlash >= 0 ? file.path.slice(lastSlash + 1) : file.path

  return (
    <div className="flex items-center gap-2 px-3 py-1 hover:bg-panel-raised cursor-pointer group" onClick={onClick}>
      <span className={`shrink-0 w-3 font-mono ${STATUS_COLOR[file.status]}`}>
        {STATUS_LABEL[file.status]}
      </span>
      <Tooltip label={<span className="font-mono">{file.path}</span>} side="top">
        <span className="truncate min-w-0 flex-1" style={{ direction: 'rtl', textAlign: 'left' }}>
          <bdi>
            {dir && <span className="text-faint">{dir}</span>}
            <span className="text-fg">{name}</span>
          </bdi>
        </span>
      </Tooltip>
      {(file.additions !== undefined || file.deletions !== undefined) && (
        <span className="shrink-0 font-mono text-[10px] tabular-nums">
          {file.additions !== undefined && file.additions > 0 && (
            <span className="text-success">+{file.additions}</span>
          )}
          {file.deletions !== undefined && file.deletions > 0 && (
            <span className="text-danger ml-1">−{file.deletions}</span>
          )}
        </span>
      )}
      {onSendToAgent && (
        <Tooltip label="Reference in Claude" side="left">
          <button
            onClick={(e) => {
              e.stopPropagation()
              onSendToAgent(`@${file.path} `)
            }}
            className="shrink-0 opacity-0 group-hover:opacity-100 text-faint hover:text-fg transition-all cursor-pointer"
          >
            <AtSign size={11} />
          </button>
        </Tooltip>
      )}
      {worktreePath && (
        <Tooltip label="Open file in editor" side="left">
          <button
            onClick={(e) => {
              e.stopPropagation()
              window.api.openInEditor(worktreePath, file.path)
            }}
            className="shrink-0 opacity-0 group-hover:opacity-100 text-faint hover:text-fg transition-all cursor-pointer"
          >
            <Code2 size={11} />
          </button>
        </Tooltip>
      )}
    </div>
  )
}

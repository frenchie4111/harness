import { useState, useEffect, useCallback, useRef } from 'react'
import { RefreshCw, Code2, AtSign, ClipboardCheck } from 'lucide-react'
import type { ChangedFile } from '../types'
import { Tooltip } from './Tooltip'
import { RightPanel } from './RightPanel'

type Mode = 'working' | 'branch'

interface ChangedFilesPanelProps {
  worktreePath: string | null
  onOpenDiff: (filePath: string, staged: boolean, mode: Mode) => void
  onSendToAgent?: (text: string) => void
  onOpenReview?: () => void
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
  const [workingFiles, setWorkingFiles] = useState<ChangedFile[]>([])
  const [branchFiles, setBranchFiles] = useState<ChangedFile[]>([])
  const [hasLoaded, setHasLoaded] = useState(false)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  const refresh = useCallback(async () => {
    if (!worktreePath) return
    try {
      const [working, branch] = await Promise.all([
        window.api.getChangedFiles(worktreePath, 'working'),
        window.api.getChangedFiles(worktreePath, 'branch'),
      ])
      if (!mountedRef.current) return
      setWorkingFiles(working)
      setBranchFiles(branch)
    } catch (err) {
      console.error('Failed to get changed files:', err)
      if (!mountedRef.current) return
      setWorkingFiles([])
      setBranchFiles([])
    } finally {
      if (mountedRef.current) setHasLoaded(true)
    }
  }, [worktreePath])

  useEffect(() => {
    setHasLoaded(false)
  }, [worktreePath])

  useEffect(() => {
    refresh()
    const interval = setInterval(refresh, 3000)
    return () => clearInterval(interval)
  }, [refresh])

  const stagedFiles = workingFiles.filter((f) => f.staged)
  const unstagedFiles = workingFiles.filter((f) => !f.staged)
  const totalCount = workingFiles.length + branchFiles.length

  const actions = (
    <>
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
      {onOpenReview && branchFiles.length > 0 && (
        <button
          onClick={(e) => {
            e.stopPropagation()
            onOpenReview()
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
      <div className="flex-1 overflow-y-auto min-h-0 text-xs">
        {!worktreePath && (
          <div className="p-3 text-faint">No worktree selected</div>
        )}

        {worktreePath && hasLoaded && (
          <>
            {/* Uncommitted section */}
            <div className="px-3 py-1.5 text-[10px] font-medium text-dim uppercase tracking-wider bg-panel-raised/50">
              Uncommitted
            </div>
            {workingFiles.length === 0 ? (
              <div className="px-3 py-2 text-faint italic">No changes</div>
            ) : (
              <>
                {stagedFiles.length > 0 && unstagedFiles.length > 0 && (
                  <div className="px-3 py-1 text-[9px] font-medium text-dim uppercase tracking-wider">
                    Staged
                  </div>
                )}
                {stagedFiles.map((file) => (
                  <FileRow
                    key={`staged-${file.path}`}
                    file={file}
                    worktreePath={worktreePath}
                    onClick={() => onOpenDiff(file.path, true, 'working')}
                    onSendToAgent={onSendToAgent}
                  />
                ))}
                {stagedFiles.length > 0 && unstagedFiles.length > 0 && (
                  <div className="px-3 py-1 text-[9px] font-medium text-dim uppercase tracking-wider">
                    Unstaged
                  </div>
                )}
                {unstagedFiles.map((file) => (
                  <FileRow
                    key={`unstaged-${file.path}`}
                    file={file}
                    worktreePath={worktreePath}
                    onClick={() => onOpenDiff(file.path, false, 'working')}
                    onSendToAgent={onSendToAgent}
                  />
                ))}
              </>
            )}

            {/* Branch diff section */}
            <div className="px-3 py-1.5 text-[10px] font-medium text-dim uppercase tracking-wider bg-panel-raised/50 mt-1">
              Committed
            </div>
            {branchFiles.length === 0 ? (
              <div className="px-3 py-2 text-faint italic">No commits on this branch yet</div>
            ) : (
              branchFiles.map((file) => (
                <FileRow
                  key={`branch-${file.path}`}
                  file={file}
                  worktreePath={worktreePath}
                  onClick={() => onOpenDiff(file.path, false, 'branch')}
                  onSendToAgent={onSendToAgent}
                />
              ))
            )}
          </>
        )}
      </div>

      {totalCount > 0 && (
        <div className="px-3 py-1.5 border-t border-border text-[10px] text-faint shrink-0">
          {workingFiles.length > 0 && <span>{workingFiles.length} uncommitted</span>}
          {workingFiles.length > 0 && branchFiles.length > 0 && <span> · </span>}
          {branchFiles.length > 0 && <span>{branchFiles.length} committed</span>}
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

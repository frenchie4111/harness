import { useCallback } from 'react'
import { RefreshCw, Code2, AtSign, ClipboardCheck } from 'lucide-react'
import type { ChangedFile } from '../types'
import { Tooltip } from './Tooltip'
import { RightPanel } from './RightPanel'
import { useWatchedQuery } from '../hooks/useWatchedQuery'
import { useBackend } from '../backend'

type Mode = 'working' | 'branch'

interface ChangedFilesPanelProps {
  worktreePath: string | null
  onOpenDiff: (filePath: string, staged: boolean, mode: Mode) => void
  onSendToAgent?: (text: string) => void
  onOpenReview?: () => void
  /** Open the worktree's Review tab focused on this committed file. */
  onOpenReviewFile?: (filePath: string) => void
  /** Open a file in the in-Harness editor tab (⌘-click on the editor icon). */
  onOpenFile?: (filePath: string) => void
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

interface ChangedFilesData {
  working: ChangedFile[]
  branch: ChangedFile[]
}

export function ChangedFilesPanel({ worktreePath, onOpenDiff, onSendToAgent, onOpenReview, onOpenReviewFile, onOpenFile }: ChangedFilesPanelProps): JSX.Element {
  const backend = useBackend()
  const fetcher = useCallback(async (path: string): Promise<ChangedFilesData> => {
    const [working, branch] = await Promise.all([
      backend.getChangedFiles(path, 'working'),
      backend.getChangedFiles(path, 'branch'),
    ])
    return { working, branch }
  }, [backend])

  const { data, loading, refresh } = useWatchedQuery<ChangedFilesData>({
    worktreePath,
    cacheKey: 'changedFiles',
    fetcher,
  })

  const workingFiles = data?.working ?? []
  const branchFiles = data?.branch ?? []
  const hasLoaded = !loading

  const stagedFiles = workingFiles.filter((f) => f.staged)
  const unstagedFiles = workingFiles.filter((f) => !f.staged)

  const actions = (
    <>
      {onOpenReview && branchFiles.length > 0 && (
        <Tooltip label="Review changes" action="openReview">
          <button
            onClick={(e) => {
              e.stopPropagation()
              onOpenReview()
            }}
            className="flex items-center gap-1.5 px-2 py-1 rounded bg-accent text-app text-xs hover:bg-accent/80 transition-colors cursor-pointer"
          >
            <ClipboardCheck className="icon-xs" />
            Review
          </button>
        </Tooltip>
      )}
      <Tooltip label="Refresh">
        <button
          onClick={(e) => {
            e.stopPropagation()
            refresh()
          }}
          className="text-faint hover:text-fg transition-colors cursor-pointer"
        >
          <RefreshCw className="icon-xs" />
        </button>
      </Tooltip>
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
            <div className="flex items-center justify-between px-3 py-1.5 text-xs font-medium text-dim uppercase tracking-wider bg-panel-raised/50">
              <span>Uncommitted</span>
              {workingFiles.length > 0 && (
                <span className="tabular-nums normal-case">{workingFiles.length}</span>
              )}
            </div>
            {workingFiles.length === 0 ? (
              <div className="px-3 py-2 text-faint italic">No changes</div>
            ) : (
              <>
                {stagedFiles.length > 0 && unstagedFiles.length > 0 && (
                  <div className="px-3 py-1 text-xs font-medium text-dim uppercase tracking-wider">
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
                    onOpenFile={onOpenFile}
                  />
                ))}
                {stagedFiles.length > 0 && unstagedFiles.length > 0 && (
                  <div className="px-3 py-1 text-xs font-medium text-dim uppercase tracking-wider">
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
                    onOpenFile={onOpenFile}
                  />
                ))}
              </>
            )}

            {/* Branch diff section */}
            <div className="flex items-center justify-between px-3 py-1.5 text-xs font-medium text-dim uppercase tracking-wider bg-panel-raised/50 mt-1">
              <span>Committed</span>
              {branchFiles.length > 0 && (
                <span className="tabular-nums normal-case">{branchFiles.length}</span>
              )}
            </div>
            {branchFiles.length === 0 ? (
              <div className="px-3 py-2 text-faint italic">No commits on this branch yet</div>
            ) : (
              branchFiles.map((file) => (
                <FileRow
                  key={`branch-${file.path}`}
                  file={file}
                  worktreePath={worktreePath}
                  onClick={() =>
                    onOpenReviewFile
                      ? onOpenReviewFile(file.path)
                      : onOpenDiff(file.path, false, 'branch')
                  }
                  onSendToAgent={onSendToAgent}
                  onOpenFile={onOpenFile}
                />
              ))
            )}
          </>
        )}
      </div>

    </RightPanel>
  )
}

function FileRow({
  file,
  worktreePath,
  onClick,
  onSendToAgent,
  onOpenFile
}: {
  file: ChangedFile
  worktreePath: string | null
  onClick: () => void
  onSendToAgent?: (text: string) => void
  onOpenFile?: (filePath: string) => void
}): JSX.Element {
  const backend = useBackend()
  const lastSlash = file.path.lastIndexOf('/')
  const dir = lastSlash >= 0 ? file.path.slice(0, lastSlash + 1) : ''
  const name = lastSlash >= 0 ? file.path.slice(lastSlash + 1) : file.path

  return (
    <div
      className="flex items-center gap-2 px-3 py-1 hover:bg-panel-raised cursor-pointer group"
      onClick={onClick}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', `@${file.path} `)
        e.dataTransfer.effectAllowed = 'copy'
      }}
    >
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
        <span className="shrink-0 font-mono text-xs tabular-nums">
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
            <AtSign className="icon-xs" />
          </button>
        </Tooltip>
      )}
      {worktreePath && (
        <Tooltip label="Open file in external editor (⌘-click for in-app editor)" side="left">
          <button
            onClick={(e) => {
              e.stopPropagation()
              if (e.metaKey && onOpenFile) onOpenFile(file.path)
              else backend.openInEditor(worktreePath, file.path)
            }}
            className="shrink-0 opacity-0 group-hover:opacity-100 text-faint hover:text-fg transition-all cursor-pointer"
          >
            <Code2 className="icon-xs" />
          </button>
        </Tooltip>
      )}
    </div>
  )
}

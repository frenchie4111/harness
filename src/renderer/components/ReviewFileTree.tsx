import { useEffect, useRef, useCallback } from 'react'
import { ChevronRight, Check } from 'lucide-react'
import type { ChangedFile } from '../types'

export interface ReviewComment {
  id: string
  filePath: string
  lineNumber: number
  body: string
  timestamp: number
}

interface ReviewFileTreeProps {
  files: ChangedFile[]
  selectedFile: string | null
  reviewedFiles: Set<string>
  comments: ReviewComment[]
  collapsedDirs: Set<string>
  onSelectFile: (path: string) => void
  onToggleReviewed: (path: string) => void
  onToggleDir: (dir: string) => void
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

interface FileGroup {
  dir: string
  files: ChangedFile[]
}

function groupAndSortFiles(files: ChangedFile[]): FileGroup[] {
  const groups = new Map<string, ChangedFile[]>()
  for (const file of files) {
    const lastSlash = file.path.lastIndexOf('/')
    const dir = lastSlash >= 0 ? file.path.slice(0, lastSlash + 1) : ''
    const list = groups.get(dir) || []
    list.push(file)
    groups.set(dir, list)
  }

  const result: FileGroup[] = []
  for (const [dir, dirFiles] of groups) {
    dirFiles.sort((a, b) => {
      const statusOrder = (s: ChangedFile['status']): number => {
        if (s === 'deleted') return 0
        if (s === 'modified') return 1
        return 2
      }
      const oa = statusOrder(a.status)
      const ob = statusOrder(b.status)
      if (oa !== ob) return oa - ob
      const sizeA = (a.additions ?? 0) + (a.deletions ?? 0)
      const sizeB = (b.additions ?? 0) + (b.deletions ?? 0)
      if (sizeA !== sizeB) return sizeB - sizeA
      return a.path.localeCompare(b.path)
    })
    result.push({ dir, files: dirFiles })
  }
  result.sort((a, b) => a.dir.localeCompare(b.dir))
  return result
}

function flatFileList(groups: FileGroup[], collapsedDirs: Set<string>): ChangedFile[] {
  const result: ChangedFile[] = []
  for (const group of groups) {
    if (!collapsedDirs.has(group.dir)) {
      result.push(...group.files)
    }
  }
  return result
}

export function ReviewFileTree({
  files,
  selectedFile,
  reviewedFiles,
  comments,
  collapsedDirs,
  onSelectFile,
  onToggleReviewed,
  onToggleDir
}: ReviewFileTreeProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const groups = groupAndSortFiles(files)
  const navigableFiles = flatFileList(groups, collapsedDirs)

  const commentCountByFile = new Map<string, number>()
  for (const c of comments) {
    commentCountByFile.set(c.filePath, (commentCountByFile.get(c.filePath) ?? 0) + 1)
  }

  const navigateFile = useCallback(
    (delta: number) => {
      if (navigableFiles.length === 0) return
      const currentIdx = navigableFiles.findIndex((f) => f.path === selectedFile)
      let nextIdx: number
      if (currentIdx < 0) {
        nextIdx = 0
      } else {
        nextIdx = Math.max(0, Math.min(navigableFiles.length - 1, currentIdx + delta))
      }
      onSelectFile(navigableFiles[nextIdx].path)
    },
    [navigableFiles, selectedFile, onSelectFile]
  )

  const navigateUnreviewed = useCallback(
    (delta: number) => {
      const unreviewed = navigableFiles.filter((f) => !reviewedFiles.has(f.path))
      if (unreviewed.length === 0) return
      const currentIdx = unreviewed.findIndex((f) => f.path === selectedFile)
      let nextIdx: number
      if (currentIdx < 0) {
        nextIdx = delta > 0 ? 0 : unreviewed.length - 1
      } else {
        nextIdx = (currentIdx + delta + unreviewed.length) % unreviewed.length
      }
      onSelectFile(unreviewed[nextIdx].path)
    },
    [navigableFiles, reviewedFiles, selectedFile, onSelectFile]
  )

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLInputElement
      ) {
        return
      }
      if (e.key === 'j' || (e.key === 'ArrowDown' && !e.metaKey)) {
        e.preventDefault()
        navigateFile(1)
      } else if (e.key === 'k' || (e.key === 'ArrowUp' && !e.metaKey)) {
        e.preventDefault()
        navigateFile(-1)
      } else if (e.key === ']') {
        e.preventDefault()
        navigateUnreviewed(1)
      } else if (e.key === '[') {
        e.preventDefault()
        navigateUnreviewed(-1)
      } else if (e.key === 'r' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault()
        if (selectedFile) onToggleReviewed(selectedFile)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [navigateFile, navigateUnreviewed, selectedFile, onToggleReviewed])

  return (
    <div ref={containerRef} className="flex flex-col h-full overflow-y-auto text-xs select-none">
      {groups.map((group) => {
        const isCollapsed = collapsedDirs.has(group.dir)
        return (
          <div key={group.dir}>
            {group.dir && (
              <button
                onClick={() => onToggleDir(group.dir)}
                className="w-full flex items-center gap-1 px-2 py-1 text-[10px] font-medium text-dim uppercase tracking-wider bg-panel-raised/50 hover:bg-panel-raised cursor-pointer"
              >
                <ChevronRight
                  size={10}
                  className={`transition-transform ${isCollapsed ? '' : 'rotate-90'}`}
                />
                {group.dir}
              </button>
            )}
            {!isCollapsed &&
              group.files.map((file) => {
                const name = file.path.slice(group.dir.length)
                const isSelected = file.path === selectedFile
                const isReviewed = reviewedFiles.has(file.path)
                const commentCount = commentCountByFile.get(file.path) ?? 0
                return (
                  <div
                    key={file.path}
                    onClick={() => onSelectFile(file.path)}
                    className={`flex items-center gap-1.5 px-2 py-1 cursor-pointer transition-colors ${
                      isSelected
                        ? 'bg-accent/15 border-l-2 border-accent'
                        : 'border-l-2 border-transparent hover:bg-panel-raised'
                    } ${isReviewed ? 'opacity-50' : ''}`}
                  >
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        onToggleReviewed(file.path)
                      }}
                      className={`shrink-0 w-3.5 h-3.5 rounded border flex items-center justify-center transition-colors cursor-pointer ${
                        isReviewed
                          ? 'bg-success/20 border-success text-success'
                          : 'border-border-strong text-transparent hover:border-faint'
                      }`}
                    >
                      {isReviewed && <Check size={9} strokeWidth={3} />}
                    </button>

                    <span className={`shrink-0 w-3 font-mono text-[10px] ${STATUS_COLOR[file.status]}`}>
                      {STATUS_LABEL[file.status]}
                    </span>

                    <span className="truncate flex-1 text-fg">{name}</span>

                    {(file.additions !== undefined || file.deletions !== undefined) && (
                      <span className="shrink-0 font-mono text-[10px] tabular-nums">
                        {file.additions !== undefined && file.additions > 0 && (
                          <span className="text-success">+{file.additions}</span>
                        )}
                        {file.deletions !== undefined && file.deletions > 0 && (
                          <span className="text-danger ml-0.5">−{file.deletions}</span>
                        )}
                      </span>
                    )}

                    {commentCount > 0 && (
                      <span className="shrink-0 text-[9px] bg-info/20 text-info px-1 rounded-full tabular-nums">
                        {commentCount}
                      </span>
                    )}
                  </div>
                )
              })}
          </div>
        )
      })}
    </div>
  )
}

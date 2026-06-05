import { useEffect, useRef, useCallback, useMemo, useState } from 'react'
import { ChevronRight, Folder, FolderOpen, FileText } from 'lucide-react'
import type { ChangedFile } from '../types'

export interface ReviewComment {
  id: string
  filePath: string
  /** End line of the comment range (1-based, modified side). 0 = file-level.
   *  GitHub convention: this is `line` (the last line of a multi-line range). */
  lineNumber: number
  /** First line of a multi-line range. Undefined/equal to lineNumber means a
   *  single-line comment. Maps to GitHub's `start_line`. */
  startLine?: number
  body: string
  timestamp: number
  /** GitHub review-comment id once pushed/fetched. Absent = local-only. */
  remoteId?: number
  /** GitHub login of the author, for comments fetched from the PR. */
  author?: string
  /** Author avatar URL, for comments fetched from the PR. */
  authorAvatarUrl?: string
  /** ISO creation timestamp, for comments fetched from the PR. */
  createdAt?: string
  /** Link to the comment on GitHub. */
  htmlUrl?: string
  /** True for a comment on an unsubmitted (pending) review. */
  draft?: boolean
  /** remoteId of the comment this replies to (thread root), if any. */
  inReplyToId?: number
  /** GraphQL node id of the review thread this comment belongs to. */
  threadId?: string
  /** True when the thread is resolved on GitHub. */
  resolved?: boolean
}

interface ReviewFileTreeProps {
  files: ChangedFile[]
  selectedFile: string | null
  reviewedFiles: Set<string>
  comments: ReviewComment[]
  /** Folder paths the user has explicitly collapsed. All other folders
   *  render expanded by default — reviews are small enough that "open
   *  everything" is the right starting state. */
  collapsedDirs: Set<string>
  onSelectFile: (path: string) => void
  onToggleReviewed: (path: string) => void
  onToggleDir: (dir: string) => void
  /** s = side-by-side, d = unified. Lives here so every review keyboard
   *  shortcut shares one handler/pattern. */
  onSetSideBySide: (sideBySide: boolean) => void
  /** ? toggles the review shortcuts popup. */
  onShowShortcuts: () => void
  /** Scroll the diff to a line — used by ] / [ comment navigation. */
  onRevealLine: (filePath: string, line: number) => void
  /** True when the review tab is the active/visible tab — the keyboard
   *  shortcuts no-op otherwise so a background review tab doesn't react. */
  active?: boolean
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

interface DirNode {
  kind: 'dir'
  name: string
  path: string
  children: TreeNode[]
}
interface FileNode {
  kind: 'file'
  name: string
  path: string
  file: ChangedFile
}
type TreeNode = DirNode | FileNode

const EMPTY_SET: Set<string> = new Set()

function buildTree(files: ChangedFile[]): DirNode {
  const root: DirNode = { kind: 'dir', name: '', path: '', children: [] }
  for (const file of files) {
    const parts = file.path.split('/')
    let node: DirNode = root
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      const isLast = i === parts.length - 1
      if (isLast) {
        node.children.push({
          kind: 'file',
          name: part,
          path: file.path,
          file
        })
      } else {
        const subPath = parts.slice(0, i + 1).join('/')
        let dir = node.children.find(
          (c): c is DirNode => c.kind === 'dir' && c.name === part
        )
        if (!dir) {
          dir = { kind: 'dir', name: part, path: subPath, children: [] }
          node.children.push(dir)
        }
        node = dir
      }
    }
  }
  sortTree(root)
  return root
}

function sortTree(node: DirNode): void {
  node.children.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  for (const c of node.children) {
    if (c.kind === 'dir') sortTree(c)
  }
}

interface DirChain {
  /** Path of the deepest dir in the collapsed chain. Doubles as the
   *  collapse-state key — toggling collapses/expands the whole chain. */
  path: string
  /** Slash-joined display name: "a/b/c" for a chain of three. */
  displayName: string
  /** Children render under the deepest dir's children. */
  inner: DirNode
}

/** Walk down a directory chain while each dir has exactly one dir-child.
 *  The chain stops at: a dir with multiple children, a dir with a file
 *  child, or a leaf. File-child dirs do NOT collapse — matches VS Code's
 *  "Compact Folders" behavior. */
function resolveChain(node: DirNode): DirChain {
  let cur = node
  const names = [cur.name]
  while (cur.children.length === 1 && cur.children[0].kind === 'dir') {
    cur = cur.children[0]
    names.push(cur.name)
  }
  return { path: cur.path, displayName: names.join('/'), inner: cur }
}

/** Walk the tree in render order, emitting only files whose ancestor
 *  folders are all expanded. Used by j/k keyboard nav so it matches what
 *  the user actually sees. Mirrors the render-time chain collapse so
 *  collapse keys line up with rendered rows. */
function visibleFiles(root: DirNode, collapsed: Set<string>): ChangedFile[] {
  const out: ChangedFile[] = []
  const walk = (node: DirNode): void => {
    for (const child of node.children) {
      if (child.kind === 'file') {
        out.push(child.file)
      } else {
        const chain = resolveChain(child)
        if (!collapsed.has(chain.path)) walk(chain.inner)
      }
    }
  }
  walk(root)
  return out
}

export function ReviewFileTree({
  files,
  selectedFile,
  reviewedFiles,
  comments,
  collapsedDirs,
  onSelectFile,
  onToggleReviewed,
  onToggleDir,
  onSetSideBySide,
  onShowShortcuts,
  onRevealLine,
  active
}: ReviewFileTreeProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const [filter, setFilter] = useState('')
  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return files
    return files.filter((f) => f.path.toLowerCase().includes(q))
  }, [files, filter])
  const filtering = filter.trim().length > 0
  const tree = useMemo(() => buildTree(filtered), [filtered])
  // While filtering, every directory expands so matches under collapsed
  // folders aren't hidden — same trick AllFilesPanel uses.
  const effectiveCollapsed = filtering ? EMPTY_SET : collapsedDirs
  const navigableFiles = useMemo(
    () => visibleFiles(tree, effectiveCollapsed),
    [tree, effectiveCollapsed]
  )

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

  // ] / [ cycle through the comment threads in the current file. Roots only
  // (replies share their parent's line), sorted by line.
  const fileCommentLines = useMemo(() => {
    if (!selectedFile) return [] as number[]
    return comments
      .filter((c) => c.filePath === selectedFile && c.inReplyToId === undefined)
      .map((c) => c.lineNumber)
      .sort((a, b) => a - b)
  }, [comments, selectedFile])
  const commentNavRef = useRef(-1)
  useEffect(() => {
    commentNavRef.current = -1
  }, [selectedFile])
  const navigateComment = useCallback(
    (delta: number) => {
      if (!selectedFile || fileCommentLines.length === 0) return
      const n = fileCommentLines.length
      const cur = commentNavRef.current
      const idx = cur < 0 ? (delta > 0 ? 0 : n - 1) : (cur + delta + n) % n
      commentNavRef.current = idx
      onRevealLine(selectedFile, fileCommentLines[idx])
    },
    [selectedFile, fileCommentLines, onRevealLine]
  )

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (!active) return
      if (
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLInputElement
      ) {
        return
      }
      if (e.key === 'u' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault()
        navigateUnreviewed(1)
      } else if (e.key === 'i' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault()
        navigateUnreviewed(-1)
      } else if (!e.shiftKey && (e.key === 'j' || (e.key === 'ArrowDown' && !e.metaKey))) {
        e.preventDefault()
        navigateFile(1)
      } else if (!e.shiftKey && (e.key === 'k' || (e.key === 'ArrowUp' && !e.metaKey))) {
        e.preventDefault()
        navigateFile(-1)
      } else if (e.key === ']') {
        e.preventDefault()
        navigateComment(1)
      } else if (e.key === '[') {
        e.preventDefault()
        navigateComment(-1)
      } else if (e.key === 's' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault()
        onSetSideBySide(true)
      } else if (e.key === 'd' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault()
        onSetSideBySide(false)
      } else if (e.key === '?') {
        e.preventDefault()
        onShowShortcuts()
      } else if (e.key === 'r' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault()
        if (selectedFile) {
          const wasReviewed = reviewedFiles.has(selectedFile)
          onToggleReviewed(selectedFile)
          if (!wasReviewed) {
            const unreviewed = navigableFiles.filter(
              (f) => !reviewedFiles.has(f.path) && f.path !== selectedFile
            )
            if (unreviewed.length > 0) {
              const currentIdx = navigableFiles.findIndex((f) => f.path === selectedFile)
              const next = unreviewed.find(
                (f) => navigableFiles.indexOf(f) > currentIdx
              ) ?? unreviewed[0]
              onSelectFile(next.path)
            }
          }
        }
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [active, navigateFile, navigateUnreviewed, navigateComment, selectedFile, navigableFiles, reviewedFiles, onSelectFile, onToggleReviewed, onSetSideBySide, onShowShortcuts])

  return (
    <div ref={containerRef} className="flex flex-col h-full text-xs select-none">
      <div className="shrink-0 p-2 border-b border-border">
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter files..."
          className="w-full bg-panel-raised border border-border rounded px-2 py-1 text-xs text-fg placeholder:text-faint focus:outline-none focus:border-border-strong"
        />
      </div>
      <div className="flex-1 overflow-auto min-h-0">
        {filtering && navigableFiles.length === 0 && (
          <div className="px-3 py-2 text-faint">No matches</div>
        )}
        <TreeBranch
          node={tree}
          depth={0}
          collapsedDirs={effectiveCollapsed}
          selectedFile={selectedFile}
          reviewedFiles={reviewedFiles}
          commentCountByFile={commentCountByFile}
          onSelectFile={onSelectFile}
          onToggleReviewed={onToggleReviewed}
          onToggleDir={onToggleDir}
        />
      </div>
    </div>
  )
}

interface TreeBranchProps {
  node: DirNode
  depth: number
  collapsedDirs: Set<string>
  selectedFile: string | null
  reviewedFiles: Set<string>
  commentCountByFile: Map<string, number>
  onSelectFile: (path: string) => void
  onToggleReviewed: (path: string) => void
  onToggleDir: (dir: string) => void
}

function TreeBranch({
  node,
  depth,
  collapsedDirs,
  selectedFile,
  reviewedFiles,
  commentCountByFile,
  onSelectFile,
  onToggleReviewed,
  onToggleDir
}: TreeBranchProps): JSX.Element {
  return (
    <>
      {node.children.map((child) => {
        if (child.kind === 'file') {
          return (
            <FileRow
              key={child.path}
              file={child.file}
              name={child.name}
              depth={depth}
              selected={child.path === selectedFile}
              reviewed={reviewedFiles.has(child.path)}
              commentCount={commentCountByFile.get(child.path) ?? 0}
              onSelect={() => onSelectFile(child.path)}
              onToggleReviewed={() => onToggleReviewed(child.path)}
            />
          )
        }
        const chain = resolveChain(child)
        const isOpen = !collapsedDirs.has(chain.path)
        return (
          <div key={chain.path}>
            <DirRow
              name={chain.displayName}
              depth={depth}
              open={isOpen}
              onToggle={() => onToggleDir(chain.path)}
            />
            {isOpen && (
              <TreeBranch
                node={chain.inner}
                depth={depth + 1}
                collapsedDirs={collapsedDirs}
                selectedFile={selectedFile}
                reviewedFiles={reviewedFiles}
                commentCountByFile={commentCountByFile}
                onSelectFile={onSelectFile}
                onToggleReviewed={onToggleReviewed}
                onToggleDir={onToggleDir}
              />
            )}
          </div>
        )
      })}
    </>
  )
}

function DirRow({
  name,
  depth,
  open,
  onToggle
}: {
  name: string
  depth: number
  open: boolean
  onToggle: () => void
}): JSX.Element {
  return (
    <div
      onClick={onToggle}
      className="flex w-max min-w-full items-center gap-1 px-2 py-0.5 hover:bg-panel-raised cursor-pointer select-none"
      style={{ paddingLeft: 8 + depth * 12 }}
    >
      <ChevronRight
        className={`icon-2xs shrink-0 text-faint transition-transform ${open ? 'rotate-90' : ''}`}
      />
      {open ? (
        <FolderOpen className="icon-xs shrink-0 text-info" />
      ) : (
        <Folder className="icon-xs shrink-0 text-info" />
      )}
      <span className="whitespace-nowrap text-fg">{name}</span>
    </div>
  )
}

function FileRow({
  file,
  name,
  depth,
  selected,
  reviewed,
  commentCount,
  onSelect
}: {
  file: ChangedFile
  name: string
  depth: number
  selected: boolean
  reviewed: boolean
  commentCount: number
  onSelect: () => void
  onToggleReviewed: () => void
}): JSX.Element {
  return (
    <div
      onClick={onSelect}
      className={`flex w-max min-w-full items-center gap-1.5 py-0.5 pr-2 cursor-pointer transition-colors ${
        selected
          ? 'bg-accent/15 border-l-2 border-accent'
          : 'border-l-2 border-transparent hover:bg-panel-raised'
      } ${reviewed ? 'opacity-50' : ''}`}
      style={{ paddingLeft: 8 + depth * 12 + 10 }}
    >
      <FileText className="icon-xs shrink-0 text-faint" />

      <span className={`shrink-0 w-3 font-mono text-xs ${STATUS_COLOR[file.status]}`}>
        {STATUS_LABEL[file.status]}
      </span>

      <span className="whitespace-nowrap text-fg">{name}</span>

      {commentCount > 0 && (
        <span className="shrink-0 text-xs bg-info/20 text-info px-1 rounded-full tabular-nums">
          {commentCount}
        </span>
      )}
    </div>
  )
}

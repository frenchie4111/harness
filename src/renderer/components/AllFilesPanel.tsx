import { useCallback, useEffect, useMemo, useState } from 'react'
import { RefreshCw, AtSign, Code2, ChevronRight, Folder, FolderOpen, FileText } from 'lucide-react'
import { Tooltip } from './Tooltip'
import { RightPanel } from './RightPanel'
import { useSettings } from '../store'
import { bindingToString, formatBindingGlyphs, resolveHotkeys } from '../hotkeys'

interface AllFilesPanelProps {
  worktreePath: string | null
  onOpenFile: (filePath: string) => void
  onSendToAgent?: (text: string) => void
}

interface TreeNode {
  name: string
  path: string
  children?: Map<string, TreeNode>
  isFile: boolean
}

function buildTree(files: string[]): TreeNode {
  const root: TreeNode = { name: '', path: '', children: new Map(), isFile: false }
  for (const file of files) {
    const parts = file.split('/')
    let node = root
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      const isLast = i === parts.length - 1
      if (!node.children) node.children = new Map()
      let child = node.children.get(part)
      if (!child) {
        child = {
          name: part,
          path: parts.slice(0, i + 1).join('/'),
          isFile: isLast,
          children: isLast ? undefined : new Map()
        }
        node.children.set(part, child)
      }
      node = child
    }
  }
  return root
}

function sortChildren(node: TreeNode): TreeNode[] {
  if (!node.children) return []
  return Array.from(node.children.values()).sort((a, b) => {
    if (a.isFile !== b.isFile) return a.isFile ? 1 : -1
    return a.name.localeCompare(b.name)
  })
}

export function AllFilesPanel({
  worktreePath,
  onOpenFile,
  onSendToAgent
}: AllFilesPanelProps): JSX.Element {
  const [files, setFiles] = useState<string[]>([])
  const [hasLoaded, setHasLoaded] = useState(false)
  const [filter, setFilter] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['']))
  const settings = useSettings()
  const quickOpenGlyphs = useMemo(() => {
    const binding = resolveHotkeys(settings.hotkeys ?? undefined).fileQuickOpen
    return formatBindingGlyphs(bindingToString(binding))
  }, [settings.hotkeys])

  const refresh = useCallback(async () => {
    if (!worktreePath) return
    try {
      const result = await window.api.listAllFiles(worktreePath)
      setFiles(result)
    } catch (err) {
      console.error('Failed to list files:', err)
      setFiles([])
    } finally {
      setHasLoaded(true)
    }
  }, [worktreePath])

  useEffect(() => {
    setHasLoaded(false)
    setFilter('')
    setExpanded(new Set(['']))
  }, [worktreePath])

  useEffect(() => {
    refresh()
  }, [refresh])

  const filtered = useMemo(() => {
    if (!filter.trim()) return files
    const q = filter.toLowerCase()
    return files.filter((f) => f.toLowerCase().includes(q))
  }, [files, filter])

  const tree = useMemo(() => buildTree(filtered), [filtered])

  const filtering = filter.trim().length > 0

  const toggle = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const actions = (
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
  )

  return (
    <RightPanel id="all-files" title="All Files" actions={actions} grow defaultCollapsed>
      <div className="shrink-0 p-2 border-b border-border">
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter files..."
          className="w-full bg-panel-raised border border-border rounded px-2 py-1 text-xs text-fg placeholder:text-faint focus:outline-none focus:border-border-strong"
        />
      </div>
      <div className="flex-1 overflow-y-auto min-h-0 text-xs">
        {!worktreePath && <div className="p-3 text-faint">No worktree selected</div>}
        {worktreePath && hasLoaded && files.length === 0 && (
          <div className="p-3 text-faint">No files found</div>
        )}
        {worktreePath && filtering && filtered.length === 0 && files.length > 0 && (
          <div className="p-3 text-faint">No matches</div>
        )}
        {worktreePath && filtered.length > 0 && (
          <TreeBranch
            node={tree}
            depth={0}
            expanded={expanded}
            forceExpanded={filtering}
            worktreePath={worktreePath}
            onToggle={toggle}
            onOpenFile={onOpenFile}
            onSendToAgent={onSendToAgent}
          />
        )}
      </div>
      {files.length > 0 && (
        <div className="px-3 py-1.5 border-t border-border text-[10px] text-faint shrink-0 flex items-center justify-between">
          <span>
            {filtering ? `${filtered.length} / ${files.length}` : files.length} file
            {files.length !== 1 ? 's' : ''}
          </span>
          <kbd className="font-mono">{quickOpenGlyphs} fuzzy open</kbd>
        </div>
      )}
    </RightPanel>
  )
}

interface TreeBranchProps {
  node: TreeNode
  depth: number
  expanded: Set<string>
  forceExpanded: boolean
  worktreePath: string
  onToggle: (path: string) => void
  onOpenFile: (filePath: string) => void
  onSendToAgent?: (text: string) => void
}

function TreeBranch({
  node,
  depth,
  expanded,
  forceExpanded,
  worktreePath,
  onToggle,
  onOpenFile,
  onSendToAgent
}: TreeBranchProps): JSX.Element {
  const children = sortChildren(node)
  return (
    <>
      {children.map((child) => {
        if (child.isFile) {
          return (
            <FileRow
              key={child.path}
              name={child.name}
              path={child.path}
              depth={depth}
              worktreePath={worktreePath}
              onOpenFile={onOpenFile}
              onSendToAgent={onSendToAgent}
            />
          )
        }
        const isOpen = forceExpanded || expanded.has(child.path)
        return (
          <div key={child.path}>
            <DirRow
              name={child.name}
              path={child.path}
              depth={depth}
              open={isOpen}
              onToggle={() => onToggle(child.path)}
            />
            {isOpen && (
              <TreeBranch
                node={child}
                depth={depth + 1}
                expanded={expanded}
                forceExpanded={forceExpanded}
                worktreePath={worktreePath}
                onToggle={onToggle}
                onOpenFile={onOpenFile}
                onSendToAgent={onSendToAgent}
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
  path: string
  depth: number
  open: boolean
  onToggle: () => void
}): JSX.Element {
  return (
    <div
      onClick={onToggle}
      className="flex items-center gap-1 px-2 py-0.5 hover:bg-panel-raised cursor-pointer select-none"
      style={{ paddingLeft: 8 + depth * 12 }}
    >
      <ChevronRight
        size={10}
        className={`shrink-0 text-faint transition-transform ${open ? 'rotate-90' : ''}`}
      />
      {open ? (
        <FolderOpen size={11} className="shrink-0 text-info" />
      ) : (
        <Folder size={11} className="shrink-0 text-info" />
      )}
      <span className="truncate text-fg">{name}</span>
    </div>
  )
}

function FileRow({
  name,
  path,
  depth,
  worktreePath,
  onOpenFile,
  onSendToAgent
}: {
  name: string
  path: string
  depth: number
  worktreePath: string
  onOpenFile: (filePath: string) => void
  onSendToAgent?: (text: string) => void
}): JSX.Element {
  return (
    <div
      className="flex items-center gap-1 px-2 py-0.5 hover:bg-panel-raised cursor-pointer group"
      style={{ paddingLeft: 8 + depth * 12 + 10 }}
      onClick={() => onOpenFile(path)}
    >
      <FileText size={11} className="shrink-0 text-faint" />
      <span className="truncate min-w-0 flex-1 text-fg">{name}</span>
      {onSendToAgent && (
        <Tooltip label="Reference in Claude" side="left">
          <button
            onClick={(e) => {
              e.stopPropagation()
              onSendToAgent(`@${path} `)
            }}
            className="shrink-0 opacity-0 group-hover:opacity-100 text-faint hover:text-fg transition-all cursor-pointer"
          >
            <AtSign size={11} />
          </button>
        </Tooltip>
      )}
      <Tooltip label="Open file in editor" side="left">
        <button
          onClick={(e) => {
            e.stopPropagation()
            window.api.openInEditor(worktreePath, path)
          }}
          className="shrink-0 opacity-0 group-hover:opacity-100 text-faint hover:text-fg transition-all cursor-pointer"
        >
          <Code2 size={11} />
        </button>
      </Tooltip>
    </div>
  )
}

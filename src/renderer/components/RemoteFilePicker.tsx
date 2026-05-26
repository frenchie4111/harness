import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronUp, Folder, FolderOpen, GitBranch, Loader2, X } from 'lucide-react'
import type { FsEntry } from '../types'
import { useBackend } from '../backend'

interface RemoteFilePickerProps {
  isOpen: boolean
  title: string
  initialPath?: string
  selectLabel?: string
  onSelect: (path: string) => void
  onCancel: () => void
}

function parentDir(path: string): string {
  if (!path) return path
  const trimmed = path.replace(/\/+$/, '')
  if (trimmed === '' || trimmed === '/') return '/'
  const idx = trimmed.lastIndexOf('/')
  if (idx <= 0) return '/'
  return trimmed.slice(0, idx)
}

function joinPath(base: string, name: string): string {
  if (!base || base === '/') return `/${name}`
  return `${base.replace(/\/+$/, '')}/${name}`
}

export function RemoteFilePicker({
  isOpen,
  title,
  initialPath,
  selectLabel = 'Select',
  onSelect,
  onCancel
}: RemoteFilePickerProps): JSX.Element | null {
  const backend = useBackend()
  const [currentPath, setCurrentPath] = useState<string>(initialPath ?? '')
  const [pathDraft, setPathDraft] = useState<string>(initialPath ?? '')
  const [entries, setEntries] = useState<FsEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showHidden, setShowHidden] = useState(false)
  const fetchSeqRef = useRef(0)

  // Resolve home as the starting point if no initialPath was provided.
  useEffect(() => {
    if (!isOpen || currentPath) return
    let cancelled = false
    void backend.resolveHome().then((home) => {
      if (cancelled) return
      setCurrentPath(home)
      setPathDraft(home)
    })
    return () => {
      cancelled = true
    }
  }, [isOpen, currentPath])

  // Fetch entries on path / showHidden change.
  useEffect(() => {
    if (!isOpen || !currentPath) return
    const seq = ++fetchSeqRef.current
    setLoading(true)
    setError(null)
    void backend
      .listDir(currentPath, { showHidden })
      .then((items) => {
        if (fetchSeqRef.current !== seq) return
        setEntries(items)
        setLoading(false)
      })
      .catch((e: unknown) => {
        if (fetchSeqRef.current !== seq) return
        setEntries([])
        setError(e instanceof Error ? e.message : String(e))
        setLoading(false)
      })
  }, [isOpen, currentPath, showHidden])

  // Esc closes; Enter on the path bar navigates.
  useEffect(() => {
    if (!isOpen) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isOpen, onCancel])

  const navigateTo = useCallback((next: string) => {
    setCurrentPath(next)
    setPathDraft(next)
  }, [])

  const handlePathSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault()
      navigateTo(pathDraft.trim() || '/')
    },
    [navigateTo, pathDraft]
  )

  const handleUp = useCallback(() => {
    navigateTo(parentDir(currentPath))
  }, [currentPath, navigateTo])

  const handleSelect = useCallback(() => {
    onSelect(currentPath)
  }, [currentPath, onSelect])

  const visibleEntries = useMemo(() => entries.filter((e) => e.isDir || e.truncated), [entries])

  if (!isOpen) return null

  const selectDisabled = loading

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center pt-[10vh] bg-black/30"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-2xl bg-surface rounded-xl shadow-2xl border border-border overflow-hidden flex flex-col"
        style={{ maxHeight: '78vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-border">
          <h2 className="text-sm font-semibold text-fg-bright">{title}</h2>
          <button
            onClick={onCancel}
            title="Close (Esc)"
            className="text-dim hover:text-fg p-1 rounded transition-colors cursor-pointer"
          >
            <X className="icon-base" />
          </button>
        </div>

        <div className="px-5 py-3 border-b border-border flex flex-col gap-2">
          <form onSubmit={handlePathSubmit} className="flex items-stretch gap-2">
            <button
              type="button"
              onClick={handleUp}
              title="Parent directory"
              className="flex items-center justify-center px-2.5 rounded-md border border-border-strong bg-app hover:border-accent text-dim hover:text-fg transition-colors cursor-pointer"
            >
              <ChevronUp className="icon-sm" />
            </button>
            <input
              type="text"
              value={pathDraft}
              onChange={(e) => setPathDraft(e.target.value)}
              spellCheck={false}
              autoComplete="off"
              placeholder="/path/to/folder"
              className="flex-1 min-w-0 bg-app border border-border-strong rounded-md px-2.5 py-1.5 font-mono text-xs text-fg-bright placeholder-faint outline-none focus:border-accent transition-colors"
            />
          </form>
          <label className="flex items-center gap-2 text-xs text-dim cursor-pointer w-fit">
            <input
              type="checkbox"
              checked={showHidden}
              onChange={(e) => setShowHidden(e.target.checked)}
              className="accent-accent icon-base cursor-pointer" />
            Show hidden files
          </label>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto">
          {loading && (
            <div className="flex items-center justify-center py-10 text-dim text-sm gap-2">
              <Loader2 className="icon-sm animate-spin" />
              Loading…
            </div>
          )}
          {!loading && error && (
            <div className="px-5 py-4 text-sm text-danger bg-danger/10 border-b border-danger/30">
              {error}
            </div>
          )}
          {!loading && !error && visibleEntries.length === 0 && (
            <div className="px-5 py-10 text-center text-sm text-faint">
              No folders here.
            </div>
          )}
          {!loading && !error && visibleEntries.length > 0 && (
            <ul className="py-1">
              {visibleEntries.map((entry) => {
                if (entry.truncated) {
                  return (
                    <li
                      key="__truncated__"
                      className="px-4 py-1.5 text-xs text-faint italic"
                    >
                      {entry.name}
                    </li>
                  )
                }
                const full = joinPath(currentPath, entry.name)
                return (
                  <li key={entry.name}>
                    <button
                      type="button"
                      onClick={() => navigateTo(full)}
                      className="w-full text-left flex items-center gap-2.5 px-4 py-1.5 hover:bg-panel/60 transition-colors cursor-pointer group"
                    >
                      {entry.isGitRepo ? (
                        <FolderOpen className="icon-sm text-accent shrink-0" />
                      ) : (
                        <Folder className="icon-sm text-dim shrink-0" />
                      )}
                      <span className="flex-1 text-sm text-fg truncate">{entry.name}</span>
                      {entry.isGitRepo && (
                        <span
                          className="flex items-center gap-1 text-xs font-medium text-success shrink-0"
                          title="Git repository"
                        >
                          <GitBranch className="icon-2xs" />
                          git
                        </span>
                      )}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        <div className="px-5 py-3 border-t border-border flex items-center justify-between gap-3">
          <div className="text-xs text-faint truncate min-w-0 flex-1 font-mono">
            {currentPath}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={onCancel}
              className="px-3 py-1.5 text-sm text-dim hover:text-fg transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              onClick={handleSelect}
              disabled={selectDisabled}
              className="px-4 py-1.5 rounded-md bg-fg-bright text-app font-medium text-sm hover:bg-fg disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
            >
              {selectLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

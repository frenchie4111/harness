import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Search, GitBranch, ArrowRight, Circle, Loader, Clock, AlertTriangle } from 'lucide-react'
import type { Worktree, PtyStatus } from '../types'
import type { Action, HotkeyBinding } from '../hotkeys'
import { ACTION_LABELS, bindingToString } from '../hotkeys'

interface CommandPaletteProps {
  worktrees: Worktree[]
  worktreeStatuses: Record<string, PtyStatus>
  activeWorktreeId: string | null
  resolvedHotkeys: Record<Action, HotkeyBinding>
  onClose: () => void
  onSelectWorktree: (path: string) => void
  onAction: (action: Action) => void
}

interface PaletteItem {
  id: string
  label: string
  sublabel?: string
  hint?: string
  category: 'worktree' | 'action'
  action?: Action
  worktreePath?: string
  status?: PtyStatus
}

const STATUS_ICON: Record<PtyStatus, { icon: typeof Circle; className: string; label: string }> = {
  idle: { icon: Circle, className: 'text-faint', label: 'Idle' },
  processing: { icon: Loader, className: 'text-success animate-spin', label: 'Working' },
  waiting: { icon: Clock, className: 'text-warning', label: 'Waiting' },
  'needs-approval': { icon: AlertTriangle, className: 'text-danger animate-pulse', label: 'Needs approval' },
}

const EXCLUDED_ACTIONS: Set<Action> = new Set([
  'worktree1', 'worktree2', 'worktree3', 'worktree4', 'worktree5',
  'worktree6', 'worktree7', 'worktree8', 'worktree9',
  'commandPalette',
])

function fuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  let score = 0
  let qi = 0
  let lastMatchIdx = -1
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      score += 10
      if (ti === 0) score += 5
      if (lastMatchIdx === ti - 1) score += 5
      lastMatchIdx = ti
      qi++
    }
  }
  if (t.startsWith(q)) score += 20
  return qi === q.length ? score : -1
}

export function CommandPalette({
  worktrees,
  worktreeStatuses,
  activeWorktreeId,
  resolvedHotkeys,
  onClose,
  onSelectWorktree,
  onAction,
}: CommandPaletteProps): JSX.Element {
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const multiRepo = useMemo(() => {
    const roots = new Set(worktrees.map((wt) => wt.repoRoot))
    return roots.size > 1
  }, [worktrees])

  const allItems = useMemo<PaletteItem[]>(() => {
    const items: PaletteItem[] = []

    for (const wt of worktrees) {
      const repoName = wt.repoRoot.split('/').pop() || wt.repoRoot
      items.push({
        id: `wt:${wt.path}`,
        label: wt.branch || wt.path.split('/').pop() || wt.path,
        sublabel: multiRepo ? repoName : undefined,
        category: 'worktree',
        worktreePath: wt.path,
        status: worktreeStatuses[wt.path],
      })
    }

    for (const [action, label] of Object.entries(ACTION_LABELS)) {
      if (EXCLUDED_ACTIONS.has(action as Action)) continue
      const binding = resolvedHotkeys[action as Action]
      items.push({
        id: `action:${action}`,
        label,
        hint: binding ? bindingToString(binding) : undefined,
        category: 'action',
        action: action as Action,
      })
    }

    return items
  }, [worktrees, worktreeStatuses, multiRepo, resolvedHotkeys])

  const filtered = useMemo(() => {
    if (!query.trim()) return allItems

    return allItems
      .map((item) => {
        const labelScore = fuzzyScore(query, item.label)
        const subScore = item.sublabel ? fuzzyScore(query, item.sublabel) : -1
        return { item, score: Math.max(labelScore, subScore) }
      })
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .map(({ item }) => item)
  }, [allItems, query])

  useEffect(() => {
    setSelectedIndex(0)
  }, [query])

  const execute = useCallback(
    (item: PaletteItem) => {
      if (item.category === 'worktree' && item.worktreePath) {
        onSelectWorktree(item.worktreePath)
      } else if (item.category === 'action' && item.action) {
        onAction(item.action)
      }
      onClose()
    },
    [onClose, onSelectWorktree, onAction]
  )

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIndex((i) => Math.max(i - 1, 0))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        if (filtered[selectedIndex]) execute(filtered[selectedIndex])
      }
    },
    [filtered, selectedIndex, execute, onClose]
  )

  useEffect(() => {
    const el = listRef.current?.children[selectedIndex] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  const worktreeItems = filtered.filter((i) => i.category === 'worktree')
  const actionItems = filtered.filter((i) => i.category === 'action')

  let runningIdx = 0
  const worktreeStartIdx = runningIdx
  runningIdx += worktreeItems.length
  const actionStartIdx = runningIdx

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center pt-[15vh]" onClick={onClose}>
      <div
        className="w-full max-w-lg bg-surface rounded-xl shadow-2xl border border-border overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
          <Search size={16} className="text-dim shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search worktrees and commands..."
            className="flex-1 bg-transparent text-fg-bright text-sm outline-none placeholder:text-faint"
          />
          <kbd className="text-[10px] text-faint bg-bg px-1.5 py-0.5 rounded border border-border font-mono">ESC</kbd>
        </div>

        <div ref={listRef} className="max-h-80 overflow-y-auto py-1">
          {filtered.length === 0 && (
            <div className="px-4 py-8 text-center text-dim text-sm">No results</div>
          )}

          {worktreeItems.length > 0 && (
            <>
              <div className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-faint">
                Worktrees
              </div>
              {worktreeItems.map((item, i) => {
                const globalIdx = worktreeStartIdx + i
                const isActive = item.worktreePath === activeWorktreeId
                const statusInfo = item.status ? STATUS_ICON[item.status] : undefined
                const StatusIcon = statusInfo?.icon
                return (
                  <button
                    key={item.id}
                    className={`w-full flex items-center gap-2 px-3 py-2 text-sm cursor-pointer transition-colors ${
                      globalIdx === selectedIndex
                        ? 'bg-accent/15 text-fg-bright'
                        : 'text-fg hover:bg-surface-hover'
                    }`}
                    onMouseEnter={() => setSelectedIndex(globalIdx)}
                    onClick={() => execute(item)}
                  >
                    {StatusIcon ? (
                      <StatusIcon size={14} className={`shrink-0 ${statusInfo.className}`} title={statusInfo.label} />
                    ) : (
                      <GitBranch size={14} className="text-dim shrink-0" />
                    )}
                    <span className="truncate flex-1 text-left">{item.label}</span>
                    {item.sublabel && (
                      <span className="text-[10px] text-faint shrink-0">{item.sublabel}</span>
                    )}
                    {isActive && (
                      <span className="text-[10px] text-accent font-medium shrink-0">current</span>
                    )}
                  </button>
                )
              })}
            </>
          )}

          {actionItems.length > 0 && (
            <>
              <div className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-faint">
                Commands
              </div>
              {actionItems.map((item, i) => {
                const globalIdx = actionStartIdx + i
                return (
                  <button
                    key={item.id}
                    className={`w-full flex items-center gap-2 px-3 py-2 text-sm cursor-pointer transition-colors ${
                      globalIdx === selectedIndex
                        ? 'bg-accent/15 text-fg-bright'
                        : 'text-fg hover:bg-surface-hover'
                    }`}
                    onMouseEnter={() => setSelectedIndex(globalIdx)}
                    onClick={() => execute(item)}
                  >
                    <ArrowRight size={14} className="text-dim shrink-0" />
                    <span className="truncate flex-1 text-left">{item.label}</span>
                    {item.hint && (
                      <kbd className="text-[10px] text-faint bg-bg px-1.5 py-0.5 rounded border border-border font-mono shrink-0">
                        {item.hint}
                      </kbd>
                    )}
                  </button>
                )
              })}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Search, GitPullRequest, ArrowRight } from 'lucide-react'
import type { Worktree, PtyStatus, PRStatus } from '../types'
import type { Action, HotkeyBinding } from '../hotkeys'
import { ACTION_LABELS, bindingToString } from '../hotkeys'
import { groupWorktrees, GROUP_ORDER, GROUP_LABELS, type GroupKey } from '../worktree-sort'

interface CommandPaletteProps {
  worktrees: Worktree[]
  worktreeStatuses: Record<string, PtyStatus>
  prStatuses: Record<string, PRStatus | null>
  mergedPaths: Record<string, boolean>
  activeWorktreeId: string | null
  resolvedHotkeys: Record<Action, HotkeyBinding>
  onClose: () => void
  onSelectWorktree: (path: string) => void
  onAction: (action: Action) => void
}

type PaletteItem =
  | { kind: 'worktree'; wt: Worktree }
  | { kind: 'action'; action: Action; label: string; hint?: string }
  | { kind: 'heading'; label: string }

const STATUS_COLORS: Record<PtyStatus | 'merged', string> = {
  idle: 'bg-faint',
  processing: 'bg-success animate-pulse',
  waiting: 'bg-warning',
  'needs-approval': 'bg-danger animate-pulse',
  merged: 'bg-accent',
}

const STATUS_LABELS: Record<PtyStatus | 'merged', string> = {
  idle: 'Idle',
  processing: 'Working...',
  waiting: 'Waiting for input',
  'needs-approval': 'Needs approval',
  merged: 'Merged',
}

const PR_ICON_COLOR: Record<string, string> = {
  success: 'text-success',
  failure: 'text-danger',
  pending: 'text-warning',
  none: 'text-dim',
}

const PR_STATE_COLOR: Record<string, string> = {
  open: 'text-success',
  draft: 'text-dim',
  merged: 'text-accent',
  closed: 'text-danger',
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

function prIconColor(pr: PRStatus): string {
  if (pr.state === 'merged') return PR_STATE_COLOR.merged
  if (pr.state === 'closed') return PR_STATE_COLOR.closed
  if (pr.hasConflict === true) return PR_ICON_COLOR.failure
  if (pr.checksOverall === 'failure') return PR_ICON_COLOR.failure
  if (pr.checksOverall === 'pending') return PR_ICON_COLOR.pending
  if (pr.checksOverall === 'success') return PR_ICON_COLOR.success
  return PR_STATE_COLOR[pr.state] || PR_ICON_COLOR.none
}

export function CommandPalette({
  worktrees,
  worktreeStatuses,
  prStatuses,
  mergedPaths,
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

  const groups = useMemo(
    () => groupWorktrees(worktrees, prStatuses, mergedPaths),
    [worktrees, prStatuses, mergedPaths]
  )

  const actionItems = useMemo(() => {
    const items: { action: Action; label: string; hint?: string }[] = []
    for (const [action, label] of Object.entries(ACTION_LABELS)) {
      if (EXCLUDED_ACTIONS.has(action as Action)) continue
      const binding = resolvedHotkeys[action as Action]
      items.push({ action: action as Action, label, hint: binding ? bindingToString(binding) : undefined })
    }
    return items
  }, [resolvedHotkeys])

  const { items: flatItems, selectableCount } = useMemo(() => {
    const isSearching = query.trim().length > 0
    const items: PaletteItem[] = []
    let selectable = 0

    if (isSearching) {
      const scoredWts = worktrees
        .map((wt) => {
          const branch = wt.branch || wt.path.split('/').pop() || ''
          const repo = wt.repoRoot.split('/').pop() || ''
          return { wt, score: Math.max(fuzzyScore(query, branch), fuzzyScore(query, repo)) }
        })
        .filter(({ score }) => score > 0)
        .sort((a, b) => b.score - a.score)

      const scoredActions = actionItems
        .map((a) => ({ ...a, score: fuzzyScore(query, a.label) }))
        .filter(({ score }) => score > 0)
        .sort((a, b) => b.score - a.score)

      if (scoredWts.length > 0) {
        items.push({ kind: 'heading', label: 'Worktrees' })
        for (const { wt } of scoredWts) {
          items.push({ kind: 'worktree', wt })
          selectable++
        }
      }
      if (scoredActions.length > 0) {
        items.push({ kind: 'heading', label: 'Commands' })
        for (const { action, label, hint } of scoredActions) {
          items.push({ kind: 'action', action, label, hint })
          selectable++
        }
      }
    } else {
      for (const group of groups) {
        items.push({ kind: 'heading', label: GROUP_LABELS[group.key] })
        for (const wt of group.worktrees) {
          items.push({ kind: 'worktree', wt })
          selectable++
        }
      }
      items.push({ kind: 'heading', label: 'Commands' })
      for (const a of actionItems) {
        items.push({ kind: 'action', ...a })
        selectable++
      }
    }

    return { items, selectableCount: selectable }
  }, [query, worktrees, groups, actionItems])

  // Map from selectable index → flat index
  const selectableIndices = useMemo(() => {
    const indices: number[] = []
    for (let i = 0; i < flatItems.length; i++) {
      if (flatItems[i].kind !== 'heading') indices.push(i)
    }
    return indices
  }, [flatItems])

  useEffect(() => {
    setSelectedIndex(0)
  }, [query])

  const execute = useCallback(
    (item: PaletteItem) => {
      if (item.kind === 'worktree') {
        onSelectWorktree(item.wt.path)
      } else if (item.kind === 'action') {
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
        setSelectedIndex((i) => Math.min(i + 1, selectableCount - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIndex((i) => Math.max(i - 1, 0))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        const flatIdx = selectableIndices[selectedIndex]
        if (flatIdx !== undefined) execute(flatItems[flatIdx])
      }
    },
    [flatItems, selectableIndices, selectedIndex, selectableCount, execute, onClose]
  )

  useEffect(() => {
    const flatIdx = selectableIndices[selectedIndex]
    if (flatIdx === undefined) return
    const el = listRef.current?.querySelector(`[data-idx="${flatIdx}"]`) as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex, selectableIndices])

  let selectableIdx = -1

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
          {selectableCount === 0 && (
            <div className="px-4 py-8 text-center text-dim text-sm">No results</div>
          )}

          {flatItems.map((item, flatIdx) => {
            if (item.kind === 'heading') {
              return (
                <div
                  key={`h-${flatIdx}`}
                  className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-faint"
                >
                  {item.label}
                </div>
              )
            }

            selectableIdx++
            const mySelectableIdx = selectableIdx
            const isSelected = mySelectableIdx === selectedIndex

            if (item.kind === 'worktree') {
              const { wt } = item
              const status = worktreeStatuses[wt.path] || 'idle'
              const isMerged = !!mergedPaths[wt.path]
              const displayStatus: PtyStatus | 'merged' = isMerged ? 'merged' : status
              const pr = prStatuses[wt.path]
              const isActive = wt.path === activeWorktreeId
              const repoName = multiRepo ? (wt.repoRoot.split('/').pop() || wt.repoRoot) : undefined

              let iconColor = ''
              if (pr) {
                iconColor = prIconColor(pr)
              }

              return (
                <button
                  key={wt.path}
                  data-idx={flatIdx}
                  className={`w-full flex items-center gap-2 px-3 py-2 cursor-pointer transition-colors ${
                    isSelected ? 'bg-accent/15 text-fg-bright' : 'text-fg hover:bg-surface-hover'
                  }`}
                  onMouseEnter={() => setSelectedIndex(mySelectableIdx)}
                  onClick={() => execute(item)}
                >
                  <span
                    className={`w-2 h-2 rounded-full shrink-0 ${STATUS_COLORS[displayStatus]}`}
                    title={STATUS_LABELS[displayStatus]}
                  />
                  {pr && (
                    <GitPullRequest size={13} className={`shrink-0 ${iconColor}`} />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium truncate text-left">{wt.branch}</div>
                    <div className="text-xs text-faint truncate text-left">
                      {repoName ? (
                        <>
                          <span className="text-dim">{repoName}</span>
                          <span className="mx-1">&middot;</span>
                          {wt.path.split('/').pop()}
                        </>
                      ) : (
                        wt.path.split('/').slice(-2).join('/')
                      )}
                    </div>
                  </div>
                  {isActive && (
                    <span className="text-[10px] text-accent font-medium shrink-0">current</span>
                  )}
                </button>
              )
            }

            return (
              <button
                key={item.action}
                data-idx={flatIdx}
                className={`w-full flex items-center gap-2 px-3 py-2 text-sm cursor-pointer transition-colors ${
                  isSelected ? 'bg-accent/15 text-fg-bright' : 'text-fg hover:bg-surface-hover'
                }`}
                onMouseEnter={() => setSelectedIndex(mySelectableIdx)}
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
        </div>
      </div>
    </div>
  )
}

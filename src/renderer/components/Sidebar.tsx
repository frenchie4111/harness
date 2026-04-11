import { useState, useCallback, useMemo } from 'react'
import { ChevronDown, ChevronRight, Plus, RefreshCw, FolderOpen, Loader2, Settings as SettingsIcon, Sparkles, BarChart3 } from 'lucide-react'
import { Tooltip } from './Tooltip'
import type { Worktree, PtyStatus, PRStatus } from '../types'
import type { GroupKey } from '../worktree-sort'
import { groupWorktrees } from '../worktree-sort'
import { WorktreeTab } from './WorktreeTab'

interface SidebarProps {
  worktrees: Worktree[]
  activeWorktreeId: string | null
  statuses: Record<string, PtyStatus>
  prStatuses: Record<string, PRStatus | null>
  mergedPaths?: Record<string, boolean>
  lastActive: Record<string, number>
  prLoading: boolean
  /** Non-main worktrees. Used to decide whether to show the "spawn your first agent" nudge. */
  agentCount: number
  onSelectWorktree: (path: string) => void
  onNewWorktree: () => void
  onContinueWorktree: (worktreePath: string, newBranchName: string) => Promise<void>
  onDeleteWorktree: (path: string) => Promise<void>
  onRefresh: () => void
  onSelectRepo: () => void
  onOpenSettings: () => void
  onOpenActivity: () => void
}

export function Sidebar({
  worktrees,
  activeWorktreeId,
  statuses,
  prStatuses,
  mergedPaths,
  lastActive,
  prLoading,
  agentCount,
  onSelectWorktree,
  onNewWorktree,
  onContinueWorktree,
  onDeleteWorktree,
  onRefresh,
  onSelectRepo,
  onOpenSettings,
  onOpenActivity
}: SidebarProps): JSX.Element {
  const [continueTarget, setContinueTarget] = useState<{ path: string; oldBranch: string } | null>(null)
  const [continueBranchName, setContinueBranchName] = useState('')
  const [continuing, setContinuing] = useState(false)
  const [continueError, setContinueError] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<Record<GroupKey, boolean>>({ 'needs-attention': false, active: false, 'no-pr': false, merged: true })

  const suggestContinueName = useCallback((oldBranch: string) => {
    // Strip any trailing "-N" suffix, then add "-continued" (or bump N)
    const match = oldBranch.match(/^(.*?)-continued(?:-(\d+))?$/)
    if (match) {
      const next = match[2] ? parseInt(match[2], 10) + 1 : 2
      return `${match[1]}-continued-${next}`
    }
    return `${oldBranch}-continued`
  }, [])

  const beginContinue = useCallback(
    (path: string, oldBranch: string) => {
      setContinueTarget({ path, oldBranch })
      setContinueBranchName(suggestContinueName(oldBranch))
      setContinueError(null)
    },
    [suggestContinueName]
  )

  const cancelContinue = useCallback(() => {
    setContinueTarget(null)
    setContinueBranchName('')
    setContinueError(null)
  }, [])

  const submitContinue = useCallback(async () => {
    if (!continueTarget) return
    const name = continueBranchName.trim()
    if (!name) return
    setContinuing(true)
    setContinueError(null)
    try {
      await onContinueWorktree(continueTarget.path, name)
      cancelContinue()
    } catch (err) {
      setContinueError(err instanceof Error ? err.message : 'Failed to continue worktree')
    } finally {
      setContinuing(false)
    }
  }, [continueTarget, continueBranchName, onContinueWorktree, cancelContinue])

  const handleContinueKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') submitContinue()
      if (e.key === 'Escape') cancelContinue()
    },
    [submitContinue, cancelContinue]
  )

  const toggleGroup = useCallback((key: GroupKey) => {
    setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }))
  }, [])

  const groups = useMemo(
    () => groupWorktrees(worktrees, prStatuses, lastActive, mergedPaths),
    [worktrees, prStatuses, lastActive, mergedPaths]
  )

  return (
    <div className="w-56 bg-panel border-r border-border flex flex-col h-full">
      {/* Title bar drag region with app name — vertically aligned with traffic lights at y:12 */}
      <div className="drag-region h-10 relative shrink-0">
        <span className="gradient-text text-xs font-semibold absolute left-20 top-[11px]">Harness</span>
      </div>

      {/* Worktrees header */}
      <div className="px-3 py-1.5 flex items-center gap-2 shrink-0">
        <span className="text-xs font-medium text-dim">WORKTREES</span>
        {prLoading && <Loader2 size={10} className="text-faint animate-spin" />}
      </div>

      {/* Worktree list grouped by PR status */}
      <div className="flex-1 overflow-y-auto py-1">
        {agentCount === 0 && (
          <button
            onClick={onNewWorktree}
            className="group relative mx-2 mb-2 mt-1 w-[calc(100%-1rem)] text-left bg-panel-raised border border-border-strong hover:border-accent rounded-lg overflow-hidden transition-colors cursor-pointer"
          >
            <div className="brand-gradient-bg h-0.5" />
            <div className="p-3">
              <div className="flex items-center gap-1.5 mb-1">
                <Sparkles size={11} className="text-accent" />
                <span className="text-[10px] font-semibold uppercase tracking-wider text-accent">
                  Get started
                </span>
              </div>
              <div className="text-[13px] font-semibold text-fg-bright leading-snug">
                Spawn your first agent
              </div>
              <div className="text-[11px] text-dim mt-0.5 leading-snug">
                Fork a branch and send a Claude into it.
              </div>
            </div>
          </button>
        )}
        {groups.map((group) => (
          <div key={group.key}>
            <button
              onClick={() => toggleGroup(group.key)}
              className="w-full flex items-center gap-1 px-3 py-1.5 text-xs text-dim hover:text-fg transition-colors cursor-pointer"
              title={collapsed[group.key] ? `Expand ${group.label}` : `Collapse ${group.label}`}
            >
              {collapsed[group.key]
                ? <ChevronRight size={12} className="shrink-0" />
                : <ChevronDown size={12} className="shrink-0" />
              }
              <span className="font-medium">{group.label}</span>
              <span className="text-faint ml-auto">{group.worktrees.length}</span>
            </button>
            {!collapsed[group.key] && group.worktrees.map((wt) => (
              <div key={wt.path}>
                <WorktreeTab
                  worktree={wt}
                  isActive={wt.path === activeWorktreeId}
                  status={statuses[wt.path] || 'idle'}
                  prStatus={prStatuses[wt.path]}
                  onClick={() => onSelectWorktree(wt.path)}
                  onDelete={wt.isMain ? undefined : () => onDeleteWorktree(wt.path)}
                  onContinue={wt.isMain ? undefined : () => beginContinue(wt.path, wt.branch)}
                />
                {continueTarget?.path === wt.path && (
                  <div className="border-y-2 border-accent bg-panel-raised p-2.5 shadow-inner">
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-accent mb-1.5 px-0.5">
                      Continue on new branch
                    </div>
                    <input
                      type="text"
                      value={continueBranchName}
                      onChange={(e) => setContinueBranchName(e.target.value)}
                      onKeyDown={handleContinueKeyDown}
                      placeholder="new-branch-name"
                      autoFocus
                      disabled={continuing}
                      className="w-full bg-app border-2 border-border-strong rounded px-2 py-1.5 text-xs text-fg-bright placeholder-faint outline-none focus:border-accent"
                    />
                    {continueError && (
                      <div className="text-xs text-danger mt-1 px-1 truncate" title={continueError}>
                        {continueError}
                      </div>
                    )}
                    <div className="flex gap-1 mt-1.5">
                      <button
                        onClick={submitContinue}
                        disabled={continuing || !continueBranchName.trim()}
                        className="flex-1 text-xs bg-accent hover:opacity-90 disabled:opacity-40 rounded px-2 py-1 text-app font-semibold transition-opacity cursor-pointer"
                      >
                        {continuing ? 'Continuing...' : 'Continue'}
                      </button>
                      <button
                        onClick={cancelContinue}
                        disabled={continuing}
                        className="text-xs text-dim hover:text-fg px-2 py-1 transition-colors cursor-pointer"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        ))}
        {worktrees.length === 0 && (
          <div className="px-4 py-3 text-xs text-faint">
            No worktrees found
          </div>
        )}
      </div>

      {/* Bottom actions */}
      <div className="border-t border-border p-2 flex justify-center gap-1 shrink-0">
        <Tooltip label="New worktree" action="newWorktree" side="top">
          <button
            onClick={onNewWorktree}
            className="text-dim hover:text-fg hover:bg-surface rounded p-1.5 transition-colors cursor-pointer"
          >
            <Plus size={14} />
          </button>
        </Tooltip>
        <Tooltip label="Refresh worktrees" action="refreshWorktrees" side="top">
          <button
            onClick={onRefresh}
            className="text-dim hover:text-fg hover:bg-surface rounded p-1.5 transition-colors cursor-pointer"
          >
            <RefreshCw size={14} />
          </button>
        </Tooltip>
        <Tooltip label="Change repository" side="top">
          <button
            onClick={onSelectRepo}
            className="text-dim hover:text-fg hover:bg-surface rounded p-1.5 transition-colors cursor-pointer"
          >
            <FolderOpen size={14} />
          </button>
        </Tooltip>
        <Tooltip label="Activity" side="top">
          <button
            onClick={onOpenActivity}
            className="text-dim hover:text-fg hover:bg-surface rounded p-1.5 transition-colors cursor-pointer"
          >
            <BarChart3 size={14} />
          </button>
        </Tooltip>
        <Tooltip label="Settings" side="top">
          <button
            onClick={onOpenSettings}
            className="text-dim hover:text-fg hover:bg-surface rounded p-1.5 transition-colors cursor-pointer"
          >
            <SettingsIcon size={14} />
          </button>
        </Tooltip>
      </div>
    </div>
  )
}

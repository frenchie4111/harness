import { useState, useCallback, useMemo } from 'react'
import { ChevronDown, ChevronRight, Plus, RefreshCw, FolderOpen, Loader2, Settings as SettingsIcon, Sparkles, BarChart3, Trash2, LayoutGrid, X, Layers, Rows3, AlertCircle } from 'lucide-react'
import { Tooltip } from './Tooltip'
import { HotkeyBadge } from './HotkeyBadge'
import { useMetaHeld } from '../hooks/useMetaHeld'
import type { Worktree, PtyStatus, PendingTool, PRStatus, PendingWorktree } from '../types'
import type { GroupKey } from '../worktree-sort'
import { groupWorktrees } from '../worktree-sort'
import { WorktreeTab } from './WorktreeTab'
import { RepoIcon } from './RepoIcon'

interface SidebarProps {
  worktrees: Worktree[]
  pendingWorktrees: PendingWorktree[]
  activeWorktreeId: string | null
  statuses: Record<string, PtyStatus>
  pendingTools: Record<string, PendingTool | null>
  shellActivity: Record<string, boolean>
  prStatuses: Record<string, PRStatus | null>
  mergedPaths?: Record<string, boolean>
  prLoading: boolean
  /** Non-main worktrees. Used to decide whether to show the "spawn your first agent" nudge. */
  agentCount: number
  onSelectWorktree: (path: string) => void
  onDismissPendingWorktree: (id: string) => void
  onNewWorktree: () => void
  onContinueWorktree: (worktreePath: string, newBranchName: string) => Promise<void>
  onDeleteWorktree: (path: string) => Promise<void>
  onRefresh: () => void
  repoRoots: string[]
  onAddRepo: () => void
  onRemoveRepo: (repoRoot: string) => Promise<void>
  onOpenSettings: () => void
  onOpenActivity: () => void
  onOpenCleanup: () => void
  onOpenCommandCenter: () => void
  commandCenterActive: boolean
  width: number
  collapsedGroups: Record<string, boolean>
  onToggleGroup: (scope: string, key: GroupKey) => void
  isGroupCollapsed: (scope: string, key: GroupKey) => boolean
  collapsedRepos: Record<string, boolean>
  onToggleRepo: (repoRoot: string) => void
  unifiedRepos: boolean
  onToggleUnifiedRepos: () => void
}

export function Sidebar({
  worktrees,
  pendingWorktrees,
  activeWorktreeId,
  statuses,
  pendingTools,
  shellActivity,
  prStatuses,
  mergedPaths,
  prLoading,
  agentCount,
  onSelectWorktree,
  onDismissPendingWorktree,
  onNewWorktree,
  onContinueWorktree,
  onDeleteWorktree,
  onRefresh,
  repoRoots,
  onAddRepo,
  onRemoveRepo,
  onOpenSettings,
  onOpenActivity,
  onOpenCleanup,
  onOpenCommandCenter,
  commandCenterActive,
  width,
  collapsedGroups: _collapsedGroups,
  onToggleGroup,
  isGroupCollapsed,
  collapsedRepos,
  onToggleRepo,
  unifiedRepos,
  onToggleUnifiedRepos
}: SidebarProps): JSX.Element {
  const metaHeld = useMetaHeld()
  const [continueTarget, setContinueTarget] = useState<{ path: string; oldBranch: string } | null>(null)
  const [continueBranchName, setContinueBranchName] = useState('')
  const [continuing, setContinuing] = useState(false)
  const [continueError, setContinueError] = useState<string | null>(null)

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

  // Group worktrees by repo, preserving the user's repo order. In unified
  // mode we short-circuit and return a single "synthetic" repo containing
  // every worktree.
  const byRepo = useMemo(() => {
    if (unifiedRepos && repoRoots.length > 1) {
      return [{ repoRoot: '__unified__', groups: groupWorktrees(worktrees, prStatuses, mergedPaths) }]
    }
    const map = new Map<string, Worktree[]>()
    for (const root of repoRoots) map.set(root, [])
    for (const wt of worktrees) {
      if (!map.has(wt.repoRoot)) map.set(wt.repoRoot, [])
      map.get(wt.repoRoot)!.push(wt)
    }
    return Array.from(map.entries()).map(([repoRoot, wts]) => ({
      repoRoot,
      groups: groupWorktrees(wts, prStatuses, mergedPaths)
    }))
  }, [repoRoots, worktrees, prStatuses, mergedPaths, unifiedRepos])

  const showRepoHeaders = repoRoots.length > 1 && !unifiedRepos
  const showRepoLabelsOnTabs = repoRoots.length > 1 && unifiedRepos

  // Assign Cmd+1..9 ordinals in the same order as App.tsx visibleWorktrees:
  // iterate repos → groups, skipping collapsed repos/groups, so ordinals
  // match the actual hotkey targets.
  const cmdOrdinals = useMemo(() => {
    const map = new Map<string, number>()
    let n = 1
    for (const { repoRoot, groups } of byRepo) {
      if (repoRoot !== '__unified__' && collapsedRepos[repoRoot]) continue
      for (const group of groups) {
        if (isGroupCollapsed(repoRoot, group.key)) continue
        for (const wt of group.worktrees) {
          if (n > 9) break
          map.set(wt.path, n)
          n += 1
        }
        if (n > 9) break
      }
      if (n > 9) break
    }
    return map
  }, [byRepo, collapsedRepos, isGroupCollapsed])

  const repoLabelFor = useCallback((repoRoot: string): string => {
    return repoRoot.split('/').pop() || repoRoot
  }, [])

  return (
    <div
      className="shrink-0 bg-panel flex flex-col h-full"
      style={{ width }}
    >
      {/* Title bar drag region with app name — vertically aligned with traffic lights at y:12 */}
      <div className="drag-region h-10 relative shrink-0">
        <span className="gradient-text text-xs font-semibold absolute left-20 top-[11px]">Harness</span>
      </div>

      {/* Command Center entry */}
      <div className="px-2 pt-1 pb-1 shrink-0">
        <button
          onClick={onOpenCommandCenter}
          className={`w-full flex items-center gap-2 px-2 py-1.5 rounded transition-colors cursor-pointer ${
            commandCenterActive
              ? 'bg-surface text-fg-bright'
              : 'text-muted hover:bg-panel-raised hover:text-fg'
          }`}
        >
          <LayoutGrid size={14} className={commandCenterActive ? 'text-accent' : 'text-dim'} />
          <span className="text-sm font-medium">Command Center</span>
          {metaHeld && (
            <HotkeyBadge action="toggleCommandCenter" variant="strong" className="ml-auto" />
          )}
        </button>
      </div>

      {/* Worktrees header */}
      <div className="px-3 py-1.5 flex items-center gap-2 shrink-0">
        <span className="text-xs font-medium text-dim">WORKTREES</span>
        {prLoading && <Loader2 size={10} className="text-faint animate-spin" />}
        {repoRoots.length > 1 && (
          <Tooltip
            label={unifiedRepos ? 'Split by repo' : 'Merge repos into one list'}
            side="bottom"
          >
            <button
              onClick={onToggleUnifiedRepos}
              className="ml-auto text-dim hover:text-fg hover:bg-surface rounded p-0.5 transition-colors cursor-pointer"
            >
              {unifiedRepos ? <Rows3 size={12} /> : <Layers size={12} />}
            </button>
          </Tooltip>
        )}
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
              <div className="mt-2">
                <HotkeyBadge action="newWorktree" />
              </div>
            </div>
          </button>
        )}
        {byRepo.map(({ repoRoot, groups }) => {
          const repoCollapsed = collapsedRepos[repoRoot] === true
          const repoName = repoRoot === '__unified__' ? 'All repos' : repoRoot.split('/').pop() || repoRoot
          const scope = repoRoot
          const groupsBody = groups.map((group) => (
          <div key={group.key}>
            <button
              onClick={() => onToggleGroup(scope, group.key)}
              className="w-full flex items-center gap-1 px-3 py-1.5 text-xs text-dim hover:text-fg transition-colors cursor-pointer"
              title={isGroupCollapsed(scope, group.key) ? `Expand ${group.label}` : `Collapse ${group.label}`}
            >
              {isGroupCollapsed(scope, group.key)
                ? <ChevronRight size={12} className="shrink-0" />
                : <ChevronDown size={12} className="shrink-0" />
              }
              <span className="font-medium">{group.label}</span>
              <span className="text-faint ml-auto">{group.worktrees.length}</span>
            </button>
            {!isGroupCollapsed(scope, group.key) && group.worktrees.map((wt) => (
              <div key={wt.path}>
                <WorktreeTab
                  worktree={wt}
                  isActive={wt.path === activeWorktreeId}
                  status={statuses[wt.path] || 'idle'}
                  pendingTool={pendingTools[wt.path] || null}
                  shellActive={!!shellActivity[wt.path]}
                  prStatus={prStatuses[wt.path]}
                  isMerged={group.key === 'merged'}
                  repoLabel={showRepoLabelsOnTabs ? repoLabelFor(wt.repoRoot) : undefined}
                  cmdOrdinal={cmdOrdinals.get(wt.path)}
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
          ))
          const repoPendings =
            repoRoot === '__unified__'
              ? pendingWorktrees
              : pendingWorktrees.filter((p) => p.repoRoot === repoRoot)
          const pendingBody = repoPendings.map((pending) => (
            <PendingWorktreeRow
              key={pending.id}
              pending={pending}
              isActive={pending.id === activeWorktreeId}
              onClick={() => onSelectWorktree(pending.id)}
              onDismiss={() => onDismissPendingWorktree(pending.id)}
            />
          ))
          return (
            <div key={repoRoot}>
              {showRepoHeaders && (
                <button
                  onClick={() => onToggleRepo(repoRoot)}
                  className="group w-full flex items-center gap-1 px-3 mt-1 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-dim hover:text-fg transition-colors cursor-pointer"
                  title={repoRoot}
                >
                  {repoCollapsed
                    ? <ChevronRight size={11} className="shrink-0" />
                    : <ChevronDown size={11} className="shrink-0" />}
                  <RepoIcon repoName={repoName} size={14} />
                  <span className="truncate">{repoName}</span>
                  <span
                    role="button"
                    className="ml-auto opacity-0 group-hover:opacity-100 text-faint hover:text-danger"
                    title={`Remove ${repoName} from workspace`}
                    onClick={(e) => {
                      e.stopPropagation()
                      if (window.confirm(`Remove ${repoName} from this window? Worktrees stay on disk.`)) {
                        void onRemoveRepo(repoRoot)
                      }
                    }}
                  >
                    <X size={11} />
                  </span>
                </button>
              )}
              {!repoCollapsed && pendingBody}
              {!repoCollapsed && groupsBody}
            </div>
          )
        })}
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
        <Tooltip label="Add repository" side="top">
          <button
            onClick={onAddRepo}
            className="text-dim hover:text-fg hover:bg-surface rounded p-1.5 transition-colors cursor-pointer"
          >
            <FolderOpen size={14} />
          </button>
        </Tooltip>
        <Tooltip label="Clean up old worktrees" side="top">
          <button
            onClick={onOpenCleanup}
            className="text-dim hover:text-fg hover:bg-surface rounded p-1.5 transition-colors cursor-pointer"
          >
            <Trash2 size={14} />
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

interface PendingWorktreeRowProps {
  pending: PendingWorktree
  isActive: boolean
  onClick: () => void
  onDismiss: () => void
}

function PendingWorktreeRow({ pending, isActive, onClick, onDismiss }: PendingWorktreeRowProps): JSX.Element {
  const isError = pending.status === 'error'
  return (
    <div
      onClick={onClick}
      className={`group w-full text-left px-3 py-2 flex items-center gap-2 transition-colors cursor-pointer ${
        isActive ? 'bg-surface text-fg-bright' : 'text-muted hover:bg-panel-raised hover:text-fg'
      }`}
    >
      {isError ? (
        <AlertCircle size={13} className="shrink-0 text-danger" />
      ) : (
        <Loader2 size={13} className="shrink-0 text-accent animate-spin" />
      )}
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium truncate">{pending.branchName}</div>
        <div className="text-xs text-faint truncate">
          {isError ? 'Failed to create' : 'Creating worktree…'}
        </div>
      </div>
      {isError && (
        <Tooltip label="Dismiss" side="left">
          <button
            onClick={(e) => {
              e.stopPropagation()
              onDismiss()
            }}
            className="opacity-0 group-hover:opacity-100 text-faint hover:text-danger transition-all shrink-0 cursor-pointer"
          >
            <X size={12} />
          </button>
        </Tooltip>
      )}
    </div>
  )
}

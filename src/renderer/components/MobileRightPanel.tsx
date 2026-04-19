import { useCallback } from 'react'
import { ChevronLeft } from 'lucide-react'
import { useRepoConfigs, useSettings } from '../store'
import { PRStatusPanel, MergeLocallyPanel } from './PRStatusPanel'
import { BranchCommitsPanel } from './BranchCommitsPanel'
import { CostPanel } from './CostPanel'
import type { Worktree, PRStatus } from '../types'

interface MobileRightPanelProps {
  activeWorktree: Worktree | null
  prStatuses: Record<string, PRStatus | null>
  prLoading: boolean
  onClose: () => void
}

// Fullscreen takeover that surfaces the useful slices of the desktop
// right panel — PR status, local merge, branch commits, cost. File
// panels (ChangedFiles / AllFiles) are intentionally omitted: their
// primary interaction is "tap a file to open a diff tab", and mobile
// can't render diff/file tabs meaningfully.
export function MobileRightPanel({
  activeWorktree,
  prStatuses,
  prLoading,
  onClose
}: MobileRightPanelProps): JSX.Element {
  const repoConfigs = useRepoConfigs()
  const settings = useSettings()
  const hasGithubToken = settings.hasGithubToken || settings.githubAuthSource === 'gh-cli'
  const activeRepoConfig = activeWorktree ? repoConfigs[activeWorktree.repoRoot] ?? null : null
  void activeRepoConfig

  const handleRefresh = useCallback(() => {
    void window.api.refreshPRsAll()
  }, [])

  const handleRemoveWorktree = useCallback(
    (path: string): void => {
      if (!activeWorktree) return
      void window.api.removeWorktree(activeWorktree.repoRoot, path)
      onClose()
    },
    [activeWorktree, onClose]
  )

  const repoLabel = activeWorktree
    ? activeWorktree.repoRoot.split('/').pop() || activeWorktree.repoRoot
    : null

  return (
    <div className="absolute inset-0 z-40 flex flex-col bg-app">
      <div className="shrink-0 flex items-stretch border-b border-border bg-panel h-11">
        <button
          onClick={onClose}
          className="shrink-0 inline-flex items-center justify-center w-11 h-full border-r border-border hover:bg-panel-raised"
          aria-label="Back"
        >
          <ChevronLeft className="w-5 h-5 text-fg" />
        </button>
        <div className="flex-1 min-w-0 flex flex-col justify-center px-3">
          <span className="text-[10px] uppercase tracking-wider text-dim truncate">
            {repoLabel ?? 'Worktree'}
          </span>
          <span className="text-xs font-medium text-fg-bright truncate">
            {activeWorktree?.branch || activeWorktree?.path.split('/').pop() || 'No worktree'}
          </span>
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto">
        {!activeWorktree && (
          <div className="p-6 text-center text-dim text-sm">
            Pick a worktree first.
          </div>
        )}
        {activeWorktree && (
          <>
            <PRStatusPanel
              pr={prStatuses[activeWorktree.path] ?? null}
              hasGithubToken={hasGithubToken}
              loading={prLoading}
              onRefresh={handleRefresh}
              onConnectGithub={onClose}
            />
            <MergeLocallyPanel
              pr={prStatuses[activeWorktree.path] ?? null}
              worktree={activeWorktree}
              hasGithubToken={hasGithubToken}
              onMerged={handleRefresh}
              onRemoveWorktree={handleRemoveWorktree}
            />
            <BranchCommitsPanel worktreePath={activeWorktree.path} />
            <CostPanel worktreePath={activeWorktree.path} />
            <div className="px-4 py-3 text-[11px] text-dim">
              File diffs and commit review open only on desktop for now.
            </div>
          </>
        )}
      </div>
    </div>
  )
}

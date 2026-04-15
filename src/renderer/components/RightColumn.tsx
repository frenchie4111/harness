import type { PRStatus, Worktree, RepoConfig } from '../types'
import { PRStatusPanel, MergeLocallyPanel } from './PRStatusPanel'
import { BranchCommitsPanel } from './BranchCommitsPanel'
import { ChangedFilesPanel } from './ChangedFilesPanel'
import { AllFilesPanel } from './AllFilesPanel'
import { CostPanel } from './CostPanel'

type BranchCommitsPanelProps = React.ComponentProps<typeof BranchCommitsPanel>
type ChangedFilesPanelProps = React.ComponentProps<typeof ChangedFilesPanel>
type AllFilesPanelProps = React.ComponentProps<typeof AllFilesPanel>

interface RightColumnProps {
  width: number
  activeWorktreeId: string | null
  worktrees: Worktree[]
  prStatuses: Record<string, PRStatus | null>
  prLoading: boolean
  hasGithubToken: boolean
  activeRepoConfig: RepoConfig | null
  onRefreshPRs: () => void
  onOpenGithubSettings: () => void
  onMerged: () => void
  onRemoveWorktree: (path: string) => void
  onOpenCommit: BranchCommitsPanelProps['onOpenCommit']
  onOpenDiff: ChangedFilesPanelProps['onOpenDiff']
  onOpenFile: AllFilesPanelProps['onOpenFile']
  onSendToClaude: (worktreePath: string, text: string) => void
}

export function RightColumn({
  width,
  activeWorktreeId,
  worktrees,
  prStatuses,
  prLoading,
  hasGithubToken,
  activeRepoConfig,
  onRefreshPRs,
  onOpenGithubSettings,
  onMerged,
  onRemoveWorktree,
  onOpenCommit,
  onOpenDiff,
  onOpenFile,
  onSendToClaude
}: RightColumnProps): JSX.Element {
  return (
    <div
      className="shrink-0 h-full flex flex-col bg-panel"
      style={{ width }}
    >
      {!activeRepoConfig?.hideMergePanel && (
        <MergeLocallyPanel
          pr={activeWorktreeId ? prStatuses[activeWorktreeId] : null}
          worktree={worktrees.find((w) => w.path === activeWorktreeId) || null}
          hasGithubToken={hasGithubToken}
          onMerged={onMerged}
          onRemoveWorktree={onRemoveWorktree}
        />
      )}
      {!activeRepoConfig?.hidePrPanel && (
        <PRStatusPanel
          pr={activeWorktreeId ? prStatuses[activeWorktreeId] : null}
          hasGithubToken={hasGithubToken}
          loading={prLoading}
          onRefresh={onRefreshPRs}
          onConnectGithub={onOpenGithubSettings}
        />
      )}
      <BranchCommitsPanel worktreePath={activeWorktreeId} onOpenCommit={onOpenCommit} />
      <ChangedFilesPanel
        worktreePath={activeWorktreeId}
        onOpenDiff={onOpenDiff}
        onSendToClaude={
          activeWorktreeId ? (text) => onSendToClaude(activeWorktreeId, text) : undefined
        }
      />
      <AllFilesPanel
        worktreePath={activeWorktreeId}
        onOpenFile={onOpenFile}
        onSendToClaude={
          activeWorktreeId ? (text) => onSendToClaude(activeWorktreeId, text) : undefined
        }
      />
      <CostPanel worktreePath={activeWorktreeId} />
    </div>
  )
}

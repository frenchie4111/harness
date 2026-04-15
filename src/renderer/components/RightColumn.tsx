import type { PRStatus, Worktree, RepoConfig } from '../types'
import {
  effectiveHiddenRightPanels,
  type HiddenRightPanels
} from '../../shared/state/repo-configs'
import { PRStatusPanel, MergeLocallyPanel } from './PRStatusPanel'
import { BranchCommitsPanel } from './BranchCommitsPanel'
import { ChangedFilesPanel } from './ChangedFilesPanel'
import { AllFilesPanel } from './AllFilesPanel'
import { CostPanel } from './CostPanel'
import { RightColumnToolbar } from './RightColumnToolbar'

type BranchCommitsPanelProps = React.ComponentProps<typeof BranchCommitsPanel>
type ChangedFilesPanelProps = React.ComponentProps<typeof ChangedFilesPanel>
type AllFilesPanelProps = React.ComponentProps<typeof AllFilesPanel>

interface RightColumnProps {
  width: number
  activeWorktreeId: string | null
  activeRepoRoot: string | null
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
  onCollapse: () => void
}

export function RightColumn({
  width,
  activeWorktreeId,
  activeRepoRoot,
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
  onSendToClaude,
  onCollapse
}: RightColumnProps): JSX.Element {
  const hidden = effectiveHiddenRightPanels(activeRepoConfig)

  const handleChangeHidden = (next: HiddenRightPanels): void => {
    if (!activeRepoRoot) return
    // Send the full hiddenRightPanels object; also null out legacy
    // fields so old values don't leak back in via effective migration.
    void window.api.setRepoConfig(activeRepoRoot, {
      hiddenRightPanels: next,
      hideMergePanel: null,
      hidePrPanel: null
    } as unknown as Partial<RepoConfig>)
  }

  return (
    <div
      className="shrink-0 h-full flex flex-col bg-panel"
      style={{ width }}
    >
      <RightColumnToolbar
        hidden={hidden}
        onChangeHidden={handleChangeHidden}
        onCollapse={onCollapse}
        canConfigure={!!activeRepoRoot}
      />
      {!hidden.merge && (
        <MergeLocallyPanel
          pr={activeWorktreeId ? prStatuses[activeWorktreeId] : null}
          worktree={worktrees.find((w) => w.path === activeWorktreeId) || null}
          hasGithubToken={hasGithubToken}
          onMerged={onMerged}
          onRemoveWorktree={onRemoveWorktree}
        />
      )}
      {!hidden.pr && (
        <PRStatusPanel
          pr={activeWorktreeId ? prStatuses[activeWorktreeId] : null}
          hasGithubToken={hasGithubToken}
          loading={prLoading}
          onRefresh={onRefreshPRs}
          onConnectGithub={onOpenGithubSettings}
        />
      )}
      {!hidden.commits && (
        <BranchCommitsPanel worktreePath={activeWorktreeId} onOpenCommit={onOpenCommit} />
      )}
      {!hidden.changedFiles && (
        <ChangedFilesPanel
          worktreePath={activeWorktreeId}
          onOpenDiff={onOpenDiff}
          onSendToClaude={
            activeWorktreeId ? (text) => onSendToClaude(activeWorktreeId, text) : undefined
          }
        />
      )}
      {!hidden.allFiles && (
        <AllFilesPanel
          worktreePath={activeWorktreeId}
          onOpenFile={onOpenFile}
          onSendToClaude={
            activeWorktreeId ? (text) => onSendToClaude(activeWorktreeId, text) : undefined
          }
        />
      )}
      {!hidden.cost && <CostPanel worktreePath={activeWorktreeId} />}
    </div>
  )
}

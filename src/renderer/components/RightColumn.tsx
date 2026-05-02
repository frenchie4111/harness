import type { PRStatus, Worktree, RepoConfig } from '../types'
import {
  effectiveHiddenRightPanels,
  effectiveRightPanelOrder,
  type HiddenRightPanels,
  type RightPanelKey
} from '../../shared/state/repo-configs'
import { PRStatusPanel, MergeLocallyPanel } from './PRStatusPanel'
import { BranchCommitsPanel } from './BranchCommitsPanel'
import { ChangedFilesPanel } from './ChangedFilesPanel'
import { AllFilesPanel } from './AllFilesPanel'
import { CostPanel } from './CostPanel'
import { JsonClaudeTodosPanel } from './JsonClaudeTodosPanel'
import { RightColumnToolbar } from './RightColumnToolbar'

type ChangedFilesPanelProps = React.ComponentProps<typeof ChangedFilesPanel>
type AllFilesPanelProps = React.ComponentProps<typeof AllFilesPanel>

interface RightColumnProps {
  width: number
  activeWorktreeId: string | null
  activeRepoRoot: string | null
  /** Id of the currently focused tab in the active worktree's focused
   *  pane. Used by the Todos panel to look up the focused json-claude
   *  session; null when no worktree is active. */
  focusedTabId: string | null
  worktrees: Worktree[]
  prStatuses: Record<string, PRStatus | null>
  prLoading: boolean
  hasGithubToken: boolean
  activeRepoConfig: RepoConfig | null
  onRefreshPRs: () => void
  onOpenGithubSettings: () => void
  onMerged: () => void
  onRemoveWorktree: (path: string) => void
  onOpenCommitReview: (hash: string, shortHash: string, subject: string) => void
  onOpenDiff: ChangedFilesPanelProps['onOpenDiff']
  onOpenFile: AllFilesPanelProps['onOpenFile']
  onSendToAgent: (worktreePath: string, text: string) => void
  onOpenReview: () => void
  onCollapse: () => void
}

export function RightColumn({
  width,
  activeWorktreeId,
  activeRepoRoot,
  focusedTabId,
  worktrees,
  prStatuses,
  prLoading,
  hasGithubToken,
  activeRepoConfig,
  onRefreshPRs,
  onOpenGithubSettings,
  onMerged,
  onRemoveWorktree,
  onOpenCommitReview,
  onOpenDiff,
  onOpenFile,
  onSendToAgent,
  onOpenReview,
  onCollapse
}: RightColumnProps): JSX.Element {
  const hidden = effectiveHiddenRightPanels(activeRepoConfig)
  const order = effectiveRightPanelOrder(activeRepoConfig)

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

  const handleChangeOrder = (next: RightPanelKey[]): void => {
    if (!activeRepoRoot) return
    void window.api.setRepoConfig(activeRepoRoot, {
      rightPanelOrder: next
    } as unknown as Partial<RepoConfig>)
  }

  const renderPanel = (key: RightPanelKey): JSX.Element | null => {
    if (hidden[key]) return null
    switch (key) {
      case 'merge':
        return (
          <MergeLocallyPanel
            key="merge"
            pr={activeWorktreeId ? prStatuses[activeWorktreeId] : null}
            worktree={worktrees.find((w) => w.path === activeWorktreeId) || null}
            hasGithubToken={hasGithubToken}
            onMerged={onMerged}
            onRemoveWorktree={onRemoveWorktree}
          />
        )
      case 'pr':
        return (
          <PRStatusPanel
            key="pr"
            pr={activeWorktreeId ? prStatuses[activeWorktreeId] : null}
            hasGithubToken={hasGithubToken}
            loading={prLoading}
            onRefresh={onRefreshPRs}
            onConnectGithub={onOpenGithubSettings}
          />
        )
      case 'todos':
        return <JsonClaudeTodosPanel key="todos" focusedTabId={focusedTabId} />
      case 'commits':
        return (
          <BranchCommitsPanel
            key="commits"
            worktreePath={activeWorktreeId}
            onOpenCommitReview={onOpenCommitReview}
          />
        )
      case 'changedFiles':
        return (
          <ChangedFilesPanel
            key="changedFiles"
            worktreePath={activeWorktreeId}
            onOpenDiff={onOpenDiff}
            onSendToAgent={
              activeWorktreeId ? (text) => onSendToAgent(activeWorktreeId, text) : undefined
            }
            onOpenReview={onOpenReview}
          />
        )
      case 'allFiles':
        return (
          <AllFilesPanel
            key="allFiles"
            worktreePath={activeWorktreeId}
            onOpenFile={onOpenFile}
            onSendToAgent={
              activeWorktreeId ? (text) => onSendToAgent(activeWorktreeId, text) : undefined
            }
          />
        )
      case 'cost':
        return <CostPanel key="cost" worktreePath={activeWorktreeId} />
    }
  }

  return (
    <div
      className="shrink-0 h-full flex flex-col bg-panel"
      style={{ width }}
    >
      <RightColumnToolbar
        hidden={hidden}
        order={order}
        onChangeHidden={handleChangeHidden}
        onChangeOrder={handleChangeOrder}
        onCollapse={onCollapse}
        canConfigure={!!activeRepoRoot}
      />
      {order.map((key) => renderPanel(key))}
    </div>
  )
}

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
  /** When true, render as a fixed-position slide-over from the right with
   *  a backdrop instead of a flex column. Used at narrow viewports so the
   *  right panel collapses out of the way unless explicitly opened. */
  slideover?: boolean
  /** Whether the slide-over is currently visible. Ignored when
   *  `slideover` is false. */
  slideoverOpen?: boolean
  /** Backdrop / close-button click handler. Ignored when `slideover` is
   *  false. */
  onSlideoverClose?: () => void
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
  onCollapse,
  slideover,
  slideoverOpen,
  onSlideoverClose
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

  const body = (
    <div
      className={`shrink-0 h-full flex flex-col bg-panel ${
        slideover ? 'overflow-y-auto' : ''
      }`}
      style={slideover ? undefined : { width }}
    >
      <RightColumnToolbar
        hidden={hidden}
        order={order}
        onChangeHidden={handleChangeHidden}
        onChangeOrder={handleChangeOrder}
        onCollapse={slideover ? onSlideoverClose ?? onCollapse : onCollapse}
        canConfigure={!!activeRepoRoot}
      />
      {order.map((key) => renderPanel(key))}
    </div>
  )
  if (!slideover) return body
  return (
    <div
      className={`fixed inset-0 z-40 ${slideoverOpen ? '' : 'pointer-events-none'}`}
      aria-hidden={!slideoverOpen}
    >
      <div
        className={`absolute inset-0 bg-black/60 transition-opacity ${
          slideoverOpen ? 'opacity-100' : 'opacity-0'
        }`}
        onClick={onSlideoverClose}
      />
      <div
        className={`absolute inset-y-0 right-0 max-w-[90%] shadow-2xl transform transition-transform ${
          slideoverOpen ? 'translate-x-0' : 'translate-x-full'
        }`}
        style={{ width: 'min(360px, 90%)' }}
      >
        {body}
      </div>
    </div>
  )
}

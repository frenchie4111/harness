import { useCallback, useEffect, useRef, useState } from 'react'
import {
  PanelRightOpen,
  GitMerge,
  GitPullRequest,
  ClipboardCheck,
  Code2,
  FolderOpen,
  FolderSearch2,
  Loader2,
  Check,
  Pencil,
  GitCommitHorizontal,
  RefreshCw,
  CircleX
} from 'lucide-react'
import { Tooltip } from './Tooltip'
import { useActiveBackend, usePrs, useRepoConfigs, useSettings, useWorktrees } from '../store'
import { useBackend } from '../backend'
import { useWatchedQuery } from '../hooks/useWatchedQuery'
import type {
  BranchCommit,
  ChangedFile,
  GitHubMergeMethod,
  MergePRResult,
  MergeStrategy
} from '../types'

interface ChangedFilesData {
  working: ChangedFile[]
  branch: ChangedFile[]
}

interface CollapsedRightPanelProps {
  worktreePath: string | null
  onExpand: () => void
  onReview: () => void
  /** Opens the fuzzy file-open palette (same overlay as the Cmd+P
   *  fileQuickOpen hotkey). */
  onFileQuickOpen: () => void
}

const WIDTH = 48

// 'fast-forward' has no GitHub equivalent — 'rebase' is the closest
// approximation (linear history but rewritten commit SHAs). Same mapping
// PRStatusPanel uses.
const STRATEGY_TO_METHOD: Record<MergeStrategy, GitHubMergeMethod> = {
  squash: 'squash',
  'merge-commit': 'merge',
  'fast-forward': 'rebase'
}

const METHOD_LABEL: Record<GitHubMergeMethod, string> = {
  squash: 'Squash+Merge',
  merge: 'Merge',
  rebase: 'Rebase+Merge'
}

export function CollapsedRightPanel({
  worktreePath,
  onExpand,
  onReview,
  onFileQuickOpen
}: CollapsedRightPanelProps): JSX.Element {
  const backend = useBackend()
  const activeBackend = useActiveBackend()
  const isLocal = activeBackend.kind === 'local'

  const worktrees = useWorktrees().list
  const prs = usePrs()
  const settings = useSettings()
  const repoConfigs = useRepoConfigs()

  const worktree = worktreePath ? worktrees.find((w) => w.path === worktreePath) ?? null : null
  const pr = worktreePath ? prs.byPath[worktreePath] ?? null : null
  const hasGithubToken = settings.hasGithubToken || !!settings.githubAuthSource

  // Counts for the badge buttons. Shared cacheKeys with ChangedFilesPanel
  // and BranchCommitsPanel so the expanded right column doesn't re-fetch
  // when the user toggles between collapsed and expanded.
  const changedFilesFetcher = useCallback(
    async (path: string): Promise<ChangedFilesData> => {
      const [working, branch] = await Promise.all([
        backend.getChangedFiles(path, 'working'),
        backend.getChangedFiles(path, 'branch')
      ])
      return { working, branch }
    },
    [backend]
  )
  const { data: changedFilesData, loading: changedFilesLoading, refresh: refreshChangedFiles } =
    useWatchedQuery<ChangedFilesData>({
      worktreePath,
      cacheKey: 'changedFiles',
      fetcher: changedFilesFetcher
    })
  const commitsFetcher = useCallback(
    (path: string) => backend.getBranchCommits(path),
    [backend]
  )
  const { data: commitsData, loading: commitsLoading, refresh: refreshCommits } =
    useWatchedQuery<BranchCommit[]>({
      worktreePath,
      cacheKey: 'branchCommits',
      fetcher: commitsFetcher
    })
  const changedFilesCount =
    (changedFilesData?.working.length ?? 0) + (changedFilesData?.branch.length ?? 0)
  const commitsCount = commitsData?.length ?? 0
  const hasUnpushedCommits = !!commitsData?.some((c) => !c.pushed)

  const handleRefreshAll = useCallback(() => {
    refreshChangedFiles()
    refreshCommits()
    if (worktreePath) void backend.refreshPRsOne(worktreePath)
  }, [refreshChangedFiles, refreshCommits, worktreePath, backend])
  const refreshing = changedFilesLoading || commitsLoading

  const strategy: MergeStrategy =
    (worktree && repoConfigs[worktree.repoRoot]?.mergeStrategy) || settings.mergeStrategy
  const method = STRATEGY_TO_METHOD[strategy]
  const methodLabel = METHOD_LABEL[method]

  // Merge button state — mirrors the 2-click confirm pattern in
  // PRStatusPanel. First click arms; second within 5s actually fires.
  const [confirming, setConfirming] = useState(false)
  const [merging, setMerging] = useState(false)
  const [justMerged, setJustMerged] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const justMergedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current)
      if (justMergedTimerRef.current) clearTimeout(justMergedTimerRef.current)
      if (errorTimerRef.current) clearTimeout(errorTimerRef.current)
    }
  }, [])

  // Reset confirm/just-merged when the PR identity or worktree changes.
  useEffect(() => {
    setConfirming(false)
    setJustMerged(false)
    setError(null)
    if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current)
  }, [worktreePath, pr?.number, pr?.state])

  let mergeDisabledReason: string | null = null
  if (!pr) mergeDisabledReason = 'No PR to merge'
  else if (!hasGithubToken) mergeDisabledReason = 'Connect a GitHub token to merge'
  else if (pr.state === 'merged') mergeDisabledReason = 'Already merged'
  else if (pr.state === 'closed') mergeDisabledReason = 'PR is closed'
  else if (pr.state === 'draft') mergeDisabledReason = "Draft PRs can't be merged"
  else if (pr.hasConflict === true) mergeDisabledReason = 'There are merge conflicts'
  const canMerge = mergeDisabledReason === null && !merging && !justMerged

  const performMerge = useCallback(async () => {
    if (!worktreePath) return
    setConfirming(false)
    if (confirmTimerRef.current) {
      clearTimeout(confirmTimerRef.current)
      confirmTimerRef.current = null
    }
    setMerging(true)
    setError(null)
    try {
      const result: MergePRResult = await backend.mergePR(worktreePath, method)
      if (result.ok) {
        setJustMerged(true)
        justMergedTimerRef.current = setTimeout(() => setJustMerged(false), 4000)
      } else {
        setError(result.error || 'Merge failed')
        errorTimerRef.current = setTimeout(() => setError(null), 6000)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      errorTimerRef.current = setTimeout(() => setError(null), 6000)
    } finally {
      setMerging(false)
    }
  }, [worktreePath, method, backend])

  const onMergeClick = useCallback(() => {
    if (!canMerge) return
    if (confirming) {
      void performMerge()
      return
    }
    setError(null)
    setConfirming(true)
    if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current)
    confirmTimerRef.current = setTimeout(() => {
      setConfirming(false)
      confirmTimerRef.current = null
    }, 5000)
  }, [canMerge, confirming, performMerge])

  let mergeTooltip: string
  let mergeColor: string
  let MergeIcon = GitMerge
  if (merging) {
    mergeTooltip = `Merging via ${methodLabel}…`
    mergeColor = 'text-dim'
    MergeIcon = Loader2
  } else if (justMerged) {
    mergeTooltip = 'Merged ✓'
    mergeColor = 'text-success'
    MergeIcon = Check
  } else if (error) {
    mergeTooltip = error
    mergeColor = 'text-danger'
  } else if (mergeDisabledReason) {
    mergeTooltip = mergeDisabledReason
    mergeColor = 'text-dim'
  } else if (confirming) {
    mergeTooltip = `Click again to merge via ${methodLabel}`
    mergeColor = 'text-warning'
  } else {
    mergeTooltip = `Merge PR on GitHub (${methodLabel})`
    mergeColor = 'text-dim'
  }

  const hasPR = !!pr
  const prUrl = pr?.url ?? null
  const failedChecksCount = pr?.checks.filter((c) => c.state === 'failure' || c.state === 'error').length ?? 0

  return (
    <div
      className="shrink-0 h-full flex flex-col bg-panel border-l border-border"
      style={{ width: WIDTH }}
    >
      <div className="no-drag flex flex-col items-center gap-1 py-1">
        <Tooltip label="Expand sidebar" action="toggleRightColumn" side="left">
          <button
            onClick={onExpand}
            className="text-dim hover:text-fg hover:bg-surface rounded p-1.5 transition-colors cursor-pointer"
            aria-label="Expand right column"
          >
            <PanelRightOpen className="icon-sm" />
          </button>
        </Tooltip>

        <div className="h-px w-6 bg-border my-1" />

        <Tooltip
          label={hasPR ? 'Open PR' : 'No PR to open'}
          action={hasPR ? 'openPR' : undefined}
          side="left"
        >
          <button
            onClick={() => prUrl && backend.openExternal(prUrl)}
            disabled={!hasPR}
            className="text-dim hover:text-fg hover:bg-surface rounded p-1.5 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-dim"
            aria-label="Open PR in browser"
          >
            <GitPullRequest size={14} />
          </button>
        </Tooltip>
        <Tooltip label={mergeTooltip} side="left">
          <button
            onClick={onMergeClick}
            disabled={!canMerge}
            className={`${mergeColor} hover:text-fg hover:bg-surface rounded p-1.5 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent`}
            aria-label="Merge PR on GitHub"
          >
            <MergeIcon size={14} className={merging ? 'animate-spin' : undefined} />
          </button>
        </Tooltip>
        {failedChecksCount > 0 && (
          <Tooltip
            label={`${failedChecksCount} failed check${failedChecksCount === 1 ? '' : 's'}`}
            side="left"
          >
            <button
              onClick={onExpand}
              className="text-danger hover:bg-surface rounded px-1 py-1 transition-colors cursor-pointer flex items-center gap-0.5"
              aria-label={`${failedChecksCount} failed checks`}
            >
              <CircleX size={12} />
              <span className="text-[10px] tabular-nums leading-none">{failedChecksCount}</span>
            </button>
          </Tooltip>
        )}

        <div className="h-px w-6 bg-border my-1" />

        <Tooltip label="Review changes" action="openReview" side="left">
          <button
            onClick={onReview}
            className="text-dim hover:text-fg hover:bg-surface rounded p-1.5 transition-colors cursor-pointer"
            aria-label="Review changes"
          >
            <ClipboardCheck size={14} />
          </button>
        </Tooltip>

        <Tooltip
          label={`${changedFilesCount} changed file${changedFilesCount === 1 ? '' : 's'} (uncommitted + committed)`}
          side="left"
        >
          <button
            onClick={onExpand}
            className="text-dim hover:text-fg hover:bg-surface rounded px-1 py-1 transition-colors cursor-pointer flex items-center gap-0.5"
            aria-label={`${changedFilesCount} changed files`}
          >
            <Pencil size={12} />
            <span className="text-[10px] tabular-nums leading-none">{changedFilesCount}</span>
          </button>
        </Tooltip>
        <Tooltip
          label={
            hasUnpushedCommits
              ? `${commitsCount} commit${commitsCount === 1 ? '' : 's'} (unpushed)`
              : `${commitsCount} commit${commitsCount === 1 ? '' : 's'}`
          }
          side="left"
        >
          <button
            onClick={onExpand}
            className={`${hasUnpushedCommits ? 'text-warning' : 'text-dim'} hover:text-fg hover:bg-surface rounded px-1 py-1 transition-colors cursor-pointer flex items-center gap-0.5`}
            aria-label={`${commitsCount} commits`}
          >
            <GitCommitHorizontal size={12} />
            <span className="text-[10px] tabular-nums leading-none">{commitsCount}</span>
          </button>
        </Tooltip>

        <div className="h-px w-6 bg-border my-1" />

        {worktreePath && (
          <Tooltip label="Open worktree in editor" action="openInEditor" side="left">
            <button
              onClick={() => backend.openInEditor(worktreePath)}
              className="text-dim hover:text-fg hover:bg-surface rounded p-1.5 transition-colors cursor-pointer"
              aria-label="Open worktree in editor"
            >
              <Code2 className="icon-sm" />
            </button>
          </Tooltip>
        )}
        {worktreePath && isLocal && (
          <Tooltip label="Reveal in Finder" side="left">
            <button
              onClick={() => backend.openPath(worktreePath)}
              className="text-dim hover:text-fg hover:bg-surface rounded p-1.5 transition-colors cursor-pointer"
              aria-label="Reveal worktree in Finder"
            >
              <FolderOpen className="icon-sm" />
            </button>
          </Tooltip>
        )}
        <Tooltip label="Find file in worktree" action="fileQuickOpen" side="left">
          <button
            onClick={onFileQuickOpen}
            className="text-dim hover:text-fg hover:bg-surface rounded p-1.5 transition-colors cursor-pointer"
            aria-label="Find file in worktree"
          >
            <FolderSearch2 size={14} />
          </button>
        </Tooltip>
      </div>

      <div className="flex-1" />

      <div className="no-drag flex flex-col items-center gap-1 py-1">
        <Tooltip label="Refresh commits, changed files, and PR info" side="left">
          <button
            onClick={handleRefreshAll}
            disabled={!worktreePath}
            className="text-dim hover:text-fg hover:bg-surface rounded p-1.5 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            aria-label="Refresh PR, commits, and changed files"
          >
            <RefreshCw size={14} className={refreshing ? 'animate-spin' : undefined} />
          </button>
        </Tooltip>
      </div>
    </div>
  )
}

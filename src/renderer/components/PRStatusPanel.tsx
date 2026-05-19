import { useState, useEffect, useCallback, useRef } from 'react'
import { ExternalLink, GitMerge, ChevronDown, Check, GitPullRequest, RefreshCw, Loader2 } from 'lucide-react'
import { useRepoConfigs, useSettings } from '../store'
import { useBackend } from '../backend'
import type {
  PRStatus,
  PRReview,
  CheckStatus,
  Worktree,
  MergeStrategy,
  MainWorktreeStatus,
  MergeConflictPreview,
  GitHubMergeMethod,
  MergePRResult
} from '../types'
import { Tooltip } from './Tooltip'
import { RightPanel } from './RightPanel'

/** Pick a one-line failure reason out of a check's GitHub `output.summary`,
 * which is often multi-line markdown. Grab the first non-empty, non-heading
 * line and cap it — good enough to tell "what broke" without the full log. */
function firstLine(summary: string | undefined): string {
  if (!summary) return ''
  for (const raw of summary.split('\n')) {
    const line = raw.trim().replace(/^#+\s*/, '').replace(/^[-*]\s+/, '')
    if (line) return line.length > 140 ? line.slice(0, 140) + '…' : line
  }
  return ''
}

const STRATEGY_BUTTON_LABELS: Record<MergeStrategy, string> = {
  squash: 'Squash and merge',
  'merge-commit': 'Create a merge commit',
  'fast-forward': 'Fast-forward merge'
}

const STRATEGY_MENU_LABELS: Record<MergeStrategy, string> = {
  squash: 'Squash and merge',
  'merge-commit': 'Create a merge commit',
  'fast-forward': 'Fast-forward merge'
}

const STRATEGY_DESCRIPTIONS: Record<MergeStrategy, string> = {
  squash:
    'The commits from this branch will be combined into one commit on the base branch.',
  'merge-commit':
    'All commits from this branch will be added to the base branch via a merge commit.',
  'fast-forward':
    'Only merge if the base can fast-forward (--ff-only). Fails on divergent history.'
}

interface MergeLocallyPanelProps {
  pr: PRStatus | null | undefined
  worktree?: Worktree | null
  hasGithubToken?: boolean | null
  onMerged?: () => void | Promise<void>
  onRemoveWorktree?: (worktreePath: string) => void | Promise<void>
}

/** Renders the "Merge Locally" right-panel when it's applicable (no PR, not main branch,
 * GitHub connected). Returns null otherwise. */
export function MergeLocallyPanel({
  pr,
  worktree,
  hasGithubToken,
  onMerged,
  onRemoveWorktree
}: MergeLocallyPanelProps): JSX.Element | null {
  const needsGithubToken = hasGithubToken === false
  const show = !needsGithubToken && pr === null && worktree && !worktree.isMain
  if (!show || !worktree) return null
  return (
    <RightPanel id="merge-locally" title="Merge Locally">
      <MergeLocallyBody
        worktree={worktree}
        onMerged={onMerged}
        onRemoveWorktree={onRemoveWorktree}
      />
    </RightPanel>
  )
}

function MergeLocallyBody({
  worktree,
  onMerged,
  onRemoveWorktree
}: {
  worktree: Worktree
  onMerged?: () => void | Promise<void>
  onRemoveWorktree?: (worktreePath: string) => void | Promise<void>
}): JSX.Element {
  const backend = useBackend()
  const [mainStatus, setMainStatus] = useState<MainWorktreeStatus | null>(null)
  const [conflictPreview, setConflictPreview] = useState<MergeConflictPreview | null>(null)
  const [busy, setBusy] = useState<'idle' | 'checking' | 'fixing' | 'merging'>('idle')
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  // Effective merge strategy = repo override → global default. Both come
  // from the main-process store, so this re-renders automatically when
  // either changes.
  const repoConfigs = useRepoConfigs()
  const globalStrategy = useSettings().mergeStrategy
  const strategy: MergeStrategy =
    repoConfigs[worktree.repoRoot]?.mergeStrategy || globalStrategy
  const strategyLoaded = true

  const refreshStatus = useCallback(async () => {
    setBusy('checking')
    try {
      const [status, preview] = await Promise.all([
        backend.getMainWorktreeStatus(worktree.repoRoot),
        backend.previewMergeConflicts(worktree.repoRoot, worktree.branch, worktree.path).catch(() => null)
      ])
      setMainStatus(status)
      setConflictPreview(preview)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy('idle')
    }
  }, [worktree.branch])

  useEffect(() => {
    setError(null)
    setSuccess(null)
    setConflictPreview(null)
    void refreshStatus()
  }, [worktree.path, refreshStatus])

  // Close dropdown on outside click
  useEffect(() => {
    if (!menuOpen) return
    const handler = (e: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
      }
    }
    window.addEventListener('mousedown', handler)
    return () => window.removeEventListener('mousedown', handler)
  }, [menuOpen])

  const handlePickStrategy = useCallback((s: MergeStrategy) => {
    setMenuOpen(false)
    // Persist as new default — "last used wins". The store dispatch
    // re-renders us with the new strategy automatically.
    void backend.setMergeStrategy(s)
  }, [])

  const handleFix = useCallback(async () => {
    setError(null)
    setBusy('fixing')
    try {
      const status = await backend.prepareMainForMerge(worktree.repoRoot)
      setMainStatus(status)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy('idle')
    }
  }, [])

  const handleMerge = useCallback(async () => {
    if (!mainStatus) return
    setError(null)
    setSuccess(null)
    setBusy('merging')
    try {
      // Persist strategy on use too, in case the user never opened the dropdown.
      void backend.setMergeStrategy(strategy)
      const result = await backend.mergeWorktreeLocally(worktree.repoRoot, worktree.branch, strategy, worktree.path)
      setSuccess(`Merged into ${result.baseBranch}`)
      if (onMerged) await onMerged()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy('idle')
    }
  }, [mainStatus, strategy, worktree.repoRoot, worktree.branch, onMerged])

  const handleRemoveAfterMerge = useCallback(async () => {
    if (!onRemoveWorktree) return
    await onRemoveWorktree(worktree.path)
  }, [onRemoveWorktree, worktree.path])

  const ready = mainStatus?.ready === true
  const needsFix = mainStatus && !mainStatus.ready
  const hasConflict = conflictPreview?.hasConflict === true

  return (
    <div className="px-3 py-2 space-y-2">
        {!success && (
          <>
            <div className="text-xs text-faint">
              Merge <span className="text-fg font-mono">{worktree.branch}</span>
              {mainStatus && (
                <>
                  {' '}into{' '}
                  <span className="text-fg font-mono">{mainStatus.baseBranch}</span>
                </>
              )}
            </div>

            {/* GitHub-style split button */}
            <div className="relative" ref={menuRef}>
              <div className="flex">
                <button
                  onClick={handleMerge}
                  disabled={!ready || busy !== 'idle' || !strategyLoaded || hasConflict}
                  title={hasConflict ? 'Resolve merge conflicts before merging' : undefined}
                  className="flex-1 text-xs bg-accent/20 hover:bg-accent/30 text-fg-bright px-2 py-1.5 rounded-l flex items-center justify-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer border-r border-accent/40"
                >
                  <GitMerge size={12} />
                  {busy === 'merging' ? 'Merging…' : STRATEGY_BUTTON_LABELS[strategy]}
                </button>
                <button
                  onClick={() => setMenuOpen((v) => !v)}
                  disabled={busy === 'merging'}
                  className="text-xs bg-accent/20 hover:bg-accent/30 text-fg-bright px-1.5 py-1.5 rounded-r flex items-center justify-center disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                  aria-label="Change merge strategy"
                  title="Change merge strategy"
                >
                  <ChevronDown size={12} />
                </button>
              </div>

              {menuOpen && (
                <div className="absolute left-0 right-0 top-full mt-1 z-10 bg-surface border border-border rounded shadow-lg overflow-hidden">
                  {(['squash', 'merge-commit', 'fast-forward'] as MergeStrategy[]).map(
                    (s) => {
                      const active = s === strategy
                      return (
                        <button
                          key={s}
                          onClick={() => handlePickStrategy(s)}
                          className={`w-full text-left px-2 py-1.5 flex items-start gap-1.5 hover:bg-panel-raised cursor-pointer ${
                            active ? 'bg-panel-raised' : ''
                          }`}
                        >
                          <Check
                            size={12}
                            className={`mt-0.5 shrink-0 ${
                              active ? 'text-accent' : 'opacity-0'
                            }`}
                          />
                          <div className="min-w-0">
                            <div className="text-xs text-fg-bright">
                              {STRATEGY_MENU_LABELS[s]}
                            </div>
                            <div className="text-[11px] text-faint leading-snug">
                              {STRATEGY_DESCRIPTIONS[s]}
                            </div>
                          </div>
                        </button>
                      )
                    }
                  )}
                </div>
              )}
            </div>

            {hasConflict && conflictPreview && (
              <div className="text-[11px] text-danger leading-snug space-y-1">
                <div>
                  Merge conflict
                  {conflictPreview.files.length > 0 && (
                    <>
                      {' '}in{' '}
                      <span className="font-mono">
                        {conflictPreview.files.length === 1
                          ? conflictPreview.files[0]
                          : `${conflictPreview.files.length} files`}
                      </span>
                    </>
                  )}
                  . Resolve before merging.
                </div>
                {conflictPreview.files.length > 1 && (
                  <ul className="text-faint font-mono text-[10px] space-y-0.5 max-h-20 overflow-y-auto">
                    {conflictPreview.files.map((f) => (
                      <li key={f} className="truncate" style={{ direction: 'rtl', textAlign: 'left' }} title={f}>
                        <bdi>{f}</bdi>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {needsFix && (
              <div className="text-[11px] text-warning leading-snug space-y-1">
                <div>
                  Main worktree isn't ready:
                  {mainStatus.isDirty && ' has uncommitted changes'}
                  {!mainStatus.isOnBase && (
                    <>
                      {mainStatus.isDirty ? ' and' : ''} on{' '}
                      <span className="font-mono">
                        {mainStatus.currentBranch || 'detached HEAD'}
                      </span>
                      , not <span className="font-mono">{mainStatus.baseBranch}</span>
                    </>
                  )}
                  .
                </div>
                <button
                  onClick={handleFix}
                  disabled={busy !== 'idle'}
                  className="text-xs bg-panel-raised hover:bg-surface text-fg px-2 py-1 rounded disabled:opacity-50 cursor-pointer"
                >
                  {busy === 'fixing'
                    ? 'Fixing…'
                    : mainStatus.isDirty
                    ? `Stash & checkout ${mainStatus.baseBranch}`
                    : `Checkout ${mainStatus.baseBranch}`}
                </button>
              </div>
            )}

            {error && (
              <div className="text-[11px] text-danger leading-snug break-words">{error}</div>
            )}
          </>
        )}

        {success && (
          <div className="space-y-2">
            <div className="text-xs text-success">{success}</div>
            {onRemoveWorktree && (
              <button
                onClick={handleRemoveAfterMerge}
                className="w-full text-xs bg-panel-raised hover:bg-surface text-fg px-2 py-1.5 rounded cursor-pointer"
              >
                Remove worktree
              </button>
            )}
            <button
              onClick={() => {
                setSuccess(null)
                void refreshStatus()
              }}
              className="w-full text-xs text-faint hover:text-fg cursor-pointer"
            >
              Dismiss
            </button>
          </div>
        )}
    </div>
  )
}

const STATE_LABELS: Record<string, string> = {
  open: 'Open',
  draft: 'Draft',
  merged: 'Merged',
  closed: 'Closed'
}

const STATE_COLORS: Record<string, string> = {
  open: 'text-success',
  draft: 'text-warning',
  merged: 'text-accent',
  closed: 'text-danger'
}

function ordinalSuffix(n: number): string {
  const mod100 = n % 100
  if (mod100 >= 11 && mod100 <= 13) return 'th'
  switch (n % 10) {
    case 1:
      return 'st'
    case 2:
      return 'nd'
    case 3:
      return 'rd'
    default:
      return 'th'
  }
}

function queueBadgeLabel(position: number): string {
  if (position <= 1) return 'Queued'
  return `Queued (${position}${ordinalSuffix(position)})`
}

const CHECK_ICONS: Record<CheckStatus['state'], { symbol: string; color: string }> = {
  success: { symbol: '\u2713', color: 'text-success' },
  failure: { symbol: '\u2717', color: 'text-danger' },
  error: { symbol: '!', color: 'text-danger' },
  pending: { symbol: '\u25CB', color: 'text-warning' },
  neutral: { symbol: '-', color: 'text-dim' },
  skipped: { symbol: '-', color: 'text-dim' }
}

const OVERALL_COLORS: Record<string, string> = {
  success: 'text-success',
  failure: 'text-danger',
  pending: 'text-warning',
  none: 'text-dim'
}

// Failed/error checks are what the user has to act on, so they go first.
// Then pending (in progress), then success, then non-actionable
// neutral/skipped. Within each group, sort by startedAt ascending so the
// order matches the actual run order on CI.
const CHECK_STATE_PRIORITY: Record<CheckStatus['state'], number> = {
  failure: 0,
  error: 0,
  pending: 1,
  success: 2,
  neutral: 3,
  skipped: 4
}

function sortChecksForDisplay(checks: CheckStatus[]): CheckStatus[] {
  return [...checks].sort((a, b) => {
    const pa = CHECK_STATE_PRIORITY[a.state]
    const pb = CHECK_STATE_PRIORITY[b.state]
    if (pa !== pb) return pa - pb
    const ta = a.startedAt ? Date.parse(a.startedAt) : Number.POSITIVE_INFINITY
    const tb = b.startedAt ? Date.parse(b.startedAt) : Number.POSITIVE_INFINITY
    if (ta !== tb) return ta - tb
    return a.name.localeCompare(b.name)
  })
}

const REVIEW_DECISION_LABELS: Record<PRStatus['reviewDecision'], { text: string; color: string }> = {
  approved: { text: 'Approved', color: 'text-success' },
  changes_requested: { text: 'Changes requested', color: 'text-warning' },
  review_required: { text: 'Review pending', color: 'text-faint' },
  none: { text: '', color: '' }
}

const REVIEW_STATE_ICONS: Record<PRReview['state'], { symbol: string; color: string }> = {
  APPROVED: { symbol: '\u2713', color: 'text-success' },
  CHANGES_REQUESTED: { symbol: '\u25CF', color: 'text-warning' },
  COMMENTED: { symbol: '\u25CB', color: 'text-faint' },
  DISMISSED: { symbol: '-', color: 'text-dim' },
  PENDING: { symbol: '\u25CB', color: 'text-dim' }
}

function ReviewSummary({
  reviews,
  decision
}: {
  reviews: PRReview[]
  decision: PRStatus['reviewDecision']
}): JSX.Element {
  const backend = useBackend()
  const [expanded, setExpanded] = useState(false)
  const label = REVIEW_DECISION_LABELS[decision]

  // Dedupe to latest review per user for the summary row
  const latestByUser = new Map<string, PRReview>()
  for (const r of reviews) {
    latestByUser.set(r.user, r)
  }
  const uniqueReviewers = [...latestByUser.values()]

  return (
    <div className="mb-1">
      <div
        className="flex items-center gap-1.5 cursor-pointer"
        onClick={() => setExpanded(!expanded)}
      >
        <span className={`text-xs ${label.color}`}>{label.text}</span>
        <span className="text-xs text-faint">
          ({uniqueReviewers.length} {uniqueReviewers.length === 1 ? 'reviewer' : 'reviewers'})
          {expanded ? '\u25B4' : '\u25BE'}
        </span>
      </div>
      {expanded && (
        <div className="space-y-0.5 mt-1">
          {uniqueReviewers.map((review) => {
            const icon = REVIEW_STATE_ICONS[review.state]
            return (
              <div
                key={review.user}
                className="flex items-center gap-1.5 text-xs py-0.5 cursor-pointer hover:bg-panel-raised px-1 -mx-1 rounded group"
                onClick={() => backend.openExternal(review.htmlUrl)}
                title={`${review.user}: ${review.state.toLowerCase().replace('_', ' ')}`}
              >
                <img
                  src={review.avatarUrl}
                  alt={review.user}
                  className="w-4 h-4 rounded-full shrink-0"
                />
                <span className="text-muted truncate">{review.user}</span>
                <span className={`shrink-0 ${icon.color}`}>{icon.symbol}</span>
                <ExternalLink
                  size={10}
                  className="shrink-0 text-faint opacity-0 group-hover:opacity-100 transition-opacity ml-auto"
                />
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// 'fast-forward' has no GitHub equivalent — 'rebase' is the closest
// approximation but produces different history (linear, but rewritten
// commits with new SHAs). Tooltip below calls this out.
const STRATEGY_TO_METHOD: Record<MergeStrategy, GitHubMergeMethod> = {
  squash: 'squash',
  'merge-commit': 'merge',
  'fast-forward': 'rebase'
}

const METHOD_LABEL: Record<GitHubMergeMethod, string> = {
  squash: 'squash',
  merge: 'merge commit',
  rebase: 'rebase'
}

interface PRActionsProps {
  pr: PRStatus
  worktree?: Worktree | null
  needsGithubToken: boolean
}

function PRActions({ pr, worktree, needsGithubToken }: PRActionsProps): JSX.Element {
  const backend = useBackend()
  const repoConfigs = useRepoConfigs()
  const globalStrategy = useSettings().mergeStrategy
  const strategy: MergeStrategy = worktree
    ? repoConfigs[worktree.repoRoot]?.mergeStrategy || globalStrategy
    : globalStrategy
  const method = STRATEGY_TO_METHOD[strategy]
  const methodLabel = METHOD_LABEL[method]

  const [confirming, setConfirming] = useState(false)
  const [merging, setMerging] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [justMerged, setJustMerged] = useState(false)
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current)
    }
  }, [])

  // Reset confirm flag if the PR identity changes underneath us.
  useEffect(() => {
    setConfirming(false)
    setError(null)
    setJustMerged(false)
    if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current)
  }, [pr.number, pr.state])

  const isTerminal = pr.state === 'merged' || pr.state === 'closed'

  let disabledReason: string | null = null
  if (needsGithubToken) disabledReason = 'Connect GitHub token to merge'
  else if (!worktree) disabledReason = 'No active worktree'
  else if (pr.state === 'merged') disabledReason = 'Already merged'
  else if (pr.state === 'closed') disabledReason = 'PR is closed'
  else if (pr.state === 'draft') disabledReason = "Draft PRs can't be merged"
  else if (pr.hasConflict === true) disabledReason = 'PR has merge conflicts'
  const canMerge = disabledReason === null && !merging

  const startConfirm = (): void => {
    setError(null)
    setConfirming(true)
    if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current)
    confirmTimerRef.current = setTimeout(() => {
      setConfirming(false)
      confirmTimerRef.current = null
    }, 5000)
  }

  const performMerge = useCallback(async () => {
    if (!worktree) return
    if (confirmTimerRef.current) {
      clearTimeout(confirmTimerRef.current)
      confirmTimerRef.current = null
    }
    setConfirming(false)
    setMerging(true)
    setError(null)
    try {
      const result: MergePRResult = await backend.mergePR(worktree.path, method)
      if (result.ok) {
        setJustMerged(true)
      } else {
        setError(result.error || 'Merge failed')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setMerging(false)
    }
  }, [worktree, method, backend])

  const onMergeClick = (): void => {
    if (!canMerge) return
    if (confirming) {
      void performMerge()
    } else {
      startConfirm()
    }
  }

  let mergeLabel: string
  if (merging) mergeLabel = 'Merging…'
  else if (justMerged) mergeLabel = 'Merged'
  else if (confirming) mergeLabel = `Confirm ${methodLabel}`
  else mergeLabel = 'Merge'

  const showMergeButton = !isTerminal && !pr.queuePosition

  let mergeTooltip: string
  if (disabledReason) mergeTooltip = disabledReason
  else if (confirming) mergeTooltip = 'Click again to confirm'
  else if (strategy === 'fast-forward')
    mergeTooltip = 'Merge via GitHub using rebase (closest equivalent to fast-forward)'
  else mergeTooltip = `Merge via GitHub using ${methodLabel}`

  return (
    <div className="flex items-center gap-1.5 flex-wrap mb-2">
      {showMergeButton && (
        <Tooltip label={mergeTooltip}>
          <button
            onClick={onMergeClick}
            disabled={!canMerge || justMerged}
            className={`px-3 py-1.5 text-xs rounded transition-colors cursor-pointer flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed ${
              confirming
                ? 'bg-warning/30 hover:bg-warning/40 text-warning border border-warning/50'
                : 'bg-success/20 hover:bg-success/30 text-success'
            }`}
          >
            {merging ? (
              <Loader2 size={11} className="animate-spin" />
            ) : justMerged ? (
              <Check size={11} />
            ) : (
              <GitMerge size={11} />
            )}
            {mergeLabel}
          </button>
        </Tooltip>
      )}
      {showMergeButton && !confirming && !merging && !justMerged && (
        <span className="text-[10px] text-muted ml-auto">
          via {methodLabel}
        </span>
      )}
      {error && (
        <div className="basis-full text-[11px] text-danger leading-snug break-words flex items-center gap-2">
          <span className="flex-1">{error}</span>
          <button
            onClick={() => {
              setError(null)
              void performMerge()
            }}
            className="px-2 py-0.5 text-[11px] rounded bg-surface hover:bg-surface/60 text-fg transition-colors cursor-pointer shrink-0"
          >
            Retry
          </button>
        </div>
      )}
    </div>
  )
}

interface PRStatusPanelProps {
  pr: PRStatus | null | undefined
  worktree?: Worktree | null
  hasGithubToken?: boolean | null
  loading?: boolean
  onRefresh?: () => void | Promise<void>
  onConnectGithub?: () => void
}

export function PRStatusPanel({
  pr,
  worktree,
  hasGithubToken,
  loading,
  onRefresh,
  onConnectGithub
}: PRStatusPanelProps): JSX.Element {
  const backend = useBackend()
  const [expanded, setExpanded] = useState(false)

  // Auto-expand the check list whenever checks are failing so the user sees
  // which check broke without an extra click.
  useEffect(() => {
    if (pr?.checksOverall === 'failure') setExpanded(true)
  }, [pr?.checksOverall, pr?.number])

  const needsGithubToken = hasGithubToken === false

  const refreshButton = !needsGithubToken && onRefresh ? (
    <Tooltip label="Refresh PR status" side="left">
      <button
        onClick={(e) => {
          e.stopPropagation()
          void onRefresh()
        }}
        disabled={loading}
        className="text-xs text-dim hover:text-fg flex items-center transition-colors cursor-pointer disabled:cursor-default"
        aria-label="Refresh PR status"
      >
        <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
      </button>
    </Tooltip>
  ) : null

  const openButton = !needsGithubToken && pr ? (
    <Tooltip label="Open PR in browser" action="openPR" side="left">
      <button
        onClick={(e) => {
          e.stopPropagation()
          backend.openExternal(pr.url)
        }}
        className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-accent text-app text-[10px] font-medium hover:bg-accent/80 transition-colors cursor-pointer"
        aria-label="Open PR in browser"
      >
        <GitPullRequest size={10} />
        #{pr.number}
      </button>
    </Tooltip>
  ) : null

  const actions = (openButton || refreshButton) ? (
    <div className="flex items-center gap-2">
      {openButton}
      {refreshButton}
    </div>
  ) : null

  return (
    <RightPanel
      id="pull-request"
      title="Pull Request"
      actions={actions}
      containerClassName={needsGithubToken ? 'bg-info/10' : ''}
      headerClassName={needsGithubToken ? 'bg-info/25' : ''}
    >
      {needsGithubToken && (
        <div className="px-3 py-3 space-y-2">
          <div className="text-xs text-info/90 leading-snug">
            Connect a GitHub token to see PR status and open pull requests from Harness.
          </div>
          {onConnectGithub && (
            <button
              onClick={onConnectGithub}
              className="w-full text-xs bg-info/25 hover:bg-info/35 text-info px-2 py-1.5 rounded flex items-center justify-center gap-1.5 cursor-pointer"
            >
              <GitPullRequest size={12} />
              Connect GitHub
            </button>
          )}
        </div>
      )}

      {!needsGithubToken && pr === null && (
        <div className="px-3 py-2 text-xs text-faint">No PR for this branch</div>
      )}

      {!needsGithubToken && pr === undefined && (
        <div className="px-3 py-2 text-xs text-faint">Loading...</div>
      )}

      {!needsGithubToken && pr && (
        <div className="px-3 py-2">
          {/* PR title */}
          <a
            className="block text-xs text-fg hover:text-fg-bright truncate cursor-pointer mb-1"
            title={`${pr.title}\n${pr.url}`}
            onClick={() => setExpanded(!expanded)}
          >
            {pr.title}
          </a>

          <div className="flex items-center gap-1.5 mb-1 text-xs">
            <span
              className={`font-medium shrink-0 ${
                pr.queuePosition ? 'text-accent' : STATE_COLORS[pr.state]
              }`}
            >
              {pr.queuePosition ? queueBadgeLabel(pr.queuePosition) : STATE_LABELS[pr.state]}
            </span>
            {!pr.isDefaultBase && (
              <span className="font-mono text-faint truncate">{pr.baseBranch}</span>
            )}
            {pr.milestone ? (
              <a
                onClick={(e) => {
                  e.stopPropagation()
                  backend.openExternal(pr.milestone!.url)
                }}
                className={`shrink-0 px-1.5 py-0.5 rounded-full text-[10px] font-medium cursor-pointer transition-colors truncate max-w-[140px] ${
                  pr.milestone.state === 'closed'
                    ? 'bg-surface text-dim hover:text-fg-bright'
                    : 'bg-accent/20 text-accent hover:bg-accent/30'
                }`}
                title={`Milestone: ${pr.milestone.title}`}
              >
                {pr.milestone.title}
              </a>
            ) : (
              <span className="shrink-0 px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-surface text-faint">
                No milestone
              </span>
            )}
            <div className="flex items-center gap-1.5 ml-auto shrink-0">
              {pr.assignees.length > 0 && (
                <div className="flex items-center">
                  {pr.assignees.map((a, i) => (
                    <img
                      key={a.login}
                      src={a.avatarUrl}
                      alt={a.login}
                      title={`Assigned to ${a.login}`}
                      className={`w-4 h-4 rounded-full border border-panel ${i > 0 ? '-ml-1' : ''}`}
                    />
                  ))}
                </div>
              )}
              {typeof pr.additions === 'number' && typeof pr.deletions === 'number' && (
                <span className="font-mono">
                  <span className="text-success">+{pr.additions}</span>
                  <span className="text-danger ml-1">−{pr.deletions}</span>
                </span>
              )}
            </div>
          </div>

          <PRActions pr={pr} worktree={worktree} needsGithubToken={needsGithubToken} />

          {/* Merge conflict indicator — styled like the checks line */}
          {pr.hasConflict === true && (
            <div className="flex items-center gap-1.5 mb-1">
              <span className="text-xs text-danger">Merge conflict</span>
            </div>
          )}

          {/* Reviews summary */}
          {pr.reviews.length > 0 && (
            <ReviewSummary reviews={pr.reviews} decision={pr.reviewDecision} />
          )}

          {/* Checks summary */}
          <div
            className={`flex items-center gap-1.5 cursor-pointer ${expanded ? 'mb-1.5' : ''}`}
            onClick={() => setExpanded(!expanded)}
          >
            <span className={`text-xs ${OVERALL_COLORS[pr.checksOverall]}`}>
              {pr.checksOverall === 'success' && 'Checks passing'}
              {pr.checksOverall === 'failure' && 'Checks failing'}
              {pr.checksOverall === 'pending' && 'Checks running'}
              {pr.checksOverall === 'none' && 'No checks'}
            </span>
            {pr.checks.length > 0 && (
              <span className="text-xs text-faint">
                ({pr.checks.filter((c) => c.state === 'success').length}/{pr.checks.length})
                {expanded ? '\u25B4' : '\u25BE'}
              </span>
            )}
          </div>

          {/* Expanded check list — sorted: failed → pending → success → neutral/skipped,
              then by startedAt within each group. */}
          {expanded && pr.checks.length > 0 && (
            <div className="space-y-0.5 max-h-60 overflow-y-auto">
              {sortChecksForDisplay(pr.checks).map((check) => {
                const icon = CHECK_ICONS[check.state]
                const isFailure = check.state === 'failure' || check.state === 'error'
                const reason = isFailure
                  ? check.description || firstLine(check.summary)
                  : ''
                const clickable = !!check.detailsUrl
                const rowClasses = `flex items-start gap-1.5 text-xs py-0.5 rounded ${
                  clickable ? 'cursor-pointer hover:bg-panel-raised px-1 -mx-1 group' : ''
                }`
                return (
                  <div
                    key={check.name}
                    className={rowClasses}
                    onClick={() => {
                      if (check.detailsUrl) backend.openExternal(check.detailsUrl)
                    }}
                    title={
                      check.detailsUrl
                        ? `Open: ${check.detailsUrl}`
                        : check.description || check.name
                    }
                  >
                    <span className={`shrink-0 mt-0.5 ${icon.color}`}>{icon.symbol}</span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1">
                        <span
                          className={`truncate ${isFailure ? 'text-fg' : 'text-muted'}`}
                        >
                          {check.name}
                        </span>
                        {clickable && (
                          <ExternalLink
                            size={10}
                            className="shrink-0 text-faint opacity-0 group-hover:opacity-100 transition-opacity"
                          />
                        )}
                      </div>
                      {reason && (
                        <div className="text-faint text-[11px] leading-snug truncate">
                          {reason}
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </RightPanel>
  )
}

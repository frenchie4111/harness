import { useState, useEffect, useCallback, useRef } from 'react'
import { ExternalLink, GitMerge, ChevronDown, Check, GitPullRequest, RefreshCw } from 'lucide-react'
import { useRepoConfigs, useSettings } from '../store'
import type {
  PRStatus,
  PRReview,
  CheckStatus,
  Worktree,
  MergeStrategy,
  MainWorktreeStatus,
  MergeConflictPreview
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
        window.api.getMainWorktreeStatus(worktree.repoRoot),
        window.api.previewMergeConflicts(worktree.repoRoot, worktree.branch).catch(() => null)
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
    void window.api.setMergeStrategy(s)
  }, [])

  const handleFix = useCallback(async () => {
    setError(null)
    setBusy('fixing')
    try {
      const status = await window.api.prepareMainForMerge(worktree.repoRoot)
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
      void window.api.setMergeStrategy(strategy)
      const result = await window.api.mergeWorktreeLocally(worktree.repoRoot, worktree.branch, strategy)
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
  draft: 'text-muted',
  merged: 'text-accent',
  closed: 'text-danger'
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
                onClick={() => window.api.openExternal(review.htmlUrl)}
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

interface PRStatusPanelProps {
  pr: PRStatus | null | undefined
  hasGithubToken?: boolean | null
  loading?: boolean
  onRefresh?: () => void | Promise<void>
  onConnectGithub?: () => void
}

export function PRStatusPanel({
  pr,
  hasGithubToken,
  loading,
  onRefresh,
  onConnectGithub
}: PRStatusPanelProps): JSX.Element {
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
          window.api.openExternal(pr.url)
        }}
        className="text-xs text-dim hover:text-fg flex items-center gap-1 transition-colors cursor-pointer"
      >
        Open
        <ExternalLink size={11} />
      </button>
    </Tooltip>
  ) : null

  const actions = (refreshButton || openButton) ? (
    <>
      {refreshButton}
      {openButton}
    </>
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
          {/* PR title and state */}
          <div className="flex items-start gap-1.5 mb-1.5">
            <span className={`text-xs font-medium shrink-0 ${STATE_COLORS[pr.state]}`}>
              {STATE_LABELS[pr.state]}
            </span>
            <a
              className="text-xs text-fg hover:text-fg-bright truncate cursor-pointer"
              title={`#${pr.number}: ${pr.title}\n${pr.url}`}
              onClick={() => setExpanded(!expanded)}
            >
              #{pr.number} {pr.title}
            </a>
          </div>

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

          {/* Expanded check list */}
          {expanded && pr.checks.length > 0 && (
            <div className="space-y-0.5 max-h-60 overflow-y-auto">
              {pr.checks.map((check) => {
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
                      if (check.detailsUrl) window.api.openExternal(check.detailsUrl)
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

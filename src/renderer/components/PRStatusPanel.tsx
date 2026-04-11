import { useState, useEffect, useCallback, useRef } from 'react'
import { ExternalLink, GitMerge, ChevronDown, Check, GitPullRequest } from 'lucide-react'
import type {
  PRStatus,
  CheckStatus,
  Worktree,
  MergeStrategy,
  MainWorktreeStatus,
  MergeConflictPreview
} from '../types'
import { Tooltip } from './Tooltip'

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

interface PRStatusPanelProps {
  pr: PRStatus | null | undefined
  worktree?: Worktree | null
  /** Called right after a successful local merge (for refreshing lists). */
  onMerged?: () => void | Promise<void>
  /** Called when the user clicks "Remove worktree" after a merge. */
  onRemoveWorktree?: (worktreePath: string) => void | Promise<void>
  /** Whether a GitHub token is configured. `null` means still loading. */
  hasGithubToken?: boolean | null
  /** Called when the user clicks the "Connect GitHub" button. */
  onConnectGithub?: () => void
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

function MergeLocallySection({
  worktree,
  onMerged,
  onRemoveWorktree
}: {
  worktree: Worktree
  onMerged?: () => void | Promise<void>
  onRemoveWorktree?: (worktreePath: string) => void | Promise<void>
}): JSX.Element {
  const [strategy, setStrategy] = useState<MergeStrategy>('squash')
  const [strategyLoaded, setStrategyLoaded] = useState(false)
  const [mainStatus, setMainStatus] = useState<MainWorktreeStatus | null>(null)
  const [conflictPreview, setConflictPreview] = useState<MergeConflictPreview | null>(null)
  const [busy, setBusy] = useState<'idle' | 'checking' | 'fixing' | 'merging'>('idle')
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  // Load the persisted default strategy once on mount.
  useEffect(() => {
    window.api.getMergeStrategy().then((s) => {
      setStrategy(s)
      setStrategyLoaded(true)
    })
  }, [])

  const refreshStatus = useCallback(async () => {
    setBusy('checking')
    try {
      const [status, preview] = await Promise.all([
        window.api.getMainWorktreeStatus(),
        window.api.previewMergeConflicts(worktree.branch).catch(() => null)
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
    setStrategy(s)
    setMenuOpen(false)
    // Persist as new default — "last used wins"
    void window.api.setMergeStrategy(s)
  }, [])

  const handleFix = useCallback(async () => {
    setError(null)
    setBusy('fixing')
    try {
      const status = await window.api.prepareMainForMerge()
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
      const result = await window.api.mergeWorktreeLocally(worktree.branch, strategy)
      setSuccess(`Merged into ${result.baseBranch}`)
      if (onMerged) await onMerged()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy('idle')
    }
  }, [mainStatus, strategy, worktree.branch, onMerged])

  const handleRemoveAfterMerge = useCallback(async () => {
    if (!onRemoveWorktree) return
    await onRemoveWorktree(worktree.path)
  }, [onRemoveWorktree, worktree.path])

  const ready = mainStatus?.ready === true
  const needsFix = mainStatus && !mainStatus.ready
  const hasConflict = conflictPreview?.hasConflict === true

  return (
    <div className="border-b border-border">
      <div className="px-3 py-2 flex items-center gap-2">
        <span className="text-xs font-medium text-dim flex-1">MERGE LOCALLY</span>
      </div>
      <div className="px-3 pb-3 space-y-2">
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
                      <li key={f} className="truncate" title={f}>
                        {f}
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

export function PRStatusPanel({
  pr,
  worktree,
  onMerged,
  onRemoveWorktree,
  hasGithubToken,
  onConnectGithub
}: PRStatusPanelProps): JSX.Element {
  const [expanded, setExpanded] = useState(false)

  // Auto-expand the check list whenever checks are failing so the user sees
  // which check broke without an extra click.
  useEffect(() => {
    if (pr?.checksOverall === 'failure') setExpanded(true)
  }, [pr?.checksOverall, pr?.number])

  const needsGithubToken = hasGithubToken === false
  const showMergeLocally = !needsGithubToken && pr === null && worktree && !worktree.isMain

  return (
    <>
    {showMergeLocally && (
      <MergeLocallySection
        worktree={worktree}
        onMerged={onMerged}
        onRemoveWorktree={onRemoveWorktree}
      />
    )}
    <div className={`border-b border-border ${needsGithubToken ? 'bg-info/10' : ''}`}>
      <div
        className={`px-3 py-2 flex items-center gap-2 ${
          needsGithubToken ? 'bg-info/25' : ''
        }`}
      >
        <span
          className={`text-xs font-medium flex-1 ${
            needsGithubToken ? 'text-info' : 'text-dim'
          }`}
        >
          PULL REQUEST
        </span>
        {!needsGithubToken && pr && (
          <Tooltip label="Open PR in browser" action="openPR" side="left">
            <button
              onClick={() => window.api.openExternal(pr.url)}
              className="text-xs text-dim hover:text-fg flex items-center gap-1 transition-colors cursor-pointer"
            >
              Open
              <ExternalLink size={11} />
            </button>
          </Tooltip>
        )}
      </div>

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
        <div className="px-3 pb-2 text-xs text-faint">No PR for this branch</div>
      )}

      {!needsGithubToken && pr === undefined && (
        <div className="px-3 pb-2 text-xs text-faint">Loading...</div>
      )}

      {!needsGithubToken && pr && (
        <div className="px-3 pb-2">
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
    </div>
    </>
  )
}

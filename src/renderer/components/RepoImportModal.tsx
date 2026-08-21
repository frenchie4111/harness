import { useCallback, useEffect, useMemo, useState } from 'react'
import { GitBranch, GitPullRequest, Loader2, MessageSquare, Check } from 'lucide-react'
import { useBackend } from '../backend'
import type {
  ChatDepth,
  RepoImportCandidate,
  RepoImportPlan,
  RepoImportResult
} from '../../shared/repo-import-types'

/** Offers to recreate a repo's existing Claude Code work as Ness worktrees.
 *
 *  Two steps on purpose. Step one asks a yes/no question about a repo the
 *  user just added, because a checklist of forty branches is not an answer
 *  to "do you want this at all". Step two is the checklist, pre-checked with
 *  the branches whose chats are recent — see repo-import.ts for why recency
 *  and not merge state carries that decision. */

interface RepoImportModalProps {
  repoRoot: string
  onDismiss: () => void
  onImported: (firstWorktreePath: string | null) => void
}

type Stage = 'probing' | 'offer' | 'pick' | 'working' | 'done'

/** Windows the recency filter offers, in days. `null` is everything. */
const WINDOWS: { label: string; days: number | null }[] = [
  { label: 'Past week', days: 7 },
  { label: 'Past month', days: 30 },
  { label: 'All time', days: null }
]

function relativeTime(ms: number): string {
  const diff = Date.now() - ms
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  const days = Math.floor(diff / 86_400_000)
  if (days < 30) return `${days}d ago`
  if (days < 365) return `${Math.floor(days / 30)}mo ago`
  return `${Math.floor(days / 365)}y ago`
}

function plural(n: number, word: string): string {
  if (n === 1) return `${n} ${word}`
  return `${n} ${word}${/(?:ch|sh|s|x|z)$/.test(word) ? 'es' : 's'}`
}

export function RepoImportModal({
  repoRoot,
  onDismiss,
  onImported
}: RepoImportModalProps): JSX.Element | null {
  const backend = useBackend()
  const [stage, setStage] = useState<Stage>('probing')
  const [plan, setPlan] = useState<RepoImportPlan | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [windowDays, setWindowDays] = useState<number | null>(30)
  const [hideMerged, setHideMerged] = useState(true)
  const [chatDepth, setChatDepth] = useState<ChatDepth>('latest')
  const [result, setResult] = useState<RepoImportResult | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const probed = await backend.probeRepoImport(repoRoot)
      if (cancelled) return
      // Nothing to offer — never make the user dismiss an empty dialog.
      if (!probed || probed.candidates.length === 0) {
        onDismiss()
        return
      }
      setPlan(probed)
      setSelected(new Set(probed.candidates.filter((c) => c.recommended).map((c) => c.branch)))
      setStage('offer')
    })()
    return () => {
      cancelled = true
    }
  }, [repoRoot, backend, onDismiss])

  // Esc backs out, but not mid-import: the worktrees are already being
  // created on disk and closing the dialog wouldn't stop them.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || stage === 'working') return
      e.preventDefault()
      onDismiss()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onDismiss, stage])

  const visible = useMemo(() => {
    if (!plan) return []
    const cutoff = windowDays === null ? 0 : Date.now() - windowDays * 86_400_000
    return plan.candidates.filter((c) => {
      if (c.latestActivityMs < cutoff) return false
      // A branch the user explicitly checked always stays visible, so
      // narrowing the filter can never silently drop it from the batch.
      if (hideMerged && c.merged && !selected.has(c.branch)) return false
      return true
    })
  }, [plan, windowDays, hideMerged, selected])

  const toggle = useCallback((branch: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(branch)) next.delete(branch)
      else next.add(branch)
      return next
    })
  }, [])

  const runImport = useCallback(async () => {
    if (!plan) return
    setStage('working')
    const outcome = await backend.importRepoBranches({
      repoRoot,
      branches: [...selected],
      chatDepth
    })
    setResult(outcome)
    setStage('done')
  }, [plan, backend, repoRoot, selected, chatDepth])

  if (stage === 'probing' || !plan) return null

  const hiddenCount = plan.candidates.length - visible.length

  return (
    <div
      className="fixed inset-0 z-[70] flex items-start justify-center pt-[12vh] bg-black/40"
      onClick={stage === 'working' ? undefined : onDismiss}
    >
      <div
        className="w-full max-w-2xl bg-surface rounded-xl shadow-2xl border border-border overflow-hidden flex flex-col max-h-[70vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {stage === 'offer' ? (
          <OfferStage
            plan={plan}
            onDismiss={onDismiss}
            onContinue={() => setStage('pick')}
          />
        ) : null}

        {stage === 'pick' ? (
          <>
            <div className="px-5 py-3.5 border-b border-border">
              <h2 className="text-sm font-semibold text-fg-bright">
                Which branches are you still working on?
              </h2>
              <p className="text-xs text-dim mt-1">
                Each one becomes a worktree with its chat history attached.
              </p>
            </div>

            <div className="px-5 py-2.5 border-b border-border flex items-center gap-3 flex-wrap">
              <div className="flex items-center gap-1">
                {WINDOWS.map((w) => (
                  <button
                    key={w.label}
                    onClick={() => setWindowDays(w.days)}
                    className={`px-2.5 py-1 text-xs rounded cursor-pointer transition-colors ${
                      windowDays === w.days
                        ? 'bg-accent/20 text-fg-bright border border-accent/40'
                        : 'text-dim hover:text-fg border border-transparent hover:bg-surface-hover'
                    }`}
                  >
                    {w.label}
                  </button>
                ))}
              </div>
              <label className="flex items-center gap-1.5 text-xs text-dim cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={hideMerged}
                  onChange={(e) => setHideMerged(e.target.checked)}
                  className="icon-base cursor-pointer"
                />
                Hide merged
              </label>
              <div className="ml-auto text-xs text-dim">
                {plural(selected.size, 'branch')} selected
              </div>
            </div>

            <div className="overflow-y-auto flex-1">
              {visible.map((c) => (
                <CandidateRow
                  key={c.branch}
                  candidate={c}
                  checked={selected.has(c.branch)}
                  onToggle={() => toggle(c.branch)}
                />
              ))}
              {visible.length === 0 ? (
                <div className="px-5 py-8 text-center text-xs text-dim">
                  No branches match this filter.
                </div>
              ) : null}
            </div>

            <div className="px-5 py-2 border-t border-border text-xs text-dim flex items-center gap-3 flex-wrap">
              {hiddenCount > 0 ? <span>{hiddenCount} hidden by filters</span> : null}
              {plan.alreadyOpenCount > 0 ? (
                <span>{plural(plan.alreadyOpenCount, 'branch')} already open</span>
              ) : null}
              {plan.strandedSessionCount > 0 ? (
                <span>
                  {plural(plan.strandedSessionCount, 'chat')} on deleted branches — still
                  searchable, but can&apos;t become a worktree
                </span>
              ) : null}
            </div>

            <div className="px-5 py-3 border-t border-border flex items-center justify-between gap-2">
              <label className="flex items-center gap-1.5 text-xs text-dim cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={chatDepth === 'all'}
                  onChange={(e) => setChatDepth(e.target.checked ? 'all' : 'latest')}
                  className="icon-base cursor-pointer"
                />
                Open every chat, not just the most recent
              </label>
              <div className="flex items-center gap-2">
                <button
                  onClick={onDismiss}
                  className="px-3 py-1.5 text-xs font-medium rounded text-dim hover:text-fg cursor-pointer transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={runImport}
                  disabled={selected.size === 0}
                  className="px-4 py-1.5 text-xs font-medium rounded bg-accent/20 hover:bg-accent/30 text-fg-bright border border-accent/40 cursor-pointer transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Create {plural(selected.size, 'worktree')}
                </button>
              </div>
            </div>
          </>
        ) : null}

        {stage === 'working' ? (
          <div className="px-5 py-10 flex flex-col items-center gap-3">
            <Loader2 className="icon-lg animate-spin text-accent" />
            <div className="text-sm text-fg-bright">
              Creating {plural(selected.size, 'worktree')}…
            </div>
            <div className="text-xs text-dim text-center max-w-sm">
              Each one checks out its branch and runs the repo&apos;s setup script. Progress
              shows in the sidebar.
            </div>
          </div>
        ) : null}

        {stage === 'done' && result ? (
          <DoneStage
            result={result}
            onClose={() => {
              onImported(result.branches.find((b) => b.ok)?.worktreePath ?? null)
              onDismiss()
            }}
          />
        ) : null}
      </div>
    </div>
  )
}

function OfferStage({
  plan,
  onDismiss,
  onContinue
}: {
  plan: RepoImportPlan
  onDismiss: () => void
  onContinue: () => void
}): JSX.Element {
  return (
    <>
      <div className="px-5 py-3.5 border-b border-border">
        <h2 className="text-sm font-semibold text-fg-bright">
          Found existing work in {plan.repoLabel}
        </h2>
      </div>
      <div className="px-5 py-4 text-sm text-fg">
        <p>
          This repo already has {plural(plan.totalSessionCount, 'Claude Code chat')} across{' '}
          {plural(plan.candidates.length, 'branch')}. Ness can bring them in as worktrees so
          you pick up where you left off.
        </p>
        {plan.recommendedCount > 0 ? (
          <p className="text-xs text-dim mt-2">
            {plural(plan.recommendedCount, 'branch')} {plan.recommendedCount === 1 ? 'looks' : 'look'}{' '}
            active — those are preselected.
          </p>
        ) : null}
      </div>
      <div className="px-5 py-3 border-t border-border flex items-center justify-end gap-2">
        <button
          onClick={onDismiss}
          className="px-3 py-1.5 text-xs font-medium rounded text-dim hover:text-fg cursor-pointer transition-colors"
        >
          Not now
        </button>
        <button
          onClick={onContinue}
          className="px-4 py-1.5 text-xs font-medium rounded bg-accent/20 hover:bg-accent/30 text-fg-bright border border-accent/40 cursor-pointer transition-colors"
        >
          Choose branches
        </button>
      </div>
    </>
  )
}

function CandidateRow({
  candidate,
  checked,
  onToggle
}: {
  candidate: RepoImportCandidate
  checked: boolean
  onToggle: () => void
}): JSX.Element {
  return (
    <label className="flex items-start gap-3 px-5 py-2.5 border-b border-border/50 cursor-pointer hover:bg-surface-hover transition-colors">
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        className="icon-base mt-0.5 cursor-pointer shrink-0"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <GitBranch className="icon-xs text-dim shrink-0" />
          <span className="text-sm text-fg-bright truncate">{candidate.branch}</span>
          {candidate.merged ? (
            <span className="text-xs px-1.5 py-0.5 rounded bg-surface-hover text-dim shrink-0">
              merged
            </span>
          ) : null}
          {candidate.prNumber !== null ? (
            <span className="flex items-center gap-0.5 text-xs text-dim shrink-0">
              <GitPullRequest className="icon-2xs" />
              {candidate.prNumber}
            </span>
          ) : null}
        </div>
        {candidate.latestTitle ? (
          <div className="text-xs text-dim truncate mt-0.5">{candidate.latestTitle}</div>
        ) : null}
      </div>
      <div className="text-xs text-dim text-right shrink-0 flex items-center gap-2">
        <span className="flex items-center gap-1">
          <MessageSquare className="icon-2xs" />
          {candidate.sessionCount}
        </span>
        <span className="w-16">{relativeTime(candidate.latestActivityMs)}</span>
      </div>
    </label>
  )
}

function DoneStage({
  result,
  onClose
}: {
  result: RepoImportResult
  onClose: () => void
}): JSX.Element {
  const failed = result.branches.filter((b) => !b.ok)
  return (
    <>
      <div className="px-5 py-3.5 border-b border-border flex items-center gap-2">
        <Check className="icon-sm text-accent" />
        <h2 className="text-sm font-semibold text-fg-bright">
          Imported {plural(result.created, 'worktree')}
        </h2>
      </div>
      <div className="px-5 py-4 text-sm text-fg overflow-y-auto">
        <p>{plural(result.importedChats, 'chat')} attached and ready to resume.</p>
        {failed.length > 0 ? (
          <div className="mt-3">
            <p className="text-xs text-dim mb-1.5">
              {plural(failed.length, 'branch')} couldn&apos;t be imported:
            </p>
            <ul className="text-xs text-dim space-y-1">
              {failed.map((b) => (
                <li key={b.branch} className="truncate">
                  <span className="text-fg">{b.branch}</span> — {b.error}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
      <div className="px-5 py-3 border-t border-border flex items-center justify-end">
        <button
          onClick={onClose}
          className="px-4 py-1.5 text-xs font-medium rounded bg-accent/20 hover:bg-accent/30 text-fg-bright border border-accent/40 cursor-pointer transition-colors"
        >
          Done
        </button>
      </div>
    </>
  )
}

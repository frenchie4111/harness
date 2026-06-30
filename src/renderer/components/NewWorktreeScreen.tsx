import { useState, useCallback, useEffect, useRef } from 'react'
import { Sparkles, Loader2, X, Map as MapIcon, ListChecks, BookOpen, Radio, GitPullRequest, ChevronRight, ChevronDown, Check } from 'lucide-react'
import iconUrl from '../../../resources/icon.png'
import { sanitizeBranchInput, isValidBranchName } from '../branch-name'
import { RepoIcon } from './RepoIcon'
import { useBackend } from '../backend'
import { useSettings } from '../store'
import { CLAUDE_MODELS, CODEX_MODELS } from '../../shared/agent-registry'
import type { PRSummary } from '../types'

interface NewWorktreeScreenProps {
  onSubmit: (
    repoRoot: string,
    branchName: string,
    initialPrompt: string,
    teleportSessionId?: string,
    agentKind?: 'claude' | 'codex',
    model?: string,
    checkoutExisting?: boolean,
    baseRef?: string
  ) => Promise<void>
  onPRSubmit: (
    repoRoot: string,
    prNumber: number,
    initialPrompt: string,
    agentKind?: 'claude' | 'codex',
    model?: string,
    checkoutExisting?: boolean
  ) => Promise<void>
  onCancel: () => void
  repoRoots: string[]
  /** Repo to pre-select in the picker. Usually the repo of the currently active worktree. */
  defaultRepoRoot?: string
}

/** Sort + clean the local-branch list from the backend. The backend already
 * limits to locals via `git branch --format=...` (no `-a`), so all we do
 * here is drop empty/HEAD entries and alphabetize. */
function normalizeBranchList(raw: string[]): string[] {
  return raw.filter((b) => b && b !== 'HEAD').sort((a, b) => a.localeCompare(b))
}

function relTime(iso: string | undefined): string {
  if (!iso) return ''
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return ''
  const diff = Date.now() - t
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

/** Extract a `session_…` id from either a raw id or a full `claude --teleport …` command. */
function parseTeleportInput(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const match = trimmed.match(/session_[A-Za-z0-9]+/)
  return match ? match[0] : null
}

/** Derive a worktree folder name from a teleport session id. The claude CLI
 * overwrites the branch on first run anyway, so this only affects the folder
 * name on disk. */
function teleportFolderName(sessionId: string): string {
  const stripped = sessionId.replace(/^session_/, '')
  return `teleport-${stripped}`
}

const STARTER_PROMPTS = [
  {
    icon: MapIcon,
    label: 'Map the repo',
    hint: 'A one-paragraph architecture summary',
    branch: 'map-repo',
    prompt:
      "Read this repo and write a one-paragraph summary of its architecture in SCRATCH.md — what the major pieces are and how they fit together. Keep it under 150 words."
  },
  {
    icon: ListChecks,
    label: 'Find the TODOs',
    hint: 'Collect every TODO/FIXME in one file',
    branch: 'find-todos',
    prompt:
      "Search the codebase for every TODO and FIXME comment. Write TODOS.md grouping them by file with line numbers and the comment text. Don't fix anything — just catalog."
  },
  {
    icon: BookOpen,
    label: 'Sharpen the README',
    hint: 'Get 3 concrete improvement ideas',
    branch: 'sharpen-readme',
    prompt:
      "Read the README and propose 3 specific, concrete improvements (not vague advice). Reply with the suggestions — don't make any changes yet so I can review first."
  }
]

export function NewWorktreeScreen({ onSubmit, onPRSubmit, onCancel, repoRoots, defaultRepoRoot }: NewWorktreeScreenProps): JSX.Element {
  const [mode, setMode] = useState<'fresh' | 'teleport' | 'pr'>('fresh')
  const [selectedRepo, setSelectedRepo] = useState<string>(
    defaultRepoRoot && repoRoots.includes(defaultRepoRoot) ? defaultRepoRoot : repoRoots[0] || ''
  )
  const [branch, setBranch] = useState('')
  const [existingBranch, setExistingBranch] = useState<string | null>(null)
  // Free-text ref: commit SHA, tag, remote-tracking ref (`origin/foo`), etc.
  // Used as the base the new branch (`refBranch`) is forked from — the
  // worktree is created with `-b <refBranch> <refValue>` so it always lands
  // on a named local branch, never a detached HEAD.
  const [refValue, setRefValue] = useState('')
  // The name of the new branch to create at `refValue` on the Ref tab.
  const [refBranch, setRefBranch] = useState('')
  const [branchTab, setBranchTab] = useState<'new' | 'existing' | 'ref'>('new')
  const [prompt, setPrompt] = useState('')
  const settings = useSettings()
  const [reviewPrompt, setReviewPrompt] = useState(settings.prReviewPrompt)
  const [teleportInput, setTeleportInput] = useState('')
  // Per-creation overrides for agent + model. Default agent comes from
  // settings; model defaults to empty (= use settings.claudeModel/codexModel
  // at spawn time). Teleport mode pins to Claude — codex has no equivalent
  // "resume by id" flow today.
  const [agentKindOverride, setAgentKindOverride] = useState<'claude' | 'codex'>(
    settings.defaultAgent === 'codex' ? 'codex' : 'claude'
  )
  const [modelOverride, setModelOverride] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const branchRef = useRef<HTMLInputElement>(null)
  const promptRef = useRef<HTMLTextAreaElement>(null)
  const teleportRef = useRef<HTMLInputElement>(null)

  const backend = useBackend()
  // Cache PR-list fetch results per repo so flipping back to the tab
  // doesn't re-fetch within the same modal session.
  const [prsByRepo, setPrsByRepo] = useState<Record<string, PRSummary[] | null>>({})
  const [prsLoadingRepo, setPrsLoadingRepo] = useState<string | null>(null)
  const [prsError, setPrsError] = useState<string | null>(null)
  const [prClickPending, setPrClickPending] = useState<number | null>(null)
  // PR mode is select-then-create — same pattern as the other modes. Clicking
  // a row selects it; the footer "Create worktree" button submits.
  const [selectedPRNumber, setSelectedPRNumber] = useState<number | null>(null)
  // "Look up by number" path: type a PR number, resolve it on demand against
  // the upstream repo, show its details, then create. A successful lookup
  // becomes THE selection (replaces any list click); selecting a list row
  // clears it. selectedPRNumber stays the single source of truth for submit.
  const [prNumberInput, setPrNumberInput] = useState('')
  const [lookupPending, setLookupPending] = useState(false)
  const [lookupError, setLookupError] = useState<string | null>(null)
  const [lookedUpPR, setLookedUpPR] = useState<PRSummary | null>(null)

  // Same pattern as prsByRepo: cache normalized branch lists per repo
  // for the lifetime of the modal. Reset when repo changes.
  const [branchesByRepo, setBranchesByRepo] = useState<Record<string, string[]>>({})

  const parsedTeleport = mode === 'teleport' ? parseTeleportInput(teleportInput) : null
  const teleportInvalid = mode === 'teleport' && teleportInput.trim().length > 0 && !parsedTeleport
  // The active branch tab dictates which value is submitted — picking from a
  // hidden tab does NOT carry through. Keeps "what you see is what you submit"
  // intact when the user toggles between New / Existing / Ref.
  const submitBranch =
    branchTab === 'new'
      ? branch
      : branchTab === 'existing'
        ? (existingBranch ?? '')
        : refBranch
  const effectiveBranch = mode === 'teleport'
    ? (parsedTeleport ? teleportFolderName(parsedTeleport) : '')
    : submitBranch
  // On the Ref tab the new branch is forked from this base ref (commit SHA,
  // tag, remote ref, or an expression like `HEAD~3`). It can include chars
  // that `isValidBranchName` rightly rejects for branch *names*, so it's only
  // validated for non-emptiness — git resolves it at worktree-add time.
  const baseRef = branchTab === 'ref' ? refValue.trim() : undefined
  // The Ref tab requires BOTH a valid new branch name and a non-empty base
  // ref; other tabs just need a valid branch name (or a parsed teleport id).
  const canSubmit =
    !submitting &&
    !!selectedRepo &&
    (mode === 'fresh'
      ? branchTab === 'ref'
        ? isValidBranchName(submitBranch) && !!baseRef
        : isValidBranchName(submitBranch)
      : !!parsedTeleport && !teleportInvalid && isValidBranchName(effectiveBranch))

  useEffect(() => {
    branchRef.current?.focus()
  }, [])

  // Lazy-load the PR list when the tab is shown for a repo we haven't
  // fetched yet in this modal session. Deps intentionally exclude
  // prsByRepo + prsLoadingRepo: setting them inside the effect would
  // otherwise re-fire it, cancel the in-flight fetch, and strand the
  // spinner once the canceled response is dropped.
  useEffect(() => {
    if (mode !== 'pr' || !selectedRepo) return
    if (selectedRepo in prsByRepo) return
    let cancelled = false
    setPrsLoadingRepo(selectedRepo)
    setPrsError(null)
    void (async () => {
      try {
        const result = await backend.listRepoPRs(selectedRepo)
        if (cancelled) return
        setPrsByRepo((prev) => ({ ...prev, [selectedRepo]: result }))
      } catch (err) {
        if (cancelled) return
        setPrsError(err instanceof Error ? err.message : 'Failed to fetch PRs')
        setPrsByRepo((prev) => ({ ...prev, [selectedRepo]: null }))
      } finally {
        if (!cancelled) setPrsLoadingRepo(null)
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, selectedRepo])

  const handlePRSelect = useCallback((prNumber: number) => {
    setSelectedPRNumber((prev) => (prev === prNumber ? null : prNumber))
    // A list click is now the selection — drop any looked-up card so there's
    // one visible source of truth.
    setLookedUpPR(null)
    setPrNumberInput('')
    setLookupError(null)
    setError(null)
  }, [])

  const handlePRLookup = useCallback(async () => {
    if (lookupPending) return
    const n = Number.parseInt(prNumberInput.trim(), 10)
    if (!Number.isInteger(n) || n <= 0) {
      setLookupError('Enter a valid PR number')
      return
    }
    setLookupPending(true)
    setLookupError(null)
    try {
      const res = await backend.getPRByNumber(selectedRepo, n)
      if (res.ok) {
        setLookedUpPR(res.pr)
        setSelectedPRNumber(res.pr.number)
        setError(null)
      } else {
        setLookedUpPR(null)
        setSelectedPRNumber(null)
        if (res.reason === 'not-found') setLookupError(`PR #${n} not found`)
        else if (res.reason === 'no-token')
          setLookupError('Add a GitHub token in Settings to look up PRs')
        else setLookupError(res.message || 'Failed to look up PR')
      }
    } catch (err) {
      setLookedUpPR(null)
      setSelectedPRNumber(null)
      setLookupError(err instanceof Error ? err.message : 'Failed to look up PR')
    } finally {
      setLookupPending(false)
    }
  }, [backend, lookupPending, prNumberInput, selectedRepo])

  const handlePRSubmit = useCallback(async () => {
    if (prClickPending !== null) return
    if (selectedPRNumber === null) return
    setPrClickPending(selectedPRNumber)
    setError(null)
    try {
      await onPRSubmit(
        selectedRepo,
        selectedPRNumber,
        reviewPrompt.trim(),
        agentKindOverride,
        modelOverride.trim() || undefined
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to open PR')
      setPrClickPending(null)
    }
  }, [onPRSubmit, prClickPending, selectedPRNumber, selectedRepo, reviewPrompt, agentKindOverride, modelOverride])

  // Lazy-fetch branches for the selected repo when entering fresh mode.
  // Same self-cancellation pattern as the PR list above.
  useEffect(() => {
    if (mode !== 'fresh' || !selectedRepo) return
    if (selectedRepo in branchesByRepo) return
    let cancelled = false
    void (async () => {
      try {
        const raw = await backend.listBranches(selectedRepo)
        if (cancelled) return
        setBranchesByRepo((prev) => ({ ...prev, [selectedRepo]: normalizeBranchList(raw) }))
      } catch {
        if (cancelled) return
        setBranchesByRepo((prev) => ({ ...prev, [selectedRepo]: [] }))
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, selectedRepo])

  const handleBranchChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setBranch(sanitizeBranchInput(e.target.value))
  }, [])

  const handlePickExistingBranch = useCallback((name: string | null) => {
    setExistingBranch(name)
  }, [])

  const handleRefChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    // No sanitization: refs legitimately contain chars (`~`, `^`) that
    // sanitizeBranchInput strips. Trust git to validate at worktree-add time.
    setRefValue(e.target.value)
  }, [])

  const handleRefBranchChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setRefBranch(sanitizeBranchInput(e.target.value))
  }, [])

  // Switching tabs wipes the value of the tab being left, so each tab is
  // a fresh slate when entered. Without this, a stale value typed into one
  // tab would silently linger and could be submitted later if the user
  // toggled back to it.
  const switchBranchTab = useCallback((next: 'new' | 'existing' | 'ref') => {
    setBranchTab((prev) => {
      if (prev === next) return prev
      if (prev === 'new') setBranch('')
      else if (prev === 'existing') setExistingBranch(null)
      else {
        setRefValue('')
        setRefBranch('')
      }
      return next
    })
  }, [])

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return
    setSubmitting(true)
    setError(null)
    try {
      // Teleport mode always Claude — codex has no resume-by-session-id
      // analog today.
      const effectiveAgent: 'claude' | 'codex' =
        mode === 'teleport' ? 'claude' : agentKindOverride
      // Existing tab: `git worktree add <dir> <branch>` (no `-b`) so git
      // checks out the already-existing local branch as-is. Ref tab: create
      // a new branch named `effectiveBranch` forked from `baseRef`.
      const checkoutExisting = mode === 'fresh' && branchTab === 'existing'
      await onSubmit(
        selectedRepo,
        effectiveBranch,
        prompt.trim(),
        parsedTeleport || undefined,
        effectiveAgent,
        modelOverride.trim() || undefined,
        checkoutExisting,
        baseRef
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create worktree')
      setSubmitting(false)
    }
  }, [effectiveBranch, prompt, canSubmit, onSubmit, parsedTeleport, selectedRepo, mode, agentKindOverride, modelOverride, branchTab, baseRef])

  const cycleRepo = useCallback((direction: 1 | -1) => {
    if (repoRoots.length <= 1) return
    const idx = repoRoots.indexOf(selectedRepo)
    const next = (idx + direction + repoRoots.length) % repoRoots.length
    setSelectedRepo(repoRoots[next])
  }, [repoRoots, selectedRepo])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        if (mode === 'pr') void handlePRSubmit()
        else handleSubmit()
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
      }
      if ((e.metaKey || e.ctrlKey) && e.key === '[') {
        e.preventDefault()
        cycleRepo(-1)
      }
      if ((e.metaKey || e.ctrlKey) && e.key === ']') {
        e.preventDefault()
        cycleRepo(1)
      }
    },
    [mode, handlePRSubmit, handleSubmit, onCancel, cycleRepo]
  )

  // Selection is per-(repo, PR-list) — switching repos invalidates it,
  // including the looked-up-by-number card.
  useEffect(() => {
    setSelectedPRNumber(null)
    setLookedUpPR(null)
    setPrNumberInput('')
    setLookupError(null)
    setLookupPending(false)
  }, [selectedRepo, mode])

  const handleBranchKey = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
      e.preventDefault()
      promptRef.current?.focus()
    }
  }, [])

  return (
    <div
      className="flex-1 flex flex-col min-w-0 bg-app brand-grid-bg relative"
      onKeyDown={handleKeyDown}
    >
      <div className="drag-region h-10 shrink-0 flex items-center justify-end pr-2">
        <button
          onClick={onCancel}
          title="Close (Esc)"
          className="no-drag text-dim hover:text-fg p-1.5 rounded transition-colors cursor-pointer"
        >
          <X className="icon-base" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto px-8 py-8">
          <div className="text-center mb-8">
            <img
              src={iconUrl}
              alt="Harness"
              className="w-20 h-20 mx-auto rounded-3xl mb-5 brand-glow-amber"
            />
            <h1 className="text-3xl font-extrabold tracking-tight mb-2">
              New <span className="brand-gradient-text">worktree</span>
            </h1>
            <p className="text-muted text-base">
              Fork a branch or select an existing branch and send Claude into it.
            </p>
          </div>

          <div className="bg-panel/80 backdrop-blur border border-border rounded-2xl p-6 shadow-xl">
            <div className="flex p-1 bg-app border border-border-strong rounded-lg mb-6">
              <button
                type="button"
                onClick={() => {
                  setMode('fresh')
                  requestAnimationFrame(() => branchRef.current?.focus())
                }}
                disabled={submitting}
                className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md transition-colors cursor-pointer ${
                  mode === 'fresh'
                    ? 'bg-panel text-fg-bright shadow-sm'
                    : 'text-dim hover:text-fg'
                }`}
              >
                <Sparkles className="icon-xs" />
                Fresh start
              </button>
              <button
                type="button"
                onClick={() => {
                  setMode('teleport')
                  requestAnimationFrame(() => teleportRef.current?.focus())
                }}
                disabled={submitting}
                className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md transition-colors cursor-pointer ${
                  mode === 'teleport'
                    ? 'bg-panel text-fg-bright shadow-sm'
                    : 'text-dim hover:text-fg'
                }`}
              >
                <Radio className="icon-xs" />
                Teleport from claude.ai
              </button>
              <button
                type="button"
                onClick={() => setMode('pr')}
                disabled={submitting}
                className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md transition-colors cursor-pointer ${
                  mode === 'pr'
                    ? 'bg-panel text-fg-bright shadow-sm'
                    : 'text-dim hover:text-fg'
                }`}
              >
                <GitPullRequest className="icon-xs" />
                Open PR
              </button>
            </div>

            {repoRoots.length > 1 && (
              <div className="mb-5">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-semibold uppercase tracking-wider text-dim">
                    Repository
                  </span>
                  <span className="text-xs text-faint">
                    <span className="font-mono">⌘[</span> <span className="font-mono">⌘]</span> to switch
                  </span>
                </div>
                <div className="flex p-1 bg-app border border-border-strong rounded-lg gap-1 flex-wrap">
                  {repoRoots.map((r) => (
                    <button
                      key={r}
                      type="button"
                      onClick={() => setSelectedRepo(r)}
                      disabled={submitting}
                      className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md transition-colors cursor-pointer ${
                        selectedRepo === r
                          ? 'bg-panel text-fg-bright shadow-sm'
                          : 'text-dim hover:text-fg'
                      }`}
                    >
                      <RepoIcon repoName={r.split('/').pop() || r} className="text-sm" />
                      {r.split('/').pop() || r}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {mode === 'fresh' && (
              <div>
                <div className="flex p-1 bg-app border border-border-strong rounded-lg mb-3">
                  <button
                    type="button"
                    onClick={() => {
                      switchBranchTab('new')
                      requestAnimationFrame(() => branchRef.current?.focus())
                    }}
                    disabled={submitting}
                    className={`flex-1 flex items-center justify-center px-3 py-1.5 text-xs font-semibold rounded-md transition-colors cursor-pointer ${
                      branchTab === 'new'
                        ? 'bg-panel text-fg-bright shadow-sm'
                        : 'text-dim hover:text-fg'
                    }`}
                  >
                    New branch
                  </button>
                  <button
                    type="button"
                    onClick={() => switchBranchTab('existing')}
                    disabled={submitting}
                    className={`flex-1 flex items-center justify-center px-3 py-1.5 text-xs font-semibold rounded-md transition-colors cursor-pointer ${
                      branchTab === 'existing'
                        ? 'bg-panel text-fg-bright shadow-sm'
                        : 'text-dim hover:text-fg'
                    }`}
                  >
                    Existing branch
                  </button>
                  <button
                    type="button"
                    onClick={() => switchBranchTab('ref')}
                    disabled={submitting}
                    className={`flex-1 flex items-center justify-center px-3 py-1.5 text-xs font-semibold rounded-md transition-colors cursor-pointer ${
                      branchTab === 'ref'
                        ? 'bg-panel text-fg-bright shadow-sm'
                        : 'text-dim hover:text-fg'
                    }`}
                  >
                    Any Git Ref
                  </button>
                </div>

                {branchTab === 'new' && (
                  <input
                    ref={branchRef}
                    type="text"
                    value={branch}
                    onChange={handleBranchChange}
                    onKeyDown={handleBranchKey}
                    placeholder="fix-the-thing"
                    disabled={submitting}
                    autoComplete="off"
                    spellCheck={false}
                    className="w-full bg-app border-2 border-border-strong rounded-lg px-3 py-2.5 font-mono text-sm text-fg-bright placeholder-faint outline-none focus:border-accent transition-colors disabled:opacity-50"
                  />
                )}
                {branchTab === 'existing' && (
                  <ExistingBranchCombobox
                    branches={branchesByRepo[selectedRepo] || []}
                    value={existingBranch}
                    onChange={handlePickExistingBranch}
                    disabled={submitting || !selectedRepo}
                    placeholder={!selectedRepo ? 'Select a repository first' : undefined}
                  />
                )}
                {branchTab === 'ref' && (
                  <div className="space-y-2">
                    <input
                      type="text"
                      value={refBranch}
                      onChange={handleRefBranchChange}
                      placeholder="new-branch-name"
                      disabled={submitting || !selectedRepo}
                      autoComplete="off"
                      spellCheck={false}
                      className="w-full bg-app border-2 border-border-strong rounded-lg px-3 py-2.5 font-mono text-sm text-fg-bright placeholder-faint outline-none focus:border-accent transition-colors disabled:opacity-50"
                    />
                    <input
                      type="text"
                      value={refValue}
                      onChange={handleRefChange}
                      onKeyDown={handleBranchKey}
                      placeholder="from: commit SHA, tag, or origin/branch"
                      disabled={submitting || !selectedRepo}
                      autoComplete="off"
                      spellCheck={false}
                      className="w-full bg-app border-2 border-border-strong rounded-lg px-3 py-2.5 font-mono text-sm text-fg-bright placeholder-faint outline-none focus:border-accent transition-colors disabled:opacity-50"
                    />
                    <p className="text-xs text-dim">
                      Creates a new branch at any git ref — a commit SHA, tag, or remote branch (e.g. <span className="font-mono">origin/main</span>).
                    </p>
                  </div>
                )}
              </div>
            )}

            {mode === 'fresh' && (
              <label className="block mt-6">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-semibold uppercase tracking-wider text-dim">
                    Kickoff prompt
                  </span>
                  <span className="text-xs text-faint">optional</span>
                </div>
                <textarea
                  ref={promptRef}
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder="What should Claude start on? Leave blank to drop in and take it from there."
                  disabled={submitting}
                  rows={5}
                  className="w-full bg-app border-2 border-border-strong rounded-lg px-4 py-3 text-sm text-fg-bright placeholder-faint outline-none focus:border-accent transition-colors resize-none"
                />
              </label>
            )}

            {mode === 'teleport' && (
              <label className="block">
                <div className="mb-2">
                  <span className="text-xs font-semibold uppercase tracking-wider text-dim">
                    Session id or command
                  </span>
                </div>
                <input
                  ref={teleportRef}
                  type="text"
                  value={teleportInput}
                  onChange={(e) => setTeleportInput(e.target.value)}
                  placeholder="session_014RhXscMpGuVrBJnbeTcpVn  or  claude --teleport session_…"
                  disabled={submitting}
                  autoComplete="off"
                  spellCheck={false}
                  className={`w-full bg-app border-2 rounded-lg px-3 py-2.5 font-mono text-sm text-fg-bright placeholder-faint outline-none transition-colors ${
                    teleportInvalid
                      ? 'border-danger focus:border-danger'
                      : 'border-border-strong focus:border-accent'
                  }`}
                />
                <div className="mt-2 text-xs text-dim leading-snug">
                  {teleportInvalid ? (
                    <span className="text-danger">
                      Couldn't find a <span className="font-mono">session_…</span> id in there.
                    </span>
                  ) : parsedTeleport ? (
                    <>
                      Worktree folder: <span className="font-mono text-fg">{effectiveBranch}</span>
                      {' '}— the Claude CLI will check out the session's own branch on top.
                    </>
                  ) : (
                    <>
                      Grab a session id from{' '}
                      <span className="font-mono">claude.ai/code</span> to resume it here.
                    </>
                  )}
                </div>
              </label>
            )}

            {mode === 'pr' && (
              <>
                <label className="block mb-4">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-semibold uppercase tracking-wider text-dim">
                      Review prompt
                    </span>
                    <span className="text-xs text-faint">
                      sent to Claude after the PR loads · edit defaults in Settings
                    </span>
                  </div>
                  <textarea
                    value={reviewPrompt}
                    onChange={(e) => setReviewPrompt(e.target.value)}
                    placeholder="Leave blank to drop in with no kickoff prompt."
                    disabled={prClickPending !== null}
                    rows={4}
                    className="w-full bg-app border-2 border-border-strong rounded-lg px-4 py-3 text-sm text-fg-bright placeholder-faint outline-none focus:border-accent transition-colors resize-none"
                  />
                </label>
                <AgentModelRow
                  mode={mode}
                  agentKind={agentKindOverride}
                  setAgentKind={setAgentKindOverride}
                  model={modelOverride}
                  setModel={setModelOverride}
                  defaultClaudeModel={settings.claudeModel}
                  defaultCodexModel={settings.codexModel}
                  disabled={prClickPending !== null}
                />
                <div className="mt-5">
                  <div className="text-xs font-semibold uppercase tracking-wider text-dim mb-2">
                    Look up by number
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-dim">PR #</span>
                    <input
                      type="text"
                      inputMode="numeric"
                      value={prNumberInput}
                      onChange={(e) => setPrNumberInput(e.target.value.replace(/[^0-9]/g, ''))}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          void handlePRLookup()
                        }
                      }}
                      placeholder="182"
                      disabled={prClickPending !== null}
                      className="w-28 bg-app border-2 border-border-strong rounded-lg px-3 py-2 text-sm text-fg-bright placeholder-faint outline-none focus:border-accent transition-colors"
                    />
                    <button
                      type="button"
                      onClick={() => void handlePRLookup()}
                      disabled={
                        prClickPending !== null || lookupPending || prNumberInput.trim().length === 0
                      }
                      className="px-3 py-2 text-sm rounded-lg border border-border-strong bg-app text-dim hover:text-fg hover:border-accent transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-40 flex items-center gap-1.5"
                    >
                      {lookupPending && <Loader2 className="icon-sm animate-spin" />}
                      Look up
                    </button>
                  </div>
                  {lookupError && <div className="mt-2 text-sm text-danger">{lookupError}</div>}
                  {lookedUpPR && (
                    <div className="mt-3 flex flex-col gap-1.5">
                      <PRPickerRow
                        pr={lookedUpPR}
                        viewerLogin={settings.viewerLogin}
                        isSelected={selectedPRNumber === lookedUpPR.number}
                        isPending={prClickPending === lookedUpPR.number}
                        disabled={prClickPending !== null}
                        onSelect={() => setSelectedPRNumber(lookedUpPR.number)}
                      />
                      {lookedUpPR.state && lookedUpPR.state !== 'open' && (
                        <div className="text-xs text-warning">This PR is {lookedUpPR.state}.</div>
                      )}
                    </div>
                  )}
                </div>
                <div className="text-xs font-semibold uppercase tracking-wider text-dim mt-6">
                  Open PRs
                </div>
                <PRPickerList
                  prs={prsByRepo[selectedRepo]}
                  loading={prsLoadingRepo === selectedRepo}
                  error={prsError}
                  disabled={prClickPending !== null}
                  selectedNumber={selectedPRNumber}
                  pendingNumber={prClickPending}
                  viewerLogin={settings.viewerLogin}
                  onSelect={handlePRSelect}
                />
              </>
            )}

            {mode !== 'pr' && (
              <AgentModelRow
                mode={mode}
                agentKind={agentKindOverride}
                setAgentKind={setAgentKindOverride}
                model={modelOverride}
                setModel={setModelOverride}
                defaultClaudeModel={settings.claudeModel}
                defaultCodexModel={settings.codexModel}
                disabled={submitting}
              />
            )}

            {error && (
              <div className="mt-4 text-sm text-danger bg-danger/10 border border-danger/30 rounded-lg px-3 py-2">
                {error}
              </div>
            )}

            {mode !== 'pr' && (
              <div className="flex items-center justify-between mt-6 gap-3">
                <div className="text-xs text-faint">
                  <span className="font-mono">⌘⏎</span> to create ·{' '}
                  <span className="font-mono">Esc</span> to cancel
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={onCancel}
                    disabled={submitting}
                    className="px-4 py-2 text-sm text-dim hover:text-fg transition-colors cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleSubmit}
                    disabled={!canSubmit}
                    className="brand-gradient-bg text-white font-semibold text-sm px-5 py-2.5 rounded-lg flex items-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed hover:brightness-110 transition-all shadow-lg cursor-pointer"
                  >
                    {submitting ? (
                      <>
                        <Loader2 className="icon-sm animate-spin" />
                        Creating…
                      </>
                    ) : (
                      <>
                        <Sparkles className="icon-sm" />
                        Create worktree
                      </>
                    )}
                  </button>
                </div>
              </div>
            )}

            {mode === 'pr' && (
              <div className="flex items-center justify-between mt-6 gap-3">
                <div className="text-xs text-faint">
                  <span className="font-mono">⌘⏎</span> to create ·{' '}
                  <span className="font-mono">Esc</span> to cancel
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={onCancel}
                    disabled={prClickPending !== null}
                    className="px-4 py-2 text-sm text-dim hover:text-fg transition-colors cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => void handlePRSubmit()}
                    disabled={selectedPRNumber === null || prClickPending !== null}
                    className="brand-gradient-bg text-white font-semibold text-sm px-5 py-2.5 rounded-lg flex items-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed hover:brightness-110 transition-all shadow-lg cursor-pointer"
                  >
                    {prClickPending !== null ? (
                      <>
                        <Loader2 className="icon-sm animate-spin" />
                        Creating…
                      </>
                    ) : (
                      <>
                        <Sparkles className="icon-sm" />
                        Create worktree
                      </>
                    )}
                  </button>
                </div>
              </div>
            )}
          </div>

          {mode === 'fresh' && (
          <div className="mt-10">
            <div className="mb-3 px-1">
              <span className="text-xs font-semibold uppercase tracking-wider text-dim">
                Or try a starter task
              </span>
            </div>
            <div className="grid sm:grid-cols-3 gap-3">
              {STARTER_PROMPTS.map(
                ({ icon: Icon, label, hint, branch: starterBranch, prompt: starterPrompt }) => (
                  <button
                    key={label}
                    type="button"
                    onClick={() => {
                      if (!branch) {
                        switchBranchTab('new')
                        setBranch(starterBranch)
                      }
                      setPrompt(starterPrompt)
                      promptRef.current?.focus()
                    }}
                    disabled={submitting}
                    className="text-left bg-panel/60 border border-border/60 hover:border-accent hover:bg-panel rounded-xl p-4 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <Icon className="w-[1.125rem] h-[1.125rem] text-accent mb-2" />
                    <div className="text-sm text-fg font-medium">{label}</div>
                    <div className="text-xs text-dim mt-0.5">{hint}</div>
                  </button>
                )
              )}
            </div>
          </div>
          )}
        </div>
      </div>
    </div>
  )
}

interface PRPickerListProps {
  prs: PRSummary[] | null | undefined
  loading: boolean
  error: string | null
  disabled: boolean
  /** Currently-selected PR number — drives the highlight. */
  selectedNumber: number | null
  /** PR number currently being submitted — drives the row spinner. */
  pendingNumber: number | null
  viewerLogin: string | null
  onSelect: (prNumber: number) => void
}

const CHECKS_OVERALL_COLORS: Record<NonNullable<PRSummary['checksOverall']>, string> = {
  success: 'bg-success',
  failure: 'bg-danger',
  pending: 'bg-warning',
  none: 'bg-dim'
}

const CHECKS_OVERALL_LABELS: Record<NonNullable<PRSummary['checksOverall']>, string> = {
  success: 'All checks passing',
  failure: 'Some checks failing',
  pending: 'Checks running',
  none: 'No checks'
}

function labelTextColor(hex: string): string {
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return '#fff'
  const r = parseInt(hex.slice(0, 2), 16)
  const g = parseInt(hex.slice(2, 4), 16)
  const b = parseInt(hex.slice(4, 6), 16)
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
  return lum > 140 ? '#1f2328' : '#ffffff'
}

const MAX_VISIBLE_LABELS = 4

function isViewerRequested(pr: PRSummary, viewerLogin: string | null): boolean {
  if (!viewerLogin) return false
  if (pr.author?.login === viewerLogin) return false
  return pr.requestedReviewers.some((r) => r.login === viewerLogin)
}

function PRPickerList({
  prs,
  loading,
  error,
  disabled,
  selectedNumber,
  pendingNumber,
  viewerLogin,
  onSelect
}: PRPickerListProps): JSX.Element {
  // Persist across reopens of the same modal session but not across
  // app restarts — useState in the modal component, not a slice.
  const [needsMyReviewOnly, setNeedsMyReviewOnly] = useState(false)

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-12 text-sm text-dim">
        <Loader2 className="icon-sm animate-spin" />
        Fetching open PRs…
      </div>
    )
  }
  if (error || prs === null) {
    return (
      <div className="text-center py-12 text-sm text-dim">
        Couldn't fetch PRs.{' '}
        <span className="text-faint">Check your GitHub token in Settings.</span>
      </div>
    )
  }
  if (!prs || prs.length === 0) {
    return (
      <div className="text-center py-12 text-sm text-dim">
        No open PRs in this repo.
      </div>
    )
  }

  const needsMyReviewCount = prs.filter((p) => isViewerRequested(p, viewerLogin)).length
  const showFilter = needsMyReviewCount > 0
  const filteredPrs = needsMyReviewOnly
    ? prs.filter((p) => isViewerRequested(p, viewerLogin))
    : prs

  return (
    <div className="flex flex-col gap-2 mt-5">
      {showFilter && (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setNeedsMyReviewOnly((v) => !v)}
            disabled={disabled}
            className={`px-2.5 py-1 text-xs rounded-full border transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-40 flex items-center gap-1.5 ${
              needsMyReviewOnly
                ? 'bg-accent/25 border-accent text-fg-bright'
                : 'bg-app border-border-strong text-dim hover:text-fg hover:border-accent'
            }`}
          >
            Needs my review
            <span
              className={`px-1 rounded text-xs font-medium ${
                needsMyReviewOnly ? 'bg-accent/30' : 'bg-panel/80'
              }`}
            >
              {needsMyReviewCount}
            </span>
          </button>
        </div>
      )}
      <div className="flex flex-col gap-1.5 max-h-[420px] overflow-y-auto pr-1">
        {filteredPrs.length === 0 ? (
          <div className="text-center py-12 text-sm text-dim">
            No PRs need your review.
          </div>
        ) : (
          filteredPrs.map((pr) => (
            <PRPickerRow
              key={pr.number}
              pr={pr}
              viewerLogin={viewerLogin}
              isSelected={selectedNumber === pr.number}
              isPending={pendingNumber === pr.number}
              disabled={disabled}
              onSelect={onSelect}
            />
          ))
        )}
      </div>
    </div>
  )
}

interface PRPickerRowProps {
  pr: PRSummary
  viewerLogin: string | null
  isSelected: boolean
  isPending: boolean
  disabled: boolean
  onSelect: (prNumber: number) => void
}

function PRPickerRow({ pr, viewerLogin, isSelected, isPending, disabled, onSelect }: PRPickerRowProps): JSX.Element {
  const viewerRequested = isViewerRequested(pr, viewerLogin)
  const visibleLabels = pr.labels.slice(0, MAX_VISIBLE_LABELS)
  const overflowLabels = pr.labels.length - visibleLabels.length

  // Merge requested reviewers + reviewed-state reviewers into one avatar
  // strip, deduped by login. Ring color reflects state.
  type ReviewerCell = { login: string; avatarUrl: string; ring: string; title: string }
  const reviewerByLogin: Map<string, ReviewerCell> = new Map()
  for (const r of pr.requestedReviewers) {
    reviewerByLogin.set(r.login, {
      login: r.login,
      avatarUrl: r.avatarUrl,
      ring: 'ring-1 ring-faint',
      title: `${r.login} (review requested)`
    })
  }
  for (const r of pr.reviewerStates) {
    const ring =
      r.state === 'APPROVED'
        ? 'ring-1 ring-success'
        : r.state === 'CHANGES_REQUESTED'
          ? 'ring-1 ring-warning'
          : 'ring-1 ring-dim'
    const label =
      r.state === 'APPROVED'
        ? 'approved'
        : r.state === 'CHANGES_REQUESTED'
          ? 'requested changes'
          : 'commented'
    reviewerByLogin.set(r.login, {
      login: r.login,
      avatarUrl: r.avatarUrl,
      ring,
      title: `${r.login} (${label})`
    })
  }
  const reviewerAvatars = [...reviewerByLogin.values()]

  return (
    <button
      type="button"
      onClick={() => onSelect(pr.number)}
      disabled={disabled}
      aria-pressed={isSelected}
      className={`text-left bg-panel/60 border rounded-xl p-3 transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-40 ${
        isSelected || isPending ? 'border-accent bg-panel' : 'border-border/60 hover:border-accent hover:bg-panel'
      }`}
    >
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-xs text-faint shrink-0">#{pr.number}</span>
        <span className="text-sm text-fg-bright font-medium truncate flex-1 min-w-0">
          {pr.title}
        </span>
        {viewerRequested && (
          <span
            className="shrink-0 px-1.5 py-0.5 rounded-full text-xs font-medium bg-accent/25 text-fg-bright"
            title="You are a requested reviewer"
          >
            Needs your review
          </span>
        )}
        {pr.checksOverall && (
          <span
            className={`inline-block w-2 h-2 rounded-full shrink-0 ${CHECKS_OVERALL_COLORS[pr.checksOverall]}`}
            title={CHECKS_OVERALL_LABELS[pr.checksOverall]}
          />
        )}
        {isPending && <Loader2 className="icon-xs animate-spin text-accent shrink-0" />}
      </div>
      <div className="mt-1 text-xs text-dim flex items-center gap-1.5 flex-wrap">
        {pr.author && <span>by {pr.author.login}</span>}
        <span className="text-faint">·</span>
        <span className="font-mono text-faint">
          {pr.baseBranch} ← {pr.isFork && pr.headRepoFullName
            ? `${pr.headRepoFullName}:${pr.headBranch}`
            : pr.headBranch}
        </span>
        {pr.draft && (
          <>
            <span className="text-faint">·</span>
            <span className="text-faint">draft</span>
          </>
        )}
        <span className="text-faint">·</span>
        <span>updated {relTime(pr.updatedAt)}</span>
        {reviewerAvatars.length > 0 && (
          <span className="flex items-center ml-1">
            {reviewerAvatars.map((r, i) => (
              <img
                key={r.login}
                src={r.avatarUrl}
                alt={r.login}
                title={r.title}
                className={`w-4 h-4 rounded-full ${r.ring} ${i > 0 ? '-ml-1' : ''}`}
              />
            ))}
          </span>
        )}
      </div>
      {visibleLabels.length > 0 && (
        <div className="mt-1.5 flex items-center flex-wrap gap-1">
          {visibleLabels.map((label) => {
            const fg = labelTextColor(label.color)
            return (
              <span
                key={label.name}
                className="px-1.5 py-0.5 rounded-full text-xs font-medium leading-tight"
                style={{ backgroundColor: `#${label.color}`, color: fg }}
                title={label.name}
              >
                {label.name}
              </span>
            )
          })}
          {overflowLabels > 0 && (
            <span className="text-xs text-faint">+{overflowLabels}</span>
          )}
        </div>
      )}
    </button>
  )
}

interface AgentModelRowProps {
  mode: 'fresh' | 'teleport' | 'pr'
  agentKind: 'claude' | 'codex'
  setAgentKind: (k: 'claude' | 'codex') => void
  model: string
  setModel: (m: string) => void
  defaultClaudeModel: string | null
  defaultCodexModel: string | null
  disabled: boolean
}

function AgentModelRow({
  mode,
  agentKind,
  setAgentKind,
  model,
  setModel,
  defaultClaudeModel,
  defaultCodexModel,
  disabled
}: AgentModelRowProps): JSX.Element {
  // Teleport mode pins to Claude — codex has no equivalent
  // "resume by session id" today. Lock the selector so users don't
  // think they can flip it.
  const locked = mode === 'teleport'
  const effectiveAgent = locked ? 'claude' : agentKind
  const modelOptions = effectiveAgent === 'codex' ? CODEX_MODELS : CLAUDE_MODELS
  const fallbackModel =
    effectiveAgent === 'codex' ? defaultCodexModel : defaultClaudeModel
  const fallbackDisplay =
    modelOptions.find((m) => m.id === fallbackModel)?.displayName || fallbackModel
  const defaultLabel = fallbackDisplay
    ? `(Default — settings: ${fallbackDisplay})`
    : '(Default — let CLI choose)'

  // Auto-open when the user has typed a model override OR picked a non-
  // claude agent — so a state that's already non-default isn't hidden
  // behind a collapsed header. Plain `useState` here makes the open flag
  // sticky once the user expands; collapsing again is always a click.
  const [openOverride, setOpenOverride] = useState(false)
  const hasNonDefault = (!locked && agentKind !== 'claude') || model.trim().length > 0
  const open = openOverride || hasNonDefault

  const handleAgentChange = (next: 'claude' | 'codex'): void => {
    // Reset the model when switching agents — otherwise a stale Claude
    // model id would be sent as Codex's --model flag (or vice versa).
    if (next !== agentKind) setModel('')
    setAgentKind(next)
  }

  const modelDisplay = modelOptions.find((m) => m.id === model)?.displayName || model

  return (
    <div className="mt-5">
      <button
        type="button"
        onClick={() => setOpenOverride((v) => !v)}
        className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-dim hover:text-fg transition-colors cursor-pointer"
      >
        {open ? <ChevronDown className="icon-xs" /> : <ChevronRight className="icon-xs" />}
        Advanced
        {!open && hasNonDefault && (
          <span className="ml-1 normal-case font-normal tracking-normal text-faint">
            ({effectiveAgent === 'codex' ? 'Codex' : 'Claude'}
            {model.trim() ? ` · ${modelDisplay}` : ''})
          </span>
        )}
      </button>
      {open && (
        <div className="flex items-center gap-3 mt-3">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-dim">
              Agent
            </span>
            <select
              value={effectiveAgent}
              onChange={(e) => handleAgentChange(e.target.value === 'codex' ? 'codex' : 'claude')}
              disabled={disabled || locked}
              title={locked ? 'Teleport sessions require Claude' : undefined}
              className="bg-app border border-border-strong rounded px-2 py-1 text-xs text-fg-bright outline-none focus:border-accent disabled:opacity-50 cursor-pointer"
            >
              <option value="claude">Claude</option>
              <option value="codex">Codex</option>
            </select>
          </div>
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <span className="text-xs font-semibold uppercase tracking-wider text-dim shrink-0">
              Model
            </span>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              disabled={disabled}
              className="flex-1 min-w-0 bg-app border border-border-strong rounded px-2 py-1 text-xs text-fg-bright outline-none focus:border-accent disabled:opacity-50 cursor-pointer"
            >
              <option value="">{defaultLabel}</option>
              <optgroup label="Current">
                {modelOptions.filter((m) => m.tier === 'current').map((m) => (
                  <option key={m.id} value={m.id}>{m.displayName}</option>
                ))}
              </optgroup>
              <optgroup label="Legacy">
                {modelOptions.filter((m) => m.tier === 'legacy').map((m) => (
                  <option key={m.id} value={m.id}>{m.displayName}</option>
                ))}
              </optgroup>
            </select>
          </div>
        </div>
      )}
    </div>
  )
}

interface ExistingBranchComboboxProps {
  branches: string[]
  value: string | null
  onChange: (name: string | null) => void
  disabled: boolean
  /** Optional override for the input placeholder. When omitted, the
   * combobox picks one of its own ("Filter local branches…" or
   * "No local branches found") based on `branches.length`. */
  placeholder?: string
}

/** Typeahead combobox over the local branch list (remote-tracking refs
 * are excluded — users wanting `origin/foo` should use the Ref tab). Typing
 * filters by substring (case-insensitive); ArrowUp/Down navigate;
 * Enter commits the highlighted match; Esc closes the panel; the
 * X button clears the current selection back to null. */
function ExistingBranchCombobox({
  branches,
  value,
  onChange,
  disabled,
  placeholder
}: ExistingBranchComboboxProps): JSX.Element {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [highlight, setHighlight] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // When a value is committed externally (or initially), reflect it in
  // the visible query so the user sees what they picked.
  useEffect(() => {
    if (value !== null) setQuery(value)
    else if (!open) setQuery('')
  }, [value, open])

  const filtered = (() => {
    const q = query.trim().toLowerCase()
    if (!q) return branches
    return branches.filter((b) => b.toLowerCase().includes(q))
  })()

  useEffect(() => {
    if (highlight >= filtered.length) setHighlight(0)
  }, [filtered.length, highlight])

  const commit = (name: string) => {
    onChange(name)
    setQuery(name)
    setOpen(false)
  }

  const handleKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (!open) setOpen(true)
      setHighlight((h) => Math.min(filtered.length - 1, h + 1))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlight((h) => Math.max(0, h - 1))
      return
    }
    if (e.key === 'Enter') {
      if (open && filtered[highlight]) {
        e.preventDefault()
        e.stopPropagation()
        commit(filtered[highlight])
      }
      return
    }
    if (e.key === 'Escape' && open) {
      e.preventDefault()
      e.stopPropagation()
      setOpen(false)
    }
  }

  const handleBlur = () => {
    // Defer so a click on a dropdown item registers before we unmount it.
    closeTimer.current = setTimeout(() => setOpen(false), 120)
  }
  const handleFocus = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current)
    if (!disabled) setOpen(true)
  }

  return (
    <div className="relative">
      <div className="relative">
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setOpen(true)
            // Typing invalidates the prior committed pick until they
            // match a branch again.
            if (value !== null) onChange(null)
          }}
          onFocus={handleFocus}
          onBlur={handleBlur}
          onKeyDown={handleKey}
          placeholder={placeholder ?? (branches.length === 0 ? 'No local branches found' : 'Filter local branches…')}
          disabled={disabled || branches.length === 0}
          autoComplete="off"
          spellCheck={false}
          className="w-full bg-app border-2 border-border-strong rounded-lg pl-3 pr-16 py-2.5 font-mono text-sm text-fg-bright placeholder-faint outline-none focus:border-accent transition-colors disabled:opacity-50"
        />
        <div className="absolute inset-y-0 right-2 flex items-center gap-1">
          {value !== null && !disabled && (
            <button
              type="button"
              onMouseDown={(e) => {
                // mousedown beats blur — clear before the input loses focus.
                e.preventDefault()
                onChange(null)
                setQuery('')
                inputRef.current?.focus()
              }}
              className="text-dim hover:text-fg p-1 rounded cursor-pointer"
              title="Clear selection"
            >
              <X className="icon-xs" />
            </button>
          )}
          <ChevronDown className="icon-sm text-dim pointer-events-none" />
        </div>
      </div>
      {open && filtered.length > 0 && (
        <div className="absolute z-10 mt-1 w-full max-h-56 overflow-y-auto bg-panel border border-border-strong rounded-lg shadow-xl">
          {filtered.map((b, i) => (
            <button
              key={b}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault()
                commit(b)
              }}
              onMouseEnter={() => setHighlight(i)}
              className={`w-full text-left px-3 py-1.5 font-mono text-xs flex items-center gap-2 cursor-pointer ${
                i === highlight ? 'bg-accent/20 text-fg-bright' : 'text-fg hover:bg-app/60'
              }`}
            >
              {value === b ? (
                <Check className="icon-xs text-accent shrink-0" />
              ) : (
                <span className="w-3 shrink-0" />
              )}
              <span className="truncate">{b}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

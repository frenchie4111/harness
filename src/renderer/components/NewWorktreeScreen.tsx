import { useState, useCallback, useEffect, useRef } from 'react'
import { Sparkles, Loader2, X, Map, ListChecks, BookOpen, Radio, GitPullRequest, ChevronRight, ChevronDown } from 'lucide-react'
import iconUrl from '../../../resources/icon.png'
import { sanitizeBranchInput, isValidBranchName } from '../branch-name'
import { RepoIcon } from './RepoIcon'
import { useBackend } from '../backend'
import { useSettings } from '../store'
import type { PRSummary } from '../types'

interface NewWorktreeScreenProps {
  onSubmit: (
    repoRoot: string,
    branchName: string,
    initialPrompt: string,
    teleportSessionId?: string,
    agentKind?: 'claude' | 'codex',
    model?: string
  ) => Promise<void>
  onPRSubmit: (
    repoRoot: string,
    prNumber: number,
    initialPrompt: string,
    agentKind?: 'claude' | 'codex',
    model?: string
  ) => Promise<void>
  onCancel: () => void
  repoRoots: string[]
  /** Repo to pre-select in the picker. Usually the repo of the currently active worktree. */
  defaultRepoRoot?: string
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
    icon: Map,
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

  const parsedTeleport = mode === 'teleport' ? parseTeleportInput(teleportInput) : null
  const teleportInvalid = mode === 'teleport' && teleportInput.trim().length > 0 && !parsedTeleport
  const effectiveBranch = mode === 'teleport'
    ? (parsedTeleport ? teleportFolderName(parsedTeleport) : '')
    : branch
  const canSubmit =
    !submitting &&
    !!selectedRepo &&
    (mode === 'fresh'
      ? isValidBranchName(branch)
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

  const handlePRClick = useCallback(
    async (prNumber: number) => {
      if (prClickPending !== null) return
      setPrClickPending(prNumber)
      setError(null)
      try {
        await onPRSubmit(
          selectedRepo,
          prNumber,
          reviewPrompt.trim(),
          agentKindOverride,
          modelOverride.trim() || undefined
        )
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to open PR')
        setPrClickPending(null)
      }
    },
    [onPRSubmit, prClickPending, selectedRepo, reviewPrompt, agentKindOverride, modelOverride]
  )

  const handleBranchChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setBranch(sanitizeBranchInput(e.target.value))
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
      await onSubmit(
        selectedRepo,
        effectiveBranch,
        prompt.trim(),
        parsedTeleport || undefined,
        effectiveAgent,
        modelOverride.trim() || undefined
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create worktree')
      setSubmitting(false)
    }
  }, [effectiveBranch, prompt, canSubmit, onSubmit, parsedTeleport, selectedRepo, mode, agentKindOverride, modelOverride])

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
        handleSubmit()
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
    [handleSubmit, onCancel, cycleRepo]
  )

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
          <X size={16} />
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
            <h1 className="text-5xl font-extrabold tracking-tight mb-2">
              New <span className="brand-gradient-text">worktree</span>
            </h1>
            <p className="text-muted text-base">
              Fork a branch and send a Claude into it.
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
                <Sparkles size={12} />
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
                <Radio size={12} />
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
                <GitPullRequest size={12} />
                Open PR
              </button>
            </div>

            {repoRoots.length > 1 && (
              <div className="mb-5">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-dim">
                    Repository
                  </span>
                  <span className="text-[11px] text-faint">
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
                      <RepoIcon repoName={r.split('/').pop() || r} size={14} />
                      {r.split('/').pop() || r}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {mode === 'fresh' && (
              <label className="block">
                <div className="mb-2">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-dim">
                    Branch name
                  </span>
                </div>
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
                  style={{ fontSize: '13px' }}
                  className="w-full bg-app border-2 border-border-strong rounded-lg px-3 py-2.5 font-mono text-fg-bright placeholder-faint outline-none focus:border-accent transition-colors"
                />
              </label>
            )}

            {mode === 'fresh' && (
              <label className="block mt-6">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-dim">
                    Kickoff prompt
                  </span>
                  <span className="text-[11px] text-faint">optional</span>
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
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-dim">
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
                  style={{ fontSize: '13px' }}
                  className={`w-full bg-app border-2 rounded-lg px-3 py-2.5 font-mono text-fg-bright placeholder-faint outline-none transition-colors ${
                    teleportInvalid
                      ? 'border-danger focus:border-danger'
                      : 'border-border-strong focus:border-accent'
                  }`}
                />
                <div className="mt-2 text-[11px] text-dim leading-snug">
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
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-dim">
                      Review prompt
                    </span>
                    <span className="text-[11px] text-faint">
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
                <PRPickerList
                  prs={prsByRepo[selectedRepo]}
                  loading={prsLoadingRepo === selectedRepo}
                  error={prsError}
                  disabled={prClickPending !== null}
                  pendingNumber={prClickPending}
                  onPick={handlePRClick}
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
                <div className="text-[11px] text-faint">
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
                        <Loader2 size={14} className="animate-spin" />
                        Creating…
                      </>
                    ) : (
                      <>
                        <Sparkles size={14} />
                        Create worktree
                      </>
                    )}
                  </button>
                </div>
              </div>
            )}

            {mode === 'pr' && (
              <div className="flex items-center justify-end mt-6 gap-3">
                <button
                  onClick={onCancel}
                  disabled={prClickPending !== null}
                  className="px-4 py-2 text-sm text-dim hover:text-fg transition-colors cursor-pointer"
                >
                  Cancel
                </button>
              </div>
            )}
          </div>

          {mode === 'fresh' && (
          <div className="mt-10">
            <div className="mb-3 px-1">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-dim">
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
                      if (!branch) setBranch(starterBranch)
                      setPrompt(starterPrompt)
                      promptRef.current?.focus()
                    }}
                    disabled={submitting}
                    className="text-left bg-panel/60 border border-border/60 hover:border-accent hover:bg-panel rounded-xl p-4 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <Icon size={18} className="text-accent mb-2" />
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
  pendingNumber: number | null
  onPick: (prNumber: number) => void
}

function PRPickerList({ prs, loading, error, disabled, pendingNumber, onPick }: PRPickerListProps): JSX.Element {
  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-12 text-sm text-dim">
        <Loader2 size={14} className="animate-spin" />
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
  return (
    <div className="flex flex-col gap-1.5 max-h-[420px] overflow-y-auto pr-1">
      {prs.map((pr) => {
        const isPending = pendingNumber === pr.number
        return (
          <button
            key={pr.number}
            type="button"
            onClick={() => onPick(pr.number)}
            disabled={disabled}
            className={`text-left bg-panel/60 border border-border/60 rounded-xl p-3 transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-40 ${
              isPending ? 'border-accent bg-panel' : 'hover:border-accent hover:bg-panel'
            }`}
          >
            <div className="flex items-baseline gap-2">
              <span className="font-mono text-xs text-faint shrink-0">#{pr.number}</span>
              <span className="text-sm text-fg-bright font-medium truncate flex-1 min-w-0">
                {pr.title}
              </span>
              {isPending && <Loader2 size={12} className="animate-spin text-accent shrink-0" />}
            </div>
            <div className="mt-1 text-[11px] text-dim flex items-center gap-1.5 flex-wrap">
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
            </div>
          </button>
        )
      })}
    </div>
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
  const placeholder =
    effectiveAgent === 'codex'
      ? defaultCodexModel || 'default'
      : defaultClaudeModel || 'default'

  // Auto-open when the user has typed a model override OR picked a non-
  // claude agent — so a state that's already non-default isn't hidden
  // behind a collapsed header. Plain `useState` here makes the open flag
  // sticky once the user expands; collapsing again is always a click.
  const [openOverride, setOpenOverride] = useState(false)
  const hasNonDefault = (!locked && agentKind !== 'claude') || model.trim().length > 0
  const open = openOverride || hasNonDefault

  return (
    <div className="mt-5">
      <button
        type="button"
        onClick={() => setOpenOverride((v) => !v)}
        className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-dim hover:text-fg transition-colors cursor-pointer"
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        Advanced
        {!open && hasNonDefault && (
          <span className="ml-1 normal-case font-normal tracking-normal text-faint">
            ({effectiveAgent === 'codex' ? 'Codex' : 'Claude'}
            {model.trim() ? ` · ${model.trim()}` : ''})
          </span>
        )}
      </button>
      {open && (
        <div className="flex items-center gap-3 mt-3">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-dim">
              Agent
            </span>
            <select
              value={effectiveAgent}
              onChange={(e) => setAgentKind(e.target.value === 'codex' ? 'codex' : 'claude')}
              disabled={disabled || locked}
              title={locked ? 'Teleport sessions require Claude' : undefined}
              className="bg-app border border-border-strong rounded px-2 py-1 text-xs text-fg-bright outline-none focus:border-accent disabled:opacity-50"
            >
              <option value="claude">Claude</option>
              <option value="codex">Codex</option>
            </select>
          </div>
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-dim shrink-0">
              Model
            </span>
            <input
              type="text"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={placeholder}
              disabled={disabled}
              spellCheck={false}
              autoComplete="off"
              className="flex-1 min-w-0 bg-app border border-border-strong rounded px-2 py-1 text-xs font-mono text-fg-bright placeholder-faint outline-none focus:border-accent disabled:opacity-50"
            />
          </div>
        </div>
      )}
    </div>
  )
}

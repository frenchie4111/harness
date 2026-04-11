import { useState, useCallback, useEffect, useRef } from 'react'
import { Sparkles, Loader2, X, Map, ListChecks, BookOpen } from 'lucide-react'
import iconUrl from '../../../resources/icon.png'
import { sanitizeBranchInput, isValidBranchName } from '../branch-name'

interface NewWorktreeScreenProps {
  onSubmit: (branchName: string, initialPrompt: string) => Promise<void>
  onCancel: () => void
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

export function NewWorktreeScreen({ onSubmit, onCancel }: NewWorktreeScreenProps): JSX.Element {
  const [branch, setBranch] = useState('')
  const [prompt, setPrompt] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const branchRef = useRef<HTMLInputElement>(null)
  const promptRef = useRef<HTMLTextAreaElement>(null)

  const canSubmit = !submitting && isValidBranchName(branch)

  useEffect(() => {
    branchRef.current?.focus()
  }, [])

  const handleBranchChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setBranch(sanitizeBranchInput(e.target.value))
  }, [])

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return
    setSubmitting(true)
    setError(null)
    try {
      await onSubmit(branch, prompt.trim())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create worktree')
      setSubmitting(false)
    }
  }, [branch, prompt, canSubmit, onSubmit])

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
    },
    [handleSubmit, onCancel]
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

            {error && (
              <div className="mt-4 text-sm text-danger bg-danger/10 border border-danger/30 rounded-lg px-3 py-2">
                {error}
              </div>
            )}

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
          </div>

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
        </div>
      </div>
    </div>
  )
}

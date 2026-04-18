import { useCallback, useEffect, useRef, useState } from 'react'
import { FolderOpen, Loader2, Sparkles, X } from 'lucide-react'
import iconUrl from '../../../resources/icon.png'

type GitignorePreset = 'none' | 'node' | 'python' | 'macos'

const LAST_PARENT_DIR_KEY = 'harness:newProjectLastParentDir'

interface NewProjectScreenProps {
  onCancel: () => void
  onCreated: (path: string) => void
}

const NAME_INVALID_CHAR_RE = /[\\/:*?"<>|]/
function validateName(name: string): string | null {
  const trimmed = name.trim()
  if (!trimmed) return null
  if (NAME_INVALID_CHAR_RE.test(trimmed)) return 'Name contains invalid characters'
  if (trimmed === '.' || trimmed === '..') return 'Invalid name'
  return null
}

const GITIGNORE_OPTIONS: { id: GitignorePreset; label: string; hint: string }[] = [
  { id: 'macos', label: 'macOS', hint: '.DS_Store and friends' },
  { id: 'node', label: 'Node', hint: 'node_modules, dist, .env' },
  { id: 'python', label: 'Python', hint: '__pycache__, venv, dist' },
  { id: 'none', label: 'None', hint: 'Skip the file' }
]

export function NewProjectScreen({ onCancel, onCreated }: NewProjectScreenProps): JSX.Element {
  const [name, setName] = useState('')
  const [parentDir, setParentDir] = useState<string>(
    () => localStorage.getItem(LAST_PARENT_DIR_KEY) ?? ''
  )
  const [includeReadme, setIncludeReadme] = useState(true)
  const [gitignorePreset, setGitignorePreset] = useState<GitignorePreset>('macos')
  const [serverError, setServerError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const nameInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    nameInputRef.current?.focus()
  }, [])

  const trimmedName = name.trim()
  const nameError = validateName(name)
  const fullPath = parentDir && trimmedName ? `${parentDir}/${trimmedName}` : ''
  const canSubmit = !submitting && !!trimmedName && !nameError && !!parentDir

  const handlePickLocation = useCallback(async () => {
    const picked = await window.api.pickDirectory({
      defaultPath: parentDir || undefined,
      title: 'Choose parent folder'
    })
    if (picked) {
      setParentDir(picked)
      localStorage.setItem(LAST_PARENT_DIR_KEY, picked)
    }
  }, [parentDir])

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return
    setServerError(null)
    setSubmitting(true)
    try {
      const result = await window.api.createNewProject({
        parentDir,
        name: trimmedName,
        includeReadme,
        gitignorePreset
      })
      if ('error' in result) {
        setServerError(result.error)
        setSubmitting(false)
        return
      }
      localStorage.setItem(LAST_PARENT_DIR_KEY, parentDir)
      onCreated(result.path)
    } catch (e) {
      setServerError(e instanceof Error ? e.message : String(e))
      setSubmitting(false)
    }
  }, [canSubmit, parentDir, trimmedName, includeReadme, gitignorePreset, onCreated])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        void handleSubmit()
      }
      if (e.key === 'Escape' && !submitting) {
        e.preventDefault()
        onCancel()
      }
    },
    [handleSubmit, onCancel, submitting]
  )

  return (
    <div
      className="flex-1 flex flex-col min-w-0 bg-app brand-grid-bg relative h-full"
      onKeyDown={handleKeyDown}
    >
      <div className="drag-region h-10 shrink-0 flex items-center justify-end pr-2">
        <button
          onClick={onCancel}
          title="Close (Esc)"
          disabled={submitting}
          className="no-drag text-dim hover:text-fg p-1.5 rounded transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
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
              New <span className="brand-gradient-text">project</span>
            </h1>
            <p className="text-muted text-base">
              Scaffold a fresh folder with git, a README, and a first commit.
            </p>
          </div>

          <div className="bg-panel/80 backdrop-blur border border-border rounded-2xl p-6 shadow-xl">
            <label className="block">
              <div className="mb-2">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-dim">
                  Project name
                </span>
              </div>
              <input
                ref={nameInputRef}
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="my-project"
                disabled={submitting}
                autoComplete="off"
                spellCheck={false}
                style={{ fontSize: '13px' }}
                className={`w-full bg-app border-2 rounded-lg px-3 py-2.5 font-mono text-fg-bright placeholder-faint outline-none transition-colors ${
                  nameError
                    ? 'border-danger focus:border-danger'
                    : 'border-border-strong focus:border-accent'
                }`}
              />
              {nameError && (
                <div className="mt-2 text-[11px] text-danger">{nameError}</div>
              )}
            </label>

            <div className="mt-5">
              <div className="mb-2">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-dim">
                  Parent folder
                </span>
              </div>
              <div className="flex items-stretch gap-2">
                <div className="flex-1 min-w-0 bg-app border-2 border-border-strong rounded-lg px-3 py-2.5 text-sm text-fg font-mono truncate">
                  {parentDir || <span className="text-faint">No folder selected</span>}
                </div>
                <button
                  type="button"
                  onClick={handlePickLocation}
                  disabled={submitting}
                  className="flex items-center gap-1.5 px-3 py-2.5 rounded-lg border-2 border-border-strong bg-app hover:border-accent text-sm text-fg transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <FolderOpen size={14} />
                  Browse…
                </button>
              </div>
              {fullPath && !nameError && (
                <div className="mt-2 text-[11px] text-dim leading-snug">
                  Will create: <span className="font-mono text-fg">{fullPath}</span>
                </div>
              )}
            </div>

            <div className="mt-5 flex items-center gap-2">
              <input
                id="include-readme"
                type="checkbox"
                checked={includeReadme}
                onChange={(e) => setIncludeReadme(e.target.checked)}
                className="accent-accent w-4 h-4 cursor-pointer"
                disabled={submitting}
              />
              <label htmlFor="include-readme" className="text-sm text-fg cursor-pointer">
                Include <code className="text-xs text-fg-bright font-mono">README.md</code>
              </label>
            </div>

            <div className="mt-5">
              <div className="mb-2">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-dim">
                  Gitignore preset
                </span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {GITIGNORE_OPTIONS.map((opt) => {
                  const active = gitignorePreset === opt.id
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => setGitignorePreset(opt.id)}
                      disabled={submitting}
                      className={`text-left rounded-lg border px-3 py-2 transition-colors cursor-pointer ${
                        active
                          ? 'bg-panel border-accent text-fg-bright shadow-sm'
                          : 'bg-app/60 border-border text-dim hover:text-fg hover:border-border-strong'
                      }`}
                    >
                      <div className="text-xs font-semibold">{opt.label}</div>
                      <div className="text-[10px] text-dim mt-0.5 truncate">{opt.hint}</div>
                    </button>
                  )
                })}
              </div>
            </div>

            {serverError && (
              <div className="mt-4 text-sm text-danger bg-danger/10 border border-danger/30 rounded-lg px-3 py-2">
                {serverError}
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
                  className="px-4 py-2 text-sm text-dim hover:text-fg transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Cancel
                </button>
                <button
                  onClick={() => void handleSubmit()}
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
                      Create project
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

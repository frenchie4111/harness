import { useEffect, useRef, useState } from 'react'
import { FolderOpen, Loader2 } from 'lucide-react'

type GitignorePreset = 'none' | 'node' | 'python' | 'macos'

const LAST_PARENT_DIR_KEY = 'harness:newProjectLastParentDir'

interface NewProjectModalProps {
  onClose: () => void
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

export function NewProjectModal({ onClose, onCreated }: NewProjectModalProps): JSX.Element {
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

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !submitting) {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose, submitting])

  const trimmedName = name.trim()
  const nameError = validateName(name)
  const fullPath = parentDir && trimmedName ? `${parentDir}/${trimmedName}` : ''
  const canSubmit =
    !submitting && !!trimmedName && !nameError && !!parentDir

  const handlePickLocation = async (): Promise<void> => {
    const picked = await window.api.pickDirectory({
      defaultPath: parentDir || undefined,
      title: 'Choose parent folder'
    })
    if (picked) {
      setParentDir(picked)
      localStorage.setItem(LAST_PARENT_DIR_KEY, picked)
    }
  }

  const handleSubmit = async (): Promise<void> => {
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
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center pt-[12vh]"
      onClick={submitting ? undefined : onClose}
    >
      <div
        className="w-full max-w-xl bg-surface rounded-xl shadow-2xl border border-border overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-border">
          <h2 className="text-sm font-semibold text-fg-bright">Start a new project</h2>
          <kbd className="text-[10px] text-faint bg-bg px-1.5 py-0.5 rounded border border-border font-mono">
            ESC
          </kbd>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault()
            void handleSubmit()
          }}
          className="px-5 py-4 space-y-4"
        >
          <div>
            <label className="block text-xs font-medium text-fg-bright mb-1.5">
              Project name
            </label>
            <input
              ref={nameInputRef}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-project"
              className="w-full bg-app border border-border rounded-md px-3 py-2 text-sm text-fg-bright font-mono focus:outline-none focus:border-accent"
              disabled={submitting}
            />
            {nameError && (
              <div className="mt-1 text-[11px] text-danger">{nameError}</div>
            )}
          </div>

          <div>
            <label className="block text-xs font-medium text-fg-bright mb-1.5">
              Location
            </label>
            <div className="flex items-stretch gap-2">
              <div className="flex-1 min-w-0 bg-app border border-border rounded-md px-3 py-2 text-sm text-fg font-mono truncate">
                {parentDir || <span className="text-dim">No folder selected</span>}
              </div>
              <button
                type="button"
                onClick={handlePickLocation}
                className="flex items-center gap-1.5 px-3 py-2 rounded-md border border-border bg-panel hover:border-border-strong text-sm text-fg transition-colors cursor-pointer"
                disabled={submitting}
              >
                <FolderOpen size={14} />
                Browse…
              </button>
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-fg-bright mb-1.5">
              Full path
            </label>
            <div
              className={`w-full bg-app/50 border border-border rounded-md px-3 py-2 text-sm font-mono truncate ${
                fullPath && !nameError ? 'text-fg-bright' : 'text-dim'
              }`}
            >
              {fullPath || '—'}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <input
              id="include-readme"
              type="checkbox"
              checked={includeReadme}
              onChange={(e) => setIncludeReadme(e.target.checked)}
              className="accent-accent"
              disabled={submitting}
            />
            <label htmlFor="include-readme" className="text-sm text-fg cursor-pointer">
              Include <code className="text-xs text-fg-bright">README.md</code>
            </label>
          </div>

          <div>
            <label className="block text-xs font-medium text-fg-bright mb-1.5">
              Gitignore
            </label>
            <div className="grid grid-cols-4 gap-1.5">
              {(
                [
                  { id: 'none', label: 'None' },
                  { id: 'macos', label: 'macOS' },
                  { id: 'node', label: 'Node' },
                  { id: 'python', label: 'Python' }
                ] as { id: GitignorePreset; label: string }[]
              ).map((opt) => {
                const active = gitignorePreset === opt.id
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => setGitignorePreset(opt.id)}
                    disabled={submitting}
                    className={`px-2 py-1.5 rounded-md border text-xs transition-colors cursor-pointer ${
                      active
                        ? 'bg-surface text-fg-bright border-fg'
                        : 'bg-panel border-border text-dim hover:text-fg hover:border-border-strong'
                    }`}
                  >
                    {opt.label}
                  </button>
                )
              })}
            </div>
          </div>

          {serverError && (
            <div className="text-[12px] text-danger bg-danger/10 border border-danger/30 rounded-md px-3 py-2">
              {serverError}
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="px-3 py-2 rounded-md text-sm text-dim hover:text-fg transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!canSubmit}
              className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors cursor-pointer ${
                canSubmit
                  ? 'bg-accent/20 hover:bg-accent/30 border border-accent/40 text-fg-bright'
                  : 'bg-panel border border-border text-dim cursor-not-allowed'
              }`}
            >
              {submitting && <Loader2 size={14} className="animate-spin" />}
              Create project
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

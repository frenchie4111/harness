import { useState, useEffect, useCallback, useRef } from 'react'
import { ArrowLeft, Check, X, Eye, EyeOff, Star, RefreshCw, Download, RotateCw, GitPullRequest, DownloadCloud, Keyboard, RotateCcw, Terminal as TerminalIcon, Palette, BookOpen, Code2, GitBranch } from 'lucide-react'
import type { UpdaterStatus, MergeStrategy } from '../types'
import { DEFAULT_HOTKEYS, ACTION_LABELS, bindingToString, eventToBinding, resolveHotkeys, type Action, type HotkeyBinding } from '../hotkeys'
import { Tooltip } from './Tooltip'

interface SettingsProps {
  onClose: () => void
  onOpenGuide: () => void
  initialSection?: SectionId
}

type SectionId = 'appearance' | 'claude' | 'worktrees' | 'editor' | 'github' | 'hotkeys' | 'updates'

interface Section {
  id: SectionId
  label: string
  icon: React.ComponentType<{ size?: number; className?: string }>
}

const SECTIONS: Section[] = [
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'claude', label: 'Claude', icon: TerminalIcon },
  { id: 'worktrees', label: 'Worktrees', icon: GitBranch },
  { id: 'editor', label: 'Editor', icon: Code2 },
  { id: 'github', label: 'GitHub', icon: GitPullRequest },
  { id: 'hotkeys', label: 'Hotkeys', icon: Keyboard },
  { id: 'updates', label: 'Updates', icon: DownloadCloud }
]

const THEME_OPTIONS: { id: string; label: string; description: string; swatches: string[] }[] = [
  {
    id: 'dark',
    label: 'Dark',
    description: 'Neutral dark \u2014 the default Harness look.',
    swatches: ['#0a0a0a', '#262626', '#d4d4d4', '#22c55e']
  },
  {
    id: 'dracula',
    label: 'Dracula',
    description: 'The iconic purple-tinted dark theme.',
    swatches: ['#282a36', '#44475a', '#f8f8f2', '#bd93f9']
  },
  {
    id: 'nord',
    label: 'Nord',
    description: 'Arctic, north-bluish clean and elegant.',
    swatches: ['#2e3440', '#434c5e', '#d8dee9', '#88c0d0']
  },
  {
    id: 'gruvbox-dark',
    label: 'Gruvbox Dark',
    description: 'Retro groove warm earth tones.',
    swatches: ['#282828', '#3c3836', '#ebdbb2', '#fabd2f']
  },
  {
    id: 'tokyo-night',
    label: 'Tokyo Night',
    description: 'Inspired by the neon lights of downtown Tokyo.',
    swatches: ['#1a1b26', '#292e42', '#c0caf5', '#7aa2f7']
  },
  {
    id: 'catppuccin-mocha',
    label: 'Catppuccin Mocha',
    description: 'Soothing pastel theme, mocha flavor.',
    swatches: ['#1e1e2e', '#313244', '#cdd6f4', '#cba6f7']
  },
  {
    id: 'one-dark',
    label: 'One Dark',
    description: 'Atom\u2019s classic dark theme.',
    swatches: ['#282c34', '#3e4451', '#abb2bf', '#61afef']
  },
  {
    id: 'solarized-dark',
    label: 'Solarized Dark',
    description: 'Ethan Schoonover\u2019s classic low-contrast dark palette.',
    swatches: ['#002b36', '#073642', '#93a1a1', '#268bd2']
  },
  {
    id: 'solarized-light',
    label: 'Solarized Light',
    description: 'The light half of Solarized \u2014 easy on the eyes in daylight.',
    swatches: ['#fdf6e3', '#eee8d5', '#657b83', '#268bd2']
  }
]

export function Settings({ onClose, onOpenGuide, initialSection }: SettingsProps): JSX.Element {
  const [activeSection, setActiveSection] = useState<SectionId>(initialSection ?? 'appearance')
  const scrollRef = useRef<HTMLDivElement>(null)
  const sectionRefs = useRef<Record<SectionId, HTMLElement | null>>({
    appearance: null,
    claude: null,
    worktrees: null,
    editor: null,
    github: null,
    hotkeys: null,
    updates: null
  })

  // Scroll to a section when the sidebar item is clicked
  const scrollToSection = useCallback((id: SectionId) => {
    setActiveSection(id)
    const el = sectionRefs.current[id]
    if (el && scrollRef.current) {
      scrollRef.current.scrollTo({ top: el.offsetTop - 24, behavior: 'smooth' })
    }
  }, [])

  // Honor `initialSection` once the section refs are wired up.
  useEffect(() => {
    if (!initialSection) return
    const el = sectionRefs.current[initialSection]
    if (el && scrollRef.current) {
      scrollRef.current.scrollTo({ top: el.offsetTop - 24 })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Update active section based on scroll position
  useEffect(() => {
    const container = scrollRef.current
    if (!container) return

    const onScroll = (): void => {
      const scrollTop = container.scrollTop
      let current: SectionId = 'appearance'
      for (const section of SECTIONS) {
        const el = sectionRefs.current[section.id]
        if (el && el.offsetTop - 48 <= scrollTop) {
          current = section.id
        }
      }
      setActiveSection(current)
    }

    container.addEventListener('scroll', onScroll)
    return () => container.removeEventListener('scroll', onScroll)
  }, [])

  // GitHub state
  const [token, setToken] = useState('')
  const [hasToken, setHasToken] = useState(false)
  const [showToken, setShowToken] = useState(false)
  const [saving, setSaving] = useState(false)
  const [autoStar, setAutoStar] = useState(true)
  const [tokenResult, setTokenResult] = useState<{ ok: boolean; message: string } | null>(null)

  // Updates state
  const [version, setVersion] = useState<string>('')
  const [updaterStatus, setUpdaterStatus] = useState<UpdaterStatus | null>(null)
  const [checking, setChecking] = useState(false)

  // Hotkeys state
  const [hotkeyOverrides, setHotkeyOverrides] = useState<Record<string, string> | null>(null)
  const [rebindingAction, setRebindingAction] = useState<Action | null>(null)

  // Claude command state
  const [claudeCommand, setClaudeCommand] = useState<string>('')
  const [defaultClaudeCommand, setDefaultClaudeCommand] = useState<string>('')
  const [claudeSaveResult, setClaudeSaveResult] = useState<{ ok: boolean; message: string } | null>(null)

  // Theme state
  const [theme, setThemeState] = useState<string>('dark')

  // Editor state
  const [editorId, setEditorId] = useState<string>('vscode')
  const [availableEditors, setAvailableEditors] = useState<{ id: string; name: string }[]>([])

  // Worktree base state
  const [worktreeBase, setWorktreeBaseState] = useState<'remote' | 'local'>('remote')
  const [mergeStrategy, setMergeStrategyState] = useState<MergeStrategy>('squash')

  useEffect(() => {
    window.api.hasGithubToken().then(setHasToken)
    window.api.getVersion().then(setVersion)
    window.api.getHotkeyOverrides().then((v) => setHotkeyOverrides(v))
    window.api.getClaudeCommand().then(setClaudeCommand)
    window.api.getDefaultClaudeCommand().then(setDefaultClaudeCommand)
    window.api.getTheme().then(setThemeState)
    window.api.getEditor().then(setEditorId)
    window.api.getAvailableEditors().then(setAvailableEditors)
    window.api.getWorktreeBase().then(setWorktreeBaseState)
    window.api.getMergeStrategy().then(setMergeStrategyState)
  }, [])

  const handleSelectTheme = useCallback(async (id: string) => {
    setThemeState(id)
    await window.api.setTheme(id)
  }, [])

  const handleSelectEditor = useCallback(async (id: string) => {
    setEditorId(id)
    await window.api.setEditor(id)
  }, [])

  const handleSelectWorktreeBase = useCallback(async (mode: 'remote' | 'local') => {
    setWorktreeBaseState(mode)
    await window.api.setWorktreeBase(mode)
  }, [])

  const handleSelectMergeStrategy = useCallback(async (strategy: MergeStrategy) => {
    setMergeStrategyState(strategy)
    await window.api.setMergeStrategy(strategy)
  }, [])

  useEffect(() => {
    const cleanup = window.api.onUpdaterStatus((status) => setUpdaterStatus(status))
    return cleanup
  }, [])

  const handleSave = useCallback(async () => {
    setSaving(true)
    setTokenResult(null)
    try {
      const res = await window.api.setGithubToken(token, { starRepo: autoStar })
      if (res.ok) {
        let message = res.username ? `Connected as @${res.username}` : 'Token saved'
        if (autoStar && res.starred) message += ' · starred Harness on GitHub'
        setTokenResult({ ok: true, message })
        setHasToken(true)
        setToken('')
      } else {
        setTokenResult({ ok: false, message: `Invalid token: ${res.error || 'unknown error'}` })
      }
    } finally {
      setSaving(false)
    }
  }, [token, autoStar])

  const handleClear = useCallback(async () => {
    await window.api.clearGithubToken()
    setHasToken(false)
    setTokenResult({ ok: true, message: 'Token removed' })
  }, [])

  const handleCheckForUpdates = useCallback(async () => {
    setChecking(true)
    try {
      const res = await window.api.checkForUpdates()
      if (!res.ok) {
        setUpdaterStatus({ state: 'error', error: res.error || 'unknown error' })
      } else if (!res.available) {
        setUpdaterStatus({ state: 'not-available' })
      }
    } finally {
      setChecking(false)
    }
  }, [])

  const handleRestart = useCallback(() => {
    window.api.quitAndInstall()
  }, [])

  // Capture a key press while rebinding
  useEffect(() => {
    if (!rebindingAction) return

    const handler = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()

      if (e.key === 'Escape') {
        setRebindingAction(null)
        return
      }

      const binding = eventToBinding(e)
      if (!binding) return // ignore pure modifier presses

      const shortcut = bindingToString(binding)
      const next = { ...(hotkeyOverrides || {}), [rebindingAction]: shortcut }
      setHotkeyOverrides(next)
      void window.api.setHotkeyOverrides(next)
      setRebindingAction(null)
    }

    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [rebindingAction, hotkeyOverrides])

  const resolvedHotkeys = resolveHotkeys(hotkeyOverrides || undefined)

  const handleResetHotkey = useCallback(async (action: Action) => {
    const next = { ...(hotkeyOverrides || {}) }
    delete next[action]
    setHotkeyOverrides(next)
    await window.api.setHotkeyOverrides(next)
  }, [hotkeyOverrides])

  const handleResetAllHotkeys = useCallback(async () => {
    setHotkeyOverrides(null)
    await window.api.resetHotkeyOverrides()
  }, [])

  const handleSaveClaudeCommand = useCallback(async () => {
    setClaudeSaveResult(null)
    await window.api.setClaudeCommand(claudeCommand)
    setClaudeSaveResult({ ok: true, message: 'Saved · new tabs will use this command' })
  }, [claudeCommand])

  const handleResetClaudeCommand = useCallback(async () => {
    setClaudeCommand(defaultClaudeCommand)
    await window.api.setClaudeCommand(defaultClaudeCommand)
    setClaudeSaveResult({ ok: true, message: 'Reset to default' })
  }, [defaultClaudeCommand])

  const isOverridden = (action: Action): boolean => {
    if (!hotkeyOverrides || !(action in hotkeyOverrides)) return false
    const defaultStr = bindingToString(DEFAULT_HOTKEYS[action])
    return hotkeyOverrides[action] !== defaultStr
  }

  const renderUpdaterStatus = (): JSX.Element | null => {
    if (!updaterStatus) return null
    switch (updaterStatus.state) {
      case 'checking':
        return (
          <div className="flex items-center gap-2 text-xs text-muted">
            <RefreshCw size={12} className="animate-spin" />
            Checking for updates...
          </div>
        )
      case 'not-available':
        return (
          <div className="flex items-center gap-2 text-xs text-success">
            <Check size={12} />
            You&apos;re up to date
          </div>
        )
      case 'available':
        return (
          <div className="flex items-center gap-2 text-xs text-warning">
            <Download size={12} />
            Version {updaterStatus.version} available — downloading...
          </div>
        )
      case 'downloading':
        return (
          <div className="flex items-center gap-2 text-xs text-warning">
            <Download size={12} />
            Downloading update... {Math.round(updaterStatus.percent)}%
          </div>
        )
      case 'downloaded':
        return (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2 text-xs text-success">
              <Check size={12} />
              Version {updaterStatus.version} ready to install
            </div>
            <button
              onClick={handleRestart}
              className="self-start flex items-center gap-1.5 px-3 py-1.5 bg-success/20 hover:bg-success/30 rounded text-xs text-success transition-colors cursor-pointer"
            >
              <RotateCw size={12} />
              Restart &amp; install
            </button>
          </div>
        )
      case 'error':
        return (
          <div className="flex items-center gap-2 text-xs text-danger">
            <X size={12} />
            {updaterStatus.error}
          </div>
        )
    }
  }

  return (
    <div className="flex flex-col h-full bg-panel">
      {/* Title bar (drag region) */}
      <div className="drag-region h-10 shrink-0 border-b border-border relative">
        <button
          onClick={onClose}
          className="no-drag absolute left-20 top-1/2 -translate-y-1/2 flex items-center gap-1.5 text-xs text-muted hover:text-fg-bright transition-colors cursor-pointer"
        >
          <ArrowLeft size={14} />
          Back
        </button>
        <span className="absolute left-1/2 -translate-x-1/2 top-1/2 -translate-y-1/2 text-sm font-medium text-fg pointer-events-none">
          Settings
        </span>
      </div>

      <div className="flex flex-1 min-h-0">
        {/* Left sidebar */}
        <div className="w-56 border-r border-border bg-panel flex flex-col shrink-0">
          <div className="px-3 py-2">
            <span className="text-xs font-medium text-dim">SECTIONS</span>
          </div>
          {SECTIONS.map((section) => {
            const Icon = section.icon
            const isActive = activeSection === section.id
            const needsAttention = section.id === 'github' && !hasToken
            const className = needsAttention
              ? `flex items-center gap-2 px-3 py-2 text-left text-sm transition-colors cursor-pointer ${
                  isActive ? 'bg-info/25 text-info' : 'bg-info/10 text-info hover:bg-info/20'
                }`
              : `flex items-center gap-2 px-3 py-2 text-left text-sm transition-colors cursor-pointer ${
                  isActive
                    ? 'bg-surface text-fg-bright'
                    : 'text-muted hover:bg-panel-raised hover:text-fg-bright'
                }`
            return (
              <button
                key={section.id}
                onClick={() => scrollToSection(section.id)}
                className={className}
              >
                <Icon size={14} className="shrink-0" />
                <span>{section.label}</span>
              </button>
            )
          })}

          <div className="mt-auto border-t border-border px-3 py-2">
            <span className="text-xs font-medium text-dim">HELP</span>
          </div>
          <button
            onClick={onOpenGuide}
            className="flex items-center gap-2 px-3 py-2 text-left text-sm text-muted hover:bg-panel-raised hover:text-fg-bright transition-colors cursor-pointer"
          >
            <BookOpen size={14} className="shrink-0" />
            <span>Worktree Guide</span>
          </button>
        </div>

        {/* Main scrollable content */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto">
          <div className="max-w-2xl p-8 space-y-12">
            {/* Appearance section */}
            <section ref={(el) => { sectionRefs.current.appearance = el }} id="appearance">
              <h2 className="text-lg font-semibold text-fg-bright mb-1">Appearance</h2>
              <p className="text-sm text-dim mb-4">
                Pick a color theme for the major panels. Takes effect immediately.
              </p>

              <div className="bg-panel-raised border border-border rounded-lg divide-y divide-border">
                {THEME_OPTIONS.map((opt) => {
                  const isActive = theme === opt.id
                  return (
                    <button
                      key={opt.id}
                      onClick={() => handleSelectTheme(opt.id)}
                      className={`w-full flex items-center gap-3 px-4 py-3 text-left transition-colors cursor-pointer ${
                        isActive ? 'bg-surface' : 'hover:bg-surface/60'
                      }`}
                    >
                      <div className="flex gap-1 shrink-0">
                        {opt.swatches.map((c) => (
                          <span
                            key={c}
                            className="w-4 h-4 rounded border border-border-strong"
                            style={{ backgroundColor: c }}
                          />
                        ))}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-fg">{opt.label}</div>
                        <div className="text-xs text-dim truncate">{opt.description}</div>
                      </div>
                      {isActive && <Check size={14} className="text-success shrink-0" />}
                    </button>
                  )
                })}
              </div>
            </section>

            {/* Claude section */}
            <section ref={(el) => { sectionRefs.current.claude = el }} id="claude">
              <h2 className="text-lg font-semibold text-fg-bright mb-1">Claude</h2>
              <p className="text-sm text-dim mb-4">
                The shell command run inside each Claude tab. The command is executed via{' '}
                <code className="bg-panel-raised px-1 rounded text-xs">/bin/zsh -ilc</code>{' '}
                so your full PATH and shell config are available.
              </p>

              <div className="bg-panel-raised border border-border rounded-lg p-4">
                <label className="block text-sm font-medium text-fg mb-1">
                  Launch command
                </label>
                <p className="text-xs text-dim mb-2">
                  Harness appends <code className="bg-panel px-1 rounded">--session-id &lt;uuid&gt;</code> to this command so each tab has its own stable, resumable Claude session.
                </p>
                <textarea
                  value={claudeCommand}
                  onChange={(e) => setClaudeCommand(e.target.value)}
                  rows={3}
                  spellCheck={false}
                  className="w-full bg-panel border border-border-strong rounded px-3 py-2 text-xs text-fg-bright placeholder-faint outline-none focus:border-fg font-mono resize-y"
                  placeholder={defaultClaudeCommand}
                />

                <div className="flex items-center gap-2 mt-3">
                  <button
                    onClick={handleSaveClaudeCommand}
                    disabled={!claudeCommand.trim()}
                    className="px-3 py-1.5 bg-surface hover:bg-surface-hover disabled:opacity-40 rounded text-sm text-fg-bright transition-colors cursor-pointer"
                  >
                    Save
                  </button>
                  {claudeCommand !== defaultClaudeCommand && defaultClaudeCommand && (
                    <button
                      onClick={handleResetClaudeCommand}
                      className="flex items-center gap-1 px-3 py-1.5 text-sm text-dim hover:text-fg transition-colors cursor-pointer"
                    >
                      <RotateCcw size={12} />
                      Reset to default
                    </button>
                  )}
                </div>

                {claudeSaveResult && (
                  <div className={`mt-3 text-xs flex items-center gap-1.5 ${claudeSaveResult.ok ? 'text-success' : 'text-danger'}`}>
                    {claudeSaveResult.ok ? <Check size={12} /> : <X size={12} />}
                    {claudeSaveResult.message}
                  </div>
                )}
              </div>

              <div className="mt-4 text-xs text-dim space-y-2">
                <p>
                  Default: <code className="bg-panel-raised px-1 rounded text-[10px] break-all">{defaultClaudeCommand}</code>
                </p>
                <p>
                  Common variations:{' '}
                  <code className="bg-panel-raised px-1 rounded text-[10px]">claude --model opus-4</code>,{' '}
                  <code className="bg-panel-raised px-1 rounded text-[10px]">claude --dangerously-skip-permissions</code>
                </p>
                <p className="text-faint">
                  Note: changes apply to newly created Claude tabs. Existing terminals are unaffected.
                </p>
              </div>
            </section>

            {/* Worktrees section */}
            <section ref={(el) => { sectionRefs.current.worktrees = el }} id="worktrees">
              <h2 className="text-lg font-semibold text-fg-bright mb-1">Worktrees</h2>
              <p className="text-sm text-dim mb-4">
                Controls how new worktrees are created from the sidebar.
              </p>
              <div className="space-y-2">
                {(
                  [
                    {
                      id: 'remote' as const,
                      label: 'Branch from the latest remote main',
                      description:
                        'Fetches origin before creating the worktree so you start from the tip of the remote default branch. Falls back to local HEAD if the fetch fails (e.g. offline).'
                    },
                    {
                      id: 'local' as const,
                      label: 'Branch from the current local HEAD',
                      description:
                        "Uses whatever is checked out in the main repo right now. Fastest, but you'll inherit any stale local main or unpushed commits."
                    }
                  ]
                ).map((opt) => {
                  const isActive = worktreeBase === opt.id
                  return (
                    <button
                      key={opt.id}
                      onClick={() => handleSelectWorktreeBase(opt.id)}
                      className={`w-full text-left rounded border px-3 py-2 transition-colors cursor-pointer ${
                        isActive
                          ? 'border-accent bg-panel-raised'
                          : 'border-border hover:border-border-strong'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <div
                          className={`w-3 h-3 rounded-full border ${
                            isActive ? 'border-accent bg-accent' : 'border-border-strong'
                          }`}
                        />
                        <span className="text-sm text-fg-bright">{opt.label}</span>
                      </div>
                      <p className="text-xs text-dim mt-1 ml-5">{opt.description}</p>
                    </button>
                  )
                })}
              </div>

              <h3 className="text-sm font-semibold text-fg-bright mt-6 mb-1">Default merge strategy</h3>
              <p className="text-xs text-dim mb-3">
                Used when you run "Merge locally" on a worktree. The dropdown on
                that button also writes back to this setting so your most recent
                choice becomes the new default.
              </p>
              <div className="space-y-2">
                {(
                  [
                    {
                      id: 'squash' as const,
                      label: 'Squash',
                      description:
                        "Combine all branch commits into one commit on the base branch. GitHub's \"Squash and merge\"."
                    },
                    {
                      id: 'merge-commit' as const,
                      label: 'Merge commit',
                      description:
                        'Always create a merge commit (--no-ff), preserving the branch as a visible bubble in history.'
                    },
                    {
                      id: 'fast-forward' as const,
                      label: 'Fast-forward only',
                      description:
                        'Only merge if the base can fast-forward (--ff-only). Fails on divergent history.'
                    }
                  ]
                ).map((opt) => {
                  const isActive = mergeStrategy === opt.id
                  return (
                    <button
                      key={opt.id}
                      onClick={() => handleSelectMergeStrategy(opt.id)}
                      className={`w-full text-left rounded border px-3 py-2 transition-colors cursor-pointer ${
                        isActive
                          ? 'border-accent bg-panel-raised'
                          : 'border-border hover:border-border-strong'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <div
                          className={`w-3 h-3 rounded-full border ${
                            isActive ? 'border-accent bg-accent' : 'border-border-strong'
                          }`}
                        />
                        <span className="text-sm text-fg-bright">{opt.label}</span>
                      </div>
                      <p className="text-xs text-dim mt-1 ml-5">{opt.description}</p>
                    </button>
                  )
                })}
              </div>
            </section>

            {/* Editor section */}
            <section ref={(el) => { sectionRefs.current.editor = el }} id="editor">
              <h2 className="text-lg font-semibold text-fg-bright mb-1">Editor</h2>
              <p className="text-sm text-dim mb-4">
                Your preferred code editor. Harness uses this when you click
                "Open in editor" on a worktree, or click the edit icon on a
                changed file. The editor's CLI must be installed and on your
                shell PATH.
              </p>
              <div className="grid grid-cols-2 gap-2 mb-3">
                {availableEditors.map((ed) => {
                  const isActive = editorId === ed.id
                  return (
                    <button
                      key={ed.id}
                      onClick={() => handleSelectEditor(ed.id)}
                      className={`flex items-center gap-2 text-left rounded border px-3 py-2 text-sm transition-colors cursor-pointer ${
                        isActive
                          ? 'border-accent bg-panel-raised text-fg-bright'
                          : 'border-border hover:border-border-strong text-muted hover:text-fg'
                      }`}
                    >
                      <Code2 size={14} className={isActive ? 'text-accent' : 'text-faint'} />
                      <span className="flex-1">{ed.name}</span>
                      {isActive && <Check size={12} className="text-accent" />}
                    </button>
                  )
                })}
              </div>
              <p className="text-[11px] text-faint">
                Harness spawns the editor via a login shell (<code className="bg-panel-raised px-1 rounded text-[10px]">zsh -ilc</code>)
                so homebrew and nvm paths are picked up automatically. If nothing
                happens when you click "Open in editor", check that the selected
                editor's CLI is installed (e.g. VS Code's{' '}
                <code className="bg-panel-raised px-1 rounded text-[10px]">code</code> command,
                installed via <em>Shell Command: Install 'code' command in PATH</em> from
                the command palette).
              </p>
            </section>

            {/* GitHub section */}
            <section ref={(el) => { sectionRefs.current.github = el }} id="github">
              <h2 className={`text-lg font-semibold mb-1 ${!hasToken ? 'text-info' : 'text-fg-bright'}`}>GitHub</h2>
              <p className={`text-sm mb-4 ${!hasToken ? 'text-info/80' : 'text-dim'}`}>
                Harness uses a personal access token to fetch PR status and check results.
                The token is encrypted and stored locally using your macOS keychain.
              </p>

              <div className={`rounded-lg p-4 border ${!hasToken ? 'bg-info/10 border-info/30' : 'bg-panel-raised border-border'}`}>
                <label className="block text-sm font-medium text-fg mb-2">
                  Personal Access Token
                </label>

                {hasToken && (
                  <div className="flex items-center gap-2 mb-3 text-xs text-success">
                    <Check size={14} />
                    <span>A token is currently saved</span>
                  </div>
                )}

                <label className="flex items-center gap-2 mb-3 cursor-pointer group">
                  <input
                    type="checkbox"
                    checked={autoStar}
                    onChange={(e) => setAutoStar(e.target.checked)}
                    className="w-3.5 h-3.5 accent-warning cursor-pointer"
                  />
                  <Star size={12} className="text-warning shrink-0" />
                  <span className="text-xs text-muted group-hover:text-fg transition-colors">
                    Automatically star Harness on GitHub
                  </span>
                </label>

                <div className="relative mb-3">
                  <input
                    type={showToken ? 'text' : 'password'}
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    placeholder={hasToken ? 'Enter a new token to replace the existing one' : 'ghp_... or github_pat_...'}
                    className="w-full bg-panel border border-border-strong rounded px-3 py-2 pr-10 text-sm text-fg-bright placeholder-faint outline-none focus:border-fg font-mono"
                  />
                  <button
                    onClick={() => setShowToken(!showToken)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-dim hover:text-fg transition-colors cursor-pointer"
                  >
                    {showToken ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    onClick={handleSave}
                    disabled={saving || !token.trim()}
                    className="px-3 py-1.5 bg-surface hover:bg-surface-hover disabled:opacity-40 rounded text-sm text-fg-bright transition-colors cursor-pointer"
                  >
                    {saving ? 'Validating...' : 'Save'}
                  </button>
                  {hasToken && (
                    <button
                      onClick={handleClear}
                      className="px-3 py-1.5 text-sm text-danger hover:text-danger transition-colors cursor-pointer"
                    >
                      Remove
                    </button>
                  )}
                </div>

                {tokenResult && (
                  <div className={`mt-3 text-xs flex items-center gap-1.5 ${tokenResult.ok ? 'text-success' : 'text-danger'}`}>
                    {tokenResult.ok ? <Check size={12} /> : <X size={12} />}
                    {tokenResult.message}
                  </div>
                )}
              </div>

              <div className="mt-4 text-xs text-dim space-y-2">
                <p>
                  Create a token at{' '}
                  <a
                    onClick={() => window.api.openExternal('https://github.com/settings/tokens?type=beta')}
                    className="text-muted hover:text-fg-bright underline cursor-pointer"
                  >
                    github.com/settings/tokens
                  </a>
                  {' '}(fine-grained) or{' '}
                  <a
                    onClick={() => window.api.openExternal('https://github.com/settings/tokens')}
                    className="text-muted hover:text-fg-bright underline cursor-pointer"
                  >
                    classic tokens
                  </a>
                  .
                </p>
                <p>
                  Required scopes: <code className="bg-panel-raised px-1 rounded">repo</code> for private repos,
                  or <code className="bg-panel-raised px-1 rounded">public_repo</code> for public only.
                </p>
              </div>
            </section>

            {/* Hotkeys section */}
            <section ref={(el) => { sectionRefs.current.hotkeys = el }} id="hotkeys">
              <div className="flex items-start justify-between mb-1">
                <h2 className="text-lg font-semibold text-fg-bright">Hotkeys</h2>
                {hotkeyOverrides && Object.keys(hotkeyOverrides).length > 0 && (
                  <button
                    onClick={handleResetAllHotkeys}
                    className="flex items-center gap-1 text-xs text-dim hover:text-fg transition-colors cursor-pointer"
                  >
                    <RotateCcw size={11} />
                    Reset all to defaults
                  </button>
                )}
              </div>
              <p className="text-sm text-dim mb-4">
                Click a shortcut to rebind it. Press <kbd className="bg-panel-raised px-1 rounded text-[10px]">Esc</kbd> to cancel.
              </p>

              <div className="bg-panel-raised border border-border rounded-lg divide-y divide-border">
                {(Object.keys(DEFAULT_HOTKEYS) as Action[]).map((action) => {
                  const binding: HotkeyBinding = resolvedHotkeys[action]
                  const isRebinding = rebindingAction === action
                  const overridden = isOverridden(action)

                  return (
                    <div key={action} className="flex items-center justify-between px-3 py-2">
                      <span className="text-sm text-fg">{ACTION_LABELS[action]}</span>
                      <div className="flex items-center gap-2">
                        {overridden && (
                          <Tooltip label="Reset to default">
                            <button
                              onClick={() => handleResetHotkey(action)}
                              className="text-xs text-dim hover:text-fg transition-colors cursor-pointer"
                            >
                              <RotateCcw size={11} />
                            </button>
                          </Tooltip>
                        )}
                        <button
                          onClick={() => setRebindingAction(isRebinding ? null : action)}
                          className={`min-w-[100px] px-2.5 py-1 rounded text-xs font-mono transition-colors cursor-pointer ${
                            isRebinding
                              ? 'bg-warning/20 text-warning border border-warning/50 animate-pulse'
                              : 'bg-panel text-fg border border-border-strong hover:border-fg'
                          }`}
                        >
                          {isRebinding ? 'Press keys...' : bindingToString(binding)}
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            </section>

            {/* Updates section */}
            <section ref={(el) => { sectionRefs.current.updates = el }} id="updates">
              <h2 className="text-lg font-semibold text-fg-bright mb-1">Updates</h2>
              <p className="text-sm text-dim mb-4">
                Harness checks for updates automatically on startup and every hour.
              </p>

              <div className="bg-panel-raised border border-border rounded-lg p-4">
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <div className="text-sm text-fg">Current version</div>
                    <div className="text-xs text-dim font-mono mt-0.5">
                      {version || '...'}
                    </div>
                  </div>
                  <button
                    onClick={handleCheckForUpdates}
                    disabled={checking || updaterStatus?.state === 'checking' || updaterStatus?.state === 'downloading'}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-surface hover:bg-surface-hover disabled:opacity-40 rounded text-sm text-fg-bright transition-colors cursor-pointer"
                  >
                    <RefreshCw size={12} className={checking ? 'animate-spin' : ''} />
                    Check for updates
                  </button>
                </div>

                {renderUpdaterStatus() && (
                  <div className="pt-3 border-t border-border">
                    {renderUpdaterStatus()}
                  </div>
                )}
              </div>

              <div className="mt-3 text-xs text-dim">
                <a
                  onClick={() => window.api.openExternal('https://github.com/frenchie4111/harness/releases')}
                  className="text-muted hover:text-fg-bright underline cursor-pointer"
                >
                  View all releases on GitHub
                </a>
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  )
}

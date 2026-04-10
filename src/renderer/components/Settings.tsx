import { useState, useEffect, useCallback, useRef } from 'react'
import { ArrowLeft, Check, X, Eye, EyeOff, Star, RefreshCw, Download, RotateCw, GitPullRequest, DownloadCloud, Keyboard, RotateCcw } from 'lucide-react'
import type { UpdaterStatus } from '../types'
import { DEFAULT_HOTKEYS, ACTION_LABELS, bindingToString, eventToBinding, resolveHotkeys, type Action, type HotkeyBinding } from '../hotkeys'

interface SettingsProps {
  onClose: () => void
}

type SectionId = 'github' | 'updates' | 'hotkeys'

interface Section {
  id: SectionId
  label: string
  icon: React.ComponentType<{ size?: number; className?: string }>
}

const SECTIONS: Section[] = [
  { id: 'github', label: 'GitHub', icon: GitPullRequest },
  { id: 'hotkeys', label: 'Hotkeys', icon: Keyboard },
  { id: 'updates', label: 'Updates', icon: DownloadCloud }
]

export function Settings({ onClose }: SettingsProps): JSX.Element {
  const [activeSection, setActiveSection] = useState<SectionId>('github')
  const scrollRef = useRef<HTMLDivElement>(null)
  const sectionRefs = useRef<Record<SectionId, HTMLElement | null>>({
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

  // Update active section based on scroll position
  useEffect(() => {
    const container = scrollRef.current
    if (!container) return

    const onScroll = (): void => {
      const scrollTop = container.scrollTop
      let current: SectionId = 'github'
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

  useEffect(() => {
    window.api.hasGithubToken().then(setHasToken)
    window.api.getVersion().then(setVersion)
    window.api.getHotkeyOverrides().then((v) => setHotkeyOverrides(v))
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
          <div className="flex items-center gap-2 text-xs text-neutral-400">
            <RefreshCw size={12} className="animate-spin" />
            Checking for updates...
          </div>
        )
      case 'not-available':
        return (
          <div className="flex items-center gap-2 text-xs text-green-400">
            <Check size={12} />
            You&apos;re up to date
          </div>
        )
      case 'available':
        return (
          <div className="flex items-center gap-2 text-xs text-amber-400">
            <Download size={12} />
            Version {updaterStatus.version} available — downloading...
          </div>
        )
      case 'downloading':
        return (
          <div className="flex items-center gap-2 text-xs text-amber-400">
            <Download size={12} />
            Downloading update... {Math.round(updaterStatus.percent)}%
          </div>
        )
      case 'downloaded':
        return (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2 text-xs text-green-400">
              <Check size={12} />
              Version {updaterStatus.version} ready to install
            </div>
            <button
              onClick={handleRestart}
              className="self-start flex items-center gap-1.5 px-3 py-1.5 bg-green-900 hover:bg-green-800 rounded text-xs text-green-200 transition-colors cursor-pointer"
            >
              <RotateCw size={12} />
              Restart &amp; install
            </button>
          </div>
        )
      case 'error':
        return (
          <div className="flex items-center gap-2 text-xs text-red-400">
            <X size={12} />
            {updaterStatus.error}
          </div>
        )
    }
  }

  return (
    <div className="flex flex-col h-full bg-neutral-950">
      {/* Title bar (drag region) */}
      <div className="drag-region h-10 shrink-0 border-b border-neutral-800 relative">
        <button
          onClick={onClose}
          className="no-drag absolute left-20 top-1/2 -translate-y-1/2 flex items-center gap-1.5 text-xs text-neutral-400 hover:text-neutral-200 transition-colors cursor-pointer"
        >
          <ArrowLeft size={14} />
          Back
        </button>
        <span className="absolute left-1/2 -translate-x-1/2 top-1/2 -translate-y-1/2 text-sm font-medium text-neutral-300 pointer-events-none">
          Settings
        </span>
      </div>

      <div className="flex flex-1 min-h-0">
        {/* Left sidebar */}
        <div className="w-56 border-r border-neutral-800 bg-neutral-950 flex flex-col shrink-0">
          <div className="px-3 py-2">
            <span className="text-xs font-medium text-neutral-500">SECTIONS</span>
          </div>
          {SECTIONS.map((section) => {
            const Icon = section.icon
            const isActive = activeSection === section.id
            return (
              <button
                key={section.id}
                onClick={() => scrollToSection(section.id)}
                className={`flex items-center gap-2 px-3 py-2 text-left text-sm transition-colors cursor-pointer ${
                  isActive
                    ? 'bg-neutral-800 text-neutral-100'
                    : 'text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200'
                }`}
              >
                <Icon size={14} className="shrink-0" />
                <span>{section.label}</span>
              </button>
            )
          })}
        </div>

        {/* Main scrollable content */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto">
          <div className="max-w-2xl p-8 space-y-12">
            {/* GitHub section */}
            <section ref={(el) => { sectionRefs.current.github = el }} id="github">
              <h2 className="text-lg font-semibold text-neutral-200 mb-1">GitHub</h2>
              <p className="text-sm text-neutral-500 mb-4">
                Harness uses a personal access token to fetch PR status and check results.
                The token is encrypted and stored locally using your macOS keychain.
              </p>

              <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-4">
                <label className="block text-sm font-medium text-neutral-300 mb-2">
                  Personal Access Token
                </label>

                {hasToken && (
                  <div className="flex items-center gap-2 mb-3 text-xs text-green-400">
                    <Check size={14} />
                    <span>A token is currently saved</span>
                  </div>
                )}

                <label className="flex items-center gap-2 mb-3 cursor-pointer group">
                  <input
                    type="checkbox"
                    checked={autoStar}
                    onChange={(e) => setAutoStar(e.target.checked)}
                    className="w-3.5 h-3.5 accent-amber-400 cursor-pointer"
                  />
                  <Star size={12} className="text-amber-400 shrink-0" />
                  <span className="text-xs text-neutral-400 group-hover:text-neutral-300 transition-colors">
                    Automatically star Harness on GitHub
                  </span>
                </label>

                <div className="relative mb-3">
                  <input
                    type={showToken ? 'text' : 'password'}
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    placeholder={hasToken ? 'Enter a new token to replace the existing one' : 'ghp_... or github_pat_...'}
                    className="w-full bg-neutral-950 border border-neutral-700 rounded px-3 py-2 pr-10 text-sm text-neutral-200 placeholder-neutral-600 outline-none focus:border-neutral-500 font-mono"
                  />
                  <button
                    onClick={() => setShowToken(!showToken)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-neutral-500 hover:text-neutral-300 transition-colors cursor-pointer"
                  >
                    {showToken ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    onClick={handleSave}
                    disabled={saving || !token.trim()}
                    className="px-3 py-1.5 bg-neutral-800 hover:bg-neutral-700 disabled:opacity-40 rounded text-sm text-neutral-200 transition-colors cursor-pointer"
                  >
                    {saving ? 'Validating...' : 'Save'}
                  </button>
                  {hasToken && (
                    <button
                      onClick={handleClear}
                      className="px-3 py-1.5 text-sm text-red-400 hover:text-red-300 transition-colors cursor-pointer"
                    >
                      Remove
                    </button>
                  )}
                </div>

                {tokenResult && (
                  <div className={`mt-3 text-xs flex items-center gap-1.5 ${tokenResult.ok ? 'text-green-400' : 'text-red-400'}`}>
                    {tokenResult.ok ? <Check size={12} /> : <X size={12} />}
                    {tokenResult.message}
                  </div>
                )}
              </div>

              <div className="mt-4 text-xs text-neutral-500 space-y-2">
                <p>
                  Create a token at{' '}
                  <a
                    onClick={() => window.api.openExternal('https://github.com/settings/tokens?type=beta')}
                    className="text-neutral-400 hover:text-neutral-200 underline cursor-pointer"
                  >
                    github.com/settings/tokens
                  </a>
                  {' '}(fine-grained) or{' '}
                  <a
                    onClick={() => window.api.openExternal('https://github.com/settings/tokens')}
                    className="text-neutral-400 hover:text-neutral-200 underline cursor-pointer"
                  >
                    classic tokens
                  </a>
                  .
                </p>
                <p>
                  Required scopes: <code className="bg-neutral-900 px-1 rounded">repo</code> for private repos,
                  or <code className="bg-neutral-900 px-1 rounded">public_repo</code> for public only.
                </p>
              </div>
            </section>

            {/* Hotkeys section */}
            <section ref={(el) => { sectionRefs.current.hotkeys = el }} id="hotkeys">
              <div className="flex items-start justify-between mb-1">
                <h2 className="text-lg font-semibold text-neutral-200">Hotkeys</h2>
                {hotkeyOverrides && Object.keys(hotkeyOverrides).length > 0 && (
                  <button
                    onClick={handleResetAllHotkeys}
                    className="flex items-center gap-1 text-xs text-neutral-500 hover:text-neutral-300 transition-colors cursor-pointer"
                  >
                    <RotateCcw size={11} />
                    Reset all to defaults
                  </button>
                )}
              </div>
              <p className="text-sm text-neutral-500 mb-4">
                Click a shortcut to rebind it. Press <kbd className="bg-neutral-900 px-1 rounded text-[10px]">Esc</kbd> to cancel.
              </p>

              <div className="bg-neutral-900 border border-neutral-800 rounded-lg divide-y divide-neutral-800">
                {(Object.keys(DEFAULT_HOTKEYS) as Action[]).map((action) => {
                  const binding: HotkeyBinding = resolvedHotkeys[action]
                  const isRebinding = rebindingAction === action
                  const overridden = isOverridden(action)

                  return (
                    <div key={action} className="flex items-center justify-between px-3 py-2">
                      <span className="text-sm text-neutral-300">{ACTION_LABELS[action]}</span>
                      <div className="flex items-center gap-2">
                        {overridden && (
                          <button
                            onClick={() => handleResetHotkey(action)}
                            className="text-xs text-neutral-500 hover:text-neutral-300 transition-colors cursor-pointer"
                            title="Reset to default"
                          >
                            <RotateCcw size={11} />
                          </button>
                        )}
                        <button
                          onClick={() => setRebindingAction(isRebinding ? null : action)}
                          className={`min-w-[100px] px-2.5 py-1 rounded text-xs font-mono transition-colors cursor-pointer ${
                            isRebinding
                              ? 'bg-amber-900 text-amber-200 border border-amber-700 animate-pulse'
                              : 'bg-neutral-950 text-neutral-300 border border-neutral-700 hover:border-neutral-500'
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
              <h2 className="text-lg font-semibold text-neutral-200 mb-1">Updates</h2>
              <p className="text-sm text-neutral-500 mb-4">
                Harness checks for updates automatically on startup and every hour.
              </p>

              <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-4">
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <div className="text-sm text-neutral-300">Current version</div>
                    <div className="text-xs text-neutral-500 font-mono mt-0.5">
                      {version || '...'}
                    </div>
                  </div>
                  <button
                    onClick={handleCheckForUpdates}
                    disabled={checking || updaterStatus?.state === 'checking' || updaterStatus?.state === 'downloading'}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-neutral-800 hover:bg-neutral-700 disabled:opacity-40 rounded text-sm text-neutral-200 transition-colors cursor-pointer"
                  >
                    <RefreshCw size={12} className={checking ? 'animate-spin' : ''} />
                    Check for updates
                  </button>
                </div>

                {renderUpdaterStatus() && (
                  <div className="pt-3 border-t border-neutral-800">
                    {renderUpdaterStatus()}
                  </div>
                )}
              </div>

              <div className="mt-3 text-xs text-neutral-500">
                <a
                  onClick={() => window.api.openExternal('https://github.com/frenchie4111/harness/releases')}
                  className="text-neutral-400 hover:text-neutral-200 underline cursor-pointer"
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

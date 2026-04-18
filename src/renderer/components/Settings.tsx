import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { ArrowLeft, Check, X, Eye, EyeOff, Star, RefreshCw, Download, RotateCw, GitPullRequest, DownloadCloud, Keyboard, RotateCcw, Terminal as TerminalIcon, Palette, BookOpen, Code2, GitBranch, Plus, Trash2, LifeBuoy, Bug, Lightbulb } from 'lucide-react'
import { openReportIssue } from './ReportIssueModal'
import { HARNESS_RELEASES_URL } from '../../shared/constants'
import { useSettings, useUpdater, useRepoConfigs, useHooks } from '../store'
import type { UpdaterStatus, MergeStrategy, RepoConfig } from '../types'
import { DEFAULT_HOTKEYS, ACTION_LABELS, bindingToString, eventToBinding, resolveHotkeys, type Action, type HotkeyBinding } from '../hotkeys'
import { Tooltip } from './Tooltip'
import { AGENT_REGISTRY, agentDisplayName, CLAUDE_MODELS, CODEX_MODELS } from '../../shared/agent-registry'
import { AgentIcon } from './AgentIcon'
import { THEME_OPTIONS } from '../themes'

interface SettingsProps {
  onClose: () => void
  onOpenGuide: () => void
  initialSection?: SectionId
}

type SectionId = 'appearance' | 'agent' | 'worktrees' | 'editor' | 'github' | 'hotkeys' | 'updates' | 'support'
type SubSectionId = 'agent-general' | 'agent-claude' | 'agent-codex'

interface SubSection {
  id: SubSectionId
  label: string
}

interface Section {
  id: SectionId
  label: string
  icon: React.ComponentType<{ size?: number; className?: string }>
  children?: SubSection[]
}

const SECTIONS: Section[] = [
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'agent', label: 'Agent', icon: TerminalIcon, children: [
    { id: 'agent-general', label: 'General' },
    { id: 'agent-claude', label: 'Claude' },
    { id: 'agent-codex', label: 'Codex' }
  ]},
  { id: 'worktrees', label: 'Worktrees', icon: GitBranch },
  { id: 'editor', label: 'Editor', icon: Code2 },
  { id: 'github', label: 'GitHub', icon: GitPullRequest },
  { id: 'hotkeys', label: 'Hotkeys', icon: Keyboard },
  { id: 'updates', label: 'Updates', icon: DownloadCloud },
  { id: 'support', label: 'Support', icon: LifeBuoy }
]

export function Settings({ onClose, onOpenGuide, initialSection }: SettingsProps): JSX.Element {
  const [activeSection, setActiveSection] = useState<SectionId>(initialSection ?? 'appearance')
  const [activeSubSection, setActiveSubSection] = useState<SubSectionId | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const sectionRefs = useRef<Record<SectionId, HTMLElement | null>>({
    appearance: null,
    agent: null,
    worktrees: null,
    editor: null,
    github: null,
    hotkeys: null,
    updates: null,
    support: null
  })
  const subSectionRefs = useRef<Record<SubSectionId, HTMLElement | null>>({
    'agent-general': null,
    'agent-claude': null,
    'agent-codex': null
  })
  const isProgrammaticScroll = useRef(false)

  const scrollToSection = useCallback((id: SectionId) => {
    setActiveSection(id)
    const section = SECTIONS.find((s) => s.id === id)
    setActiveSubSection(section?.children?.[0]?.id ?? null)
    isProgrammaticScroll.current = true
    const el = sectionRefs.current[id]
    if (el && scrollRef.current) {
      scrollRef.current.scrollTo({ top: el.offsetTop - 24, behavior: 'smooth' })
    }
  }, [])

  const scrollToSubSection = useCallback((id: SubSectionId) => {
    setActiveSubSection(id)
    isProgrammaticScroll.current = true
    const el = subSectionRefs.current[id]
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

  useEffect(() => {
    const container = scrollRef.current
    if (!container) return

    const onScrollEnd = (): void => { isProgrammaticScroll.current = false }

    const onScroll = (): void => {
      if (isProgrammaticScroll.current) return
      const scrollTop = container.scrollTop
      let current: SectionId = 'appearance'
      for (const section of SECTIONS) {
        const el = sectionRefs.current[section.id]
        if (el && el.offsetTop - 48 <= scrollTop) {
          current = section.id
        }
      }
      setActiveSection(current)

      const currentSection = SECTIONS.find((s) => s.id === current)
      if (currentSection?.children) {
        let currentSub: SubSectionId | null = currentSection.children[0].id
        for (const child of currentSection.children) {
          const el = subSectionRefs.current[child.id]
          if (el && el.offsetTop - 48 <= scrollTop) {
            currentSub = child.id
          }
        }
        setActiveSubSection(currentSub)
      } else {
        setActiveSubSection(null)
      }
    }

    container.addEventListener('scroll', onScroll)
    container.addEventListener('scrollend', onScrollEnd)
    return () => {
      container.removeEventListener('scroll', onScroll)
      container.removeEventListener('scrollend', onScrollEnd)
    }
  }, [])

  // GitHub state
  const [token, setToken] = useState('')
  const [showToken, setShowToken] = useState(false)
  const [saving, setSaving] = useState(false)
  const [tokenResult, setTokenResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [showPatForm, setShowPatForm] = useState(false)

  // Updates state — updaterStatus lives in the main-process store
  const [version, setVersion] = useState<string>('')
  const updaterStatus = useUpdater().status
  const [checking, setChecking] = useState(false)

  // All long-lived settings live in the main-process store; this hook
  // re-renders Settings whenever any client updates any of them.
  const settings = useSettings()
  const {
    theme,
    hotkeys: hotkeyOverrides,
    defaultAgent,
    claudeCommand,
    codexCommand,
    harnessMcpEnabled,
    claudeEnvVars,
    codexEnvVars,
    nameClaudeSessions,
    claudeModel,
    codexModel,
    terminalFontFamily,
    terminalFontSize,
    editor: editorId,
    worktreeBase,
    mergeStrategy,
    hasGithubToken: settingsHasToken,
    githubAuthSource: authSource,
    harnessStarred,
    worktreeScripts,
    shareClaudeSettings,
    autoUpdateEnabled,
    harnessSystemPromptEnabled,
    harnessSystemPrompt,
    harnessSystemPromptMain,
    claudeTuiFullscreen
  } = settings
  const setupScript = worktreeScripts.setup
  const teardownScript = worktreeScripts.teardown

  const [rebindingAction, setRebindingAction] = useState<Action | null>(null)
  const [defaultClaudeCommand, setDefaultClaudeCommand] = useState<string>('')
  const [claudeSaveResult, setClaudeSaveResult] = useState<{ ok: boolean; message: string } | null>(null)
  // Alias settings.hasGithubToken to the legacy local name so existing JSX
  // stays unchanged.
  const hasToken = settingsHasToken

  // Claude env var state. Stored as an ordered list of [key, value] pairs so
  // the user can edit a blank row without it collapsing in a Record. Seeded
  // from settings on mount; edits live locally until "Save" dispatches through
  // the setter IPC.
  const [claudeEnvRows, setClaudeEnvRows] = useState<{ key: string; value: string }[]>(() =>
    Object.entries(claudeEnvVars).map(([key, value]) => ({ key, value }))
  )
  const [envSaveResult, setEnvSaveResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [revealedEnvRows, setRevealedEnvRows] = useState<Set<number>>(new Set())

  const [codexCommandDraft, setCodexCommandDraft] = useState<string>(codexCommand)
  useEffect(() => { setCodexCommandDraft(codexCommand) }, [codexCommand])
  const [codexSaveResult, setCodexSaveResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [codexEnvRows, setCodexEnvRows] = useState<{ key: string; value: string }[]>(() =>
    Object.entries(codexEnvVars).map(([key, value]) => ({ key, value }))
  )
  const [codexEnvSaveResult, setCodexEnvSaveResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [codexRevealedEnvRows, setCodexRevealedEnvRows] = useState<Set<number>>(new Set())

  const [systemPromptDraft, setSystemPromptDraft] = useState<string>(harnessSystemPrompt)
  useEffect(() => { setSystemPromptDraft(harnessSystemPrompt) }, [harnessSystemPrompt])
  const [systemPromptMainDraft, setSystemPromptMainDraft] = useState<string>(harnessSystemPromptMain)
  useEffect(() => { setSystemPromptMainDraft(harnessSystemPromptMain) }, [harnessSystemPromptMain])
  const [systemPromptSaveResult, setSystemPromptSaveResult] = useState<{ ok: boolean; message: string } | null>(null)

  const [defaultTerminalFontFamily, setDefaultTerminalFontFamily] = useState<string>('')
  const [availableEditors, setAvailableEditors] = useState<{ id: string; name: string }[]>([])
  const [scriptsSaveResult, setScriptsSaveResult] = useState<{ ok: boolean; message: string } | null>(null)

  // Per-repo scope state for scopable worktree settings. scopeRepoRoot === null
  // means the controls bind to global config; otherwise they bind to the
  // repo-scoped .harness.json at that repoRoot. The configs map itself
  // lives in the main-process store.
  const repoConfigs = useRepoConfigs()
  const repoList = useMemo(() => Object.keys(repoConfigs), [repoConfigs])
  const [scopeRepoRoot, setScopeRepoRoot] = useState<string | null>(null)

  // Hooks consent — drives the copy in the "Status hooks" card below.
  const { consent: hooksConsent } = useHooks()

  // Constants and non-settings state load once; live settings are already
  // hydrated via useSettings() above.
  useEffect(() => {
    window.api.getVersion().then(setVersion)
    window.api.getDefaultClaudeCommand().then(setDefaultClaudeCommand)
    window.api.getDefaultTerminalFontFamily().then(setDefaultTerminalFontFamily)
    window.api.getAvailableEditors().then(setAvailableEditors)
  }, [])

  // Whenever claudeEnvVars in the store changes (e.g. another window saved),
  // re-seed the local editable rows. Local edits between loads are lost —
  // same as before the migration, where Settings only read on mount.
  useEffect(() => {
    setClaudeEnvRows(Object.entries(claudeEnvVars).map(([key, value]) => ({ key, value })))
  }, [claudeEnvVars])

  const updateRepoConfig = useCallback(
    async (repoRoot: string, patch: Record<string, unknown>) => {
      // Main dispatches repoConfigs/changed after saveRepoConfig commits;
      // useRepoConfigs() re-renders us automatically.
      await window.api.setRepoConfig(repoRoot, patch)
    },
    []
  )

  const repoBasename = useCallback((repoRoot: string): string => {
    const parts = repoRoot.split('/').filter(Boolean)
    return parts[parts.length - 1] || repoRoot
  }, [])

  const [setupDraft, setSetupDraft] = useState<string>('')
  const [teardownDraft, setTeardownDraft] = useState<string>('')

  // Editable draft for the Claude command input. Hydrated from the store and
  // re-synced whenever the store value changes (e.g. another window edited it).
  // The `Save` button commits the draft via the setter IPC.
  const [claudeCommandDraft, setClaudeCommandDraft] = useState<string>(claudeCommand)
  useEffect(() => {
    setClaudeCommandDraft(claudeCommand)
  }, [claudeCommand])

  const handleSelectTheme = useCallback(async (id: string) => {
    await window.api.setTheme(id)
  }, [])

  const handleTerminalFontFamilyChange = useCallback((value: string) => {
    void window.api.setTerminalFontFamily(value)
  }, [])

  const handleResetTerminalFontFamily = useCallback(() => {
    void window.api.setTerminalFontFamily(defaultTerminalFontFamily)
  }, [defaultTerminalFontFamily])

  const handleTerminalFontSizeChange = useCallback((value: number) => {
    if (!Number.isFinite(value)) return
    const clamped = Math.max(8, Math.min(48, Math.round(value)))
    void window.api.setTerminalFontSize(clamped)
  }, [])

  const handleSelectEditor = useCallback(async (id: string) => {
    await window.api.setEditor(id)
  }, [])

  const handleSelectWorktreeBase = useCallback(async (mode: 'remote' | 'local') => {
    await window.api.setWorktreeBase(mode)
  }, [])

  const handleSelectMergeStrategy = useCallback(
    async (strategy: MergeStrategy) => {
      if (scopeRepoRoot) {
        await updateRepoConfig(scopeRepoRoot, { mergeStrategy: strategy })
      } else {
        await window.api.setMergeStrategy(strategy)
      }
    },
    [scopeRepoRoot, updateRepoConfig]
  )

  // Resolve what each control should display for the active scope.
  const scopedRepoCfg = scopeRepoRoot ? repoConfigs[scopeRepoRoot] || {} : null
  const displayedMergeStrategy: MergeStrategy = scopedRepoCfg
    ? (scopedRepoCfg.mergeStrategy || mergeStrategy)
    : mergeStrategy
  const scopedMergeStrategyIsOverride = !!(scopedRepoCfg && scopedRepoCfg.mergeStrategy)
  const displayedSetupScript = scopedRepoCfg
    ? (scopedRepoCfg.setupCommand ?? '')
    : setupScript
  const displayedTeardownScript = scopedRepoCfg
    ? (scopedRepoCfg.teardownCommand ?? '')
    : teardownScript
  const scopedSetupIsOverride = !!(scopedRepoCfg && scopedRepoCfg.setupCommand)
  const scopedTeardownIsOverride = !!(scopedRepoCfg && scopedRepoCfg.teardownCommand)

  // Reset the scoped script drafts whenever the active scope (or persisted
  // value for that scope) changes, so the textareas show what's on disk.
  useEffect(() => {
    setSetupDraft(displayedSetupScript)
    setTeardownDraft(displayedTeardownScript)
  }, [scopeRepoRoot, displayedSetupScript, displayedTeardownScript])

  const handleSaveWorktreeScripts = useCallback(async () => {
    if (scopeRepoRoot) {
      await updateRepoConfig(scopeRepoRoot, {
        setupCommand: setupDraft.trim() || null,
        teardownCommand: teardownDraft.trim() || null
      })
    } else {
      await window.api.setWorktreeScripts({ setup: setupDraft, teardown: teardownDraft })
    }
    setScriptsSaveResult({ ok: true, message: 'Saved' })
    setTimeout(() => setScriptsSaveResult(null), 2000)
  }, [scopeRepoRoot, setupDraft, teardownDraft, updateRepoConfig])

  const handleResetSetupToGlobal = useCallback(async () => {
    if (!scopeRepoRoot) return
    await updateRepoConfig(scopeRepoRoot, { setupCommand: null })
    setSetupDraft('')
  }, [scopeRepoRoot, updateRepoConfig])

  const handleResetTeardownToGlobal = useCallback(async () => {
    if (!scopeRepoRoot) return
    await updateRepoConfig(scopeRepoRoot, { teardownCommand: null })
    setTeardownDraft('')
  }, [scopeRepoRoot, updateRepoConfig])

  const handleResetMergeStrategyToGlobal = useCallback(async () => {
    if (!scopeRepoRoot) return
    await updateRepoConfig(scopeRepoRoot, { mergeStrategy: null })
  }, [scopeRepoRoot, updateRepoConfig])

  // Repos that override a given key — used to decorate global-scope controls
  // with a "Overridden in N repo(s)" badge.
  const reposOverridingKey = useCallback(
    (key: keyof RepoConfig): string[] => {
      return repoList.filter((r) => {
        const cfg = repoConfigs[r]
        if (!cfg) return false
        const v = cfg[key]
        return typeof v === 'string' ? v.length > 0 : v != null
      })
    },
    [repoList, repoConfigs]
  )

  const handleSave = useCallback(async () => {
    setSaving(true)
    setTokenResult(null)
    try {
      const res = await window.api.setGithubToken(token)
      if (res.ok) {
        const message = res.username ? `Connected as @${res.username}` : 'Token saved'
        setTokenResult({ ok: true, message })
        setToken('')
      } else {
        setTokenResult({ ok: false, message: `Invalid token: ${res.error || 'unknown error'}` })
      }
    } finally {
      setSaving(false)
    }
  }, [token])

  const handleClear = useCallback(async () => {
    await window.api.clearGithubToken()
    setTokenResult({ ok: true, message: 'Token removed' })
  }, [])

  const handleCheckForUpdates = useCallback(async () => {
    setChecking(true)
    try {
      // Main dispatches the resulting updater/statusChanged event itself —
      // we just await the call so we know when to clear the spinner.
      await window.api.checkForUpdates()
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
      void window.api.setHotkeyOverrides(next)
      setRebindingAction(null)
    }

    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [rebindingAction, hotkeyOverrides])

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (e.defaultPrevented) return
      onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const resolvedHotkeys = resolveHotkeys(hotkeyOverrides || undefined)

  const handleResetHotkey = useCallback(async (action: Action) => {
    const next = { ...(hotkeyOverrides || {}) }
    delete next[action]
    await window.api.setHotkeyOverrides(next)
  }, [hotkeyOverrides])

  const handleResetAllHotkeys = useCallback(async () => {
    await window.api.resetHotkeyOverrides()
  }, [])

  const handleSaveClaudeCommand = useCallback(async () => {
    setClaudeSaveResult(null)
    await window.api.setClaudeCommand(claudeCommandDraft)
    setClaudeSaveResult({ ok: true, message: 'Saved · new tabs will use this command' })
  }, [claudeCommandDraft])

  const handleToggleHarnessMcp = useCallback(async (enabled: boolean) => {
    await window.api.setHarnessMcpEnabled(enabled)
  }, [])

  const handleToggleAutoUpdate = useCallback(async (enabled: boolean) => {
    await window.api.setAutoUpdateEnabled(enabled)
  }, [])

  const handleSaveSystemPrompt = useCallback(async () => {
    await window.api.setHarnessSystemPrompt(systemPromptDraft)
    await window.api.setHarnessSystemPromptMain(systemPromptMainDraft)
    setSystemPromptSaveResult({ ok: true, message: 'Saved · new sessions will use this prompt' })
    setTimeout(() => setSystemPromptSaveResult(null), 2000)
  }, [systemPromptDraft, systemPromptMainDraft])

  const handleResetSystemPrompt = useCallback(async () => {
    await window.api.setHarnessSystemPrompt('')
    await window.api.setHarnessSystemPromptMain('')
    setSystemPromptSaveResult({ ok: true, message: 'Reset to defaults' })
    setTimeout(() => setSystemPromptSaveResult(null), 2000)
  }, [])

  const effectiveClaudeCommand = claudeCommandDraft.trim() || defaultClaudeCommand
  const modelPart = claudeModel && !effectiveClaudeCommand.includes('--model') ? ` --model ${claudeModel}` : ''
  const mcpPart = harnessMcpEnabled ? ' --mcp-config <per-session>' : ''
  const previewInner = `${effectiveClaudeCommand}${modelPart}${mcpPart} --session-id <uuid>`
  const commandPreview = `/bin/zsh -ilc "${previewInner}"`

  const handleResetClaudeCommand = useCallback(async () => {
    setClaudeCommandDraft(defaultClaudeCommand)
    await window.api.setClaudeCommand(defaultClaudeCommand)
    setClaudeSaveResult({ ok: true, message: 'Reset to default' })
  }, [defaultClaudeCommand])

  const handleAddEnvRow = useCallback(() => {
    setClaudeEnvRows((prev) => [...prev, { key: '', value: '' }])
    setEnvSaveResult(null)
  }, [])

  const handleRemoveEnvRow = useCallback((index: number) => {
    setClaudeEnvRows((prev) => prev.filter((_, i) => i !== index))
    setRevealedEnvRows((prev) => {
      const next = new Set<number>()
      prev.forEach((i) => { if (i < index) next.add(i); else if (i > index) next.add(i - 1) })
      return next
    })
    setEnvSaveResult(null)
  }, [])

  const handleUpdateEnvRow = useCallback((index: number, field: 'key' | 'value', value: string) => {
    setClaudeEnvRows((prev) => prev.map((row, i) => (i === index ? { ...row, [field]: value } : row)))
    setEnvSaveResult(null)
  }, [])

  const handleToggleRevealEnvRow = useCallback((index: number) => {
    setRevealedEnvRows((prev) => {
      const next = new Set(prev)
      if (next.has(index)) next.delete(index); else next.add(index)
      return next
    })
  }, [])

  const handleSaveClaudeEnvVars = useCallback(async () => {
    const vars: Record<string, string> = {}
    const seen = new Set<string>()
    const invalidNames: string[] = []
    const duplicates: string[] = []
    for (const { key, value } of claudeEnvRows) {
      const k = key.trim()
      if (!k) continue
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
        invalidNames.push(k)
        continue
      }
      if (seen.has(k)) {
        duplicates.push(k)
        continue
      }
      seen.add(k)
      vars[k] = value
    }
    if (invalidNames.length > 0) {
      setEnvSaveResult({ ok: false, message: `Invalid name(s): ${invalidNames.join(', ')}` })
      return
    }
    if (duplicates.length > 0) {
      setEnvSaveResult({ ok: false, message: `Duplicate name(s): ${duplicates.join(', ')}` })
      return
    }
    await window.api.setClaudeEnvVars(vars)
    setEnvSaveResult({ ok: true, message: 'Saved · new Claude tabs will see these' })
  }, [claudeEnvRows])

  const handleSaveCodexCommand = useCallback(async () => {
    setCodexSaveResult(null)
    await window.api.setCodexCommand(codexCommandDraft)
    setCodexSaveResult({ ok: true, message: 'Saved · new tabs will use this command' })
  }, [codexCommandDraft])

  const handleResetCodexCommand = useCallback(async () => {
    setCodexCommandDraft('codex')
    await window.api.setCodexCommand('codex')
    setCodexSaveResult({ ok: true, message: 'Reset to default' })
  }, [])

  const handleSaveCodexEnvVars = useCallback(async () => {
    const vars: Record<string, string> = {}
    const seen = new Set<string>()
    const invalidNames: string[] = []
    const duplicates: string[] = []
    for (const { key, value } of codexEnvRows) {
      const k = key.trim()
      if (!k) continue
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) { invalidNames.push(k); continue }
      if (seen.has(k)) { duplicates.push(k); continue }
      seen.add(k)
      vars[k] = value
    }
    if (invalidNames.length > 0) { setCodexEnvSaveResult({ ok: false, message: `Invalid name(s): ${invalidNames.join(', ')}` }); return }
    if (duplicates.length > 0) { setCodexEnvSaveResult({ ok: false, message: `Duplicate name(s): ${duplicates.join(', ')}` }); return }
    await window.api.setCodexEnvVars(vars)
    setCodexEnvSaveResult({ ok: true, message: 'Saved · new Codex tabs will see these' })
  }, [codexEnvRows])

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
          <kbd className="text-[10px] text-faint bg-bg px-1.5 py-0.5 rounded border border-border font-mono">ESC</kbd>
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
            const needsAttention = section.id === 'github' && !hasToken && authSource !== 'gh-cli'
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
              <div key={section.id}>
                <button
                  onClick={() => scrollToSection(section.id)}
                  className={`w-full ${className}`}
                >
                  <Icon size={14} className="shrink-0" />
                  <span>{section.label}</span>
                </button>
                {section.children && (
                  <div
                    className="overflow-hidden transition-all duration-200"
                    style={{
                      maxHeight: isActive ? `${section.children.length * 36}px` : '0px',
                      opacity: isActive ? 1 : 0
                    }}
                  >
                    {section.children.map((child) => {
                      const isSubActive = activeSubSection === child.id
                      return (
                        <button
                          key={child.id}
                          onClick={() => scrollToSubSection(child.id)}
                          className={`w-full pl-9 pr-3 py-1.5 text-left text-xs transition-colors cursor-pointer ${
                            isSubActive
                              ? 'text-fg-bright bg-surface/60'
                              : 'text-muted hover:text-fg-bright hover:bg-panel-raised'
                          }`}
                        >
                          {child.label}
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
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

              <h3 className="text-sm font-semibold text-fg-bright mt-6 mb-1">Terminal font</h3>
              <p className="text-xs text-dim mb-3">
                Used by every Claude and shell tab. Provide any CSS font-family value
                — install the font on your system first (e.g.{' '}
                <code className="bg-panel-raised px-1 rounded">Hack</code>,{' '}
                <code className="bg-panel-raised px-1 rounded">'JetBrains Mono'</code>,{' '}
                <code className="bg-panel-raised px-1 rounded">'Fira Code'</code>).
                Changes apply immediately to all open terminals.
              </p>

              <div className="bg-panel-raised border border-border rounded-lg p-4 space-y-4">
                <div>
                  <label className="block text-sm font-medium text-fg mb-1">Font family</label>
                  <input
                    type="text"
                    value={terminalFontFamily}
                    onChange={(e) => handleTerminalFontFamilyChange(e.target.value)}
                    spellCheck={false}
                    className="w-full bg-panel border border-border-strong rounded px-3 py-2 text-xs text-fg-bright placeholder-faint outline-none focus:border-fg font-mono"
                    placeholder={defaultTerminalFontFamily}
                  />
                  {terminalFontFamily !== defaultTerminalFontFamily && defaultTerminalFontFamily && (
                    <button
                      onClick={handleResetTerminalFontFamily}
                      className="mt-2 flex items-center gap-1 px-2 py-1 text-xs text-dim hover:text-fg transition-colors cursor-pointer"
                    >
                      <RotateCcw size={11} />
                      Reset to default
                    </button>
                  )}
                </div>

                <div>
                  <label className="block text-sm font-medium text-fg mb-1">
                    Font size <span className="text-dim font-normal">({terminalFontSize}px)</span>
                  </label>
                  <input
                    type="range"
                    min={8}
                    max={24}
                    step={1}
                    value={terminalFontSize}
                    onChange={(e) => handleTerminalFontSizeChange(Number(e.target.value))}
                    className="w-full accent-fg cursor-pointer"
                  />
                </div>

                <div
                  className="rounded border border-border-strong bg-panel px-3 py-2 text-fg-bright"
                  style={{
                    fontFamily: terminalFontFamily || defaultTerminalFontFamily,
                    fontSize: `${terminalFontSize}px`,
                    lineHeight: 1.4
                  }}
                >
                  the quick brown fox 0123 =&gt; != &lt;= -&gt;
                </div>
              </div>
            </section>

            {/* Agent section */}
            <section ref={(el) => { sectionRefs.current.agent = el }} id="agent">
              <h2 className="text-lg font-semibold text-fg-bright mb-1">Agent</h2>
              <p className="text-sm text-dim mb-4">
                Choose which AI coding agent Harness launches in new tabs.
              </p>

              {/* ── General subsection ── */}
              <div ref={(el) => { subSectionRefs.current['agent-general'] = el }} id="agent-general">
              <div className="bg-panel-raised border border-border rounded-lg p-4 mb-6">
                <label className="block text-sm font-medium text-fg mb-3">Default agent</label>
                <div className="flex gap-2">
                  {AGENT_REGISTRY.map((agent) => (
                    <button
                      key={agent.kind}
                      onClick={() => window.api.setDefaultAgent(agent.kind)}
                      className={`flex items-center gap-2 px-4 py-2 rounded text-sm font-medium transition-colors cursor-pointer ${
                        defaultAgent === agent.kind
                          ? 'bg-surface text-fg-bright border border-fg'
                          : 'bg-panel border border-border text-dim hover:text-fg hover:border-border-strong'
                      }`}
                    >
                      <AgentIcon kind={agent.kind} size={14} />
                      {agent.displayName}
                    </button>
                  ))}
                </div>
                <p className="mt-2 text-xs text-faint">
                  New agent tabs will use the selected default. Existing tabs are unaffected.
                </p>
              </div>

              <h3 className="text-sm font-semibold text-fg-bright mt-6 mb-3">
                Status hooks
              </h3>
              <div className="bg-panel-raised border border-border rounded-lg p-4">
                <p className="text-xs text-dim mb-3">
                  Harness installs a small hook at{' '}
                  <code className="bg-panel px-1 rounded">~/.claude/settings.json</code> and{' '}
                  <code className="bg-panel px-1 rounded">~/.codex/hooks.json</code> so it can
                  detect when each agent tab is processing, waiting, or awaiting approval.
                  The hook only emits when <code className="bg-panel px-1 rounded">$HARNESS_TERMINAL_ID</code>{' '}
                  is set — sessions you launch outside Harness are untouched.
                </p>
                <div className="flex items-center gap-2">
                  {hooksConsent === 'accepted' ? (
                    <>
                      <span className="text-xs text-success flex items-center gap-1"><Check size={12} />Installed</span>
                      <button
                        onClick={() => void window.api.uninstallHooks()}
                        className="ml-auto px-3 py-1.5 bg-surface hover:bg-surface-hover rounded text-sm text-fg-bright transition-colors cursor-pointer"
                      >
                        Remove hooks
                      </button>
                    </>
                  ) : (
                    <>
                      <span className="text-xs text-dim">
                        {hooksConsent === 'declined' ? 'Declined' : 'Not installed'}
                      </span>
                      <button
                        onClick={() => void window.api.acceptHooks()}
                        className="ml-auto px-3 py-1.5 bg-surface hover:bg-surface-hover rounded text-sm text-fg-bright transition-colors cursor-pointer"
                      >
                        Install hooks
                      </button>
                    </>
                  )}
                </div>
              </div>
              </div>

              {/* ── Claude subsection ── */}
              <div ref={(el) => { subSectionRefs.current['agent-claude'] = el }} id="agent-claude" className="mt-8">
              <h3 className="text-sm font-semibold text-fg-bright mb-3 flex items-center gap-2">
                Claude Code
                {defaultAgent === 'claude' && <span className="text-[10px] font-normal text-dim bg-panel px-1.5 py-0.5 rounded">default</span>}
              </h3>

              <div className="bg-panel-raised border border-border rounded-lg p-4 mb-4">
                <label className="block text-sm font-medium text-fg mb-1">Model</label>
                <p className="text-xs text-dim mb-2">
                  Appends <code className="bg-panel px-1 rounded">--model</code> to the launch command. Leave on default to let the CLI choose.
                </p>
                <select
                  value={claudeModel || ''}
                  onChange={(e) => { void window.api.setClaudeModel(e.target.value || null) }}
                  className="w-full bg-panel border border-border-strong rounded px-3 py-2 text-sm text-fg-bright outline-none focus:border-fg cursor-pointer"
                >
                  <option value="">(Default — let CLI choose)</option>
                  <optgroup label="Current">
                    {CLAUDE_MODELS.filter((m) => m.tier === 'current').map((m) => (
                      <option key={m.id} value={m.id}>{m.displayName}</option>
                    ))}
                  </optgroup>
                  <optgroup label="Legacy">
                    {CLAUDE_MODELS.filter((m) => m.tier === 'legacy').map((m) => (
                      <option key={m.id} value={m.id}>{m.displayName}</option>
                    ))}
                  </optgroup>
                </select>
              </div>

              <div className="bg-panel-raised border border-border rounded-lg p-4">
                <label className="block text-sm font-medium text-fg mb-1">Launch command</label>
                <p className="text-xs text-dim mb-2">
                  Harness appends <code className="bg-panel px-1 rounded">--session-id &lt;uuid&gt;</code> so each tab has its own stable, resumable session.
                </p>
                <textarea
                  value={claudeCommandDraft}
                  onChange={(e) => setClaudeCommandDraft(e.target.value)}
                  rows={2}
                  spellCheck={false}
                  className="w-full bg-panel border border-border-strong rounded px-3 py-2 text-xs text-fg-bright placeholder-faint outline-none focus:border-fg font-mono resize-y"
                  placeholder={defaultClaudeCommand}
                />
                <div className="flex items-center gap-2 mt-3">
                  <button onClick={handleSaveClaudeCommand} disabled={!claudeCommandDraft.trim()} className="px-3 py-1.5 bg-surface hover:bg-surface-hover disabled:opacity-40 rounded text-sm text-fg-bright transition-colors cursor-pointer">Save</button>
                  {claudeCommandDraft !== defaultClaudeCommand && defaultClaudeCommand && (
                    <button onClick={handleResetClaudeCommand} className="flex items-center gap-1 px-3 py-1.5 text-sm text-dim hover:text-fg transition-colors cursor-pointer"><RotateCcw size={12} />Reset</button>
                  )}
                </div>
                {claudeSaveResult && (
                  <div className={`mt-3 text-xs flex items-center gap-1.5 ${claudeSaveResult.ok ? 'text-success' : 'text-danger'}`}>
                    {claudeSaveResult.ok ? <Check size={12} /> : <X size={12} />}{claudeSaveResult.message}
                  </div>
                )}

                <div className="mt-4 pt-3 border-t border-border">
                  <label className="block text-xs font-medium text-fg mb-1">Full command preview</label>
                  <div className="bg-panel border border-border rounded px-3 py-2 text-[11px] text-fg-bright font-mono break-all">{commandPreview}</div>
                </div>

                <div className="mt-4 pt-3 border-t border-border">
                  <label className="flex items-start gap-2 cursor-pointer">
                    <input type="checkbox" checked={harnessMcpEnabled} onChange={(e) => handleToggleHarnessMcp(e.target.checked)} className="mt-0.5 cursor-pointer" />
                    <div className="flex-1">
                      <div className="text-sm text-fg-bright">Enable Harness MCP</div>
                      <div className="text-xs text-dim mt-0.5">
                        Injects <code className="bg-panel px-1 rounded text-[10px]">harness-control</code> MCP server via <code className="bg-panel px-1 rounded text-[10px]">--mcp-config</code>.
                      </div>
                    </div>
                  </label>
                </div>

                <div className="mt-4 pt-3 border-t border-border">
                  <label className="flex items-center gap-3 cursor-pointer">
                    <input type="checkbox" checked={nameClaudeSessions} onChange={(e) => { void window.api.setNameClaudeSessions(e.target.checked) }} className="accent-current w-4 h-4 cursor-pointer" />
                    <div>
                      <span className="text-sm font-medium text-fg">Name sessions by worktree</span>
                      <p className="text-xs text-dim mt-0.5">Passes <code className="bg-panel px-1 rounded">--name &quot;repo/branch&quot;</code> to Claude.</p>
                    </div>
                  </label>
                </div>

                <div className="mt-4 pt-3 border-t border-border">
                  <label className="flex items-start gap-2 cursor-pointer">
                    <input type="checkbox" checked={claudeTuiFullscreen} onChange={(e) => { void window.api.setClaudeTuiFullscreen(e.target.checked) }} className="mt-0.5 cursor-pointer" />
                    <div className="flex-1">
                      <div className="text-sm text-fg-bright">Fullscreen TUI by default</div>
                      <div className="text-xs text-dim mt-0.5">
                        Sets <code className="bg-panel px-1 rounded text-[10px]">CLAUDE_CODE_NO_FLICKER=1</code> so Claude runs in fullscreen TUI mode instead of taking over your scrollback.
                      </div>
                    </div>
                  </label>
                </div>
              </div>

              <div className="mt-4 bg-panel-raised border border-border rounded-lg p-4">
                <label className="block text-sm font-medium text-fg mb-1">Environment variables</label>
                <p className="text-xs text-dim mb-3">
                  Injected into Claude tabs. Use for <code className="bg-panel px-1 rounded">ANTHROPIC_API_KEY</code> etc.
                </p>
                {claudeEnvRows.length > 0 && (
                  <div className="space-y-2 mb-3">
                    {claudeEnvRows.map((row, index) => {
                      const revealed = revealedEnvRows.has(index)
                      return (
                        <div key={index} className="flex items-center gap-2">
                          <input type="text" value={row.key} onChange={(e) => handleUpdateEnvRow(index, 'key', e.target.value)} placeholder="NAME" spellCheck={false} className="w-44 bg-panel border border-border-strong rounded px-2 py-1.5 text-xs text-fg-bright placeholder-faint outline-none focus:border-fg font-mono" />
                          <span className="text-dim text-xs">=</span>
                          <input type={revealed ? 'text' : 'password'} value={row.value} onChange={(e) => handleUpdateEnvRow(index, 'value', e.target.value)} placeholder="value" spellCheck={false} className="flex-1 bg-panel border border-border-strong rounded px-2 py-1.5 text-xs text-fg-bright placeholder-faint outline-none focus:border-fg font-mono" />
                          <Tooltip label={revealed ? 'Hide value' : 'Reveal value'}><button onClick={() => handleToggleRevealEnvRow(index)} className="p-1.5 text-dim hover:text-fg transition-colors cursor-pointer">{revealed ? <EyeOff size={14} /> : <Eye size={14} />}</button></Tooltip>
                          <Tooltip label="Remove"><button onClick={() => handleRemoveEnvRow(index)} className="p-1.5 text-dim hover:text-danger transition-colors cursor-pointer"><Trash2 size={14} /></button></Tooltip>
                        </div>
                      )
                    })}
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <button onClick={handleAddEnvRow} className="flex items-center gap-1 px-3 py-1.5 bg-surface hover:bg-surface-hover rounded text-sm text-fg-bright transition-colors cursor-pointer"><Plus size={12} />Add variable</button>
                  <button onClick={handleSaveClaudeEnvVars} className="px-3 py-1.5 bg-surface hover:bg-surface-hover rounded text-sm text-fg-bright transition-colors cursor-pointer">Save</button>
                </div>
                {envSaveResult && (
                  <div className={`mt-3 text-xs flex items-center gap-1.5 ${envSaveResult.ok ? 'text-success' : 'text-danger'}`}>
                    {envSaveResult.ok ? <Check size={12} /> : <X size={12} />}{envSaveResult.message}
                  </div>
                )}
              </div>

              </div>

              {/* ── Codex subsection ── */}
              <div ref={(el) => { subSectionRefs.current['agent-codex'] = el }} id="agent-codex" className="mt-8">
              <h3 className="text-sm font-semibold text-fg-bright mb-3 flex items-center gap-2">
                Codex
                {defaultAgent === 'codex' && <span className="text-[10px] font-normal text-dim bg-panel px-1.5 py-0.5 rounded">default</span>}
              </h3>

              <div className="bg-panel-raised border border-border rounded-lg p-4 mb-4">
                <label className="block text-sm font-medium text-fg mb-1">Model</label>
                <p className="text-xs text-dim mb-2">
                  Appends <code className="bg-panel px-1 rounded">--model</code> to the launch command. Leave on default to let the CLI choose.
                </p>
                <select
                  value={codexModel || ''}
                  onChange={(e) => { void window.api.setCodexModel(e.target.value || null) }}
                  className="w-full bg-panel border border-border-strong rounded px-3 py-2 text-sm text-fg-bright outline-none focus:border-fg cursor-pointer"
                >
                  <option value="">(Default — let CLI choose)</option>
                  <optgroup label="Current">
                    {CODEX_MODELS.filter((m) => m.tier === 'current').map((m) => (
                      <option key={m.id} value={m.id}>{m.displayName}</option>
                    ))}
                  </optgroup>
                  <optgroup label="Legacy">
                    {CODEX_MODELS.filter((m) => m.tier === 'legacy').map((m) => (
                      <option key={m.id} value={m.id}>{m.displayName}</option>
                    ))}
                  </optgroup>
                </select>
              </div>

              <div className="bg-panel-raised border border-border rounded-lg p-4">
                <label className="block text-sm font-medium text-fg mb-1">Launch command</label>
                <p className="text-xs text-dim mb-2">
                  The Codex CLI command. Harness manages session resume automatically.
                </p>
                <textarea
                  value={codexCommandDraft}
                  onChange={(e) => setCodexCommandDraft(e.target.value)}
                  rows={2}
                  spellCheck={false}
                  className="w-full bg-panel border border-border-strong rounded px-3 py-2 text-xs text-fg-bright placeholder-faint outline-none focus:border-fg font-mono resize-y"
                  placeholder="codex"
                />
                <div className="flex items-center gap-2 mt-3">
                  <button onClick={handleSaveCodexCommand} disabled={!codexCommandDraft.trim()} className="px-3 py-1.5 bg-surface hover:bg-surface-hover disabled:opacity-40 rounded text-sm text-fg-bright transition-colors cursor-pointer">Save</button>
                  {codexCommandDraft !== 'codex' && (
                    <button onClick={handleResetCodexCommand} className="flex items-center gap-1 px-3 py-1.5 text-sm text-dim hover:text-fg transition-colors cursor-pointer"><RotateCcw size={12} />Reset</button>
                  )}
                </div>
                {codexSaveResult && (
                  <div className={`mt-3 text-xs flex items-center gap-1.5 ${codexSaveResult.ok ? 'text-success' : 'text-danger'}`}>
                    {codexSaveResult.ok ? <Check size={12} /> : <X size={12} />}{codexSaveResult.message}
                  </div>
                )}
                {(() => {
                  const effectiveCodexCommand = codexCommandDraft.trim() || 'codex'
                  const codexModelPart = codexModel && !effectiveCodexCommand.includes('--model') && !effectiveCodexCommand.includes('-m ') ? ` --model ${codexModel}` : ''
                  const codexPreviewInner = `${effectiveCodexCommand}${codexModelPart}`
                  return (
                    <div className="mt-4 pt-3 border-t border-border">
                      <label className="block text-xs font-medium text-fg mb-1">Full command preview</label>
                      <div className="bg-panel border border-border rounded px-3 py-2 text-[11px] text-fg-bright font-mono break-all">{`/bin/zsh -ilc "${codexPreviewInner}"`}</div>
                    </div>
                  )
                })()}
              </div>

              <div className="mt-4 bg-panel-raised border border-border rounded-lg p-4">
                <label className="block text-sm font-medium text-fg mb-1">Environment variables</label>
                <p className="text-xs text-dim mb-3">
                  Injected into Codex tabs. Use for <code className="bg-panel px-1 rounded">OPENAI_API_KEY</code> etc.
                </p>
                {codexEnvRows.length > 0 && (
                  <div className="space-y-2 mb-3">
                    {codexEnvRows.map((row, index) => {
                      const revealed = codexRevealedEnvRows.has(index)
                      return (
                        <div key={index} className="flex items-center gap-2">
                          <input type="text" value={row.key} onChange={(e) => { setCodexEnvRows((prev) => prev.map((r, i) => (i === index ? { ...r, key: e.target.value } : r))); setCodexEnvSaveResult(null) }} placeholder="NAME" spellCheck={false} className="w-44 bg-panel border border-border-strong rounded px-2 py-1.5 text-xs text-fg-bright placeholder-faint outline-none focus:border-fg font-mono" />
                          <span className="text-dim text-xs">=</span>
                          <input type={revealed ? 'text' : 'password'} value={row.value} onChange={(e) => { setCodexEnvRows((prev) => prev.map((r, i) => (i === index ? { ...r, value: e.target.value } : r))); setCodexEnvSaveResult(null) }} placeholder="value" spellCheck={false} className="flex-1 bg-panel border border-border-strong rounded px-2 py-1.5 text-xs text-fg-bright placeholder-faint outline-none focus:border-fg font-mono" />
                          <Tooltip label={revealed ? 'Hide value' : 'Reveal value'}><button onClick={() => setCodexRevealedEnvRows((prev) => { const next = new Set(prev); if (next.has(index)) next.delete(index); else next.add(index); return next })} className="p-1.5 text-dim hover:text-fg transition-colors cursor-pointer">{revealed ? <EyeOff size={14} /> : <Eye size={14} />}</button></Tooltip>
                          <Tooltip label="Remove"><button onClick={() => { setCodexEnvRows((prev) => prev.filter((_, i) => i !== index)); setCodexEnvSaveResult(null) }} className="p-1.5 text-dim hover:text-danger transition-colors cursor-pointer"><Trash2 size={14} /></button></Tooltip>
                        </div>
                      )
                    })}
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <button onClick={() => { setCodexEnvRows((prev) => [...prev, { key: '', value: '' }]); setCodexEnvSaveResult(null) }} className="flex items-center gap-1 px-3 py-1.5 bg-surface hover:bg-surface-hover rounded text-sm text-fg-bright transition-colors cursor-pointer"><Plus size={12} />Add variable</button>
                  <button onClick={handleSaveCodexEnvVars} className="px-3 py-1.5 bg-surface hover:bg-surface-hover rounded text-sm text-fg-bright transition-colors cursor-pointer">Save</button>
                </div>
                {codexEnvSaveResult && (
                  <div className={`mt-3 text-xs flex items-center gap-1.5 ${codexEnvSaveResult.ok ? 'text-success' : 'text-danger'}`}>
                    {codexEnvSaveResult.ok ? <Check size={12} /> : <X size={12} />}{codexEnvSaveResult.message}
                  </div>
                )}
              </div>
              </div>

              {/* ── System prompt subsection ── */}
              <h3 className="text-sm font-semibold text-fg-bright mt-6 mb-3">
                System prompt
              </h3>
              <div className="bg-panel-raised border border-border rounded-lg p-4">
                <label className="flex items-start gap-2 cursor-pointer mb-4">
                  <input
                    type="checkbox"
                    checked={harnessSystemPromptEnabled}
                    onChange={(e) => { void window.api.setHarnessSystemPromptEnabled(e.target.checked) }}
                    className="mt-0.5 cursor-pointer"
                  />
                  <div className="flex-1">
                    <div className="text-sm text-fg-bright">Inject Harness context into Claude sessions</div>
                    <div className="text-xs text-dim mt-0.5">
                      Appends <code className="bg-panel px-1 rounded text-[10px]">--append-system-prompt</code> with context about Harness and MCP tools.
                    </div>
                  </div>
                </label>

                {harnessSystemPromptEnabled && (
                  <>
                    <div className="mb-4">
                      <label className="block text-xs font-medium text-fg mb-1">Base prompt</label>
                      <p className="text-[11px] text-dim mb-2">Sent to every Claude session.</p>
                      <textarea
                        value={systemPromptDraft}
                        onChange={(e) => setSystemPromptDraft(e.target.value)}
                        rows={6}
                        spellCheck={false}
                        className="w-full bg-panel border border-border-strong rounded px-3 py-2 text-xs text-fg-bright placeholder-faint outline-none focus:border-fg font-mono resize-y"
                      />
                    </div>

                    <div className="mb-4">
                      <label className="block text-xs font-medium text-fg mb-1">Main worktree addition</label>
                      <p className="text-[11px] text-dim mb-2">Appended when Claude is running on the main/primary worktree.</p>
                      <textarea
                        value={systemPromptMainDraft}
                        onChange={(e) => setSystemPromptMainDraft(e.target.value)}
                        rows={4}
                        spellCheck={false}
                        className="w-full bg-panel border border-border-strong rounded px-3 py-2 text-xs text-fg-bright placeholder-faint outline-none focus:border-fg font-mono resize-y"
                      />
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        onClick={handleSaveSystemPrompt}
                        className="px-3 py-1.5 bg-surface hover:bg-surface-hover rounded text-sm text-fg-bright transition-colors cursor-pointer"
                      >
                        Save
                      </button>
                      <button
                        onClick={handleResetSystemPrompt}
                        className="flex items-center gap-1 px-3 py-1.5 text-sm text-dim hover:text-fg transition-colors cursor-pointer"
                      >
                        <RotateCcw size={12} />
                        Reset to defaults
                      </button>
                    </div>
                    {systemPromptSaveResult && (
                      <div className={`mt-3 text-xs flex items-center gap-1.5 ${systemPromptSaveResult.ok ? 'text-success' : 'text-danger'}`}>
                        {systemPromptSaveResult.ok ? <Check size={12} /> : <X size={12} />}{systemPromptSaveResult.message}
                      </div>
                    )}
                    <p className="mt-3 text-[11px] text-faint">Changes apply to new sessions only.</p>
                  </>
                )}
              </div>
            </section>

            {/* Worktrees section */}
            <section ref={(el) => { sectionRefs.current.worktrees = el }} id="worktrees">
              <h2 className="text-lg font-semibold text-fg-bright mb-1">Worktrees</h2>
              <p className="text-sm text-dim mb-4">
                Controls how new worktrees are created from the sidebar.
              </p>

              {repoList.length > 0 && (
                <div className="mb-4">
                  <div className="flex items-center gap-1 text-[11px] text-faint mb-1.5 uppercase tracking-wide">
                    Scope
                  </div>
                  <div className="flex flex-wrap gap-1 bg-panel-raised border border-border rounded p-1">
                    <button
                      onClick={() => setScopeRepoRoot(null)}
                      className={`px-2.5 py-1 rounded text-xs transition-colors cursor-pointer ${
                        scopeRepoRoot === null
                          ? 'bg-surface text-fg-bright'
                          : 'text-dim hover:text-fg'
                      }`}
                    >
                      Global
                    </button>
                    {repoList.map((r) => (
                      <button
                        key={r}
                        onClick={() => setScopeRepoRoot(r)}
                        className={`px-2.5 py-1 rounded text-xs font-mono transition-colors cursor-pointer ${
                          scopeRepoRoot === r
                            ? 'bg-surface text-fg-bright'
                            : 'text-dim hover:text-fg'
                        }`}
                        title={r}
                      >
                        {repoBasename(r)}
                      </button>
                    ))}
                  </div>
                  <p className="text-[11px] text-faint mt-1.5">
                    {scopeRepoRoot
                      ? <>Editing <code className="bg-panel-raised px-1 rounded">.harness.json</code> in <span className="font-mono">{repoBasename(scopeRepoRoot)}</span>. Unset fields inherit from global. You can commit this file to share settings with teammates.</>
                      : 'Editing global settings. Individual repos can override these values via their .harness.json file.'}
                  </p>
                </div>
              )}
              {scopeRepoRoot === null && (
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
              )}

              <div className="flex items-center justify-between mt-6 mb-1">
                <h3 className="text-sm font-semibold text-fg-bright">Default merge strategy</h3>
                {scopeRepoRoot === null && reposOverridingKey('mergeStrategy').length > 0 && (
                  <span className="text-[10px] text-warning bg-warning/10 border border-warning/30 rounded px-1.5 py-0.5">
                    Overridden in {reposOverridingKey('mergeStrategy').map(repoBasename).join(', ')}
                  </span>
                )}
                {scopeRepoRoot !== null && scopedMergeStrategyIsOverride && (
                  <button
                    onClick={handleResetMergeStrategyToGlobal}
                    className="text-[10px] text-dim hover:text-fg underline cursor-pointer"
                  >
                    Reset to global
                  </button>
                )}
              </div>
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
                  const isActive = displayedMergeStrategy === opt.id
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

              <h3 className="text-sm font-semibold text-fg-bright mt-6 mb-1">Setup & teardown scripts</h3>
              <p className="text-xs text-dim mb-3">
                Optional shell commands run via a login shell
                (<code className="bg-panel-raised px-1 rounded text-[10px]">zsh -ilc</code>) with
                the worktree as <code className="bg-panel-raised px-1 rounded text-[10px]">cwd</code>.
                Setup runs after a worktree is created; teardown runs before it's removed.
                The env vars{' '}
                <code className="bg-panel-raised px-1 rounded text-[10px]">HARNESS_WORKTREE_PATH</code>,{' '}
                <code className="bg-panel-raised px-1 rounded text-[10px]">HARNESS_BRANCH</code>, and{' '}
                <code className="bg-panel-raised px-1 rounded text-[10px]">HARNESS_REPO_ROOT</code>{' '}
                are available to the command.
              </p>

              <div className="flex items-center justify-between mb-1">
                <label className="block text-xs text-dim">Setup command</label>
                {scopeRepoRoot === null && reposOverridingKey('setupCommand').length > 0 && (
                  <span className="text-[10px] text-warning bg-warning/10 border border-warning/30 rounded px-1.5 py-0.5">
                    Overridden in {reposOverridingKey('setupCommand').map(repoBasename).join(', ')}
                  </span>
                )}
                {scopeRepoRoot !== null && scopedSetupIsOverride && (
                  <button
                    onClick={handleResetSetupToGlobal}
                    className="text-[10px] text-dim hover:text-fg underline cursor-pointer"
                  >
                    Reset to global
                  </button>
                )}
              </div>
              <textarea
                value={setupDraft}
                onChange={(e) => setSetupDraft(e.target.value)}
                placeholder={
                  scopeRepoRoot && setupScript
                    ? `Inherits from global: ${setupScript}`
                    : 'e.g. npm install --legacy-peer-deps'
                }
                rows={3}
                className="w-full bg-panel border border-border-strong rounded px-3 py-2 text-sm text-fg-bright placeholder-faint outline-none focus:border-fg font-mono resize-y"
              />

              <div className="flex items-center justify-between mt-3 mb-1">
                <label className="block text-xs text-dim">Teardown command</label>
                {scopeRepoRoot === null && reposOverridingKey('teardownCommand').length > 0 && (
                  <span className="text-[10px] text-warning bg-warning/10 border border-warning/30 rounded px-1.5 py-0.5">
                    Overridden in {reposOverridingKey('teardownCommand').map(repoBasename).join(', ')}
                  </span>
                )}
                {scopeRepoRoot !== null && scopedTeardownIsOverride && (
                  <button
                    onClick={handleResetTeardownToGlobal}
                    className="text-[10px] text-dim hover:text-fg underline cursor-pointer"
                  >
                    Reset to global
                  </button>
                )}
              </div>
              <textarea
                value={teardownDraft}
                onChange={(e) => setTeardownDraft(e.target.value)}
                placeholder={
                  scopeRepoRoot && teardownScript
                    ? `Inherits from global: ${teardownScript}`
                    : 'e.g. docker compose down'
                }
                rows={3}
                className="w-full bg-panel border border-border-strong rounded px-3 py-2 text-sm text-fg-bright placeholder-faint outline-none focus:border-fg font-mono resize-y"
              />

              <div className="flex items-center gap-2 mt-3">
                <button
                  onClick={handleSaveWorktreeScripts}
                  className="px-3 py-1.5 bg-surface hover:bg-surface-hover rounded text-sm text-fg-bright transition-colors cursor-pointer"
                >
                  Save
                </button>
                {scriptsSaveResult && (
                  <span className={`text-xs flex items-center gap-1.5 ${scriptsSaveResult.ok ? 'text-success' : 'text-danger'}`}>
                    {scriptsSaveResult.ok ? <Check size={12} /> : <X size={12} />}
                    {scriptsSaveResult.message}
                  </span>
                )}
              </div>
              <p className="mt-2 text-[11px] text-faint">
                Failures are logged but don't block the worktree operation. Leave blank to disable.
              </p>

              {scopeRepoRoot === null && (
                <>
                  <h3 className="text-sm font-semibold text-fg-bright mt-6 mb-1">Share Claude Code permissions</h3>
                  <p className="text-xs text-dim mb-3">
                    Symlink each worktree's{' '}
                    <code className="bg-panel-raised px-1 rounded text-[10px]">.claude/settings.local.json</code>{' '}
                    to the main worktree's copy so "Don't ask again"
                    permissions granted in any worktree apply everywhere.
                    Only takes effect for worktrees created while enabled
                    (plus a one-shot boot migration of existing ones).
                  </p>
                  <label className="flex items-center gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={shareClaudeSettings}
                      onChange={(e) => { void window.api.setShareClaudeSettings(e.target.checked) }}
                      className="accent-current w-4 h-4 cursor-pointer"
                    />
                    <span className="text-sm text-fg">
                      Share settings.local.json across worktrees
                    </span>
                  </label>
                </>
              )}

              {scopeRepoRoot !== null && (
                <div className="mt-6 pt-5 border-t border-border">
                  <label className="block text-sm text-fg-bright mb-1">Right-panel visibility</label>
                  <p className="text-xs text-dim">
                    Toggle individual panels from the right-column toolbar in the main window.
                  </p>
                </div>
              )}
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
              {(() => {
                const authed = hasToken || authSource === 'gh-cli'
                return (
              <>
              <h2 className={`text-lg font-semibold mb-1 ${!authed ? 'text-info' : 'text-fg-bright'}`}>GitHub</h2>
              <p className={`text-sm mb-4 ${!authed ? 'text-info/80' : 'text-dim'}`}>
                Harness fetches PR status and check results from GitHub. If you have the
                {' '}<code className="bg-panel-raised px-1 rounded">gh</code> CLI installed and authenticated,
                it'll be used automatically. Otherwise, paste a personal access token below — it'll be
                encrypted and stored locally using your macOS keychain.
              </p>

              {authed && harnessStarred !== null && (
                <label className="mb-4 flex items-center gap-2 cursor-pointer group">
                  <input
                    type="checkbox"
                    checked={harnessStarred}
                    onChange={(e) => { void window.api.setHarnessStarred(e.target.checked) }}
                    className="w-3.5 h-3.5 accent-warning cursor-pointer"
                  />
                  <Star
                    size={14}
                    className={harnessStarred ? 'text-warning fill-warning shrink-0' : 'text-warning shrink-0'}
                  />
                  <span className="text-sm text-fg group-hover:text-fg-bright transition-colors">
                    Star Harness on GitHub
                  </span>
                </label>
              )}

              {authSource === 'gh-cli' && !hasToken && (
                <div className="mb-4 rounded-lg p-4 border bg-success/10 border-success/30">
                  <div className="flex items-center gap-2 text-sm text-success">
                    <Check size={14} />
                    <span>Using <code className="bg-panel-raised px-1 rounded">gh</code> CLI token (auto-detected)</span>
                  </div>
                  {!showPatForm && (
                    <button
                      onClick={() => setShowPatForm(true)}
                      className="mt-3 text-xs text-muted hover:text-fg-bright underline cursor-pointer"
                    >
                      Use a personal access token instead
                    </button>
                  )}
                </div>
              )}

              {(authSource !== 'gh-cli' || hasToken || showPatForm) && (
              <div className={`rounded-lg p-4 border ${!authed ? 'bg-info/10 border-info/30' : 'bg-panel-raised border-border'}`}>
                <label className="block text-sm font-medium text-fg mb-2">
                  Personal Access Token
                </label>

                {hasToken && (
                  <div className="flex items-center gap-2 mb-3 text-xs text-success">
                    <Check size={14} />
                    <span>A token is currently saved {authSource === 'pat' ? '(in use)' : ''}</span>
                  </div>
                )}

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
              )}

              {(authSource !== 'gh-cli' || hasToken || showPatForm) && (
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
              )}
              </>
                )
              })()}
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
                {autoUpdateEnabled
                  ? 'Harness checks for updates automatically on startup and every 10 minutes.'
                  : 'Automatic update checks are disabled. Use the button below to check manually.'}
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

                <div className="mt-4 pt-3 border-t border-border">
                  <label className="flex items-start gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={autoUpdateEnabled}
                      onChange={(e) => handleToggleAutoUpdate(e.target.checked)}
                      className="mt-0.5 cursor-pointer"
                    />
                    <div className="flex-1">
                      <div className="text-sm text-fg-bright">Check for updates automatically</div>
                      <div className="text-xs text-dim mt-0.5">
                        When enabled, Harness checks for new releases on startup and every
                        10 minutes. Disable to only check when you press the button above.
                      </div>
                    </div>
                  </label>
                </div>
              </div>

              <div className="mt-3 text-xs text-dim">
                <a
                  onClick={() => window.api.openExternal(HARNESS_RELEASES_URL)}
                  className="text-muted hover:text-fg-bright underline cursor-pointer"
                >
                  View all releases on GitHub
                </a>
              </div>
            </section>

            {/* Support section */}
            <section ref={(el) => { sectionRefs.current.support = el }} id="support">
              <h2 className="text-lg font-semibold text-fg-bright mb-1">Support</h2>
              <p className="text-sm text-dim mb-4">
                Found a bug or want to request a feature? Let us know on GitHub.
              </p>

              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => openReportIssue({ kind: 'bug' })}
                  className="flex items-center gap-2 px-3 py-2 bg-panel-raised border border-border rounded-lg text-sm text-fg-bright hover:bg-surface transition-colors cursor-pointer"
                >
                  <Bug size={14} />
                  Report a bug
                </button>
                <button
                  type="button"
                  onClick={() => openReportIssue({ kind: 'feature' })}
                  className="flex items-center gap-2 px-3 py-2 bg-panel-raised border border-border rounded-lg text-sm text-fg-bright hover:bg-surface transition-colors cursor-pointer"
                >
                  <Lightbulb size={14} />
                  Request a feature
                </button>
              </div>

              <p className="mt-3 text-xs text-dim">
                Opens a prefilled GitHub issue in your browser. No data is sent from Harness directly.
              </p>
            </section>
          </div>
        </div>
      </div>
    </div>
  )
}

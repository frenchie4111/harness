import type { JsonClaudePermissionMode } from './json-claude'

export interface WorktreeScripts {
  setup: string
  teardown: string
}

export type MergeStrategy = 'squash' | 'merge-commit' | 'fast-forward'
export type WorktreeBase = 'remote' | 'local'
export type WorktreeDetail = 'diff' | 'age' | 'pr' | 'none'

export type AgentKindSetting = 'claude' | 'codex'

export type BrowserToolsMode = 'view' | 'full'

export type JsonModeChatDensity = 'compact' | 'comfy'

/** Five-step UI density. Controls the root `html` font-size so every
 *  `rem`-based unit (and therefore the entire `text-xs` / `text-sm` /
 *  `text-base` / `text-lg` scale and every `w-N` / `h-N` icon) shifts
 *  together. See SCALES below for the authoritative table — adding a
 *  sixth rung later is a one-line change there. */
export type UiScale = 'x-small' | 'small' | 'medium' | 'large' | 'x-large'

export interface UiScaleSpec {
  id: UiScale
  label: string
  rootPx: number
  /** Pixels added to the user's `terminalFontSize` so xterm stays in
   *  proportion with the rest of the UI. XTerminal and the Settings
   *  preview both read from this same table. */
  terminalOffset: number
}

export const SCALES: readonly UiScaleSpec[] = [
  { id: 'x-small', label: 'X-Small', rootPx: 14, terminalOffset: -2 },
  { id: 'small', label: 'Small', rootPx: 16, terminalOffset: 0 },
  { id: 'medium', label: 'Medium', rootPx: 18, terminalOffset: 2 },
  { id: 'large', label: 'Large', rootPx: 20, terminalOffset: 4 },
  { id: 'x-large', label: 'X-Large', rootPx: 22, terminalOffset: 6 }
] as const

export function scaleSpec(id: UiScale): UiScaleSpec {
  return SCALES.find((s) => s.id === id) ?? SCALES[0]
}

/** The pixel font-size a code editor / terminal should use at a given UI
 *  scale: the user's configured `terminalFontSize` shifted by the scale's
 *  `terminalOffset` so Monaco and xterm stay in proportion with the rest of
 *  the rem-scaled UI. Monaco consumers (DiffView / FileView / ReviewDiffPane)
 *  and XTerminal both go through this — passing the raw setting instead makes
 *  the editor ignore `uiScale`. */
export function scaledEditorFontSize(
  terminalFontSize: number | undefined,
  uiScale: UiScale
): number {
  return (terminalFontSize || 13) + scaleSpec(uiScale).terminalOffset
}

export type ThemeMode = 'light' | 'dark' | 'system'

/** A theme loaded from `<userData>/themes/*.json`. Stays minimal — the
 *  loader only validates `name` + `mode` + an optional `colors` map of the
 *  16 semantic keys; missing keys inherit from the default of that mode at
 *  apply time. */
export interface CustomTheme {
  /** Derived from filename, sanitized to `[a-z0-9-]`. Unique across the
   *  set (collisions are dropped by the loader). */
  id: string
  /** Display label from the file's `name` field. */
  name: string
  mode: 'light' | 'dark'
  /** Partial map of semantic color keys → CSS color string. The loader
   *  doesn't enforce which keys are present — apply just sets whichever
   *  are listed. */
  colors: Record<string, string>
}

/** Shared empty-array reference so the initial reducer and "no themes on
 *  disk" outcomes return the same array — keeps `useMemo` deps stable in
 *  components reading the slice. */
export const EMPTY_CUSTOM_THEMES: CustomTheme[] = []

/** Built-in theme ids used as the per-mode default when nothing else
 *  applies — the seed value for `themeLight`/`themeDark`, the IPC "this
 *  matches the default so don't persist it" guard, and the fallback
 *  `[data-theme]` selector for partial custom themes. Kept in shared so
 *  main and renderer agree without crossing the import boundary. */
export const DEFAULT_LIGHT_THEME = 'solarized-light'
export const DEFAULT_DARK_THEME = 'dark'

/** Default kickoff prompt for "Open PR as worktree". Editable globally in
 *  Settings (`prReviewPrompt`) and per-creation in the New Worktree screen. */
export const DEFAULT_PR_REVIEW_PROMPT =
  "Review this PR. Read the diff, then check for correctness issues, design problems, security concerns, and missing edge cases. Cite file paths and line numbers for anything you flag. Skip restating what the PR does — focus on what could go wrong or be improved."

export interface SettingsState {
  /** Whether the active theme is the light theme, the dark theme, or follows
   *  the OS appearance. Default 'system'. */
  themeMode: ThemeMode
  /** Theme id used when `themeMode` resolves to 'light'. */
  themeLight: string
  /** Theme id used when `themeMode` resolves to 'dark'. */
  themeDark: string
  /** User-authored themes loaded from `<userData>/themes/*.json` at boot
   *  (and on reload). Replaced wholesale on rescan — array reference
   *  changes only when the on-disk contents actually change. */
  customThemes: CustomTheme[]
  hotkeys: Record<string, string> | null
  defaultAgent: AgentKindSetting
  claudeCommand: string
  codexCommand: string
  worktreeScripts: WorktreeScripts
  claudeEnvVars: Record<string, string>
  codexEnvVars: Record<string, string>
  harnessMcpEnabled: boolean
  nameClaudeSessions: boolean
  terminalFontFamily: string
  terminalFontSize: number
  editor: string
  worktreeBase: WorktreeBase
  mergeStrategy: MergeStrategy
  worktreeDetail: WorktreeDetail
  shareClaudeSettings: boolean
  claudeModel: string | null
  codexModel: string | null
  hasGithubToken: boolean
  githubAuthSource: 'pat' | 'gh-cli' | null
  /** GitHub login of the user whose token is configured. Resolved at
   *  boot via a /user call once the token is available. Used by the
   *  sidebar to bucket PRs you didn't author into the Reviewing group;
   *  null until resolved or when the token is missing/invalid. */
  viewerLogin: string | null
  harnessStarred: boolean | null
  autoUpdateEnabled: boolean
  /** When true (default), ⌘Q must be held briefly to quit (Chrome-style
   *  "Warn Before Quitting"); a tap shows a toast and does nothing. When
   *  false, ⌘Q quits immediately. */
  warnBeforeQuitting: boolean
  harnessSystemPromptEnabled: boolean
  harnessSystemPrompt: string
  harnessSystemPromptMain: string
  claudeTuiFullscreen: boolean
  wsTransportEnabled: boolean
  wsTransportPort: number
  wsTransportHost: string
  browserToolsEnabled: boolean
  browserToolsMode: BrowserToolsMode
  /** Controls whether new Claude tabs spawn as the terminal-hosted TUI
   *  ('xterm') or the React chat interface ('json'). Internal values are
   *  unchanged; the user-facing label is "Terminal" / "Chat". */
  defaultClaudeTabType: 'xterm' | 'json'
  /** True once the user clicks the X on the "Switch to the new Chat
   *  mode" overlay shown on Terminal Claude tabs. Persistent so the
   *  promotion stays dismissed across reloads. */
  chatPromotionDismissed: boolean
  /** When true, JSON-mode tabs run a Haiku oneshot to auto-approve
   *  obviously-safe tool calls instead of prompting the user. Productivity
   *  feature only — an LLM judging another LLM is not a security boundary.
   *  A hardcoded deny-list catches the high-blast-radius cases (rm -rf,
   *  git push, web fetch, etc.) before Haiku is ever consulted. Default
   *  off. */
  autoApprovePermissions: boolean
  /** Optional project-specific guidance appended to the auto-approver's
   *  policy prompt (after the hardcoded safety preamble). Useful for
   *  per-project carve-outs like "approve `npm install` on this repo"
   *  or "be especially strict about Bash that writes outside src/".
   *  Empty by default — the base policy is what runs. Has no effect
   *  unless autoApprovePermissions is on. */
  autoApproveSteerInstructions: string
  /** Diagnostic toggle (no UI): when true, json-mode tabs spawn the user's
   *  PATH `claude` instead of the bundled one. Default off. */
  useSystemClaudeForJsonMode: boolean
  /** Visual density of the JSON-mode chat. 'compact' (default) keeps the
   *  power-user defaults; 'comfy' bumps font sizes, padding, and corner
   *  radius for newcomers / screen-sharing. Wired via CSS variables on
   *  the chat root, so it's a pure styling switch. */
  jsonModeChatDensity: JsonModeChatDensity
  /** Global UI density. Maps to a root `html` font-size — see SCALES. */
  uiScale: UiScale
  /** When true, plain Enter sends a message in the JSON-mode chat
   *  composer (Shift+Enter inserts a newline). When false (default),
   *  the historical behavior applies: Cmd/Ctrl+Enter sends and plain
   *  Enter inserts a newline. */
  jsonModeSendOnEnter: boolean
  /** Permission mode applied to a freshly-spawned json-mode session.
   *  Existing sessions keep whatever mode they were in (set via the
   *  statusline picker). Default 'acceptEdits' so first-time users
   *  don't get a wall of approval cards for routine edits; Bash and
   *  other risky tools still surface approvals. */
  jsonModeDefaultPermissionMode: JsonClaudePermissionMode
  /** Minutes a json-mode tab can sit at the yellow "waiting" dot before
   *  the auto-sleep monitor tears its subprocess down. The slept tab
   *  stays in the tree (history intact) and re-spawns on click. 0
   *  disables auto-sleep entirely. */
  autoSleepMinutes: number
  snoozeDefaultDays: number
  /** When true, high-volume diagnostic categories are written to
   *  debug.log — currently per-GitHub-API-call `[github-api]` lines (URL,
   *  method, status, duration). Off by default because the per-call
   *  volume is high during PR refresh bursts. HUD metrics like "GH API"
   *  rate are always on regardless of this flag. */
  expandedDiagnosticLoggingEnabled: boolean
  /** Default prompt pre-filled into the "Open PR as worktree" screen and
   *  used as the kickoff prompt when an MCP `create_worktree` call provides
   *  a `prNumber` without an explicit `initialPrompt`. The textarea on the
   *  PR-creation screen is seeded from this value but edits there are
   *  one-shot — managing the default happens in Settings. */
  prReviewPrompt: string
  /** Announcement ids the user has dismissed with the per-banner `×`.
   *  Used to filter the fetched feed down to the most recent unseen
   *  entry. Append-only — we never garbage-collect because entries fall
   *  out of the feed on their own once they expire. */
  dismissedAnnouncementIds: string[]
  /** When true, all announcement banners are suppressed regardless of
   *  the feed contents. Set by the "Hide all announcements" action and
   *  cleared only by the user. */
  announcementsMuted: boolean
}

export type SettingsEvent =
  | { type: 'settings/themeModeChanged'; payload: ThemeMode }
  | { type: 'settings/themeLightChanged'; payload: string }
  | { type: 'settings/themeDarkChanged'; payload: string }
  | { type: 'settings/customThemesChanged'; payload: CustomTheme[] }
  | { type: 'settings/hotkeysChanged'; payload: Record<string, string> | null }
  | { type: 'settings/defaultAgentChanged'; payload: AgentKindSetting }
  | { type: 'settings/claudeCommandChanged'; payload: string }
  | { type: 'settings/codexCommandChanged'; payload: string }
  | { type: 'settings/worktreeScriptsChanged'; payload: WorktreeScripts }
  | { type: 'settings/claudeEnvVarsChanged'; payload: Record<string, string> }
  | { type: 'settings/codexEnvVarsChanged'; payload: Record<string, string> }
  | { type: 'settings/harnessMcpEnabledChanged'; payload: boolean }
  | { type: 'settings/nameClaudeSessionsChanged'; payload: boolean }
  | { type: 'settings/terminalFontFamilyChanged'; payload: string }
  | { type: 'settings/terminalFontSizeChanged'; payload: number }
  | { type: 'settings/editorChanged'; payload: string }
  | { type: 'settings/worktreeBaseChanged'; payload: WorktreeBase }
  | { type: 'settings/mergeStrategyChanged'; payload: MergeStrategy }
  | { type: 'settings/worktreeDetailChanged'; payload: WorktreeDetail }
  | { type: 'settings/shareClaudeSettingsChanged'; payload: boolean }
  | { type: 'settings/hasGithubTokenChanged'; payload: boolean }
  | { type: 'settings/githubAuthSourceChanged'; payload: 'pat' | 'gh-cli' | null }
  | { type: 'settings/viewerLoginChanged'; payload: string | null }
  | { type: 'settings/harnessStarredChanged'; payload: boolean | null }
  | { type: 'settings/claudeModelChanged'; payload: string | null }
  | { type: 'settings/codexModelChanged'; payload: string | null }
  | { type: 'settings/autoUpdateEnabledChanged'; payload: boolean }
  | { type: 'settings/warnBeforeQuittingChanged'; payload: boolean }
  | { type: 'settings/harnessSystemPromptEnabledChanged'; payload: boolean }
  | { type: 'settings/harnessSystemPromptChanged'; payload: string }
  | { type: 'settings/harnessSystemPromptMainChanged'; payload: string }
  | { type: 'settings/claudeTuiFullscreenChanged'; payload: boolean }
  | { type: 'settings/wsTransportEnabledChanged'; payload: boolean }
  | { type: 'settings/wsTransportPortChanged'; payload: number }
  | { type: 'settings/wsTransportHostChanged'; payload: string }
  | { type: 'settings/browserToolsEnabledChanged'; payload: boolean }
  | { type: 'settings/browserToolsModeChanged'; payload: BrowserToolsMode }
  | { type: 'settings/defaultClaudeTabTypeChanged'; payload: 'xterm' | 'json' }
  | { type: 'settings/chatPromotionDismissedChanged'; payload: boolean }
  | { type: 'settings/autoApprovePermissionsChanged'; payload: boolean }
  | { type: 'settings/autoApproveSteerInstructionsChanged'; payload: string }
  | { type: 'settings/useSystemClaudeForJsonModeChanged'; payload: boolean }
  | { type: 'settings/jsonModeChatDensityChanged'; payload: JsonModeChatDensity }
  | { type: 'settings/uiScaleChanged'; payload: UiScale }
  | { type: 'settings/jsonModeSendOnEnterChanged'; payload: boolean }
  | {
      type: 'settings/jsonModeDefaultPermissionModeChanged'
      payload: JsonClaudePermissionMode
    }
  | { type: 'settings/autoSleepMinutesChanged'; payload: number }
  | { type: 'settings/snoozeDefaultDaysChanged'; payload: number }
  | { type: 'settings/expandedDiagnosticLoggingEnabledChanged'; payload: boolean }
  | { type: 'settings/prReviewPromptChanged'; payload: string }
  | { type: 'settings/announcementDismissed'; payload: string }
  | { type: 'settings/announcementsMutedChanged'; payload: boolean }

// Client-side placeholder. Real values are seeded in the main-process Store
// constructor from the on-disk config and secrets.
export const initialSettings: SettingsState = {
  themeMode: 'system',
  themeLight: DEFAULT_LIGHT_THEME,
  themeDark: DEFAULT_DARK_THEME,
  customThemes: EMPTY_CUSTOM_THEMES,
  hotkeys: null,
  defaultAgent: 'claude',
  claudeCommand: '',
  codexCommand: '',
  worktreeScripts: { setup: '', teardown: '' },
  claudeEnvVars: {},
  codexEnvVars: {},
  harnessMcpEnabled: true,
  nameClaudeSessions: false,
  terminalFontFamily: '',
  terminalFontSize: 13,
  editor: 'vscode',
  worktreeBase: 'remote',
  mergeStrategy: 'squash',
  worktreeDetail: 'diff',
  shareClaudeSettings: true,
  claudeModel: null,
  codexModel: null,
  hasGithubToken: false,
  githubAuthSource: null,
  viewerLogin: null,
  harnessStarred: null,
  autoUpdateEnabled: true,
  warnBeforeQuitting: true,
  harnessSystemPromptEnabled: true,
  harnessSystemPrompt: '',
  harnessSystemPromptMain: '',
  claudeTuiFullscreen: true,
  wsTransportEnabled: false,
  wsTransportPort: 37291,
  wsTransportHost: '127.0.0.1',
  browserToolsEnabled: true,
  browserToolsMode: 'full',
  defaultClaudeTabType: 'xterm',
  chatPromotionDismissed: false,
  autoApprovePermissions: false,
  autoApproveSteerInstructions: '',
  useSystemClaudeForJsonMode: false,
  jsonModeChatDensity: 'compact',
  uiScale: 'small',
  jsonModeSendOnEnter: false,
  jsonModeDefaultPermissionMode: 'acceptEdits',
  autoSleepMinutes: 30,
  snoozeDefaultDays: 7,
  expandedDiagnosticLoggingEnabled: false,
  prReviewPrompt: DEFAULT_PR_REVIEW_PROMPT,
  dismissedAnnouncementIds: [],
  announcementsMuted: false
}

export function settingsReducer(state: SettingsState, event: SettingsEvent): SettingsState {
  switch (event.type) {
    case 'settings/themeModeChanged':
      return { ...state, themeMode: event.payload }
    case 'settings/themeLightChanged':
      return { ...state, themeLight: event.payload }
    case 'settings/themeDarkChanged':
      return { ...state, themeDark: event.payload }
    case 'settings/customThemesChanged':
      return { ...state, customThemes: event.payload }
    case 'settings/hotkeysChanged':
      return { ...state, hotkeys: event.payload }
    case 'settings/defaultAgentChanged':
      return { ...state, defaultAgent: event.payload }
    case 'settings/claudeCommandChanged':
      return { ...state, claudeCommand: event.payload }
    case 'settings/codexCommandChanged':
      return { ...state, codexCommand: event.payload }
    case 'settings/worktreeScriptsChanged':
      return { ...state, worktreeScripts: event.payload }
    case 'settings/claudeEnvVarsChanged':
      return { ...state, claudeEnvVars: event.payload }
    case 'settings/codexEnvVarsChanged':
      return { ...state, codexEnvVars: event.payload }
    case 'settings/harnessMcpEnabledChanged':
      return { ...state, harnessMcpEnabled: event.payload }
    case 'settings/nameClaudeSessionsChanged':
      return { ...state, nameClaudeSessions: event.payload }
    case 'settings/terminalFontFamilyChanged':
      return { ...state, terminalFontFamily: event.payload }
    case 'settings/terminalFontSizeChanged':
      return { ...state, terminalFontSize: event.payload }
    case 'settings/editorChanged':
      return { ...state, editor: event.payload }
    case 'settings/worktreeBaseChanged':
      return { ...state, worktreeBase: event.payload }
    case 'settings/mergeStrategyChanged':
      return { ...state, mergeStrategy: event.payload }
    case 'settings/worktreeDetailChanged':
      return { ...state, worktreeDetail: event.payload }
    case 'settings/shareClaudeSettingsChanged':
      return { ...state, shareClaudeSettings: event.payload }
    case 'settings/hasGithubTokenChanged':
      return { ...state, hasGithubToken: event.payload }
    case 'settings/githubAuthSourceChanged':
      return { ...state, githubAuthSource: event.payload }
    case 'settings/viewerLoginChanged':
      return { ...state, viewerLogin: event.payload }
    case 'settings/harnessStarredChanged':
      return { ...state, harnessStarred: event.payload }
    case 'settings/claudeModelChanged':
      return { ...state, claudeModel: event.payload }
    case 'settings/codexModelChanged':
      return { ...state, codexModel: event.payload }
    case 'settings/autoUpdateEnabledChanged':
      return { ...state, autoUpdateEnabled: event.payload }
    case 'settings/warnBeforeQuittingChanged':
      return { ...state, warnBeforeQuitting: event.payload }
    case 'settings/harnessSystemPromptEnabledChanged':
      return { ...state, harnessSystemPromptEnabled: event.payload }
    case 'settings/harnessSystemPromptChanged':
      return { ...state, harnessSystemPrompt: event.payload }
    case 'settings/harnessSystemPromptMainChanged':
      return { ...state, harnessSystemPromptMain: event.payload }
    case 'settings/claudeTuiFullscreenChanged':
      return { ...state, claudeTuiFullscreen: event.payload }
    case 'settings/wsTransportEnabledChanged':
      return { ...state, wsTransportEnabled: event.payload }
    case 'settings/wsTransportPortChanged':
      return { ...state, wsTransportPort: event.payload }
    case 'settings/wsTransportHostChanged':
      return { ...state, wsTransportHost: event.payload }
    case 'settings/browserToolsEnabledChanged':
      return { ...state, browserToolsEnabled: event.payload }
    case 'settings/browserToolsModeChanged':
      return { ...state, browserToolsMode: event.payload }
    case 'settings/defaultClaudeTabTypeChanged':
      return { ...state, defaultClaudeTabType: event.payload }
    case 'settings/chatPromotionDismissedChanged':
      return { ...state, chatPromotionDismissed: event.payload }
    case 'settings/autoApprovePermissionsChanged':
      return { ...state, autoApprovePermissions: event.payload }
    case 'settings/autoApproveSteerInstructionsChanged':
      return { ...state, autoApproveSteerInstructions: event.payload }
    case 'settings/useSystemClaudeForJsonModeChanged':
      return { ...state, useSystemClaudeForJsonMode: event.payload }
    case 'settings/jsonModeChatDensityChanged':
      return { ...state, jsonModeChatDensity: event.payload }
    case 'settings/uiScaleChanged':
      return { ...state, uiScale: event.payload }
    case 'settings/jsonModeSendOnEnterChanged':
      return { ...state, jsonModeSendOnEnter: event.payload }
    case 'settings/jsonModeDefaultPermissionModeChanged':
      return { ...state, jsonModeDefaultPermissionMode: event.payload }
    case 'settings/autoSleepMinutesChanged':
      return { ...state, autoSleepMinutes: event.payload }
    case 'settings/snoozeDefaultDaysChanged':
      return { ...state, snoozeDefaultDays: event.payload }
    case 'settings/expandedDiagnosticLoggingEnabledChanged':
      return { ...state, expandedDiagnosticLoggingEnabled: event.payload }
    case 'settings/prReviewPromptChanged':
      return { ...state, prReviewPrompt: event.payload }
    case 'settings/announcementDismissed': {
      if (state.dismissedAnnouncementIds.includes(event.payload)) return state
      return {
        ...state,
        dismissedAnnouncementIds: [...state.dismissedAnnouncementIds, event.payload]
      }
    }
    case 'settings/announcementsMutedChanged':
      return { ...state, announcementsMuted: event.payload }
    default: {
      const _exhaustive: never = event
      void _exhaustive
      return state
    }
  }
}

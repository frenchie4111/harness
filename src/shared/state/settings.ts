export interface WorktreeScripts {
  setup: string
  teardown: string
}

export type MergeStrategy = 'squash' | 'merge-commit' | 'fast-forward'
export type WorktreeBase = 'remote' | 'local'

export type AgentKindSetting = 'claude' | 'codex'

export type BrowserToolsMode = 'view' | 'full'

export type JsonModeChatDensity = 'compact' | 'comfy'

export interface SettingsState {
  theme: string
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
  shareClaudeSettings: boolean
  claudeModel: string | null
  codexModel: string | null
  hasGithubToken: boolean
  githubAuthSource: 'pat' | 'gh-cli' | null
  harnessStarred: boolean | null
  autoUpdateEnabled: boolean
  harnessSystemPromptEnabled: boolean
  harnessSystemPrompt: string
  harnessSystemPromptMain: string
  claudeTuiFullscreen: boolean
  wsTransportEnabled: boolean
  wsTransportPort: number
  wsTransportHost: string
  browserToolsEnabled: boolean
  browserToolsMode: BrowserToolsMode
  /** Experimental: when true, render Claude tabs as a JSON-streamed React
   *  chat (json-claude tab type) instead of an xterm-hosted TUI. Off by
   *  default. See plans/json-mode-native-chat.md. */
  jsonModeClaudeTabs: boolean
  /** When `jsonModeClaudeTabs` is on, controls whether the Claude tab
   *  spawned by default is the xterm-hosted TUI or the JSON-mode React
   *  chat. Ignored when `jsonModeClaudeTabs` is off (always xterm). */
  defaultClaudeTabType: 'xterm' | 'json'
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
}

export type SettingsEvent =
  | { type: 'settings/themeChanged'; payload: string }
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
  | { type: 'settings/shareClaudeSettingsChanged'; payload: boolean }
  | { type: 'settings/hasGithubTokenChanged'; payload: boolean }
  | { type: 'settings/githubAuthSourceChanged'; payload: 'pat' | 'gh-cli' | null }
  | { type: 'settings/harnessStarredChanged'; payload: boolean | null }
  | { type: 'settings/claudeModelChanged'; payload: string | null }
  | { type: 'settings/codexModelChanged'; payload: string | null }
  | { type: 'settings/autoUpdateEnabledChanged'; payload: boolean }
  | { type: 'settings/harnessSystemPromptEnabledChanged'; payload: boolean }
  | { type: 'settings/harnessSystemPromptChanged'; payload: string }
  | { type: 'settings/harnessSystemPromptMainChanged'; payload: string }
  | { type: 'settings/claudeTuiFullscreenChanged'; payload: boolean }
  | { type: 'settings/wsTransportEnabledChanged'; payload: boolean }
  | { type: 'settings/wsTransportPortChanged'; payload: number }
  | { type: 'settings/wsTransportHostChanged'; payload: string }
  | { type: 'settings/browserToolsEnabledChanged'; payload: boolean }
  | { type: 'settings/browserToolsModeChanged'; payload: BrowserToolsMode }
  | { type: 'settings/jsonModeClaudeTabsChanged'; payload: boolean }
  | { type: 'settings/defaultClaudeTabTypeChanged'; payload: 'xterm' | 'json' }
  | { type: 'settings/autoApprovePermissionsChanged'; payload: boolean }
  | { type: 'settings/autoApproveSteerInstructionsChanged'; payload: string }
  | { type: 'settings/useSystemClaudeForJsonModeChanged'; payload: boolean }
  | { type: 'settings/jsonModeChatDensityChanged'; payload: JsonModeChatDensity }

// Client-side placeholder. Real values are seeded in the main-process Store
// constructor from the on-disk config and secrets.
export const initialSettings: SettingsState = {
  theme: 'dark',
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
  shareClaudeSettings: true,
  claudeModel: null,
  codexModel: null,
  hasGithubToken: false,
  githubAuthSource: null,
  harnessStarred: null,
  autoUpdateEnabled: true,
  harnessSystemPromptEnabled: true,
  harnessSystemPrompt: '',
  harnessSystemPromptMain: '',
  claudeTuiFullscreen: true,
  wsTransportEnabled: false,
  wsTransportPort: 37291,
  wsTransportHost: '127.0.0.1',
  browserToolsEnabled: true,
  browserToolsMode: 'full',
  jsonModeClaudeTabs: false,
  defaultClaudeTabType: 'xterm',
  autoApprovePermissions: false,
  autoApproveSteerInstructions: '',
  useSystemClaudeForJsonMode: false,
  jsonModeChatDensity: 'compact'
}

export function settingsReducer(state: SettingsState, event: SettingsEvent): SettingsState {
  switch (event.type) {
    case 'settings/themeChanged':
      return { ...state, theme: event.payload }
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
    case 'settings/shareClaudeSettingsChanged':
      return { ...state, shareClaudeSettings: event.payload }
    case 'settings/hasGithubTokenChanged':
      return { ...state, hasGithubToken: event.payload }
    case 'settings/githubAuthSourceChanged':
      return { ...state, githubAuthSource: event.payload }
    case 'settings/harnessStarredChanged':
      return { ...state, harnessStarred: event.payload }
    case 'settings/claudeModelChanged':
      return { ...state, claudeModel: event.payload }
    case 'settings/codexModelChanged':
      return { ...state, codexModel: event.payload }
    case 'settings/autoUpdateEnabledChanged':
      return { ...state, autoUpdateEnabled: event.payload }
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
    case 'settings/jsonModeClaudeTabsChanged':
      return { ...state, jsonModeClaudeTabs: event.payload }
    case 'settings/defaultClaudeTabTypeChanged':
      return { ...state, defaultClaudeTabType: event.payload }
    case 'settings/autoApprovePermissionsChanged':
      return { ...state, autoApprovePermissions: event.payload }
    case 'settings/autoApproveSteerInstructionsChanged':
      return { ...state, autoApproveSteerInstructions: event.payload }
    case 'settings/useSystemClaudeForJsonModeChanged':
      return { ...state, useSystemClaudeForJsonMode: event.payload }
    case 'settings/jsonModeChatDensityChanged':
      return { ...state, jsonModeChatDensity: event.payload }
    default: {
      const _exhaustive: never = event
      void _exhaustive
      return state
    }
  }
}

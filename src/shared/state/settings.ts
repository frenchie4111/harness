export interface WorktreeScripts {
  setup: string
  teardown: string
}

export type MergeStrategy = 'squash' | 'merge-commit' | 'fast-forward'
export type WorktreeBase = 'remote' | 'local'

export interface SettingsState {
  theme: string
  hotkeys: Record<string, string> | null
  claudeCommand: string
  worktreeScripts: WorktreeScripts
  claudeEnvVars: Record<string, string>
  harnessMcpEnabled: boolean
  nameClaudeSessions: boolean
  terminalFontFamily: string
  terminalFontSize: number
  editor: string
  worktreeBase: WorktreeBase
  mergeStrategy: MergeStrategy
  hasGithubToken: boolean
  githubAuthSource: 'pat' | 'gh-cli' | null
  harnessStarred: boolean | null
}

export type SettingsEvent =
  | { type: 'settings/themeChanged'; payload: string }
  | { type: 'settings/hotkeysChanged'; payload: Record<string, string> | null }
  | { type: 'settings/claudeCommandChanged'; payload: string }
  | { type: 'settings/worktreeScriptsChanged'; payload: WorktreeScripts }
  | { type: 'settings/claudeEnvVarsChanged'; payload: Record<string, string> }
  | { type: 'settings/harnessMcpEnabledChanged'; payload: boolean }
  | { type: 'settings/nameClaudeSessionsChanged'; payload: boolean }
  | { type: 'settings/terminalFontFamilyChanged'; payload: string }
  | { type: 'settings/terminalFontSizeChanged'; payload: number }
  | { type: 'settings/editorChanged'; payload: string }
  | { type: 'settings/worktreeBaseChanged'; payload: WorktreeBase }
  | { type: 'settings/mergeStrategyChanged'; payload: MergeStrategy }
  | { type: 'settings/hasGithubTokenChanged'; payload: boolean }
  | { type: 'settings/githubAuthSourceChanged'; payload: 'pat' | 'gh-cli' | null }
  | { type: 'settings/harnessStarredChanged'; payload: boolean | null }

// Client-side placeholder. Real values are seeded in the main-process Store
// constructor from the on-disk config and secrets.
export const initialSettings: SettingsState = {
  theme: 'dark',
  hotkeys: null,
  claudeCommand: '',
  worktreeScripts: { setup: '', teardown: '' },
  claudeEnvVars: {},
  harnessMcpEnabled: true,
  nameClaudeSessions: false,
  terminalFontFamily: '',
  terminalFontSize: 13,
  editor: 'vscode',
  worktreeBase: 'remote',
  mergeStrategy: 'squash',
  hasGithubToken: false,
  githubAuthSource: null,
  harnessStarred: null
}

export function settingsReducer(state: SettingsState, event: SettingsEvent): SettingsState {
  switch (event.type) {
    case 'settings/themeChanged':
      return { ...state, theme: event.payload }
    case 'settings/hotkeysChanged':
      return { ...state, hotkeys: event.payload }
    case 'settings/claudeCommandChanged':
      return { ...state, claudeCommand: event.payload }
    case 'settings/worktreeScriptsChanged':
      return { ...state, worktreeScripts: event.payload }
    case 'settings/claudeEnvVarsChanged':
      return { ...state, claudeEnvVars: event.payload }
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
    case 'settings/hasGithubTokenChanged':
      return { ...state, hasGithubToken: event.payload }
    case 'settings/githubAuthSourceChanged':
      return { ...state, githubAuthSource: event.payload }
    case 'settings/harnessStarredChanged':
      return { ...state, harnessStarred: event.payload }
    default: {
      const _exhaustive: never = event
      void _exhaustive
      return state
    }
  }
}

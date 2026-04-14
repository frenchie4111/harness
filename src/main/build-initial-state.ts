import type { AppState } from '../shared/state'
import { initialPRs } from '../shared/state/prs'
import { initialOnboarding } from '../shared/state/onboarding'
import { initialHooks } from '../shared/state/hooks'
import { initialWorktrees } from '../shared/state/worktrees'
import { initialTerminals } from '../shared/state/terminals'
import { initialUpdater } from '../shared/state/updater'
import { initialRepoConfigs } from '../shared/state/repo-configs'
import { initialSettings } from '../shared/state/settings'
import {
  DEFAULT_CLAUDE_COMMAND,
  DEFAULT_THEME,
  DEFAULT_TERMINAL_FONT_FAMILY,
  DEFAULT_TERMINAL_FONT_SIZE,
  DEFAULT_WORKTREE_BASE,
  DEFAULT_MERGE_STRATEGY,
  type Config
} from './persistence'
import { DEFAULT_EDITOR_ID } from './editor'

export function buildInitialAppState(
  config: Config,
  opts: { hasGithubToken: boolean }
): AppState {
  return {
    prs: initialPRs,
    onboarding: { ...initialOnboarding, quest: config.onboarding?.quest ?? 'hidden' },
    hooks: initialHooks,
    worktrees: { ...initialWorktrees, repoRoots: config.repoRoots || [] },
    terminals: initialTerminals,
    updater: initialUpdater,
    repoConfigs: initialRepoConfigs,
    settings: {
      ...initialSettings,
      theme: config.theme || DEFAULT_THEME,
      hotkeys: config.hotkeys || null,
      claudeCommand: config.claudeCommand || DEFAULT_CLAUDE_COMMAND,
      worktreeScripts: {
        setup: config.worktreeSetupCommand || '',
        teardown: config.worktreeTeardownCommand || ''
      },
      claudeEnvVars: config.claudeEnvVars || {},
      harnessMcpEnabled: config.harnessMcpEnabled !== false,
      nameClaudeSessions: config.nameClaudeSessions ?? false,
      terminalFontFamily: config.terminalFontFamily || DEFAULT_TERMINAL_FONT_FAMILY,
      terminalFontSize: config.terminalFontSize || DEFAULT_TERMINAL_FONT_SIZE,
      editor: config.editor || DEFAULT_EDITOR_ID,
      worktreeBase: config.worktreeBase || DEFAULT_WORKTREE_BASE,
      mergeStrategy: config.mergeStrategy || DEFAULT_MERGE_STRATEGY,
      hasGithubToken: opts.hasGithubToken
    }
  }
}

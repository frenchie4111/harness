import type { AppState } from '../shared/state'
import { initialPRs } from '../shared/state/prs'
import { initialOnboarding } from '../shared/state/onboarding'
import { initialHooks } from '../shared/state/hooks'
import { initialWorktrees } from '../shared/state/worktrees'
import { initialTerminals } from '../shared/state/terminals'
import { initialUpdater } from '../shared/state/updater'
import { initialRepoConfigs } from '../shared/state/repo-configs'
import { initialCosts, type CostsState } from '../shared/state/costs'
import { initialBrowser } from '../shared/state/browser'
import { initialJsonClaude } from '../shared/state/json-claude'
import { initialSettings } from '../shared/state/settings'
import {
  DEFAULT_CLAUDE_COMMAND,
  DEFAULT_THEME,
  DEFAULT_TERMINAL_FONT_FAMILY,
  DEFAULT_TERMINAL_FONT_SIZE,
  DEFAULT_WORKTREE_BASE,
  DEFAULT_MERGE_STRATEGY,
  DEFAULT_HARNESS_SYSTEM_PROMPT,
  DEFAULT_HARNESS_SYSTEM_PROMPT_MAIN,
  type Config
} from './persistence'
import { DEFAULT_EDITOR_ID } from './editor'

export function buildInitialAppState(
  config: Config,
  opts: { hasGithubToken: boolean }
): AppState {
  return {
    prs: initialPRs,
    onboarding: {
      ...initialOnboarding,
      quest: config.onboarding?.quest ?? 'hidden'
    },
    hooks: initialHooks,
    worktrees: { ...initialWorktrees, repoRoots: config.repoRoots || [] },
    terminals: initialTerminals,
    updater: initialUpdater,
    repoConfigs: initialRepoConfigs,
    costs: config.costs ? { ...initialCosts, ...config.costs } : initialCosts,
    browser: initialBrowser,
    jsonClaude: initialJsonClaude,
    settings: {
      ...initialSettings,
      theme: config.theme || DEFAULT_THEME,
      hotkeys: config.hotkeys || null,
      defaultAgent: config.defaultAgent || 'claude',
      claudeCommand: config.claudeCommand || DEFAULT_CLAUDE_COMMAND,
      codexCommand: config.codexCommand || 'codex',
      worktreeScripts: {
        setup: config.worktreeSetupCommand || '',
        teardown: config.worktreeTeardownCommand || ''
      },
      claudeEnvVars: config.claudeEnvVars || {},
      codexEnvVars: config.codexEnvVars || {},
      harnessMcpEnabled: config.harnessMcpEnabled !== false,
      nameClaudeSessions: config.nameClaudeSessions ?? false,
      terminalFontFamily: config.terminalFontFamily || DEFAULT_TERMINAL_FONT_FAMILY,
      terminalFontSize: config.terminalFontSize || DEFAULT_TERMINAL_FONT_SIZE,
      editor: config.editor || DEFAULT_EDITOR_ID,
      worktreeBase: config.worktreeBase || DEFAULT_WORKTREE_BASE,
      mergeStrategy: config.mergeStrategy || DEFAULT_MERGE_STRATEGY,
      claudeModel: config.claudeModel || null,
      codexModel: config.codexModel || null,
      hasGithubToken: opts.hasGithubToken,
      autoUpdateEnabled: config.autoUpdateEnabled !== false,
      shareClaudeSettings: config.shareClaudeSettings !== false,
      harnessSystemPromptEnabled: config.harnessSystemPromptEnabled !== false,
      harnessSystemPrompt: config.harnessSystemPrompt || DEFAULT_HARNESS_SYSTEM_PROMPT,
      harnessSystemPromptMain: config.harnessSystemPromptMain || DEFAULT_HARNESS_SYSTEM_PROMPT_MAIN,
      claudeTuiFullscreen: config.claudeTuiFullscreen !== false,
      wsTransportEnabled: config.wsTransportEnabled === true,
      wsTransportPort: config.wsTransportPort ?? 37291,
      wsTransportHost: config.wsTransportHost ?? '127.0.0.1',
      browserToolsEnabled: config.browserToolsEnabled !== false,
      browserToolsMode: config.browserToolsMode === 'view' ? 'view' : 'full',
      jsonModeClaudeTabs: config.jsonModeClaudeTabs === true,
      defaultClaudeTabType: config.defaultClaudeTabType === 'json' ? 'json' : 'xterm',
      autoApprovePermissions: config.autoApprovePermissions === true,
      autoApproveSteerInstructions: config.autoApproveSteerInstructions || '',
      useSystemClaudeForJsonMode: config.useSystemClaudeForJsonMode === true,
      jsonModeChatDensity: config.jsonModeChatDensity === 'comfy' ? 'comfy' : 'compact',
      jsonModeDefaultPermissionMode:
        config.jsonModeDefaultPermissionMode === 'default' ||
        config.jsonModeDefaultPermissionMode === 'plan'
          ? config.jsonModeDefaultPermissionMode
          : 'acceptEdits',
      autoSleepMinutes:
        typeof config.autoSleepMinutes === 'number' &&
        Number.isFinite(config.autoSleepMinutes) &&
        config.autoSleepMinutes >= 0
          ? Math.floor(config.autoSleepMinutes)
          : 30
    }
  }
}

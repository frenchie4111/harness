import type { AppState } from '../shared/state'
import { initialPRs } from '../shared/state/prs'
import { initialOnboarding } from '../shared/state/onboarding'
import { initialHooks } from '../shared/state/hooks'
import { initialWorktrees } from '../shared/state/worktrees'
import { initialTerminals } from '../shared/state/terminals'
import { initialUpdater } from '../shared/state/updater'
import { initialRepoConfigs } from '../shared/state/repo-configs'
import { initialCosts } from '../shared/state/costs'
import { initialBrowser } from '../shared/state/browser'
import { initialJsonClaude } from '../shared/state/json-claude'
import { initialSnooze } from '../shared/state/snooze'
import { initialAnnouncements } from '../shared/state/announcements'
import { initialScratchpad } from '../shared/state/scratchpad'
import { initialSshBootstrap } from '../shared/state/ssh-bootstrap'
import { initialConfigHealth, type ConfigLoadError } from '../shared/state/config-health'
import {
  initialSettings,
  DEFAULT_LIGHT_THEME,
  DEFAULT_DARK_THEME,
  DEFAULT_PR_REVIEW_PROMPT
} from '../shared/state/settings'
import {
  DEFAULT_CLAUDE_COMMAND,
  DEFAULT_TERMINAL_FONT_FAMILY,
  DEFAULT_TERMINAL_FONT_SIZE,
  DEFAULT_WORKTREE_BASE,
  DEFAULT_MERGE_STRATEGY,
  DEFAULT_WORKTREE_DETAIL,
  DEFAULT_HARNESS_SYSTEM_PROMPT,
  DEFAULT_HARNESS_SYSTEM_PROMPT_MAIN,
  type Config
} from './persistence'
import { DEFAULT_EDITOR_ID } from './editor'

/** Flatten the nested `repoRoot → worktreePath → text` shape on disk
 *  into the flat `worktreePath → text` map the slice carries in memory.
 *  Two repos shouldn't have overlapping worktree paths in practice; if
 *  they ever do, last-write-wins on iteration order. */
function flattenScratchpadNotes(
  nested: Record<string, Record<string, string>> | undefined
): Record<string, string> {
  if (!nested) return {}
  const out: Record<string, string> = {}
  for (const byPath of Object.values(nested)) {
    if (!byPath) continue
    for (const [worktreePath, text] of Object.entries(byPath)) {
      if (typeof text === 'string' && text !== '') out[worktreePath] = text
    }
  }
  return out
}

export function buildInitialAppState(
  config: Config,
  opts: { hasGithubToken: boolean; configLoadError?: ConfigLoadError | null }
): AppState {
  return {
    prs: initialPRs,
    configHealth: { ...initialConfigHealth, loadError: opts.configLoadError ?? null },
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
    snooze: config.snooze ? { byPath: { ...config.snooze } } : initialSnooze,
    announcements: initialAnnouncements,
    scratchpad: { byWorktreePath: flattenScratchpadNotes(config.scratchpadNotes) },
    sshBootstrap: initialSshBootstrap,
    settings: {
      ...initialSettings,
      themeMode:
        config.themeMode === 'light' || config.themeMode === 'dark'
          ? config.themeMode
          : 'system',
      themeLight: config.themeLight || DEFAULT_LIGHT_THEME,
      themeDark: config.themeDark || DEFAULT_DARK_THEME,
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
      worktreeDetail: config.worktreeDetail || DEFAULT_WORKTREE_DETAIL,
      claudeModel: config.claudeModel || null,
      codexModel: config.codexModel || null,
      hasGithubToken: opts.hasGithubToken,
      autoUpdateEnabled: config.autoUpdateEnabled !== false,
      warnBeforeQuitting: config.warnBeforeQuitting !== false,
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
      defaultClaudeTabType: config.defaultClaudeTabType === 'json' ? 'json' : 'xterm',
      chatPromotionDismissed: config.chatPromotionDismissed === true,
      autoApprovePermissions: config.autoApprovePermissions === true,
      autoApproveSteerInstructions: config.autoApproveSteerInstructions || '',
      useSystemClaudeForJsonMode: config.useSystemClaudeForJsonMode === true,
      jsonModeChatDensity: config.jsonModeChatDensity === 'comfy' ? 'comfy' : 'compact',
      uiScale:
        config.uiScale === 'x-small' ||
        config.uiScale === 'medium' ||
        config.uiScale === 'large' ||
        config.uiScale === 'x-large'
          ? config.uiScale
          : 'small',
      jsonModeSendOnEnter: config.jsonModeSendOnEnter === true,
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
          : 30,
      snoozeDefaultDays: Math.max(1, Math.floor(config.snoozeDefaultDays ?? 7)),
      expandedDiagnosticLoggingEnabled: config.expandedDiagnosticLoggingEnabled === true,
      prReviewPrompt: config.prReviewPrompt || DEFAULT_PR_REVIEW_PROMPT,
      dismissedAnnouncementIds: Array.isArray(config.dismissedAnnouncementIds)
        ? config.dismissedAnnouncementIds.filter((x): x is string => typeof x === 'string')
        : [],
      announcementsMuted: config.announcementsMuted === true,
      autoFetchEnabled: config.autoFetchEnabled !== false
    }
  }
}

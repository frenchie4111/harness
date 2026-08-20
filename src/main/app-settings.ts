// The settings surface the app-scoped agent is allowed to see and change.
//
// Deliberately a projection, not a dump of SettingsState: secrets
// (`hasGithubToken`), derived data (`customThemes`, `viewerLogin`), and
// one-shot UI bookkeeping (`chatPromotionDismissed`,
// `dismissedAnnouncementIds`) have no business in an agent's vocabulary.
//
// Each writable entry names the IPC channel that already implements the
// mutation. Nothing here re-implements a `saveConfig` + `dispatch` pair —
// the control server invokes the registered handler through the local
// transport tap, so an agent-driven change takes exactly the same path
// as a click in the Settings panel and lands in every open window.

import type { AppState, SettingsState } from '../shared/state'
import { SCALES } from '../shared/state/settings'
import { JSON_CLAUDE_PERMISSION_MODES } from '../shared/state/json-claude'
import { AVAILABLE_THEMES } from './persistence'

export type AppSettingType = 'string' | 'boolean' | 'number' | 'enum' | 'object'

export interface AppSettingDescriptor {
  /** Key as the agent sees it. Matches the SettingsState field name so
   *  a read and a write use the same vocabulary. */
  key: keyof SettingsState
  description: string
  type: AppSettingType
  /** Allowed values for `type: 'enum'`. Some are resolved at call time
   *  (theme ids depend on which custom themes loaded), hence the
   *  function form. */
  values?: (state: AppState) => string[]
  /** Request channel that applies the change, or undefined for a
   *  read-only entry. */
  channel?: string
}

const UI_SCALES = SCALES.map((s) => s.id)

export const APP_SETTINGS: AppSettingDescriptor[] = [
  {
    key: 'themeMode',
    description:
      "Whether the active theme follows the OS ('system'), or is pinned to the configured light or dark theme.",
    type: 'enum',
    values: () => ['light', 'dark', 'system'],
    channel: 'config:setThemeMode'
  },
  {
    key: 'themeLight',
    description: 'Theme id used when themeMode resolves to light.',
    type: 'enum',
    values: (s) => themeIds(s, 'light'),
    channel: 'config:setThemeLight'
  },
  {
    key: 'themeDark',
    description: 'Theme id used when themeMode resolves to dark.',
    type: 'enum',
    values: (s) => themeIds(s, 'dark'),
    channel: 'config:setThemeDark'
  },
  {
    key: 'nessieColor',
    description:
      "Id of the accent colour preset driving the brand ramp (e.g. 'nessie', 'violet').",
    type: 'string',
    channel: 'config:setNessieColor'
  },
  {
    key: 'uiScale',
    description:
      'Global UI density. Maps to the root html font-size, so every text and icon size shifts together.',
    type: 'enum',
    values: () => [...UI_SCALES],
    channel: 'config:setUiScale'
  },
  {
    key: 'sidebarDensity',
    description:
      "Sidebar row layout: 'comfy' stacks label and details on two lines, 'compact' folds them onto one.",
    type: 'enum',
    values: () => ['compact', 'comfy'],
    channel: 'config:setSidebarDensity'
  },
  {
    key: 'jsonModeChatDensity',
    description: 'Visual density of the Chat tab transcript.',
    type: 'enum',
    values: () => ['compact', 'comfy'],
    channel: 'config:setJsonModeChatDensity'
  },
  {
    key: 'terminalFontFamily',
    description: 'Font stack used by terminal tabs and the code editor.',
    type: 'string',
    channel: 'config:setTerminalFontFamily'
  },
  {
    key: 'terminalFontSize',
    description:
      'Base terminal/editor font size in px, before the uiScale offset is applied.',
    type: 'number',
    channel: 'config:setTerminalFontSize'
  },
  {
    key: 'hotkeys',
    description:
      "Hotkey overrides as an action -> binding map (e.g. {\"nextWorktree\": \"cmd+j\"}). Writing replaces the WHOLE map, so read it first and send back the merged object. Send null to reset every binding to its default.",
    type: 'object',
    channel: 'config:setHotkeys'
  },
  {
    key: 'defaultAgent',
    description:
      "Which CLI agent new worktrees spawn by default: 'claude', 'codex', or 'cursor'.",
    type: 'enum',
    values: () => ['claude', 'codex', 'cursor'],
    channel: 'config:setDefaultAgent'
  },
  {
    key: 'defaultClaudeTabType',
    description:
      "Whether new Claude tabs open as the terminal TUI ('xterm') or the Ness chat UI ('json').",
    type: 'enum',
    values: () => ['xterm', 'json'],
    channel: 'config:setDefaultClaudeTabType'
  },
  {
    key: 'claudeCommand',
    description:
      'Command line used to launch Claude in terminal tabs. Chat tabs use the bundled binary and ignore this.',
    type: 'string',
    channel: 'config:setClaudeCommand'
  },
  {
    key: 'claudeModel',
    description:
      "Model passed to Claude's --model flag, or null for the CLI default.",
    type: 'string',
    channel: 'config:setClaudeModel'
  },
  {
    key: 'jsonModeDefaultPermissionMode',
    description:
      'Permission mode applied to freshly-spawned Chat sessions. Existing sessions keep their own mode.',
    type: 'enum',
    values: () => [...JSON_CLAUDE_PERMISSION_MODES],
    channel: 'config:setJsonModeDefaultPermissionMode'
  },
  {
    key: 'autoApprovePermissions',
    description:
      'When on, obviously-safe tool calls in Chat tabs are auto-approved by a Haiku reviewer instead of prompting.',
    type: 'boolean',
    channel: 'config:setAutoApprovePermissions'
  },
  {
    key: 'jsonModeSendOnEnter',
    description:
      'When on, plain Enter sends in the chat composer and Shift+Enter inserts a newline.',
    type: 'boolean',
    channel: 'config:setJsonModeSendOnEnter'
  },
  {
    key: 'autoScrollToBottom',
    description:
      'When on, the chat follows the tail of a streaming response instead of pinning the last user message to the top.',
    type: 'boolean',
    channel: 'config:setAutoScrollToBottom'
  },
  {
    key: 'autoSleepMinutes',
    description:
      'Minutes an idle Chat tab waits before its subprocess is torn down. 0 disables auto-sleep.',
    type: 'number',
    channel: 'config:setAutoSleepMinutes'
  },
  {
    key: 'harnessMcpEnabled',
    description:
      'Whether worktree agents get the ness-control MCP tools (worktree management, browser tabs, shells).',
    type: 'boolean',
    channel: 'config:setHarnessMcpEnabled'
  },
  {
    key: 'browserToolsEnabled',
    description: 'Whether agents can drive Ness browser tabs at all.',
    type: 'boolean',
    channel: 'config:setBrowserToolsEnabled'
  },
  {
    key: 'browserToolsMode',
    description:
      "'view' allows inspection only; 'full' also allows click/type/scroll.",
    type: 'enum',
    values: () => ['view', 'full'],
    channel: 'config:setBrowserToolsMode'
  },
  {
    key: 'worktreeMessagingEnabled',
    description:
      'Whether agents can send messages into another worktree\'s chat via the send_message tool.',
    type: 'boolean',
    channel: 'config:setWorktreeMessagingEnabled'
  },
  {
    key: 'conversationForkEnabled',
    description:
      'Whether a chat can be forked into a new worktree so the new agent resumes the same conversation.',
    type: 'boolean',
    channel: 'config:setConversationForkEnabled'
  },
  {
    key: 'warnBeforeQuitting',
    description:
      'When on, Cmd+Q must be held briefly to quit instead of quitting on a tap.',
    type: 'boolean',
    channel: 'config:setWarnBeforeQuitting'
  },
  {
    key: 'autoUpdateEnabled',
    description: 'Whether Ness checks for and downloads updates in the background.',
    type: 'boolean',
    channel: 'config:setAutoUpdateEnabled'
  },
  {
    key: 'showAssignedPRs',
    description:
      'Whether PRs awaiting your review show as phantom sidebar entries in the Reviewing group.',
    type: 'boolean',
    channel: 'config:setShowAssignedPRs'
  },
  {
    key: 'notifyChatOnCiFailure',
    description:
      "Global default for injecting a 'CI is failing' message into a worktree's chat when its checks go red.",
    type: 'boolean',
    channel: 'config:setNotifyChatOnCiFailure'
  },
  {
    key: 'worktreeBase',
    description:
      "Whether new worktrees branch from the remote default branch ('remote') or the local one ('local').",
    type: 'enum',
    values: () => ['remote', 'local'],
    channel: 'config:setWorktreeBase'
  },
  {
    key: 'prReviewPrompt',
    description:
      'Prompt used to kick off an agent in a worktree created from a GitHub PR.',
    type: 'string',
    channel: 'config:setPrReviewPrompt'
  },
  {
    key: 'editor',
    description: "Id of the external editor the 'Open in editor' action launches.",
    type: 'string',
    channel: 'config:setEditor'
  },
  {
    key: 'hasGithubToken',
    description:
      'Read-only: whether a GitHub token is configured. The token itself is never exposed.',
    type: 'boolean'
  },
  {
    key: 'githubAuthSource',
    description:
      "Read-only: where the GitHub token came from — 'pat' (pasted into Settings) or 'gh-cli'.",
    type: 'string'
  }
]

/** AVAILABLE_THEMES doesn't record which ids are light and which are
 *  dark, so the advertised enum is the full built-in list plus the
 *  mode-matching custom themes. The setThemeLight / setThemeDark
 *  handlers stay the authority — a mismatched id comes back as a
 *  rejected write rather than being silently applied. */
function themeIds(state: AppState, mode: 'light' | 'dark'): string[] {
  const custom = state.settings.customThemes
    .filter((t) => t.mode === mode)
    .map((t) => t.id)
  return [...AVAILABLE_THEMES, ...custom]
}

export function readAppSettings(state: AppState): Array<{
  key: string
  value: unknown
  type: AppSettingType
  writable: boolean
  description: string
  values?: string[]
}> {
  return APP_SETTINGS.map((d) => {
    const values = d.values?.(state)
    return {
      key: d.key,
      value: state.settings[d.key],
      type: d.type,
      writable: Boolean(d.channel),
      description: d.description,
      ...(values && values.length > 0 ? { values } : {})
    }
  })
}

export function findAppSetting(key: string): AppSettingDescriptor | undefined {
  return APP_SETTINGS.find((d) => d.key === key)
}

/** Coerce a JSON value from the MCP call into what the IPC handler
 *  expects. Returns an error string rather than throwing so the caller
 *  can hand the agent something it can act on. */
export function coerceAppSettingValue(
  descriptor: AppSettingDescriptor,
  raw: unknown,
  state: AppState
): { ok: true; value: unknown } | { ok: false; error: string } {
  switch (descriptor.type) {
    case 'boolean': {
      if (typeof raw === 'boolean') return { ok: true, value: raw }
      if (raw === 'true') return { ok: true, value: true }
      if (raw === 'false') return { ok: true, value: false }
      return { ok: false, error: `${descriptor.key} expects a boolean` }
    }
    case 'number': {
      const n = typeof raw === 'number' ? raw : Number(raw)
      if (!Number.isFinite(n)) {
        return { ok: false, error: `${descriptor.key} expects a number` }
      }
      return { ok: true, value: n }
    }
    case 'enum': {
      if (typeof raw !== 'string') {
        return { ok: false, error: `${descriptor.key} expects a string` }
      }
      const allowed = descriptor.values?.(state) ?? []
      if (allowed.length > 0 && !allowed.includes(raw)) {
        return {
          ok: false,
          error: `${descriptor.key} must be one of: ${allowed.join(', ')}`
        }
      }
      return { ok: true, value: raw }
    }
    case 'object': {
      if (raw === null) return { ok: true, value: null }
      if (typeof raw === 'object') return { ok: true, value: raw }
      if (typeof raw === 'string') {
        try {
          return { ok: true, value: JSON.parse(raw) }
        } catch {
          return { ok: false, error: `${descriptor.key} expects a JSON object` }
        }
      }
      return { ok: false, error: `${descriptor.key} expects a JSON object` }
    }
    default: {
      // `claudeModel` is nullable — an explicit null clears the override.
      if (raw === null) return { ok: true, value: null }
      if (typeof raw === 'string') return { ok: true, value: raw }
      return { ok: false, error: `${descriptor.key} expects a string` }
    }
  }
}

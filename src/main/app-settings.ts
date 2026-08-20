// The settings surface the app-scoped agent is allowed to see and change.
//
// Deliberately a projection, not a dump of SettingsState — but an
// EXHAUSTIVE one. Every key of SettingsState must appear either here or
// in HELD_BACK_SETTINGS below, and app-settings.test.ts fails the build
// if one appears in neither.
//
// That check is the point of this file's design. Settings get added to
// this app constantly, and an allow-list that's merely hand-maintained
// goes stale silently: the new setting just doesn't exist to the agent,
// nothing errors, and nobody notices for a month. Forcing a compile-time
// decision costs whoever adds a setting one line, and that line is
// exactly where "should an agent be able to change this?" gets asked.
//
// Env-var settings ARE exposed but never surrender their values; see the
// 'env' type above.
//
// Each writable entry names the IPC channel that already implements the
// mutation. Nothing here re-implements a `saveConfig` + `dispatch` pair —
// the control server invokes the registered handler through the local
// transport tap, so an agent-driven change takes exactly the same path
// as a click in the Settings panel and lands in every open window.

import type { AppState, SettingsState } from '../shared/state'
import { SCALES, initialSettings } from '../shared/state/settings'
import { JSON_CLAUDE_PERMISSION_MODES } from '../shared/state/json-claude'
import { AVAILABLE_THEMES } from './persistence'

export type AppSettingType =
  | 'string'
  | 'boolean'
  | 'number'
  | 'enum'
  | 'object'
  /** A `NAME -> value` env map for one of the agent CLIs. Handled
   *  specially in both directions because these routinely hold API keys:
   *  reads report which names are set and never their values, and writes
   *  patch-merge rather than replace — a replace would be unusable when
   *  the caller can't see what it's about to overwrite. */
  | 'env'

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

/** Settings the app-scoped agent deliberately does NOT get, each with
 *  the reason. Read as the other half of APP_SETTINGS: between them they
 *  must cover every key of SettingsState, and the test enforces it.
 *
 *  Adding a setting to this app? You have to land it in one of the two.
 *  Default to APP_SETTINGS — the whole point of the global chat is
 *  configuring Ness conversationally, and a setting that isn't listed
 *  might as well not exist to it. Come here only when exposure is
 *  meaningless (derived state), incoherent (one-shot UI bookkeeping),
 *  or carries blast radius the user hasn't opted into. */
export const HELD_BACK_SETTINGS: Partial<Record<keyof SettingsState, string>> = {
  // Derived — the value is computed elsewhere, so writing it here would
  // either be ignored or immediately overwritten.
  customThemes: 'scanned from disk; the agent uses reload_custom_themes instead',
  viewerLogin: 'resolved from the GitHub API at boot',
  harnessStarred: 'reflects the star state of the repo on GitHub',

  // One-shot UI bookkeeping. These record that a human dismissed
  // something; an agent setting them fakes an interaction that didn't
  // happen.
  chatPromotionDismissed: 'records that the user dismissed an overlay',
  dismissedAnnouncementIds: 'records which banners the user dismissed',

  // Owned by a main-process component that manages its own lifecycle.
  preventSleepUntil:
    'session-only; the WakeLockController owns it and clears it on expiry',

  // Deliberate holds. Not oversights — revisit if the user asks.
  harnessSystemPromptEnabled:
    'changes the system prompt of every agent in every worktree at once',
  harnessSystemPrompt:
    'changes the system prompt of every agent in every worktree at once',
  harnessSystemPromptMain:
    'changes the system prompt of every agent in every worktree at once',
  wsTransportEnabled: 'opens a network listener — changes the attack surface',
  wsTransportPort: 'part of the network listener config',
  wsTransportHost: 'binding 0.0.0.0 exposes the app to the LAN',
  useSystemClaudeForJsonMode:
    'undocumented diagnostic toggle with no UI; not offered to the agent yet'
}

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
    key: 'codexCommand',
    description: 'Command line used to launch Codex in terminal tabs.',
    type: 'string',
    channel: 'config:setCodexCommand'
  },
  {
    key: 'codexModel',
    description: "Model passed to Codex's --model flag, or null for its default.",
    type: 'string',
    channel: 'config:setCodexModel'
  },
  {
    key: 'cursorCommand',
    description: 'Command line used to launch the Cursor agent in terminal tabs.',
    type: 'string',
    channel: 'config:setCursorCommand'
  },
  {
    key: 'cursorModel',
    description:
      "Model passed to the Cursor agent's --model flag, or null for its default.",
    type: 'string',
    channel: 'config:setCursorModel'
  },
  {
    key: 'claudeEnvVars',
    description:
      'Environment variables injected into every Claude process Ness spawns. Reads report which names are set, never their values — these commonly hold API keys. Writes PATCH: send only the names you want to change, and set a name to null to remove it. Names you omit are left alone.',
    type: 'env',
    channel: 'config:setClaudeEnvVars'
  },
  {
    key: 'codexEnvVars',
    description:
      'Environment variables injected into every Codex process. Same read redaction and patch-write semantics as claudeEnvVars.',
    type: 'env',
    channel: 'config:setCodexEnvVars'
  },
  {
    key: 'cursorEnvVars',
    description:
      'Environment variables injected into every Cursor agent process. Same read redaction and patch-write semantics as claudeEnvVars.',
    type: 'env',
    channel: 'config:setCursorEnvVars'
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
    key: 'autoApproveSteerInstructions',
    description:
      'Project-specific guidance appended to the auto-approver\'s policy prompt (e.g. "approve npm install on this repo", "be strict about Bash writing outside src/"). No effect unless autoApprovePermissions is on.',
    type: 'string',
    channel: 'config:setAutoApproveSteerInstructions'
  },
  {
    key: 'sidebarDetails',
    description:
      'Which items show in each sidebar row\'s detail cluster, per density. Shape: {"compact": {...}, "comfy": {...}}, each with boolean repoLabel / branch / age / diff / milestone / prNumber / assignee. Writing REPLACES the whole object — read it first and send back the merged value.',
    type: 'object',
    channel: 'config:setSidebarDetails'
  },
  {
    key: 'worktreeScripts',
    description:
      'Shell commands run when a worktree is created and destroyed. Shape: {"setup": "npm install", "teardown": ""}. Writing replaces both fields, so send both. Empty string disables one.',
    type: 'object',
    channel: 'config:setWorktreeScripts'
  },
  {
    key: 'hiddenBottomIcons',
    description:
      'Bottom-launcher icons the user has hidden, as a key -> true map. Only keys set to true are stored. Writing replaces the whole map.',
    type: 'object',
    channel: 'config:setHiddenBottomIcons'
  },
  {
    key: 'bottomIconOrder',
    description:
      'Render order for the bottom-launcher icons, as an array of keys. Unknown or duplicate keys are dropped; known keys you omit get appended in canonical order.',
    type: 'object',
    channel: 'config:setBottomIconOrder'
  },
  {
    key: 'mergeStrategy',
    description: 'Default strategy offered when merging a PR from Ness.',
    type: 'enum',
    values: () => ['squash', 'merge-commit', 'fast-forward'],
    channel: 'config:setMergeStrategy'
  },
  {
    key: 'nameClaudeSessions',
    description:
      "When on, Claude sessions are launched with --name set to <repo>/<branch>, so they're identifiable outside Ness.",
    type: 'boolean',
    channel: 'config:setNameClaudeSessions'
  },
  {
    key: 'claudeTuiFullscreen',
    description:
      'When on, terminal-hosted Claude tabs run in the CLI\'s fullscreen TUI mode.',
    type: 'boolean',
    channel: 'config:setClaudeTuiFullscreen'
  },
  {
    key: 'shareClaudeSettings',
    description:
      "When on, each worktree's .claude/settings.local.json is symlinked to the main worktree's copy, so tool permissions are shared across worktrees of a repo.",
    type: 'boolean',
    channel: 'config:setShareClaudeSettings'
  },
  {
    key: 'openPrInBrowserTab',
    description:
      'When on, the Open PR action opens the PR in a Ness browser tab instead of the system browser.',
    type: 'boolean',
    channel: 'config:setOpenPrInBrowserTab'
  },
  {
    key: 'snoozeDefaultDays',
    description: 'Default number of days the snooze action parks a worktree for.',
    type: 'number',
    channel: 'config:setSnoozeDefaultDays'
  },
  {
    key: 'announcementsMuted',
    description:
      'When on, all announcement banners are suppressed regardless of the feed.',
    type: 'boolean',
    channel: 'announcements:mute'
  },
  {
    key: 'preventSleepMode',
    description:
      "Wake-lock policy: 'off', 'while-agents-running', or 'always'. Stops the machine sleeping mid-run.",
    type: 'enum',
    values: () => ['off', 'while-agents-running', 'always'],
    channel: 'config:setPreventSleepMode'
  },
  {
    key: 'expandedDiagnosticLoggingEnabled',
    description:
      'When on, high-volume per-GitHub-API-call lines are written to debug.log. Useful when diagnosing PR-refresh problems; noisy otherwise.',
    type: 'boolean',
    channel: 'config:setExpandedDiagnosticLoggingEnabled'
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

/** Placeholder standing in for an env var's value. Reporting the NAME is
 *  genuinely useful ("you have ANTHROPIC_BASE_URL set, that's why…");
 *  reporting the value would paste an API key into a chat transcript
 *  that persists on disk under ~/.claude/projects. */
const ENV_VALUE_PLACEHOLDER = '<set>'

function redactEnv(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {}
  const out: Record<string, string> = {}
  for (const name of Object.keys(value as Record<string, unknown>).sort()) {
    out[name] = ENV_VALUE_PLACEHOLDER
  }
  return out
}

/** What the agent is allowed to see for one setting. Identity for
 *  everything except env maps. Used for both the read path and the value
 *  echoed back after a write, so a write can't leak what a read won't. */
export function projectAppSettingValue(
  descriptor: AppSettingDescriptor,
  state: AppState
): unknown {
  const raw = state.settings[descriptor.key]
  return descriptor.type === 'env' ? redactEnv(raw) : raw
}

/** Fold a patch into an existing env map. `null` removes a name; any
 *  name the patch doesn't mention is preserved. This is what makes a
 *  redacted read safe — a replace-semantics write would blow away every
 *  var the caller couldn't see. */
export function applyEnvPatch(
  current: unknown,
  patch: Record<string, string | null>
): Record<string, string> {
  const next: Record<string, string> = {}
  if (current && typeof current === 'object') {
    for (const [k, v] of Object.entries(current as Record<string, unknown>)) {
      if (typeof v === 'string') next[k] = v
    }
  }
  for (const [name, value] of Object.entries(patch)) {
    if (value === null) delete next[name]
    else next[name] = value
  }
  return next
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
      value: projectAppSettingValue(d, state),
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

/** Keys of SettingsState that are neither exposed nor explicitly held
 *  back. Should always be empty; the test asserts it. Derived from
 *  `initialSettings` rather than a hand-written list so it tracks the
 *  interface automatically — that's the whole mechanism. */
export function unclassifiedSettingKeys(): string[] {
  const exposed = new Set<string>(APP_SETTINGS.map((d) => d.key))
  const held = new Set(Object.keys(HELD_BACK_SETTINGS))
  return Object.keys(initialSettings).filter(
    (key) => !exposed.has(key) && !held.has(key)
  )
}

/** JSON.parse that reports failure as `undefined` rather than throwing.
 *  `null` is a legitimate parse result, so it can't double as the
 *  sentinel. */
function tryParseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
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
    case 'env': {
      const parsed = raw && typeof raw === 'string' ? tryParseJson(raw) : raw
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return {
          ok: false,
          error: `${descriptor.key} expects an object of NAME -> value (or NAME -> null to remove)`
        }
      }
      const patch: Record<string, string | null> = {}
      for (const [name, value] of Object.entries(
        parsed as Record<string, unknown>
      )) {
        if (value === null) {
          patch[name] = null
          continue
        }
        if (typeof value !== 'string') {
          return {
            ok: false,
            error: `${descriptor.key}.${name} must be a string, or null to remove it`
          }
        }
        patch[name] = value
      }
      return { ok: true, value: patch }
    }
    case 'object': {
      if (raw === null) return { ok: true, value: null }
      if (typeof raw === 'object') return { ok: true, value: raw }
      if (typeof raw === 'string') {
        const parsed = tryParseJson(raw)
        if (parsed === undefined) {
          return { ok: false, error: `${descriptor.key} expects a JSON object` }
        }
        return { ok: true, value: parsed }
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

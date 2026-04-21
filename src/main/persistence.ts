import { app } from 'electron'
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, readdirSync } from 'fs'
import { join } from 'path'
import {
  runMigrations,
  SCHEMA_VERSION,
  type AnyConfig,
  type PersistedPane,
  type PersistedPaneNode,
  type PersistedTab
} from './persistence-migrations'
import type { CostsState } from '../shared/state/costs'

export type { PersistedPane, PersistedPaneNode, PersistedTab }

export type QuestStep = 'hidden' | 'spawn-second' | 'switch-between' | 'finale' | 'done'

export interface Config {
  /** Schema version of the on-disk config. Bumped whenever the shape changes;
   *  see `migrations` below. Always written; absent on pre-versioned configs. */
  schemaVersion?: number
  windowBounds: { x: number; y: number; width: number; height: number } | null
  // All repo roots that have been opened (for re-opening windows)
  repoRoots: string[]
  // Custom hotkey overrides: action name → shortcut string (e.g. "Cmd+Shift+T")
  hotkeys?: Record<string, string>
  // Which agent CLI to default to when creating new tabs: 'claude' or 'codex'.
  defaultAgent?: 'claude' | 'codex'
  // Command used to launch Claude in a worktree terminal. Runs via login shell.
  // Harness appends `--session-id <uuid>` so each tab has a stable resumable session.
  claudeCommand?: string
  // Command used to launch Codex in a worktree terminal.
  codexCommand?: string
  // Extra environment variables injected into the PTY when spawning a Claude tab.
  claudeEnvVars?: Record<string, string>
  // Model override for Claude Code (passed as --model <id>).
  claudeModel?: string
  // Model override for Codex (passed as --model <id>).
  codexModel?: string
  // Extra environment variables injected into the PTY when spawning a Codex tab.
  codexEnvVars?: Record<string, string>
  // When false, Harness won't inject `--mcp-config <path>` pointing at the
  // bundled harness-control MCP server. Default is enabled (undefined/true).
  harnessMcpEnabled?: boolean
  // Persisted workspace panes nested by repoRoot → worktreePath → panes[].
  // Two repos can have worktrees with identical paths in theory, and the
  // multi-repo UI shows them together, so we key by repo to keep them distinct.
  panes?: Record<string, Record<string, PersistedPaneNode>>
  // Legacy flat shape (worktreePath → panes). Migrated into the nested form on
  // first load — entries are grouped under whichever known `repoRoot` is a
  // prefix of the worktree path; unmatched entries land in `__orphan__`.
  legacyPanes?: Record<string, PersistedPane[]>
  // Even older — migrated to `legacyPanes` then to `panes` on first load.
  terminalTabs?: Record<string, PersistedTab[]>
  activeTabId?: Record<string, string>
  // Selected color theme id
  theme?: string
  // Terminal font family (CSS font-family string, applied to xterm.js)
  terminalFontFamily?: string
  // Terminal font size in px
  terminalFontSize?: number
  // Preferred external editor id (see AVAILABLE_EDITORS)
  editor?: string
  // New worktrees are branched from: 'remote' = fetch origin then branch
  // from origin/<default>, 'local' = branch from current HEAD.
  worktreeBase?: 'remote' | 'local'
  // Default strategy for "Merge locally" action. Auto-updates to whatever
  // was last used unless the user pinned one in Settings.
  mergeStrategy?: 'squash' | 'merge-commit' | 'fast-forward'
  // Branches that have been merged locally via Harness, keyed by branch name.
  // Value is the branch-tip SHA at merge time — if the branch later advances
  // past this SHA, the flag is considered stale and the branch is no longer
  // shown as merged.
  // Shell command to run after a worktree is created. Runs via login shell
   // with cwd=worktree and env vars HARNESS_WORKTREE_PATH, HARNESS_BRANCH,
   // HARNESS_REPO_ROOT. Failures are logged but don't block creation.
  worktreeSetupCommand?: string
  // Shell command to run before a worktree is removed. Same execution model
   // as setup. Failures are logged but don't block removal.
  worktreeTeardownCommand?: string
  locallyMerged?: Record<string, string>
  // First-run parallelism quest — advances through steps as the user learns.
  // When true, pass --name "repo/branch" to Claude so sessions are named by
  // their worktree rather than auto-summarized. Also sets the name visible
  // to `claude --resume` and remote control.
  nameClaudeSessions?: boolean
  onboarding?: {
    quest?: QuestStep
  }
  // True once we've auto-starred frenchie4111/harness on behalf of a
  // gh-cli-detected user. Sticky — if they later unstar manually, we
  // don't re-star on next boot.
  harnessAutoStarred?: boolean
  // Per-terminal token usage + estimated cost, tallied from Claude Code
  // session jsonl transcripts. Entries persist across tab/terminal death
  // so worktree-level totals survive restarts.
  costs?: CostsState
  // When false, Harness skips background update checks on startup and
  // on its periodic timer. The manual "Check for updates" button in
  // Settings still works. Default is enabled (undefined/true).
  autoUpdateEnabled?: boolean
  // When false, new worktrees don't symlink their .claude/settings.local.json
  // to the main worktree's copy, and the boot migration doesn't convert
  // existing regular files. Default is enabled (undefined/true).
  shareClaudeSettings?: boolean
  // User's choice for installing agent status hooks at user scope
  // (~/.claude/settings.json, ~/.codex/hooks.json). Persisted so a
  // declined user doesn't see the banner again on next launch.
  hooksConsent?: 'pending' | 'accepted' | 'declined'
  // One-shot migration flag: once true, we've swept all known worktrees'
  // per-worktree .claude/settings.local.json + .codex/hooks.json files
  // and stripped any legacy Harness entries. Prevents re-running the
  // migration on every boot.
  hooksMigratedToGlobal?: boolean
  harnessSystemPromptEnabled?: boolean
  harnessSystemPrompt?: string
  harnessSystemPromptMain?: string
  // When false, Claude sessions spawn without CLAUDE_CODE_NO_FLICKER=1, so they
  // use the inline (non-fullscreen) TUI mode. Default is enabled (undefined/true).
  claudeTuiFullscreen?: boolean
  // Experimental: when true, main also serves state + RPC + signals over a
  // WebSocket bound to 127.0.0.1:<wsTransportPort>. Off by default.
  wsTransportEnabled?: boolean
  wsTransportPort?: number
  // Host the WS + HTTP web-client servers bind to. Default 127.0.0.1
  // (loopback only). Set to '0.0.0.0' to expose to other devices on the
  // LAN (a phone, second laptop, etc.). Token auth still applies, but
  // there is no TLS — only enable on a trusted network.
  wsTransportHost?: string
  // When false, the harness-control browser_* MCP tools are not advertised to
  // agents and the corresponding /browser/* control endpoints reject calls.
  // Default is enabled (undefined/true).
  browserToolsEnabled?: boolean
  // 'view' = inspect tabs + spawn/navigate, but no clicking, typing, or
  // scrolling. 'full' = everything. Default 'full' (undefined treated as 'full').
  browserToolsMode?: 'view' | 'full'
}

export const DEFAULT_WORKTREE_BASE: 'remote' | 'local' = 'remote'
export const DEFAULT_MERGE_STRATEGY: 'squash' | 'merge-commit' | 'fast-forward' = 'squash'

export const DEFAULT_THEME = 'dark'
export const AVAILABLE_THEMES = [
  'dark',
  'dracula',
  'nord',
  'gruvbox-dark',
  'tokyo-night',
  'catppuccin-mocha',
  'one-dark',
  'solarized-dark',
  'solarized-light'
] as const

/** App background hex for each theme — used for the Electron window backgroundColor
 *  so the first paint matches the theme instead of flashing default dark. */
export const THEME_APP_BG: Record<string, string> = {
  'dark': '#0a0a0a',
  'dracula': '#282a36',
  'nord': '#2e3440',
  'gruvbox-dark': '#282828',
  'tokyo-night': '#1a1b26',
  'catppuccin-mocha': '#1e1e2e',
  'one-dark': '#282c34',
  'solarized-dark': '#002b36',
  'solarized-light': '#fdf6e3'
}

export const DEFAULT_CLAUDE_COMMAND = 'claude'

export const DEFAULT_HARNESS_SYSTEM_PROMPT = `You are running inside Harness, a desktop app that manages multiple Claude Code sessions across git worktrees. You have access to harness-control MCP tools:

- mcp__harness-control__create_worktree: Create a new worktree with its own Claude session. Always provide a detailed initialPrompt so the new session has full context.
- mcp__harness-control__list_worktrees: List all active worktrees.

When the user wants to start a new task, fix, or investigation that would benefit from isolation, suggest creating a worktree for it rather than doing everything inline. Each worktree is an independent git branch with its own terminal and Claude session.

Harness also exposes embedded browser tabs — you can open a browser alongside the terminal and see and drive what's in it via the harness-control browser tools (scoped to this worktree only):

- create_browser_tab: open a new browser tab in this worktree (optionally navigating to a URL).
- list_browser_tabs, get_tab_url, get_tab_dom, get_tab_console_logs: inspect what's in the tab.
- navigate_tab, back_tab, forward_tab, reload_tab: drive the tab.
- get_tab_clickables: returns a compact JSON snapshot of in-viewport interactive elements (buttons, links, inputs, [role=button|link|tab|menuitem|checkbox|radio|switch|option|combobox|searchbox|textbox], [tabindex], [contenteditable], [onclick]) — including elements inside open shadow roots. Each entry is {role, name, cx, cy, w, h} with the click center already computed.
- click_tab, type_tab, scroll_tab, show_cursor: interact with the page — click at (x, y), type into the focused field, scroll, or just move the visible cursor overlay so the user can see what you're about to do.
- screenshot_tab: visual verification only. Returns JPEG quality 70 by default for context-efficiency; ask for format:'png' only when lossless matters. Screenshot dimensions match the CSS viewport, so coords observed in a screenshot can be passed straight to click_tab.

Click targeting workflow: **prefer get_tab_clickables → match by role + name → call click_tab(cx, cy) for anything you want to click**. It's far cheaper than a screenshot + vision and far more reliable for real DOM targets. Reserve screenshot_tab for confirming a click had the visual effect you wanted, or for targets without accessible names (canvas/SVG/images). The clickables snapshot is in-viewport only and capped at 500 items — if the target isn't there, scroll_tab first, then re-snapshot. To type into a field: click_tab on it first to focus, then type_tab. type_tab also accepts a \`key\` argument (Enter, Tab, Backspace, ArrowDown, …) for submitting forms or navigating menus.

Prefer these over blind curl/fetch — or shelling out to \`open <url>\`, which launches the user's default browser outside Harness where you can't see the result — when you need to verify rendered UI, inspect a dev server, debug a page the user is looking at, or confirm your changes actually work in the browser.

Harness also exposes shell tabs for long-running processes — anything that wouldn't naturally exit within a few seconds (dev servers, watchers, \`tail -f\`, REPL-style tools, long builds). Drive them via the harness-control shell tools (scoped to this worktree only):

- create_shell: spawn a shell tab, optionally with a command to run (\`zsh -ilc <command>\`). Returns an id — keep it for later reads.
- list_shells: enumerate existing shell tabs (id, label, command, alive). Check here before spawning — don't start a second \`npm run dev\` if one is already running.
- read_shell_output: read a shell's output, optionally with a \`match\` regex + \`context\` lines to scan a long log for errors/warnings without pulling back megabytes.
- kill_shell: terminate the process AND close the tab. For natural exits (process finishes on its own), the tab stays open for inspection — kill_shell is explicit cleanup.

Prefer these over running long-running commands via Bash — Bash either blocks until the process exits or loses the output stream when backgrounded, whereas a Harness shell tab keeps streaming, stays readable via read_shell_output after the fact, and is visible to the user in the Harness UI. Short one-shots (\`npm test\`, \`tsc --noEmit\`, \`git status\`) still belong on Bash.`

export const DEFAULT_HARNESS_SYSTEM_PROMPT_MAIN = `You are on the main worktree. This is the primary checkout — avoid making direct changes here unless the user explicitly asks. Instead, use this session to plan, review, and coordinate work across worktrees. When the user describes a task, create a new worktree for it with a thorough initialPrompt that gives the new Claude session all the context it needs to work independently. If you need to run a dev server, watcher, or other long-running process here, use the harness-control shell tools (create_shell / list_shells / read_shell_output / kill_shell) rather than Bash, so the output keeps streaming and stays readable.`

export const DEFAULT_TERMINAL_FONT_FAMILY =
  "'SF Mono', 'Monaco', 'Menlo', 'Courier New', monospace"
export const DEFAULT_TERMINAL_FONT_SIZE = 13

const DEFAULT_CONFIG: Config = {
  schemaVersion: 0, // overwritten in loadConfig — kept here to satisfy Config shape
  windowBounds: null,
  repoRoots: []
}

function getConfigPath(): string {
  return join(app.getPath('userData'), 'config.json')
}

export function loadConfig(): Config {
  try {
    const data = readFileSync(getConfigPath(), 'utf-8')
    const parsed = JSON.parse(data) as AnyConfig
    runMigrations(parsed)
    return { ...DEFAULT_CONFIG, ...(parsed as Partial<Config>), schemaVersion: SCHEMA_VERSION }
  } catch {
    return { ...DEFAULT_CONFIG, schemaVersion: SCHEMA_VERSION }
  }
}

let saveTimeout: ReturnType<typeof setTimeout> | null = null

export function saveConfig(config: Config): void {
  if (saveTimeout) clearTimeout(saveTimeout)
  saveTimeout = setTimeout(() => {
    try {
      writeFileSync(getConfigPath(), JSON.stringify(config, null, 2))
    } catch (e) {
      console.error('Failed to save config:', e)
    }
  }, 500)
}

export function saveConfigSync(config: Config): void {
  try {
    writeFileSync(getConfigPath(), JSON.stringify(config, null, 2))
  } catch (e) {
    console.error('Failed to save config:', e)
  }
}

// --- Terminal scrollback persistence ---
// Each terminal's serialized xterm buffer is stored as a file named by a
// hash-free sanitized version of the terminal id.

function getHistoryDir(): string {
  const dir = join(app.getPath('userData'), 'terminal-history')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, '_')
}

function historyPath(id: string): string {
  return join(getHistoryDir(), `${sanitizeId(id)}.txt`)
}

export function saveTerminalHistory(id: string, content: string): void {
  try {
    writeFileSync(historyPath(id), content)
  } catch (e) {
    console.error('Failed to save terminal history:', e)
  }
}

export function loadTerminalHistory(id: string): string | null {
  try {
    return readFileSync(historyPath(id), 'utf-8')
  } catch {
    return null
  }
}

export function clearTerminalHistory(id: string): void {
  try {
    unlinkSync(historyPath(id))
  } catch {
    // ignore missing file
  }
}

/** Remove history files for terminals not present in `keepIds`. */
export function pruneTerminalHistory(keepIds: Set<string>): void {
  try {
    const dir = getHistoryDir()
    const keep = new Set(Array.from(keepIds).map((id) => `${sanitizeId(id)}.txt`))
    for (const file of readdirSync(dir)) {
      if (!keep.has(file)) {
        try { unlinkSync(join(dir, file)) } catch { /* ignore */ }
      }
    }
  } catch {
    // ignore
  }
}

import { app } from 'electron'
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, readdirSync } from 'fs'
import { join } from 'path'
import {
  runMigrations,
  SCHEMA_VERSION,
  type AnyConfig,
  type PersistedPane,
  type PersistedTab
} from './persistence-migrations'

export type { PersistedPane, PersistedTab }

export type QuestStep = 'hidden' | 'spawn-second' | 'switch-between' | 'finale' | 'done'

interface Config {
  /** Schema version of the on-disk config. Bumped whenever the shape changes;
   *  see `migrations` below. Always written; absent on pre-versioned configs. */
  schemaVersion?: number
  windowBounds: { x: number; y: number; width: number; height: number } | null
  // All repo roots that have been opened (for re-opening windows)
  repoRoots: string[]
  // Custom hotkey overrides: action name → shortcut string (e.g. "Cmd+Shift+T")
  hotkeys?: Record<string, string>
  // Command used to launch Claude in a worktree terminal. Runs via login shell.
  // Harness appends `--session-id <uuid>` so each tab has a stable resumable session.
  claudeCommand?: string
  // Extra environment variables injected into the PTY when spawning a Claude tab.
  // Merged on top of process.env so users can set things like ANTHROPIC_API_KEY,
  // DISABLE_TELEMETRY, etc. without editing their shell config.
  claudeEnvVars?: Record<string, string>
  // When false, Harness won't inject `--mcp-config <path>` pointing at the
  // bundled harness-control MCP server. Default is enabled (undefined/true).
  harnessMcpEnabled?: boolean
  // Persisted workspace panes nested by repoRoot → worktreePath → panes[].
  // Two repos can have worktrees with identical paths in theory, and the
  // multi-repo UI shows them together, so we key by repo to keep them distinct.
  panes?: Record<string, Record<string, PersistedPane[]>>
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

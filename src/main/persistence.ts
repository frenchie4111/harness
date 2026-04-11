import { app } from 'electron'
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, readdirSync } from 'fs'
import { join } from 'path'

export interface PersistedTab {
  id: string
  type: 'claude' | 'shell'
  label: string
  /** UUID passed to `claude --session-id` so the tab resumes its own session. Claude tabs only. */
  sessionId?: string
}

export interface PersistedPane {
  id: string
  tabs: PersistedTab[]
  activeTabId: string
}

export type QuestStep = 'hidden' | 'spawn-second' | 'switch-between' | 'finale' | 'done'

interface Config {
  windowBounds: { x: number; y: number; width: number; height: number } | null
  // All repo roots that have been opened (for re-opening windows)
  repoRoots: string[]
  // Custom hotkey overrides: action name → shortcut string (e.g. "Cmd+Shift+T")
  hotkeys?: Record<string, string>
  // Command used to launch Claude in a worktree terminal. Runs via login shell.
  // Harness appends `--session-id <uuid>` so each tab has a stable resumable session.
  claudeCommand?: string
  // Persisted workspace panes per worktree path — each pane has its own tabs + active id.
  // Replaces the legacy `terminalTabs` / `activeTabId` flat-list shape; migrated on load.
  panes?: Record<string, PersistedPane[]>
  // Legacy — migrated to `panes` on first load, then cleared.
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
  locallyMerged?: Record<string, string>
  // First-run parallelism quest — advances through steps as the user learns.
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
  windowBounds: null,
  repoRoots: []
}

function getConfigPath(): string {
  return join(app.getPath('userData'), 'config.json')
}

export function loadConfig(): Config {
  try {
    const data = readFileSync(getConfigPath(), 'utf-8')
    const parsed = JSON.parse(data)
    // Migrate from old single repoRoot format
    if (parsed.repoRoot && !parsed.repoRoots) {
      parsed.repoRoots = [parsed.repoRoot]
      delete parsed.repoRoot
    }
    // Migrate legacy flat-tab persistence → pane shape. Each worktree's
    // previous tab list becomes a single pane with the same active tab.
    // We intentionally leave the legacy `terminalTabs` / `activeTabId` keys
    // in place so users can downgrade to an older build without losing
    // their tab layout — the new app ignores them after migration.
    if (parsed.terminalTabs && !parsed.panes) {
      const migrated: Record<string, PersistedPane[]> = {}
      for (const [wtPath, tabs] of Object.entries(parsed.terminalTabs as Record<string, PersistedTab[]>)) {
        if (!tabs || tabs.length === 0) continue
        const activeId = parsed.activeTabId?.[wtPath] || tabs[0].id
        migrated[wtPath] = [{ id: `pane-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, tabs, activeTabId: activeId }]
      }
      parsed.panes = migrated
    }
    return { ...DEFAULT_CONFIG, ...parsed }
  } catch {
    return { ...DEFAULT_CONFIG }
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

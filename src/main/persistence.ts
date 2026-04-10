import { app } from 'electron'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

interface Config {
  windowBounds: { x: number; y: number; width: number; height: number } | null
  // All repo roots that have been opened (for re-opening windows)
  repoRoots: string[]
  // Custom hotkey overrides: action name → shortcut string (e.g. "Cmd+Shift+T")
  hotkeys?: Record<string, string>
  // Command used to launch Claude in a worktree terminal. Runs via login shell.
  claudeCommand?: string
}

export const DEFAULT_CLAUDE_COMMAND = 'claude --continue || (echo "Creating new Claude session for this worktree..." && claude)'

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

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { log } from '../debug'
import { harnessPluginDir } from '../claude-plugin'
import { shellQuote } from '../shell-quote'
import type { AgentSpawnOpts } from './index'

// Claude Code strips unknown fields when it normalizes settings.json,
// so dedup recognizes our entries by the status-dir path baked into
// the hook command instead of a sidecar marker.
const HARNESS_HOOK_COMMAND_SIGNATURE = '/tmp/harness-status'

export const defaultCommand = 'claude'
export const assignsSessionId = true

export const hookEvents = [
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'Notification'
]

interface HookEntry {
  matcher?: string
  hooks: { type: string; command: string; timeout?: number }[]
}

interface SettingsFile {
  hooks?: Record<string, HookEntry[]>
  [key: string]: unknown
}

function globalSettingsPath(): string {
  return join(homedir(), '.claude', 'settings.json')
}

function worktreeSettingsPath(worktreePath: string): string {
  return join(worktreePath, '.claude', 'settings.local.json')
}

function readSettings(path: string): SettingsFile {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    return {}
  }
}

function writeSettings(path: string, settings: SettingsFile): void {
  const dir = join(path, '..')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(path, JSON.stringify(settings, null, 2))
}

function isHarnessHookEntry(entry: HookEntry): boolean {
  return !!entry.hooks?.some(
    (h) => typeof h.command === 'string' && h.command.includes(HARNESS_HOOK_COMMAND_SIGNATURE)
  )
}

function removeOldHarnessEntries(entries: HookEntry[]): HookEntry[] {
  return entries.filter((entry) => !isHarnessHookEntry(entry))
}

/** One-shot migration: strip any legacy Harness entries from
 *  ~/.claude/settings.json. Harness used to install hooks there; we now
 *  ship them as a plugin loaded via --plugin-dir, so the user-scope copy
 *  is dead weight. Returns true if the file was modified. */
export function stripGlobalHooks(): boolean {
  const path = globalSettingsPath()
  if (!existsSync(path)) return false
  const settings = readSettings(path)
  if (!settings.hooks) return false
  let changed = false
  for (const event of Object.keys(settings.hooks)) {
    const before = settings.hooks[event].length
    settings.hooks[event] = removeOldHarnessEntries(settings.hooks[event])
    if (settings.hooks[event].length !== before) changed = true
    if (settings.hooks[event].length === 0) delete settings.hooks[event]
  }
  if (!changed) return false
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks
  writeSettings(path, settings)
  log('hooks', `stripped legacy Harness entries from ${path}`)
  return true
}

/** Strip any legacy Harness entries from a worktree's .claude/settings.local.json.
 *  Returns true if the file was modified. Leaves user-authored hooks alone. */
export function stripHooksFromWorktree(worktreePath: string): boolean {
  const path = worktreeSettingsPath(worktreePath)
  if (!existsSync(path)) return false
  const settings = readSettings(path)
  if (!settings.hooks) return false
  let changed = false
  for (const event of Object.keys(settings.hooks)) {
    const before = settings.hooks[event].length
    settings.hooks[event] = removeOldHarnessEntries(settings.hooks[event])
    if (settings.hooks[event].length !== before) changed = true
    if (settings.hooks[event].length === 0) delete settings.hooks[event]
  }
  if (!changed) return false
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks
  writeSettings(path, settings)
  log('hooks', `stripped legacy Harness entries from ${path}`)
  return true
}

export function sessionFileExists(cwd: string, sessionId: string): boolean {
  try {
    const encoded = cwd.replace(/[^a-zA-Z0-9]/g, '-')
    return existsSync(join(homedir(), '.claude', 'projects', encoded, `${sessionId}.jsonl`))
  } catch {
    return false
  }
}

export function latestSessionId(cwd: string): string | null {
  try {
    const encoded = cwd.replace(/[^a-zA-Z0-9]/g, '-')
    const dir = join(homedir(), '.claude', 'projects', encoded)
    const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
    if (files.length === 0) return null
    let bestId: string | null = null
    let bestMtime = -Infinity
    for (const file of files) {
      const mtime = statSync(join(dir, file)).mtimeMs
      if (mtime > bestMtime) {
        bestMtime = mtime
        bestId = file.replace(/\.jsonl$/, '')
      }
    }
    return bestId
  } catch {
    return null
  }
}

export function buildSpawnArgs(opts: AgentSpawnOpts): string {
  // No --mcp-config flag: the bundled Harness plugin ships its own
  // .mcp.json defining the harness-control bridge, loaded via the
  // --plugin-dir flag below. The bridge's per-session env (port,
  // token, terminal id, scope) is injected onto the PTY's env in
  // pty:create (src/main/index.ts) so the plugin's ${...} placeholders
  // resolve at Claude launch time.
  const modelFlag = opts.model && !opts.command.includes('--model') ? ` --model ${shellQuote(opts.model)}` : ''
  const nameFlag = opts.sessionName ? ` --name ${shellQuote(opts.sessionName)}` : ''
  const systemPromptFlag = opts.systemPrompt ? ` --append-system-prompt ${shellQuote(opts.systemPrompt)}` : ''
  const pluginFlag = ` --plugin-dir ${shellQuote(harnessPluginDir())}`
  const tuiPrefix = opts.tuiFullscreen ? 'CLAUDE_CODE_NO_FLICKER=1 ' : ''
  const cmd = `${tuiPrefix}${opts.command}${modelFlag}${nameFlag}${systemPromptFlag}${pluginFlag}`

  if (opts.teleportSessionId && opts.sessionId) {
    const exists = sessionFileExists(opts.cwd, opts.sessionId)
    if (!exists) {
      return `${cmd} --teleport ${opts.teleportSessionId} --session-id ${opts.sessionId}`
    }
  }

  if (!opts.sessionId) {
    return opts.initialPrompt ? `${cmd} ${shellQuote(opts.initialPrompt)}` : cmd
  }

  const exists = sessionFileExists(opts.cwd, opts.sessionId)
  if (exists) return `${cmd} --resume ${opts.sessionId}`
  const base = `${cmd} --session-id ${opts.sessionId}`
  return opts.initialPrompt ? `${base} ${shellQuote(opts.initialPrompt)}` : base
}

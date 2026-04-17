import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { log } from '../debug'
import { makeHookCommand } from '../hooks'
import type { AgentSpawnOpts } from './index'

function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'"
}

const HARNESS_HOOK_MARKER = '__claude_harness__'
const HARNESS_HOOK_VERSION = 8

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
  hooks: { type: string; command: string; timeout?: number; _marker?: string }[]
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

function makeHarnessHookEntry(command: string): HookEntry {
  return {
    hooks: [
      {
        type: 'command',
        command,
        timeout: 5,
        _marker: HARNESS_HOOK_MARKER,
        _version: HARNESS_HOOK_VERSION
      } as HookEntry['hooks'][number]
    ]
  }
}

function removeOldHarnessEntries(entries: HookEntry[]): HookEntry[] {
  return entries.filter((entry) => {
    const hasOurMarker = entry.hooks?.some(
      (h) => (h as Record<string, unknown>)._marker === HARNESS_HOOK_MARKER
    )
    return !hasOurMarker
  })
}

export function hooksInstalled(): boolean {
  const settings = readSettings(globalSettingsPath())
  const hooks = settings.hooks
  if (!hooks) return false
  for (const entries of Object.values(hooks)) {
    for (const entry of entries) {
      for (const h of entry.hooks || []) {
        const rec = h as Record<string, unknown>
        if (rec._marker === HARNESS_HOOK_MARKER && rec._version === HARNESS_HOOK_VERSION) return true
      }
    }
  }
  return false
}

export function installHooks(): void {
  const path = globalSettingsPath()
  log('hooks', `installing Claude hooks into ${path}`)
  const settings = readSettings(path)
  if (!settings.hooks) settings.hooks = {}

  for (const event of Object.keys(settings.hooks)) {
    settings.hooks[event] = removeOldHarnessEntries(settings.hooks[event])
  }

  for (const event of hookEvents) {
    if (!settings.hooks[event]) settings.hooks[event] = []
    settings.hooks[event].push(makeHarnessHookEntry(makeHookCommand(event)))
  }

  writeSettings(path, settings)
}

/** Remove our entries from ~/.claude/settings.json but leave any user-authored
 *  hooks + unrelated keys intact. No-op if we're not installed. */
export function uninstallHooks(): void {
  const path = globalSettingsPath()
  if (!existsSync(path)) return
  const settings = readSettings(path)
  if (!settings.hooks) return
  for (const event of Object.keys(settings.hooks)) {
    settings.hooks[event] = removeOldHarnessEntries(settings.hooks[event])
    if (settings.hooks[event].length === 0) delete settings.hooks[event]
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks
  writeSettings(path, settings)
  log('hooks', `uninstalled Claude hooks from ${path}`)
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
  const modelFlag = opts.model && !opts.command.includes('--model') ? ` --model ${shellQuote(opts.model)}` : ''
  const mcpFlag = opts.mcpConfigPath ? ` --mcp-config ${shellQuote(opts.mcpConfigPath)}` : ''
  const nameFlag = opts.sessionName ? ` --name ${shellQuote(opts.sessionName)}` : ''
  const systemPromptFlag = opts.systemPrompt ? ` --append-system-prompt ${shellQuote(opts.systemPrompt)}` : ''
  const cmd = `${opts.command}${modelFlag}${mcpFlag}${nameFlag}${systemPromptFlag}`

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

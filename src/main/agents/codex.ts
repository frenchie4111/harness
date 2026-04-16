import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, appendFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { log } from '../debug'
import { makeHookCommand } from '../hooks'
import type { AgentSpawnOpts } from './index'

function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'"
}

const HARNESS_HOOK_MARKER = '__codex_harness__'
const HARNESS_HOOK_VERSION = 1

export const defaultCommand = 'codex'
export const assignsSessionId = false

export const hookEvents = [
  'SessionStart',
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'Stop'
]

interface CodexHookEntry {
  matcher?: string
  hooks: { type: string; command: string; timeout?: number; _marker?: string; _version?: number }[]
}

interface CodexHooksFile {
  hooks?: Record<string, CodexHookEntry[]>
}

function globalHooksPath(): string {
  return join(homedir(), '.codex', 'hooks.json')
}

function worktreeHooksPath(worktreePath: string): string {
  return join(worktreePath, '.codex', 'hooks.json')
}

function readHooksFile(path: string): CodexHooksFile {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    return {}
  }
}

function writeHooksFile(path: string, data: CodexHooksFile): void {
  const dir = join(path, '..')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(path, JSON.stringify(data, null, 2))
}

function makeHarnessHookEntry(command: string): CodexHookEntry {
  return {
    hooks: [
      {
        type: 'command',
        command,
        timeout: 5,
        _marker: HARNESS_HOOK_MARKER,
        _version: HARNESS_HOOK_VERSION
      }
    ]
  }
}

function removeOldHarnessEntries(entries: CodexHookEntry[]): CodexHookEntry[] {
  return entries.filter((entry) => {
    const hasOurMarker = entry.hooks?.some(
      (h) => (h as Record<string, unknown>)._marker === HARNESS_HOOK_MARKER
    )
    return !hasOurMarker
  })
}

function ensureCodexHooksEnabled(): void {
  const configPath = join(homedir(), '.codex', 'config.toml')
  try {
    const content = existsSync(configPath) ? readFileSync(configPath, 'utf-8') : ''
    if (content.includes('codex_hooks')) return
    const section = content.includes('[features]') ? '' : '\n[features]\n'
    const line = 'codex_hooks = true\n'
    appendFileSync(configPath, section + line)
    log('hooks', 'enabled codex_hooks in ~/.codex/config.toml')
  } catch (err) {
    log('hooks', 'failed to enable codex_hooks', err instanceof Error ? err.message : err)
  }
}

export function hooksInstalled(): boolean {
  const data = readHooksFile(globalHooksPath())
  const hooks = data.hooks
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
  const path = globalHooksPath()
  log('hooks', `installing Codex hooks into ${path}`)

  ensureCodexHooksEnabled()

  const data = readHooksFile(path)
  if (!data.hooks) data.hooks = {}

  for (const event of Object.keys(data.hooks)) {
    data.hooks[event] = removeOldHarnessEntries(data.hooks[event])
  }

  for (const event of hookEvents) {
    if (!data.hooks[event]) data.hooks[event] = []
    data.hooks[event].push(makeHarnessHookEntry(makeHookCommand(event)))
  }

  writeHooksFile(path, data)
}

export function uninstallHooks(): void {
  const path = globalHooksPath()
  if (!existsSync(path)) return
  const data = readHooksFile(path)
  if (!data.hooks) return
  for (const event of Object.keys(data.hooks)) {
    data.hooks[event] = removeOldHarnessEntries(data.hooks[event])
    if (data.hooks[event].length === 0) delete data.hooks[event]
  }
  if (Object.keys(data.hooks).length === 0) delete data.hooks
  writeHooksFile(path, data)
  log('hooks', `uninstalled Codex hooks from ${path}`)
}

export function stripHooksFromWorktree(worktreePath: string): boolean {
  const path = worktreeHooksPath(worktreePath)
  if (!existsSync(path)) return false
  const data = readHooksFile(path)
  if (!data.hooks) return false
  let changed = false
  for (const event of Object.keys(data.hooks)) {
    const before = data.hooks[event].length
    data.hooks[event] = removeOldHarnessEntries(data.hooks[event])
    if (data.hooks[event].length !== before) changed = true
    if (data.hooks[event].length === 0) delete data.hooks[event]
  }
  if (!changed) return false
  if (Object.keys(data.hooks).length === 0) delete data.hooks
  writeHooksFile(path, data)
  log('hooks', `stripped legacy Harness Codex entries from ${path}`)
  return true
}

export function sessionFileExists(_cwd: string, sessionId: string): boolean {
  try {
    const sessionsDir = join(homedir(), '.codex', 'sessions')
    const walkDir = (dir: string): boolean => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (walkDir(join(dir, entry.name))) return true
        } else if (entry.name.includes(sessionId) && entry.name.endsWith('.jsonl')) {
          return true
        }
      }
      return false
    }
    return walkDir(sessionsDir)
  } catch {
    return false
  }
}

export function latestSessionId(_cwd: string): string | null {
  try {
    const sessionsDir = join(homedir(), '.codex', 'sessions')
    let bestId: string | null = null
    let bestMtime = -Infinity
    const walkDir = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          walkDir(full)
        } else if (entry.name.endsWith('.jsonl')) {
          const mtime = statSync(full).mtimeMs
          if (mtime > bestMtime) {
            bestMtime = mtime
            const stem = entry.name.replace(/\.jsonl$/, '')
            const uuidMatch = stem.match(/([0-9a-f]{4,}-[0-9a-f-]+)$/)
            bestId = uuidMatch ? uuidMatch[1] : stem
          }
        }
      }
    }
    walkDir(sessionsDir)
    return bestId
  } catch {
    return null
  }
}

export function buildSpawnArgs(opts: AgentSpawnOpts): string {
  // Codex MCP is configured globally via ~/.codex/config.toml, not per-terminal
  // flags. The mcpConfigPath is unused here but the MCP server was already
  // registered by the prepareMcpForTerminal IPC call.
  let cmd = opts.command
  if (opts.model && !opts.command.includes('--model') && !opts.command.includes('-m ')) {
    cmd += ` --model ${shellQuote(opts.model)}`
  }

  if (!opts.sessionId) {
    return opts.initialPrompt ? `${cmd} ${shellQuote(opts.initialPrompt)}` : cmd
  }

  const exists = sessionFileExists(opts.cwd, opts.sessionId)
  if (exists) return `${cmd} resume ${opts.sessionId}`

  return opts.initialPrompt ? `${cmd} ${shellQuote(opts.initialPrompt)}` : cmd
}

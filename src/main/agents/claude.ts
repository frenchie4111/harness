import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { log } from '../debug'
import type { AgentSpawnOpts } from './index'

function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'"
}

const HARNESS_HOOK_MARKER = '__claude_harness__'
const HARNESS_HOOK_VERSION = 8

export const defaultCommand = 'claude'

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

interface SettingsLocal {
  hooks?: Record<string, HookEntry[]>
  [key: string]: unknown
}

function getSettingsPath(worktreePath: string): string {
  return join(worktreePath, '.claude', 'settings.local.json')
}

function readSettingsLocal(worktreePath: string): SettingsLocal {
  const p = getSettingsPath(worktreePath)
  try {
    return JSON.parse(readFileSync(p, 'utf-8'))
  } catch {
    return {}
  }
}

function writeSettingsLocal(worktreePath: string, settings: SettingsLocal): void {
  const dir = join(worktreePath, '.claude')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(getSettingsPath(worktreePath), JSON.stringify(settings, null, 2))
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

export function hooksInstalled(worktreePath: string): boolean {
  const settings = readSettingsLocal(worktreePath)
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

export function installHooks(worktreePath: string): void {
  // Import makeHookCommand dynamically to avoid circular deps
  const { makeHookCommand } = require('../hooks') as { makeHookCommand: (event: string) => string }
  log('hooks', `installing Claude hooks in ${worktreePath}`)
  const settings = readSettingsLocal(worktreePath)
  if (!settings.hooks) settings.hooks = {}

  for (const event of Object.keys(settings.hooks)) {
    settings.hooks[event] = removeOldHarnessEntries(settings.hooks[event])
  }

  for (const event of hookEvents) {
    if (!settings.hooks[event]) settings.hooks[event] = []
    settings.hooks[event].push(makeHarnessHookEntry(makeHookCommand(event)))
  }

  writeSettingsLocal(worktreePath, settings)
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
  const mcpFlag = opts.mcpConfigPath ? ` --mcp-config ${shellQuote(opts.mcpConfigPath)}` : ''
  const nameFlag = opts.sessionName ? ` --name ${shellQuote(opts.sessionName)}` : ''
  const cmd = `${opts.command}${mcpFlag}${nameFlag}`

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

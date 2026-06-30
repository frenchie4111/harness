import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { log } from '../debug'
import { makeHookCommand } from '../hooks'
import type { AgentSpawnOpts } from './index'

function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'"
}

const HARNESS_HOOK_COMMAND_SIGNATURE = '/tmp/harness-status'

export const defaultCommand = 'agent'
export const assignsSessionId = false

export const hookEvents = [
  'preToolUse',
  'postToolUse',
  'beforeSubmitPrompt',
  'stop'
]

interface CursorHookEntry {
  command: string
  type?: string
  timeout?: number
  matcher?: string
}

interface CursorHooksFile {
  version?: number
  hooks?: Record<string, CursorHookEntry[]>
}

function globalHooksPath(): string {
  return join(homedir(), '.cursor', 'hooks.json')
}

function worktreeHooksPath(worktreePath: string): string {
  return join(worktreePath, '.cursor', 'hooks.json')
}

function readHooksFile(path: string): CursorHooksFile {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    return {}
  }
}

function writeHooksFile(path: string, data: CursorHooksFile): void {
  const dir = join(path, '..')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  if (data.version == null) data.version = 1
  writeFileSync(path, JSON.stringify(data, null, 2))
}

function makeHarnessHookEntry(command: string): CursorHookEntry {
  return { command, timeout: 5 }
}

function isHarnessHookEntry(entry: CursorHookEntry): boolean {
  return typeof entry.command === 'string' && entry.command.includes(HARNESS_HOOK_COMMAND_SIGNATURE)
}

function removeOldHarnessEntries(entries: CursorHookEntry[]): CursorHookEntry[] {
  return entries.filter((entry) => !isHarnessHookEntry(entry))
}

function sessionDir(sessionId: string): string | null {
  try {
    const chatsDir = join(homedir(), '.cursor', 'chats')
    if (!existsSync(chatsDir)) return null
    for (const entry of readdirSync(chatsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const candidate = join(chatsDir, entry.name, sessionId)
      if (existsSync(candidate)) return candidate
    }
    return null
  } catch {
    return null
  }
}

export function hooksInstalled(): boolean {
  const data = readHooksFile(globalHooksPath())
  const hooks = data.hooks
  if (!hooks) return false
  for (const entries of Object.values(hooks)) {
    for (const entry of entries) {
      if (isHarnessHookEntry(entry)) return true
    }
  }
  return false
}

export function installHooks(): void {
  const path = globalHooksPath()
  log('hooks', `installing Cursor Agent hooks into ${path}`)

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
  log('hooks', `uninstalled Cursor Agent hooks from ${path}`)
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
  log('hooks', `stripped legacy Harness Cursor Agent entries from ${path}`)
  return true
}

export function sessionFileExists(_cwd: string, sessionId: string): boolean {
  return sessionDir(sessionId) !== null
}

export function latestSessionId(_cwd: string): string | null {
  try {
    const chatsDir = join(homedir(), '.cursor', 'chats')
    if (!existsSync(chatsDir)) return null
    let bestId: string | null = null
    let bestMtime = -Infinity
    for (const hashEntry of readdirSync(chatsDir, { withFileTypes: true })) {
      if (!hashEntry.isDirectory()) continue
      const hashDir = join(chatsDir, hashEntry.name)
      for (const sessionEntry of readdirSync(hashDir, { withFileTypes: true })) {
        if (!sessionEntry.isDirectory()) continue
        const metaPath = join(hashDir, sessionEntry.name, 'meta.json')
        let mtime = statSync(join(hashDir, sessionEntry.name)).mtimeMs
        try {
          mtime = statSync(metaPath).mtimeMs
        } catch {
          // use directory mtime
        }
        if (mtime > bestMtime) {
          bestMtime = mtime
          bestId = sessionEntry.name
        }
      }
    }
    return bestId
  } catch {
    return null
  }
}

export function buildSpawnArgs(opts: AgentSpawnOpts): string {
  let cmd = opts.command
  if (opts.model && !opts.command.includes('--model')) {
    cmd += ` --model ${shellQuote(opts.model)}`
  }

  if (!opts.sessionId) {
    return opts.initialPrompt ? `${cmd} ${shellQuote(opts.initialPrompt)}` : cmd
  }

  const exists = sessionFileExists(opts.cwd, opts.sessionId)
  if (exists) return `${cmd} --resume ${opts.sessionId}`

  return opts.initialPrompt ? `${cmd} ${shellQuote(opts.initialPrompt)}` : cmd
}

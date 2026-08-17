import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { log } from '../debug'
import { makeHookCommand } from '../hooks'
import { shellQuote } from '../shell-quote'
import type { AgentSpawnOpts } from './index'

// Cursor strips unknown fields when it normalizes hooks.json, so dedup
// recognizes our entries by the status-dir path baked into the hook
// command instead of a sidecar marker.
const HARNESS_HOOK_COMMAND_SIGNATURE = '/tmp/harness-status'

export const defaultCommand = 'agent'
export const assignsSessionId = false

// Cursor uses camelCase event names; hooks.ts normalizes them to the
// Claude-style names before deriving statuses. sessionStart is included
// so the agent-assigned session ID is discovered at launch (its payload
// carries conversation_id) instead of on the first tool use.
export const hookEvents = [
  'sessionStart',
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

function projectsDir(): string {
  return join(homedir(), '.cursor', 'projects')
}

// Cursor slugs the absolute project path by dropping the leading '/' and
// replacing every remaining '/' with '-'. The slug is lossy (a literal
// hyphen in the path is indistinguishable from a slash separator), so
// callers that look for a specific session id fall back to a global scan.
function projectSlug(cwd: string): string {
  return cwd.replace(/^\/+/, '').replace(/\//g, '-')
}

// ~/.cursor/projects/<slug>/agent-transcripts/<session-uuid>/<session-uuid>.jsonl
function projectTranscriptsDir(cwd: string): string {
  return join(projectsDir(), projectSlug(cwd), 'agent-transcripts')
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
  log('hooks', `stripped legacy Ness Cursor Agent entries from ${path}`)
  return true
}

export function sessionFileExists(cwd: string, sessionId: string): boolean {
  try {
    if (existsSync(join(projectTranscriptsDir(cwd), sessionId))) return true
    // Fallback: session IDs are UUIDs, so a global scan can't produce a
    // false positive. Covers slug drift (symlinks, path hyphens vs.
    // separators, etc.) between our cwd and the slug Cursor recorded.
    const root = projectsDir()
    if (!existsSync(root)) return false
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      if (existsSync(join(root, entry.name, 'agent-transcripts', sessionId))) return true
    }
    return false
  } catch {
    return false
  }
}

// Scoped to the worktree's own project dir — this feeds session adoption
// when a pane initializes, and a global scan would resume whichever
// session was touched last across ALL projects.
export function latestSessionId(cwd: string): string | null {
  try {
    const dir = projectTranscriptsDir(cwd)
    if (!existsSync(dir)) return null
    let bestId: string | null = null
    let bestMtime = -Infinity
    for (const sessionEntry of readdirSync(dir, { withFileTypes: true })) {
      if (!sessionEntry.isDirectory()) continue
      const sessionPath = join(dir, sessionEntry.name)
      // The transcript jsonl is appended on every turn, so it's the freshest
      // recency signal; the directory mtime only changes when files are added.
      let mtime = statSync(sessionPath).mtimeMs
      try {
        mtime = statSync(join(sessionPath, `${sessionEntry.name}.jsonl`)).mtimeMs
      } catch {
        // no transcript yet — use directory mtime
      }
      if (mtime > bestMtime) {
        bestMtime = mtime
        bestId = sessionEntry.name
      }
    }
    return bestId
  } catch {
    return null
  }
}

export function extractSessionId(payload: Record<string, unknown>): string | null {
  const sid = payload.conversation_id
  return typeof sid === 'string' && sid ? sid : null
}

export function buildSpawnArgs(opts: AgentSpawnOpts): string {
  // Cursor's MCP config is global (~/.cursor/mcp.json), not a per-terminal
  // flag, so mcpConfigPath is unused here — same shape as codex.ts.
  let cmd = opts.command
  if (opts.model && !opts.command.includes('--model') && !opts.command.includes('-m ')) {
    cmd += ` --model ${shellQuote(opts.model)}`
  }

  if (!opts.sessionId) {
    return opts.initialPrompt ? `${cmd} ${shellQuote(opts.initialPrompt)}` : cmd
  }

  const exists = sessionFileExists(opts.cwd, opts.sessionId)
  if (exists) return `${cmd} --resume ${opts.sessionId}`

  return opts.initialPrompt ? `${cmd} ${shellQuote(opts.initialPrompt)}` : cmd
}

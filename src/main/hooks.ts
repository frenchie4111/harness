import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  watch,
  openSync,
  fstatSync,
  readSync,
  closeSync,
  unlinkSync
} from 'fs'
import { join } from 'path'
import { BrowserWindow } from 'electron'
import type { PtyStatus } from './pty-manager'
import { log } from './debug'

const STATUS_DIR = '/tmp/harness-status'
const HARNESS_HOOK_MARKER = '__claude_harness__'
// Bump this when the hook format changes to force reinstallation
const HARNESS_HOOK_VERSION = 7

// Emit a bash command that appends one NDJSON line per event to the
// terminal's log file at /tmp/harness-status/<id>.ndjson. The line wraps
// the full stdin payload Claude Code sends to the hook, so the main process
// has access to the raw event and can do all classification in TypeScript.
//
// POSIX only — no jq, no python. The bash reads stdin into a shell var,
// defaults empty to `null`, then emits a single printf writing one line to
// the append-mode file. A single write(2) under PIPE_BUF (4096 bytes) is
// guaranteed atomic vs. other O_APPEND writers on POSIX.
function makeHookCommand(event: string): string {
  const inner =
    `h="$CLAUDE_HARNESS_ID"; [ -z "$h" ] && exit 0; ` +
    `d=${STATUS_DIR}; mkdir -p "$d"; ` +
    `p=$(cat); [ -z "$p" ] && p=null; ` +
    `printf "{\\"event\\":\\"${event}\\",\\"ts\\":%s,\\"payload\\":%s}\\n" ` +
    `"$(date +%s)" "$p" >> "$d/$h.ndjson"`
  return `bash -c '${inner}'`
}

// Events we install hooks for. Every event uses the exact same shape —
// classification happens in TS against the raw payload.
const HOOK_EVENTS = [
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

/** Returns true if our hooks are installed AND at the current version */
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

/** Remove all old harness hooks from a hook entry array */
function removeOldHarnessEntries(entries: HookEntry[]): HookEntry[] {
  return entries.filter((entry) => {
    const hasOurMarker = entry.hooks?.some(
      (h) => (h as Record<string, unknown>)._marker === HARNESS_HOOK_MARKER
    )
    return !hasOurMarker
  })
}

/** Install our hooks into the worktree's .claude/settings.local.json, merging with existing */
export function installHooks(worktreePath: string): void {
  log('hooks', `installing hooks in ${worktreePath}`)
  const settings = readSettingsLocal(worktreePath)
  if (!settings.hooks) settings.hooks = {}

  for (const event of Object.keys(settings.hooks)) {
    settings.hooks[event] = removeOldHarnessEntries(settings.hooks[event])
  }

  for (const event of HOOK_EVENTS) {
    if (!settings.hooks[event]) settings.hooks[event] = []
    settings.hooks[event].push(makeHarnessHookEntry(makeHookCommand(event)))
  }

  writeSettingsLocal(worktreePath, settings)
}

interface HookEvent {
  event: string
  ts: number
  payload: Record<string, unknown> | null
}

function deriveStatus(ev: HookEvent): PtyStatus | null {
  switch (ev.event) {
    case 'UserPromptSubmit':
    case 'PreToolUse':
    case 'PostToolUse':
      return 'processing'
    case 'Stop':
      return 'waiting'
    case 'Notification': {
      const t = (ev.payload as Record<string, unknown> | null)?.notification_type
      if (t === 'permission_prompt' || t === 'elicitation_dialog') return 'needs-approval'
      if (t === 'idle_prompt') return 'waiting'
      return null
    }
    default:
      return null
  }
}

// Per-terminal byte offset into the NDJSON log. Tail from here on each
// fs.watch firing; advance to EOF after successful read.
const offsets = new Map<string, number>()
// Left-over partial line from the last read (in case a write lands
// between our read and the newline flush). Keyed by terminal id.
const residual = new Map<string, string>()

function tailLog(terminalId: string, win: BrowserWindow): void {
  const path = join(STATUS_DIR, `${terminalId}.ndjson`)
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch {
    return
  }
  try {
    const { size } = fstatSync(fd)
    let off = offsets.get(terminalId) ?? 0
    if (size < off) {
      // File was truncated or replaced — start over.
      off = 0
      residual.delete(terminalId)
    }
    if (size === off) return
    const len = size - off
    const buf = Buffer.alloc(len)
    readSync(fd, buf, 0, len, off)
    offsets.set(terminalId, size)

    const text = (residual.get(terminalId) ?? '') + buf.toString('utf-8')
    const lines = text.split('\n')
    // Last chunk may be a partial line; stash it for next read.
    const tail = lines.pop() ?? ''
    if (tail) residual.set(terminalId, tail)
    else residual.delete(terminalId)

    for (const line of lines) {
      if (!line.trim()) continue
      let ev: HookEvent
      try {
        ev = JSON.parse(line) as HookEvent
      } catch (err) {
        log('hooks', `parse error for ${terminalId}: ${err instanceof Error ? err.message : err}`, line)
        continue
      }
      log('hooks', `event terminal=${terminalId} event=${ev.event}`)
      const status = deriveStatus(ev)
      if (status) {
        win.webContents.send('terminal:status', terminalId, status)
      }
    }
  } finally {
    closeSync(fd)
  }
}

/** Watch the status directory for changes and emit status updates.
 *  getWindowForTerminal returns the BrowserWindow that owns the terminal, or null. */
export function watchStatusDir(
  getWindowForTerminal: (id: string) => BrowserWindow | null
): () => void {
  mkdirSync(STATUS_DIR, { recursive: true })

  log('hooks', `watching status dir: ${STATUS_DIR}`)

  const watcher = watch(STATUS_DIR, (_eventType, filename) => {
    if (!filename || !filename.endsWith('.ndjson')) return
    if (filename.startsWith('.')) return
    const terminalId = filename.replace(/\.ndjson$/, '')
    const win = getWindowForTerminal(terminalId)
    if (!win) return
    try {
      tailLog(terminalId, win)
    } catch (err) {
      log('hooks', `tail failed for ${terminalId}`, err instanceof Error ? err.message : err)
    }
  })

  return () => watcher.close()
}

/** Called on terminal death — drop the log file and reset tailing state. */
export function cleanupTerminalLog(terminalId: string): void {
  offsets.delete(terminalId)
  residual.delete(terminalId)
  try {
    unlinkSync(join(STATUS_DIR, `${terminalId}.ndjson`))
  } catch {
    // file may not exist; ignore
  }
}

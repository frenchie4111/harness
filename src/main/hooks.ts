import { readFileSync, writeFileSync, mkdirSync, existsSync, watch } from 'fs'
import { join } from 'path'
import { BrowserWindow } from 'electron'
import type { PtyStatus } from './pty-manager'
import { log } from './debug'

const STATUS_DIR = '/tmp/harness-status'
const HARNESS_HOOK_MARKER = '__claude_harness__'
// Bump this when the hook format changes to force reinstallation
const HARNESS_HOOK_VERSION = 4

// Per-event hook commands. Each event type gets its own simple command
// that writes the appropriate status. No jq dependency — these don't need
// to parse stdin, they just know what event they're attached to.
// Uses CLAUDE_HARNESS_ID env var (set by our PTY manager) to key the file.
function makeHookCommand(status: string): string {
  return (
    'bash -c \'hid="$CLAUDE_HARNESS_ID"; [ -z "$hid" ] && exit 0; ' +
    'mkdir -p ' + STATUS_DIR + '; ' +
    'echo "{\\"status\\":\\"' + status + '\\",\\"ts\\":$(date +%s)}" > ' + STATUS_DIR + '/$hid.json\''
  )
}

// For Notification we need to distinguish idle_prompt vs permission_prompt.
// The matcher field on the hook entry filters by notification_type, so we
// use separate hook entries per notification type.
const NOTIFICATION_HOOKS: { matcher: string; status: string }[] = [
  { matcher: 'idle_prompt', status: 'waiting' },
  { matcher: 'permission_prompt', status: 'needs-approval' },
  { matcher: 'elicitation_dialog', status: 'needs-approval' }
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

function makeHarnessHookEntry(command: string, matcher?: string): HookEntry {
  return {
    ...(matcher ? { matcher } : {}),
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

  // Remove any old-version harness hooks first
  for (const event of Object.keys(settings.hooks)) {
    settings.hooks[event] = removeOldHarnessEntries(settings.hooks[event])
  }

  // Notification hooks — for permission/approval detection
  if (!settings.hooks['Notification']) settings.hooks['Notification'] = []
  for (const { matcher, status } of NOTIFICATION_HOOKS) {
    settings.hooks['Notification'].push(makeHarnessHookEntry(makeHookCommand(status), matcher))
  }

  // Stop — fires immediately when Claude finishes its turn
  if (!settings.hooks['Stop']) settings.hooks['Stop'] = []
  settings.hooks['Stop'].push(makeHarnessHookEntry(makeHookCommand('waiting')))

  // Processing signals
  for (const event of ['UserPromptSubmit', 'PreToolUse']) {
    if (!settings.hooks[event]) settings.hooks[event] = []
    settings.hooks[event].push(makeHarnessHookEntry(makeHookCommand('processing')))
  }

  writeSettingsLocal(worktreePath, settings)
}

/** Watch the status directory for changes and emit status updates.
 *  getWindowForTerminal returns the BrowserWindow that owns the terminal, or null. */
export function watchStatusDir(
  getWindowForTerminal: (id: string) => BrowserWindow | null
): () => void {
  mkdirSync(STATUS_DIR, { recursive: true })

  log('hooks', `watching status dir: ${STATUS_DIR}`)

  const watcher = watch(STATUS_DIR, (eventType, filename) => {
    if (!filename || !filename.endsWith('.json')) return
    const terminalId = filename.replace('.json', '')
    const win = getWindowForTerminal(terminalId)
    if (!win) {
      log('hooks', `status file changed for unknown terminal: ${filename}`)
      return
    }

    try {
      const raw = readFileSync(join(STATUS_DIR, filename), 'utf-8')
      const data = JSON.parse(raw)
      const status = data.status as PtyStatus
      log('hooks', `status update: terminal=${terminalId} status=${status}`, data)
      if (status) {
        win.webContents.send('terminal:status', terminalId, status)
      }
    } catch (err) {
      log('hooks', `failed to read status file: ${filename}`, err instanceof Error ? err.message : err)
    }
  })

  return () => watcher.close()
}

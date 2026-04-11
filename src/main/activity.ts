import { app } from 'electron'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { log } from './debug'

export type ActivityState = 'processing' | 'waiting' | 'needs-approval' | 'idle'

export interface ActivityEvent {
  /** epoch ms */
  t: number
  /** state entered at time t */
  s: ActivityState
}

/** Map of worktree path → append-only list of state transitions. */
export type ActivityLog = Record<string, ActivityEvent[]>

const MAX_EVENTS_PER_WORKTREE = 5000

let cache: ActivityLog | null = null
let saveTimer: ReturnType<typeof setTimeout> | null = null

function getPath(): string {
  return join(app.getPath('userData'), 'activity.json')
}

function load(): ActivityLog {
  if (cache) return cache
  try {
    const raw = readFileSync(getPath(), 'utf-8')
    cache = JSON.parse(raw) as ActivityLog
  } catch {
    cache = {}
  }
  return cache
}

function scheduleSave(): void {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    if (!cache) return
    try {
      writeFileSync(getPath(), JSON.stringify(cache))
    } catch (e) {
      log('activity', 'save failed', e instanceof Error ? e.message : e)
    }
  }, 1000)
}

/** Record a state for a worktree. Deduplicates — only writes if state changed. */
export function recordActivity(worktreePath: string, state: ActivityState): void {
  const logMap = load()
  const events = logMap[worktreePath] || (logMap[worktreePath] = [])
  const last = events[events.length - 1]
  if (last && last.s === state) return
  events.push({ t: Date.now(), s: state })
  if (events.length > MAX_EVENTS_PER_WORKTREE) {
    events.splice(0, events.length - MAX_EVENTS_PER_WORKTREE)
  }
  scheduleSave()
}

export function getActivityLog(): ActivityLog {
  return load()
}

export function clearActivityForWorktree(worktreePath: string): void {
  const logMap = load()
  delete logMap[worktreePath]
  scheduleSave()
}

export function clearAllActivity(): void {
  cache = {}
  scheduleSave()
}

/** Close out any non-idle worktree segments with an idle marker.
 *  Call on app quit so gaps while the app is closed don't render as the last
 *  known state stretching forever. Writes synchronously — the debounce timer
 *  won't fire during shutdown. */
export function sealAllActive(): void {
  const logMap = load()
  let changed = false
  for (const events of Object.values(logMap)) {
    const last = events[events.length - 1]
    if (last && last.s !== 'idle') {
      events.push({ t: Date.now(), s: 'idle' })
      changed = true
    }
  }
  if (!changed) return
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  try {
    writeFileSync(getPath(), JSON.stringify(cache))
  } catch (e) {
    log('activity', 'seal save failed', e instanceof Error ? e.message : e)
  }
}

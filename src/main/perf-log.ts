import { appendFile, appendFileSync, existsSync, renameSync, statSync, unlinkSync } from 'fs'
import { join } from 'path'
import { userDataDir } from './paths'

// Append-only across sessions — the user is debugging lag that may have
// happened earlier in the session, possibly before the most recent restart,
// so unlike debug.log we don't truncate on startup. We do rotate, because an
// unbounded file is both a disk hazard and a write-latency one.
//
// Writes are buffered and flushed asynchronously. The naive version called
// appendFileSync per line, which put a blocking syscall on the main thread for
// every traced event — at production event rates that's ~1M blocking writes a
// session, i.e. the profiler became a top source of the lag it was measuring.
const FLUSH_INTERVAL_MS = 1000
const MAX_BUFFERED_LINES = 500
const MAX_LOG_BYTES = 10 * 1024 * 1024

let logPath: string | null = null
let headerWritten = false
let buffer: string[] = []
let flushTimer: NodeJS.Timeout | null = null
let flushing = false

function getLogPath(): string {
  if (!logPath) {
    logPath = join(userDataDir(), 'perf.log')
  }
  return logPath
}

/** Rotate into a single `.1` archive once the live file exceeds the cap,
 *  mirroring debug.log. Sync is fine here: it happens at most once per 10MB. */
function rotateIfNeeded(path: string): void {
  try {
    if (statSync(path).size < MAX_LOG_BYTES) return
    const archive = `${path}.1`
    if (existsSync(archive)) unlinkSync(archive)
    renameSync(path, archive)
  } catch {
    // Missing file or a losing race with another rotation — nothing to do.
  }
}

function flush(): void {
  if (flushing || buffer.length === 0) return
  flushing = true
  const chunk = buffer.join('')
  buffer = []
  const path = getLogPath()
  rotateIfNeeded(path)
  appendFile(path, chunk, () => {
    flushing = false
    // Anything queued while the write was in flight goes out on the next tick
    // rather than recursing here, so a hot stream can't starve the loop.
    if (buffer.length > 0) scheduleFlush()
  })
}

function scheduleFlush(): void {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    flush()
  }, FLUSH_INTERVAL_MS)
  // Never hold the process open just to write a diagnostic log.
  flushTimer.unref?.()
}

function ensureHeader(path: string): void {
  if (headerWritten) return
  headerWritten = true
  const sep = existsSync(path) ? '\n' : ''
  buffer.push(`${sep}=== session started at ${new Date().toISOString()} ===\n`)
}

export function perfLog(category: string, message: string, data?: unknown): void {
  const path = getLogPath()
  ensureHeader(path)
  const ts = new Date().toISOString().slice(11, 23) // HH:MM:SS.mmm
  let line = `[${ts}] [${category}] ${message}`
  if (data !== undefined) {
    try {
      line += ' ' + JSON.stringify(data)
    } catch {
      line += ' [unserializable]'
    }
  }
  buffer.push(line + '\n')
  // Bound memory if something floods faster than the flush interval.
  if (buffer.length >= MAX_BUFFERED_LINES) flush()
  else scheduleFlush()
}

/** Drain synchronously — for shutdown, where an async flush would be dropped. */
export function flushPerfLogSync(): void {
  if (buffer.length === 0) return
  const chunk = buffer.join('')
  buffer = []
  try {
    appendFileSync(getLogPath(), chunk)
  } catch {
    // ignore write errors
  }
}

export function getPerfLogFilePath(): string {
  return getLogPath()
}

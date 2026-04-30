import { appendFileSync, existsSync } from 'fs'
import { join } from 'path'
import { userDataDir } from './paths'

// Append-only across sessions — the user is debugging lag that may have
// happened earlier in the session, possibly before the most recent restart,
// so unlike debug.log we don't truncate on startup.
let logPath: string | null = null
let headerWritten = false

function getLogPath(): string {
  if (!logPath) {
    logPath = join(userDataDir(), 'perf.log')
  }
  return logPath
}

function ensureHeader(path: string): void {
  if (headerWritten) return
  headerWritten = true
  const sep = existsSync(path) ? '\n' : ''
  try {
    appendFileSync(path, `${sep}=== session started at ${new Date().toISOString()} ===\n`)
  } catch {
    // ignore write errors
  }
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
  try {
    appendFileSync(path, line + '\n')
  } catch {
    // ignore write errors
  }
}

export function getPerfLogFilePath(): string {
  return getLogPath()
}

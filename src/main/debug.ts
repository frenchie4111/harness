import { appendFileSync, existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { userDataDir } from './paths'

// Append-only across sessions. Crash forensics require seeing what
// happened BEFORE the most recent restart — the user usually only
// notices something went wrong after they've already restarted, at
// which point a clear-on-startup policy has destroyed the evidence.
// Rotated at MAX_BYTES into a single `.1` archive; manual clear via
// `npm run log:clear`.
const MAX_BYTES = 10 * 1024 * 1024
const ROTATE_CHECK_EVERY = 1000

let logPath: string | null = null
let writesSinceLastRotateCheck = 0

function rotateIfNeeded(): void {
  if (!logPath) return
  try {
    const st = statSync(logPath)
    if (st.size < MAX_BYTES) return
    const archivePath = logPath + '.1'
    try { unlinkSync(archivePath) } catch { /* didn't exist */ }
    renameSync(logPath, archivePath)
  } catch {
    // file doesn't exist, or stat failed — nothing to rotate
  }
}

function getLogPath(): string {
  if (!logPath) {
    logPath = join(userDataDir(), 'debug.log')
    rotateIfNeeded()
    try {
      appendFileSync(logPath, `=== Claude Harness debug log session started at ${new Date().toISOString()} ===\n`)
    } catch {
      writeFileSync(logPath, `=== Claude Harness debug log started at ${new Date().toISOString()} ===\n`)
    }
  }
  return logPath
}

export function log(category: string, message: string, data?: unknown): void {
  const ts = new Date().toISOString().slice(11, 23) // HH:MM:SS.mmm
  let line = `[${ts}] [${category}] ${message}`
  if (data !== undefined) {
    try {
      line += ' ' + JSON.stringify(data)
    } catch {
      line += ' [unserializable]'
    }
  }
  console.log(line)
  try {
    appendFileSync(getLogPath(), line + '\n')
  } catch {
    // ignore write errors
  }
  if (++writesSinceLastRotateCheck >= ROTATE_CHECK_EVERY) {
    writesSinceLastRotateCheck = 0
    rotateIfNeeded()
  }
}

export function getLogFilePath(): string {
  return getLogPath()
}

export function formatErr(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  const cause = (err as { cause?: unknown })?.cause
  if (cause === undefined || cause === null) return msg
  const causeMsg = cause instanceof Error ? cause.message : String(cause)
  const causeCode = (cause as { code?: unknown })?.code
  return causeCode ? `${msg} cause=${causeMsg} code=${String(causeCode)}` : `${msg} cause=${causeMsg}`
}

export function readRecentDebugLog(maxLines = 200): string {
  const path = getLogPath()
  if (!existsSync(path)) return ''
  try {
    const content = readFileSync(path, 'utf-8')
    const lines = content.split('\n')
    const tail = lines.slice(-Math.max(1, maxLines))
    return tail.join('\n').trim()
  } catch {
    return ''
  }
}

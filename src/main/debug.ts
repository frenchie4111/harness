import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { userDataDir } from './paths'

let logPath: string | null = null

function getLogPath(): string {
  if (!logPath) {
    logPath = join(userDataDir(), 'debug.log')
    // Clear on startup
    writeFileSync(logPath, `=== Claude Harness debug log started at ${new Date().toISOString()} ===\n`)
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
}

export function getLogFilePath(): string {
  return getLogPath()
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

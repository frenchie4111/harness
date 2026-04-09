import { appendFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'

let logPath: string | null = null

function getLogPath(): string {
  if (!logPath) {
    logPath = join(app.getPath('userData'), 'debug.log')
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

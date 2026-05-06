// Run a login + interactive shell once at boot, capture its PATH, and
// merge into process.env.PATH so child processes spawned later (the
// bundled claude, MCP bridges, anything spawned without a shell wrapper)
// see homebrew/nvm/pyenv/etc. on PATH the same way they would in the
// user's terminal. Runs in both Electron-local and headless (Node)
// boots — headless can also start with a stripped PATH when launched
// via `ssh host 'harness-server'` or a systemd/launchd unit.
//
// We merge rather than replace so launcher-prepended entries (npm
// putting `node_modules/.bin` first when running `npm run dev`, an
// explicit `Environment=PATH=...` in a systemd unit, etc.) keep their
// priority. Order is: existing entries that aren't already in captured,
// followed by the full captured list. Net effect: `node_modules/.bin`
// stays first; Homebrew/nvm get appended only if missing.
//
// Sentinel-delimited capture skips noise from rc files (starship init,
// nvm "Loading...", etc. that print during shell startup). Timeout
// bounds boot if the user's shell init is genuinely broken.

import { spawn } from 'child_process'
import { resolveUserShell } from './user-shell'
import { log } from './debug'

const BEGIN = '__HARNESS_PATH_BEGIN__'
const END = '__HARNESS_PATH_END__'
const PROBE = `printf '${BEGIN}\\n%s\\n${END}\\n' "$PATH"`
const DEFAULT_TIMEOUT_MS = 3000

export function parseProbeOutput(stdout: string): string | null {
  const beginIdx = stdout.indexOf(BEGIN)
  if (beginIdx < 0) return null
  const lineStart = stdout.indexOf('\n', beginIdx + BEGIN.length)
  if (lineStart < 0) return null
  const endIdx = stdout.indexOf(END, lineStart + 1)
  if (endIdx < 0) return null
  const innerEnd = stdout.lastIndexOf('\n', endIdx - 1)
  if (innerEnd <= lineStart) return null
  return stdout.slice(lineStart + 1, innerEnd)
}

export async function capturePath(
  shellPath: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<string | null> {
  return new Promise((resolve) => {
    let stdout = ''
    let timedOut = false
    let settled = false
    const finish = (value: string | null): void => {
      if (settled) return
      settled = true
      resolve(value)
    }

    let child
    try {
      child = spawn(shellPath, ['-ilc', PROBE], {
        stdio: ['ignore', 'pipe', 'ignore']
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log('path-fix', `spawn failed (shell=${shellPath}): ${msg}`)
      finish(null)
      return
    }

    const timer = setTimeout(() => {
      timedOut = true
      log('path-fix', `probe timed out after ${timeoutMs}ms (shell=${shellPath})`)
      try {
        child.kill('SIGKILL')
      } catch {
        // already dead
      }
      finish(null)
    }, timeoutMs)

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      log('path-fix', `spawn error (shell=${shellPath}): ${err.message}`)
      finish(null)
    })
    child.on('close', () => {
      clearTimeout(timer)
      if (timedOut) return
      const captured = parseProbeOutput(stdout)
      if (captured == null) {
        log('path-fix', `probe output missing sentinels (shell=${shellPath})`)
      }
      finish(captured)
    })
  })
}

export function mergePaths(existing: string | undefined, captured: string): string {
  const capturedEntries = captured.split(':').filter((e) => e.length > 0)
  if (!existing) return capturedEntries.join(':')
  const capturedSet = new Set(capturedEntries)
  const seen = new Set<string>()
  const existingOnly: string[] = []
  for (const e of existing.split(':')) {
    if (e === '') continue
    if (capturedSet.has(e)) continue
    if (seen.has(e)) continue
    seen.add(e)
    existingOnly.push(e)
  }
  return [...existingOnly, ...capturedEntries].join(':')
}

export async function fixPathFromLoginShell(): Promise<void> {
  if (process.platform !== 'darwin') return
  try {
    const shell = resolveUserShell()
    const captured = await capturePath(shell)
    if (captured == null) return
    const existing = process.env.PATH ?? ''
    const merged = mergePaths(existing, captured)
    if (merged === existing) return
    log(
      'path-fix',
      `PATH merged from ${shell} (${existing.length} → ${merged.length} chars)`
    )
    process.env.PATH = merged
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log('path-fix', `unexpected error, skipping fix: ${msg}`)
  }
}

import { log } from './debug'

type Recorder = () => void
let recorder: Recorder | null = null
let loggingEnabled = false

const DEFAULT_TIMEOUT_MS = 30_000

export function setGitHubApiRecorder(fn: Recorder | null): void {
  recorder = fn
}

export function setGitHubApiLoggingEnabled(enabled: boolean): void {
  loggingEnabled = enabled
}

export async function trackedFetch(url: string, init?: RequestInit): Promise<Response> {
  const method = init?.method ?? 'GET'
  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)
  // Chain caller's signal if present so either can cancel the fetch.
  // AbortSignal.any is available in Node 20+ and modern Electron.
  const signal = init?.signal
    ? AbortSignal.any([init.signal, controller.signal])
    : controller.signal
  try {
    const res = await fetch(url, { ...init, signal })
    if (loggingEnabled) {
      const ms = Date.now() - started
      log('github-api', `${method} ${shortPath(url)} → ${res.status} (${ms}ms)`)
    }
    recorder?.()
    return res
  } catch (err) {
    if (loggingEnabled) {
      const ms = Date.now() - started
      log('github-api', `${method} ${shortPath(url)} → error (${ms}ms): ${err instanceof Error ? err.message : String(err)}`)
    }
    recorder?.()
    // Distinguish our timeout from a caller-initiated abort so downstream
    // log lines are actionable ("timeout" vs generic AbortError).
    if (
      controller.signal.aborted &&
      (!init?.signal || !init.signal.aborted) &&
      err instanceof Error &&
      err.name === 'AbortError'
    ) {
      throw new Error(`GitHub request timed out after ${DEFAULT_TIMEOUT_MS}ms: ${method} ${shortPath(url)}`)
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

function shortPath(url: string): string {
  return url.replace(/^https:\/\/api\.github\.com/, '')
}

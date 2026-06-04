import { log } from './debug'

type Recorder = () => void
let recorder: Recorder | null = null
let loggingEnabled = false

export function setGitHubApiRecorder(fn: Recorder | null): void {
  recorder = fn
}

export function setGitHubApiLoggingEnabled(enabled: boolean): void {
  loggingEnabled = enabled
}

export async function trackedFetch(url: string, init?: RequestInit): Promise<Response> {
  const method = init?.method ?? 'GET'
  const started = Date.now()
  try {
    const res = await fetch(url, init)
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
    throw err
  }
}

function shortPath(url: string): string {
  return url.replace(/^https:\/\/api\.github\.com/, '')
}

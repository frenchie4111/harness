import { log } from './debug'
import type {
  GitHubApiEntry,
  GitHubApiLogSnapshot,
  GitHubApiMinuteBucket,
  GitHubApiRateLimit
} from '../shared/github-api-log-types'

type Recorder = () => void
type LogSubscriber = (entry: GitHubApiEntry) => void

// Ring buffer capacity. 2000 entries at ~200B each is well under 1MB and
// covers a couple of hours of typical PR-poller cadence, which is what
// we want for "did rate limit spike an hour ago?" retrospectives.
export const MAX_ENTRIES = 2000
const MINUTE_BUCKETS = 60

// Ceiling on any single GitHub request. Without this a mid-request hang
// stalls the PR poller forever (repro: monorepo with ~50 worktrees
// hitting GitHub 504s), leaving locally-merged worktrees stuck in
// "Active" indefinitely. 30s is the ceiling for anything — we'd rather
// fail fast and let the next poll retry.
const DEFAULT_TIMEOUT_MS = 30_000

// Redaction note: `init.headers` is INTENTIONALLY never captured, because
// it carries the user's GitHub PAT in the Authorization header. Any future
// "capture headers for debugging" toggle needs to explicitly redact
// Authorization / X-Github-* header names before it can land. The
// operationName sniff on GraphQL bodies is the ONE thing we pull from the
// request; the parsed body is not stored anywhere.

let recorder: Recorder | null = null
let loggingEnabled = false

const entries: GitHubApiEntry[] = []
const subscribers = new Set<LogSubscriber>()
let nextId = 1
let totalRecorded = 0

const minuteBuckets: GitHubApiMinuteBucket[] = []
let rateLimit: GitHubApiRateLimit | undefined

export function setGitHubApiRecorder(fn: Recorder | null): void {
  recorder = fn
}

export function setGitHubApiLoggingEnabled(enabled: boolean): void {
  loggingEnabled = enabled
}

export function subscribeGitHubApiLog(fn: LogSubscriber): () => void {
  subscribers.add(fn)
  return () => {
    subscribers.delete(fn)
  }
}

export function getGitHubApiLogSnapshot(): GitHubApiLogSnapshot {
  return {
    entries: entries.slice(),
    minuteBuckets: minuteBuckets.slice(),
    rateLimit,
    totalRecorded,
    maxEntries: MAX_ENTRIES
  }
}

export function clearGitHubApiLog(): void {
  entries.length = 0
  minuteBuckets.length = 0
  totalRecorded = 0
  nextId = 1
  rateLimit = undefined
}

// Test helper — also drops subscribers, which prod callers never want.
export function __resetGitHubApiRecorderForTests(): void {
  clearGitHubApiLog()
  subscribers.clear()
  recorder = null
  loggingEnabled = false
}

function minuteFloor(t: number): number {
  return Math.floor(t / 60_000) * 60_000
}

function ensureBucketFor(t: number): GitHubApiMinuteBucket {
  const start = minuteFloor(t)
  const last = minuteBuckets[minuteBuckets.length - 1]
  if (last && last.startedAt === start) return last
  const bucket: GitHubApiMinuteBucket = {
    startedAt: start,
    count: 0,
    errorCount: 0,
    totalDurationMs: 0,
    maxDurationMs: 0
  }
  minuteBuckets.push(bucket)
  while (minuteBuckets.length > MINUTE_BUCKETS) minuteBuckets.shift()
  return bucket
}

function appendEntry(entry: GitHubApiEntry): void {
  entries.push(entry)
  if (entries.length > MAX_ENTRIES) entries.shift()
  totalRecorded++

  const bucket = ensureBucketFor(entry.startedAt)
  bucket.count++
  const failed =
    entry.error != null || (entry.status != null && entry.status >= 500)
  if (failed) bucket.errorCount++
  bucket.totalDurationMs += entry.durationMs
  if (entry.durationMs > bucket.maxDurationMs) bucket.maxDurationMs = entry.durationMs

  if (
    entry.rateLimitLimit != null &&
    entry.rateLimitRemaining != null &&
    entry.rateLimitReset != null
  ) {
    rateLimit = {
      limit: entry.rateLimitLimit,
      remaining: entry.rateLimitRemaining,
      reset: entry.rateLimitReset,
      lastUpdatedAt: entry.startedAt
    }
  }

  for (const sub of subscribers) {
    try {
      sub(entry)
    } catch {
      // Subscribers must never break the fetch path.
    }
  }
}

function sanitizeUrl(url: string): string {
  try {
    const u = new URL(url)
    for (const key of Array.from(u.searchParams.keys())) {
      if (/token|auth|key/i.test(key)) u.searchParams.set(key, '<redacted>')
    }
    return u.toString()
  } catch {
    return url
  }
}

function shortPath(url: string): string {
  return url.replace(/^https:\/\/api\.github\.com/, '')
}

function extractOperationName(
  init: RequestInit | undefined,
  url: string
): string | undefined {
  if (init?.method !== 'POST') return undefined
  if (!url.endsWith('/graphql')) return undefined
  const body = init.body
  if (typeof body !== 'string') return undefined
  try {
    const parsed = JSON.parse(body) as { operationName?: unknown }
    if (
      typeof parsed.operationName === 'string' &&
      parsed.operationName.length > 0
    ) {
      return parsed.operationName
    }
    return undefined
  } catch {
    return undefined
  }
}

function parseIntHeader(v: string | null): number | undefined {
  if (v == null) return undefined
  const n = Number.parseInt(v, 10)
  return Number.isFinite(n) ? n : undefined
}

function extractRateLimit(headers: Headers | undefined): {
  rateLimitLimit?: number
  rateLimitRemaining?: number
  rateLimitReset?: number
} {
  // Guard against Response mocks that don't carry a real Headers object.
  if (!headers || typeof headers.get !== 'function') return {}
  return {
    rateLimitLimit: parseIntHeader(headers.get('x-ratelimit-limit')),
    rateLimitRemaining: parseIntHeader(headers.get('x-ratelimit-remaining')),
    rateLimitReset: parseIntHeader(headers.get('x-ratelimit-reset'))
  }
}

export async function trackedFetch(
  url: string,
  init?: RequestInit
): Promise<Response> {
  const method = init?.method ?? 'GET'
  const started = Date.now()
  const cleanUrl = sanitizeUrl(url)
  const operationName = extractOperationName(init, url)

  // Timeout via AbortController. Chain the caller's signal (if any) via
  // AbortSignal.any so either side can cancel the fetch. AbortSignal.any
  // is available in Node 20+ and modern Electron.
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)
  const signal = init?.signal
    ? AbortSignal.any([init.signal, controller.signal])
    : controller.signal

  try {
    const res = await fetch(url, { ...init, signal })
    const durationMs = Date.now() - started
    const rl = extractRateLimit(res.headers)
    const entry: GitHubApiEntry = {
      id: nextId++,
      startedAt: started,
      method,
      url: cleanUrl,
      shortPath: shortPath(cleanUrl),
      operationName,
      status: res.status,
      statusText: res.statusText || undefined,
      durationMs,
      ...rl
    }
    appendEntry(entry)
    if (loggingEnabled) {
      log(
        'github-api',
        `${method} ${entry.shortPath} → ${res.status} (${durationMs}ms)`
      )
    }
    recorder?.()
    return res
  } catch (err) {
    const durationMs = Date.now() - started
    // Distinguish our timeout from a caller-initiated abort so downstream
    // log lines are actionable ("timeout" vs generic AbortError).
    const timedOut =
      controller.signal.aborted &&
      (!init?.signal || !init.signal.aborted) &&
      err instanceof Error &&
      err.name === 'AbortError'
    const originalMessage = err instanceof Error ? err.message : String(err)
    const message = timedOut
      ? `GitHub request timed out after ${DEFAULT_TIMEOUT_MS}ms: ${method} ${shortPath(cleanUrl)}`
      : originalMessage
    const entry: GitHubApiEntry = {
      id: nextId++,
      startedAt: started,
      method,
      url: cleanUrl,
      shortPath: shortPath(cleanUrl),
      operationName,
      durationMs,
      error: message
    }
    appendEntry(entry)
    if (loggingEnabled) {
      log(
        'github-api',
        `${method} ${entry.shortPath} → error (${durationMs}ms): ${message}`
      )
    }
    recorder?.()
    if (timedOut) throw new Error(message)
    throw err
  } finally {
    clearTimeout(timer)
  }
}

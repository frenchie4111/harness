// Types shared between the main-side github-recorder (which owns the
// ring buffer + rollups) and the renderer's GitHubApiLogPanel (which
// polls the snapshot every second). Kept in `shared/` because both
// runtimes reference the shapes; the recorder itself lives in `main/`.
//
// Bodies are intentionally NOT part of any type here — see the comment
// in `main/github-recorder.ts` for the rationale (Authorization / token
// leakage). Only `operationName` is sniffed from GraphQL bodies.

export interface GitHubApiEntry {
  id: number
  startedAt: number
  method: string
  url: string
  shortPath: string
  operationName?: string
  status?: number
  statusText?: string
  durationMs: number
  error?: string
  rateLimitLimit?: number
  rateLimitRemaining?: number
  rateLimitReset?: number
}

export interface GitHubApiMinuteBucket {
  startedAt: number
  count: number
  errorCount: number
  totalDurationMs: number
  maxDurationMs: number
}

export interface GitHubApiRateLimit {
  limit: number
  remaining: number
  reset: number
  lastUpdatedAt: number
}

export interface GitHubApiLogSnapshot {
  entries: GitHubApiEntry[]
  minuteBuckets: GitHubApiMinuteBucket[]
  rateLimit?: GitHubApiRateLimit
  totalRecorded: number
  maxEntries: number
}

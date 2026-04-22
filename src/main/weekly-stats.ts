// Weekly stats computation. Reads the persisted activity log + git log +
// current slice state and returns a plain JSON summary over the last 7
// days. Called on-demand by the WeeklyWrappedScreen via the
// `stats:getWeekly` IPC — no subscriptions, no caching beyond a single
// request.

import { execFile } from 'child_process'
import { promisify } from 'util'
import type { ActivityLog, ActivityState } from './activity'
import { getActivityLog } from './activity'
import type { PRsState } from '../shared/state/prs'
import type { WorktreesState } from '../shared/state/worktrees'
import type { TopWorktree, WeeklyStats } from '../shared/weekly-stats'

export type { TopWorktree, WeeklyStats }

const execFileAsync = promisify(execFile)

const DAY_MS = 24 * 60 * 60 * 1000
const WINDOW_MS = 7 * DAY_MS

const DAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function isActive(s: ActivityState): boolean {
  return s === 'processing' || s === 'waiting' || s === 'needs-approval'
}

function hourLabel(h: number): string {
  const suffix = h < 12 ? 'AM' : 'PM'
  const hour12 = h % 12 === 0 ? 12 : h % 12
  return `${hour12} ${suffix}`
}

/** Walk a worktree's timeline within [since, until] and attribute minutes to
 *  day-of-week, hour-of-day, and calendar-day buckets. Also counts transitions
 *  into `processing` that came from `needs-approval` (user approvals). */
function accumulateTimeline(
  events: Array<{ t: number; s: ActivityState }>,
  since: number,
  until: number,
  buckets: {
    perDow: number[]
    perHour: number[]
    perDayMs: Map<number, number>
  }
): { activeMs: number; approvals: number } {
  if (events.length === 0) return { activeMs: 0, approvals: 0 }

  let activeMs = 0
  let approvals = 0

  // Treat the state before the first event as 'idle' — we can only count
  // what the deriver actually recorded.
  for (let i = 0; i < events.length; i++) {
    const ev = events[i]
    const next = events[i + 1]
    const segStart = Math.max(ev.t, since)
    const segEnd = Math.min(next ? next.t : until, until)
    if (segEnd <= segStart) {
      // Still check approval transition even if segment is outside window.
      if (next && ev.s === 'needs-approval' && next.s === 'processing' && next.t >= since && next.t <= until) {
        approvals++
      }
      continue
    }
    if (isActive(ev.s)) {
      const dur = segEnd - segStart
      activeMs += dur
      // Slice into per-hour / per-day-of-week / per-calendar-day chunks.
      // For typical session lengths the loop body runs a handful of times.
      let cursor = segStart
      while (cursor < segEnd) {
        const d = new Date(cursor)
        const hourBoundary = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() + 1).getTime()
        const dayBoundary = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime()
        const chunkEnd = Math.min(hourBoundary, dayBoundary, segEnd)
        const chunkMs = chunkEnd - cursor
        buckets.perHour[d.getHours()] += chunkMs
        buckets.perDow[d.getDay()] += chunkMs
        const dayKey = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
        buckets.perDayMs.set(dayKey, (buckets.perDayMs.get(dayKey) ?? 0) + chunkMs)
        cursor = chunkEnd
      }
    }
    // Approval = user clicking through a pending tool use.
    if (next && ev.s === 'needs-approval' && next.s === 'processing' && next.t >= since && next.t <= until) {
      approvals++
    }
  }
  return { activeMs, approvals }
}

async function countCommitsInRepo(
  repoRoot: string,
  since: number,
  authorEmail: string | null
): Promise<{ commits: number; additions: number; deletions: number }> {
  const sinceIso = new Date(since).toISOString()
  const args = [
    'log',
    '--all',
    `--since=${sinceIso}`,
    '--no-merges',
    '--pretty=format:%H',
    '--numstat'
  ]
  if (authorEmail) args.splice(3, 0, `--author=${authorEmail}`)
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd: repoRoot,
      maxBuffer: 20 * 1024 * 1024
    })
    const seen = new Set<string>()
    let additions = 0
    let deletions = 0
    let currentHash: string | null = null
    for (const rawLine of stdout.split('\n')) {
      const line = rawLine.trim()
      if (!line) {
        currentHash = null
        continue
      }
      // Hashes are 40 hex chars; numstat rows are "<add>\t<del>\t<path>".
      if (/^[0-9a-f]{40}$/.test(line)) {
        currentHash = line
        seen.add(line)
        continue
      }
      if (!currentHash) continue
      const parts = line.split('\t')
      if (parts.length < 2) continue
      const add = parts[0] === '-' ? 0 : parseInt(parts[0], 10) || 0
      const del = parts[1] === '-' ? 0 : parseInt(parts[1], 10) || 0
      additions += add
      deletions += del
    }
    return { commits: seen.size, additions, deletions }
  } catch {
    return { commits: 0, additions: 0, deletions: 0 }
  }
}

async function getGitUserEmail(repoRoot: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['config', 'user.email'], { cwd: repoRoot })
    const email = stdout.trim()
    return email || null
  } catch {
    return null
  }
}

export async function computeWeeklyStats(
  activity: ActivityLog,
  prs: PRsState,
  worktrees: WorktreesState
): Promise<WeeklyStats> {
  const until = Date.now()
  const since = until - WINDOW_MS

  // ── Activity-derived buckets ────────────────────────────────────────
  const perDow = new Array(7).fill(0)
  const perHour = new Array(24).fill(0)
  const perDayMs = new Map<number, number>()
  const perWorktreeMs = new Map<string, number>()

  let totalActiveMs = 0
  let approvalsHandedOut = 0
  let prsMerged = 0
  let worktreesCreated = 0

  for (const [path, rec] of Object.entries(activity)) {
    // Has the worktree's final 'merged' event landed in the window?
    // (finalizeActivity pushes a terminal 'merged' or 'idle' event.)
    if (rec.prState === 'merged' && rec.removedAt && rec.removedAt >= since && rec.removedAt <= until) {
      prsMerged++
    } else {
      // A locally-merged worktree with a terminal 'merged' event also counts.
      const last = rec.events[rec.events.length - 1]
      if (last && last.s === 'merged' && last.t >= since && last.t <= until) {
        prsMerged++
      }
    }

    if (rec.createdAt && rec.createdAt >= since && rec.createdAt <= until) {
      worktreesCreated++
    }

    const { activeMs, approvals } = accumulateTimeline(
      rec.events,
      since,
      until,
      { perDow, perHour, perDayMs }
    )
    totalActiveMs += activeMs
    approvalsHandedOut += approvals
    if (activeMs > 0) perWorktreeMs.set(path, activeMs)
  }

  // ── Day bucket (aligned to today, going back 7 calendar days) ──────
  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const dailyMinutes: number[] = []
  for (let i = 6; i >= 0; i--) {
    const dayKey = todayStart - i * DAY_MS
    dailyMinutes.push(Math.round((perDayMs.get(dayKey) ?? 0) / 60000))
  }

  // ── Busiest day / peak hour ────────────────────────────────────────
  let busiestDay: WeeklyStats['busiestDay'] = null
  let bestDowMs = 0
  for (let d = 0; d < 7; d++) {
    if (perDow[d] > bestDowMs) {
      bestDowMs = perDow[d]
      busiestDay = { dayOfWeek: d, label: DAY_LABELS[d], minutes: Math.round(perDow[d] / 60000) }
    }
  }

  let peakHour: WeeklyStats['peakHour'] = null
  let bestHourMs = 0
  for (let h = 0; h < 24; h++) {
    if (perHour[h] > bestHourMs) {
      bestHourMs = perHour[h]
      peakHour = { hour: h, label: hourLabel(h), minutes: Math.round(perHour[h] / 60000) }
    }
  }

  // ── Top worktrees ──────────────────────────────────────────────────
  const topWorktrees: TopWorktree[] = Array.from(perWorktreeMs.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([path, ms]) => {
      const rec = activity[path]
      const repoRoot = rec?.repoRoot ?? ''
      const repoLabel = repoRoot.split('/').filter(Boolean).pop() ?? ''
      return {
        path,
        branch: rec?.branch ?? path.split('/').pop() ?? path,
        repoLabel,
        minutes: Math.round(ms / 60000)
      }
    })

  // ── Git-derived: commits + line deltas across every known repo ─────
  let commits = 0
  let linesAdded = 0
  let linesRemoved = 0
  const seenRepos = new Set<string>(worktrees.repoRoots)
  // Include any repoRoots surfaced only by historical activity (repos the
  // user removed from Harness but still committed in this week).
  for (const rec of Object.values(activity)) {
    if (rec.repoRoot) seenRepos.add(rec.repoRoot)
  }
  // Author filter: take the email from the first resolvable repo.
  let authorEmail: string | null = null
  for (const root of seenRepos) {
    authorEmail = await getGitUserEmail(root)
    if (authorEmail) break
  }
  for (const root of seenRepos) {
    const r = await countCommitsInRepo(root, since, authorEmail)
    commits += r.commits
    linesAdded += r.additions
    linesRemoved += r.deletions
  }

  // ── PRs open (currently) ───────────────────────────────────────────
  let prsOpen = 0
  for (const pr of Object.values(prs.byPath)) {
    if (pr && (pr.state === 'open' || pr.state === 'draft')) prsOpen++
  }

  return {
    since,
    until,
    commits,
    linesAdded,
    linesRemoved,
    prsMerged,
    prsOpen,
    worktreesCreated,
    activeMinutes: Math.round(totalActiveMs / 60000),
    approvalsHandedOut,
    busiestDay,
    peakHour,
    topWorktrees,
    dailyMinutes
  }
}

/** Convenience wrapper that pulls live state out of the store. */
export async function getWeeklyStats(
  prs: PRsState,
  worktrees: WorktreesState
): Promise<WeeklyStats> {
  return computeWeeklyStats(getActivityLog(), prs, worktrees)
}

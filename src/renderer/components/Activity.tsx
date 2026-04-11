import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, Flame, Clock, Zap, GitBranch, RefreshCw } from 'lucide-react'
import type { Worktree, ActivityLog, ActivityEvent, ActivityState } from '../types'

interface ActivityProps {
  onClose: () => void
  worktrees: Worktree[]
}

type Range = '1h' | '6h' | '24h' | '7d'

const RANGES: { id: Range; label: string; ms: number }[] = [
  { id: '1h', label: '1h', ms: 60 * 60 * 1000 },
  { id: '6h', label: '6h', ms: 6 * 60 * 60 * 1000 },
  { id: '24h', label: '24h', ms: 24 * 60 * 60 * 1000 },
  { id: '7d', label: '7d', ms: 7 * 24 * 60 * 60 * 1000 }
]

const STATE_COLOR: Record<ActivityState, string> = {
  processing: 'bg-success/80',
  waiting: 'bg-warning/80',
  'needs-approval': 'bg-danger/80',
  idle: 'bg-faint/20'
}

const STATE_LABEL: Record<ActivityState, string> = {
  processing: 'working',
  waiting: 'waiting on you',
  'needs-approval': 'needs approval',
  idle: 'idle'
}

/** Convert an events list into a series of [start, end, state] segments
 *  clamped to [windowStart, now]. */
function eventsToSegments(
  events: ActivityEvent[],
  windowStart: number,
  windowEnd: number
): { start: number; end: number; state: ActivityState }[] {
  if (events.length === 0) return []
  const segs: { start: number; end: number; state: ActivityState }[] = []
  for (let i = 0; i < events.length; i++) {
    const e = events[i]
    const next = events[i + 1]
    const segStart = e.t
    const segEnd = next ? next.t : windowEnd
    if (segEnd <= windowStart) continue
    if (segStart >= windowEnd) break
    segs.push({
      start: Math.max(segStart, windowStart),
      end: Math.min(segEnd, windowEnd),
      state: e.s
    })
  }
  return segs
}

function formatDuration(ms: number): string {
  if (ms < 1000) return '0s'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  const mm = m % 60
  if (h < 24) return mm ? `${h}h ${mm}m` : `${h}h`
  const d = Math.floor(h / 24)
  return `${d}d ${h % 24}h`
}

function basename(p: string): string {
  const parts = p.split('/')
  return parts[parts.length - 1] || p
}

export function Activity({ onClose, worktrees }: ActivityProps): JSX.Element {
  const [log, setLog] = useState<ActivityLog>({})
  const [range, setRange] = useState<Range>('24h')
  const [now, setNow] = useState(Date.now())
  const [loading, setLoading] = useState(true)

  const loadLog = async (): Promise<void> => {
    setLoading(true)
    try {
      const data = await window.api.getActivityLog()
      setLog(data)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadLog()
  }, [])

  // Tick so active worktrees extend their current state in real time.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 2000)
    return () => clearInterval(id)
  }, [])

  const rangeMs = RANGES.find((r) => r.id === range)!.ms
  const windowStart = now - rangeMs

  // Order worktrees: those with data first (by most recent activity), then others.
  const orderedPaths = useMemo(() => {
    const knownPaths = new Set(worktrees.map((w) => w.path))
    const seen = new Set<string>()
    const withActivity: { path: string; lastT: number }[] = []
    for (const [path, events] of Object.entries(log)) {
      if (!events.length) continue
      if (!knownPaths.has(path)) continue
      seen.add(path)
      withActivity.push({ path, lastT: events[events.length - 1].t })
    }
    withActivity.sort((a, b) => b.lastT - a.lastT)
    const rest = worktrees.filter((w) => !seen.has(w.path)).map((w) => w.path)
    return [...withActivity.map((w) => w.path), ...rest]
  }, [log, worktrees])

  // Totals across the window
  const totals = useMemo(() => {
    const totalsByState: Record<ActivityState, number> = {
      processing: 0,
      waiting: 0,
      'needs-approval': 0,
      idle: 0
    }
    let longestFlow = 0
    let activeWorktrees = 0
    for (const path of orderedPaths) {
      const events = log[path] || []
      const segs = eventsToSegments(events, windowStart, now)
      let hadAny = false
      for (const seg of segs) {
        const dur = seg.end - seg.start
        totalsByState[seg.state] += dur
        if (seg.state === 'processing') {
          if (dur > longestFlow) longestFlow = dur
          hadAny = true
        }
        if (seg.state === 'waiting' || seg.state === 'needs-approval') hadAny = true
      }
      if (hadAny) activeWorktrees++
    }
    return { totalsByState, longestFlow, activeWorktrees }
  }, [log, orderedPaths, windowStart, now])

  const handleReset = async (): Promise<void> => {
    if (!confirm('Clear all activity history? This cannot be undone.')) return
    await window.api.clearActivityLog()
    await loadLog()
  }

  return (
    <div className="flex flex-col h-full w-full bg-panel">
      <div className="drag-region h-10 shrink-0 border-b border-border relative">
        <button
          onClick={onClose}
          className="no-drag absolute left-4 top-1/2 -translate-y-1/2 flex items-center gap-1.5 text-xs text-muted hover:text-fg-bright transition-colors cursor-pointer"
        >
          <ArrowLeft size={14} />
          Back
        </button>
        <span className="absolute left-1/2 -translate-x-1/2 top-1/2 -translate-y-1/2 text-sm font-medium text-fg pointer-events-none">
          Activity
        </span>
        <div className="no-drag absolute right-4 top-1/2 -translate-y-1/2 flex items-center gap-2">
          <button
            onClick={loadLog}
            className="text-muted hover:text-fg-bright transition-colors cursor-pointer p-1"
            title="Refresh"
          >
            <RefreshCw size={13} />
          </button>
          <button
            onClick={handleReset}
            className="text-xs text-muted hover:text-danger transition-colors cursor-pointer"
          >
            reset
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-5xl mx-auto px-8 py-8">
          {/* Range selector */}
          <div className="flex items-center gap-2 mb-6">
            <span className="text-xs text-dim uppercase tracking-wider mr-2">Range</span>
            {RANGES.map((r) => (
              <button
                key={r.id}
                onClick={() => setRange(r.id)}
                className={`px-2.5 py-1 rounded text-xs font-mono transition-colors cursor-pointer ${
                  range === r.id
                    ? 'bg-accent/25 text-fg-bright border border-accent/40'
                    : 'bg-surface/40 text-muted hover:text-fg border border-transparent'
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>

          {/* Stat cards */}
          <div className="grid grid-cols-4 gap-3 mb-8">
            <StatCard
              icon={Zap}
              label="Flow time"
              value={formatDuration(totals.totalsByState.processing)}
              tint="text-success"
              sub="Claude working"
            />
            <StatCard
              icon={Clock}
              label="Wait time"
              value={formatDuration(
                totals.totalsByState.waiting + totals.totalsByState['needs-approval']
              )}
              tint="text-warning"
              sub="waiting on you"
            />
            <StatCard
              icon={Flame}
              label="Longest flow"
              value={formatDuration(totals.longestFlow)}
              tint="text-danger"
              sub="single session"
            />
            <StatCard
              icon={GitBranch}
              label="Active worktrees"
              value={String(totals.activeWorktrees)}
              tint="text-info"
              sub="in this range"
            />
          </div>

          {/* Timeline */}
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-fg-bright">Timeline</h2>
            <Legend />
          </div>

          {loading && <div className="text-sm text-dim py-8 text-center">Loading…</div>}

          {!loading && orderedPaths.length === 0 && (
            <div className="text-sm text-dim py-12 text-center">
              No worktrees yet.
            </div>
          )}

          {!loading && orderedPaths.length > 0 && (
            <div className="bg-app/50 border border-border rounded-xl p-5">
              <TimeAxis windowStart={windowStart} windowEnd={now} />
              <div className="space-y-2 mt-2">
                {orderedPaths.map((path) => {
                  const events = log[path] || []
                  const segs = eventsToSegments(events, windowStart, now)
                  const wt = worktrees.find((w) => w.path === path)
                  return (
                    <WorktreeRow
                      key={path}
                      label={wt?.branch || basename(path)}
                      segments={segs}
                      windowStart={windowStart}
                      windowEnd={now}
                    />
                  )
                })}
              </div>
            </div>
          )}

          <p className="text-xs text-dim mt-6 text-center">
            Activity is recorded locally from Claude Code hooks. Each bar shows when that worktree was working, waiting, or blocked on you.
          </p>
        </div>
      </div>
    </div>
  )
}

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  tint
}: {
  icon: React.ComponentType<{ size?: number; className?: string }>
  label: string
  value: string
  sub: string
  tint: string
}): JSX.Element {
  return (
    <div className="bg-app/50 border border-border rounded-xl p-4">
      <div className="flex items-center gap-2 mb-2">
        <Icon size={14} className={tint} />
        <span className="text-[10px] uppercase tracking-wider text-dim">{label}</span>
      </div>
      <div className={`text-2xl font-bold ${tint} tabular-nums`}>{value}</div>
      <div className="text-[10px] text-dim mt-0.5">{sub}</div>
    </div>
  )
}

function Legend(): JSX.Element {
  return (
    <div className="flex items-center gap-3 text-[10px] text-dim">
      <span className="flex items-center gap-1.5">
        <span className="w-2.5 h-2.5 rounded-sm bg-success/80" />
        working
      </span>
      <span className="flex items-center gap-1.5">
        <span className="w-2.5 h-2.5 rounded-sm bg-warning/80" />
        waiting
      </span>
      <span className="flex items-center gap-1.5">
        <span className="w-2.5 h-2.5 rounded-sm bg-danger/80" />
        needs approval
      </span>
    </div>
  )
}

function TimeAxis({ windowStart, windowEnd }: { windowStart: number; windowEnd: number }): JSX.Element {
  // 5 evenly spaced tick marks
  const ticks = [0, 0.25, 0.5, 0.75, 1]
  const span = windowEnd - windowStart
  const fmt = (t: number): string => {
    if (span <= 2 * 60 * 60 * 1000) {
      // short range — minutes ago
      const mAgo = Math.round((windowEnd - t) / 60000)
      return mAgo === 0 ? 'now' : `${mAgo}m`
    }
    if (span <= 48 * 60 * 60 * 1000) {
      // day range — HH:MM
      const d = new Date(t)
      return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
    }
    const d = new Date(t)
    return `${d.getMonth() + 1}/${d.getDate()}`
  }
  return (
    <div className="flex items-center ml-28 mb-1">
      <div className="flex-1 relative h-4">
        {ticks.map((p) => {
          const t = windowStart + p * span
          return (
            <div
              key={p}
              className="absolute text-[9px] text-dim tabular-nums -translate-x-1/2"
              style={{ left: `${p * 100}%` }}
            >
              {fmt(t)}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function WorktreeRow({
  label,
  segments,
  windowStart,
  windowEnd
}: {
  label: string
  segments: { start: number; end: number; state: ActivityState }[]
  windowStart: number
  windowEnd: number
}): JSX.Element {
  const span = windowEnd - windowStart
  return (
    <div className="flex items-center gap-3">
      <span className="text-[11px] text-muted font-mono w-28 shrink-0 truncate" title={label}>
        {label}
      </span>
      <div className="flex-1 relative h-6 rounded-md overflow-hidden border border-border bg-faint/5">
        {segments.map((seg, i) => {
          if (seg.state === 'idle') return null
          const leftPct = ((seg.start - windowStart) / span) * 100
          const widthPct = ((seg.end - seg.start) / span) * 100
          if (widthPct <= 0) return null
          return (
            <div
              key={i}
              className={`absolute top-0 h-full ${STATE_COLOR[seg.state]} hover:brightness-125 transition-all`}
              style={{
                left: `${leftPct}%`,
                width: `${Math.max(widthPct, 0.15)}%`
              }}
              title={`${STATE_LABEL[seg.state]} — ${formatDuration(seg.end - seg.start)}`}
            />
          )
        })}
      </div>
    </div>
  )
}

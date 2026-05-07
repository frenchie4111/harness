import { useEffect, useMemo, useState } from 'react'
import { Loader2, ChevronDown, ChevronRight, ChevronUp } from 'lucide-react'
import type { SessionCostSummary } from '../types'
import {
  emptyBreakdown,
  cloneBreakdown,
  addBreakdown,
  type ContentBreakdown
} from '../../shared/state/costs'
import { useWorktrees } from '../store'

type Range = '24h' | '7d' | '30d' | 'all'

const RANGES: { id: Range; label: string; ms: number | null }[] = [
  { id: '24h', label: 'Last 24h', ms: 24 * 60 * 60 * 1000 },
  { id: '7d', label: 'Last 7 days', ms: 7 * 24 * 60 * 60 * 1000 },
  { id: '30d', label: 'Last 30 days', ms: 30 * 24 * 60 * 60 * 1000 },
  { id: 'all', label: 'All time', ms: null }
]

const DEFAULT_VISIBLE_REPOS = 5
const BREAKDOWN_VISIBLE_ROWS = 5

function basename(p: string): string {
  const parts = p.split('/').filter(Boolean)
  return parts[parts.length - 1] || p
}

function formatAge(ms: number): string {
  if (ms < 0) return 'just now'
  const s = Math.floor(ms / 1000)
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d ago`
  const mo = Math.floor(d / 30)
  return `${mo}mo ago`
}

function formatModel(model: string | null): string {
  if (!model) return '—'
  return model.replace(/^claude-/, '').replace(/-\d{8}$/, '')
}

const dollarsBig = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
})
const dollarsSmall = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 4,
  maximumFractionDigits: 4
})

function formatCost(usd: number): string {
  if (usd === 0) return '$0.00'
  if (usd < 0.01) return dollarsSmall.format(usd)
  return dollarsBig.format(usd)
}

interface WorktreeGroup {
  worktreePath: string
  branch: string | null
  totalCostUsd: number
  turns: number
  lastAt: number
  sessions: SessionCostSummary[]
  models: Set<string>
}

interface RepoGroup {
  repoRoot: string
  totalCostUsd: number
  turns: number
  lastAt: number
  worktrees: WorktreeGroup[]
}

export function ActivityCosts(): JSX.Element {
  const [range, setRange] = useState<Range>('7d')
  const [data, setData] = useState<SessionCostSummary[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [showAllRepos, setShowAllRepos] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const worktrees = useWorktrees()

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setShowAllRepos(false)
    setExpanded(new Set())
    const ms = RANGES.find((r) => r.id === range)!.ms
    const sinceMs = ms == null ? undefined : Date.now() - ms
    void window.api
      .getAllSessionCosts(sinceMs)
      .then((rows) => {
        if (cancelled) return
        setData(rows)
        setLoading(false)
      })
      .catch(() => {
        if (cancelled) return
        setData([])
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [range])

  // Map known worktree paths -> {repoRoot, branch}. Sessions whose
  // projectPath doesn't match a current worktree fall through to the
  // "Other" repo bucket and use their projectPath as the worktree key.
  const worktreeIndex = useMemo(() => {
    const idx = new Map<string, { repoRoot: string; branch: string }>()
    for (const w of worktrees.list) {
      idx.set(w.path, { repoRoot: w.repoRoot, branch: w.branch })
    }
    return idx
  }, [worktrees.list])

  const repos = useMemo<RepoGroup[]>(() => {
    if (!data) return []
    const byRepo = new Map<string, Map<string, WorktreeGroup>>()
    for (const s of data) {
      const wt = worktreeIndex.get(s.projectPath)
      const repoKey = wt?.repoRoot ?? '__other__'
      let wtMap = byRepo.get(repoKey)
      if (!wtMap) {
        wtMap = new Map()
        byRepo.set(repoKey, wtMap)
      }
      let group = wtMap.get(s.projectPath)
      if (!group) {
        group = {
          worktreePath: s.projectPath,
          branch: wt?.branch ?? null,
          totalCostUsd: 0,
          turns: 0,
          lastAt: 0,
          sessions: [],
          models: new Set()
        }
        wtMap.set(s.projectPath, group)
      }
      group.totalCostUsd += s.totalCostUsd
      group.turns += s.turns
      if (s.lastAt > group.lastAt) group.lastAt = s.lastAt
      group.sessions.push(s)
      if (s.model) group.models.add(s.model)
    }

    const out: RepoGroup[] = []
    for (const [repoRoot, wtMap] of byRepo) {
      const worktreeArr = [...wtMap.values()]
      worktreeArr.sort((a, b) => b.totalCostUsd - a.totalCostUsd)
      let total = 0
      let turns = 0
      let lastAt = 0
      for (const w of worktreeArr) {
        total += w.totalCostUsd
        turns += w.turns
        if (w.lastAt > lastAt) lastAt = w.lastAt
        w.sessions.sort((a, b) => b.totalCostUsd - a.totalCostUsd)
      }
      out.push({
        repoRoot,
        totalCostUsd: total,
        turns,
        lastAt,
        worktrees: worktreeArr
      })
    }
    out.sort((a, b) => b.totalCostUsd - a.totalCostUsd)
    return out
  }, [data, worktreeIndex])

  const total = useMemo(() => {
    if (!data) return 0
    return data.reduce((acc, r) => acc + r.totalCostUsd, 0)
  }, [data])

  const aggregateBreakdown = useMemo<ContentBreakdown>(() => {
    const acc = cloneBreakdown(emptyBreakdown)
    if (!data) return acc
    for (const row of data) addBreakdown(acc, row.breakdown)
    return acc
  }, [data])

  const visibleRepos = showAllRepos ? repos : repos.slice(0, DEFAULT_VISIBLE_REPOS)
  const hiddenRepos = Math.max(0, repos.length - DEFAULT_VISIBLE_REPOS)
  const rangeLabel = RANGES.find((r) => r.id === range)!.label.toLowerCase()
  const now = Date.now()

  const toggle = (key: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  return (
    <div className="max-w-5xl mx-auto px-8 py-8">
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

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <div className="bg-app/50 border border-border rounded-xl p-6 md:col-span-1">
          <div className="text-[10px] uppercase tracking-wider text-dim mb-2">Total</div>
          {loading ? (
            <div className="flex items-center gap-2 text-muted">
              <Loader2 size={16} className="animate-spin" />
              <span className="text-sm">Parsing session history…</span>
            </div>
          ) : (
            <>
              <div className="text-3xl font-bold text-accent tabular-nums">
                {formatCost(total)}
              </div>
              <div className="text-xs text-dim mt-1">
                spent in the {rangeLabel} across {data?.length ?? 0}{' '}
                {data?.length === 1 ? 'session' : 'sessions'}
              </div>
            </>
          )}
        </div>

        <div className="bg-app/50 border border-border rounded-xl p-6 md:col-span-2">
          <div className="text-[10px] uppercase tracking-wider text-dim mb-3">
            Cost by type
          </div>
          {loading ? (
            <div className="flex items-center gap-2 text-muted">
              <Loader2 size={16} className="animate-spin" />
              <span className="text-sm">Computing breakdown…</span>
            </div>
          ) : total > 0 ? (
            <BreakdownPanel breakdown={aggregateBreakdown} total={total} />
          ) : (
            <div className="text-sm text-dim italic">No usage in this range.</div>
          )}
        </div>
      </div>

      {!loading && repos.length === 0 && (
        <div className="text-sm text-dim py-12 text-center">
          No json-mode sessions in the selected period.
        </div>
      )}

      {!loading && repos.length > 0 && (
        <div className="bg-app/50 border border-border rounded-xl overflow-hidden">
          <div className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-4 px-3 py-2 border-b border-border bg-surface/40 text-[10px] uppercase tracking-wider text-dim">
            <span>Repository / worktree</span>
            <span className="text-right w-24">Cost</span>
            <span className="text-right w-24">Last active</span>
            <span className="text-right w-16">Turns</span>
          </div>
          <div>
            {visibleRepos.map((repo) => (
              <RepoRow
                key={repo.repoRoot}
                repo={repo}
                expanded={expanded}
                onToggle={toggle}
                now={now}
              />
            ))}
          </div>
          {hiddenRepos > 0 && (
            <button
              onClick={() => setShowAllRepos((s) => !s)}
              className="w-full px-3 py-2 text-xs text-muted hover:text-fg-bright hover:bg-surface/30 border-t border-border/50 cursor-pointer transition-colors flex items-center justify-center gap-1.5"
            >
              {showAllRepos ? (
                <>
                  <ChevronUp size={12} />
                  Show top {DEFAULT_VISIBLE_REPOS}
                </>
              ) : (
                <>
                  <ChevronDown size={12} />
                  Show {hiddenRepos} more {hiddenRepos === 1 ? 'repo' : 'repos'}
                </>
              )}
            </button>
          )}
        </div>
      )}

      <p className="text-xs text-dim mt-6 text-center">
        Costs are computed from session JSONLs in ~/.claude/projects/. Breakdown is estimated by char-length within each turn — the total is exact.
      </p>
    </div>
  )
}

function RepoRow({
  repo,
  expanded,
  onToggle,
  now
}: {
  repo: RepoGroup
  expanded: Set<string>
  onToggle: (key: string) => void
  now: number
}): JSX.Element {
  const isExpanded = expanded.has(`repo:${repo.repoRoot}`)
  const repoLabel =
    repo.repoRoot === '__other__' ? 'Other' : basename(repo.repoRoot)
  const wtCount = repo.worktrees.length
  return (
    <div className="border-b border-border/50 last:border-0">
      <button
        onClick={() => onToggle(`repo:${repo.repoRoot}`)}
        className="w-full grid grid-cols-[1fr_auto_auto_auto] items-center gap-4 px-3 py-2.5 hover:bg-surface/30 cursor-pointer transition-colors text-left"
      >
        <div className="flex items-center gap-2 min-w-0">
          {isExpanded ? (
            <ChevronDown size={14} className="text-muted shrink-0" />
          ) : (
            <ChevronRight size={14} className="text-muted shrink-0" />
          )}
          <span
            className="text-fg-bright font-medium truncate"
            title={repo.repoRoot === '__other__' ? 'Sessions outside any tracked worktree' : repo.repoRoot}
          >
            {repoLabel}
          </span>
          <span className="text-[10px] text-dim shrink-0">
            {wtCount} {wtCount === 1 ? 'worktree' : 'worktrees'}
          </span>
        </div>
        <span className="text-right text-fg-bright tabular-nums w-24">
          {formatCost(repo.totalCostUsd)}
        </span>
        <span className="text-right text-dim text-xs tabular-nums w-24">
          {repo.lastAt ? formatAge(now - repo.lastAt) : '—'}
        </span>
        <span className="text-right text-dim text-xs tabular-nums w-16">
          {repo.turns.toLocaleString()}
        </span>
      </button>
      {isExpanded && (
        <div className="bg-surface/20">
          {repo.worktrees.map((wt) => (
            <WorktreeRow
              key={wt.worktreePath}
              worktree={wt}
              now={now}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function WorktreeRow({
  worktree,
  now
}: {
  worktree: WorktreeGroup
  now: number
}): JSX.Element {
  const label = worktree.branch ?? basename(worktree.worktreePath)
  const sessionCount = worktree.sessions.length
  const modelLabel = formatModel(
    worktree.models.size === 1 ? [...worktree.models][0] : null
  )
  return (
    <div
      className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-4 px-3 py-2 pl-10 border-t border-border/30 hover:bg-surface/40 transition-colors"
      title={worktree.worktreePath}
    >
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-muted font-mono text-xs truncate">{label}</span>
        <span className="text-[10px] text-dim shrink-0">
          {sessionCount} {sessionCount === 1 ? 'session' : 'sessions'}
        </span>
        {worktree.models.size === 1 && (
          <span className="text-[10px] text-dim/70 font-mono shrink-0">
            {modelLabel}
          </span>
        )}
      </div>
      <span className="text-right text-fg tabular-nums text-sm w-24">
        {formatCost(worktree.totalCostUsd)}
      </span>
      <span className="text-right text-dim text-xs tabular-nums w-24">
        {worktree.lastAt ? formatAge(now - worktree.lastAt) : '—'}
      </span>
      <span className="text-right text-dim text-xs tabular-nums w-16">
        {worktree.turns.toLocaleString()}
      </span>
    </div>
  )
}

interface BreakdownRow {
  label: string
  cost: number
}

function BreakdownPanel({
  breakdown,
  total
}: {
  breakdown: ContentBreakdown
  total: number
}): JSX.Element {
  const [showAll, setShowAll] = useState(false)
  const allRows: BreakdownRow[] = [
    { label: 'text', cost: breakdown.text },
    { label: 'thinking', cost: breakdown.thinking },
    { label: 'tool_use', cost: breakdown.toolUse },
    { label: 'user prompt', cost: breakdown.userPrompt },
    { label: 'asst echo', cost: breakdown.assistantEcho },
    ...Object.entries(breakdown.toolResults).map(([name, cost]) => ({
      label: name,
      cost
    }))
  ]
  const nonZero = allRows
    .filter((r) => r.cost > 0)
    .sort((a, b) => b.cost - a.cost)
  if (nonZero.length === 0) {
    return <div className="text-sm text-dim italic">No usage in this range.</div>
  }
  const visible = showAll ? nonZero : nonZero.slice(0, BREAKDOWN_VISIBLE_ROWS)
  const hidden = Math.max(0, nonZero.length - BREAKDOWN_VISIBLE_ROWS)
  const max = nonZero[0].cost
  return (
    <div className="flex flex-col gap-1.5">
      {visible.map((r) => (
        <BreakdownBar key={r.label} row={r} max={max} total={total} />
      ))}
      {hidden > 0 && (
        <button
          onClick={() => setShowAll((s) => !s)}
          className="self-start mt-1 text-[10px] text-muted hover:text-fg-bright cursor-pointer flex items-center gap-1 transition-colors"
        >
          {showAll ? (
            <>
              <ChevronUp size={10} />
              Show top {BREAKDOWN_VISIBLE_ROWS}
            </>
          ) : (
            <>
              <ChevronDown size={10} />
              Show {hidden} more
            </>
          )}
        </button>
      )}
    </div>
  )
}

function BreakdownBar({
  row,
  max,
  total
}: {
  row: BreakdownRow
  max: number
  total: number
}): JSX.Element {
  const pct = total > 0 ? (row.cost / total) * 100 : 0
  const width = max > 0 ? (row.cost / max) * 100 : 0
  return (
    <div className="flex items-center gap-2 text-[11px] leading-tight">
      <span className="text-muted truncate w-20 shrink-0" title={row.label}>
        {row.label}
      </span>
      <div className="flex-1 h-1.5 bg-surface/60 rounded-sm overflow-hidden">
        <div className="h-full bg-accent/70" style={{ width: `${width}%` }} />
      </div>
      <span className="text-dim tabular-nums w-10 text-right shrink-0">
        {pct >= 1 ? `${Math.round(pct)}%` : '<1%'}
      </span>
      <span className="text-fg tabular-nums w-16 text-right shrink-0">
        {formatCost(row.cost)}
      </span>
    </div>
  )
}

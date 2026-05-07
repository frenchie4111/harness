import { useEffect, useMemo, useState } from 'react'
import { Loader2, ArrowDown, ArrowUp, ChevronDown, ChevronUp } from 'lucide-react'
import type { SessionCostSummary } from '../types'
import {
  emptyBreakdown,
  cloneBreakdown,
  addBreakdown,
  type ContentBreakdown
} from '../../shared/state/costs'

type Range = '24h' | '7d' | '30d' | 'all'

const RANGES: { id: Range; label: string; ms: number | null }[] = [
  { id: '24h', label: 'Last 24h', ms: 24 * 60 * 60 * 1000 },
  { id: '7d', label: 'Last 7 days', ms: 7 * 24 * 60 * 60 * 1000 },
  { id: '30d', label: 'Last 30 days', ms: 30 * 24 * 60 * 60 * 1000 },
  { id: 'all', label: 'All time', ms: null }
]

type SortKey = 'project' | 'model' | 'cost' | 'lastAt' | 'turns'

const DEFAULT_VISIBLE_ROWS = 5

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

function formatCost(usd: number): string {
  if (usd >= 100) return `$${usd.toFixed(0)}`
  if (usd >= 1) return `$${usd.toFixed(2)}`
  if (usd >= 0.01) return `$${usd.toFixed(2)}`
  if (usd > 0) return `$${usd.toFixed(4)}`
  return '$0.00'
}

export function ActivityCosts(): JSX.Element {
  const [range, setRange] = useState<Range>('7d')
  const [data, setData] = useState<SessionCostSummary[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [sortKey, setSortKey] = useState<SortKey>('cost')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [showAll, setShowAll] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setShowAll(false)
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

  const sorted = useMemo(() => {
    if (!data) return []
    const dir = sortDir === 'asc' ? 1 : -1
    const rows = [...data]
    rows.sort((a, b) => {
      switch (sortKey) {
        case 'project':
          return basename(a.projectPath).localeCompare(basename(b.projectPath)) * dir
        case 'model':
          return (a.model ?? '').localeCompare(b.model ?? '') * dir
        case 'cost':
          return (a.totalCostUsd - b.totalCostUsd) * dir
        case 'lastAt':
          return (a.lastAt - b.lastAt) * dir
        case 'turns':
          return (a.turns - b.turns) * dir
      }
    })
    return rows
  }, [data, sortKey, sortDir])

  const handleSort = (key: SortKey): void => {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir(key === 'project' || key === 'model' ? 'asc' : 'desc')
    }
  }

  const visibleRows = showAll ? sorted : sorted.slice(0, DEFAULT_VISIBLE_ROWS)
  const hiddenCount = Math.max(0, sorted.length - DEFAULT_VISIBLE_ROWS)
  const rangeLabel = RANGES.find((r) => r.id === range)!.label.toLowerCase()
  const now = Date.now()

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
                spent in the {rangeLabel} across {sorted.length}{' '}
                {sorted.length === 1 ? 'session' : 'sessions'}
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

      {!loading && sorted.length === 0 && (
        <div className="text-sm text-dim py-12 text-center">
          No json-mode sessions in the selected period.
        </div>
      )}

      {!loading && sorted.length > 0 && (
        <div className="bg-app/50 border border-border rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-surface/40 text-[10px] uppercase tracking-wider text-dim">
                <SortHeader k="project" current={sortKey} dir={sortDir} onClick={handleSort}>
                  Project
                </SortHeader>
                <SortHeader k="model" current={sortKey} dir={sortDir} onClick={handleSort}>
                  Model
                </SortHeader>
                <SortHeader k="cost" current={sortKey} dir={sortDir} onClick={handleSort} align="right">
                  Cost
                </SortHeader>
                <SortHeader k="lastAt" current={sortKey} dir={sortDir} onClick={handleSort} align="right">
                  Last active
                </SortHeader>
                <SortHeader k="turns" current={sortKey} dir={sortDir} onClick={handleSort} align="right">
                  Turns
                </SortHeader>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((r) => (
                <tr
                  key={`${r.projectPath}::${r.sessionId}`}
                  className="border-b border-border/50 last:border-0 hover:bg-surface/30 transition-colors"
                >
                  <td
                    className="px-3 py-2 text-muted font-mono truncate max-w-xs"
                    title={r.projectPath}
                  >
                    {basename(r.projectPath)}
                  </td>
                  <td className="px-3 py-2 text-muted font-mono text-xs">
                    {formatModel(r.model)}
                  </td>
                  <td className="px-3 py-2 text-right text-fg-bright tabular-nums">
                    {formatCost(r.totalCostUsd)}
                  </td>
                  <td className="px-3 py-2 text-right text-dim tabular-nums">
                    {r.lastAt ? formatAge(now - r.lastAt) : '—'}
                  </td>
                  <td className="px-3 py-2 text-right text-dim tabular-nums">
                    {r.turns}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {hiddenCount > 0 && (
            <button
              onClick={() => setShowAll((s) => !s)}
              className="w-full px-3 py-2 text-xs text-muted hover:text-fg-bright hover:bg-surface/30 border-t border-border/50 cursor-pointer transition-colors flex items-center justify-center gap-1.5"
            >
              {showAll ? (
                <>
                  <ChevronUp size={12} />
                  Show top {DEFAULT_VISIBLE_ROWS}
                </>
              ) : (
                <>
                  <ChevronDown size={12} />
                  Show {hiddenCount} more
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

function SortHeader({
  k,
  current,
  dir,
  onClick,
  align,
  children
}: {
  k: SortKey
  current: SortKey
  dir: 'asc' | 'desc'
  onClick: (k: SortKey) => void
  align?: 'right'
  children: React.ReactNode
}): JSX.Element {
  const active = current === k
  return (
    <th
      onClick={() => onClick(k)}
      className={`px-3 py-2 font-medium cursor-pointer select-none hover:text-fg-bright transition-colors ${
        align === 'right' ? 'text-right' : 'text-left'
      } ${active ? 'text-fg-bright' : ''}`}
    >
      <span className={`inline-flex items-center gap-1 ${align === 'right' ? 'justify-end' : ''}`}>
        {children}
        {active && (dir === 'asc' ? <ArrowUp size={10} /> : <ArrowDown size={10} />)}
      </span>
    </th>
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
  const outputRows: BreakdownRow[] = [
    { label: 'text', cost: breakdown.text },
    { label: 'thinking', cost: breakdown.thinking },
    { label: 'tool_use', cost: breakdown.toolUse }
  ]
  const inputRows: BreakdownRow[] = [
    { label: 'user prompt', cost: breakdown.userPrompt },
    { label: 'asst echo', cost: breakdown.assistantEcho },
    ...Object.entries(breakdown.toolResults).map(([name, cost]) => ({
      label: name,
      cost
    }))
  ]
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <BreakdownSection title="Output (produced)" rows={outputRows} total={total} />
      <BreakdownSection title="Input (context)" rows={inputRows} total={total} />
    </div>
  )
}

function BreakdownSection({
  title,
  rows,
  total
}: {
  title: string
  rows: BreakdownRow[]
  total: number
}): JSX.Element | null {
  const nonZero = rows.filter((r) => r.cost > 0).sort((a, b) => b.cost - a.cost)
  if (nonZero.length === 0) return null
  const max = nonZero[0].cost
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-[10px] uppercase tracking-wide text-dim">{title}</div>
      {nonZero.map((r) => (
        <BreakdownBar key={r.label} row={r} max={max} total={total} />
      ))}
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
      <span className="text-fg tabular-nums w-14 text-right shrink-0">
        {formatCost(row.cost)}
      </span>
    </div>
  )
}

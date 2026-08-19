import { useMemo, useState } from 'react'
import { RightPanel } from './RightPanel'
import { useContextWindow } from '../store'
import { useBackend } from '../backend'
import type { ContextSnapshot } from '../../shared/state/context-window'

interface ContextPanelProps {
  /** Tab whose window we're showing. Works for terminal agent tabs and
   *  chat tabs alike — both key the slice by tab id. */
  focusedTabId: string | null
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 10_000) return `${Math.round(n / 1000)}k`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

function shortModel(model: string): string {
  return model.replace(/^claude-/, '')
}

/** MCP tool ids are `mcp__<server>__<tool>` and blow out the label column.
 *  The server is the part worth seeing at a glance. */
function shortToolName(name: string): string {
  const mcp = name.match(/^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/)
  if (mcp) return `${mcp[1]}/${mcp[2]}`
  return name
}

interface Row {
  label: string
  tokens: number
  /** Tailwind bg class for the bar and the stacked meter segment. */
  color: string
  title?: string
}

function Meter({ rows, used, limit }: { rows: Row[]; used: number; limit: number }): JSX.Element {
  const free = Math.max(0, limit - used)
  return (
    <div className="flex h-2 w-full overflow-hidden rounded-sm bg-panel-raised/40">
      {rows
        .filter((r) => r.tokens > 0)
        .map((r) => (
          <div
            key={r.label}
            className={r.color}
            style={{ width: `${(r.tokens / limit) * 100}%` }}
            title={`${r.label} — ${formatTokens(r.tokens)}`}
          />
        ))}
      <div className="flex-1" title={`free — ${formatTokens(free)}`} />
    </div>
  )
}

function BarRow({ row, used }: { row: Row; used: number }): JSX.Element {
  const pct = used > 0 ? (row.tokens / used) * 100 : 0
  return (
    <div className="flex items-center gap-2 text-xs leading-tight" title={row.title}>
      <span className={`w-2 h-2 shrink-0 rounded-sm ${row.color}`} />
      <span className="text-faint truncate flex-1 min-w-0">{row.label}</span>
      <span className="text-faint tabular-nums w-8 text-right shrink-0">
        {pct >= 1 ? `${Math.round(pct)}%` : '<1%'}
      </span>
      <span className="text-text tabular-nums w-12 text-right shrink-0">
        {formatTokens(row.tokens)}
      </span>
    </div>
  )
}

function buildRows(snapshot: ContextSnapshot): Row[] {
  const c = snapshot.categories
  const rows: Row[] = [
    {
      label: 'System + tools',
      tokens: c.systemAndTools,
      color: 'bg-faint',
      title: 'System prompt and tool schemas. Derived as the part of the window the conversation does not account for.'
    },
    {
      label: 'CLAUDE.md',
      tokens: c.memoryFiles,
      color: 'bg-muted',
      title: 'Memory files, sized from disk. The API folds these into the system block, so this is an estimate.'
    },
    {
      label: 'Carried summary',
      tokens: c.carriedSummary,
      color: 'bg-warning',
      title: 'The continuation summary written by the last compaction.'
    },
    {
      label: 'Attachments',
      tokens: c.attachments,
      color: 'bg-accent',
      title: 'Skill listings, agent listings, todo reminders and @-mentioned files.'
    },
    { label: 'Your messages', tokens: c.userPrompts, color: 'bg-success' },
    { label: 'Claude replies', tokens: c.assistantText, color: 'bg-fg' },
    { label: 'Thinking', tokens: c.thinking, color: 'bg-fg-bright' },
    {
      label: 'Tool calls',
      tokens: c.toolCalls,
      color: 'bg-danger',
      title: 'Arguments passed to tools. Write and Edit carry whole file bodies, so this is often larger than it looks like it should be.'
    }
  ]
  for (const [name, tokens] of Object.entries(c.toolResults)) {
    rows.push({ label: shortToolName(name), tokens, color: 'bg-error', title: name })
  }
  return rows
}

export function ContextPanel({ focusedTabId }: ContextPanelProps): JSX.Element | null {
  const backend = useBackend()
  const snapshot = useContextWindow(focusedTabId)
  const [showDiscoverable, setShowDiscoverable] = useState(false)

  const rows = useMemo(() => (snapshot ? buildRows(snapshot) : []), [snapshot])

  const body = (): JSX.Element => {
    if (!snapshot) {
      return (
        <div className="text-xs text-faint italic">
          No context data yet. Updates after each turn.
        </div>
      )
    }

    const { usedTokens, limit, autocompactAt } = snapshot
    const pct = limit > 0 ? (usedTokens / limit) * 100 : 0
    const toCompact = autocompactAt - usedTokens
    // Sorted so the biggest consumer is always the first thing read —
    // that's the whole point of the panel.
    const sorted = rows.filter((r) => r.tokens > 0).sort((a, b) => b.tokens - a.tokens)

    return (
      <>
        <div className="flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-base font-medium text-text tabular-nums">
              {Math.round(pct)}%
            </span>
            <span className="text-xs text-faint tabular-nums">
              {formatTokens(usedTokens)} / {formatTokens(limit)}
            </span>
          </div>
          <Meter rows={sorted} used={usedTokens} limit={limit} />
          <div className="flex items-baseline justify-between gap-2 text-xs text-faint">
            <span
              title={
                toCompact > 0
                  ? `Expected to auto-compact around ${formatTokens(autocompactAt)}`
                  : 'Past the expected auto-compact point'
              }
            >
              {toCompact > 0
                ? `${formatTokens(toCompact)} until compact`
                : 'compact imminent'}
            </span>
            {snapshot.model && (
              <span className="truncate">{shortModel(snapshot.model)}</span>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-1">
          {sorted.map((r) => (
            <BarRow key={r.label} row={r} used={usedTokens} />
          ))}
        </div>

        {snapshot.compactions > 0 && (
          <div className="text-xs text-faint">
            {snapshot.compactions} compaction{snapshot.compactions === 1 ? '' : 's'} so far —
            everything before the last one is gone.
          </div>
        )}

        {snapshot.discoverableTools.length > 0 && (
          <div className="flex flex-col gap-1">
            <button
              className="text-xs text-faint hover:text-text text-left"
              onClick={() => setShowDiscoverable((v) => !v)}
              title="Tools the agent can pull in on demand. Their schemas are not in the window until used."
            >
              {showDiscoverable ? '▾' : '▸'} {snapshot.discoverableTools.length} tools
              discoverable, not loaded
            </button>
            {showDiscoverable && (
              <div className="text-xs text-faint leading-relaxed break-words">
                {snapshot.discoverableTools.map(shortToolName).join(', ')}
              </div>
            )}
          </div>
        )}

        <div
          className="text-xs text-faint italic"
          title="The total is exact — it comes off the last turn's usage record. The category split is anchored to the measured token delta between turns and divided within each turn by char proportion."
        >
          total is exact, split is estimated
        </div>
      </>
    )
  }

  return (
    <RightPanel
      id="context"
      title="Context"
      defaultCollapsed
      onCollapsedChange={(c) => {
        backend.setContextWindowInterest(!c)
      }}
      actions={
        snapshot ? (
          <span className="text-xs text-faint tabular-nums">
            {Math.round((snapshot.usedTokens / snapshot.limit) * 100)}%
          </span>
        ) : undefined
      }
    >
      <div className="px-3 py-2 flex flex-col gap-3">{body()}</div>
    </RightPanel>
  )
}

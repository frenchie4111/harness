import { useMemo } from 'react'
import { RightPanel } from './RightPanel'
import { useCosts, usePanes } from '../store'
import {
  totalForSession,
  addBreakdown,
  cloneBreakdown,
  emptyBreakdown,
  emptyTally,
  type ContentBreakdown,
  type ModelTally
} from '../../shared/state/costs'

interface CostPanelProps {
  worktreePath: string | null
}

function formatCost(n: number): string {
  if (n === 0) return '$0.00'
  if (n < 0.01) return '<$0.01'
  if (n < 1) return `$${n.toFixed(2)}`
  return `$${n.toFixed(2)}`
}

function shortModel(model: string): string {
  return model.replace(/^claude-/, '')
}

interface Row {
  label: string
  cost: number
}

function Bar({
  row,
  max,
  total
}: {
  row: Row
  max: number
  total: number
}): JSX.Element {
  const pct = total > 0 ? (row.cost / total) * 100 : 0
  const width = max > 0 ? (row.cost / max) * 100 : 0
  return (
    <div className="flex items-center gap-2 text-[11px] leading-tight">
      <span className="text-faint truncate w-20 shrink-0">{row.label}</span>
      <div className="flex-1 h-1.5 bg-panel-raised/40 rounded-sm overflow-hidden">
        <div
          className="h-full bg-accent/70"
          style={{ width: `${width}%` }}
        />
      </div>
      <span className="text-faint tabular-nums w-10 text-right shrink-0">
        {pct >= 1 ? `${Math.round(pct)}%` : '<1%'}
      </span>
      <span className="text-text tabular-nums w-12 text-right shrink-0">
        {formatCost(row.cost)}
      </span>
    </div>
  )
}

function Section({
  title,
  rows,
  total
}: {
  title: string
  rows: Row[]
  total: number
}): JSX.Element | null {
  const nonZero = rows.filter((r) => r.cost > 0).sort((a, b) => b.cost - a.cost)
  if (nonZero.length === 0) return null
  const max = nonZero[0].cost
  return (
    <div className="flex flex-col gap-1">
      <div className="text-[10px] uppercase tracking-wide text-faint">{title}</div>
      {nonZero.map((r) => (
        <Bar key={r.label} row={r} max={max} total={total} />
      ))}
    </div>
  )
}

export function CostPanel({ worktreePath }: CostPanelProps): JSX.Element | null {
  const costs = useCosts()
  const panes = usePanes()

  const { total, breakdown, currentModel, hasData } = useMemo(() => {
    const breakdown: ContentBreakdown = cloneBreakdown(emptyBreakdown)
    const total: ModelTally = { ...emptyTally }
    let currentModel: string | null = null
    let latestTs = -Infinity
    let hasData = false

    if (worktreePath) {
      const worktreePanes = panes[worktreePath] ?? []
      const terminalIds = new Set<string>()
      for (const pane of worktreePanes) {
        for (const tab of pane.tabs) {
          if (tab.type === 'claude') terminalIds.add(tab.id)
        }
      }
      // Dedup by transcriptPath so a tab that was restarted with
      // --resume against the same jsonl doesn't double-count.
      const seenTranscripts = new Set<string>()
      for (const tid of terminalIds) {
        const usage = costs.byTerminal[tid]
        if (!usage || seenTranscripts.has(usage.transcriptPath)) continue
        seenTranscripts.add(usage.transcriptPath)
        hasData = true
        const sessionTotal = totalForSession(usage)
        total.messages += sessionTotal.messages
        total.input += sessionTotal.input
        total.output += sessionTotal.output
        total.cacheRead += sessionTotal.cacheRead
        total.cacheWrite += sessionTotal.cacheWrite
        total.cost += sessionTotal.cost
        addBreakdown(breakdown, usage.breakdown)
        if (usage.updatedAt > latestTs && usage.currentModel) {
          latestTs = usage.updatedAt
          currentModel = usage.currentModel
        }
      }
    }
    return { total, breakdown, currentModel, hasData }
  }, [worktreePath, costs, panes])

  if (!worktreePath) return null

  const outputRows: Row[] = [
    { label: 'text', cost: breakdown.text },
    { label: 'thinking', cost: breakdown.thinking },
    { label: 'tool_use', cost: breakdown.toolUse }
  ]
  const inputRows: Row[] = [
    { label: 'user prompt', cost: breakdown.userPrompt },
    { label: 'asst echo', cost: breakdown.assistantEcho },
    ...Object.entries(breakdown.toolResults).map(([name, cost]) => ({
      label: name,
      cost
    }))
  ]

  return (
    <RightPanel id="cost" title="Cost" defaultCollapsed>
      <div className="px-3 py-2 flex flex-col gap-3">
        {!hasData ? (
          <div className="text-xs text-faint italic">
            No usage yet. Tallies update after each Claude turn.
          </div>
        ) : (
          <>
            <div className="flex items-baseline justify-between gap-2">
              <span
                className="text-base font-medium text-text tabular-nums"
                title={`${total.messages} assistant messages`}
              >
                {formatCost(total.cost)}
              </span>
              {currentModel && (
                <span className="text-[10px] text-faint truncate">
                  {shortModel(currentModel)}
                </span>
              )}
            </div>
            <Section title="Output (produced)" rows={outputRows} total={total.cost} />
            <Section title="Input (context)" rows={inputRows} total={total.cost} />
            <div
              className="text-[10px] text-faint italic"
              title="Per-block token counts aren't in the Anthropic usage field. Category splits are estimated by char-length proportion within each turn. The top-line total is exact."
            >
              breakdown is estimated
            </div>
          </>
        )}
      </div>
    </RightPanel>
  )
}

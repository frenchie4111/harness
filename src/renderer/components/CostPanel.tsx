import { useMemo } from 'react'
import { RightPanel } from './RightPanel'
import { useCosts, usePanes } from '../store'
import {
  totalForSession,
  emptyTally,
  type ModelTally,
  type SessionUsage
} from '../../shared/state/costs'

interface CostPanelProps {
  worktreePath: string | null
}

function formatCost(n: number): string {
  if (n === 0) return '$0.00'
  if (n < 0.01) return '<$0.01'
  return `$${n.toFixed(2)}`
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return `${n}`
}

function shortModel(model: string): string {
  return model.replace(/^claude-/, '')
}

function sumInto(target: ModelTally, src: ModelTally): void {
  target.messages += src.messages
  target.input += src.input
  target.output += src.output
  target.cacheRead += src.cacheRead
  target.cacheWrite += src.cacheWrite
  target.cost += src.cost
}

export function CostPanel({ worktreePath }: CostPanelProps): JSX.Element | null {
  const costs = useCosts()
  const panes = usePanes()

  const { byModel, total, currentModel, hasData } = useMemo(() => {
    const byModel: Record<string, ModelTally> = {}
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
      const seen = new Set<SessionUsage>()
      for (const tid of terminalIds) {
        const usage = costs.byTerminal[tid]
        if (!usage || seen.has(usage)) continue
        seen.add(usage)
        hasData = true
        for (const [model, tally] of Object.entries(usage.byModel)) {
          const prev = byModel[model] ?? { ...emptyTally }
          sumInto(prev, tally)
          byModel[model] = prev
        }
        sumInto(total, totalForSession(usage))
        if (usage.updatedAt > latestTs && usage.currentModel) {
          latestTs = usage.updatedAt
          currentModel = usage.currentModel
        }
      }
    }
    return { byModel, total, currentModel, hasData }
  }, [worktreePath, costs, panes])

  if (!worktreePath) return null

  const modelRows = Object.entries(byModel).sort((a, b) => b[1].cost - a[1].cost)

  return (
    <RightPanel id="cost" title="Cost">
      <div className="px-3 py-2 text-xs">
        {!hasData ? (
          <div className="text-faint italic">
            No usage yet. Tallies update after each Claude turn.
          </div>
        ) : (
          <>
            <div className="flex items-baseline justify-between gap-2 mb-2">
              <span className="text-base font-medium text-text tabular-nums">
                {formatCost(total.cost)}
              </span>
              {currentModel && (
                <span className="text-[10px] text-faint truncate">
                  {shortModel(currentModel)}
                </span>
              )}
            </div>
            <div className="flex flex-col gap-1">
              {modelRows.map(([model, tally]) => (
                <div
                  key={model}
                  className="flex items-baseline justify-between gap-2 text-faint"
                  title={
                    `in ${formatTokens(tally.input)}  out ${formatTokens(tally.output)}\n` +
                    `cache read ${formatTokens(tally.cacheRead)}  write ${formatTokens(tally.cacheWrite)}\n` +
                    `${tally.messages} assistant msgs`
                  }
                >
                  <span className="truncate">{shortModel(model)}</span>
                  <span className="tabular-nums shrink-0">
                    {tally.messages} · {formatCost(tally.cost)}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </RightPanel>
  )
}

import { useEffect, useState, type ReactNode } from 'react'

export interface ToolGroupRow {
  key: string
  node: ReactNode
  toolName?: string
  hasError?: boolean
  hasPendingApproval?: boolean
}

export function ToolGroup({ rows }: { rows: ToolGroupRow[] }): JSX.Element {
  const hasError = rows.some((r) => r.hasError)
  const hasPending = rows.some((r) => r.hasPendingApproval)
  const [expanded, setExpanded] = useState<boolean>(hasError || hasPending)
  useEffect(() => {
    if (hasError || hasPending) setExpanded(true)
  }, [hasError, hasPending])

  const names = rows.map((r) => r.toolName ?? 'Tool')
  const visible = names.slice(0, 6).join(' · ')
  const moreCount = names.length - 6
  const summary = moreCount > 0 ? `${visible} · +${moreCount} more` : visible

  return (
    <div className="my-2 rounded-md border border-border/60 bg-app/30 overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full px-2 py-1 text-[11px] flex items-center gap-2 cursor-pointer hover:bg-app/60 transition-colors text-left"
      >
        <span className="text-muted text-[9px] w-2 shrink-0 select-none">
          {expanded ? '▾' : '▸'}
        </span>
        <span className="text-muted shrink-0 font-mono">
          {rows.length} tool calls
        </span>
        <span className="opacity-60 truncate flex-1 min-w-0 font-mono">
          {summary}
        </span>
        {hasPending && (
          <span className="text-warning text-[10px] uppercase tracking-wide shrink-0">
            needs approval
          </span>
        )}
        {hasError && (
          <span className="text-danger text-[10px] uppercase tracking-wide shrink-0">
            error
          </span>
        )}
      </button>
      {expanded && (
        <div className="px-2">
          {rows.map((r) => (
            <div key={r.key}>{r.node}</div>
          ))}
        </div>
      )}
    </div>
  )
}

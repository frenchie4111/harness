import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Brain } from 'lucide-react'
import { isHarnessControl, prettyToolName } from './index'

export interface ToolGroupRow {
  key: string
  node: ReactNode
  toolName?: string
  hasError?: boolean
  hasPendingApproval?: boolean
  /** Thinking blocks ride along in the same group as adjacent tool_use
   *  rows since they're both agent work between user-facing replies.
   *  ToolGroup counts them under their own label so the header isn't
   *  misleading ("5 tool calls" when 2 of them are actually thoughts). */
  isThinking?: boolean
}

export function ToolGroup({ rows }: { rows: ToolGroupRow[] }): JSX.Element {
  const hasError = rows.some((r) => r.hasError)
  const hasPending = rows.some((r) => r.hasPendingApproval)
  // Brand styling only fires when an actual harness-control tool is in
  // the group — thinking rows shouldn't trigger the gold gradient.
  const anyBrand = rows.some(
    (r) => !r.isThinking && isHarnessControl(r.toolName)
  )
  // Auto-expand only for pending approvals — those need user action.
  // Errors get a header badge but stay collapsed; user can drill in.
  const wasAutoExpandedRef = useRef(hasPending)
  const [expanded, setExpanded] = useState<boolean>(hasPending)
  useEffect(() => {
    if (hasPending && !expanded) {
      wasAutoExpandedRef.current = true
      setExpanded(true)
    } else if (!hasPending && wasAutoExpandedRef.current && expanded) {
      wasAutoExpandedRef.current = false
      setExpanded(false)
    }
  }, [hasPending, expanded])

  const toolRows = rows.filter((r) => !r.isThinking)
  const thinkingCount = rows.length - toolRows.length

  const names = toolRows.map((r) => prettyToolName(r.toolName))
  const visible = names.slice(0, 6).join(' · ')
  const moreCount = names.length - 6
  const summary = moreCount > 0 ? `${visible} · +${moreCount} more` : visible

  // Count label: "3 tool calls", "2 thoughts", or "2 thoughts · 3 tools"
  // when mixed. Singular gets singular ("1 thought", "1 tool call").
  const toolLabel =
    toolRows.length > 0
      ? `${toolRows.length} tool${toolRows.length === 1 ? ' call' : ' calls'}`
      : ''
  const thinkingLabel =
    thinkingCount > 0
      ? `${thinkingCount} thought${thinkingCount === 1 ? '' : 's'}`
      : ''
  const countLabel = [thinkingLabel, toolLabel].filter(Boolean).join(' · ')

  return (
    <div
      className={`my-2 border ${anyBrand ? 'border-warning/30' : 'border-border/60'} bg-app/30 overflow-hidden`}
      style={{ borderRadius: 'var(--chat-bubble-radius)' }}
    >
      {anyBrand && <div className="brand-gradient-bg h-0.5" />}
      <button
        type="button"
        onClick={() => {
          wasAutoExpandedRef.current = false
          setExpanded((v) => !v)
        }}
        className={`${anyBrand ? 'group' : ''} w-full flex items-center gap-2 cursor-pointer hover:bg-app/60 transition-colors text-left`}
        style={{
          paddingInline: 'var(--chat-chrome-px)',
          paddingBlock: 'var(--chat-chrome-py)',
          fontSize: 'var(--chat-chrome-text)'
        }}
      >
        <span className="text-muted text-[9px] w-2 shrink-0 select-none">
          {expanded ? '▾' : '▸'}
        </span>
        {thinkingCount > 0 && (
          <Brain size={11} className="text-muted shrink-0" />
        )}
        <span
          className={`shrink-0 ${anyBrand ? 'brand-gradient-text brand-gradient-flow-text-hover' : 'text-muted'}`}
          style={{ fontFamily: 'var(--chat-tool-name-family)' }}
        >
          {countLabel}
        </span>
        <span
          className="opacity-60 truncate flex-1 min-w-0"
          style={{ fontFamily: 'var(--chat-tool-name-family)' }}
        >
          {summary}
        </span>
        {hasPending && (
          <span
            className="text-warning uppercase tracking-wide shrink-0"
            style={{ fontSize: 'var(--chat-meta-text)' }}
          >
            needs approval
          </span>
        )}
        {hasError && (
          <span
            className="text-danger uppercase tracking-wide shrink-0"
            style={{ fontSize: 'var(--chat-meta-text)' }}
          >
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

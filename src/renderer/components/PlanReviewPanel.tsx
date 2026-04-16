import { useCallback, useState } from 'react'
import Markdown from 'react-markdown'
import { Check, X, Terminal, FileText } from 'lucide-react'
import { Tooltip } from './Tooltip'

interface PlanReviewPanelProps {
  planText: string
  terminalId: string
}

export function PlanReviewPanel({ planText, terminalId }: PlanReviewPanelProps): JSX.Element {
  const [responding, setResponding] = useState(false)
  const [collapsed, setCollapsed] = useState(false)

  const handleApprove = useCallback(() => {
    setResponding(true)
    // Send 'y' then Enter — covers both single-key and line-input prompt modes
    window.api.writeTerminal(terminalId, 'y\r')
  }, [terminalId])

  const handleReject = useCallback(() => {
    setResponding(true)
    // Escape is the universal TUI "cancel/reject"
    window.api.writeTerminal(terminalId, '\x1b')
  }, [terminalId])

  if (collapsed) {
    return (
      <div className="absolute bottom-3 right-3 z-10">
        <Tooltip label="Show plan" side="left">
          <button
            onClick={() => setCollapsed(false)}
            className="flex items-center gap-2 px-3 py-2 rounded-lg bg-panel border border-border text-muted hover:text-fg-bright hover:bg-surface transition-colors cursor-pointer shadow-lg"
          >
            <FileText size={14} />
            <span className="text-xs font-medium">Plan</span>
          </button>
        </Tooltip>
      </div>
    )
  }

  return (
    <div className="absolute inset-0 z-10 flex flex-col bg-app">
      {/* Header */}
      <div className="flex items-center h-10 px-4 border-b border-border bg-panel shrink-0">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <FileText size={13} className="text-accent shrink-0" />
          <span className="text-xs font-medium text-fg-bright">Plan review</span>
        </div>
      </div>

      {/* Scrollable plan content */}
      <div className="flex-1 overflow-y-auto px-6 py-5 min-h-0">
        <div className="max-w-[720px] plan-markdown">
          <Markdown>{planText}</Markdown>
        </div>
      </div>

      {/* Action bar */}
      <div className="flex items-center gap-2 px-4 py-3 border-t border-border bg-panel shrink-0">
        <button
          onClick={handleApprove}
          disabled={responding}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-border bg-panel text-fg-bright hover:bg-border transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-default text-xs"
        >
          <Check size={12} className="text-success" />
          Approve
        </button>
        <button
          onClick={handleReject}
          disabled={responding}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-border bg-panel text-muted hover:text-fg-bright hover:bg-border transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-default text-xs"
        >
          <X size={12} />
          Reject
        </button>
        {responding && (
          <span className="text-xs text-dim ml-1">Sending…</span>
        )}
        <div className="flex-1" />
        <Tooltip label="Show terminal" side="left">
          <button
            onClick={() => setCollapsed(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-border bg-panel text-muted hover:text-fg-bright hover:bg-border transition-colors cursor-pointer text-xs"
          >
            <Terminal size={12} />
            Terminal
          </button>
        </Tooltip>
      </div>
    </div>
  )
}

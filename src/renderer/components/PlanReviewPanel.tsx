import { useCallback, useState } from 'react'
import Markdown from 'react-markdown'
import { CheckCircle2, XCircle, FileText } from 'lucide-react'

interface PlanReviewPanelProps {
  planText: string
  terminalId: string
}

export function PlanReviewPanel({ planText, terminalId }: PlanReviewPanelProps): JSX.Element {
  const [responding, setResponding] = useState(false)

  const handleApprove = useCallback(() => {
    setResponding(true)
    window.api.writeTerminal(terminalId, 'y')
  }, [terminalId])

  const handleReject = useCallback(() => {
    setResponding(true)
    window.api.writeTerminal(terminalId, 'n')
  }, [terminalId])

  return (
    <div className="absolute inset-0 z-10 flex flex-col bg-app/97">
      <div className="flex items-center gap-2 px-6 pt-5 pb-3 border-b border-border shrink-0">
        <FileText size={16} className="text-accent" />
        <h2 className="text-base font-semibold text-fg-bright">Plan review</h2>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5">
        <div className="max-w-[720px] plan-markdown">
          <Markdown>{planText}</Markdown>
        </div>
      </div>

      <div className="flex items-center gap-3 px-6 py-4 border-t border-border bg-panel shrink-0">
        <button
          onClick={handleApprove}
          disabled={responding}
          className="flex items-center gap-2 px-4 py-2 rounded bg-success/20 text-success hover:bg-success/30 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-default"
        >
          <CheckCircle2 size={14} />
          Approve plan
        </button>
        <button
          onClick={handleReject}
          disabled={responding}
          className="flex items-center gap-2 px-4 py-2 rounded bg-danger/20 text-danger hover:bg-danger/30 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-default"
        >
          <XCircle size={14} />
          Reject
        </button>
        {responding && (
          <span className="text-xs text-dim ml-2">Sending response…</span>
        )}
      </div>
    </div>
  )
}

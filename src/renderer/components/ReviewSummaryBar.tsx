import { ArrowLeft, MessageSquare, Send, Clipboard, Check } from 'lucide-react'
import { Tooltip } from './Tooltip'

interface ReviewSummaryBarProps {
  branchName: string
  fileCount: number
  additions: number
  deletions: number
  reviewedCount: number
  pendingCommentCount: number
  onSendToAgent: () => void
  onCopyComments: () => void
  onClose: () => void
}

export function ReviewSummaryBar({
  branchName,
  fileCount,
  additions,
  deletions,
  reviewedCount,
  pendingCommentCount,
  onSendToAgent,
  onCopyComments,
  onClose
}: ReviewSummaryBarProps): JSX.Element {
  const progress = fileCount > 0 ? reviewedCount / fileCount : 0
  const allReviewed = fileCount > 0 && reviewedCount === fileCount

  return (
    <div className="shrink-0 border-b border-border bg-panel drag-region">
      <div className="h-10 flex items-center gap-3 px-3">
        <Tooltip label="Back to workspace">
          <button
            onClick={onClose}
            className="text-faint hover:text-fg transition-colors cursor-pointer no-drag"
          >
            <ArrowLeft size={16} />
          </button>
        </Tooltip>

        <span className="text-xs font-mono text-dim truncate">{branchName}</span>

        <div className="flex items-center gap-2 text-[11px] text-faint">
          <span>{fileCount} file{fileCount !== 1 ? 's' : ''}</span>
          <span className="text-border">·</span>
          {additions > 0 && <span className="text-success">+{additions}</span>}
          {deletions > 0 && <span className="text-danger">−{deletions}</span>}
        </div>

        <div className="flex-1" />

        <div className="flex items-center gap-1.5 text-[11px] no-drag">
          {allReviewed ? (
            <span className="flex items-center gap-1 text-success font-medium">
              <Check size={12} strokeWidth={2.5} />
              All reviewed
            </span>
          ) : (
            <span className="text-faint tabular-nums">
              {reviewedCount}/{fileCount} reviewed
            </span>
          )}

          {pendingCommentCount > 0 && (
            <span className="flex items-center gap-1 text-info ml-2">
              <MessageSquare size={11} />
              {pendingCommentCount}
            </span>
          )}

          <Tooltip label="Copy comments to clipboard">
            <button
              onClick={onCopyComments}
              disabled={pendingCommentCount === 0}
              className="ml-2 flex items-center gap-1 px-2 py-1 rounded border border-border text-faint hover:text-fg transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-default"
            >
              <Clipboard size={11} />
              Copy
            </button>
          </Tooltip>

          <Tooltip label="Send all comments to the active agent terminal">
            <button
              onClick={onSendToAgent}
              disabled={pendingCommentCount === 0}
              className="flex items-center gap-1 px-2 py-1 rounded bg-accent text-fg text-xs font-medium hover:bg-accent/80 transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-default"
            >
              <Send size={11} />
              Send to Agent
            </button>
          </Tooltip>
        </div>
      </div>

      {/* Progress bar */}
      <div className="h-[2px] bg-border/50 relative">
        <div
          className={`h-full transition-all duration-300 ease-out ${
            allReviewed ? 'bg-success' : 'bg-accent'
          }`}
          style={{ width: `${progress * 100}%` }}
        />
      </div>
    </div>
  )
}

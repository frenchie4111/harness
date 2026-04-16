import { useState, useEffect, useCallback } from 'react'
import { Check, Trash2 } from 'lucide-react'
import type { FileDiffSides, ChangedFile } from '../types'
import type { ReviewComment } from './ReviewFileTree'
import { MonacoDiffEditor } from './MonacoDiffEditor'
import { ReviewCommentInput } from './ReviewCommentInput'
import { useSettings } from '../store'

interface ReviewDiffPaneProps {
  worktreePath: string
  file: ChangedFile | null
  mode: 'working' | 'branch'
  reviewed: boolean
  comments: ReviewComment[]
  onToggleReviewed: () => void
  onAddComment: (lineNumber: number, body: string) => void
  onDeleteComment: (id: string) => void
}

const STATUS_LABEL: Record<ChangedFile['status'], string> = {
  added: 'Added',
  modified: 'Modified',
  deleted: 'Deleted',
  renamed: 'Renamed',
  untracked: 'Untracked'
}

const STATUS_COLOR: Record<ChangedFile['status'], string> = {
  added: 'text-success',
  modified: 'text-warning',
  deleted: 'text-danger',
  renamed: 'text-info',
  untracked: 'text-dim'
}

export function ReviewDiffPane({
  worktreePath,
  file,
  mode,
  reviewed,
  comments,
  onToggleReviewed,
  onAddComment,
  onDeleteComment
}: ReviewDiffPaneProps): JSX.Element {
  const settings = useSettings()
  const [sides, setSides] = useState<FileDiffSides | null>(null)
  const [loading, setLoading] = useState(false)
  const [commentLine, setCommentLine] = useState<number | null>(null)

  useEffect(() => {
    if (!file) {
      setSides(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setCommentLine(null)
    window.api
      .getFileDiffSides(worktreePath, file.path, file.staged, mode)
      .then((result) => {
        if (!cancelled) setSides(result)
      })
      .catch(() => {
        if (!cancelled) setSides(null)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [worktreePath, file?.path, file?.staged, mode])

  const handleReferenceLine = useCallback((lineNumber: number) => {
    setCommentLine(lineNumber)
  }, [])

  if (!file) {
    return (
      <div className="flex items-center justify-center h-full text-faint text-sm">
        Select a file to review
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* File header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-panel shrink-0">
        <button
          onClick={onToggleReviewed}
          className={`shrink-0 w-4 h-4 rounded border flex items-center justify-center transition-colors cursor-pointer ${
            reviewed
              ? 'bg-success/20 border-success text-success'
              : 'border-border-strong text-transparent hover:border-faint'
          }`}
        >
          {reviewed && <Check size={10} strokeWidth={3} />}
        </button>

        <span className="text-xs font-mono truncate flex-1">{file.path}</span>

        <span className={`text-[10px] ${STATUS_COLOR[file.status]}`}>
          {STATUS_LABEL[file.status]}
        </span>

        {(file.additions !== undefined || file.deletions !== undefined) && (
          <span className="text-[10px] font-mono tabular-nums">
            {file.additions !== undefined && file.additions > 0 && (
              <span className="text-success">+{file.additions}</span>
            )}
            {file.deletions !== undefined && file.deletions > 0 && (
              <span className="text-danger ml-1">−{file.deletions}</span>
            )}
          </span>
        )}
      </div>

      {/* Diff */}
      <div className="flex-1 min-h-0 relative">
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center text-faint text-sm z-10">
            Loading diff...
          </div>
        )}
        {!loading && sides && (
          <MonacoDiffEditor
            original={sides.original}
            modified={sides.modified}
            filePath={file.path}
            readOnly
            fontFamily={settings.fontFamily}
            fontSize={settings.fontSize}
            onReferenceLine={handleReferenceLine}
          />
        )}
        {!loading && sides?.error && (
          <div className="absolute inset-0 flex items-center justify-center text-danger text-sm">
            {sides.error}
          </div>
        )}
        {!loading && sides?.modifiedBinary && (
          <div className="absolute inset-0 flex items-center justify-center text-faint text-sm">
            Binary file — cannot display diff
          </div>
        )}
      </div>

      {/* Comment input */}
      {commentLine !== null && (
        <div className="shrink-0 border-t border-border">
          <ReviewCommentInput
            lineNumber={commentLine}
            onSubmit={(body) => {
              onAddComment(commentLine, body)
              setCommentLine(null)
            }}
            onCancel={() => setCommentLine(null)}
          />
        </div>
      )}

      {/* Pending comments for this file */}
      {comments.length > 0 && (
        <div className="shrink-0 border-t border-border max-h-40 overflow-y-auto">
          <div className="px-3 py-1.5 text-[10px] font-medium text-dim uppercase tracking-wider bg-panel-raised/50">
            Comments ({comments.length})
          </div>
          {comments.map((c) => (
            <div
              key={c.id}
              className="flex items-start gap-2 px-3 py-1.5 text-xs border-b border-border/50 group"
            >
              <span className="shrink-0 font-mono text-[10px] text-faint">L{c.lineNumber}</span>
              <span className="flex-1 text-fg whitespace-pre-wrap">{c.body}</span>
              <button
                onClick={() => onDeleteComment(c.id)}
                className="shrink-0 opacity-0 group-hover:opacity-100 text-faint hover:text-danger transition-all cursor-pointer"
              >
                <Trash2 size={11} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

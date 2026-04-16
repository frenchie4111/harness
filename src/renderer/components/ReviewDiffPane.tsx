import { useState, useEffect, useCallback, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import * as monaco from 'monaco-editor'
import { Check } from 'lucide-react'
import type { FileDiffSides, ChangedFile } from '../types'
import type { ReviewComment } from './ReviewFileTree'
import { MonacoDiffEditor } from './MonacoDiffEditor'
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

function InlineComment({
  comment,
  onDelete
}: {
  comment: ReviewComment
  onDelete: () => void
}): JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: '8px',
        padding: '6px 12px',
        fontSize: '12px',
        borderLeft: '3px solid var(--color-info, #58a6ff)',
        background: 'color-mix(in srgb, var(--color-info, #58a6ff) 8%, transparent)',
        margin: '2px 8px'
      }}
    >
      <span style={{ flex: 1, color: 'var(--color-fg)', whiteSpace: 'pre-wrap' }}>
        {comment.body}
      </span>
      <button
        onClick={onDelete}
        style={{
          flexShrink: 0,
          color: 'var(--color-faint)',
          cursor: 'pointer',
          background: 'none',
          border: 'none',
          fontSize: '11px',
          padding: '0 2px'
        }}
        onMouseOver={(e) => (e.currentTarget.style.color = 'var(--color-danger, #f85149)')}
        onMouseOut={(e) => (e.currentTarget.style.color = 'var(--color-faint)')}
      >
        ✕
      </button>
    </div>
  )
}

function InlineCommentInput({
  lineNumber,
  onSubmit,
  onCancel
}: {
  lineNumber: number
  onSubmit: (body: string) => void
  onCancel: () => void
}): JSX.Element {
  const [body, setBody] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    textareaRef.current?.focus()
  }, [])

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        padding: '8px 12px',
        margin: '2px 8px',
        borderRadius: '4px',
        border: '1px solid var(--color-border-strong)',
        background: 'var(--color-panel-raised)'
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: '10px', color: 'var(--color-faint)', fontFamily: 'monospace' }}>
          Line {lineNumber}
        </span>
        <button
          onClick={onCancel}
          style={{
            color: 'var(--color-faint)',
            cursor: 'pointer',
            background: 'none',
            border: 'none',
            fontSize: '12px'
          }}
        >
          ✕
        </button>
      </div>
      <textarea
        ref={textareaRef}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            if (body.trim()) onSubmit(body.trim())
          }
          if (e.key === 'Escape') {
            e.preventDefault()
            onCancel()
          }
          e.stopPropagation()
        }}
        placeholder="Leave a comment..."
        rows={2}
        style={{
          width: '100%',
          background: 'var(--color-surface)',
          color: 'var(--color-fg)',
          fontSize: '12px',
          borderRadius: '4px',
          border: '1px solid var(--color-border)',
          padding: '6px 8px',
          resize: 'none',
          outline: 'none',
          fontFamily: 'inherit'
        }}
      />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: '10px', color: 'var(--color-faint)' }}>⌘Enter to submit</span>
        <button
          onClick={() => {
            if (body.trim()) onSubmit(body.trim())
          }}
          disabled={!body.trim()}
          style={{
            fontSize: '11px',
            padding: '2px 8px',
            borderRadius: '4px',
            background: body.trim() ? 'var(--color-accent)' : 'var(--color-border)',
            color: 'var(--color-fg)',
            border: 'none',
            cursor: body.trim() ? 'pointer' : 'default',
            opacity: body.trim() ? 1 : 0.3
          }}
        >
          Add Comment
        </button>
      </div>
    </div>
  )
}

interface ViewZoneEntry {
  zoneId: string
  root: Root
  domNode: HTMLDivElement
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
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null)
  const viewZonesRef = useRef<ViewZoneEntry[]>([])

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

  const clearViewZones = useCallback(() => {
    const editor = editorRef.current
    if (!editor) return
    const modifiedEd = editor.getModifiedEditor()
    const zones = viewZonesRef.current
    if (zones.length === 0) return
    modifiedEd.changeViewZones((accessor) => {
      for (const z of zones) {
        accessor.removeZone(z.zoneId)
        z.root.unmount()
      }
    })
    viewZonesRef.current = []
  }, [])

  // Sync view zones whenever comments or commentLine changes
  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return

    clearViewZones()

    const modifiedEd = editor.getModifiedEditor()
    const newZones: ViewZoneEntry[] = []

    // Collect all items to render: existing comments + the input (if active)
    interface ZoneItem {
      type: 'comment' | 'input'
      lineNumber: number
      comment?: ReviewComment
    }
    const items: ZoneItem[] = []

    for (const c of comments) {
      items.push({ type: 'comment', lineNumber: c.lineNumber, comment: c })
    }
    if (commentLine !== null) {
      items.push({ type: 'input', lineNumber: commentLine })
    }

    // Sort by line number so zones don't interfere with each other
    items.sort((a, b) => a.lineNumber - b.lineNumber)

    if (items.length === 0) return

    modifiedEd.changeViewZones((accessor) => {
      for (const item of items) {
        const domNode = document.createElement('div')
        domNode.style.zIndex = '10'

        const heightInLines = item.type === 'input' ? 7 : 2
        const zoneId = accessor.addZone({
          afterLineNumber: item.lineNumber,
          heightInLines,
          domNode,
          suppressMouseDown: false
        })

        const root = createRoot(domNode)
        if (item.type === 'comment' && item.comment) {
          const c = item.comment
          root.render(
            <InlineComment comment={c} onDelete={() => onDeleteComment(c.id)} />
          )
        } else if (item.type === 'input') {
          root.render(
            <InlineCommentInput
              lineNumber={item.lineNumber}
              onSubmit={(body) => {
                onAddComment(item.lineNumber, body)
                setCommentLine(null)
              }}
              onCancel={() => setCommentLine(null)}
            />
          )
        }

        newZones.push({ zoneId, root, domNode })
      }
    })

    viewZonesRef.current = newZones
  }, [comments, commentLine, clearViewZones, onAddComment, onDeleteComment])

  // Clean up view zones on unmount
  useEffect(() => {
    return () => {
      const zones = viewZonesRef.current
      for (const z of zones) z.root.unmount()
      viewZonesRef.current = []
    }
  }, [])

  const handleReferenceLine = useCallback((lineNumber: number) => {
    setCommentLine(lineNumber)
  }, [])

  const handleEditorMount = useCallback(
    (editor: monaco.editor.IStandaloneDiffEditor) => {
      editorRef.current = editor
    },
    []
  )

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

      {/* Diff with inline comments via view zones */}
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
            onEditorMount={handleEditorMount}
            glyphClassName="comment-line-glyph"
            glyphHoverMessage="Add a comment on this line"
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
    </div>
  )
}

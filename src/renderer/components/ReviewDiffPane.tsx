import { useState, useEffect, useCallback, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import * as monaco from 'monaco-editor'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize from 'rehype-sanitize'
import { Check, CheckCheck, Copy, FoldVertical, MessagesSquare, Pencil, Reply, UnfoldVertical } from 'lucide-react'
import type { FileDiffSides, ChangedFile } from '../types'
import type { ReviewComment } from './ReviewFileTree'
import { MonacoDiffEditor } from './MonacoDiffEditor'
import { Tooltip } from './Tooltip'
import { useSettings } from '../store'
import { useBackend } from '../backend'
import { scaledEditorFontSize } from '../../shared/state/settings'

interface ReviewDiffPaneProps {
  worktreePath: string
  file: ChangedFile | null
  mode: 'working' | 'branch'
  commitHash?: string
  /** When set, diffs the file across the commit range fromHash^..toHash.
   *  Overrides commitHash and mode. */
  commitRange?: { fromHash: string; toHash: string }
  reviewed: boolean
  comments: ReviewComment[]
  /** Unified (false) vs side-by-side (true) — owned by ReviewPane so the
   *  choice is one control for the whole review, not per file. */
  sideBySide: boolean
  /** Hide whitespace-only changes (true) vs surface them (false). */
  ignoreTrimWhitespace: boolean
  /** True when the review tab is active/visible — gates the `c` shortcut. */
  active?: boolean
  /** Scroll the diff to this line when it matches the current file. Used by
   *  the comment list / find to jump to a line. */
  revealTarget?: { filePath: string; line: number; nonce: number } | null
  onToggleReviewed: () => void
  onAddComment: (lineNumber: number, body: string, startLine?: number) => void
  onDeleteComment: (id: string) => void
  wordWrap: boolean
  /** Open this file as an editable in-app file tab. Undefined hides the
   *  "Open in editor" button. */
  onOpenEditor?: (filePath: string) => void
  onAddReply: (
    root: { filePath: string; lineNumber: number; remoteId: number },
    body: string
  ) => void
  onResolveThread: (threadId: string) => void
  /** Thread ids queued to resolve on the next sync. */
  pendingResolve: ReadonlySet<string>
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

const COMMENT_REMARK_PLUGINS = [remarkGfm]
// rehype-raw parses raw HTML (so GitHub-authored tags render); rehype-sanitize
// then strips anything unsafe — comments come from arbitrary PR participants.
const COMMENT_REHYPE_PLUGINS = [rehypeRaw, rehypeSanitize]

function formatRelTime(ms: number): string {
  if (!ms || Number.isNaN(ms)) return ''
  const s = Math.floor((Date.now() - ms) / 1000)
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d ago`
  return new Date(ms).toLocaleDateString()
}

const COLLAPSED_BODY_PX = 64

function InlineComment({
  comment,
  onDelete,
  forceExpanded
}: {
  comment: ReviewComment
  onDelete: () => void
  forceExpanded?: boolean
}): JSX.Element {
  const ts = comment.createdAt ? Date.parse(comment.createdAt) : comment.timestamp
  const timeStr = formatRelTime(ts)
  const [expanded, setExpanded] = useState(forceExpanded ?? false)
  const bodyRef = useRef<HTMLDivElement>(null)
  const [collapsible, setCollapsible] = useState(false)
  useEffect(() => {
    const el = bodyRef.current
    if (el) setCollapsible(el.scrollHeight > COLLAPSED_BODY_PX + 4)
  }, [comment.body])
  const clamped = collapsible && !expanded

  // Local-only or pending-review comments are drafts (not yet published on
  // the PR); tint them differently (amber) from published comments (blue).
  const isDraft = comment.draft || comment.remoteId === undefined
  const accent = isDraft ? 'var(--color-warning, #d29922)' : 'var(--color-info, #58a6ff)'
  const bg = `color-mix(in srgb, ${accent} ${isDraft ? '20%' : '28%'}, var(--color-panel-raised))`

  return (
    <div
      onClick={(e) => {
        if (!collapsible) return
        // Don't toggle the comment when interacting with controls rendered
        // inside it — a <details> disclosure, links, buttons, form fields.
        if (
          (e.target as HTMLElement | null)?.closest(
            'a, button, summary, details, input, textarea, select, label'
          )
        ) {
          return
        }
        setExpanded((v) => !v)
      }}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
        padding: '8px 12px',
        fontSize: '12px',
        border: `1px solid color-mix(in srgb, ${accent} 60%, transparent)`,
        borderLeft: `4px solid ${accent}`,
        borderRadius: '0 6px 6px 0',
        background: bg,
        boxShadow: '0 2px 10px rgba(0, 0, 0, 0.4)',
        cursor: collapsible ? 'pointer' : 'default'
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
        {comment.authorAvatarUrl ? (
          <img
            src={comment.authorAvatarUrl}
            alt={comment.author ?? ''}
            style={{ width: '18px', height: '18px', borderRadius: '50%', flexShrink: 0 }}
          />
        ) : comment.author ? (
          <span
            style={{
              width: '18px',
              height: '18px',
              borderRadius: '50%',
              flexShrink: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'var(--color-panel)',
              color: 'var(--color-faint)',
              fontSize: '10px',
              textTransform: 'uppercase'
            }}
          >
            {comment.author.slice(0, 1)}
          </span>
        ) : null}
        {comment.author && (
          <span style={{ fontWeight: 600, color: 'var(--color-fg)' }}>@{comment.author}</span>
        )}
        {comment.startLine &&
          comment.lineNumber > 0 &&
          comment.startLine !== comment.lineNumber && (
            <span style={{ fontSize: '10px', color: 'var(--color-faint)', fontFamily: 'monospace' }}>
              L{comment.startLine}–{comment.lineNumber}
            </span>
          )}
        {timeStr &&
          (comment.htmlUrl ? (
            <a
              href={comment.htmlUrl}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
              style={{ color: 'var(--color-faint)', fontSize: '11px' }}
            >
              {timeStr}
            </a>
          ) : (
            <span style={{ color: 'var(--color-faint)', fontSize: '11px' }}>{timeStr}</span>
          ))}
        {isDraft && (
          <span
            style={{
              fontSize: '10px',
              color: accent,
              border: `1px solid ${accent}`,
              borderRadius: '3px',
              padding: '0 4px',
              textTransform: 'uppercase',
              letterSpacing: '0.04em'
            }}
          >
            Draft
          </span>
        )}
        {comment.remoteId === undefined && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              onDelete()
            }}
            title="Delete comment"
            style={{
              marginLeft: 'auto',
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
        )}
      </div>
      <div style={{ position: 'relative' }}>
        <div
          ref={bodyRef}
          className="markdown"
          style={{
            color: 'var(--color-fg)',
            minWidth: 0,
            fontSize: '12px',
            maxHeight: clamped ? `${COLLAPSED_BODY_PX}px` : undefined,
            overflow: 'hidden'
          }}
        >
          <ReactMarkdown remarkPlugins={COMMENT_REMARK_PLUGINS} rehypePlugins={COMMENT_REHYPE_PLUGINS}>
            {comment.body}
          </ReactMarkdown>
        </div>
        {clamped && (
          <div
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              bottom: 0,
              height: '20px',
              background: `linear-gradient(to bottom, transparent, ${bg})`,
              pointerEvents: 'none'
            }}
          />
        )}
      </div>
      {collapsible && (
        <button
          onClick={(e) => {
            e.stopPropagation()
            setExpanded((v) => !v)
          }}
          style={{
            alignSelf: 'flex-start',
            background: 'none',
            border: 'none',
            padding: 0,
            color: accent,
            cursor: 'pointer',
            fontSize: '11px'
          }}
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  )
}

/** A comment thread: the root comment followed by its replies, each inset
 *  and touching the one above so the reply relationship reads visually. A
 *  footer holds the reply field and resolve control. */
function CommentThread({
  thread,
  onDelete,
  forceExpanded,
  onAddReply,
  onResolveThread,
  pendingResolve
}: {
  thread: ReviewComment[]
  onDelete: (id: string) => void
  forceExpanded?: boolean
  onAddReply: (
    root: { filePath: string; lineNumber: number; remoteId: number },
    body: string
  ) => void
  onResolveThread: (threadId: string) => void
  pendingResolve: ReadonlySet<string>
}): JSX.Element {
  const root = thread[0]
  const [replying, setReplying] = useState(false)
  const [replyBody, setReplyBody] = useState('')
  const replyRef = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (replying) replyRef.current?.focus()
  }, [replying])

  const canReply = root.remoteId !== undefined
  const resolved = thread.some((c) => c.resolved)
  const resolving = !!root.threadId && pendingResolve.has(root.threadId)
  const canResolve = !!root.threadId && !resolved && !root.draft

  const submitReply = (): void => {
    const body = replyBody.trim()
    if (!body || root.remoteId === undefined) return
    onAddReply({ filePath: root.filePath, lineNumber: root.lineNumber, remoteId: root.remoteId }, body)
    setReplyBody('')
    setReplying(false)
  }

  return (
    <div
      style={{ margin: '4px 0', display: 'flex', flexDirection: 'column', opacity: resolved ? 0.6 : 1 }}
    >
      {thread.map((c, i) => (
        <div key={c.id} style={{ marginLeft: i === 0 ? 0 : 16, minWidth: 0 }}>
          <InlineComment comment={c} onDelete={() => onDelete(c.id)} forceExpanded={forceExpanded} />
        </div>
      ))}

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          marginTop: '4px',
          marginLeft: thread.length > 1 ? 16 : 0,
          fontSize: '11px'
        }}
      >
        {canReply && !replying && (
          <button
            onClick={() => setReplying(true)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '4px',
              background: 'none',
              border: 'none',
              padding: 0,
              color: 'var(--color-faint)',
              cursor: 'pointer'
            }}
          >
            <Reply size={12} /> Reply
          </button>
        )}
        {resolved ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', color: 'var(--color-success)' }}>
            <CheckCheck size={12} /> Resolved
          </span>
        ) : resolving ? (
          <span style={{ color: 'var(--color-faint)' }}>Resolving on next sync…</span>
        ) : canResolve ? (
          <button
            onClick={() => root.threadId && onResolveThread(root.threadId)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '4px',
              background: 'none',
              border: 'none',
              padding: 0,
              color: 'var(--color-faint)',
              cursor: 'pointer'
            }}
          >
            <CheckCheck size={12} /> Resolve
          </button>
        ) : null}
      </div>

      {replying && (
        <div style={{ marginTop: '4px', marginLeft: thread.length > 1 ? 16 : 0 }}>
          <textarea
            ref={replyRef}
            value={replyBody}
            onChange={(e) => setReplyBody(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                submitReply()
              }
              if (e.key === 'Escape') {
                e.preventDefault()
                setReplying(false)
              }
              e.stopPropagation()
            }}
            placeholder="Reply…"
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
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '6px', marginTop: '4px' }}>
            <button
              onClick={() => setReplying(false)}
              style={{
                fontSize: '11px',
                padding: '2px 8px',
                background: 'none',
                border: 'none',
                color: 'var(--color-faint)',
                cursor: 'pointer'
              }}
            >
              Cancel
            </button>
            <button
              onClick={submitReply}
              disabled={!replyBody.trim()}
              style={{
                fontSize: '11px',
                padding: '2px 8px',
                borderRadius: '4px',
                background: replyBody.trim() ? 'var(--color-accent)' : 'var(--color-border)',
                color: replyBody.trim() ? 'var(--color-app)' : 'var(--color-faint)',
                border: 'none',
                cursor: replyBody.trim() ? 'pointer' : 'default',
                opacity: replyBody.trim() ? 1 : 0.4
              }}
            >
              Reply
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function InlineCommentInput({
  lineNumber,
  startLine,
  onSubmit,
  onCancel
}: {
  lineNumber: number
  startLine?: number | null
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
        gap: '0.375rem',
        padding: '0.5rem 0.75rem',
        margin: '0.125rem 0.5rem',
        borderRadius: '0.25rem',
        border: '1px solid var(--color-border-strong)',
        background: 'var(--color-panel-raised)'
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: '10px', color: 'var(--color-faint)', fontFamily: 'monospace' }}>
          {lineNumber === 0
            ? 'File comment'
            : startLine && startLine !== lineNumber
              ? `Lines ${startLine}–${lineNumber}`
              : `Line ${lineNumber}`}
        </span>
        <button
          onClick={onCancel}
          style={{
            color: 'var(--color-faint)',
            cursor: 'pointer',
            background: 'none',
            border: 'none',
            fontSize: '0.75rem'
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
          fontSize: '0.75rem',
          borderRadius: '0.25rem',
          border: '1px solid var(--color-border)',
          padding: '0.375rem 0.5rem',
          resize: 'none',
          outline: 'none',
          fontFamily: 'inherit'
        }}
      />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: '0.625rem', color: 'var(--color-faint)' }}>⌘Enter to submit</span>
        <button
          onClick={() => {
            if (body.trim()) onSubmit(body.trim())
          }}
          disabled={!body.trim()}
          style={{
            fontSize: '0.6875rem',
            padding: '0.125rem 0.5rem',
            borderRadius: '0.25rem',
            background: body.trim() ? 'var(--color-accent)' : 'var(--color-border)',
            color: body.trim() ? 'var(--color-app)' : 'var(--color-faint)',
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
  /** Kept so we can mutate heightInPx and re-layout when the comment's
   *  rendered height changes (collapse/expand, markdown reflow). */
  zone: monaco.editor.IViewZone
  root: Root
  domNode: HTMLDivElement
  stickyWrapper: HTMLDivElement
  resizeObserver?: ResizeObserver
}

export function ReviewDiffPane({
  worktreePath,
  file,
  mode,
  commitHash,
  commitRange,
  reviewed,
  comments,
  sideBySide,
  ignoreTrimWhitespace,
  active,
  revealTarget,
  onToggleReviewed,
  onAddComment,
  onDeleteComment,
  wordWrap,
  onOpenEditor,
  onAddReply,
  onResolveThread,
  pendingResolve
}: ReviewDiffPaneProps): JSX.Element {
  const backend = useBackend()
  const settings = useSettings()
  const [sides, setSides] = useState<FileDiffSides | null>(null)
  const [loading, setLoading] = useState(false)
  // The line a pending comment input is anchored to (its end line). A separate
  // start line carries a multi-line selection; null start = single line.
  const [commentLine, setCommentLine] = useState<number | null>(null)
  const [commentStartLine, setCommentStartLine] = useState<number | null>(null)
  const [expandAll, setExpandAll] = useState(false)
  const [copiedPath, setCopiedPath] = useState(false)
  // Bumped each time the diff editor (re)mounts so the view-zone effect
  // re-runs and re-draws comments — the editor unmounts/remounts on every
  // file switch, and a ref alone wouldn't retrigger the effect.
  const [editorNonce, setEditorNonce] = useState(0)
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null)
  const decorationsRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(null)
  const viewZonesRef = useRef<ViewZoneEntry[]>([])
  // Latest comment callbacks held in refs so the view-zone sync effect doesn't
  // list them as deps. The parent passes some as inline arrows (fresh identity
  // every render), so without this a background re-render (PR poll, file
  // watcher, sync) would re-run the effect, tear down the view zones, and
  // remount InlineCommentInput — wiping the draft the user is typing.
  const onAddCommentRef = useRef(onAddComment)
  const onDeleteCommentRef = useRef(onDeleteComment)
  const onAddReplyRef = useRef(onAddReply)
  const onResolveThreadRef = useRef(onResolveThread)
  onAddCommentRef.current = onAddComment
  onDeleteCommentRef.current = onDeleteComment
  onAddReplyRef.current = onAddReply
  onResolveThreadRef.current = onResolveThread
  // Last diff line the mouse was over, for the `c` shortcut. null ⇒ not
  // over any line ⇒ file-level comment (line 0).
  const hoveredLineRef = useRef<number | null>(null)
  // The modified editor's current multi-line selection (start/end lines), so
  // `c` can anchor a comment to a range. null ⇒ no multi-line selection.
  const selectionRef = useRef<{ start: number; end: number } | null>(null)
  // Comment ResizeObservers funnel their desired zone heights here; a single
  // rAF applies them all in one changeViewZones. Without batching, each
  // observer relayouts the editor, nudging other comment wrappers and firing
  // their observers — an N×N cascade that freezes the renderer.
  const pendingZoneHeightsRef = useRef(new Map<string, { zone: monaco.editor.IViewZone; h: number }>())
  const layoutRafRef = useRef(0)
  // Last comment width applied to every sticky wrapper. Comments size to the
  // editor's visible content width, so widening the diff (collapsing the file
  // browser, resizing the window) widens the comments too. Guarded on this ref
  // so layout events that don't change the content width are no-ops — see
  // applyZoneWidths.
  const lastZoneWidthRef = useRef(0)
  // Compute the current comment width from the editor's content area, then push
  // it to every live comment wrapper — but ONLY when it actually changed. The
  // no-op guard is what makes this safe to call from onDidLayoutChange: writing
  // the same px string doesn't resize the wrapper, so the per-zone height
  // ResizeObserver never fires, so there's no observer → changeViewZones →
  // layout → applyZoneWidths feedback loop. contentWidth reserves the vertical
  // scrollbar regardless of visibility, so it's stable across zone-height
  // changes and only moves on a real editor resize.
  const applyZoneWidths = useCallback(() => {
    const editor = editorRef.current
    if (!editor) return
    const w = editor.getModifiedEditor().getLayoutInfo().contentWidth
    if (w <= 0 || w === lastZoneWidthRef.current) return
    lastZoneWidthRef.current = w
    for (const z of viewZonesRef.current) {
      z.stickyWrapper.style.width = `${w}px`
    }
  }, [])
  const flushZoneLayout = useCallback(() => {
    if (layoutRafRef.current) return
    layoutRafRef.current = requestAnimationFrame(() => {
      layoutRafRef.current = 0
      const pending = pendingZoneHeightsRef.current
      const ed = editorRef.current
      if (!ed || pending.size === 0) {
        pending.clear()
        return
      }
      ed.getModifiedEditor().changeViewZones((acc) => {
        for (const [zoneId, { zone, h }] of pending) {
          zone.heightInPx = h
          acc.layoutZone(zoneId)
        }
      })
      pending.clear()
    })
  }, [])

  // Highlight the line span each multi-line comment (and the pending input
  // range) covers, so the reader sees what a range comment refers to.
  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    const modEd = editor.getModifiedEditor()
    if (!decorationsRef.current) decorationsRef.current = modEd.createDecorationsCollection()
    const decos: monaco.editor.IModelDeltaDecoration[] = []
    const addRange = (start: number, end: number): void => {
      if (start < 1 || end < start) return
      decos.push({
        range: new monaco.Range(start, 1, end, 1),
        options: { isWholeLine: true, className: 'comment-range-line' }
      })
    }
    for (const c of comments) {
      if (c.startLine && c.lineNumber > 0 && c.startLine !== c.lineNumber) {
        addRange(Math.min(c.startLine, c.lineNumber), Math.max(c.startLine, c.lineNumber))
      }
    }
    if (commentLine !== null && commentStartLine !== null && commentStartLine !== commentLine) {
      addRange(Math.min(commentStartLine, commentLine), Math.max(commentStartLine, commentLine))
    }
    decorationsRef.current.set(decos)
  }, [comments, commentLine, commentStartLine, editorNonce])

  useEffect(() => {
    if (!file) {
      setSides(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setCommentLine(null)
    // The editor unmounts while the new diff loads; drop our handle and
    // tear down the old comment widgets so the remount re-creates them
    // cleanly (and the view-zone effect no-ops until the new editor mounts).
    for (const z of viewZonesRef.current) queueMicrotask(() => z.root.unmount())
    viewZonesRef.current = []
    editorRef.current = null
    const promise = commitRange
      ? backend.getCommitRangeFileDiffSides(
          worktreePath,
          commitRange.fromHash,
          commitRange.toHash,
          file.path
        )
      : commitHash
        ? backend.getCommitFileDiffSides(worktreePath, commitHash, file.path)
        : backend.getFileDiffSides(worktreePath, file.path, file.staged, mode)
    promise
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
  }, [worktreePath, file?.path, file?.staged, mode, commitHash, commitRange?.fromHash, commitRange?.toHash])

  const clearViewZones = useCallback(() => {
    const editor = editorRef.current
    if (!editor) return
    const modifiedEd = editor.getModifiedEditor()
    const zones = viewZonesRef.current
    if (zones.length === 0) return
    modifiedEd.changeViewZones((accessor) => {
      for (const z of zones) {
        z.resizeObserver?.disconnect()
        accessor.removeZone(z.zoneId)
        queueMicrotask(() => z.root.unmount())
      }
    })
    viewZonesRef.current = []
    pendingZoneHeightsRef.current.clear()
    if (layoutRafRef.current) {
      cancelAnimationFrame(layoutRafRef.current)
      layoutRafRef.current = 0
    }
  }, [])

  // Sync view zones whenever comments or commentLine changes
  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return

    clearViewZones()

    const modifiedEd = editor.getModifiedEditor()
    const newZones: ViewZoneEntry[] = []

    // Collect all items to render: comment threads + the input (if active).
    interface ZoneItem {
      type: 'comment' | 'input'
      lineNumber: number
      thread?: ReviewComment[]
    }
    const items: ZoneItem[] = []

    // Group comments into threads: a reply keys to its parent's remoteId, a
    // root keys to its own. So a root and its replies share a thread.
    const threadMap = new Map<string, ReviewComment[]>()
    for (const c of comments) {
      const rootId = c.inReplyToId ?? c.remoteId
      const key = rootId !== undefined ? `id:${rootId}` : `local:${c.id}`
      const arr = threadMap.get(key)
      if (arr) arr.push(c)
      else threadMap.set(key, [c])
    }
    const timeOf = (c: ReviewComment): number =>
      c.createdAt ? Date.parse(c.createdAt) : c.timestamp
    for (const thread of threadMap.values()) {
      // Root first (no inReplyToId), then replies oldest→newest.
      thread.sort((a, b) => {
        const ar = a.inReplyToId === undefined ? 0 : 1
        const br = b.inReplyToId === undefined ? 0 : 1
        return ar !== br ? ar - br : timeOf(a) - timeOf(b)
      })
      items.push({ type: 'comment', lineNumber: thread[0].lineNumber, thread })
    }
    if (commentLine !== null) {
      items.push({ type: 'input', lineNumber: commentLine })
    }

    // Sort by line number so zones don't interfere with each other
    items.sort((a, b) => a.lineNumber - b.lineNumber)

    if (items.length === 0) return

    const contentWidth = modifiedEd.getLayoutInfo().contentWidth
    lastZoneWidthRef.current = contentWidth

    modifiedEd.changeViewZones((accessor) => {
      for (const item of items) {
        const domNode = document.createElement('div')
        domNode.style.zIndex = '10'

        // The view zone domNode stretches to the full scrollable content
        // width (which can be very wide with long lines). Pin the actual
        // content to the visible viewport using sticky positioning.
        const stickyWrapper = document.createElement('div')
        stickyWrapper.style.position = 'sticky'
        stickyWrapper.style.left = '0'
        stickyWrapper.style.width = `${contentWidth}px`
        domNode.appendChild(stickyWrapper)

        const zone: monaco.editor.IViewZone = {
          afterLineNumber: item.lineNumber,
          domNode,
          suppressMouseDown: false
        }
        if (item.type === 'input') zone.heightInLines = 7
        else zone.heightInPx = 76 // estimate; the ResizeObserver corrects it
        const zoneId = accessor.addZone(zone)

        const root = createRoot(stickyWrapper)
        if (item.type === 'comment' && item.thread) {
          root.render(
            <CommentThread
              thread={item.thread}
              onDelete={(id) => onDeleteCommentRef.current(id)}
              forceExpanded={expandAll}
              onAddReply={(root, body) => onAddReplyRef.current(root, body)}
              onResolveThread={(threadId) => onResolveThreadRef.current(threadId)}
              pendingResolve={pendingResolve}
            />
          )
        } else if (item.type === 'input') {
          root.render(
            <InlineCommentInput
              lineNumber={item.lineNumber}
              startLine={commentStartLine}
              onSubmit={(body) => {
                onAddCommentRef.current(item.lineNumber, body, commentStartLine ?? undefined)
                setCommentLine(null)
                setCommentStartLine(null)
              }}
              onCancel={() => {
                setCommentLine(null)
                setCommentStartLine(null)
              }}
            />
          )
        }

        // Resize the comment zone to fit its rendered content so collapse /
        // expand and markdown reflow don't clip. Enqueue the new height and
        // let the batched rAF apply all changes in one changeViewZones, so
        // observers can't cascade into a layout storm.
        let resizeObserver: ResizeObserver | undefined
        if (item.type === 'comment') {
          resizeObserver = new ResizeObserver(() => {
            const h = Math.ceil(stickyWrapper.scrollHeight) + 8
            if (!h || zone.heightInPx === h) return
            pendingZoneHeightsRef.current.set(zoneId, { zone, h })
            flushZoneLayout()
          })
          resizeObserver.observe(stickyWrapper)
        }

        newZones.push({ zoneId, zone, root, domNode, stickyWrapper, resizeObserver })
      }
    })

    viewZonesRef.current = newZones
  }, [comments, commentLine, commentStartLine, editorNonce, expandAll, clearViewZones, flushZoneLayout, pendingResolve])

  // Clean up view zones on unmount
  useEffect(() => {
    return () => {
      const zones = viewZonesRef.current
      for (const z of zones) {
        z.resizeObserver?.disconnect()
        queueMicrotask(() => z.root.unmount())
      }
      viewZonesRef.current = []
      if (layoutRafRef.current) cancelAnimationFrame(layoutRafRef.current)
    }
  }, [])

  // Reveal a specific line when the comment list / find navigates here. The
  // editor owns its own scroll, so center the line and briefly flash it. Keyed
  // on the request nonce + editor mount so it fires once this file's editor is
  // ready (it may have just remounted from a file switch).
  useEffect(() => {
    if (!revealTarget || !file || revealTarget.filePath !== file.path) return
    const editor = editorRef.current
    if (!editor) return
    const line = Math.max(1, revealTarget.line)
    const modEd = editor.getModifiedEditor()
    let flash: monaco.editor.IEditorDecorationsCollection | null = null
    const doReveal = (): void => {
      modEd.revealLineInCenter(line)
      if (!flash) {
        flash = modEd.createDecorationsCollection([
          {
            range: new monaco.Range(line, 1, line, 1),
            options: { isWholeLine: true, className: 'reveal-flash-line' }
          }
        ])
      }
    }
    // Reveal on the next frame AND after a short delay to catch the settled
    // layout (view zones / mount can shift line positions).
    const raf = requestAnimationFrame(doReveal)
    const t = setTimeout(doReveal, 160)
    const clearT = setTimeout(() => flash?.clear(), 1500)
    return () => {
      cancelAnimationFrame(raf)
      clearTimeout(t)
      clearTimeout(clearT)
      flash?.clear()
    }
  }, [revealTarget?.nonce, revealTarget?.filePath, editorNonce, file?.path])

  const handleReferenceLine = useCallback((lineNumber: number) => {
    setCommentStartLine(null)
    setCommentLine(lineNumber)
  }, [])

  // Drag-selecting the gutter `+` anchors a range comment: end line is the
  // input's anchor, start line is remembered (same shape as the `c` shortcut).
  const handleReferenceRange = useCallback((startLine: number, endLine: number) => {
    setCommentStartLine(startLine)
    setCommentLine(endLine)
  }, [])

  const jumpToFirstComment = useCallback(() => {
    if (comments.length === 0) return
    const first = [...comments].sort((a, b) => a.lineNumber - b.lineNumber)[0]
    const editor = editorRef.current
    if (!editor) return
    const line = Math.max(1, first.lineNumber)
    const modEd = editor.getModifiedEditor()
    modEd.setPosition({ lineNumber: line, column: 1 })
    modEd.revealLineInCenter(line)
  }, [comments])

  const handleEditorMount = useCallback(
    (editor: monaco.editor.IStandaloneDiffEditor) => {
      editorRef.current = editor
      setEditorNonce((n) => n + 1)
      const modEd = editor.getModifiedEditor()
      // Keep comment widths in sync with the editor's content area so they grow
      // when more of the diff becomes visible (file browser collapsed, window
      // resized). applyZoneWidths is a no-op unless contentWidth actually
      // changed, which is what keeps this off the observer feedback loop the old
      // code avoided by never resizing — see applyZoneWidths.
      modEd.onDidLayoutChange(() => applyZoneWidths())
      // Track the hovered line so `c` can target it.
      modEd.onMouseMove((e) => {
        hoveredLineRef.current = e.target.position?.lineNumber ?? null
      })
      modEd.onMouseLeave(() => {
        hoveredLineRef.current = null
      })
      // Track a multi-line selection so `c` can anchor a comment to a range.
      modEd.onDidChangeCursorSelection((e) => {
        const s = e.selection
        selectionRef.current =
          s.startLineNumber !== s.endLineNumber
            ? { start: Math.min(s.startLineNumber, s.endLineNumber), end: Math.max(s.startLineNumber, s.endLineNumber) }
            : null
      })
    },
    [applyZoneWidths]
  )

  // `c` opens a comment input on the hovered diff line, or a file-level
  // comment (line 0) when the mouse isn't over a line. Window listener so it
  // works whether focus is in the diff or the file tree. Bail only on a real
  // form field (the inline comment box and the file filter), never on Monaco's
  // own input.
  useEffect(() => {
    if (!file || !active) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'c' || e.metaKey || e.ctrlKey || e.altKey) return
      const el = e.target as HTMLElement | null
      if (el instanceof HTMLInputElement) return
      if (el instanceof HTMLTextAreaElement && !el.classList.contains('inputarea')) return
      e.preventDefault()
      // A multi-line text selection anchors a range comment (end line is the
      // zone anchor, start line is remembered); otherwise the hovered line, or
      // line 0 for a file-level comment.
      const sel = selectionRef.current
      if (sel) {
        setCommentLine(sel.end)
        setCommentStartLine(sel.start)
      } else {
        setCommentLine(hoveredLineRef.current ?? 0)
        setCommentStartLine(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [file, active])

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
        <Tooltip label={copiedPath ? 'Copied!' : 'Copy file path'}>
          <button
            onClick={() => {
              void navigator.clipboard.writeText(file.path)
              setCopiedPath(true)
              window.setTimeout(() => setCopiedPath(false), 1200)
            }}
            aria-label="Copy file path"
            className="shrink-0 text-faint hover:text-fg cursor-pointer"
          >
            {copiedPath ? (
              <Check className="icon-xs text-success" />
            ) : (
              <Copy className="icon-xs" />
            )}
          </button>
        </Tooltip>

        <Tooltip label={<span className="font-mono">{file.path}</span>} side="top">
          <span
            className="text-xs font-mono truncate flex-1 min-w-0"
            style={{ direction: 'rtl', textAlign: 'left' }}
          >
            <bdi>{file.path}</bdi>
          </span>
        </Tooltip>

        <span className={`text-xs ${STATUS_COLOR[file.status]}`}>
          {STATUS_LABEL[file.status]}
        </span>

        {(file.additions !== undefined || file.deletions !== undefined) && (
          <span className="text-xs font-mono tabular-nums">
            {file.additions !== undefined && file.additions > 0 && (
              <span className="text-success">+{file.additions}</span>
            )}
            {file.deletions !== undefined && file.deletions > 0 && (
              <span className="text-danger ml-1">−{file.deletions}</span>
            )}
          </span>
        )}

        {comments.length > 0 && (
          <Tooltip label="Jump to the first comment in this file">
            <button
              onClick={jumpToFirstComment}
              aria-label="Jump to first comment"
              className="shrink-0 flex items-center gap-1 px-2 py-1 rounded border border-border text-xs text-info hover:text-info/70 transition-colors cursor-pointer"
            >
              <MessagesSquare className="icon-xs" />
              {comments.length}
            </button>
          </Tooltip>
        )}

        {comments.length > 0 && (
          <Tooltip label={expandAll ? 'Collapse all comments' : 'Expand all comments'}>
            <button
              onClick={() => setExpandAll((v) => !v)}
              aria-pressed={expandAll}
              aria-label={expandAll ? 'Collapse all comments' : 'Expand all comments'}
              className={`shrink-0 flex items-center px-2 py-1 rounded border border-border transition-colors cursor-pointer ${
                expandAll ? 'text-accent' : 'text-faint hover:text-fg'
              }`}
            >
              {expandAll ? (
                <FoldVertical className="icon-xs" />
              ) : (
                <UnfoldVertical className="icon-xs" />
              )}
            </button>
          </Tooltip>
        )}

        <Tooltip label={reviewed ? 'Mark as not viewed (r)' : 'Mark as viewed (r)'}>
          <button
            onClick={onToggleReviewed}
            aria-pressed={reviewed}
            className={`shrink-0 flex items-center gap-1 px-2 py-1 rounded border text-xs transition-colors cursor-pointer ${
              reviewed
                ? 'bg-success/20 border-success text-success'
                : 'border-border-strong text-faint hover:text-fg hover:border-faint'
            }`}
          >
            <Check strokeWidth={3} className="icon-2xs" />
            Viewed
          </button>
        </Tooltip>

        {onOpenEditor && file.status !== 'deleted' && (
          <Tooltip label="Open in editor">
            <button
              onClick={() => onOpenEditor(file.path)}
              aria-label="Open in editor"
              className="shrink-0 text-faint hover:text-fg cursor-pointer"
            >
              <Pencil className="icon-xs" />
            </button>
          </Tooltip>
        )}
      </div>

      {/* Diff with inline comments via view zones. The editor fills the pane
          and owns its own vertical scroll. */}
      <div className="flex-1 min-h-0 relative">
        {loading ? (
          <div className="absolute inset-0 flex items-center justify-center text-faint text-sm">
            Loading diff...
          </div>
        ) : sides?.error ? (
          <div className="absolute inset-0 flex items-center justify-center text-danger text-sm">
            {sides.error}
          </div>
        ) : sides?.modifiedBinary ? (
          <div className="absolute inset-0 flex items-center justify-center text-faint text-sm">
            Binary file — cannot display diff
          </div>
        ) : sides ? (
          <MonacoDiffEditor
            original={sides.original}
            modified={sides.modified}
            filePath={file.path}
            readOnly
            renderSideBySide={sideBySide}
            ignoreTrimWhitespace={ignoreTrimWhitespace}
            fontFamily={settings.terminalFontFamily || undefined}
            fontSize={scaledEditorFontSize(settings.terminalFontSize, settings.uiScale)}
            wordWrap={wordWrap}
            onReferenceLine={handleReferenceLine}
            onReferenceRange={handleReferenceRange}
            onEditorMount={handleEditorMount}
            glyphClassName="comment-line-glyph"
            glyphHoverMessage="Add a comment on this line — drag to select a range"
          />
        ) : null}
      </div>
    </div>
  )
}

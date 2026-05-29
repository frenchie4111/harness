import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { Send, Clipboard, Check, MessageSquare, GitCommitHorizontal, ArrowUp, ChevronDown } from 'lucide-react'
import type { ChangedFile, BranchCommit } from '../types'
import type { ReviewComment } from './ReviewFileTree'
import { ReviewFileTree } from './ReviewFileTree'
import { ReviewDiffPane } from './ReviewDiffPane'
import { ResizeHandle } from './ResizeHandle'
import { Tooltip } from './Tooltip'
import { useBackend } from '../backend'
import { setReviewProgress, clearReviewProgress } from '../review-progress'

interface ReviewPaneProps {
  tabId: string
  worktreePath: string
  /** Anchor commit of the selection (oldest selected). Undefined ⇒ "All commits". */
  fromCommit?: string
  /** Tip commit of the selection (newest selected). Undefined ⇒ "All commits". */
  toCommit?: string
  onSendToAgent?: (text: string) => void
}

let commentIdCounter = 0

export function ReviewPane({
  tabId,
  worktreePath,
  fromCommit,
  toCommit,
  onSendToAgent
}: ReviewPaneProps): JSX.Element {
  const backend = useBackend()
  const [commits, setCommits] = useState<BranchCommit[]>([])
  const [files, setFiles] = useState<ChangedFile[]>([])
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [reviewedFiles, setReviewedFiles] = useState<Set<string>>(new Set())
  const [comments, setComments] = useState<ReviewComment[]>([])
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(new Set())
  const [fileTreeWidth, setFileTreeWidth] = useState<number>(240)

  // Whole-branch when both bounds are undefined. Single commit when both
  // are set and equal. Otherwise a contiguous range.
  const isWholeBranch = !fromCommit && !toCommit
  const isSingleCommit = !!fromCommit && fromCommit === toCommit

  useEffect(() => {
    let cancelled = false
    backend
      .getBranchCommits(worktreePath)
      .then((res) => {
        if (!cancelled) setCommits(res)
      })
      .catch(() => {
        if (!cancelled) setCommits([])
      })
    return () => {
      cancelled = true
    }
  }, [worktreePath, backend])

  // Refetch the file list whenever the commit selection changes.
  useEffect(() => {
    let cancelled = false
    const promise = isWholeBranch
      ? backend.getChangedFiles(worktreePath, 'branch')
      : isSingleCommit
        ? backend.getCommitChangedFiles(worktreePath, fromCommit!)
        : backend.getCommitRangeChangedFiles(worktreePath, fromCommit!, toCommit!)
    promise
      .then((result) => {
        if (cancelled) return
        setFiles(result)
        setSelectedFile((prev) => {
          if (prev && result.some((f) => f.path === prev)) return prev
          return result[0]?.path ?? null
        })
        // The reviewed set / comments belong to the previous file set;
        // wipe them when the selection changes so progress reflects the
        // new file set.
        setReviewedFiles(new Set())
        setComments([])
      })
      .catch(() => {
        if (!cancelled) setFiles([])
      })
    return () => {
      cancelled = true
    }
  }, [worktreePath, backend, isWholeBranch, isSingleCommit, fromCommit, toCommit])

  // Push "(N/M)" up to the tab strip. Clear on unmount.
  useEffect(() => {
    setReviewProgress(tabId, { reviewed: reviewedFiles.size, total: files.length })
  }, [tabId, reviewedFiles, files.length])

  useEffect(() => {
    return () => {
      clearReviewProgress(tabId)
    }
  }, [tabId])

  const selectedFileObj = useMemo(
    () => files.find((f) => f.path === selectedFile) ?? null,
    [files, selectedFile]
  )

  const fileComments = useMemo(
    () => (selectedFile ? comments.filter((c) => c.filePath === selectedFile) : []),
    [comments, selectedFile]
  )

  const { totalAdditions, totalDeletions } = useMemo(() => {
    let add = 0
    let del = 0
    for (const f of files) {
      add += f.additions ?? 0
      del += f.deletions ?? 0
    }
    return { totalAdditions: add, totalDeletions: del }
  }, [files])

  const handleToggleReviewed = useCallback(
    (path: string) => {
      setReviewedFiles((prev) => {
        const next = new Set(prev)
        if (next.has(path)) next.delete(path)
        else next.add(path)
        return next
      })
    },
    []
  )

  const handleToggleDir = useCallback((dir: string) => {
    setCollapsedDirs((prev) => {
      const next = new Set(prev)
      if (next.has(dir)) next.delete(dir)
      else next.add(dir)
      return next
    })
  }, [])

  const handleAddComment = useCallback(
    (lineNumber: number, body: string) => {
      if (!selectedFile) return
      setComments((prev) => [
        ...prev,
        {
          id: `comment-${++commentIdCounter}`,
          filePath: selectedFile,
          lineNumber,
          body,
          timestamp: Date.now()
        }
      ])
    },
    [selectedFile]
  )

  const handleDeleteComment = useCallback((id: string) => {
    setComments((prev) => prev.filter((c) => c.id !== id))
  }, [])

  const formatComments = useCallback((): string => {
    if (comments.length === 0) return ''
    const lines = ['Review feedback on your changes:', '']
    for (const c of comments) {
      lines.push(`${c.filePath}:${c.lineNumber} — ${c.body}`)
    }
    return lines.join('\n')
  }, [comments])

  const handleFileTreeResize = useCallback((delta: number) => {
    setFileTreeWidth((w) => {
      const next = w + delta
      // Clamp: don't let the tree shrink past readability or grow past
      // taking over the pane.
      if (next < 160) return 160
      if (next > 640) return 640
      return next
    })
  }, [])

  const handleSendToAgent = useCallback(() => {
    const text = formatComments()
    if (!text || !onSendToAgent) return
    onSendToAgent(text + '\n')
  }, [formatComments, onSendToAgent])

  const handleCopyComments = useCallback(() => {
    const text = formatComments()
    if (text) navigator.clipboard.writeText(text)
  }, [formatComments])

  // Compute the indices of the selected commits in the (newest→oldest)
  // commit list. Used to highlight the active range in the picker and
  // for shift-click range extension.
  const selectionIndices = useMemo(() => {
    if (isWholeBranch) return null
    const fromIdx = commits.findIndex((c) => c.hash === fromCommit)
    const toIdx = commits.findIndex((c) => c.hash === toCommit)
    if (fromIdx === -1 || toIdx === -1) return null
    return { fromIdx, toIdx }
  }, [commits, fromCommit, toCommit, isWholeBranch])

  const handleSelectAllCommits = useCallback(() => {
    void backend.panesSetReviewSelection(worktreePath, tabId, undefined, undefined)
  }, [backend, worktreePath, tabId])

  const handleCommitClick = useCallback(
    (idx: number, shift: boolean) => {
      const target = commits[idx]
      if (!target) return
      if (shift && selectionIndices) {
        // Extend the existing range to include the clicked commit. The
        // commit list is newest→oldest, so "tip" = lower index, "anchor"
        // = higher index in our internal terms.
        const tipIdx = Math.min(selectionIndices.fromIdx, selectionIndices.toIdx)
        const anchorIdx = Math.max(selectionIndices.fromIdx, selectionIndices.toIdx)
        const lo = Math.min(idx, tipIdx, anchorIdx)
        const hi = Math.max(idx, tipIdx, anchorIdx)
        // Range covers every commit → collapse to whole-branch so the
        // selection shows "All commits" and the diff includes uncommitted
        // changes too, matching the canonical default.
        if (lo === 0 && hi === commits.length - 1) {
          void backend.panesSetReviewSelection(worktreePath, tabId, undefined, undefined)
          return
        }
        // hi = oldest selected (higher index in newest→oldest list)
        // lo = newest selected (lower index)
        const newFrom = commits[hi].hash
        const newTo = commits[lo].hash
        void backend.panesSetReviewSelection(worktreePath, tabId, newFrom, newTo)
        return
      }
      void backend.panesSetReviewSelection(worktreePath, tabId, target.hash, target.hash)
    },
    [commits, selectionIndices, backend, worktreePath, tabId]
  )

  const allReviewed = files.length > 0 && reviewedFiles.size === files.length
  const progress = files.length > 0 ? reviewedFiles.size / files.length : 0

  return (
    <div className="flex flex-col h-full w-full bg-bg">
      {/* Top controls bar */}
      <div className="shrink-0 border-b border-border bg-panel">
        <div className="h-10 flex items-center gap-3 px-3">
          <CommitSelector
            commits={commits}
            isWholeBranch={isWholeBranch}
            selectionIndices={selectionIndices}
            onSelectAll={handleSelectAllCommits}
            onCommitClick={handleCommitClick}
            fromCommit={fromCommit}
            toCommit={toCommit}
          />

          <div className="flex items-center gap-2 text-xs text-faint">
            {totalAdditions > 0 && <span className="text-success">+{totalAdditions}</span>}
            {totalDeletions > 0 && <span className="text-danger">−{totalDeletions}</span>}
          </div>

          <div className="flex-1" />

          <div className="flex items-center gap-1.5 text-xs">
            {allReviewed ? (
              <span className="flex items-center gap-1 text-success font-medium">
                <Check strokeWidth={2.5} className="icon-xs" />
                All reviewed
              </span>
            ) : (
              <span className="text-faint tabular-nums">
                {reviewedFiles.size}/{files.length} reviewed
              </span>
            )}

            {comments.length > 0 && (
              <span className="flex items-center gap-1 text-info ml-2">
                <MessageSquare className="icon-xs" />
                {comments.length}
              </span>
            )}

            <Tooltip label="Copy comments to clipboard">
              <button
                onClick={handleCopyComments}
                disabled={comments.length === 0}
                className="ml-2 flex items-center gap-1 px-2 py-1 rounded border border-border text-faint hover:text-fg transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-default"
              >
                <Clipboard className="icon-xs" />
                Copy
              </button>
            </Tooltip>

            <Tooltip label="Send all comments to the active agent terminal">
              <button
                onClick={handleSendToAgent}
                disabled={comments.length === 0 || !onSendToAgent}
                className="flex items-center gap-1 px-2 py-1 rounded bg-accent text-fg text-xs font-medium hover:bg-accent/80 transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-default"
              >
                <Send className="icon-xs" />
                Send to Agent
              </button>
            </Tooltip>
          </div>
        </div>

        <div className="h-[2px] bg-border/50 relative">
          <div
            className={`h-full transition-all duration-300 ease-out ${
              allReviewed ? 'bg-success' : 'bg-accent'
            }`}
            style={{ width: `${progress * 100}%` }}
          />
        </div>
      </div>

      <div className="flex flex-1 min-h-0">
        {/* File tree */}
        <div
          className="shrink-0 overflow-hidden"
          style={{ width: fileTreeWidth }}
        >
          <ReviewFileTree
            files={files}
            selectedFile={selectedFile}
            reviewedFiles={reviewedFiles}
            comments={comments}
            collapsedDirs={collapsedDirs}
            onSelectFile={setSelectedFile}
            onToggleReviewed={handleToggleReviewed}
            onToggleDir={handleToggleDir}
          />
        </div>

        <ResizeHandle onDelta={handleFileTreeResize} />

        {/* Diff pane */}
        <div className="flex-1 min-w-0">
          <ReviewDiffPane
            worktreePath={worktreePath}
            file={selectedFileObj}
            mode="branch"
            commitHash={isSingleCommit ? fromCommit : undefined}
            commitRange={
              !isWholeBranch && !isSingleCommit && fromCommit && toCommit
                ? { fromHash: fromCommit, toHash: toCommit }
                : undefined
            }
            reviewed={selectedFile ? reviewedFiles.has(selectedFile) : false}
            comments={fileComments}
            onToggleReviewed={() => {
              if (selectedFile) handleToggleReviewed(selectedFile)
            }}
            onAddComment={handleAddComment}
            onDeleteComment={handleDeleteComment}
          />
        </div>
      </div>
    </div>
  )
}

interface CommitSelectorProps {
  commits: BranchCommit[]
  isWholeBranch: boolean
  selectionIndices: { fromIdx: number; toIdx: number } | null
  fromCommit?: string
  toCommit?: string
  onSelectAll: () => void
  onCommitClick: (idx: number, shift: boolean) => void
}

function CommitSelector({
  commits,
  isWholeBranch,
  selectionIndices,
  fromCommit,
  toCommit,
  onSelectAll,
  onCommitClick
}: CommitSelectorProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const wrapperRef = useRef<HTMLDivElement | null>(null)

  // Close on outside click / blur. Mousedown is enough — Tooltip uses
  // pointer events so this doesn't interfere with hovering.
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent): void => {
      if (!wrapperRef.current) return
      if (e.target instanceof Node && wrapperRef.current.contains(e.target)) return
      setOpen(false)
    }
    window.addEventListener('mousedown', close)
    return () => {
      window.removeEventListener('mousedown', close)
    }
  }, [open])

  const loRange = selectionIndices
    ? Math.min(selectionIndices.fromIdx, selectionIndices.toIdx)
    : -1
  const hiRange = selectionIndices
    ? Math.max(selectionIndices.fromIdx, selectionIndices.toIdx)
    : -1

  const buttonLabel = isWholeBranch
    ? 'All commits'
    : fromCommit && toCommit && fromCommit === toCommit
      ? shortOf(commits, fromCommit)
      : `${shortOf(commits, fromCommit)}…${shortOf(commits, toCommit)}`

  return (
    <div ref={wrapperRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 px-2 py-1 rounded border border-border text-xs text-fg hover:bg-panel-raised transition-colors cursor-pointer min-w-0"
      >
        <GitCommitHorizontal className="icon-xs text-faint shrink-0" />
        <span className="font-mono max-w-[10rem] truncate">{buttonLabel}</span>
        <ChevronDown className="icon-2xs text-faint shrink-0" />
      </button>
      {open && (
        <div
          className="absolute z-50 top-full left-0 mt-1 w-80 max-h-[24rem] overflow-y-auto bg-panel-raised border border-border-strong rounded shadow-lg py-1"
          // Stop mousedown bubbling so clicks inside the popover don't
          // trip the outside-click close listener.
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            onClick={() => {
              onSelectAll()
              setOpen(false)
            }}
            className={`w-full text-left px-3 py-1.5 text-xs cursor-pointer transition-colors ${
              isWholeBranch
                ? 'bg-panel text-fg-bright'
                : 'text-fg hover:bg-panel'
            }`}
          >
            All commits
          </button>
          <div className="h-px bg-border/50 my-1" />
          {commits.length === 0 && (
            <div className="px-3 py-2 text-xs text-faint">No commits ahead of base</div>
          )}
          {commits.map((c, i) => {
            const selected = !isWholeBranch && i >= loRange && i <= hiRange
            const dotClass = c.pushed
              ? 'bg-border-strong'
              : 'bg-warning shadow-[0_0_6px_rgba(234,179,8,0.5)]'
            return (
              <Tooltip
                key={c.hash}
                label={`${c.shortHash} · ${c.author} · ${c.relativeDate} · ${c.pushed ? 'pushed' : 'unpushed'} · click=select · shift+click=range`}
                side="left"
              >
                <div
                  onClick={(e) => {
                    onCommitClick(i, e.shiftKey)
                    // Keep open on shift-click so the user can extend the
                    // range without re-opening between picks.
                    if (!e.shiftKey) setOpen(false)
                  }}
                  className={`group flex items-center gap-2 px-3 py-1.5 text-xs cursor-pointer transition-colors ${
                    selected ? 'bg-panel text-fg-bright' : 'hover:bg-panel text-fg'
                  }`}
                >
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotClass}`} aria-hidden />
                  <span className={`shrink-0 font-mono ${c.pushed ? 'text-faint' : 'text-warning'}`}>
                    {c.shortHash}
                  </span>
                  <span className={`truncate min-w-0 flex-1 ${c.pushed ? 'text-dim' : ''}`}>
                    {c.subject}
                  </span>
                  {!c.pushed && <ArrowUp className="icon-2xs shrink-0 text-warning" />}
                </div>
              </Tooltip>
            )
          })}
        </div>
      )}
    </div>
  )
}

function shortOf(commits: BranchCommit[], hash?: string): string {
  if (!hash) return ''
  const m = commits.find((c) => c.hash === hash)
  return m ? m.shortHash : hash.slice(0, 7)
}

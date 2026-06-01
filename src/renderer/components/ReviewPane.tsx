import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { Send, Clipboard, Check, MessageSquare, GitCommitHorizontal, ArrowUp, ChevronDown, Pilcrow, X, Keyboard, CloudSync, Loader2 } from 'lucide-react'
import type { ChangedFile, BranchCommit } from '../types'
import type { PRReview } from '../../shared/state/prs'
import type { ReviewComment } from './ReviewFileTree'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize from 'rehype-sanitize'
import { ReviewFileTree } from './ReviewFileTree'
import { ReviewDiffPane } from './ReviewDiffPane'
import { ModeButton } from './DiffView'
import { ResizeHandle } from './ResizeHandle'
import { Tooltip } from './Tooltip'
import { useBackend } from '../backend'
import { usePrs } from '../store'
import { setReviewProgress, clearReviewProgress } from '../review-progress'
import { useReviewFileRequest } from '../review-open-file'

interface ReviewPaneProps {
  tabId: string
  worktreePath: string
  /** Anchor commit of the selection (oldest selected). Undefined ⇒ "All commits". */
  fromCommit?: string
  /** Tip commit of the selection (newest selected). Undefined ⇒ "All commits". */
  toCommit?: string
  /** True when this review tab is the active/visible tab in its pane.
   *  Gates the review keyboard shortcuts so they don't fire from a
   *  background tab. */
  active?: boolean
  onSendToAgent?: (text: string) => void
}

let commentIdCounter = 0

export function ReviewPane({
  tabId,
  worktreePath,
  fromCommit,
  toCommit,
  active,
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
  // Hoisted above ReviewDiffPane so the choice persists as the reviewer
  // clicks through files in the same review session.
  const [wordWrap, setWordWrap] = useState(false)
  const [sideBySide, setSideBySide] = useState(false)
  const [showWhitespace, setShowWhitespace] = useState(false)
  const [showShortcuts, setShowShortcuts] = useState(false)
  const [revealTarget, setRevealTarget] = useState<{ filePath: string; line: number; nonce: number } | null>(null)
  const revealNonceRef = useRef(0)
  const [refreshKey, setRefreshKey] = useState(0)
  const [syncState, setSyncState] = useState<'idle' | 'syncing' | 'ok' | 'error'>('idle')
  const [syncDetail, setSyncDetail] = useState<string | null>(null)
  const syncing = syncState === 'syncing'

  const prs = usePrs()
  const pr = prs.byPath[worktreePath]
  const prNumber = pr?.number

  // Whole-branch when both bounds are undefined. Single commit when both
  // are set and equal. Otherwise a contiguous range.
  const isWholeBranch = !fromCommit && !toCommit
  const isSingleCommit = !!fromCommit && fromCommit === toCommit

  // Re-fetch when the worktree's git state changes (new commits, etc.).
  // Same watcher signal the Changed Files / Branch Commits panels use.
  // Bumps refreshKey, which the commit + file effects below depend on.
  useEffect(() => {
    backend.watchChangedFiles(worktreePath)
    const off = backend.onChangedFilesInvalidated((path) => {
      if (path === worktreePath) setRefreshKey((k) => k + 1)
    })
    return () => {
      off()
      backend.unwatchChangedFiles(worktreePath)
    }
  }, [worktreePath, backend])

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
  }, [worktreePath, backend, refreshKey])

  // The reviewed set / comments belong to a specific file set, so wipe
  // them when the commit selection changes. A plain refresh (new commit
  // on the same selection) must NOT wipe them — that's why this is keyed
  // on the selection identity only, not refreshKey.
  useEffect(() => {
    setReviewedFiles(new Set())
    setComments([])
  }, [worktreePath, isWholeBranch, isSingleCommit, fromCommit, toCommit])

  // Refetch the file list when the selection changes or a refresh fires.
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
        // Drop reviewed marks for files that no longer exist so the
        // progress count stays honest after a refresh.
        setReviewedFiles((prev) => {
          const next = new Set([...prev].filter((p) => result.some((f) => f.path === p)))
          return next.size === prev.size ? prev : next
        })
      })
      .catch(() => {
        if (!cancelled) setFiles([])
      })
    return () => {
      cancelled = true
    }
  }, [worktreePath, backend, isWholeBranch, isSingleCommit, fromCommit, toCommit, refreshKey])

  // Push "(N/M)" up to the tab strip. Clear on unmount.
  useEffect(() => {
    setReviewProgress(tabId, { reviewed: reviewedFiles.size, total: files.length })
  }, [tabId, reviewedFiles, files.length])

  useEffect(() => {
    return () => {
      clearReviewProgress(tabId)
    }
  }, [tabId])

  // Honor an external "jump to this file" request (Changed Files panel
  // clicking a committed file opens this tab and asks for that file). The
  // file may not be in `files` yet when the tab is first created — set it
  // anyway; the file-load effect above preserves a still-valid selection
  // once the list arrives.
  const fileRequest = useReviewFileRequest(worktreePath)
  useEffect(() => {
    if (fileRequest) setSelectedFile(fileRequest.filePath)
  }, [fileRequest?.nonce, fileRequest?.filePath])

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

  // A reply targets a thread root by its GitHub id, on the root's file+line.
  const handleAddReply = useCallback(
    (root: { filePath: string; lineNumber: number; remoteId: number }, body: string) => {
      setComments((prev) => [
        ...prev,
        {
          id: `comment-${++commentIdCounter}`,
          filePath: root.filePath,
          lineNumber: root.lineNumber,
          body,
          timestamp: Date.now(),
          inReplyToId: root.remoteId,
          draft: true
        }
      ])
    },
    []
  )

  // Threads the user has asked to resolve; sent on the next sync, then
  // cleared (GitHub's resolved state comes back via the pull).
  const [pendingResolve, setPendingResolve] = useState<Set<string>>(new Set())
  const handleResolveThread = useCallback((threadId: string) => {
    setPendingResolve((prev) => {
      if (prev.has(threadId)) return prev
      const next = new Set(prev)
      next.add(threadId)
      return next
    })
  }, [])

  const formatComments = useCallback((): string => {
    if (comments.length === 0) return ''
    const lines = ['Review feedback on your changes:', '']
    for (const c of comments) {
      const loc = c.lineNumber === 0 ? c.filePath : `${c.filePath}:${c.lineNumber}`
      lines.push(`${loc} — ${c.body}`)
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

  // Push local comments + viewed state to the PR and pull the canonical
  // comment set back. Replaces the local comment list with the reconciled
  // result so synced comments carry their GitHub ids (and don't re-post).
  const runSync = useCallback(
    async (pullOnly: boolean) => {
      if (syncing || !prNumber || !isWholeBranch) return
      setSyncState('syncing')
      setSyncDetail(pullOnly ? 'Loading PR comments…' : 'Syncing…')
      try {
        const result = await backend.reviewSync(worktreePath, {
          comments: comments.map((c) => ({
            filePath: c.filePath,
            lineNumber: c.lineNumber,
            body: c.body,
            remoteId: c.remoteId,
            author: c.author,
            inReplyToId: c.inReplyToId
          })),
          reviewedFiles: [...reviewedFiles],
          files: files.map((f) => f.path),
          resolveThreadIds: pullOnly ? [] : [...pendingResolve],
          pullOnly
        })
        if (!result.ok) {
          setSyncState('error')
          setSyncDetail(result.error ?? 'Sync failed')
          return
        }
        setComments(
          result.comments.map((c) => ({
            id: c.remoteId !== undefined ? `gh-${c.remoteId}` : `comment-${++commentIdCounter}`,
            filePath: c.filePath,
            lineNumber: c.lineNumber,
            body: c.body,
            timestamp: Date.now(),
            remoteId: c.remoteId,
            author: c.author,
            authorAvatarUrl: c.authorAvatarUrl,
            createdAt: c.createdAt,
            htmlUrl: c.htmlUrl,
            draft: c.draft,
            inReplyToId: c.inReplyToId,
            threadId: c.threadId,
            resolved: c.resolved
          }))
        )
        // Reflect the merged viewed state (local ∪ GitHub) so files viewed
        // on GitHub show as reviewed here too.
        setReviewedFiles(new Set(result.reviewedFiles))
        // Resolve requests were sent; GitHub's resolved state is now in the
        // pulled comments, so clear the pending set.
        if (!pullOnly) setPendingResolve(new Set())
        setSyncState(result.failed > 0 ? 'error' : 'ok')
        setSyncDetail(
          pullOnly
            ? `Loaded ${result.comments.length} comment${result.comments.length === 1 ? '' : 's'}`
            : `Synced${result.pushed > 0 ? ` · ${result.pushed} drafted` : ''}${
                result.failed > 0 ? ` · ${result.failed} failed` : ''
              }`
        )
      } catch (err) {
        setSyncState('error')
        setSyncDetail(err instanceof Error ? err.message : 'Sync failed')
      }
    },
    [syncing, prNumber, isWholeBranch, backend, worktreePath, comments, reviewedFiles, files, pendingResolve]
  )

  const handleSync = useCallback(() => void runSync(false), [runSync])

  // Auto-sync (pull-only) once when the review opens with a PR, so existing
  // PR comments show up without a manual Sync. Pull-only can't clobber
  // GitHub state from the empty local review.
  const autoSyncedRef = useRef<string | null>(null)
  useEffect(() => {
    if (!prNumber || !isWholeBranch) return
    const key = `${worktreePath}:${prNumber}`
    if (autoSyncedRef.current === key) return
    autoSyncedRef.current = key
    void runSync(true)
    // runSync intentionally omitted — fire once per worktree+PR, not on every
    // comments/reviewedFiles change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prNumber, isWholeBranch, worktreePath])

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
    <div className="relative flex flex-col h-full w-full bg-bg">
      {showShortcuts && <ReviewShortcutsPopup onClose={() => setShowShortcuts(false)} />}
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
            totalAdditions={totalAdditions}
            totalDeletions={totalDeletions}
          />

          <div className="flex items-center rounded border border-border overflow-hidden text-xs">
            <ModeButton active={sideBySide} label="Split" hint="s" onClick={() => setSideBySide(true)} />
            <ModeButton active={!sideBySide} label="Unified" hint="d" onClick={() => setSideBySide(false)} />
          </div>

          <Tooltip label={showWhitespace ? 'Showing whitespace changes' : 'Ignoring whitespace changes'}>
            <button
              onClick={() => setShowWhitespace((v) => !v)}
              aria-pressed={showWhitespace}
              className={`flex items-center shrink-0 px-1.5 py-1 rounded border text-xs cursor-pointer transition-colors ${
                showWhitespace ? 'border-accent text-accent' : 'border-border text-faint hover:text-fg'
              }`}
            >
              <Pilcrow className="icon-xs" />
            </button>
          </Tooltip>

          <div className="flex-1" />

          <div className="flex items-center gap-1.5 text-xs">
            <Tooltip label="Copy comments to clipboard">
              <button
                onClick={handleCopyComments}
                disabled={comments.length === 0}
                className="flex items-center gap-1 px-2 py-1 rounded border border-border text-faint hover:text-fg transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-default"
              >
                <Clipboard className="icon-xs" />
                Copy
              </button>
            </Tooltip>

            <Tooltip
              label={
                !prNumber
                  ? 'No pull request for this worktree'
                  : !isWholeBranch
                    ? 'Sync only works when reviewing all commits'
                    : syncState !== 'idle' && syncDetail
                      ? syncDetail
                      : 'Sync: push draft comments & viewed state to the PR (submit on GitHub)'
              }
            >
              <button
                onClick={handleSync}
                disabled={!prNumber || !isWholeBranch || syncing}
                className="relative flex items-center gap-1 px-2 py-1 rounded border border-border text-faint hover:text-fg transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-default"
              >
                {syncing ? (
                  <Loader2 className="icon-xs animate-spin" />
                ) : (
                  <CloudSync className="icon-xs" />
                )}
                Sync
                {syncState !== 'idle' && (
                  <span
                    className={`absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full ${
                      syncState === 'error'
                        ? 'bg-danger'
                        : syncState === 'syncing'
                          ? 'bg-warning'
                          : 'bg-success'
                    }`}
                    aria-hidden
                  />
                )}
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

          <Tooltip label="Keyboard shortcuts (?)">
            <button
              onClick={() => setShowShortcuts((v) => !v)}
              className="flex items-center shrink-0 px-1.5 py-1 rounded border border-border text-faint hover:text-fg cursor-pointer transition-colors"
            >
              <Keyboard className="icon-xs" />
            </button>
          </Tooltip>
        </div>

        {/* Second row — review status info */}
        <div className="h-9 flex items-center gap-3 px-3 border-t border-border/60 text-xs">
          {pr && <ReviewerStatus reviews={pr.reviews} />}

          <CommentDropdown
            comments={comments}
            onSelect={(c) => {
              setSelectedFile(c.filePath)
              setRevealTarget({ filePath: c.filePath, line: c.lineNumber, nonce: ++revealNonceRef.current })
            }}
          />

          <div className="flex-1" />

          {allReviewed ? (
            <span className="flex items-center gap-1 text-success font-medium">
              <Check strokeWidth={2.5} className="icon-xs" />
              All reviewed
            </span>
          ) : (
            <span className="text-faint tabular-nums">
              {reviewedFiles.size} reviewed · {Math.max(0, files.length - reviewedFiles.size)} remaining
            </span>
          )}
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
            onSetSideBySide={setSideBySide}
            onShowShortcuts={() => setShowShortcuts((v) => !v)}
            onRevealLine={(filePath, line) =>
              setRevealTarget({ filePath, line, nonce: ++revealNonceRef.current })
            }
            active={active}
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
            sideBySide={sideBySide}
            ignoreTrimWhitespace={!showWhitespace}
            active={active}
            revealTarget={revealTarget}
            onToggleReviewed={() => {
              if (selectedFile) handleToggleReviewed(selectedFile)
            }}
            onAddComment={handleAddComment}
            onDeleteComment={handleDeleteComment}
            wordWrap={wordWrap}
            onWordWrapChange={setWordWrap}
            onAddReply={handleAddReply}
            onResolveThread={handleResolveThread}
            pendingResolve={pendingResolve}
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
  totalAdditions: number
  totalDeletions: number
  onSelectAll: () => void
  onCommitClick: (idx: number, shift: boolean) => void
}

function CommitSelector({
  commits,
  isWholeBranch,
  selectionIndices,
  fromCommit,
  toCommit,
  totalAdditions,
  totalDeletions,
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
        {(totalAdditions > 0 || totalDeletions > 0) && (
          <span className="font-mono tabular-nums shrink-0">
            {totalAdditions > 0 && <span className="text-success">+{totalAdditions}</span>}
            {totalDeletions > 0 && <span className="text-danger ml-1">−{totalDeletions}</span>}
          </span>
        )}
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

const REVIEW_MD_PLUGINS = [remarkGfm]
const REVIEW_REHYPE_PLUGINS = [rehypeRaw, rehypeSanitize]

const REVIEW_STATE_META: Record<string, { ring: string; label: string }> = {
  APPROVED: { ring: 'ring-success', label: 'approved' },
  CHANGES_REQUESTED: { ring: 'ring-danger', label: 'requested changes' },
  COMMENTED: { ring: 'ring-info', label: 'commented' },
  DISMISSED: { ring: 'ring-border', label: 'dismissed' },
  PENDING: { ring: 'ring-border', label: 'pending' }
}

/** Compact cluster of reviewer avatars, ring-colored by their latest review
 *  state. Renders nothing until someone has actually reviewed. Clicking an
 *  avatar opens that reviewer's top-level review comment. */
function ReviewerStatus({ reviews }: { reviews: PRReview[] }): JSX.Element | null {
  const [openUser, setOpenUser] = useState<string | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!openUser) return
    const close = (e: MouseEvent): void => {
      if (wrapRef.current && e.target instanceof Node && wrapRef.current.contains(e.target)) return
      setOpenUser(null)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [openUser])

  const latest = new Map<string, PRReview>()
  for (const r of reviews) {
    if (r.state === 'PENDING') continue
    const prev = latest.get(r.user)
    if (!prev || r.submittedAt > prev.submittedAt) latest.set(r.user, r)
  }
  const list = [...latest.values()]
  if (list.length === 0) return null
  const openReview = list.find((r) => r.user === openUser) ?? null

  return (
    <div ref={wrapRef} className="relative flex items-center -space-x-1 mr-1">
      {list.map((r) => {
        const meta = REVIEW_STATE_META[r.state] ?? REVIEW_STATE_META.COMMENTED
        return (
          <Tooltip key={r.user} label={`@${r.user} · ${meta.label}`}>
            <button
              onClick={() => setOpenUser((u) => (u === r.user ? null : r.user))}
              className={`w-5 h-5 rounded-full ring-2 ${meta.ring} bg-panel overflow-hidden cursor-pointer hover:z-10`}
            >
              {r.avatarUrl ? (
                <img src={r.avatarUrl} alt={r.user} className="w-full h-full" />
              ) : (
                <span className="w-full h-full flex items-center justify-center text-faint uppercase bg-panel-raised">
                  {r.user.slice(0, 1)}
                </span>
              )}
            </button>
          </Tooltip>
        )
      })}
      {openReview && (
        <div
          className="absolute z-50 top-full left-0 mt-2 w-80 rounded-lg border border-border-strong bg-panel-raised shadow-lg"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
            <span className="text-xs font-medium text-fg">@{openReview.user}</span>
            <span className="text-xs text-faint">
              {(REVIEW_STATE_META[openReview.state] ?? REVIEW_STATE_META.COMMENTED).label}
            </span>
            {openReview.htmlUrl && (
              <a
                href={openReview.htmlUrl}
                target="_blank"
                rel="noreferrer"
                className="ml-auto text-xs text-info hover:underline"
                onClick={() => setOpenUser(null)}
              >
                Open
              </a>
            )}
          </div>
          <div className="px-3 py-2 max-h-48 overflow-y-auto">
            {openReview.body.trim() ? (
              <div className="markdown text-xs text-dim">
                <ReactMarkdown remarkPlugins={REVIEW_MD_PLUGINS} rehypePlugins={REVIEW_REHYPE_PLUGINS}>
                  {openReview.body}
                </ReactMarkdown>
              </div>
            ) : (
              <span className="text-xs text-faint">(no top-level comment)</span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function CommentDropdown({
  comments,
  onSelect
}: {
  comments: ReviewComment[]
  onSelect: (c: ReviewComment) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent): void => {
      if (wrapRef.current && e.target instanceof Node && wrapRef.current.contains(e.target)) return
      setOpen(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open])

  const sorted = [...comments].sort(
    (a, b) => a.filePath.localeCompare(b.filePath) || a.lineNumber - b.lineNumber
  )

  return (
    <div ref={wrapRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={comments.length === 0}
        className="flex items-center gap-1 text-info hover:text-info/70 transition-colors cursor-pointer disabled:text-faint disabled:cursor-default"
      >
        <MessageSquare className="icon-xs" />
        {comments.length} {comments.length === 1 ? 'comment' : 'comments'}
        {comments.length > 0 && <ChevronDown className="icon-2xs" />}
      </button>
      {open && comments.length > 0 && (
        <div
          className="absolute z-50 top-full left-0 mt-1 w-[28rem] max-h-[20rem] overflow-y-auto bg-panel-raised border border-border-strong rounded shadow-lg py-1"
          onMouseDown={(e) => e.stopPropagation()}
        >
          {sorted.map((c) => {
            const name = c.filePath.split('/').pop() || c.filePath
            return (
              <button
                key={c.id}
                onClick={() => {
                  onSelect(c)
                  setOpen(false)
                }}
                className="w-full text-left px-3 py-1.5 hover:bg-panel transition-colors cursor-pointer"
              >
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono text-fg truncate">{name}</span>
                  <span className="font-mono text-faint shrink-0">
                    {c.lineNumber > 0 ? `:${c.lineNumber}` : '· file'}
                  </span>
                  {c.author && <span className="text-info shrink-0">@{c.author}</span>}
                </div>
                <div className="text-xs text-dim mt-0.5 line-clamp-1">{c.body}</div>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

const REVIEW_SHORTCUTS: [string, string][] = [
  ['j / ↓', 'Next file'],
  ['k / ↑', 'Previous file'],
  ['⇧J / ⇧↓', 'Next unreviewed file'],
  ['⇧K / ⇧↑', 'Previous unreviewed file'],
  ['] / [', 'Next / previous comment in file'],
  ['r', 'Mark file viewed / unviewed'],
  ['s / d', 'Side-by-side / unified diff'],
  ['c', 'Comment on hovered line (or file)'],
  ['?', 'Toggle this help']
]

function ReviewShortcutsPopup({ onClose }: { onClose: () => void }): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="w-96 max-w-[90%] rounded-lg border border-border-strong bg-panel-raised shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-border">
          <span className="text-lg font-medium text-fg">Review shortcuts</span>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-faint hover:text-fg cursor-pointer"
          >
            <X className="icon-base" />
          </button>
        </div>
        <div className="px-4 py-3 flex flex-col gap-2.5">
          {REVIEW_SHORTCUTS.map(([keys, desc]) => (
            <div key={keys} className="flex items-center justify-between gap-4 text-base">
              <span className="text-dim">{desc}</span>
              <kbd className="shrink-0 font-mono text-faint bg-panel px-1.5 py-0.5 rounded border border-border">
                {keys}
              </kbd>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

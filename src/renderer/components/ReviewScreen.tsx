import { useState, useEffect, useCallback, useMemo } from 'react'
import type { ChangedFile } from '../types'
import type { ReviewComment } from './ReviewFileTree'
import { ReviewSummaryBar } from './ReviewSummaryBar'
import { ReviewFileTree } from './ReviewFileTree'
import { ReviewDiffPane } from './ReviewDiffPane'

export interface ReviewCommit {
  hash: string
  shortHash: string
  subject: string
}

interface ReviewScreenProps {
  worktreePath: string
  branchName: string
  repoLabel: string
  mode: 'working' | 'branch'
  commit?: ReviewCommit
  onClose: () => void
  onSendToAgent: (worktreePath: string, text: string) => void
}

let commentIdCounter = 0

export function ReviewScreen({
  worktreePath,
  branchName,
  repoLabel,
  mode,
  commit,
  onClose,
  onSendToAgent
}: ReviewScreenProps): JSX.Element {
  const [files, setFiles] = useState<ChangedFile[]>([])
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [reviewedFiles, setReviewedFiles] = useState<Set<string>>(new Set())
  const [comments, setComments] = useState<ReviewComment[]>([])
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(new Set())

  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      try {
        const result = commit
          ? await window.api.getCommitChangedFiles(worktreePath, commit.hash)
          : await window.api.getChangedFiles(worktreePath, mode)
        if (!cancelled) {
          setFiles(result)
          if (!selectedFile && result.length > 0) {
            setSelectedFile(result[0].path)
          }
        }
      } catch {
        if (!cancelled) setFiles([])
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [worktreePath, mode, commit?.hash])

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !(e.target instanceof HTMLTextAreaElement) && !(e.target instanceof HTMLInputElement)) {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

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
        if (next.has(path)) {
          next.delete(path)
        } else {
          next.add(path)
        }
        return next
      })
    },
    []
  )

  const handleToggleDir = useCallback(
    (dir: string) => {
      setCollapsedDirs((prev) => {
        const next = new Set(prev)
        if (next.has(dir)) {
          next.delete(dir)
        } else {
          next.add(dir)
        }
        return next
      })
    },
    []
  )

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

  const handleSendToAgent = useCallback(() => {
    const text = formatComments()
    if (!text) return
    onSendToAgent(worktreePath, text + '\n')
    onClose()
  }, [formatComments, onSendToAgent, worktreePath, onClose])

  const handleCopyComments = useCallback(() => {
    const text = formatComments()
    if (text) navigator.clipboard.writeText(text)
  }, [formatComments])

  return (
    <div className="flex flex-col h-full w-full bg-bg">
      <ReviewSummaryBar
        branchName={branchName}
        repoLabel={repoLabel}
        commit={commit}
        fileCount={files.length}
        additions={totalAdditions}
        deletions={totalDeletions}
        reviewedCount={reviewedFiles.size}
        pendingCommentCount={comments.length}
        onSendToAgent={handleSendToAgent}
        onCopyComments={handleCopyComments}
        onClose={onClose}
      />

      <div className="flex flex-1 min-h-0">
        {/* File tree */}
        <div className="w-60 shrink-0 border-r border-border overflow-hidden">
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

        {/* Diff pane */}
        <div className="flex-1 min-w-0">
          <ReviewDiffPane
            worktreePath={worktreePath}
            file={selectedFileObj}
            mode={mode}
            commitHash={commit?.hash}
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

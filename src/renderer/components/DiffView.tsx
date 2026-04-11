import { useState, useEffect } from 'react'
import type { CommitDiff } from '../types'

interface DiffViewProps {
  worktreePath: string
  filePath?: string
  staged?: boolean
  branchDiff?: boolean
  commitHash?: string
}

interface DiffLine {
  type: 'add' | 'remove' | 'context' | 'header' | 'hunk'
  content: string
  oldLine?: number
  newLine?: number
}

function parseDiff(raw: string): DiffLine[] {
  const lines: DiffLine[] = []
  let oldLine = 0
  let newLine = 0

  for (const line of raw.split('\n')) {
    if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) {
      lines.push({ type: 'header', content: line })
    } else if (line.startsWith('@@')) {
      // Parse hunk header: @@ -old,count +new,count @@
      const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
      if (match) {
        oldLine = parseInt(match[1], 10)
        newLine = parseInt(match[2], 10)
      }
      lines.push({ type: 'hunk', content: line })
    } else if (line.startsWith('+')) {
      lines.push({ type: 'add', content: line.slice(1), newLine })
      newLine++
    } else if (line.startsWith('-')) {
      lines.push({ type: 'remove', content: line.slice(1), oldLine })
      oldLine++
    } else if (line.startsWith(' ')) {
      lines.push({ type: 'context', content: line.slice(1), oldLine, newLine })
      oldLine++
      newLine++
    }
  }

  return lines
}

const LINE_STYLES: Record<DiffLine['type'], string> = {
  add: 'bg-success/15 text-success',
  remove: 'bg-danger/15 text-danger',
  context: 'text-muted',
  header: 'text-dim italic',
  hunk: 'text-info bg-info/10'
}

const GUTTER_STYLES: Record<DiffLine['type'], string> = {
  add: 'text-success/70',
  remove: 'text-danger/70',
  context: 'text-faint',
  header: '',
  hunk: 'text-info/70'
}

export function DiffView({ worktreePath, filePath, staged, branchDiff, commitHash }: DiffViewProps): JSX.Element {
  const [diff, setDiff] = useState<string | null>(null)
  const [commit, setCommit] = useState<CommitDiff | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setDiff(null)
    setCommit(null)
    if (commitHash) {
      window.api.getCommitDiff(worktreePath, commitHash).then((result) => {
        if (cancelled) return
        setCommit(result)
        setDiff(result?.diff ?? '')
        setLoading(false)
      })
    } else if (filePath) {
      window.api
        .getFileDiff(worktreePath, filePath, staged ?? false, branchDiff ? 'branch' : 'working')
        .then((result) => {
          if (cancelled) return
          setDiff(result)
          setLoading(false)
        })
    } else {
      setLoading(false)
    }
    return () => {
      cancelled = true
    }
  }, [worktreePath, filePath, staged, branchDiff, commitHash])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-faint text-sm">
        Loading diff...
      </div>
    )
  }

  if (!diff) {
    return (
      <div className="flex items-center justify-center h-full text-faint text-sm">
        No diff available
      </div>
    )
  }

  const lines = parseDiff(diff)

  return (
    <div className="h-full overflow-auto bg-app">
      {commit && <CommitHeader commit={commit} />}
      <div className="font-mono text-xs leading-5 min-w-fit">
        {lines.map((line, i) => (
          <div key={i} className={`flex ${LINE_STYLES[line.type]}`}>
            {/* Gutter */}
            <span className={`shrink-0 w-10 text-right pr-2 select-none ${GUTTER_STYLES[line.type]}`}>
              {line.type === 'add' || line.type === 'context' ? line.newLine : ''}
            </span>
            <span className={`shrink-0 w-10 text-right pr-2 select-none border-r border-border/50 ${GUTTER_STYLES[line.type]}`}>
              {line.type === 'remove' || line.type === 'context' ? line.oldLine : ''}
            </span>
            {/* Sign */}
            <span className="shrink-0 w-5 text-center select-none">
              {line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ''}
            </span>
            {/* Content */}
            <span className="whitespace-pre pr-4">{line.content}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function CommitHeader({ commit }: { commit: CommitDiff }): JSX.Element {
  const date = new Date(commit.date)
  const formatted = isNaN(date.getTime()) ? commit.date : date.toLocaleString()
  return (
    <div className="border-b border-border bg-panel px-5 py-4">
      <div className="flex items-center gap-2 mb-2">
        <span className="font-mono text-[11px] text-info bg-info/10 px-2 py-0.5 rounded">
          {commit.shortHash}
        </span>
        <span className="text-xs text-faint">{formatted}</span>
      </div>
      <div className="text-sm font-medium text-fg mb-1">{commit.subject}</div>
      <div className="text-xs text-muted mb-2">
        {commit.author} {commit.authorEmail && <span className="text-faint">&lt;{commit.authorEmail}&gt;</span>}
      </div>
      {commit.body && (
        <pre className="text-xs text-muted whitespace-pre-wrap font-sans mt-2 leading-relaxed">
          {commit.body.trim()}
        </pre>
      )}
    </div>
  )
}

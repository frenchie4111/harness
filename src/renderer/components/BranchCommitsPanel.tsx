import { useState, useEffect, useCallback } from 'react'
import { RefreshCw } from 'lucide-react'
import type { BranchCommit } from '../types'
import { Tooltip } from './Tooltip'

interface BranchCommitsPanelProps {
  worktreePath: string | null
}

export function BranchCommitsPanel({ worktreePath }: BranchCommitsPanelProps): JSX.Element | null {
  const [commits, setCommits] = useState<BranchCommit[]>([])
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async () => {
    if (!worktreePath) {
      setCommits([])
      return
    }
    setLoading(true)
    try {
      const result = await window.api.getBranchCommits(worktreePath)
      setCommits(result)
    } catch (err) {
      console.error('Failed to get branch commits:', err)
      setCommits([])
    } finally {
      setLoading(false)
    }
  }, [worktreePath])

  useEffect(() => {
    refresh()
    const interval = setInterval(refresh, 5000)
    return () => clearInterval(interval)
  }, [refresh])

  if (!worktreePath) return null

  return (
    <div className="flex flex-col border-b border-border bg-panel shrink-0 max-h-48">
      <div className="flex items-center justify-between h-8 px-3 border-b border-border shrink-0">
        <span className="text-xs font-medium text-muted uppercase tracking-wide">
          Commits
        </span>
        <div className="flex items-center gap-2">
          {commits.length > 0 && (
            <span className="text-[10px] text-faint">{commits.length}</span>
          )}
          <Tooltip label="Refresh">
            <button
              onClick={refresh}
              className="text-faint hover:text-fg transition-colors cursor-pointer"
            >
              <RefreshCw size={12} />
            </button>
          </Tooltip>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto min-h-0 text-xs">
        {commits.length === 0 && !loading && (
          <div className="p-3 text-faint">No commits ahead of base</div>
        )}
        {commits.map((c) => (
          <Tooltip key={c.hash} label={`${c.shortHash} · ${c.author} · ${c.relativeDate}`} side="left">
            <div className="flex items-baseline gap-2 px-3 py-1 hover:bg-panel-raised cursor-default">
              <span className="shrink-0 font-mono text-[10px] text-faint">{c.shortHash}</span>
              <span className="truncate min-w-0 flex-1 text-fg">{c.subject}</span>
            </div>
          </Tooltip>
        ))}
      </div>
    </div>
  )
}

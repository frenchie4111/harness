import { useState, useEffect, useCallback } from 'react'
import { RefreshCw } from 'lucide-react'
import type { BranchCommit } from '../types'
import { Tooltip } from './Tooltip'

interface BranchCommitsPanelProps {
  worktreePath: string | null
  onOpenCommit?: (hash: string, shortHash: string, subject: string) => void
}

export function BranchCommitsPanel({ worktreePath, onOpenCommit }: BranchCommitsPanelProps): JSX.Element | null {
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
    <div className="flex flex-col border-b border-border bg-panel shrink-0 max-h-56">
      <div className="flex items-center justify-between h-9 px-3 border-b border-border shrink-0">
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
      <div className="flex-1 overflow-y-auto min-h-0 text-xs py-1.5">
        {commits.length === 0 && !loading && (
          <div className="px-4 py-2 text-faint">No commits ahead of base</div>
        )}
        {commits.map((c, i) => {
          const isFirst = i === 0
          const isLast = i === commits.length - 1
          return (
            <Tooltip key={c.hash} label={`${c.shortHash} · ${c.author} · ${c.relativeDate}`} side="left">
              <div
                onClick={() => onOpenCommit?.(c.hash, c.shortHash, c.subject)}
                className="group relative flex items-center gap-2.5 pl-4 pr-3 py-1.5 hover:bg-panel-raised cursor-pointer"
              >
                {/* Tree line + dot */}
                <div className="relative shrink-0 w-3 self-stretch flex justify-center">
                  <div
                    className="absolute left-1/2 -translate-x-1/2 w-px bg-border-strong"
                    style={{ top: isFirst ? '50%' : 0, bottom: isLast ? '50%' : 0 }}
                  />
                  <div className="relative z-10 self-center w-2 h-2 rounded-full bg-info ring-2 ring-panel group-hover:ring-panel-raised group-hover:bg-success transition-colors shadow-[0_0_6px_rgba(56,189,248,0.5)]" />
                </div>
                <span className="shrink-0 font-mono text-[10px] text-faint">{c.shortHash}</span>
                <span className="truncate min-w-0 flex-1 text-fg">{c.subject}</span>
              </div>
            </Tooltip>
          )
        })}
      </div>
    </div>
  )
}

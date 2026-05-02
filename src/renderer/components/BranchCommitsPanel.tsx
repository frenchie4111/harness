import { useCallback } from 'react'
import { RefreshCw, ArrowUp } from 'lucide-react'
import type { BranchCommit } from '../types'
import { Tooltip } from './Tooltip'
import { RightPanel } from './RightPanel'
import { useWatchedQuery } from '../hooks/useWatchedQuery'

interface BranchCommitsPanelProps {
  worktreePath: string | null
  onOpenCommitReview?: (hash: string, shortHash: string, subject: string) => void
}

export function BranchCommitsPanel({ worktreePath, onOpenCommitReview }: BranchCommitsPanelProps): JSX.Element | null {
  const fetcher = useCallback((path: string) => window.api.getBranchCommits(path), [])

  const { data, loading, refresh } = useWatchedQuery<BranchCommit[]>({
    worktreePath,
    cacheKey: 'branchCommits',
    fetcher,
  })

  const commits = data ?? []
  const hasLoaded = !loading

  if (!worktreePath) return null

  const actions = (
    <>
      {commits.length > 0 && (
        <span className="text-[10px] text-faint">{commits.length}</span>
      )}
      <Tooltip label="Refresh">
        <button
          onClick={(e) => {
            e.stopPropagation()
            refresh()
          }}
          className="text-faint hover:text-fg transition-colors cursor-pointer"
        >
          <RefreshCw size={12} />
        </button>
      </Tooltip>
    </>
  )

  return (
    <RightPanel id="commits" title="Commits" actions={actions} maxHeight="max-h-56">
      <div className="flex-1 overflow-y-auto min-h-0 text-xs py-1.5">
        {commits.length === 0 && hasLoaded && (
          <div className="px-4 py-2 text-faint">No commits ahead of base</div>
        )}
        {commits.map((c, i) => {
          const isFirst = i === 0
          const isLast = i === commits.length - 1
          const dotClass = c.pushed
            ? 'bg-border-strong ring-2 ring-panel group-hover:ring-panel-raised'
            : 'bg-warning ring-2 ring-panel group-hover:ring-panel-raised shadow-[0_0_6px_rgba(234,179,8,0.5)]'
          const tipSuffix = c.pushed ? 'pushed' : 'unpushed'
          return (
            <Tooltip key={c.hash} label={`${c.shortHash} · ${c.author} · ${c.relativeDate} · ${tipSuffix}`} side="left">
              <div
                onClick={() => onOpenCommitReview?.(c.hash, c.shortHash, c.subject)}
                className="group relative flex items-center gap-2.5 pl-4 pr-3 py-1.5 hover:bg-panel-raised cursor-pointer"
              >
                {/* Tree line + dot */}
                <div className="relative shrink-0 w-3 self-stretch flex justify-center">
                  <div
                    className="absolute left-1/2 -translate-x-1/2 w-px bg-border-strong"
                    style={{ top: isFirst ? '50%' : 0, bottom: isLast ? '50%' : 0 }}
                  />
                  <div className={`relative z-10 self-center w-2 h-2 rounded-full transition-colors ${dotClass}`} />
                </div>
                <span className={`shrink-0 font-mono text-[10px] ${c.pushed ? 'text-faint' : 'text-warning'}`}>{c.shortHash}</span>
                <span className={`truncate min-w-0 flex-1 ${c.pushed ? 'text-dim' : 'text-fg'}`}>{c.subject}</span>
                {!c.pushed && (
                  <ArrowUp size={10} className="shrink-0 text-warning" />
                )}
              </div>
            </Tooltip>
          )
        })}
      </div>
    </RightPanel>
  )
}

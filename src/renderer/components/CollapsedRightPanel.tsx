import { PanelRightOpen, Code2, FolderOpen } from 'lucide-react'
import { Tooltip } from './Tooltip'
import { useActiveBackend } from '../store'
import { useBackend } from '../backend'

interface CollapsedRightPanelProps {
  worktreePath: string | null
  onExpand: () => void
}

const WIDTH = 48

export function CollapsedRightPanel({
  worktreePath,
  onExpand
}: CollapsedRightPanelProps): JSX.Element {
  const backend = useBackend()
  const activeBackend = useActiveBackend()
  const isLocal = activeBackend.kind === 'local'

  return (
    <div
      className="shrink-0 h-full flex flex-col bg-panel border-l border-border"
      style={{ width: WIDTH }}
    >
      <div className="no-drag flex flex-col items-center gap-1 py-1">
        <Tooltip label="Expand sidebar" action="toggleRightColumn" side="left">
          <button
            onClick={onExpand}
            className="text-dim hover:text-fg hover:bg-surface rounded p-1.5 transition-colors cursor-pointer"
            aria-label="Expand right column"
          >
            <PanelRightOpen className="icon-sm" />
          </button>
        </Tooltip>

        <div className="h-px w-6 bg-border my-1" />

        {worktreePath && (
          <Tooltip label="Open worktree in editor" action="openInEditor" side="left">
            <button
              onClick={() => backend.openInEditor(worktreePath)}
              className="text-dim hover:text-fg hover:bg-surface rounded p-1.5 transition-colors cursor-pointer"
              aria-label="Open worktree in editor"
            >
              <Code2 className="icon-sm" />
            </button>
          </Tooltip>
        )}
        {worktreePath && isLocal && (
          <Tooltip label="Reveal in Finder" side="left">
            <button
              onClick={() => backend.openPath(worktreePath)}
              className="text-dim hover:text-fg hover:bg-surface rounded p-1.5 transition-colors cursor-pointer"
              aria-label="Reveal worktree in Finder"
            >
              <FolderOpen className="icon-sm" />
            </button>
          </Tooltip>
        )}
      </div>
    </div>
  )
}

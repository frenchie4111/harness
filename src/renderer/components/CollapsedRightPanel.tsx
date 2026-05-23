import { PanelRightOpen } from 'lucide-react'
import { Tooltip } from './Tooltip'

interface CollapsedRightPanelProps {
  onExpand: () => void
}

function btnClass(): string {
  return 'rounded p-1.5 transition-colors cursor-pointer text-dim hover:text-fg hover:bg-surface'
}

function Divider(): JSX.Element {
  return <div className="w-6 h-px bg-border my-1 shrink-0" />
}

export function CollapsedRightPanel({ onExpand }: CollapsedRightPanelProps): JSX.Element {
  return (
    <div className="shrink-0 w-12 bg-panel border-l border-border flex flex-col items-center h-full">
      {/* Drag region at the top so the row aligns with the workspace's
          top bar height and the user can still drag the window from
          this column. */}
      <div className="drag-region h-10 w-full shrink-0" />

      <div className="flex flex-col items-center gap-0.5 py-1 shrink-0">
        <Tooltip label="Expand sidebar" action="toggleRightColumn" side="left">
          <button onClick={onExpand} className={btnClass()}>
            <PanelRightOpen size={14} />
          </button>
        </Tooltip>
      </div>

      <Divider />
    </div>
  )
}

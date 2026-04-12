import { useEffect, useRef, useCallback } from 'react'
import { X, Plus, Sparkles, Code2, SplitSquareHorizontal } from 'lucide-react'
import {
  SortableContext,
  horizontalListSortingStrategy,
  useSortable
} from '@dnd-kit/sortable'
import { useDroppable } from '@dnd-kit/core'
import { CSS } from '@dnd-kit/utilities'
import type { WorkspacePane, TerminalTab, PtyStatus } from '../types'
import { Tooltip } from './Tooltip'

interface TerminalPanelProps {
  worktreePath: string
  pane: WorkspacePane
  isFocused: boolean
  paneCount: number
  statuses: Record<string, PtyStatus>
  repoLabel: string
  branch: string
  registerSlot: (paneId: string, el: HTMLDivElement | null) => void
  onSelectTab: (tabId: string) => void
  onAddTab: () => void
  onAddClaudeTab: () => void
  onCloseTab: (tabId: string) => void
  onSplit: () => void
}

const TAB_STATUS_DOT: Record<PtyStatus, string> = {
  idle: 'bg-faint',
  processing: 'bg-success',
  waiting: 'bg-warning',
  'needs-approval': 'bg-danger'
}

interface SortableTabProps {
  tab: TerminalTab
  isActive: boolean
  status: PtyStatus
  showClose: boolean
  onSelect: () => void
  onClose: () => void
}

function SortableTab({ tab, isActive, status, showClose, onSelect, onClose }: SortableTabProps): JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: tab.id
  })
  const localRef = useRef<HTMLDivElement | null>(null)
  const setRefs = useCallback(
    (el: HTMLDivElement | null) => {
      localRef.current = el
      setNodeRef(el)
    },
    [setNodeRef]
  )
  useEffect(() => {
    if (isActive && localRef.current) {
      localRef.current.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    }
  }, [isActive])
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1
  }
  return (
    <div
      ref={setRefs}
      style={style}
      {...attributes}
      {...listeners}
      className={`no-drag shrink-0 flex items-center gap-1.5 px-3 h-full text-xs cursor-pointer border-b-2 whitespace-nowrap transition-colors ${
        isActive
          ? 'border-muted text-fg-bright'
          : 'border-transparent text-dim hover:text-fg'
      }`}
      onClick={onSelect}
    >
      {tab.type !== 'diff' && (
        <span className={`w-1.5 h-1.5 rounded-full ${TAB_STATUS_DOT[status]}`} />
      )}
      <span>{tab.label}</span>
      {showClose && (
        <Tooltip label="Close tab" action="closeTab">
          <button
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              onClose()
            }}
            className="ml-1 text-faint hover:text-fg transition-colors"
          >
            <X size={10} />
          </button>
        </Tooltip>
      )}
    </div>
  )
}

export function TerminalPanel({
  worktreePath,
  pane,
  paneCount,
  statuses,
  repoLabel,
  branch,
  registerSlot,
  onSelectTab,
  onAddTab,
  onAddClaudeTab,
  onCloseTab,
  onSplit
}: TerminalPanelProps): JSX.Element {
  // Droppable target for the pane itself — lets users drop a tab onto an
  // empty pane or past the last tab.
  const { setNodeRef: setPaneDropRef } = useDroppable({ id: pane.id })
  const slotRef = useRef<HTMLDivElement | null>(null)

  // Register the content slot div with WorkspaceView so it can portal
  // terminal content into this pane.
  useEffect(() => {
    registerSlot(pane.id, slotRef.current)
    return () => registerSlot(pane.id, null)
  }, [pane.id, registerSlot])

  return (
    <div ref={setPaneDropRef} className="flex-1 flex flex-col min-w-0 bg-app">
      {/* Tab bar */}
      <div className="drag-region flex items-center border-b border-border bg-panel h-10 shrink-0">
        <div
          className="no-drag shrink-0 flex items-baseline gap-1.5 px-3 h-full text-xs whitespace-nowrap"
          title={`${repoLabel} / ${branch}`}
          style={{ alignSelf: 'stretch', display: 'flex', alignItems: 'center' }}
        >
          <span className="text-dim font-medium">{repoLabel}</span>
          <span className="text-faint">/</span>
          <span className="text-fg-bright font-medium">{branch}</span>
        </div>
        <div className="flex items-center h-full overflow-x-auto scrollbar-hidden pl-2 flex-1 min-w-0">
          <SortableContext items={pane.tabs.map((t) => t.id)} strategy={horizontalListSortingStrategy}>
            {pane.tabs.map((tab) => (
              <SortableTab
                key={tab.id}
                tab={tab}
                isActive={tab.id === pane.activeTabId}
                status={statuses[tab.id] || 'idle'}
                showClose={pane.tabs.length > 1 || paneCount > 1}
                onSelect={() => onSelectTab(tab.id)}
                onClose={() => onCloseTab(tab.id)}
              />
            ))}
          </SortableContext>
          <Tooltip label="New Claude tab">
            <button
              onClick={onAddClaudeTab}
              className="no-drag shrink-0 px-2 h-full text-faint hover:text-fg text-sm transition-colors cursor-pointer"
            >
              <Sparkles size={12} />
            </button>
          </Tooltip>
          <Tooltip label="New shell tab" action="newShellTab">
            <button
              onClick={onAddTab}
              className="no-drag shrink-0 px-2 h-full text-faint hover:text-fg text-sm transition-colors cursor-pointer"
            >
              <Plus size={12} />
            </button>
          </Tooltip>
          <Tooltip label="Split pane right">
            <button
              onClick={onSplit}
              className="no-drag shrink-0 px-2 h-full text-faint hover:text-fg text-sm transition-colors cursor-pointer"
            >
              <SplitSquareHorizontal size={12} />
            </button>
          </Tooltip>
        </div>
        <Tooltip label="Open worktree in editor" action="openInEditor" side="left">
          <button
            onClick={() => window.api.openInEditor(worktreePath)}
            className="no-drag shrink-0 px-3 h-full text-faint hover:text-fg transition-colors cursor-pointer"
          >
            <Code2 size={13} />
          </button>
        </Tooltip>
      </div>

      {/* Content slot — terminals / diffs are portaled in by WorkspaceView */}
      <div ref={slotRef} className="flex-1 relative min-h-0" />
    </div>
  )
}

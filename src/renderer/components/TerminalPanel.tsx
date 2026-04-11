import { X, Plus, Sparkles, Code2 } from 'lucide-react'
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragEndEvent
} from '@dnd-kit/core'
import {
  SortableContext,
  horizontalListSortingStrategy,
  useSortable
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { TerminalTab, PtyStatus } from '../types'
import { XTerminal } from './XTerminal'
import { DiffView } from './DiffView'
import { Tooltip } from './Tooltip'

interface TerminalPanelProps {
  worktreePath: string
  tabs: TerminalTab[]
  activeTabId: string
  statuses: Record<string, PtyStatus>
  onSelectTab: (worktreePath: string, tabId: string) => void
  onAddTab: (worktreePath: string) => void
  onAddClaudeTab: (worktreePath: string) => void
  onCloseTab: (worktreePath: string, tabId: string) => void
  onRestartClaudeTab: (worktreePath: string, tabId: string) => void
  onReorderTabs: (worktreePath: string, fromId: string, toId: string) => void
  visible: boolean
  claudeCommand: string
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
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1
  }
  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={`no-drag flex items-center gap-1.5 px-3 h-full text-xs cursor-pointer border-b-2 transition-colors ${
        isActive
          ? 'border-muted text-fg-bright'
          : 'border-transparent text-dim hover:text-fg'
      }`}
      onClick={onSelect}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${TAB_STATUS_DOT[status]}`} />
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
  tabs,
  activeTabId,
  statuses,
  onSelectTab,
  onAddTab,
  onAddClaudeTab,
  onCloseTab,
  onRestartClaudeTab,
  onReorderTabs,
  visible,
  claudeCommand
}: TerminalPanelProps): JSX.Element {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } })
  )

  const handleDragEnd = (event: DragEndEvent): void => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    onReorderTabs(worktreePath, String(active.id), String(over.id))
  }

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-app">
      {/* Tab bar */}
      <div className="drag-region flex items-center border-b border-border bg-panel h-10 shrink-0">
        <div className="no-drag flex items-center h-full overflow-x-auto pl-2 flex-1 min-w-0">
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={tabs.map((t) => t.id)} strategy={horizontalListSortingStrategy}>
              {tabs.map((tab) => (
                <SortableTab
                  key={tab.id}
                  tab={tab}
                  isActive={tab.id === activeTabId}
                  status={statuses[tab.id] || 'idle'}
                  showClose={tabs.length > 1}
                  onSelect={() => onSelectTab(worktreePath, tab.id)}
                  onClose={() => onCloseTab(worktreePath, tab.id)}
                />
              ))}
            </SortableContext>
          </DndContext>
          <Tooltip label="New Claude tab">
            <button
              onClick={() => onAddClaudeTab(worktreePath)}
              className="no-drag px-2 h-full text-faint hover:text-fg text-sm transition-colors cursor-pointer"
            >
              <Sparkles size={12} />
            </button>
          </Tooltip>
          <Tooltip label="New shell tab" action="newShellTab">
            <button
              onClick={() => onAddTab(worktreePath)}
              className="no-drag px-2 h-full text-faint hover:text-fg text-sm transition-colors cursor-pointer"
            >
              <Plus size={12} />
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

      {/* Terminal / diff area */}
      <div className="flex-1 relative min-h-0">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className="absolute inset-0"
            style={{ display: tab.id === activeTabId ? 'block' : 'none' }}
          >
            {tab.type === 'diff' ? (
              <DiffView
                worktreePath={worktreePath}
                filePath={tab.filePath}
                staged={tab.staged ?? false}
                branchDiff={tab.branchDiff ?? false}
                commitHash={tab.commitHash}
              />
            ) : (
              <XTerminal
                terminalId={tab.id}
                cwd={worktreePath}
                type={tab.type}
                visible={visible && tab.id === activeTabId}
                claudeCommand={claudeCommand}
                sessionId={tab.sessionId}
                initialPrompt={tab.initialPrompt}
                onRestartClaude={
                  tab.type === 'claude'
                    ? () => onRestartClaudeTab(worktreePath, tab.id)
                    : undefined
                }
              />
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

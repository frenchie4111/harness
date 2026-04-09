import { X, Plus } from 'lucide-react'
import type { TerminalTab, PtyStatus } from '../types'
import { XTerminal } from './XTerminal'
import { DiffView } from './DiffView'

interface TerminalPanelProps {
  worktreePath: string
  tabs: TerminalTab[]
  activeTabId: string
  statuses: Record<string, PtyStatus>
  onSelectTab: (worktreePath: string, tabId: string) => void
  onAddTab: (worktreePath: string) => void
  onCloseTab: (worktreePath: string, tabId: string) => void
  visible: boolean
}

const TAB_STATUS_DOT: Record<PtyStatus, string> = {
  idle: 'bg-neutral-600',
  processing: 'bg-green-500',
  waiting: 'bg-amber-400',
  'needs-approval': 'bg-red-500'
}

export function TerminalPanel({
  worktreePath,
  tabs,
  activeTabId,
  statuses,
  onSelectTab,
  onAddTab,
  onCloseTab,
  visible
}: TerminalPanelProps): JSX.Element {
  return (
    <div className="flex-1 flex flex-col min-w-0 bg-[#0a0a0a]">
      {/* Tab bar */}
      <div className="drag-region flex items-center border-b border-neutral-800 bg-neutral-950 h-10 shrink-0">
        <div className="no-drag flex items-center h-full overflow-x-auto pl-2">
          {tabs.map((tab) => {
            const status = statuses[tab.id] || 'idle'
            const isActive = tab.id === activeTabId
            return (
              <div
                key={tab.id}
                className={`flex items-center gap-1.5 px-3 h-full text-xs cursor-pointer border-b-2 transition-colors ${
                  isActive
                    ? 'border-neutral-400 text-neutral-200'
                    : 'border-transparent text-neutral-500 hover:text-neutral-300'
                }`}
                onClick={() => onSelectTab(worktreePath, tab.id)}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${TAB_STATUS_DOT[status]}`} />
                <span>{tab.label}</span>
                {tabs.length > 1 && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      onCloseTab(worktreePath, tab.id)
                    }}
                    className="ml-1 text-neutral-600 hover:text-neutral-300 transition-colors"
                  >
                    <X size={10} />
                  </button>
                )}
              </div>
            )
          })}
          <button
            onClick={() => onAddTab(worktreePath)}
            className="no-drag px-2 h-full text-neutral-600 hover:text-neutral-300 text-sm transition-colors"
            title="New shell tab"
          >
            <Plus size={12} />
          </button>
        </div>
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
                filePath={tab.filePath!}
                staged={tab.staged ?? false}
              />
            ) : (
              <XTerminal
                terminalId={tab.id}
                cwd={worktreePath}
                type={tab.type}
                visible={visible && tab.id === activeTabId}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

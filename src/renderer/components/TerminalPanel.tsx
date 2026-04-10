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
  claudeCommand: string
}

const TAB_STATUS_DOT: Record<PtyStatus, string> = {
  idle: 'bg-faint',
  processing: 'bg-success',
  waiting: 'bg-warning',
  'needs-approval': 'bg-danger'
}

export function TerminalPanel({
  worktreePath,
  tabs,
  activeTabId,
  statuses,
  onSelectTab,
  onAddTab,
  onCloseTab,
  visible,
  claudeCommand
}: TerminalPanelProps): JSX.Element {
  return (
    <div className="flex-1 flex flex-col min-w-0 bg-app">
      {/* Tab bar */}
      <div className="drag-region flex items-center border-b border-border bg-panel h-10 shrink-0">
        <div className="no-drag flex items-center h-full overflow-x-auto pl-2">
          {tabs.map((tab) => {
            const status = statuses[tab.id] || 'idle'
            const isActive = tab.id === activeTabId
            return (
              <div
                key={tab.id}
                className={`flex items-center gap-1.5 px-3 h-full text-xs cursor-pointer border-b-2 transition-colors ${
                  isActive
                    ? 'border-muted text-fg-bright'
                    : 'border-transparent text-dim hover:text-fg'
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
                    className="ml-1 text-faint hover:text-fg transition-colors"
                  >
                    <X size={10} />
                  </button>
                )}
              </div>
            )
          })}
          <button
            onClick={() => onAddTab(worktreePath)}
            className="no-drag px-2 h-full text-faint hover:text-fg text-sm transition-colors"
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
                claudeCommand={claudeCommand}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

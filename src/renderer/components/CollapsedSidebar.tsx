import {
  PanelLeftOpen,
  FolderOpen,
  Plus,
  Trash2,
  LayoutGrid,
  FilePlus,
  BarChart3,
  CalendarDays,
  MessageSquare,
  Keyboard,
  Settings as SettingsIcon
} from 'lucide-react'
import { openReportIssue } from './ReportIssueScreen'
import { Tooltip } from './Tooltip'

interface CollapsedSidebarProps {
  onExpand: () => void
  onAddRepo: () => void
  onNewWorktree: () => void
  onOpenCleanup: () => void
  onOpenCommandCenter: () => void
  onOpenNewProject: () => void
  onOpenActivity: () => void
  onOpenMyWeek: () => void
  onOpenHotkeyCheatsheet: () => void
  onOpenSettings: () => void
}

const WIDTH = 48

export function CollapsedSidebar({
  onExpand,
  onAddRepo,
  onNewWorktree,
  onOpenCleanup,
  onOpenCommandCenter,
  onOpenNewProject,
  onOpenActivity,
  onOpenMyWeek,
  onOpenHotkeyCheatsheet,
  onOpenSettings
}: CollapsedSidebarProps): JSX.Element {
  return (
    <div
      className="shrink-0 bg-panel flex flex-col h-full border-r border-border"
      style={{ width: WIDTH }}
    >
      <div className="no-drag flex flex-col items-center gap-1 py-1">
        <Tooltip label="Expand sidebar" action="toggleSidebar" side="right">
          <button
            onClick={onExpand}
            className="text-dim hover:text-fg hover:bg-surface rounded p-1.5 transition-colors cursor-pointer"
            aria-label="Expand sidebar"
          >
            <PanelLeftOpen className="icon-sm" />
          </button>
        </Tooltip>

        <div className="h-px w-6 bg-border my-1" />

        <Tooltip label="Add repository" side="right">
          <button
            onClick={onAddRepo}
            className="text-dim hover:text-fg hover:bg-surface rounded p-1.5 transition-colors cursor-pointer"
          >
            <FolderOpen className="icon-sm" />
          </button>
        </Tooltip>
        <Tooltip label="Add worktree" action="newWorktree" side="right">
          <button
            onClick={onNewWorktree}
            className="text-dim hover:text-fg hover:bg-surface rounded p-1.5 transition-colors cursor-pointer"
          >
            <Plus className="icon-sm" />
          </button>
        </Tooltip>
        <Tooltip label="Clean up old worktrees" side="right">
          <button
            onClick={onOpenCleanup}
            className="text-dim hover:text-fg hover:bg-surface rounded p-1.5 transition-colors cursor-pointer"
          >
            <Trash2 className="icon-sm" />
          </button>
        </Tooltip>
      </div>

      <div className="flex-1" />

      <div className="no-drag flex flex-col items-center gap-1 py-1">
        <Tooltip label="Command Center" action="toggleCommandCenter" side="right">
          <button
            onClick={onOpenCommandCenter}
            className="text-dim hover:text-fg hover:bg-surface rounded p-1.5 transition-colors cursor-pointer"
          >
            <LayoutGrid className="icon-sm" />
          </button>
        </Tooltip>
        <Tooltip label="New project" side="right">
          <button
            onClick={onOpenNewProject}
            className="text-dim hover:text-fg hover:bg-surface rounded p-1.5 transition-colors cursor-pointer"
          >
            <FilePlus className="icon-sm" />
          </button>
        </Tooltip>
        <Tooltip label="Activity" side="right">
          <button
            onClick={onOpenActivity}
            className="text-dim hover:text-fg hover:bg-surface rounded p-1.5 transition-colors cursor-pointer"
          >
            <BarChart3 className="icon-sm" />
          </button>
        </Tooltip>
        <Tooltip label="My week" side="right">
          <button
            onClick={onOpenMyWeek}
            className="text-dim hover:text-fg hover:bg-surface rounded p-1.5 transition-colors cursor-pointer"
          >
            <CalendarDays className="icon-sm" />
          </button>
        </Tooltip>
        <Tooltip label="Keyboard shortcuts" action="hotkeyCheatsheet" side="right">
          <button
            onClick={onOpenHotkeyCheatsheet}
            className="text-dim hover:text-fg hover:bg-surface rounded p-1.5 transition-colors cursor-pointer"
          >
            <Keyboard className="icon-sm" />
          </button>
        </Tooltip>
        <Tooltip label="Report an issue / request a feature / submit a suggestion" side="right">
          <button
            onClick={() => openReportIssue()}
            className="text-dim hover:text-fg hover:bg-surface rounded p-1.5 transition-colors cursor-pointer"
          >
            <MessageSquare className="icon-sm" />
          </button>
        </Tooltip>
        <Tooltip label="Settings" side="right">
          <button
            onClick={onOpenSettings}
            className="text-dim hover:text-fg hover:bg-surface rounded p-1.5 transition-colors cursor-pointer"
          >
            <SettingsIcon className="icon-sm" />
          </button>
        </Tooltip>
      </div>
    </div>
  )
}

import {
  PanelLeftOpen,
  FolderOpen,
  Plus,
  Trash2,
  LayoutGrid,
  FolderPlus,
  BarChart3,
  CalendarDays,
  MessageSquare,
  Keyboard,
  Settings as SettingsIcon,
  BookOpen
} from 'lucide-react'
import { Tooltip } from './Tooltip'

// Mirrors App.tsx's OverlayName — duplicated rather than exported because
// the App-level definition is a function-scoped type. Keep in sync if the
// overlay enum changes.
type OverlayName =
  | 'commandCenter'
  | 'activity'
  | 'myWeek'
  | 'hotkeys'
  | 'reportIssue'
  | 'settings'
  | 'cleanup'
  | 'newWorktree'
  | 'newProject'
  | 'review'
  | 'guide'
  | 'addBackend'

interface CollapsedSidebarProps {
  onExpand: () => void
  onAddRepo: () => void
  /** Open the new-worktree screen. The collapsed toolbar can't know which
   *  repo the user wants, so this is always called without a repoRoot. */
  onNewWorktree: () => void
  onOpenCleanup: () => void
  onOpenCommandCenter: () => void
  onOpenNewProject: () => void
  onOpenActivity: () => void
  onOpenMyWeek: () => void
  onOpenReportIssue: () => void
  onOpenWorktreeGuide: () => void
  onOpenHotkeyCheatsheet: () => void
  onOpenSettings: () => void
  activeOverlay: OverlayName | null
}

function btnClass(active: boolean): string {
  const base = 'rounded p-1.5 transition-colors cursor-pointer'
  return active
    ? `${base} text-accent bg-surface`
    : `${base} text-dim hover:text-fg hover:bg-surface`
}

function Divider(): JSX.Element {
  return <div className="w-6 h-px bg-border my-1 shrink-0" />
}

export function CollapsedSidebar({
  onExpand,
  onAddRepo,
  onNewWorktree,
  onOpenCleanup,
  onOpenCommandCenter,
  onOpenNewProject,
  onOpenActivity,
  onOpenMyWeek,
  onOpenReportIssue,
  onOpenWorktreeGuide,
  onOpenHotkeyCheatsheet,
  onOpenSettings,
  activeOverlay
}: CollapsedSidebarProps): JSX.Element {
  return (
    <div className="shrink-0 w-12 bg-panel border-r border-border flex flex-col items-center h-full">
      {/* Drag region reserves space for the macOS traffic lights. The
          collapsed-sidebar buttons start below it so they don't sit
          underneath the close/minimize/maximize controls. */}
      <div className="drag-region h-10 w-full shrink-0" />

      <div className="flex flex-col items-center gap-0.5 py-1 shrink-0">
        <Tooltip label="Expand sidebar" action="toggleSidebar" side="right">
          <button onClick={onExpand} className={btnClass(false)}>
            <PanelLeftOpen className="w-3.5 h-3.5" />
          </button>
        </Tooltip>
      </div>

      <Divider />

      <div className="flex flex-col items-center gap-0.5 py-1 shrink-0">
        <Tooltip label="Add repository" side="right">
          <button onClick={onAddRepo} className={btnClass(false)}>
            <FolderOpen className="w-3.5 h-3.5" />
          </button>
        </Tooltip>
        <Tooltip label="Add worktree" action="newWorktree" side="right">
          <button
            onClick={onNewWorktree}
            className={btnClass(activeOverlay === 'newWorktree')}
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
        </Tooltip>
        <Tooltip label="Clean up old worktrees" side="right">
          <button
            onClick={onOpenCleanup}
            className={btnClass(activeOverlay === 'cleanup')}
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </Tooltip>
      </div>

      <Divider />

      <div className="flex flex-col items-center gap-0.5 py-1 shrink-0">
        <Tooltip label="Command Center" action="toggleCommandCenter" side="right">
          <button
            onClick={onOpenCommandCenter}
            className={btnClass(activeOverlay === 'commandCenter')}
          >
            <LayoutGrid className="w-3.5 h-3.5" />
          </button>
        </Tooltip>
        <Tooltip label="New project" side="right">
          <button
            onClick={onOpenNewProject}
            className={btnClass(activeOverlay === 'newProject')}
          >
            <FolderPlus className="w-3.5 h-3.5" />
          </button>
        </Tooltip>
        <Tooltip label="Activity" side="right">
          <button
            onClick={onOpenActivity}
            className={btnClass(activeOverlay === 'activity')}
          >
            <BarChart3 className="w-3.5 h-3.5" />
          </button>
        </Tooltip>
        <Tooltip label="My week" side="right">
          <button
            onClick={onOpenMyWeek}
            className={btnClass(activeOverlay === 'myWeek')}
          >
            <CalendarDays className="w-3.5 h-3.5" />
          </button>
        </Tooltip>
        <Tooltip label="Report an issue / request a feature" side="right">
          <button
            onClick={onOpenReportIssue}
            className={btnClass(activeOverlay === 'reportIssue')}
          >
            <MessageSquare className="w-3.5 h-3.5" />
          </button>
        </Tooltip>
        <Tooltip label="Worktree Guide" side="right">
          <button
            onClick={onOpenWorktreeGuide}
            className={btnClass(activeOverlay === 'guide')}
          >
            <BookOpen className="w-3.5 h-3.5" />
          </button>
        </Tooltip>
        <Tooltip label="Keyboard shortcuts" action="hotkeyCheatsheet" side="right">
          <button
            onClick={onOpenHotkeyCheatsheet}
            className={btnClass(activeOverlay === 'hotkeys')}
          >
            <Keyboard className="w-3.5 h-3.5" />
          </button>
        </Tooltip>
        <Tooltip label="Settings" action="openSettings" side="right">
          <button
            onClick={onOpenSettings}
            className={btnClass(activeOverlay === 'settings')}
          >
            <SettingsIcon className="w-3.5 h-3.5" />
          </button>
        </Tooltip>
      </div>
    </div>
  )
}

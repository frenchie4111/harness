// Icon components for tool cards. Built-in Claude tools (Read, Edit, …)
// reuse lucide; MCP brand logos come from react-icons/si (the Simple
// Icons family). The Harness mark is hand-drawn since Harness isn't in
// Simple Icons — replicates the dot grid from resources/icon.png.

import type { ComponentType } from 'react'
import {
  AlarmClock,
  Bell,
  Bot,
  CalendarClock,
  Database,
  FilePen,
  FilePlus,
  FileText,
  FolderSearch,
  FolderTree,
  Globe,
  ListChecks,
  MessageCircleQuestion,
  Notebook,
  Octagon,
  ScrollText,
  Search,
  Sparkles,
  Terminal,
  Wrench,
  Zap
} from 'lucide-react'
import {
  SiGmail,
  SiGooglecalendar,
  SiGoogledrive,
  SiNotion,
  SiSlack
} from 'react-icons/si'

export type ToolIcon = ComponentType<{ className?: string }>

// Built-in Claude tools — lucide. Each is a thin wrapper so the
// registry lookup returns a uniform `(className) => element` shape.

export const ReadIcon: ToolIcon = ({ className }) => <FileText className={className} />
export const EditIcon: ToolIcon = ({ className }) => <FilePen className={className} />
export const WriteIcon: ToolIcon = ({ className }) => <FilePlus className={className} />
export const BashIcon: ToolIcon = ({ className }) => <Terminal className={className} />
export const GrepIcon: ToolIcon = ({ className }) => <Search className={className} />
export const GlobIcon: ToolIcon = ({ className }) => <FolderSearch className={className} />
export const TodoIcon: ToolIcon = ({ className }) => <ListChecks className={className} />
export const TaskIcon: ToolIcon = ({ className }) => <Bot className={className} />
export const WebIcon: ToolIcon = ({ className }) => <Globe className={className} />
export const ToolSearchIcon: ToolIcon = ({ className }) => <Wrench className={className} />
export const SkillIcon: ToolIcon = ({ className }) => <Sparkles className={className} />
export const AlarmIcon: ToolIcon = ({ className }) => <AlarmClock className={className} />
export const CronIcon: ToolIcon = ({ className }) => <CalendarClock className={className} />
export const AskIcon: ToolIcon = ({ className }) => <MessageCircleQuestion className={className} />
export const WorktreeIcon: ToolIcon = ({ className }) => <FolderTree className={className} />
export const NotebookIcon: ToolIcon = ({ className }) => <Notebook className={className} />
export const BellIcon: ToolIcon = ({ className }) => <Bell className={className} />
export const TriggerIcon: ToolIcon = ({ className }) => <Zap className={className} />
export const TaskOutputIcon: ToolIcon = ({ className }) => <ScrollText className={className} />
export const TaskStopIcon: ToolIcon = ({ className }) => <Octagon className={className} />
export const McpResourceIcon: ToolIcon = ({ className }) => <Database className={className} />

// Brand icons — Simple Icons via react-icons. Brand-canonical colors
// where they read in both light and dark themes; currentColor (text
// color) for Notion since its canonical black/white logo would
// disappear against the chrome background.

const brand = (
  Icon: ComponentType<{ className?: string; color?: string }>,
  color?: string
): ToolIcon =>
  function BrandIcon({ className }: { className?: string }) {
    return <Icon className={className} color={color} />
  }

export const NotionIcon = brand(SiNotion)
export const SlackIcon = brand(SiSlack, '#E01E5A')
export const GmailIcon = brand(SiGmail, '#EA4335')
export const DriveIcon = brand(SiGoogledrive, '#34A853')
export const CalendarIcon = brand(SiGooglecalendar, '#4285F4')

// Harness mark — 3×3 dot grid on a dark rounded-square, gray→amber→green
// gradient direction mirrors resources/icon.png.
export const HarnessIcon: ToolIcon = ({ className }) => (
  <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
    <rect width="24" height="24" rx="4" fill="#0A0A0A" />
    <circle cx="6" cy="6" r="2" fill="#6B7280" />
    <circle cx="12" cy="6" r="2" fill="#6B7280" />
    <circle cx="18" cy="6" r="2" fill="#F59E0B" />
    <circle cx="6" cy="12" r="2" fill="#6B7280" />
    <circle cx="12" cy="12" r="2" fill="#F59E0B" />
    <circle cx="18" cy="12" r="2" fill="#10B981" />
    <circle cx="6" cy="18" r="2" fill="#F59E0B" />
    <circle cx="12" cy="18" r="2" fill="#10B981" />
    <circle cx="18" cy="18" r="2" fill="#10B981" />
  </svg>
)

// Generic MCP fallback — plug shape, no brand association.
export const McpGenericIcon: ToolIcon = ({ className }) => (
  <svg
    viewBox="0 0 24 24"
    className={className}
    aria-hidden="true"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M9 3v4 M15 3v4" />
    <rect x="6" y="7" width="12" height="6" rx="1" />
    <path d="M12 13v4 M9 17h6" />
  </svg>
)

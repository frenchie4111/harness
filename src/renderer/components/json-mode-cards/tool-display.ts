// Tool-name pretty-printing + icon lookup. Built-in Claude tools get
// fixed labels and lucide icons; MCP tools (mcp__<server>__<tool>) are
// parsed and rendered as "Server · action" with a brand icon when we
// have one. Harness-control is special-cased — the brand-gradient
// chrome already implies "this is a Harness tool", so we drop the
// "Harness" prefix from the label.

import {
  AlarmIcon,
  AskIcon,
  BashIcon,
  BellIcon,
  CalendarIcon,
  CronIcon,
  DriveIcon,
  EditIcon,
  GlobIcon,
  GmailIcon,
  GrepIcon,
  HarnessIcon,
  McpGenericIcon,
  McpResourceIcon,
  NotebookIcon,
  NotionIcon,
  ReadIcon,
  SkillIcon,
  SlackIcon,
  TaskIcon,
  TaskOutputIcon,
  TaskStopIcon,
  TodoIcon,
  ToolSearchIcon,
  TriggerIcon,
  WebIcon,
  WorktreeIcon,
  WriteIcon,
  type ToolIcon
} from './tool-icons'

const HARNESS_CONTROL_PREFIX = 'mcp__harness-control__'
const MCP_PREFIX = 'mcp__'

export interface ToolDisplay {
  /** Pretty label for the card header (or group summary). */
  label: string
  /** Brand/category icon, or null for built-ins without one. */
  icon: ToolIcon | null
}

const BUILTIN_ICONS: Record<string, ToolIcon> = {
  Read: ReadIcon,
  Edit: EditIcon,
  MultiEdit: EditIcon,
  Write: WriteIcon,
  Bash: BashIcon,
  Grep: GrepIcon,
  Glob: GlobIcon,
  TodoWrite: TodoIcon,
  Task: TaskIcon,
  Agent: TaskIcon,
  WebFetch: WebIcon,
  WebSearch: WebIcon,
  ToolSearch: ToolSearchIcon,
  Skill: SkillIcon,
  NotebookEdit: NotebookIcon,
  AskUserQuestion: AskIcon,
  ScheduleWakeup: AlarmIcon,
  CronCreate: CronIcon,
  CronList: CronIcon,
  CronDelete: CronIcon,
  EnterWorktree: WorktreeIcon,
  ExitWorktree: WorktreeIcon,
  EnterPlanMode: TodoIcon,
  ExitPlanMode: TodoIcon,
  PushNotification: BellIcon,
  RemoteTrigger: TriggerIcon,
  TaskOutput: TaskOutputIcon,
  TaskStop: TaskStopIcon,
  ListMcpResourcesTool: McpResourceIcon,
  ReadMcpResourceTool: McpResourceIcon
}

interface McpBrand {
  label: string
  icon: ToolIcon
  /** Optional alternate prefixes the tool name might carry that should
   *  be stripped (e.g. notion-get-users → get users). */
  toolPrefixes?: string[]
}

const MCP_BRANDS: Record<string, McpBrand> = {
  'claude_ai_Notion': {
    label: 'Notion',
    icon: NotionIcon,
    toolPrefixes: ['notion']
  },
  notion: {
    label: 'Notion',
    icon: NotionIcon,
    toolPrefixes: ['notion']
  },
  'claude_ai_Slack': {
    label: 'Slack',
    icon: SlackIcon,
    toolPrefixes: ['slack']
  },
  'claude_ai_Gmail': {
    label: 'Gmail',
    icon: GmailIcon,
    toolPrefixes: ['gmail']
  },
  'claude_ai_Google_Drive': {
    label: 'Google Drive',
    icon: DriveIcon,
    toolPrefixes: ['drive', 'google_drive']
  },
  'claude_ai_Google_Calendar': {
    label: 'Google Calendar',
    icon: CalendarIcon,
    toolPrefixes: ['calendar', 'google_calendar']
  },
  'harness-control': {
    label: 'Harness',
    icon: HarnessIcon
  }
}

interface ParsedMcp {
  server: string
  tool: string
}

export function parseMcpToolName(name: string | undefined): ParsedMcp | null {
  if (!name || !name.startsWith(MCP_PREFIX)) return null
  const rest = name.slice(MCP_PREFIX.length)
  const sep = rest.indexOf('__')
  if (sep <= 0 || sep === rest.length - 2) return null
  return { server: rest.slice(0, sep), tool: rest.slice(sep + 2) }
}

export function isHarnessControl(name: string | undefined): boolean {
  return !!name && name.startsWith(HARNESS_CONTROL_PREFIX)
}

function humanizeAction(tool: string, prefixes: string[]): string {
  let cleaned = tool
  const lower = cleaned.toLowerCase()
  for (const p of prefixes) {
    if (lower.startsWith(p + '-') || lower.startsWith(p + '_')) {
      cleaned = cleaned.slice(p.length + 1)
      break
    }
  }
  return cleaned.replace(/[_-]+/g, ' ').trim()
}

function titleCaseServer(server: string): string {
  return server
    .replace(/^claude_ai_/, '')
    .replace(/[_-]+/g, ' ')
    .trim()
}

export function getToolDisplay(name: string | undefined): ToolDisplay {
  if (!name) return { label: 'Tool', icon: null }

  const parsed = parseMcpToolName(name)
  if (!parsed) {
    return { label: name, icon: BUILTIN_ICONS[name] ?? null }
  }

  const brand = MCP_BRANDS[parsed.server]
  if (brand) {
    const action = humanizeAction(parsed.tool, brand.toolPrefixes ?? [])
    // For harness-control the brand-gradient chrome already says
    // "Harness", so dropping the label removes the redundancy.
    const label =
      parsed.server === 'harness-control' ? action : `${brand.label} · ${action}`
    return { label, icon: brand.icon }
  }

  const serverLabel = titleCaseServer(parsed.server)
  const action = humanizeAction(parsed.tool, [parsed.server])
  return { label: `${serverLabel} · ${action}`, icon: McpGenericIcon }
}

// Back-compat shim — earlier code called prettyToolName(name) to get
// the string only. Kept so callsites that don't need the icon stay
// terse.
export function prettyToolName(name: string | undefined): string {
  return getToolDisplay(name).label
}

// Tool-name pretty-printing + icon lookup. Built-in Claude tools get
// fixed labels and lucide icons; MCP tools (mcp__<server>__<tool>) are
// parsed, server name normalized (strip claude_ai_ prefix, lowercase,
// drop separators), then matched against the brand registry to render
// as "Brand · action" with a brand icon when we have one.
//
// Harness-control is special-cased — the brand-gradient chrome already
// implies "this is a Harness tool", so we drop the "Harness" prefix
// from the label.

import {
  AlarmIcon,
  AnthropicIcon,
  AsanaIcon,
  AskIcon,
  BashIcon,
  BellIcon,
  BitbucketIcon,
  BlueskyIcon,
  BraveIcon,
  CalendarIcon,
  ClickupIcon,
  CloudflareIcon,
  CloudinaryIcon,
  ConfluenceIcon,
  CronIcon,
  DiscordIcon,
  DriveIcon,
  EditIcon,
  ElasticIcon,
  FigmaIcon,
  FirebaseIcon,
  GithubIcon,
  GitlabIcon,
  GlobIcon,
  GmailIcon,
  GrepIcon,
  HarnessIcon,
  HubspotIcon,
  HuggingfaceIcon,
  IntercomIcon,
  JiraIcon,
  LinearIcon,
  MailchimpIcon,
  McpGenericIcon,
  McpResourceIcon,
  MongoIcon,
  MysqlIcon,
  NetlifyIcon,
  NotebookIcon,
  NotionIcon,
  OpenaiIcon,
  PaypalIcon,
  PerplexityIcon,
  PostgresIcon,
  ReadIcon,
  RedditIcon,
  RedisIcon,
  SalesforceIcon,
  SentryIcon,
  ShopifyIcon,
  SkillIcon,
  SlackIcon,
  SnowflakeIcon,
  SpotifyIcon,
  SqliteIcon,
  StripeIcon,
  SupabaseIcon,
  TaskIcon,
  TaskOutputIcon,
  TaskStopIcon,
  TelegramIcon,
  TodoIcon,
  ToolSearchIcon,
  TrelloIcon,
  TriggerIcon,
  TwilioIcon,
  VercelIcon,
  WebIcon,
  WhatsappIcon,
  WorktreeIcon,
  WriteIcon,
  XIcon,
  YoutubeIcon,
  ZendeskIcon,
  ZoomIcon,
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
}

// Keyed by normalized server name (see `normalizeServerName`). Same
// brand can appear under multiple MCP server names depending on who
// packaged it (e.g. `github`, `claude_ai_GitHub`, `gh`), and the
// normalization step collapses those to one key so we don't have to
// list each spelling.
const MCP_BRANDS: Record<string, McpBrand> = {
  // Harness — kept here for completeness even though it's special-cased
  // (brand gradient implies it, so the label drops the "Harness · " bit).
  harnesscontrol: { label: 'Harness', icon: HarnessIcon },

  // Anthropic-hosted / first-party
  notion: { label: 'Notion', icon: NotionIcon },
  slack: { label: 'Slack', icon: SlackIcon },
  gmail: { label: 'Gmail', icon: GmailIcon },
  googledrive: { label: 'Google Drive', icon: DriveIcon },
  drive: { label: 'Google Drive', icon: DriveIcon },
  googlecalendar: { label: 'Google Calendar', icon: CalendarIcon },
  calendar: { label: 'Google Calendar', icon: CalendarIcon },

  // Dev & code
  github: { label: 'GitHub', icon: GithubIcon },
  gh: { label: 'GitHub', icon: GithubIcon },
  gitlab: { label: 'GitLab', icon: GitlabIcon },
  bitbucket: { label: 'Bitbucket', icon: BitbucketIcon },
  linear: { label: 'Linear', icon: LinearIcon },
  jira: { label: 'Jira', icon: JiraIcon },
  atlassian: { label: 'Atlassian', icon: JiraIcon },
  confluence: { label: 'Confluence', icon: ConfluenceIcon },
  sentry: { label: 'Sentry', icon: SentryIcon },
  vercel: { label: 'Vercel', icon: VercelIcon },
  netlify: { label: 'Netlify', icon: NetlifyIcon },
  cloudflare: { label: 'Cloudflare', icon: CloudflareIcon },
  supabase: { label: 'Supabase', icon: SupabaseIcon },
  firebase: { label: 'Firebase', icon: FirebaseIcon },

  // Databases
  postgres: { label: 'Postgres', icon: PostgresIcon },
  postgresql: { label: 'Postgres', icon: PostgresIcon },
  mysql: { label: 'MySQL', icon: MysqlIcon },
  mongo: { label: 'MongoDB', icon: MongoIcon },
  mongodb: { label: 'MongoDB', icon: MongoIcon },
  redis: { label: 'Redis', icon: RedisIcon },
  sqlite: { label: 'SQLite', icon: SqliteIcon },
  snowflake: { label: 'Snowflake', icon: SnowflakeIcon },
  elasticsearch: { label: 'Elasticsearch', icon: ElasticIcon },
  elastic: { label: 'Elasticsearch', icon: ElasticIcon },

  // Communication
  discord: { label: 'Discord', icon: DiscordIcon },
  telegram: { label: 'Telegram', icon: TelegramIcon },
  whatsapp: { label: 'WhatsApp', icon: WhatsappIcon },
  zoom: { label: 'Zoom', icon: ZoomIcon },
  mailchimp: { label: 'Mailchimp', icon: MailchimpIcon },
  twilio: { label: 'Twilio', icon: TwilioIcon },
  intercom: { label: 'Intercom', icon: IntercomIcon },

  // Productivity
  asana: { label: 'Asana', icon: AsanaIcon },
  trello: { label: 'Trello', icon: TrelloIcon },
  clickup: { label: 'ClickUp', icon: ClickupIcon },

  // Commerce & finance
  stripe: { label: 'Stripe', icon: StripeIcon },
  paypal: { label: 'PayPal', icon: PaypalIcon },
  shopify: { label: 'Shopify', icon: ShopifyIcon },
  hubspot: { label: 'HubSpot', icon: HubspotIcon },
  salesforce: { label: 'Salesforce', icon: SalesforceIcon },
  zendesk: { label: 'Zendesk', icon: ZendeskIcon },

  // AI & search
  openai: { label: 'OpenAI', icon: OpenaiIcon },
  huggingface: { label: 'Hugging Face', icon: HuggingfaceIcon },
  hf: { label: 'Hugging Face', icon: HuggingfaceIcon },
  perplexity: { label: 'Perplexity', icon: PerplexityIcon },
  brave: { label: 'Brave', icon: BraveIcon },
  bravesearch: { label: 'Brave Search', icon: BraveIcon },
  anthropic: { label: 'Anthropic', icon: AnthropicIcon },

  // Media & social
  figma: { label: 'Figma', icon: FigmaIcon },
  spotify: { label: 'Spotify', icon: SpotifyIcon },
  youtube: { label: 'YouTube', icon: YoutubeIcon },
  reddit: { label: 'Reddit', icon: RedditIcon },
  x: { label: 'X', icon: XIcon },
  twitter: { label: 'X', icon: XIcon },
  bluesky: { label: 'Bluesky', icon: BlueskyIcon },
  cloudinary: { label: 'Cloudinary', icon: CloudinaryIcon }
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

/** Collapse the many spellings the same brand can ship under (e.g.
 *  `GitHub`, `github`, `claude_ai_GitHub`) into one registry key. Drops
 *  the `claude_ai_` prefix Anthropic uses for hosted connectors,
 *  lowercases, and strips underscores/dashes/spaces. */
export function normalizeServerName(server: string): string {
  return server
    .replace(/^claude_ai_/i, '')
    .toLowerCase()
    .replace(/[_\-\s]+/g, '')
}

function humanizeAction(tool: string, prefixes: string[]): string {
  let cleaned = tool
  const lower = cleaned.toLowerCase()
  for (const p of prefixes) {
    if (!p) continue
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

  const normalized = normalizeServerName(parsed.server)
  const brand = MCP_BRANDS[normalized]
  if (brand) {
    // Strip both the normalized brand key and the raw server name as
    // tool prefixes (many MCP authors namespace their tools, e.g.
    // `notion-get-users`, `slack_send_message`, `github-create-issue`).
    const action = humanizeAction(parsed.tool, [
      normalized,
      parsed.server.toLowerCase()
    ])
    // For harness-control the brand-gradient chrome already says
    // "Harness", so dropping the label removes the redundancy.
    const label = normalized === 'harnesscontrol' ? action : `${brand.label} · ${action}`
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

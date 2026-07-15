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
  SiAnthropic,
  SiAsana,
  SiBitbucket,
  SiBluesky,
  SiBrave,
  SiClickup,
  SiCloudflare,
  SiCloudinary,
  SiConfluence,
  SiDiscord,
  SiElasticsearch,
  SiFigma,
  SiFirebase,
  SiGithub,
  SiGitlab,
  SiGmail,
  SiGooglecalendar,
  SiGoogledrive,
  SiHuggingface,
  SiHubspot,
  SiIntercom,
  SiJira,
  SiLinear,
  SiMailchimp,
  SiMongodb,
  SiMysql,
  SiNetlify,
  SiNotion,
  SiOpenai,
  SiPaypal,
  SiPerplexity,
  SiPostgresql,
  SiReddit,
  SiRedis,
  SiSalesforce,
  SiSentry,
  SiShopify,
  SiSlack,
  SiSnowflake,
  SiSpotify,
  SiSqlite,
  SiStripe,
  SiSupabase,
  SiTelegram,
  SiTrello,
  SiTwilio,
  SiVercel,
  SiWhatsapp,
  SiX,
  SiYoutube,
  SiZendesk,
  SiZoom
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

// Dev & code
export const GithubIcon = brand(SiGithub)
export const GitlabIcon = brand(SiGitlab, '#FC6D26')
export const BitbucketIcon = brand(SiBitbucket, '#2684FF')
export const LinearIcon = brand(SiLinear, '#5E6AD2')
export const JiraIcon = brand(SiJira, '#2684FF')
export const ConfluenceIcon = brand(SiConfluence, '#2684FF')
export const SentryIcon = brand(SiSentry, '#B14A7C')
export const VercelIcon = brand(SiVercel)
export const NetlifyIcon = brand(SiNetlify, '#00C7B7')
export const CloudflareIcon = brand(SiCloudflare, '#F38020')
export const SupabaseIcon = brand(SiSupabase, '#3FCF8E')
export const FirebaseIcon = brand(SiFirebase, '#FFCA28')

// Databases
export const PostgresIcon = brand(SiPostgresql, '#4169E1')
export const MysqlIcon = brand(SiMysql, '#00758F')
export const MongoIcon = brand(SiMongodb, '#47A248')
export const RedisIcon = brand(SiRedis, '#DC382D')
export const SqliteIcon = brand(SiSqlite)
export const SnowflakeIcon = brand(SiSnowflake, '#29B5E8')
export const ElasticIcon = brand(SiElasticsearch, '#00BFB3')

// Communication
export const DiscordIcon = brand(SiDiscord, '#5865F2')
export const TelegramIcon = brand(SiTelegram, '#26A5E4')
export const WhatsappIcon = brand(SiWhatsapp, '#25D366')
export const ZoomIcon = brand(SiZoom, '#2D8CFF')
export const MailchimpIcon = brand(SiMailchimp, '#FFE01B')
export const TwilioIcon = brand(SiTwilio, '#F22F46')
export const IntercomIcon = brand(SiIntercom, '#1F8DED')

// Productivity
export const AsanaIcon = brand(SiAsana, '#F06A6A')
export const TrelloIcon = brand(SiTrello, '#2684FF')
export const ClickupIcon = brand(SiClickup, '#7B68EE')

// Commerce & finance
export const StripeIcon = brand(SiStripe, '#635BFF')
export const PaypalIcon = brand(SiPaypal, '#0070BA')
export const ShopifyIcon = brand(SiShopify, '#7AB55C')
export const HubspotIcon = brand(SiHubspot, '#FF7A59')
export const SalesforceIcon = brand(SiSalesforce, '#00A1E0')
export const ZendeskIcon = brand(SiZendesk)

// AI & search
export const OpenaiIcon = brand(SiOpenai)
export const HuggingfaceIcon = brand(SiHuggingface, '#FFD21E')
export const PerplexityIcon = brand(SiPerplexity, '#20A8B0')
export const BraveIcon = brand(SiBrave, '#FB542B')
export const AnthropicIcon = brand(SiAnthropic)

// Media & social
export const FigmaIcon = brand(SiFigma, '#F24E1E')
export const SpotifyIcon = brand(SiSpotify, '#1DB954')
export const YoutubeIcon = brand(SiYoutube, '#FF0000')
export const RedditIcon = brand(SiReddit, '#FF4500')
export const XIcon = brand(SiX)
export const BlueskyIcon = brand(SiBluesky, '#0285FF')
export const CloudinaryIcon = brand(SiCloudinary, '#3448C5')

// Harness mark — 3×3 dot grid, Simple-Icons-style silhouette (no
// background rect) so it sits next to the other brand logos without
// reading as a miniature app icon. Pre-sampled diagonal interpolation
// of the brand-gradient stops (amber → red → purple) — five solid
// fills mapped across the 3×3 grid. The earlier <linearGradient> +
// url(#id) version rendered blank in packaged Electron builds because
// Chromium resolves SVG fragment refs against the document base URI,
// which differs between dev (http://localhost) and prod (file://) and
// can fail silently.
const H_AMBER = '#f59e0b'
const H_AMBER_RED = '#f27128'
const H_RED = '#ef4444'
const H_RED_PURPLE = '#cb4c9e'
const H_PURPLE = '#a855f7'

export const HarnessIcon: ToolIcon = ({ className }) => (
  <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
    <circle cx="5" cy="5" r="2.3" fill={H_AMBER} />
    <circle cx="12" cy="5" r="2.3" fill={H_AMBER_RED} />
    <circle cx="19" cy="5" r="2.3" fill={H_RED} />
    <circle cx="5" cy="12" r="2.3" fill={H_AMBER_RED} />
    <circle cx="12" cy="12" r="2.3" fill={H_RED} />
    <circle cx="19" cy="12" r="2.3" fill={H_RED_PURPLE} />
    <circle cx="5" cy="19" r="2.3" fill={H_RED} />
    <circle cx="12" cy="19" r="2.3" fill={H_RED_PURPLE} />
    <circle cx="19" cy="19" r="2.3" fill={H_PURPLE} />
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

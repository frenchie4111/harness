import {
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode
} from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'
import { remarkInsight } from '../remark-insight'
import { InsightCard } from './InsightCard'
import {
  AlertOctagon,
  AlertTriangle,
  Brain,
  ChevronDown,
  Square,
  Terminal,
  FileText,
  X,
  Layers,
  RotateCcw,
  ShieldAlert,
  Sparkles
} from 'lucide-react'
import { useJsonClaudeSession, useSettings } from '../store'
import { useBackend } from '../backend'
import { useJsonClaudeApprovals } from '../hooks/useJsonClaudeApprovals'
import { JsonClaudeApprovalCard } from './JsonClaudeApprovalCard'
import { Tooltip } from './Tooltip'
import { dispatchToolCard, ToolCardChrome } from './json-mode-cards'
import { ToolGroup } from './json-mode-cards/ToolGroup'
import { TaskCard } from './json-mode-cards/TaskCard'
import { buildChildrenMap, isSubAgentToolName } from './json-mode-cards/grouping'
import { JsonModeMentionPopover, type MentionPopoverItem } from './JsonModeMentionPopover'
import { JsonModeChatImageThumb } from './JsonModeChatImageThumb'
import { fuzzyMatch } from '../fuzzy'
import 'highlight.js/styles/github-dark.css'
import type { JsonClaudeChatEntry } from '../../shared/state/json-claude'

const REMARK_PLUGINS = [remarkGfm, remarkInsight]
const REHYPE_PLUGINS = [rehypeHighlight, rehypeColorHex]

// react-markdown v10's Components type only lists known HTML tag names,
// but the runtime accepts any string tag; cast to register our custom
// <insight-card> element.
const MARKDOWN_COMPONENTS = { 'insight-card': InsightCard } as unknown as Components

// Matches color literals we want to swatch:
//   - #RRGGBB and #RRGGBBAA hex. 3-hex (#fff) and 4-hex (#ffff) are
//     omitted on purpose — they collide with GitHub PR / issue refs
//     like #158, #1234 which dominate dev-chat false-positive volume.
//   - rgb() / rgba() CSS functions, modern and legacy syntax
//     (commas, spaces, slash-alpha, percentages). The character class
//     is loose-but-bounded — the browser's CSS parser does the real
//     validation when we set the inline background-color, and the
//     class excludes injection vectors (no quotes, semicolons, etc.).
// Negative lookbehind on the hex branch avoids URL fragments
// (`/#abc`) and double-hash; `\b` before `rgb` avoids `srgb(`.
const COLOR_RE =
  /(?<![\w#/])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6})\b|\brgba?\(\s*[\d.,%\s/]+\s*\)/gi

type HastNode = {
  type: string
  tagName?: string
  value?: string
  properties?: Record<string, unknown>
  children?: HastNode[]
}

function rehypeColorHex() {
  return (tree: HastNode) => {
    walk(tree, false)
  }
  // Skip the <pre> subtree so rehype-highlight's syntax-highlighted
  // tokens stay intact. Inline <code> (outside of <pre>) is NOT skipped
  // — Claude almost always backticks color literals like `#FF00AA`.
  function walk(node: HastNode, inPre: boolean): void {
    if (!node.children) return
    const out: HastNode[] = []
    for (const child of node.children) {
      const childInPre = inPre || child.tagName === 'pre'
      if (child.type === 'text' && !inPre && typeof child.value === 'string') {
        const split = splitColorText(child.value)
        if (split) {
          out.push(...split)
          continue
        }
      } else if (child.children) {
        walk(child, childInPre)
      }
      out.push(child)
    }
    node.children = out
  }
  function splitColorText(text: string): HastNode[] | null {
    COLOR_RE.lastIndex = 0
    if (!COLOR_RE.test(text)) return null
    COLOR_RE.lastIndex = 0
    const parts: HastNode[] = []
    let last = 0
    let m: RegExpExecArray | null
    while ((m = COLOR_RE.exec(text))) {
      const color = m[0]
      if (m.index > last) {
        parts.push({ type: 'text', value: text.slice(last, m.index) })
      }
      parts.push({ type: 'text', value: color })
      parts.push({
        type: 'element',
        tagName: 'span',
        properties: {
          className: ['hex-color-swatch'],
          style: `background-color: ${color}`,
          title: color,
          ariaHidden: 'true'
        },
        children: []
      })
      last = m.index + color.length
    }
    if (last < text.length) {
      parts.push({ type: 'text', value: text.slice(last) })
    }
    return parts
  }
}

// Worktree file list cache. Same TTL/shape as CommandPalette uses — the
// list rarely changes during a typing session, and listAllFiles shells
// out to git ls-files which is cheap but not free on big repos.
const FILE_CACHE = new Map<string, { files: string[]; ts: number }>()
const FILE_CACHE_TTL_MS = 10_000
const MAX_MENTION_RESULTS = 50

// Pre-baked descriptions for built-in slash commands. Skills + plugin
// commands appear in the menu via session.slashCommands (sourced from
// claude's system/init event) but don't have a description until we
// parse their .md frontmatter — out of scope for now.
const BUILTIN_DESCRIPTIONS: Record<string, string> = {
  clear: 'Reset the conversation context',
  compact: 'Summarize and compact prior messages',
  context: 'Show context window usage'
}

function formatTokenCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`
  return String(n)
}

interface JsonModeChatProps {
  sessionId: string
  worktreePath: string
  /** When 'asleep', the component renders chat history (if any in
   *  slice) but does not auto-spawn the subprocess. The user wakes
   *  the tab explicitly via panes:wakeTab (right-click menu or first
   *  selection). Defaults to 'awake' for back-compat callers. */
  mode?: 'awake' | 'asleep'
}

// All per-tool card components live in src/renderer/components/json-mode-cards/
// — keeps this file focused on layout + scroll + input + statusbar.
// dispatchToolCard imported above switches on block.name.

interface RenderedRow {
  key: string
  node: ReactNode
  type: 'text' | 'tool'
  /** Slice entry that produced this row. One assistant entry can emit
   *  multiple rows (text + thinking + tool_use); they all carry the same
   *  entryId so a context-menu rewind on any sub-row targets the parent
   *  entry. Undefined only for rows synthesized outside of an entry
   *  (none today; reserved). */
  entryId?: string
  toolName?: string
  hasError?: boolean
  hasPendingApproval?: boolean
  /** Marks this row as a thinking card. Lives in the 'tool' bucket so
   *  it groups with adjacent tool_use rows (thinking + tools are both
   *  agent work between user-facing replies), but ToolGroup counts it
   *  separately in the header. */
  isThinking?: boolean
}

function ThinkingCard({
  text,
  isPartial
}: {
  text: string
  isPartial: boolean
}): JSX.Element {
  // Default expanded while streaming so the user can see thoughts land in
  // real time; auto-collapse once the model moves on so finalized
  // transcripts don't drown the surrounding chat in raw thought-text.
  // Init from isPartial so cards that mount already-finalized (e.g.
  // seed-from-transcript on reload) start collapsed too — without this,
  // the partial→not transition effect below never fires and they'd stay
  // open forever.
  const [expanded, setExpanded] = useState<boolean>(isPartial)
  const wasPartial = useRef<boolean>(isPartial)
  useEffect(() => {
    if (wasPartial.current && !isPartial) setExpanded(false)
    wasPartial.current = isPartial
  }, [isPartial])

  const charCount = text.length
  return (
    <div
      className="my-1 border border-border/40 bg-app/30 overflow-hidden"
      style={{ borderRadius: 'var(--chat-bubble-radius)' }}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2 hover:bg-app/50 cursor-pointer text-left transition-colors"
        style={{
          paddingInline: 'var(--chat-chrome-px)',
          paddingBlock: 'var(--chat-chrome-py)',
          fontSize: 'var(--chat-chrome-text)'
        }}
      >
        <span className="text-muted text-xs w-2 shrink-0 select-none">
          {expanded ? '▾' : '▸'}
        </span>
        <Brain className="icon-xs text-muted shrink-0" />
        <span
          className="text-muted shrink-0"
          style={{ fontFamily: 'var(--chat-tool-name-family)' }}
        >
          {isPartial ? 'Thinking' : 'Thought'}
        </span>
        {isPartial && (
          <span
            className="json-claude-spinner shrink-0"
            aria-label="thinking"
          />
        )}
        {charCount > 0 && (
          <span
            className="text-muted/60 shrink-0"
            style={{ fontSize: 'var(--chat-meta-text)' }}
          >
            · {charCount} chars
          </span>
        )}
      </button>
      {expanded && (
        <div className="px-3 py-2 border-t border-border/30 markdown italic text-muted text-xs leading-relaxed">
          {text ? (
            <ReactMarkdown
              remarkPlugins={REMARK_PLUGINS}
              rehypePlugins={REHYPE_PLUGINS}
              components={MARKDOWN_COMPONENTS}
            >
              {text}
            </ReactMarkdown>
          ) : !isPartial ? (
            // Claude Code can return signed-but-empty thinking blocks
            // (the API tier elides plaintext but keeps a signature so
            // the model can verify its prior reasoning on the next
            // turn). Surface that explicitly instead of an empty card.
            <span className="opacity-70">(hidden)</span>
          ) : null}
        </div>
      )}
    </div>
  )
}

function CompactCard({
  trigger,
  preTokens,
  postTokens
}: {
  trigger?: 'auto' | 'manual'
  preTokens?: number
  postTokens?: number
}): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const subtitle =
    typeof preTokens === 'number' && typeof postTokens === 'number'
      ? `${formatTokenCount(preTokens)} → ${formatTokenCount(postTokens)} tokens`
      : typeof preTokens === 'number'
        ? `${formatTokenCount(preTokens)} tokens summarized`
        : 'conversation summarized'
  const triggerLabel =
    trigger === 'manual' ? 'via /compact' : trigger === 'auto' ? 'auto' : null
  return (
    <div
      className="my-2 border border-info/40 bg-info/5 overflow-hidden"
      style={{ borderRadius: 'var(--chat-bubble-radius)' }}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className={`w-full flex items-center gap-2 ${
          expanded ? 'border-b border-info/30' : ''
        } bg-info/10 hover:bg-info/15 cursor-pointer transition-colors text-left`}
        style={{
          paddingInline: 'var(--chat-chrome-px)',
          paddingBlock: 'var(--chat-chrome-py)',
          fontSize: 'var(--chat-chrome-text)'
        }}
      >
        <span className="text-info/70 text-xs w-2 shrink-0 select-none">
          {expanded ? '▾' : '▸'}
        </span>
        <Layers className="icon-xs text-info shrink-0" />
        <span
          className="font-semibold shrink-0 text-info"
          style={{ fontFamily: 'var(--chat-tool-name-family)' }}
        >
          Compact
        </span>
        <span className="opacity-70 truncate flex-1 min-w-0">{subtitle}</span>
        {triggerLabel && (
          <span
            className="uppercase tracking-wide text-info/80 bg-info/10 border border-info/30 rounded px-1 py-0.5 shrink-0"
            style={{ fontSize: 'var(--chat-meta-text)' }}
          >
            {triggerLabel}
          </span>
        )}
      </button>
      {expanded && (
        <div className="px-3 py-2 text-xs text-muted space-y-1">
          <div>
            Earlier conversation history was summarized to free up context.
            New messages continue from the summary.
          </div>
          {(typeof preTokens === 'number' ||
            typeof postTokens === 'number') && (
            <div className="font-mono text-xs text-faint">
              {typeof preTokens === 'number' && (
                <span>before: {preTokens.toLocaleString()} tokens</span>
              )}
              {typeof preTokens === 'number' &&
                typeof postTokens === 'number' && <span> · </span>}
              {typeof postTokens === 'number' && (
                <span>after: {postTokens.toLocaleString()} tokens</span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function SubprocessExitCard({
  message,
  sessionId,
  worktreePath,
  isExited
}: {
  message: string
  sessionId: string
  worktreePath: string
  isExited: boolean
}): JSX.Element {
  const backend = useBackend()
  const detail = message || 'Session ended unexpectedly'
  return (
    <div
      className="my-2 border border-danger/40 bg-danger/5 overflow-hidden"
      style={{ borderRadius: 'var(--chat-bubble-radius)' }}
    >
      <div
        className="flex items-center gap-2 bg-danger/10 border-b border-danger/30"
        style={{
          paddingInline: 'var(--chat-chrome-px)',
          paddingBlock: 'var(--chat-chrome-py)',
          fontSize: 'var(--chat-chrome-text)'
        }}
      >
        <RotateCcw className="icon-xs text-danger shrink-0" />
        <span
          className="font-semibold shrink-0 text-danger"
          style={{ fontFamily: 'var(--chat-tool-name-family)' }}
        >
          Session ended
        </span>
        <span className="opacity-70 truncate flex-1 min-w-0">{detail}</span>
      </div>
      <div className="px-3 py-2 space-y-2">
        <pre className="text-xs text-muted font-mono whitespace-pre-wrap break-words m-0">
          {detail}
        </pre>
        {isExited ? (
          <button
            type="button"
            className="px-3 py-1 bg-danger/15 hover:bg-danger/25 border border-danger/40 rounded text-danger text-xs cursor-pointer flex items-center gap-1.5"
            onClick={() => {
              void (async () => {
                await backend.killJsonClaude(sessionId)
                await backend.startJsonClaude(sessionId, worktreePath)
              })()
            }}
          >
            <RotateCcw className="icon-xs" />
            <span>Restart session</span>
          </button>
        ) : (
          <span className="text-xs text-muted italic">
            session restarted
          </span>
        )}
      </div>
    </div>
  )
}

function AuthFailureCard({
  message,
  onOpenLoginTab,
  onRetry
}: {
  message?: string
  onOpenLoginTab: () => void
  onRetry: () => void
}): JSX.Element {
  return (
    <div
      className="my-2 border border-danger/40 bg-danger/5 overflow-hidden"
      style={{ borderRadius: 'var(--chat-bubble-radius)' }}
    >
      <div
        className="flex items-center gap-2 bg-danger/10 border-b border-danger/30"
        style={{
          paddingInline: 'var(--chat-chrome-px)',
          paddingBlock: 'var(--chat-chrome-py)',
          fontSize: 'var(--chat-chrome-text)'
        }}
      >
        <ShieldAlert className="icon-xs text-danger shrink-0" />
        <span
          className="font-semibold shrink-0 text-danger"
          style={{ fontFamily: 'var(--chat-tool-name-family)' }}
        >
          Authentication failed
        </span>
      </div>
      <div className="px-3 py-2 text-xs text-fg space-y-2">
        {message && (
          <pre className="whitespace-pre-wrap break-words font-mono text-xs text-muted bg-app/40 border border-border/40 rounded px-2 py-1 max-h-32 overflow-auto">
            {message}
          </pre>
        )}
        <div>
          Click{' '}
          <span className="font-semibold text-fg-bright">Sign in</span> to open{' '}
          <code className="font-mono text-fg-bright">claude auth login</code> in
          a new shell tab. Complete the OAuth handshake there, then click{' '}
          <span className="font-semibold text-fg-bright">Retry</span> to resume
          this session.
        </div>
        <div className="flex gap-2 pt-1">
          <button
            onClick={onOpenLoginTab}
            className="px-2 py-1 bg-accent text-white rounded hover:bg-accent/90 cursor-pointer"
          >
            Sign in
          </button>
          <button
            onClick={onRetry}
            className="px-2 py-1 bg-panel-raised border border-border-strong rounded text-fg-bright hover:bg-panel cursor-pointer"
          >
            Retry
          </button>
        </div>
      </div>
    </div>
  )
}

function formatResetTime(resetAt: number): string {
  const d = new Date(resetAt)
  if (isNaN(d.getTime())) return ''
  const sameDay = new Date().toDateString() === d.toDateString()
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString([], {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      })
}

function formatTier(tier: string | undefined): string | null {
  if (!tier) return null
  // SDK enum: 'five_hour' | 'seven_day' | 'unified'. Pretty-print without
  // hard-coding the full set so future tiers fall through readably.
  return tier.replace(/_/g, ' ')
}

function RateLimitWarningCard({
  message,
  detail
}: {
  message: string
  detail?: JsonClaudeChatEntry['rateLimitDetail']
}): JSX.Element {
  const utilPct =
    typeof detail?.utilization === 'number'
      ? Math.round(detail.utilization * 100)
      : null
  const tier = formatTier(detail?.tier)
  const resetText = detail?.resetAt ? formatResetTime(detail.resetAt) : null
  return (
    <div
      className="my-2 border border-warning/40 bg-warning/5 overflow-hidden"
      style={{ borderRadius: 'var(--chat-bubble-radius)' }}
    >
      <div
        className="flex items-center gap-2 bg-warning/10"
        style={{
          paddingInline: 'var(--chat-chrome-px)',
          paddingBlock: 'var(--chat-chrome-py)',
          fontSize: 'var(--chat-chrome-text)'
        }}
      >
        <AlertTriangle className="icon-xs text-warning shrink-0" />
        <span
          className="font-semibold shrink-0 text-warning"
          style={{ fontFamily: 'var(--chat-tool-name-family)' }}
        >
          {message}
        </span>
        {utilPct !== null && (
          <span
            className="opacity-70 shrink-0"
            style={{ fontSize: 'var(--chat-meta-text)' }}
          >
            {utilPct}% used
          </span>
        )}
        {tier && (
          <span
            className="uppercase tracking-wide text-warning/80 bg-warning/10 border border-warning/30 rounded px-1 py-0.5 shrink-0"
            style={{ fontSize: 'var(--chat-meta-text)' }}
          >
            {tier}
          </span>
        )}
        <span className="flex-1" />
        {resetText && (
          <span
            className="opacity-70 shrink-0"
            style={{ fontSize: 'var(--chat-meta-text)' }}
          >
            resets {resetText}
          </span>
        )}
      </div>
    </div>
  )
}

function RateLimitErrorCard({
  message,
  detail
}: {
  message: string
  detail?: JsonClaudeChatEntry['rateLimitDetail']
}): JSX.Element {
  const resetAt = detail?.resetAt
  const resetInFuture = typeof resetAt === 'number' && resetAt > Date.now()
  const resetText = resetInFuture && resetAt ? formatResetTime(resetAt) : null
  return (
    <div
      className="my-2 border border-danger/40 bg-danger/5 overflow-hidden"
      style={{ borderRadius: 'var(--chat-bubble-radius)' }}
    >
      <div
        className="flex items-center gap-2 bg-danger/10 border-b border-danger/20"
        style={{
          paddingInline: 'var(--chat-chrome-px)',
          paddingBlock: 'var(--chat-chrome-py)',
          fontSize: 'var(--chat-chrome-text)'
        }}
      >
        <AlertOctagon className="icon-xs text-danger shrink-0" />
        <span
          className="font-semibold shrink-0 text-danger"
          style={{ fontFamily: 'var(--chat-tool-name-family)' }}
        >
          Rate limit reached
        </span>
      </div>
      <div className="px-3 py-2 text-xs text-muted space-y-1">
        <div className="text-fg/80">{message}</div>
        {resetText && (
          <div className="text-faint">
            Retry available at <span className="font-mono">{resetText}</span>
          </div>
        )}
        {!resetText && (
          <div className="text-faint italic">
            Send a new message once the limit resets.
          </div>
        )}
      </div>
    </div>
  )
}

interface RenderContext {
  resultsByToolUseId: Map<string, { content: string; isError: boolean }>
  childrenByParentToolUseId: Map<string, JsonClaudeChatEntry[]>
  approvalCard: (toolUseId: string | undefined) => ReactNode
  pendingToolUseIds: Set<string>
  autoApprovedDecisions: Record<
    string,
    { model: string; reason: string; timestamp: number }
  >
  sessionAllowedDecisions: Record<
    string,
    { toolName: string; timestamp: number }
  >
  onCancelQueued: (entryId: string) => void
  sessionId: string
  worktreePath: string
  isExited: boolean
  onOpenLoginTab: () => void
  onRetryAuth: () => void
}

function renderEntries(
  entries: JsonClaudeChatEntry[],
  ctx: RenderContext
): RenderedRow[] {
  const rows: RenderedRow[] = []
  for (const entry of entries) {
    if (entry.kind === 'user') {
      const queued = !!entry.isQueued
      rows.push({
        key: entry.entryId,
        entryId: entry.entryId,
        type: 'text',
        node: queued ? (
          <div className="flex justify-end">
            <div
              className="bg-accent/10 border border-dashed border-accent/40 pl-3 pr-1 py-2 opacity-70 flex items-start gap-2"
              style={{
                maxWidth: 'var(--chat-bubble-max)',
                borderRadius: 'var(--chat-bubble-radius)'
              }}
            >
              <div
                className="flex-1 min-w-0 whitespace-pre-wrap break-words"
                style={{ fontSize: 'var(--chat-body-text)' }}
              >
                {entry.text}
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <span
                  className="uppercase tracking-wide text-muted bg-panel/60 border border-border px-1.5 py-0.5 rounded"
                  style={{ fontSize: 'var(--chat-meta-text)' }}
                >
                  queued
                </span>
                <button
                  onClick={() => ctx.onCancelQueued(entry.entryId)}
                  className="p-1 rounded hover:bg-panel text-muted hover:text-fg cursor-pointer"
                  title="Cancel queued message"
                  aria-label="Cancel queued message"
                >
                  <X className="icon-xs" />
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex justify-end">
            <div
              className="bg-accent/15 border border-accent/30 px-3 py-2 whitespace-pre-wrap break-words"
              style={{
                maxWidth: 'var(--chat-bubble-max)',
                borderRadius: 'var(--chat-bubble-radius)',
                fontSize: 'var(--chat-body-text)'
              }}
            >
              {entry.text}
              {entry.images && entry.images.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {entry.images.map((img) => (
                    <JsonModeChatImageThumb
                      key={img.path}
                      path={img.path}
                      mediaType={img.mediaType}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        )
      })
      continue
    }
    if (entry.kind === 'compact') {
      rows.push({
        key: entry.entryId,
        entryId: entry.entryId,
        type: 'tool',
        node: (
          <CompactCard
            trigger={entry.compactTrigger}
            preTokens={entry.compactPreTokens}
            postTokens={entry.compactPostTokens}
          />
        )
      })
      continue
    }
    if (
      entry.kind === 'error' &&
      (entry.errorKind === 'subprocess-exit' ||
        entry.errorKind === 'spawn-failed')
    ) {
      const defaultMsg =
        entry.errorKind === 'spawn-failed'
          ? "Couldn't launch Claude"
          : 'Session ended unexpectedly'
      rows.push({
        key: entry.entryId,
        entryId: entry.entryId,
        type: 'text',
        node: (
          <SubprocessExitCard
            message={entry.errorMessage ?? defaultMsg}
            sessionId={ctx.sessionId}
            worktreePath={ctx.worktreePath}
            isExited={ctx.isExited}
          />
        )
      })
      continue
    }
    if (entry.kind === 'error' && entry.errorKind === 'auth-failure') {
      rows.push({
        key: entry.entryId,
        entryId: entry.entryId,
        type: 'tool',
        node: (
          <AuthFailureCard
            message={entry.errorMessage}
            onOpenLoginTab={ctx.onOpenLoginTab}
            onRetry={ctx.onRetryAuth}
          />
        )
      })
      continue
    }
    if (entry.kind === 'system' && entry.errorKind === 'rate-limit-warning') {
      rows.push({
        key: entry.entryId,
        entryId: entry.entryId,
        type: 'tool',
        node: (
          <RateLimitWarningCard
            message={entry.errorMessage ?? 'Approaching rate limit'}
            detail={entry.rateLimitDetail}
          />
        )
      })
      continue
    }
    if (entry.kind === 'error' && entry.errorKind === 'rate-limit-error') {
      rows.push({
        key: entry.entryId,
        entryId: entry.entryId,
        type: 'tool',
        node: (
          <RateLimitErrorCard
            message={entry.errorMessage ?? 'Rate limit reached'}
            detail={entry.rateLimitDetail}
          />
        )
      })
      continue
    }
    if (entry.kind === 'assistant' && entry.blocks) {
      let thinkingIdx = 0
      for (const block of entry.blocks) {
        if (block.type === 'thinking') {
          const idx = thinkingIdx++
          rows.push({
            key: `${entry.entryId}-th-${idx}`,
            entryId: entry.entryId,
            type: 'tool',
            isThinking: true,
            node: (
              <ThinkingCard
                text={block.text || ''}
                isPartial={!!entry.isPartial}
              />
            )
          })
        } else if (block.type === 'text' && (block.text || entry.isPartial)) {
          rows.push({
            key: `${entry.entryId}-t`,
            entryId: entry.entryId,
            type: 'text',
            node: (
              <div
                className="markdown leading-relaxed"
                style={{ fontSize: 'var(--chat-body-text)' }}
              >
                <ReactMarkdown
                  remarkPlugins={REMARK_PLUGINS}
                  rehypePlugins={REHYPE_PLUGINS}
                  components={MARKDOWN_COMPONENTS}
                >
                  {block.text || ''}
                </ReactMarkdown>
                {entry.isPartial && (
                  <span
                    className="json-claude-cursor"
                    aria-label="streaming"
                  />
                )}
              </div>
            )
          })
        } else if (block.type === 'tool_use') {
          const result = block.id
            ? ctx.resultsByToolUseId.get(block.id)
            : undefined
          // While the assistant message is still streaming, the
          // tool_use block has its name + id from content_block_start
          // but no input (input_json_delta isn't accumulated yet — see
          // backlog). Render a placeholder card so the user sees that
          // a tool is being called instead of an apparently-frozen UI.
          // The consolidated assistant event replaces this with the
          // real per-tool card via assistantEntryFinalized.
          const inputIsEmpty =
            !block.input || Object.keys(block.input).length === 0
          const showPlaceholder = entry.isPartial && inputIsEmpty
          // Sub-agent nesting: when the tool is Task, recursively render
          // the children attributed to this tool_use id. The recursion
          // produces another rows array that we group + render inline
          // inside the TaskCard, so deeper Task→Task nesting works the
          // same way at every level.
          let subAgentBody: ReactNode = null
          let subAgentChildCount = 0
          let subAgentDescendantHasPendingApproval = false
          if (isSubAgentToolName(block.name) && block.id) {
            const childEntries =
              ctx.childrenByParentToolUseId.get(block.id) ?? []
            subAgentChildCount = childEntries.length
            if (childEntries.length > 0) {
              const childRows = renderEntries(childEntries, ctx)
              subAgentDescendantHasPendingApproval = childRows.some(
                (r) => r.hasPendingApproval
              )
              subAgentBody = renderGroupedItems(
                groupConsecutiveToolRows(childRows)
              )
            }
          }
          rows.push({
            key: `${entry.entryId}-${block.id || 'tu'}`,
            entryId: entry.entryId,
            type: 'tool',
            toolName: block.name,
            hasError: !!result?.isError,
            hasPendingApproval:
              (!!block.id && ctx.pendingToolUseIds.has(block.id)) ||
              subAgentDescendantHasPendingApproval,
            node: (
              <>
                {showPlaceholder ? (
                  <ToolCardChrome
                    name={block.name || 'tool'}
                    subtitle="preparing call…"
                    variant="info"
                  >
                    <div className="px-2 py-1.5 text-xs text-muted italic flex items-center gap-2">
                      <span className="json-claude-cursor" />
                      <span>waiting for input</span>
                    </div>
                  </ToolCardChrome>
                ) : (
                  dispatchToolCard({
                    block,
                    result,
                    autoApproved: block.id
                      ? ctx.autoApprovedDecisions[block.id]
                      : undefined,
                    sessionAllowed: block.id
                      ? ctx.sessionAllowedDecisions[block.id]
                      : undefined,
                    subAgentBody,
                    subAgentChildCount,
                    subAgentDescendantHasPendingApproval
                  })
                )}
                {ctx.approvalCard(block.id)}
              </>
            )
          })
        }
      }
      continue
    }
    // tool_result entries are folded into their tool_use cards above.
  }
  return rows
}

interface GroupedItem {
  kind: 'single' | 'group'
  key: string
  rows: RenderedRow[]
}

function groupConsecutiveToolRows(rows: RenderedRow[]): GroupedItem[] {
  const out: GroupedItem[] = []
  let toolBuf: RenderedRow[] = []
  function flush(): void {
    if (toolBuf.length === 0) return
    if (toolBuf.length === 1) {
      out.push({ kind: 'single', key: toolBuf[0].key, rows: toolBuf })
    } else {
      out.push({
        kind: 'group',
        key: `group-${toolBuf[0].key}`,
        rows: toolBuf
      })
    }
    toolBuf = []
  }
  for (const r of rows) {
    if (r.type === 'tool') {
      toolBuf.push(r)
    } else {
      flush()
      out.push({ kind: 'single', key: r.key, rows: [r] })
    }
  }
  flush()
  return out
}

/** Renders a grouped-items list as a ReactNode. Used both at the top
 *  level of the transcript and inside TaskCard to render the sub-agent's
 *  chronological activity — keeps the visual treatment of nested rows
 *  identical to top-level rows. */
function renderGroupedItems(items: GroupedItem[]): ReactNode {
  return (
    <>
      {items.map((g) =>
        g.kind === 'single' ? (
          <div key={g.key}>{g.rows[0].node}</div>
        ) : (
          <ToolGroup key={g.key} rows={g.rows} />
        )
      )}
    </>
  )
}

export function JsonModeChat({ sessionId, worktreePath, mode = 'awake' }: JsonModeChatProps): JSX.Element {
  const backend = useBackend()
  const session = useJsonClaudeSession(sessionId)
  const { pending, resolve } = useJsonClaudeApprovals(sessionId)
  const {
    jsonModeChatDensity: density,
    jsonModeSendOnEnter: sendOnEnter,
    defaultClaudeTabType
  } = useSettings()
  const cameFromTerminalDefault = defaultClaudeTabType === 'xterm'
  const isMac =
    typeof window !== 'undefined' &&
    (window.__HARNESS_PLATFORM__
      ? window.__HARNESS_PLATFORM__ === 'darwin'
      : /Mac|iPhone|iPad/.test(navigator.platform || ''))
  const modKeySymbol = isMac ? '⌘' : 'Ctrl+'
  const modKeyWord = isMac ? 'Cmd' : 'Ctrl'
  const sendHotkeyLabel = sendOnEnter
    ? isMac
      ? '↵'
      : 'Enter'
    : isMac
      ? `${modKeySymbol}↵`
      : `${modKeySymbol}Enter`
  const sendHotkeyAria = sendOnEnter ? 'Enter' : `${modKeyWord}+Enter`
  const composerPlaceholder = sendOnEnter
    ? 'Message Claude — Enter to send, Shift+Enter for newline'
    : `Message Claude — ${modKeyWord}+Enter to send`
  const [draft, setDraft] = useState('')
  // Mention/popover state. `dismissed` carries the draft text at which
  // the user pressed Escape — comparing against the live draft is how we
  // re-open as soon as they type a different character.
  const [mentionSelectedIdx, setMentionSelectedIdx] = useState(0)
  const [mentionDismissed, setMentionDismissed] = useState<string | null>(null)
  const [cursorPos, setCursorPos] = useState(0)
  const [files, setFiles] = useState<string[]>([])
  const [isDragOver, setIsDragOver] = useState(false)
  const [attachments, setAttachments] = useState<
    Array<{
      id: string
      mediaType: string
      data: string
      dataUrl: string
      name: string
      /** Absolute on-disk path so Claude can Read/Bash/Write the file
       *  for moves, transforms, etc. Pasted images get a temp path
       *  written via writeJsonClaudeAttachmentImage; dropped images
       *  reuse webUtils.getPathForFile. Null only if the temp write
       *  failed for a paste — we still send the inline bytes. */
      path: string | null
    }>
  >([])
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  // Auto-grow composer with content. CSS max-h caps the rendered height
  // (~8 lines at text-sm + py-1.5); beyond that the textarea scrolls
  // internally. Setting height='auto' first lets the browser recompute
  // scrollHeight when the user deletes text so the box shrinks back.
  useLayoutEffect(() => {
    const ta = textareaRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${ta.scrollHeight}px`
  }, [draft])
  // Wake-on-typing: first keystroke into a slept tab fires the wake IPC;
  // subsequent keystrokes only refresh lastActive (debounced 5s) so the
  // auto-sleep monitor can't re-sleep this worktree mid-composition.
  const wakeRequestedRef = useRef(false)
  const lastTouchAtRef = useRef(0)
  useEffect(() => {
    if (mode === 'asleep') wakeRequestedRef.current = false
  }, [mode])
  const handleComposerActivity = useCallback((): void => {
    if (mode === 'asleep' && !wakeRequestedRef.current) {
      wakeRequestedRef.current = true
      void backend.panesWakeTab(worktreePath, sessionId)
    }
    const now = Date.now()
    if (now - lastTouchAtRef.current >= 5000) {
      lastTouchAtRef.current = now
      void backend.touchWorktreeLastActive(worktreePath)
    }
  }, [backend, mode, sessionId, worktreePath])
  const scrollRef = useRef<HTMLDivElement | null>(null)
  // dragenter fires for every child element entered, dragleave for every
  // child exited — so a naive boolean flickers as the cursor moves over
  // nested nodes. Counter pattern: increment on enter, decrement on
  // leave, only flip the flag at the 0/1 boundary.
  const dragEnterCount = useRef(0)
  // Auto-scroll intent is tracked from input events, not from scroll
  // position deltas. Position-derived heuristics break whenever a single
  // frame inserts large content (approval cards, expanded thinking blocks,
  // big tool cards) — the scrollTop-vs-scrollHeight gap looks like a user
  // scroll-up before the snap-to-bottom can run. Wheel/touch/keydown +
  // scrollTop-decreased deltas are the only authoritative signals.
  const userScrolledUp = useRef(false)
  const lastScrollTop = useRef(0)
  // Suppress the scrollbar-drag fallback while we're driving scroll
  // programmatically (auto-snap on content growth, jump-to-bottom click).
  const isProgrammaticScroll = useRef(false)
  const [showJumpToBottom, setShowJumpToBottom] = useState(false)

  const setUserScrolledUp = useCallback((v: boolean): void => {
    if (userScrolledUp.current === v) return
    userScrolledUp.current = v
    setShowJumpToBottom(v)
  }, [])

  const reevaluateAfterGesture = useCallback((): void => {
    requestAnimationFrame(() => {
      const el = scrollRef.current
      if (!el) return
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight
      if (distance < 32) setUserScrolledUp(false)
    })
  }, [setUserScrolledUp])

  // Spin the subprocess up the first time this session is rendered.
  // Slept tabs (mode='asleep') skip this — they wait for an explicit
  // wake (sidebar select, right-click → wake) which goes through the
  // panes:wakeTab IPC. We don't tear down on unmount — closing the tab
  // is the lifecycle boundary, owned by PanesFSM.
  useEffect(() => {
    if (mode !== 'awake') return
    if (session) return
    void backend.startJsonClaude(sessionId, worktreePath)
  }, [sessionId, worktreePath, session, mode])

  // Lazy-load the chat history. The wire snapshot ships sessions with
  // entries=[] to keep initial-load latency bounded; we fetch once per
  // sessionId here and trust the slice-side `entriesSeeded` dispatch to
  // populate. Empty result is normal (truly empty session) and the ref
  // prevents a refetch loop in that case.
  const fetchedEntriesForSession = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (!session) return
    if (fetchedEntriesForSession.current.has(sessionId)) return
    fetchedEntriesForSession.current.add(sessionId)
    void backend.getJsonClaudeEntries(sessionId)
  }, [sessionId, session])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return

    const onWheel = (e: WheelEvent): void => {
      if (e.deltaY < 0) setUserScrolledUp(true)
      else if (e.deltaY > 0) reevaluateAfterGesture()
    }

    let touchStartY = 0
    const onTouchStart = (e: TouchEvent): void => {
      touchStartY = e.touches[0]?.clientY ?? 0
    }
    const onTouchMove = (e: TouchEvent): void => {
      const y = e.touches[0]?.clientY ?? 0
      // Finger sliding down the screen scrolls content up.
      if (y - touchStartY > 0) setUserScrolledUp(true)
      touchStartY = y
    }
    const onTouchEnd = (): void => reevaluateAfterGesture()

    const SCROLL_KEYS = new Set([
      'PageUp',
      'Home',
      'ArrowUp',
      'PageDown',
      'End',
      'ArrowDown'
    ])
    const onKeyDown = (e: KeyboardEvent): void => {
      if (!SCROLL_KEYS.has(e.key)) return
      if (e.key === 'PageUp' || e.key === 'Home' || e.key === 'ArrowUp') {
        setUserScrolledUp(true)
      }
      reevaluateAfterGesture()
    }

    el.addEventListener('wheel', onWheel, { passive: true })
    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchmove', onTouchMove, { passive: true })
    el.addEventListener('touchend', onTouchEnd, { passive: true })
    el.addEventListener('keydown', onKeyDown)
    return () => {
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
      el.removeEventListener('touchend', onTouchEnd)
      el.removeEventListener('keydown', onKeyDown)
    }
  }, [setUserScrolledUp, reevaluateAfterGesture])

  // ResizeObserver catches streaming text deltas and content reflows;
  // entries.length doesn't change while the model streams text into an
  // existing assistant entry, so a deps-based effect would miss them.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    lastScrollTop.current = el.scrollTop
    let clearTimer: ReturnType<typeof setTimeout> | null = null
    const ro = new ResizeObserver(() => {
      if (userScrolledUp.current) return
      isProgrammaticScroll.current = true
      el.scrollTop = el.scrollHeight
      // Single-frame jumps (thinking card body appearing, cursor span
      // landing) grow content by ~30px in one shot — re-snap on the
      // next frame in case more layout settled after our first commit.
      requestAnimationFrame(() => {
        if (!userScrolledUp.current) el.scrollTop = el.scrollHeight
        lastScrollTop.current = el.scrollTop
      })
      // Hold the suppression window past back-to-back scroll events
      // from rapid resize bursts so the scrollbar-drag fallback below
      // doesn't misread our own snap as a user scroll-up.
      if (clearTimer) clearTimeout(clearTimer)
      clearTimer = setTimeout(() => {
        isProgrammaticScroll.current = false
        clearTimer = null
      }, 150)
    })
    const content = el.firstElementChild
    if (content) ro.observe(content)
    return () => {
      ro.disconnect()
      if (clearTimer) clearTimeout(clearTimer)
    }
  }, [])

  // Scrollbar-drag fallback: macOS pinned scrollbars don't emit wheel
  // events, so a drag is invisible to the input listeners above. Watch
  // for scrollTop deltas in either direction here, gated on the
  // programmatic-scroll flag so our own snaps don't trip it.
  //
  // Distance gate on the scrollTop-decrease branch matters: when content
  // shrinks (thinking card auto-collapse, approval card resolves) the
  // browser clamps scrollTop down and fires a scroll event before the
  // ResizeObserver callback runs (per WHATWG: scroll steps before resize
  // observer steps). Without the gate, that clamp would look like a user
  // scroll-up, flag userScrolledUp, and the RO callback would then skip
  // the snap. Auto-clamps land right at the bottom edge (distance ≈ 0),
  // so requiring distance > 32 ignores them.
  const onScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    const prev = lastScrollTop.current
    lastScrollTop.current = el.scrollTop
    if (isProgrammaticScroll.current) return
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    if (el.scrollTop < prev && distance > 32) {
      setUserScrolledUp(true)
    } else if (el.scrollTop > prev && distance < 32) {
      setUserScrolledUp(false)
    }
  }

  const jumpToBottom = (): void => {
    const el = scrollRef.current
    if (!el) return
    isProgrammaticScroll.current = true
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    lastScrollTop.current = el.scrollHeight
    setUserScrolledUp(false)
    // Smooth scroll fires several scroll events over ~300ms; clear the
    // guard well after the animation has landed at the bottom.
    setTimeout(() => {
      isProgrammaticScroll.current = false
    }, 500)
  }

  const approvalByToolUseId = useMemo(() => {
    const map = new Map<string, (typeof pending)[number]>()
    for (const a of pending) {
      if (a.toolUseId) map.set(a.toolUseId, a)
    }
    return map
  }, [pending])

  const renderApprovalForToolUseId = (toolUseId: string | undefined): ReactNode => {
    if (!toolUseId) return null
    const approval = approvalByToolUseId.get(toolUseId)
    if (!approval) return null
    return (
      <JsonClaudeApprovalCard
        approval={approval}
        onResolve={(result) => resolve(approval.requestId, result)}
      />
    )
  }

  const pendingToolUseIds = useMemo(
    () =>
      new Set(
        pending
          .map((a) => a.toolUseId)
          .filter((x): x is string => typeof x === 'string')
      ),
    [pending]
  )

  const autoApprovedDecisions = session?.autoApprovedDecisions ?? {}
  const sessionAllowedDecisions = session?.sessionAllowedDecisions ?? {}
  // Defer the entries used for heavy row rendering. React keeps input +
  // sidebar interactions responsive even while the chat re-renders mid-
  // delta — the visible cost is that streaming text lags the actual data
  // by a frame or two, which is invisible to the user.
  const entries = session?.entries ?? []
  const entriesHydrated = session?.entriesHydrated ?? false
  const deferredEntries = useDeferredValue(entries)
  const rows = useMemo(() => {
    // Sub-agent nesting pre-pass: split the flat entries array into a
    // top-level transcript and a children-by-parent map so the Task
    // case in renderEntries can recursively render nested activity.
    const { topLevelEntries, childrenByParentToolUseId } =
      buildChildrenMap(deferredEntries)
    // tool_use_id → tool_result lookup built once over the full
    // entries array (results live in top-level tool_result entries
    // even when their corresponding tool_use was a sub-agent's call).
    const resultsByToolUseId = new Map<
      string,
      { content: string; isError: boolean }
    >()
    for (const entry of deferredEntries) {
      if (entry.kind !== 'tool_result' || !entry.blocks) continue
      for (const b of entry.blocks) {
        if (b.type === 'tool_result' && b.toolUseId) {
          resultsByToolUseId.set(b.toolUseId, {
            content: b.content || '',
            isError: !!b.isError
          })
        }
      }
    }
    return renderEntries(topLevelEntries, {
      resultsByToolUseId,
      childrenByParentToolUseId,
      approvalCard: renderApprovalForToolUseId,
      pendingToolUseIds,
      autoApprovedDecisions,
      sessionAllowedDecisions,
      onCancelQueued: (entryId) =>
        backend.cancelQueuedJsonClaudeMessage(sessionId, entryId),
      sessionId,
      worktreePath,
      isExited: session?.state === 'exited',
      onOpenLoginTab: () => {
        // One-click sign-in: main spawns the bundled claude binary's
        // `auth login` subcommand in a fresh shell tab. The tab runs
        // the OAuth handshake to completion and exits cleanly. Both
        // the bundled binary and the json-mode subprocess share
        // ~/.claude/, so credentials written by the login tab are
        // visible on the next Retry.
        void backend.openJsonClaudeAuthLoginTab(worktreePath)
      },
      onRetryAuth: () => {
        // Same restart sequence as the "Reconnect" button on the exited-
        // session banner: kill (no-op if already gone) then start, which
        // re-attaches with whatever auth state is now in ~/.claude/.
        void (async () => {
          await backend.killJsonClaude(sessionId)
          await backend.startJsonClaude(sessionId, worktreePath)
        })()
      }
    })
    // approvalByToolUseId already depends on pending; pendingToolUseIds
    // also derives from pending.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    deferredEntries,
    approvalByToolUseId,
    pendingToolUseIds,
    autoApprovedDecisions,
    sessionAllowedDecisions,
    sessionId,
    worktreePath,
    session?.state
  ])

  const groupedItems = useMemo(() => groupConsecutiveToolRows(rows), [rows])

  // Right-click "Rewind to here" state. Only available on assistant
  // rows — right-clicking a user bubble or any other row does nothing
  // (browser default fires). The menu is a positioned <div> a la
  // TerminalPanel — no reusable ContextMenu primitive yet. Even on
  // assistant rows the action is disabled when:
  //   - the row is from a sub-agent (parentToolUseId set) — can't
  //     usefully rewind in isolation; parent Task's tool_result depends
  //     on the full run
  //   - it sits before any compact_boundary — claude won't see those
  //     raw turns again on --resume so truncating into them doesn't help
  //   - the session is exited — no subprocess to respawn against
  const [rewindMenu, setRewindMenu] = useState<
    | { entryId: string; x: number; y: number; disabledReason: string | null }
    | null
  >(null)
  const lastCompactIdx = useMemo(() => {
    let last = -1
    for (let i = 0; i < entries.length; i++) {
      if (entries[i].kind === 'compact') last = i
    }
    return last
  }, [entries])
  const entryIndexById = useMemo(() => {
    const m = new Map<string, number>()
    for (let i = 0; i < entries.length; i++) m.set(entries[i].entryId, i)
    return m
  }, [entries])
  const rewindDisabledReason = useCallback(
    (entryId: string): string | null => {
      const idx = entryIndexById.get(entryId)
      if (idx === undefined) return 'message not found'
      const e = entries[idx]
      if (e.kind !== 'assistant') return 'only assistant messages can be rewound'
      if (session?.state === 'exited') return 'session is not running'
      if (e.parentToolUseId) return 'sub-agent steps can’t be rewound individually'
      if (idx <= lastCompactIdx) {
        return 'rewinding across a /compact boundary isn’t supported'
      }
      if (idx >= entries.length - 1) return 'nothing after this message yet'
      return null
    },
    [entries, entryIndexById, lastCompactIdx, session?.state]
  )
  const openRewindMenu = useCallback(
    (entryId: string, e: ReactMouseEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      setRewindMenu({
        entryId,
        x: e.clientX,
        y: e.clientY,
        disabledReason: rewindDisabledReason(entryId)
      })
    },
    [rewindDisabledReason]
  )
  const performRewind = useCallback(
    async (entryId: string) => {
      setRewindMenu(null)
      await backend.rewindJsonClaudeTo(sessionId, entryId)
    },
    [backend, sessionId]
  )
  useEffect(() => {
    if (!rewindMenu) return
    const onAway = (): void => setRewindMenu(null)
    window.addEventListener('mousedown', onAway)
    window.addEventListener('scroll', onAway, true)
    window.addEventListener('keydown', onAway)
    return () => {
      window.removeEventListener('mousedown', onAway)
      window.removeEventListener('scroll', onAway, true)
      window.removeEventListener('keydown', onAway)
    }
  }, [rewindMenu])

  // tool_use ids present in chat history. Cheap one-pass scan over
  // entries, used to detect orphaned approvals without depending on the
  // (heavy) `rows` memo. Critical: rows invalidates on every coalesced
  // delta, so the previous `rows.some(r => r.key.includes(id))` check
  // ran O(pending × rows) per delta — a smoking gun for CPU pinning
  // with long chats + thinking turns.
  const allToolUseIds = useMemo(() => {
    const s = new Set<string>()
    for (const entry of entries) {
      if (!entry.blocks) continue
      for (const b of entry.blocks) {
        if (b.type === 'tool_use' && b.id) s.add(b.id)
      }
    }
    return s
  }, [entries])

  // Approvals that arrived without a matching tool_use block (rare —
  // happens when the assistant message hasn't streamed yet). Render them
  // standalone at the bottom so the user can still resolve.
  const orphanApprovals = useMemo(
    () => pending.filter((a) => !a.toolUseId || !allToolUseIds.has(a.toolUseId)),
    [pending, allToolUseIds]
  )

  // Lazy-load the worktree file list for the @-mention picker. Cached at
  // module scope so reopening the popover (or clicking through several
  // json-claude tabs in the same worktree) doesn't re-shell every time.
  useEffect(() => {
    const cached = FILE_CACHE.get(worktreePath)
    const now = Date.now()
    if (cached && now - cached.ts < FILE_CACHE_TTL_MS) {
      setFiles(cached.files)
      return
    }
    let cancelled = false
    void backend.listAllFiles(worktreePath).then((result) => {
      if (cancelled) return
      FILE_CACHE.set(worktreePath, { files: result, ts: Date.now() })
      setFiles(result)
    })
    return () => {
      cancelled = true
    }
  }, [worktreePath])

  // Find the most recent trigger char (`/` or `@`) before the cursor.
  // The token between trigger+1 and cursor is the query. Returns null if
  // the cursor isn't currently inside a trigger token. Both:
  //   - bail if any whitespace appears between trigger and cursor
  //   - require whitespace or start-of-input before the trigger char
  // The whitespace-before constraint stops false positives on paths
  // like `src/foo` and emails like `foo@bar.com`.
  function findTrigger(
    text: string,
    cursor: number,
    char: '/' | '@'
  ): { start: number; query: string } | null {
    if (cursor === 0) return null
    let i = cursor - 1
    while (i >= 0) {
      const ch = text[i]
      if (ch === char) {
        const before = i === 0 ? '' : text[i - 1]
        if (before === '' || /\s/.test(before)) {
          return { start: i, query: text.slice(i + 1, cursor) }
        }
        return null
      }
      if (/\s/.test(ch)) return null
      i--
    }
    return null
  }

  const slashTrigger = useMemo(() => {
    if (session?.state === 'exited') return null
    const trig = findTrigger(draft, cursorPos, '/')
    if (!trig) return null
    // Only allow ascii letters / digits / `-` / `:` (the namespace
    // separator for plugin commands, e.g. `frontend-design:frontend-design`)
    // in the query. Any other char closes the popover so users can type
    // literal slashes followed by punctuation without it lingering.
    if (!/^[a-zA-Z0-9:-]*$/.test(trig.query)) return null
    return trig
  }, [draft, cursorPos, session?.state])

  const mentionTrigger = useMemo<{ start: number; query: string } | null>(() => {
    if (session?.state === 'exited') return null
    return findTrigger(draft, cursorPos, '@')
  }, [draft, cursorPos, session?.state])

  const mentionItems = useMemo<MentionPopoverItem[]>(() => {
    if (mentionDismissed === draft) return []
    if (slashTrigger !== null) {
      const q = slashTrigger.query.toLowerCase()
      const all = session?.slashCommands ?? []
      const ranked =
        q.length === 0
          ? all.map((name) => ({ name, indices: undefined as number[] | undefined }))
          : fuzzyMatch(q, all).map((r) => ({ name: r.item, indices: r.indices }))
      return ranked.slice(0, 50).map((r) => ({
        key: r.name,
        label: `/${r.name}`,
        labelMatchIndices: r.indices?.map((i) => i + 1), // shift past leading '/'
        description: BUILTIN_DESCRIPTIONS[r.name],
        icon: <Terminal className="icon-xs" />
      }))
    }
    if (mentionTrigger !== null && files.length > 0) {
      const q = mentionTrigger.query
      let ranked: { item: string; indices?: number[] }[]
      if (q.length === 0) {
        ranked = files.slice(0, MAX_MENTION_RESULTS).map((f) => ({ item: f }))
      } else {
        ranked = fuzzyMatch(q, files)
          .slice(0, MAX_MENTION_RESULTS)
          .map((r) => ({ item: r.item, indices: r.indices }))
      }
      return ranked.map((r) => ({
        key: r.item,
        label: r.item,
        labelMatchIndices: r.indices,
        icon: <FileText className="icon-xs" />
      }))
    }
    return []
  }, [slashTrigger, mentionTrigger, files, draft, mentionDismissed, session?.slashCommands])

  // Clamp the selection index when the item list shrinks (e.g. the user
  // typed another character and the matches narrowed).
  useEffect(() => {
    setMentionSelectedIdx((i) =>
      mentionItems.length === 0 ? 0 : Math.min(i, mentionItems.length - 1)
    )
  }, [mentionItems.length])

  function replaceTriggerToken(
    triggerStart: number,
    insertion: string
  ): void {
    const before = draft.slice(0, triggerStart)
    const after = draft.slice(cursorPos)
    const next = before + insertion + after
    const nextCursor = before.length + insertion.length
    setDraft(next)
    setMentionDismissed(null)
    // Defer cursor placement until after React has re-rendered the
    // controlled textarea — without rAF the browser uses the stale
    // selection from before the value change.
    requestAnimationFrame(() => {
      const ta = textareaRef.current
      if (!ta) return
      ta.focus()
      ta.setSelectionRange(nextCursor, nextCursor)
      setCursorPos(nextCursor)
    })
  }

  function pickMention(
    item: MentionPopoverItem,
    opts: { sendOverride?: boolean } = {}
  ): void {
    if (slashTrigger !== null) {
      // The slash command name is the label without its leading `/`.
      const name = item.label.startsWith('/') ? item.label.slice(1) : item.label
      const fullCmd = `/${name}`
      // If the trigger spans the entire draft (i.e. user typed `/foo`
      // and nothing else), Enter sends immediately. Otherwise we're
      // inserting mid-message: replace the token, leave a trailing
      // space, and let the user keep typing before sending themselves.
      const isWholeDraft =
        slashTrigger.start === 0 && cursorPos === draft.length
      const shouldSend = opts.sendOverride ?? isWholeDraft
      if (shouldSend) {
        send(fullCmd)
      } else {
        replaceTriggerToken(slashTrigger.start, `${fullCmd} `)
      }
      return
    }
    if (mentionTrigger !== null) {
      // Replace `@<query>` with `@<filepath> ` so the user can keep
      // typing. The trailing space also closes the popover (whitespace
      // breaks the trigger).
      replaceTriggerToken(mentionTrigger.start, `@${item.label} `)
    }
  }

  function insertAtCursor(text: string): void {
    const ta = textareaRef.current
    const start = ta?.selectionStart ?? cursorPos
    const end = ta?.selectionEnd ?? cursorPos
    const next = draft.slice(0, start) + text + draft.slice(end)
    const nextCursor = start + text.length
    setDraft(next)
    setMentionDismissed(null)
    requestAnimationFrame(() => {
      const ref = textareaRef.current
      if (!ref) return
      ref.focus()
      ref.setSelectionRange(nextCursor, nextCursor)
      setCursorPos(nextCursor)
    })
  }

  async function handleDrop(e: React.DragEvent<HTMLDivElement>): Promise<void> {
    e.preventDefault()
    dragEnterCount.current = 0
    setIsDragOver(false)
    const dropped = Array.from(e.dataTransfer?.files ?? [])
    if (dropped.length === 0) return
    const tokens: string[] = []
    for (const f of dropped) {
      // Image files become inline base64 attachments; non-image files
      // become @-mention tokens for Claude to read off disk. Either way
      // we pass the source path so Claude can manipulate the file.
      const abs = backend.getFilePath(f) || null
      if (f.type.startsWith('image/')) {
        await attachImageFile(f, abs)
        continue
      }
      if (!abs) continue
      const rel = abs.startsWith(worktreePath + '/')
        ? abs.slice(worktreePath.length + 1)
        : abs
      tokens.push(`@${rel}`)
    }
    if (tokens.length > 0) insertAtCursor(tokens.join(' ') + ' ')
  }

  async function handlePaste(
    e: React.ClipboardEvent<HTMLTextAreaElement>
  ): Promise<void> {
    const items = Array.from(e.clipboardData?.items ?? [])
    const imageItems = items.filter(
      (it) => it.kind === 'file' && it.type.startsWith('image/')
    )
    if (imageItems.length === 0) return
    e.preventDefault()
    for (const it of imageItems) {
      const f = it.getAsFile()
      if (f) await attachImageFile(f, null)
    }
  }

  function send(textOverride?: string): void {
    const text = (textOverride ?? draft).trim()
    const images = attachments.map((a) => ({
      mediaType: a.mediaType,
      data: a.data,
      // Empty string when the temp write failed — manager treats it as
      // "no path known", just sends bytes with no path annotation.
      path: a.path ?? ''
    }))
    if (!session || state === 'exited') return
    if (!text && images.length === 0) return
    backend.sendJsonClaudeMessage(
      sessionId,
      text,
      images.length > 0 ? images : undefined
    )
    setDraft('')
    setAttachments([])
    setMentionDismissed(null)
    setUserScrolledUp(false)
  }

  async function attachImageFile(
    file: File,
    sourcePath: string | null
  ): Promise<void> {
    if (!file.type.startsWith('image/')) return
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(file)
    }).catch(() => '')
    if (!dataUrl) return
    // data:image/png;base64,XXXX → split off the prefix.
    const commaIdx = dataUrl.indexOf(',')
    if (commaIdx === -1) return
    const data = dataUrl.slice(commaIdx + 1)
    // Pasted images don't have an on-disk source — write to a temp path
    // so Claude can Read/Bash/Write the file. Dropped images already
    // have their original path.
    let path: string | null = sourcePath
    if (!path) {
      try {
        path = await backend.writeJsonClaudeAttachmentImage(data, file.type)
      } catch {
        path = null
      }
    }
    setAttachments((prev) => [
      ...prev,
      {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        mediaType: file.type,
        data,
        dataUrl,
        name: file.name || 'pasted-image',
        path
      }
    ])
  }

  function interrupt(): void {
    void backend.interruptJsonClaude(sessionId)
  }

  const state = session?.state ?? 'idle'
  const busy = !!session?.busy
  const permissionMode = session?.permissionMode ?? 'default'

  function cyclePermissionMode(): void {
    // default → acceptEdits → plan → default. Matches the order Claude's
    // TUI cycles via shift+tab.
    const next =
      permissionMode === 'default'
        ? 'acceptEdits'
        : permissionMode === 'acceptEdits'
          ? 'plan'
          : 'default'
    void backend.setJsonClaudePermissionMode(sessionId, next)
  }

  const modeBadgeStyle =
    permissionMode === 'acceptEdits'
      ? 'bg-success/15 text-success border-success/30'
      : permissionMode === 'plan'
        ? 'bg-accent/15 text-accent border-accent/30'
        : 'bg-surface text-muted border-border'
  const modeBadgeLabel =
    permissionMode === 'acceptEdits'
      ? 'accept edits'
      : permissionMode === 'plan'
        ? 'plan'
        : 'ask every time'

  const stateDot =
    state === 'running'
      ? 'bg-success'
      : state === 'connecting'
        ? 'bg-warning animate-pulse'
        : state === 'exited'
          ? 'bg-danger'
          : 'bg-faint'

  return (
    <div
      className="absolute inset-0 flex flex-col bg-app text-fg"
      data-chat-density={density}
      onDragEnter={(e) => {
        if (!Array.from(e.dataTransfer.types).includes('Files')) return
        dragEnterCount.current += 1
        if (dragEnterCount.current === 1) setIsDragOver(true)
      }}
      onDragOver={(e) => {
        // preventDefault is required for the subsequent drop event to
        // fire. Only opt in for file drags so text selection drags inside
        // the textarea behave normally.
        if (Array.from(e.dataTransfer.types).includes('Files')) {
          e.preventDefault()
        }
      }}
      onDragLeave={(e) => {
        if (!Array.from(e.dataTransfer.types).includes('Files')) return
        dragEnterCount.current = Math.max(0, dragEnterCount.current - 1)
        if (dragEnterCount.current === 0) setIsDragOver(false)
      }}
      onDrop={(e) => void handleDrop(e)}
    >
      {rewindMenu && (
        <div
          className="fixed z-50 bg-panel-raised border border-border-strong rounded shadow-lg text-xs py-1 min-w-[14rem]"
          style={{ left: rewindMenu.x, top: rewindMenu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            disabled={rewindMenu.disabledReason !== null}
            onClick={(e) => {
              e.stopPropagation()
              if (rewindMenu.disabledReason !== null) return
              void performRewind(rewindMenu.entryId)
            }}
            className={`flex w-full items-center gap-2 px-3 py-1.5 text-left ${
              rewindMenu.disabledReason
                ? 'text-muted cursor-not-allowed opacity-60'
                : 'text-danger hover:bg-panel cursor-pointer'
            }`}
          >
            <RotateCcw className="icon-xs shrink-0" />
            <div className="flex flex-col">
              <span>Rewind to here</span>
              <span className="text-xs text-muted">
                {rewindMenu.disabledReason ?? 'drops everything after this'}
              </span>
            </div>
          </button>
        </div>
      )}
      {isDragOver && (
        <div className="absolute inset-0 z-40 bg-accent/10 border-2 border-dashed border-accent rounded flex items-center justify-center pointer-events-none">
          <div className="bg-panel-raised border border-border-strong rounded px-4 py-2 text-fg-bright shadow-lg">
            Drop image to attach
          </div>
        </div>
      )}
      {cameFromTerminalDefault && (
        <div className="absolute top-2 left-2 z-30 flex items-center gap-1 pointer-events-auto">
          <Tooltip label="You can always switch modes by right-clicking the tab.">
            <button
              onClick={() => {
                void backend.panesConvertTabType(worktreePath, sessionId, 'agent')
              }}
              className="px-2 py-1 rounded-md text-xs bg-panel/90 border border-border text-fg-bright hover:bg-border transition-colors"
            >
              Switch back to Terminal mode
            </button>
          </Tooltip>
          <Tooltip label="You can change the default any time in Settings → Agent → Interface.">
            <button
              onClick={() => { void backend.setDefaultClaudeTabType('json') }}
              className="px-2 py-1 rounded-md text-xs bg-panel/90 border border-border text-fg-bright hover:bg-border transition-colors"
            >
              Make Chat mode default
            </button>
          </Tooltip>
        </div>
      )}
      <div className="relative flex-1 min-h-0 flex flex-col">
        <div
          ref={scrollRef}
          onScroll={onScroll}
          tabIndex={0}
          className="flex-1 overflow-y-auto overflow-x-hidden outline-none"
          style={{ overflowAnchor: 'none' }}
        >
          {/* Stable wrapper so the auto-scroll ResizeObserver (mounted once
              with empty deps) always has a firstElementChild to observe.
              Without it, a fresh chat mounts with entriesHydrated=false and
              the empty-state ternary returns null, leaving the scroll
              container childless — the RO is never attached and streaming
              tokens after entries hydrate don't snap to bottom. */}
          <div className="min-h-full flex flex-col">
          {entries.length === 0 && orphanApprovals.length === 0 && !busy ? (
            // Empty-state is only safe to show once we've confirmed there's
            // nothing to display. The wire snapshot ships entries stripped
            // (entriesHydrated=false) and the lazy-fetch above seeds them
            // shortly after mount — rendering the bright sparkle card in
            // that window flashes loudly on tabs that actually have history.
            // Render blank during the fetch; a spinner's appear-then-
            // disappear would itself be a flash.
            entriesHydrated ? (
              <div className="flex-1 flex flex-col items-center justify-center text-center px-4 select-none">
                <div className="relative mb-6">
                  <div
                    className="absolute inset-0 rounded-full blur-2xl opacity-30 brand-gradient-bg"
                    aria-hidden
                  />
                  <div className="relative w-16 h-16 rounded-full brand-gradient-bg flex items-center justify-center shadow-lg">
                    <Sparkles className="w-[1.625rem] h-[1.625rem] text-white" />
                  </div>
                </div>
                <h2 className="text-lg font-semibold brand-gradient-text">
                  What are we going to build today?
                </h2>
                <p className="mt-2 text-xs text-muted">
                  Send a message to get started.
                </p>
              </div>
            ) : null
          ) : (
          <div className="px-4 py-3 space-y-3">
            {groupedItems.map((g) => {
              // Rewind is only meaningful on assistant rows — right-
              // clicking a user bubble or any other kind of row falls
              // through to the browser default. For ToolGroup the
              // target is the first tool's parent assistant entry,
              // which is exactly the entry to rewind to.
              const targetEntryId = g.rows[0]?.entryId
              const targetEntry = targetEntryId
                ? entries[entryIndexById.get(targetEntryId) ?? -1]
                : undefined
              const onContextMenu =
                targetEntryId && targetEntry?.kind === 'assistant'
                  ? (e: ReactMouseEvent): void => openRewindMenu(targetEntryId, e)
                  : undefined
              return g.kind === 'single' ? (
                <div key={g.key} onContextMenu={onContextMenu}>
                  {g.rows[0].node}
                </div>
              ) : (
                <div key={g.key} onContextMenu={onContextMenu}>
                  <ToolGroup rows={g.rows} />
                </div>
              )
            })}
            {orphanApprovals.map((a) => (
              <JsonClaudeApprovalCard
                key={a.requestId}
                approval={a}
                onResolve={(result) => resolve(a.requestId, result)}
              />
            ))}
            {(() => {
              // In-chat "agent is working" indicator. Visible whenever the
              // turn is in flight and no other UI element already signals
              // progress. Suppressed while a text block is streaming (the
              // partial entry's cursor is at the end of the text) or a
              // tool_use block is on screen (its placeholder card signals
              // the call is being prepared). The remaining gap cases — empty
              // partial entry just after message_start, partial entry whose
              // last block is a finalized thinking card waiting for the
              // next content_block_start (e.g. the agent is about to emit
              // a big tool call) — are exactly when nothing else moves on
              // screen, so the spinner reassures the user the agent didn't
              // freeze.
              if (!busy) return null
              const last = session?.entries[session.entries.length - 1]
              const lastBlock = last?.kind === 'assistant' && last.blocks?.length
                ? last.blocks[last.blocks.length - 1]
                : null
              const showWhileStreaming =
                last?.kind === 'assistant' && last.isPartial &&
                (lastBlock?.type === 'text' || lastBlock?.type === 'tool_use')
              if (showWhileStreaming) return null
              return (
                <div className="flex items-center gap-2 px-2 py-1 text-xs text-muted italic">
                  <span className="json-claude-spinner" aria-label="working" />
                  <span>thinking…</span>
                </div>
              )
            })()}
          </div>
          )}
          </div>
        </div>
        {showJumpToBottom && (
          <button
            onClick={jumpToBottom}
            className="absolute right-4 bottom-4 z-10 px-3 py-1.5 rounded-full bg-accent text-white text-xs shadow-lg hover:bg-accent/90 cursor-pointer flex items-center gap-1.5"
            title="Jump to bottom"
          >
            <ChevronDown className="icon-xs" />
            <span>Jump to bottom</span>
          </button>
        )}
      </div>
      {session && session.sessionToolApprovals.length > 0 && (
        <div className="shrink-0 border-t border-border bg-panel/40 px-3 py-1 flex items-center gap-2 text-xs text-muted">
          <span className="opacity-70">auto-allowing:</span>
          <span className="font-mono truncate">
            {session.sessionToolApprovals.join(', ')}
          </span>
          <button
            onClick={() => {
              void backend.clearJsonClaudeSessionToolApprovals(sessionId)
            }}
            className="ml-auto p-0.5 rounded hover:bg-app/60 text-muted hover:text-fg cursor-pointer shrink-0"
            title="Clear session auto-allow set"
            aria-label="Clear session auto-allow set"
          >
            <X className="icon-2xs" />
          </button>
        </div>
      )}
      <div className="shrink-0 border-t border-border p-2">
        <div className="relative rounded-md border border-border bg-panel focus-within:border-accent transition-colors">
          {mentionItems.length > 0 && (
            <JsonModeMentionPopover
              items={mentionItems}
              selectedIdx={mentionSelectedIdx}
              onHover={setMentionSelectedIdx}
              onPick={(item) => pickMention(item)}
            />
          )}
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-2 pt-2">
              {attachments.map((a) => {
                const shortPath = a.path
                  ? a.path.startsWith(worktreePath + '/')
                    ? a.path.slice(worktreePath.length + 1)
                    : a.path.split('/').slice(-2).join('/')
                  : null
                return (
                  <div
                    key={a.id}
                    className="relative inline-flex items-center gap-2 bg-app/40 border border-border rounded overflow-hidden pr-2"
                    title={a.path || a.name}
                  >
                    <img
                      src={a.dataUrl}
                      alt={a.name}
                      className="h-12 w-12 object-cover shrink-0"
                    />
                    {shortPath && (
                      <span className="text-xs text-faint font-mono max-w-[180px] truncate">
                        {shortPath}
                      </span>
                    )}
                    <button
                      onClick={() =>
                        setAttachments((prev) => prev.filter((p) => p.id !== a.id))
                      }
                      className="absolute top-0.5 right-0.5 bg-app/80 hover:bg-app text-fg-bright rounded-full p-0.5 cursor-pointer"
                      aria-label={`Remove ${a.name}`}
                    >
                      <X className="icon-2xs" />
                    </button>
                  </div>
                )
              })}
            </div>
          )}
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value)
              setCursorPos(e.target.selectionStart ?? e.target.value.length)
              // Any text change re-arms a previously dismissed popover.
              setMentionDismissed(null)
              handleComposerActivity()
            }}
            onSelect={(e) => {
              setCursorPos(e.currentTarget.selectionStart ?? 0)
            }}
            onPaste={(e) => void handlePaste(e)}
            // Cmd/Ctrl+Enter submits, plain Enter inserts a newline. This is
            // the inverse of the spike's choice but matches how real chat
            // apps (Slack, Linear) work — accidental sends from a stray
            // Enter while typing a multi-line prompt are bad UX. No
            // preference for now; revisit if users push back.
            onKeyDown={(e) => {
              if (mentionItems.length > 0) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  setMentionSelectedIdx((i) =>
                    Math.min(i + 1, mentionItems.length - 1)
                  )
                  return
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  setMentionSelectedIdx((i) => Math.max(i - 1, 0))
                  return
                }
                if (
                  e.key === 'Enter' &&
                  !e.metaKey &&
                  !e.ctrlKey &&
                  !e.shiftKey
                ) {
                  e.preventDefault()
                  const picked = mentionItems[mentionSelectedIdx]
                  if (picked) pickMention(picked)
                  return
                }
                if (e.key === 'Tab') {
                  e.preventDefault()
                  const picked = mentionItems[mentionSelectedIdx]
                  if (picked) pickMention(picked, { sendOverride: false })
                  return
                }
                if (e.key === 'Escape') {
                  e.preventDefault()
                  setMentionDismissed(draft)
                  return
                }
              }
              if (e.key === 'Enter') {
                // IME composition guard — don't send while composing
                // CJK input.
                if (e.nativeEvent.isComposing || e.keyCode === 229) return
                const wantsSend = sendOnEnter
                  ? !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey
                  : e.metaKey || e.ctrlKey
                if (wantsSend) {
                  e.preventDefault()
                  send()
                  return
                }
                // sendOnEnter && Shift+Enter → fall through so the
                // textarea inserts a newline as usual.
              }
            }}
            placeholder={
              mode === 'asleep'
                ? 'Type to wake this session…'
                : composerPlaceholder
            }
            // text-base (16px) below sm: prevents iOS Safari from zooming
            // the viewport when the textarea takes focus. text-sm on
            // desktop keeps the chat dense.
            className="block w-full bg-transparent border-0 px-2.5 pt-2 pb-1 text-base sm:text-sm resize-none outline-none placeholder:text-faint min-h-[60px] max-h-[200px]"
            rows={2}
            // Never disabled — sleep kills the subprocess and dispatches
            // state='exited', and the wake transition arrives as separate
            // tabWoken + state='running' IPC events. Toggling disabled on
            // either of those races would briefly blur the focused
            // textarea, kicking the user out mid-keystroke. send() guards
            // the actual "no live subprocess" case.
          />
          <div className="flex items-center gap-2 px-2 pb-1.5 pt-0.5">
            <div
              className="flex items-center gap-1.5 text-xs text-muted"
              title={`session ${state}`}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${stateDot}`} />
              <span>{state}</span>
            </div>
            <button
              onClick={cyclePermissionMode}
              className={`px-1.5 py-0.5 rounded border text-xs cursor-pointer hover:opacity-80 transition-opacity ${modeBadgeStyle}`}
              title="Click to cycle permission mode. Applies mid-turn — no restart."
            >
              {modeBadgeLabel}
            </button>
            <div className="flex-1" />
            {busy && (
              <button
                onClick={interrupt}
                className="flex items-center gap-1 px-1.5 py-0.5 rounded text-xs text-danger hover:bg-danger/10 cursor-pointer"
                title="Interrupt the current model turn"
              >
                <Square fill="currentColor" className="icon-2xs" /> interrupt
              </button>
            )}
            <button
              onClick={() => send()}
              disabled={!draft.trim() && attachments.length === 0}
              aria-label={`Send (${sendHotkeyAria})`}
              title={`Send (${sendHotkeyAria})`}
              className="px-2.5 py-0.5 bg-accent text-white rounded text-xs font-medium disabled:opacity-40 cursor-pointer disabled:cursor-not-allowed hover:opacity-90 transition-opacity"
            >
              <span>Send</span>
              <span className="opacity-60 ml-1">{sendHotkeyLabel}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

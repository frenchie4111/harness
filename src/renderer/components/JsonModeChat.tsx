import {
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'
import {
  Brain,
  ChevronDown,
  Square,
  Terminal,
  FileText,
  X,
  Layers
} from 'lucide-react'
import { useJsonClaudeSession } from '../store'
import { useJsonClaudeApprovals } from '../hooks/useJsonClaudeApprovals'
import { JsonClaudeApprovalCard } from './JsonClaudeApprovalCard'
import { dispatchToolCard, ToolCardChrome } from './json-mode-cards'
import { ToolGroup } from './json-mode-cards/ToolGroup'
import { JsonModeMentionPopover, type MentionPopoverItem } from './JsonModeMentionPopover'
import { JsonModeChatImageThumb } from './JsonModeChatImageThumb'
import { fuzzyMatch } from '../fuzzy'
import 'highlight.js/styles/github-dark.css'
import type { JsonClaudeChatEntry } from '../../shared/state/json-claude'

const REMARK_PLUGINS = [remarkGfm]
const REHYPE_PLUGINS = [rehypeHighlight]

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
}

// All per-tool card components live in src/renderer/components/json-mode-cards/
// — keeps this file focused on layout + scroll + input + statusbar.
// dispatchToolCard imported above switches on block.name.

interface RenderedRow {
  key: string
  node: ReactNode
  type: 'text' | 'tool'
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
    <div className="my-1 rounded border border-border/40 bg-app/30 overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full px-2 py-1 text-[11px] flex items-center gap-2 hover:bg-app/50 cursor-pointer text-left transition-colors"
      >
        <span className="text-muted text-[9px] w-2 shrink-0 select-none">
          {expanded ? '▾' : '▸'}
        </span>
        <Brain size={11} className="text-muted shrink-0" />
        <span className="font-mono text-muted shrink-0">
          {isPartial ? 'Thinking' : 'Thought'}
        </span>
        {isPartial && (
          <span
            className="json-claude-spinner shrink-0"
            aria-label="thinking"
          />
        )}
        {charCount > 0 && (
          <span className="text-muted/60 text-[10px] shrink-0">
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
          {isPartial && (
            <span className="json-claude-cursor" aria-label="streaming" />
          )}
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
    <div className="my-2 rounded-md border border-info/40 bg-info/5 overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className={`w-full px-2 py-1 text-[11px] flex items-center gap-2 ${
          expanded ? 'border-b border-info/30' : ''
        } bg-info/10 hover:bg-info/15 cursor-pointer transition-colors text-left`}
      >
        <span className="text-info/70 text-[9px] w-2 shrink-0 select-none">
          {expanded ? '▾' : '▸'}
        </span>
        <Layers size={11} className="text-info shrink-0" />
        <span className="font-mono font-semibold shrink-0 text-info">
          Compact
        </span>
        <span className="opacity-70 truncate flex-1 min-w-0">{subtitle}</span>
        {triggerLabel && (
          <span className="text-[9px] uppercase tracking-wide text-info/80 bg-info/10 border border-info/30 rounded px-1 py-0.5 shrink-0">
            {triggerLabel}
          </span>
        )}
      </button>
      {expanded && (
        <div className="px-3 py-2 text-[11px] text-muted space-y-1">
          <div>
            Earlier conversation history was summarized to free up context.
            New messages continue from the summary.
          </div>
          {(typeof preTokens === 'number' ||
            typeof postTokens === 'number') && (
            <div className="font-mono text-[10px] text-faint">
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

function renderEntries(
  entries: JsonClaudeChatEntry[],
  approvalCard: (toolUseId: string | undefined) => ReactNode,
  pendingToolUseIds: Set<string>,
  autoApprovedDecisions: Record<
    string,
    { model: string; reason: string; timestamp: number }
  >,
  sessionAllowedDecisions: Record<
    string,
    { toolName: string; timestamp: number }
  >,
  onCancelQueued: (entryId: string) => void
): RenderedRow[] {
  // Build a tool_use_id → tool_result lookup pass first so each tool card
  // can render its result inline.
  const resultsByToolUseId = new Map<string, { content: string; isError: boolean }>()
  for (const entry of entries) {
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

  const rows: RenderedRow[] = []
  for (const entry of entries) {
    if (entry.kind === 'user') {
      const queued = !!entry.isQueued
      rows.push({
        key: entry.entryId,
        type: 'text',
        node: queued ? (
          <div className="flex justify-end">
            <div className="max-w-[80%] bg-accent/10 border border-dashed border-accent/40 rounded-md pl-3 pr-1 py-2 opacity-70 flex items-start gap-2">
              <div className="flex-1 min-w-0 whitespace-pre-wrap text-sm">
                {entry.text}
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <span className="text-[10px] uppercase tracking-wide text-muted bg-panel/60 border border-border px-1.5 py-0.5 rounded">
                  queued
                </span>
                <button
                  onClick={() => onCancelQueued(entry.entryId)}
                  className="p-1 rounded hover:bg-panel text-muted hover:text-fg cursor-pointer"
                  title="Cancel queued message"
                  aria-label="Cancel queued message"
                >
                  <X size={12} />
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex justify-end">
            <div className="max-w-[80%] bg-accent/15 border border-accent/30 rounded-md px-3 py-2 whitespace-pre-wrap text-sm">
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
    if (entry.kind === 'assistant' && entry.blocks) {
      let thinkingIdx = 0
      for (const block of entry.blocks) {
        if (block.type === 'thinking') {
          const idx = thinkingIdx++
          rows.push({
            key: `${entry.entryId}-th-${idx}`,
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
            type: 'text',
            node: (
              <div className="markdown text-sm leading-relaxed">
                <ReactMarkdown
                  remarkPlugins={REMARK_PLUGINS}
                  rehypePlugins={REHYPE_PLUGINS}
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
          const result = block.id ? resultsByToolUseId.get(block.id) : undefined
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
          rows.push({
            key: `${entry.entryId}-${block.id || 'tu'}`,
            type: 'tool',
            toolName: block.name,
            hasError: !!result?.isError,
            hasPendingApproval: !!block.id && pendingToolUseIds.has(block.id),
            node: (
              <>
                {showPlaceholder ? (
                  <ToolCardChrome
                    name={block.name || 'tool'}
                    subtitle="preparing call…"
                    variant="info"
                  >
                    <div className="px-2 py-1.5 text-[11px] text-muted italic flex items-center gap-2">
                      <span className="json-claude-cursor" />
                      <span>waiting for input</span>
                    </div>
                  </ToolCardChrome>
                ) : (
                  dispatchToolCard({
                    block,
                    result,
                    autoApproved: block.id ? autoApprovedDecisions[block.id] : undefined,
                    sessionAllowed: block.id ? sessionAllowedDecisions[block.id] : undefined
                  })
                )}
                {approvalCard(block.id)}
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

export function JsonModeChat({ sessionId, worktreePath }: JsonModeChatProps): JSX.Element {
  const session = useJsonClaudeSession(sessionId)
  const { pending, resolve } = useJsonClaudeApprovals(sessionId)
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
  const scrollRef = useRef<HTMLDivElement | null>(null)
  // dragenter fires for every child element entered, dragleave for every
  // child exited — so a naive boolean flickers as the cursor moves over
  // nested nodes. Counter pattern: increment on enter, decrement on
  // leave, only flip the flag at the 0/1 boundary.
  const dragEnterCount = useRef(0)
  // Pause auto-scroll when the user has scrolled up. Re-enables when the
  // user scrolls back to the bottom — standard chat behavior.
  const stickyBottom = useRef(true)
  // Suppress sticky-toggle while we're driving scroll programmatically
  // (auto-snap on content growth, jump-to-bottom click). Otherwise the
  // synthetic scroll event from setting scrollTop would re-enter onScroll
  // and could flip stickyBottom mid-update.
  const isProgrammaticScroll = useRef(false)
  const [showJumpToBottom, setShowJumpToBottom] = useState(false)

  // Spin the subprocess up the first time this session is rendered. We
  // don't tear it down on unmount — closing the tab is the lifecycle
  // boundary, owned by PanesFSM.
  useEffect(() => {
    if (session) return
    void window.api.startJsonClaude(sessionId, worktreePath)
  }, [sessionId, worktreePath, session])

  // ResizeObserver catches streaming text deltas and content reflows;
  // entries.length doesn't change while the model streams text into an
  // existing assistant entry, so a deps-based effect would miss them.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    const ro = new ResizeObserver(() => {
      if (!stickyBottom.current) return
      isProgrammaticScroll.current = true
      el.scrollTop = el.scrollHeight
      requestAnimationFrame(() => {
        isProgrammaticScroll.current = false
      })
    })
    const content = el.firstElementChild
    if (content) ro.observe(content)
    return () => ro.disconnect()
  }, [])

  const onScroll = (): void => {
    if (isProgrammaticScroll.current) return
    const el = scrollRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    const nextSticky = distanceFromBottom < 32
    stickyBottom.current = nextSticky
    setShowJumpToBottom(!nextSticky)
  }

  const jumpToBottom = (): void => {
    const el = scrollRef.current
    if (!el) return
    isProgrammaticScroll.current = true
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    stickyBottom.current = true
    setShowJumpToBottom(false)
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
  const deferredEntries = useDeferredValue(entries)
  const rows = useMemo(
    () =>
      renderEntries(
        deferredEntries,
        renderApprovalForToolUseId,
        pendingToolUseIds,
        autoApprovedDecisions,
        sessionAllowedDecisions,
        (entryId) =>
          window.api.cancelQueuedJsonClaudeMessage(sessionId, entryId)
      ),
    // approvalByToolUseId already depends on pending; pendingToolUseIds
    // also derives from pending.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      deferredEntries,
      approvalByToolUseId,
      pendingToolUseIds,
      autoApprovedDecisions,
      sessionAllowedDecisions,
      sessionId
    ]
  )

  const groupedItems = useMemo(() => groupConsecutiveToolRows(rows), [rows])

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
    void window.api.listAllFiles(worktreePath).then((result) => {
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
        icon: <Terminal size={12} />
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
        icon: <FileText size={12} />
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
      const abs = window.api.getFilePath(f) || null
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
    window.api.sendJsonClaudeMessage(
      sessionId,
      text,
      images.length > 0 ? images : undefined
    )
    setDraft('')
    setAttachments([])
    setMentionDismissed(null)
    stickyBottom.current = true
    setShowJumpToBottom(false)
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
        path = await window.api.writeJsonClaudeAttachmentImage(data, file.type)
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
    void window.api.interruptJsonClaude(sessionId)
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
    void window.api.setJsonClaudePermissionMode(sessionId, next)
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
      {isDragOver && (
        <div className="absolute inset-0 z-40 bg-accent/10 border-2 border-dashed border-accent rounded flex items-center justify-center pointer-events-none">
          <div className="bg-panel-raised border border-border-strong rounded px-4 py-2 text-fg-bright shadow-lg">
            Drop image to attach
          </div>
        </div>
      )}
      <div className="relative flex-1 min-h-0 flex flex-col">
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="flex-1 overflow-y-auto"
        >
          <div className="px-4 py-3 space-y-3">
            {groupedItems.map((g) =>
              g.kind === 'single' ? (
                <div key={g.key}>{g.rows[0].node}</div>
              ) : (
                <ToolGroup key={g.key} rows={g.rows} />
              )
            )}
            {orphanApprovals.map((a) => (
              <JsonClaudeApprovalCard
                key={a.requestId}
                approval={a}
                onResolve={(result) => resolve(a.requestId, result)}
              />
            ))}
            {(() => {
              // In-chat "waiting on next assistant turn" indicator. Covers
              // the dead time between user-send and message_start, and the
              // gap between a tool_result and the next assistant message
              // start. Skipped while an assistant entry is actively
              // streaming — the partial entry's own cursor signals progress
              // there.
              if (!busy) return null
              const last = session?.entries[session.entries.length - 1]
              const waiting =
                !last || last.kind === 'user' || last.kind === 'tool_result'
              if (!waiting) return null
              return (
                <div className="flex items-center gap-2 px-2 py-1 text-[11px] text-muted italic">
                  <span className="json-claude-spinner" aria-label="thinking" />
                  <span>thinking…</span>
                </div>
              )
            })()}
            {state === 'exited' && (
              <div className="flex items-center gap-3 text-xs text-danger italic">
                <span>
                  session exited
                  {session?.exitReason ? ` — ${session.exitReason}` : ''}
                </span>
                <button
                  className="not-italic px-2 py-0.5 bg-panel-raised border border-border-strong rounded text-fg-bright hover:bg-panel cursor-pointer"
                  onClick={() => {
                    // Kill (no-op if no instance) + start: re-spawns the
                    // subprocess and re-uses the same sessionId so --resume
                    // picks up the on-disk jsonl.
                    void (async () => {
                      await window.api.killJsonClaude(sessionId)
                      await window.api.startJsonClaude(sessionId, worktreePath)
                    })()
                  }}
                >
                  Reconnect
                </button>
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
            <ChevronDown size={12} />
            <span>Jump to bottom</span>
          </button>
        )}
      </div>
      {session && session.sessionToolApprovals.length > 0 && (
        <div className="shrink-0 border-t border-border bg-panel/40 px-3 py-1 flex items-center gap-2 text-[10px] text-muted">
          <span className="opacity-70">auto-allowing:</span>
          <span className="font-mono truncate">
            {session.sessionToolApprovals.join(', ')}
          </span>
          <button
            onClick={() => {
              void window.api.clearJsonClaudeSessionToolApprovals(sessionId)
            }}
            className="ml-auto p-0.5 rounded hover:bg-app/60 text-muted hover:text-fg cursor-pointer shrink-0"
            title="Clear session auto-allow set"
            aria-label="Clear session auto-allow set"
          >
            <X size={10} />
          </button>
        </div>
      )}
      <div className="shrink-0 border-t border-border p-2 flex gap-2 items-end">
        <div className="flex-1 relative rounded">
          {mentionItems.length > 0 && (
            <JsonModeMentionPopover
              items={mentionItems}
              selectedIdx={mentionSelectedIdx}
              onHover={setMentionSelectedIdx}
              onPick={(item) => pickMention(item)}
            />
          )}
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-1.5">
              {attachments.map((a) => {
                const shortPath = a.path
                  ? a.path.startsWith(worktreePath + '/')
                    ? a.path.slice(worktreePath.length + 1)
                    : a.path.split('/').slice(-2).join('/')
                  : null
                return (
                  <div
                    key={a.id}
                    className="relative inline-flex items-center gap-2 bg-panel border border-border rounded overflow-hidden pr-2"
                    title={a.path || a.name}
                  >
                    <img
                      src={a.dataUrl}
                      alt={a.name}
                      className="h-12 w-12 object-cover shrink-0"
                    />
                    {shortPath && (
                      <span className="text-[10px] text-faint font-mono max-w-[180px] truncate">
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
                      <X size={10} />
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
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                send()
              }
            }}
            placeholder="Message Claude — Cmd/Ctrl+Enter to send"
            // text-base (16px) below sm: prevents iOS Safari from zooming
            // the viewport when the textarea takes focus. text-sm on
            // desktop keeps the chat dense.
            className="w-full bg-panel border border-border rounded px-2 py-1.5 text-base sm:text-sm resize-none outline-none focus:border-accent min-h-[60px] max-h-[200px]"
            rows={2}
            disabled={state === 'exited'}
          />
        </div>
        <button
          onClick={() => send()}
          disabled={
            (!draft.trim() && attachments.length === 0) ||
            state === 'exited'
          }
          className="px-3 py-1.5 bg-accent text-white rounded text-sm disabled:opacity-40 cursor-pointer disabled:cursor-not-allowed"
        >
          Send
        </button>
      </div>
      <div className="shrink-0 border-t border-border bg-panel/40 px-3 h-6 flex items-center gap-3 text-[10px] text-muted">
        <div className="flex items-center gap-1.5" title={`session ${state}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${stateDot}`} />
          <span>{state}</span>
        </div>
        <div className="flex-1" />
        {busy && (
          <button
            onClick={interrupt}
            className="flex items-center gap-1 text-danger hover:text-danger/80 cursor-pointer"
            title="Interrupt the current model turn"
          >
            <Square size={9} fill="currentColor" /> interrupt
          </button>
        )}
        <button
          onClick={cyclePermissionMode}
          className={`px-1.5 py-0.5 rounded border cursor-pointer hover:opacity-80 transition-opacity ${modeBadgeStyle}`}
          title="Click to cycle permission mode. Applies mid-turn — no restart."
        >
          {modeBadgeLabel}
        </button>
      </div>
    </div>
  )
}

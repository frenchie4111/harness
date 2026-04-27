import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import { Square, Terminal, FileText } from 'lucide-react'
import { useJsonClaude } from '../store'
import { useJsonClaudeApprovals } from '../hooks/useJsonClaudeApprovals'
import { JsonClaudeApprovalCard } from './JsonClaudeApprovalCard'
import { dispatchToolCard, ToolCardChrome } from './json-mode-cards'
import { ToolGroup } from './json-mode-cards/ToolGroup'
import { JsonModeMentionPopover, type MentionPopoverItem } from './JsonModeMentionPopover'
import { fuzzyMatch } from '../fuzzy'
import 'highlight.js/styles/github-dark.css'
import type { JsonClaudeChatEntry } from '../../shared/state/json-claude'

// Worktree file list cache. Same TTL/shape as CommandPalette uses — the
// list rarely changes during a typing session, and listAllFiles shells
// out to git ls-files which is cheap but not free on big repos.
const FILE_CACHE = new Map<string, { files: string[]; ts: number }>()
const FILE_CACHE_TTL_MS = 10_000
const MAX_MENTION_RESULTS = 50

// Built-in slash commands that actually do something via -p stream-json
// stdin. The TUI commands (/help, /model, /agents, /mcp, /memory,
// /permissions, /resume, /status) all return "isn't available in this
// environment" — they're filtered out of the menu so we don't surface
// broken affordances. /cost is included even though its current output
// is sparse ("subscription") because it's documented as the right way
// to ask Claude about cost; richer cost UI lives on the backlog.
interface SlashCommandSpec {
  name: string
  description: string
  /** False if the command leaves the input alone after picking (rare).
   *  Defaults to true: pick → fill textarea + send immediately. */
  sendOnPick?: boolean
}

const BUILTIN_SLASH_COMMANDS: SlashCommandSpec[] = [
  { name: '/clear', description: 'Reset the conversation context' },
  { name: '/compact', description: 'Summarize and compact prior messages' },
  { name: '/cost', description: 'Show subscription / API cost summary' }
]

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
}

function renderEntries(
  entries: JsonClaudeChatEntry[],
  approvalCard: (toolUseId: string | undefined) => ReactNode,
  pendingToolUseIds: Set<string>
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
      rows.push({
        key: entry.entryId,
        type: 'text',
        node: (
          <div className="flex justify-end">
            <div className="max-w-[80%] bg-accent/15 border border-accent/30 rounded-md px-3 py-2 whitespace-pre-wrap text-sm">
              {entry.text}
            </div>
          </div>
        )
      })
      continue
    }
    if (entry.kind === 'assistant' && entry.blocks) {
      for (const block of entry.blocks) {
        if (block.type === 'text' && (block.text || entry.isPartial)) {
          rows.push({
            key: `${entry.entryId}-t`,
            type: 'text',
            node: (
              <div className="markdown text-sm leading-relaxed">
                <ReactMarkdown rehypePlugins={[rehypeHighlight]}>
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
                  dispatchToolCard({ block, result })
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
  const jsonClaude = useJsonClaude()
  const session = jsonClaude.sessions[sessionId]
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
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  // Pause auto-scroll when the user has scrolled up. Re-enables when the
  // user scrolls back to the bottom — standard chat behavior.
  const stickyBottom = useRef(true)

  // Spin the subprocess up the first time this session is rendered. We
  // don't tear it down on unmount — closing the tab is the lifecycle
  // boundary, owned by PanesFSM.
  useEffect(() => {
    if (session) return
    void window.api.startJsonClaude(sessionId, worktreePath)
  }, [sessionId, worktreePath, session])

  useEffect(() => {
    if (!session) return
    if (!stickyBottom.current) return
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [session?.entries.length, session, pending.length])

  const onScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    stickyBottom.current = distanceFromBottom < 16
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

  const rows = useMemo(
    () =>
      renderEntries(
        session?.entries ?? [],
        renderApprovalForToolUseId,
        pendingToolUseIds
      ),
    // approvalByToolUseId already depends on pending; pendingToolUseIds
    // also derives from pending.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session?.entries, approvalByToolUseId, pendingToolUseIds]
  )

  const groupedItems = useMemo(() => groupConsecutiveToolRows(rows), [rows])

  // Approvals that arrived without a matching tool_use block (rare —
  // happens when the assistant message hasn't streamed yet). Render them
  // standalone at the bottom so the user can still resolve.
  const orphanApprovals = useMemo(
    () =>
      pending.filter(
        (a) => !a.toolUseId || !rows.some((r) => r.key.includes(a.toolUseId!))
      ),
    [pending, rows]
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

  // Slash-command popover trigger. Active when the draft is just a
  // leading-slash token (`/`, `/c`, `/com`…) with no whitespace and no
  // following args yet. As soon as the user types a space, the popover
  // closes and the input behaves normally.
  const slashTrigger = useMemo<string | null>(() => {
    if (session?.state === 'exited') return null
    const m = /^\/[a-zA-Z][a-zA-Z-]*$|^\/$/.exec(draft)
    return m ? m[0] : null
  }, [draft, session?.state])

  // @-mention trigger. Scans backward from the cursor for the most
  // recent `@`. Bails if it hits whitespace before the `@`, or if the
  // char before the `@` isn't whitespace/start-of-input (avoids
  // triggering on emails like foo@bar.com).
  const mentionTrigger = useMemo<{ start: number; query: string } | null>(() => {
    if (session?.state === 'exited') return null
    if (cursorPos === 0) return null
    let i = cursorPos - 1
    while (i >= 0) {
      const ch = draft[i]
      if (ch === '@') {
        const before = i === 0 ? '' : draft[i - 1]
        if (before === '' || /\s/.test(before)) {
          return { start: i, query: draft.slice(i + 1, cursorPos) }
        }
        return null
      }
      if (/\s/.test(ch)) return null
      i--
    }
    return null
  }, [draft, cursorPos, session?.state])

  const mentionItems = useMemo<MentionPopoverItem[]>(() => {
    if (mentionDismissed === draft) return []
    if (slashTrigger !== null) {
      const q = slashTrigger.toLowerCase()
      const matches =
        q === '/'
          ? BUILTIN_SLASH_COMMANDS
          : BUILTIN_SLASH_COMMANDS.filter((c) =>
              c.name.toLowerCase().startsWith(q)
            )
      return matches.map((c) => ({
        key: c.name,
        label: c.name,
        description: c.description,
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
  }, [slashTrigger, mentionTrigger, files, draft, mentionDismissed])

  // Clamp the selection index when the item list shrinks (e.g. the user
  // typed another character and the matches narrowed).
  useEffect(() => {
    setMentionSelectedIdx((i) =>
      mentionItems.length === 0 ? 0 : Math.min(i, mentionItems.length - 1)
    )
  }, [mentionItems.length])

  function pickMention(
    item: MentionPopoverItem,
    opts: { sendOverride?: boolean } = {}
  ): void {
    if (slashTrigger !== null) {
      const cmd = BUILTIN_SLASH_COMMANDS.find((c) => c.name === item.label)
      if (!cmd) return
      const shouldSend = opts.sendOverride ?? (cmd.sendOnPick ?? true)
      if (shouldSend) {
        send(cmd.name)
      } else {
        setDraft(cmd.name)
        setMentionDismissed(cmd.name)
      }
      return
    }
    if (mentionTrigger !== null) {
      // Replace `@<query>` with `@<filepath> ` so the user can keep
      // typing. The trailing space also closes the popover (whitespace
      // breaks the trigger).
      const before = draft.slice(0, mentionTrigger.start)
      const after = draft.slice(cursorPos)
      const insertion = `@${item.label} `
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
    setIsDragOver(false)
    const dropped = Array.from(e.dataTransfer?.files ?? [])
    if (dropped.length === 0) return
    const tokens: string[] = []
    for (const f of dropped) {
      const abs = window.api.getFilePath(f)
      if (!abs) continue
      // If the file lives under the worktree, use the relative path —
      // matches the @-mention convention. Otherwise fall back to the
      // absolute path so external attachments still work.
      const rel = abs.startsWith(worktreePath + '/')
        ? abs.slice(worktreePath.length + 1)
        : abs
      tokens.push(`@${rel}`)
    }
    if (tokens.length > 0) insertAtCursor(tokens.join(' ') + ' ')
  }

  function send(textOverride?: string): void {
    const text = (textOverride ?? draft).trim()
    if (!text || !session || session.busy) return
    window.api.sendJsonClaudeMessage(sessionId, text)
    setDraft('')
    setMentionDismissed(null)
    stickyBottom.current = true
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
    <div className="absolute inset-0 flex flex-col bg-app text-fg">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="flex-1 overflow-y-auto px-4 py-3 space-y-3"
      >
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
                // picks up the on-disk jsonl. Same kill-then-start the
                // permission-mode toggle does.
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
      <div className="shrink-0 border-t border-border p-2 flex gap-2 items-end">
        <div
          className={`flex-1 relative rounded ${
            isDragOver ? 'ring-2 ring-accent ring-offset-1 ring-offset-app' : ''
          }`}
          onDragOver={(e) => {
            // Only react when files are being dragged (not text from inside
            // the textarea itself).
            if (Array.from(e.dataTransfer.types).includes('Files')) {
              e.preventDefault()
              setIsDragOver(true)
            }
          }}
          onDragLeave={() => setIsDragOver(false)}
          onDrop={(e) => void handleDrop(e)}
        >
          {mentionItems.length > 0 && (
            <JsonModeMentionPopover
              items={mentionItems}
              selectedIdx={mentionSelectedIdx}
              onHover={setMentionSelectedIdx}
              onPick={(item) => pickMention(item)}
            />
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
          disabled={busy || !draft.trim() || state === 'exited'}
          className="px-3 py-1.5 bg-accent text-white rounded text-sm disabled:opacity-40 cursor-pointer disabled:cursor-not-allowed"
        >
          Send
        </button>
      </div>
      <div className="shrink-0 border-t border-border bg-panel/40 px-3 h-6 flex items-center gap-3 text-[10px] text-muted">
        <div className="flex items-center gap-1.5" title={`session ${state}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${stateDot}`} />
          <span>{state}</span>
          {busy && <span className="italic">· thinking…</span>}
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
          title="Click to cycle permission mode. Restarts the subprocess with --resume so the conversation persists."
        >
          {modeBadgeLabel}
        </button>
      </div>
    </div>
  )
}

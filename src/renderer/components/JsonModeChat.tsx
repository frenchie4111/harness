import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import { Square, X } from 'lucide-react'
import { useJsonClaude } from '../store'
import { useJsonClaudeApprovals } from '../hooks/useJsonClaudeApprovals'
import { JsonClaudeApprovalCard } from './JsonClaudeApprovalCard'
import { dispatchToolCard, ToolCardChrome } from './json-mode-cards'
import { ToolGroup } from './json-mode-cards/ToolGroup'
import 'highlight.js/styles/github-dark.css'
import type { JsonClaudeChatEntry } from '../../shared/state/json-claude'

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
  pendingToolUseIds: Set<string>,
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
        pendingToolUseIds,
        (entryId) =>
          window.api.cancelQueuedJsonClaudeMessage(sessionId, entryId)
      ),
    // approvalByToolUseId already depends on pending; pendingToolUseIds
    // also derives from pending.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session?.entries, approvalByToolUseId, pendingToolUseIds, sessionId]
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

  function send(): void {
    const text = draft.trim()
    if (!text || !session || state === 'exited') return
    window.api.sendJsonClaudeMessage(sessionId, text)
    setDraft('')
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
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          // Cmd/Ctrl+Enter submits, plain Enter inserts a newline. This is
          // the inverse of the spike's choice but matches how real chat
          // apps (Slack, Linear) work — accidental sends from a stray
          // Enter while typing a multi-line prompt are bad UX. No
          // preference for now; revisit if users push back.
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              send()
            }
          }}
          placeholder="Message Claude — Cmd/Ctrl+Enter to send"
          // text-base (16px) below sm: prevents iOS Safari from zooming
          // the viewport when the textarea takes focus. text-sm on
          // desktop keeps the chat dense.
          className="flex-1 bg-panel border border-border rounded px-2 py-1.5 text-base sm:text-sm resize-none outline-none focus:border-accent min-h-[60px] max-h-[200px]"
          rows={2}
          disabled={state === 'exited'}
        />
        <button
          onClick={send}
          disabled={!draft.trim() || state === 'exited'}
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

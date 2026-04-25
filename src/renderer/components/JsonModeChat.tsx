import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import { Square } from 'lucide-react'
import { useJsonClaude } from '../store'
import { useJsonClaudeApprovals } from '../hooks/useJsonClaudeApprovals'
import { JsonClaudeApprovalCard } from './JsonClaudeApprovalCard'
import 'highlight.js/styles/github-dark.css'
import type {
  JsonClaudeChatEntry,
  JsonClaudeMessageBlock
} from '../../shared/state/json-claude'

interface JsonModeChatProps {
  sessionId: string
  worktreePath: string
}

function basename(p: string): string {
  return p.split('/').pop() || p
}

function trunc(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s
}

interface ToolPair {
  block: JsonClaudeMessageBlock
  result?: { content: string; isError: boolean }
}

interface ToolCardProps extends ToolPair {}

function ReadCard({ block, result }: ToolCardProps): JSX.Element {
  const fp = String(block.input?.file_path ?? '')
  const offset = Number(block.input?.offset) || 0
  const limit = Number(block.input?.limit) || 0
  const range = offset || limit ? ` (${offset || 1}–${(offset || 1) + limit})` : ''
  return (
    <ToolCardChrome name="Read" subtitle={`${basename(fp)}${range}`} variant="info">
      {fp && <div className="px-2 py-1 text-[10px] text-muted truncate font-mono">{fp}</div>}
      {result && (
        <pre
          className={`px-2 py-1 text-[11px] font-mono whitespace-pre-wrap max-h-72 overflow-auto ${
            result.isError ? 'text-danger' : 'opacity-80'
          }`}
        >
          {trunc(result.content, 4000)}
        </pre>
      )}
    </ToolCardChrome>
  )
}

function EditCard({ block, result }: ToolCardProps): JSX.Element {
  const fp = String(block.input?.file_path ?? '')
  const oldStr = String(block.input?.old_string ?? '')
  const newStr = String(block.input?.new_string ?? '')
  return (
    <ToolCardChrome name="Edit" subtitle={basename(fp)} variant="warn">
      {fp && <div className="px-2 py-1 text-[10px] text-muted truncate font-mono">{fp}</div>}
      <div className="px-2 py-1 text-[11px] font-mono">
        <pre className="bg-danger/10 text-danger/80 rounded p-2 whitespace-pre-wrap max-h-40 overflow-auto">
          {trunc(oldStr, 1500)}
        </pre>
        <pre className="bg-success/10 text-success/80 rounded p-2 whitespace-pre-wrap max-h-40 overflow-auto mt-1">
          {trunc(newStr, 1500)}
        </pre>
      </div>
      {result && result.isError && (
        <pre className="px-2 py-1 text-[11px] font-mono text-danger whitespace-pre-wrap">
          {trunc(result.content, 1000)}
        </pre>
      )}
    </ToolCardChrome>
  )
}

function WriteCard({ block, result }: ToolCardProps): JSX.Element {
  const fp = String(block.input?.file_path ?? '')
  const content = String(block.input?.content ?? '')
  return (
    <ToolCardChrome name="Write" subtitle={basename(fp)} variant="warn">
      {fp && <div className="px-2 py-1 text-[10px] text-muted truncate font-mono">{fp}</div>}
      <pre className="px-2 py-1 text-[11px] font-mono whitespace-pre-wrap max-h-60 overflow-auto bg-app/40">
        {trunc(content, 4000)}
      </pre>
      {result && result.isError && (
        <pre className="px-2 py-1 text-[11px] font-mono text-danger whitespace-pre-wrap">
          {trunc(result.content, 1000)}
        </pre>
      )}
    </ToolCardChrome>
  )
}

function BashCard({ block, result }: ToolCardProps): JSX.Element {
  const cmd = String(block.input?.command ?? '')
  const description = block.input?.description as string | undefined
  return (
    <ToolCardChrome name="Bash" subtitle={trunc(cmd, 80)} variant="warn">
      {description && <div className="px-2 py-1 text-[11px] text-muted">{description}</div>}
      <pre className="px-2 py-1 text-[11px] font-mono bg-app/40 whitespace-pre-wrap max-h-32 overflow-auto">
        $ {cmd}
      </pre>
      {result && (
        <pre
          className={`px-2 py-1 text-[11px] font-mono whitespace-pre-wrap max-h-72 overflow-auto ${
            result.isError ? 'text-danger' : 'opacity-80'
          }`}
        >
          {trunc(result.content, 6000)}
        </pre>
      )}
    </ToolCardChrome>
  )
}

function GrepCard({ block, result }: ToolCardProps): JSX.Element {
  const pattern = String(block.input?.pattern ?? '')
  const path = String(block.input?.path ?? '')
  return (
    <ToolCardChrome name="Grep" subtitle={`/${pattern}/${path ? ` in ${basename(path)}` : ''}`} variant="info">
      {result && (
        <pre className="px-2 py-1 text-[11px] font-mono whitespace-pre-wrap max-h-60 overflow-auto opacity-80">
          {trunc(result.content, 3000)}
        </pre>
      )}
    </ToolCardChrome>
  )
}

function GlobCard({ block, result }: ToolCardProps): JSX.Element {
  const pattern = String(block.input?.pattern ?? '')
  return (
    <ToolCardChrome name="Glob" subtitle={pattern} variant="info">
      {result && (
        <pre className="px-2 py-1 text-[11px] font-mono whitespace-pre-wrap max-h-60 overflow-auto opacity-80">
          {trunc(result.content, 2000)}
        </pre>
      )}
    </ToolCardChrome>
  )
}

interface TodoItem {
  content: string
  status: string
  activeForm?: string
}

function TodoWriteCard({ block }: ToolCardProps): JSX.Element {
  const todos = (block.input?.todos as TodoItem[] | undefined) ?? []
  return (
    <ToolCardChrome name="TodoWrite" subtitle={`${todos.length} item${todos.length === 1 ? '' : 's'}`} variant="info">
      <ul className="px-3 py-2 text-xs space-y-1">
        {todos.map((t, i) => (
          <li key={i} className="flex items-baseline gap-2">
            <span
              className={
                t.status === 'completed'
                  ? 'text-success'
                  : t.status === 'in_progress'
                    ? 'text-warning'
                    : 'text-faint'
              }
            >
              {t.status === 'completed' ? '☑' : t.status === 'in_progress' ? '◐' : '☐'}
            </span>
            <span
              className={t.status === 'completed' ? 'line-through opacity-60' : ''}
            >
              {t.content}
            </span>
          </li>
        ))}
      </ul>
    </ToolCardChrome>
  )
}

function GenericToolCard({ block, result }: ToolCardProps): JSX.Element {
  const summary = block.input ? trunc(JSON.stringify(block.input), 100) : ''
  return (
    <ToolCardChrome name={block.name || 'Tool'} subtitle={summary} variant="info">
      {block.input && (
        <pre className="px-2 py-1 text-[11px] font-mono bg-app/40 whitespace-pre-wrap max-h-40 overflow-auto">
          {JSON.stringify(block.input, null, 2)}
        </pre>
      )}
      {result && (
        <pre
          className={`px-2 py-1 text-[11px] font-mono whitespace-pre-wrap max-h-60 overflow-auto ${
            result.isError ? 'text-danger' : 'opacity-80'
          }`}
        >
          {trunc(result.content, 3000)}
        </pre>
      )}
    </ToolCardChrome>
  )
}

function ToolCardChrome({
  name,
  subtitle,
  variant,
  children
}: {
  name: string
  subtitle: string
  variant: 'info' | 'warn'
  children: ReactNode
}): JSX.Element {
  const ring = variant === 'warn' ? 'border-warning/30' : 'border-border'
  return (
    <div className={`my-2 rounded-md border ${ring} bg-panel overflow-hidden`}>
      <div className="px-2 py-1 text-[11px] flex items-center gap-2 border-b border-border bg-app/40">
        <span className="font-mono font-semibold text-accent">{name}</span>
        <span className="opacity-70 truncate">{subtitle}</span>
      </div>
      {children}
    </div>
  )
}

function dispatchToolCard(props: ToolCardProps): JSX.Element {
  switch (props.block.name) {
    case 'Read':
      return <ReadCard {...props} />
    case 'Edit':
    case 'MultiEdit':
      return <EditCard {...props} />
    case 'Write':
      return <WriteCard {...props} />
    case 'Bash':
      return <BashCard {...props} />
    case 'Grep':
      return <GrepCard {...props} />
    case 'Glob':
      return <GlobCard {...props} />
    case 'TodoWrite':
      return <TodoWriteCard {...props} />
    default:
      return <GenericToolCard {...props} />
  }
}

interface RenderedRow {
  key: string
  node: ReactNode
}

function renderEntries(
  entries: JsonClaudeChatEntry[],
  approvalCard: (toolUseId: string | undefined) => ReactNode
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
        if (block.type === 'text' && block.text) {
          rows.push({
            key: `${entry.entryId}-t`,
            node: (
              <div className="markdown text-sm leading-relaxed">
                <ReactMarkdown rehypePlugins={[rehypeHighlight]}>
                  {block.text}
                </ReactMarkdown>
              </div>
            )
          })
        } else if (block.type === 'tool_use') {
          const result = block.id ? resultsByToolUseId.get(block.id) : undefined
          rows.push({
            key: `${entry.entryId}-${block.id || 'tu'}`,
            node: (
              <>
                {dispatchToolCard({ block, result })}
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

  const rows = useMemo(
    () => renderEntries(session?.entries ?? [], renderApprovalForToolUseId),
    // approvalByToolUseId already depends on pending.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session?.entries, approvalByToolUseId]
  )

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
    if (!text || !session || session.busy) return
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
        {rows.map((r) => (
          <div key={r.key}>{r.node}</div>
        ))}
        {orphanApprovals.map((a) => (
          <JsonClaudeApprovalCard
            key={a.requestId}
            approval={a}
            onResolve={(result) => resolve(a.requestId, result)}
          />
        ))}
        {state === 'exited' && (
          <div className="text-xs text-danger italic">
            session exited
            {session?.exitReason ? ` — ${session.exitReason}` : ''}
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
          className="flex-1 bg-panel border border-border rounded px-2 py-1.5 text-sm resize-none outline-none focus:border-accent min-h-[60px] max-h-[200px]"
          rows={2}
          disabled={state === 'exited'}
        />
        <button
          onClick={send}
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

// The app-scoped chat, rendered as its own window root (see main.tsx's
// ?view=global-chat branch).
//
// Deliberately NOT JsonModeChat. That component is ~2900 lines and takes
// a worktreePath it uses for a dozen worktree-specific affordances —
// file @-mentions, worktree @-mentions, fork-into-worktree, tab-type
// conversion, wake-on-typing, the auth login shell tab. Threading a
// "there is no worktree" mode through all of those would have meant
// touching every one of them, on attempt one of a UX the user expects to
// reshape. This renders the same slice through a much smaller surface;
// converging the two is a follow-up once the shape settles.
//
// What IS shared: the slice, the manager, the approval bridge, the tool
// cards, and the approval card component. Nothing about the transport is
// duplicated here.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { rehypeHighlightShared } from '../rehype-highlight-shared'
import {
  Bot,
  Brain,
  ChevronDown,
  ChevronRight,
  KeyRound,
  Loader2,
  RefreshCw,
  Square,
  Trash2
} from 'lucide-react'
import { useAppState, useGlobalChat, useJsonClaudeSession, useSettings } from '../store'
import { useBackend } from '../backend'
import { useActiveTheme } from '../hooks/useActiveTheme'
import { applyTheme } from '../theme-apply'
import { scaleSpec } from '../../shared/state/settings'
import { useJsonClaudeApprovals } from '../hooks/useJsonClaudeApprovals'
import { JsonClaudeApprovalCard } from './JsonClaudeApprovalCard'
import { dispatchToolCard } from './json-mode-cards'
import type {
  JsonClaudeChatEntry,
  JsonClaudeMessageBlock,
  JsonClaudePendingApproval
} from '../../shared/state/json-claude'

interface ApprovalResult {
  behavior: 'allow' | 'deny'
  updatedInput?: Record<string, unknown>
  updatedPermissions?: unknown[]
  message?: string
  interrupt?: boolean
}

const REMARK_PLUGINS = [remarkGfm]
const REHYPE_PLUGINS = [rehypeHighlightShared]

export default function GlobalChat(): JSX.Element {
  const theme = useActiveTheme()
  const nessieColor = useAppState((s) => s.settings.nessieColor)
  const uiScale = useAppState((s) => s.settings.uiScale)
  useEffect(() => {
    applyTheme(theme, nessieColor)
  }, [theme, nessieColor])
  useEffect(() => {
    document.documentElement.style.fontSize = `${scaleSpec(uiScale).rootPx}px`
  }, [uiScale])

  return (
    <div className="h-screen w-screen flex flex-col bg-app text-fg overflow-hidden">
      <GlobalChatBody />
    </div>
  )
}

function GlobalChatBody(): JSX.Element {
  const backend = useBackend()
  const { sessionId, auth } = useGlobalChat()
  const session = useJsonClaudeSession(sessionId ?? '')
  const [bootError, setBootError] = useState<string | null>(null)

  // One ensure per window. The handler is idempotent main-side, so a
  // second window (or a reload) resumes rather than respawning.
  useEffect(() => {
    let cancelled = false
    void backend
      .globalChatEnsure()
      .catch((err: unknown) => {
        if (cancelled) return
        setBootError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [backend])

  // Entries are elided from the wire snapshot (see stripJsonClaudeEntries)
  // so a reloading window has to pull them once.
  const hydratedFor = useRef<string | null>(null)
  useEffect(() => {
    if (!sessionId || !session) return
    if (session.entriesHydrated) return
    if (hydratedFor.current === sessionId) return
    hydratedFor.current = sessionId
    void backend.getJsonClaudeEntries(sessionId)
  }, [backend, sessionId, session])

  if (bootError) {
    return (
      <EmptyState title="Ness Chat couldn't start" icon={<Bot className="icon-lg" />}>
        <p>{bootError}</p>
      </EmptyState>
    )
  }
  if (auth === 'required' || session?.state === 'auth-required') {
    return <AuthRequired />
  }
  if (!sessionId || !session) {
    return (
      <EmptyState title="Starting…" icon={<Loader2 className="icon-lg animate-spin" />}>
        <p className="text-muted">Spinning up the Ness assistant.</p>
      </EmptyState>
    )
  }
  return <Conversation sessionId={sessionId} />
}

function AuthRequired(): JSX.Element {
  const backend = useBackend()
  const [checking, setChecking] = useState(false)
  const recheck = useCallback(() => {
    setChecking(true)
    void backend.globalChatRecheckAuth().finally(() => setChecking(false))
  }, [backend])

  return (
    <EmptyState title="Claude Code isn't signed in" icon={<KeyRound className="icon-lg" />}>
      <p>
        Ness Chat runs on the same Claude Code credentials your agents use, and
        there aren't any yet. Nothing here works until that's fixed — but it's a
        one-time step.
      </p>
      <p>
        Open a terminal and run <code className="px-1 py-0.5 rounded bg-surface text-fg-bright">claude</code>, then
        follow the sign-in prompt. Anthropic subscription or API key both work.
        If you'd rather not leave Ness, open any worktree, start a Claude tab,
        and sign in there — Ness Chat shares the same{' '}
        <code className="px-1 py-0.5 rounded bg-surface text-fg-bright">~/.claude/</code> directory.
      </p>
      <p className="text-muted">
        Already signed in elsewhere? Check again and this window will start on
        its own.
      </p>
      <button
        type="button"
        onClick={recheck}
        disabled={checking}
        className="mt-1 self-start inline-flex items-center gap-2 px-3 py-1.5 text-sm rounded bg-surface hover:bg-surface/60 disabled:opacity-40 cursor-pointer"
      >
        {checking ? (
          <Loader2 className="icon-sm animate-spin" />
        ) : (
          <RefreshCw className="icon-sm" />
        )}
        Check again
      </button>
    </EmptyState>
  )
}

function EmptyState({
  title,
  icon,
  children
}: {
  title: string
  icon: React.ReactNode
  children: React.ReactNode
}): JSX.Element {
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="drag-region h-10 shrink-0" />
      <div className="max-w-xl mx-auto px-6 pb-10 flex flex-col gap-3">
        <div className="flex items-center gap-2 text-lg font-semibold">
          {icon}
          <span>{title}</span>
        </div>
        {children}
      </div>
    </div>
  )
}

function Conversation({ sessionId }: { sessionId: string }): JSX.Element {
  const backend = useBackend()
  const session = useJsonClaudeSession(sessionId)
  const { pending, resolve } = useJsonClaudeApprovals(sessionId)
  const { jsonModeSendOnEnter: sendOnEnter } = useSettings()
  const [draft, setDraft] = useState('')
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  const entries = session?.entries ?? []
  const busy = session?.busy ?? false
  const isExited = session?.state === 'exited'

  useLayoutEffect(() => {
    const ta = textareaRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${ta.scrollHeight}px`
  }, [draft])

  // Naive follow-the-tail. The full chat's scroll-intent tracking is a
  // lot of machinery for a window that is mostly short exchanges; if
  // this proves annoying it's the first thing to port over.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [entries.length, busy])

  const send = useCallback(() => {
    const text = draft.trim()
    if (!text) return
    setDraft('')
    void backend.sendJsonClaudeMessage(sessionId, text)
  }, [backend, draft, sessionId])

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      const withMod = e.metaKey || e.ctrlKey
      if (e.key !== 'Enter') return
      if (sendOnEnter ? !e.shiftKey && !withMod : withMod) {
        e.preventDefault()
        send()
      }
    },
    [send, sendOnEnter]
  )

  const resultsByToolUseId = useMemo(() => {
    const map = new Map<string, { content: string; isError: boolean }>()
    for (const entry of entries) {
      if (entry.kind !== 'tool_result') continue
      for (const block of entry.blocks ?? []) {
        if (block.type !== 'tool_result' || !block.toolUseId) continue
        map.set(block.toolUseId, {
          content: block.content ?? '',
          isError: !!block.isError
        })
      }
    }
    return map
  }, [entries])

  const pendingByToolUseId = useMemo(() => {
    const map = new Map<string, JsonClaudePendingApproval>()
    for (const a of pending) {
      if (a.toolUseId) map.set(a.toolUseId, a)
    }
    return map
  }, [pending])

  // Approvals whose tool_use block hasn't landed in the transcript yet
  // (the permission request can beat the assistant message). Render them
  // at the tail so the user is never stuck with an invisible prompt.
  const orphanApprovals = pending.filter(
    (a) => !a.toolUseId || !entries.some((e) => hasToolUse(e, a.toolUseId!))
  )

  return (
    <>
      <header className="drag-region shrink-0 h-10 flex items-center justify-end gap-1 px-3 border-b border-border">
        <span className="text-xs text-muted mr-auto pl-20 no-drag">
          Ness assistant
        </span>
        <button
          type="button"
          title="Start a new conversation"
          onClick={() => void backend.globalChatReset()}
          className="no-drag p-1.5 rounded hover:bg-surface text-muted hover:text-fg cursor-pointer"
        >
          <Trash2 className="icon-sm" />
        </button>
      </header>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4">
        <div className="max-w-3xl mx-auto flex flex-col gap-3">
          {entries.length === 0 && !busy ? <Intro /> : null}
          {entries.map((entry) => (
            <EntryRow
              key={entry.entryId}
              entry={entry}
              resultsByToolUseId={resultsByToolUseId}
              pendingByToolUseId={pendingByToolUseId}
              onResolve={resolve}
            />
          ))}
          {orphanApprovals.map((a) => (
            <JsonClaudeApprovalCard
              key={a.requestId}
              approval={a}
              onResolve={(r) => resolve(a.requestId, r)}
            />
          ))}
          {isExited ? (
            <div className="text-xs text-muted italic">
              The assistant subprocess exited
              {session?.exitReason ? ` (${session.exitReason})` : ''}. Send a
              message to restart it.
            </div>
          ) : null}
        </div>
      </div>

      <div className="shrink-0 border-t border-border px-4 py-3">
        <div className="max-w-3xl mx-auto flex items-end gap-2">
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            placeholder="Ask about Ness, or tell it what to change…"
            className="flex-1 resize-none bg-surface rounded px-3 py-2 text-sm outline-none max-h-40 placeholder:text-muted"
          />
          {busy ? (
            <button
              type="button"
              title="Interrupt"
              onClick={() => void backend.interruptJsonClaude(sessionId)}
              className="p-2 rounded bg-surface hover:bg-surface/60 cursor-pointer"
            >
              <Square className="icon-sm" />
            </button>
          ) : null}
        </div>
      </div>
    </>
  )
}

function Intro(): JSX.Element {
  return (
    <div className="text-sm text-muted flex flex-col gap-2 py-6">
      <p className="text-fg font-medium">This chat is about Ness itself.</p>
      <p>
        It can change your settings, explain what things do, and read the debug
        log when something looks wrong. It can&apos;t edit your code — that
        belongs in a worktree chat.
      </p>
      <p>
        Try: &ldquo;switch me to a dark solarized theme&rdquo;, &ldquo;make the
        UI bigger&rdquo;, or &ldquo;what does hooks consent actually do?&rdquo;
      </p>
    </div>
  )
}

function hasToolUse(entry: JsonClaudeChatEntry, toolUseId: string): boolean {
  return (entry.blocks ?? []).some(
    (b) => b.type === 'tool_use' && b.id === toolUseId
  )
}

function EntryRow({
  entry,
  resultsByToolUseId,
  pendingByToolUseId,
  onResolve
}: {
  entry: JsonClaudeChatEntry
  resultsByToolUseId: Map<string, { content: string; isError: boolean }>
  pendingByToolUseId: Map<string, JsonClaudePendingApproval>
  onResolve: (requestId: string, result: ApprovalResult) => void
}): JSX.Element | null {
  if (entry.kind === 'tool_result') return null
  if (entry.kind === 'user') {
    return (
      <div className="self-end max-w-[85%] bg-brand/15 rounded px-3 py-2 text-sm whitespace-pre-wrap">
        {entry.text}
      </div>
    )
  }
  if (entry.kind === 'error') {
    return (
      <div className="text-xs rounded border border-danger/40 bg-danger/10 text-danger px-3 py-2">
        {entry.errorMessage || 'Something went wrong.'}
      </div>
    )
  }
  if (entry.kind === 'system' || entry.kind === 'compact') {
    return (
      <div className="text-xs text-muted italic">
        {entry.text || (entry.kind === 'compact' ? 'Conversation compacted' : '')}
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-2">
      {(entry.blocks ?? []).map((block, i) => (
        <BlockRow
          key={`${entry.entryId}-${i}`}
          block={block}
          isPartial={!!entry.isPartial}
          result={block.id ? resultsByToolUseId.get(block.id) : undefined}
          approval={block.id ? pendingByToolUseId.get(block.id) : undefined}
          onResolve={onResolve}
        />
      ))}
    </div>
  )
}

function BlockRow({
  block,
  isPartial,
  result,
  approval,
  onResolve
}: {
  block: JsonClaudeMessageBlock
  isPartial: boolean
  result?: { content: string; isError: boolean }
  approval?: JsonClaudePendingApproval
  onResolve: (requestId: string, result: ApprovalResult) => void
}): JSX.Element | null {
  if (block.type === 'thinking') {
    return <ThinkingBlock text={block.text || ''} />
  }
  if (block.type === 'tool_use') {
    return (
      <>
        {dispatchToolCard({ block, result })}
        {approval ? (
          <JsonClaudeApprovalCard
            approval={approval}
            onResolve={(r) => onResolve(approval.requestId, r)}
          />
        ) : null}
      </>
    )
  }
  if (block.type !== 'text' || !block.text) return null
  return (
    <div className="text-sm markdown leading-relaxed">
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS}>
        {block.text}
      </ReactMarkdown>
      {isPartial ? <span className="json-claude-cursor" /> : null}
    </div>
  )
}

function ThinkingBlock({ text }: { text: string }): JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className="text-xs text-muted">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 hover:text-fg cursor-pointer"
      >
        {open ? (
          <ChevronDown className="icon-2xs" />
        ) : (
          <ChevronRight className="icon-2xs" />
        )}
        <Brain className="icon-2xs" />
        Thinking
      </button>
      {open ? (
        <div className="mt-1 pl-4 whitespace-pre-wrap opacity-80">{text}</div>
      ) : null}
    </div>
  )
}

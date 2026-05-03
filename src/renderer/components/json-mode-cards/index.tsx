// Per-tool cards for json-claude assistant tool_use blocks. Each tool
// gets a small focused renderer; unknown tools fall through to the
// generic JSON-dump card. Cards lazy-grow new sections per tool — most
// of them are intentionally minimal (input summary in the chrome,
// result body in a <pre>) so adding e.g. WebFetch is a small addition.
//
// Lives in a sibling directory so the main JsonModeChat component
// stays focused on layout + scroll + input + statusbar.

import { useState, type ReactNode } from 'react'
import type { JsonClaudeMessageBlock } from '../../../shared/state/json-claude'

export interface ToolCardProps {
  block: JsonClaudeMessageBlock
  result?: { content: string; isError: boolean }
  autoApproved?: { model: string; reason: string; timestamp: number }
  sessionAllowed?: { toolName: string; timestamp: number }
  /** Sub-agent fields. Only set by the Task case; other cards ignore
   *  them. Threaded through dispatchToolCard so the renderer keeps the
   *  same call shape for every tool. */
  subAgentBody?: ReactNode
  subAgentChildCount?: number
  subAgentDescendantHasPendingApproval?: boolean
}

export function basename(p: string): string {
  return p.split('/').pop() || p
}

export function trunc(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s
}

const HARNESS_CONTROL_PREFIX = 'mcp__harness-control__'

export function isHarnessControl(name: string | undefined): boolean {
  return !!name && name.startsWith(HARNESS_CONTROL_PREFIX)
}

/** Strip the `mcp__harness-control__` prefix so `create_worktree` shows
 *  instead of the full mangled name. The brand gradient already conveys
 *  "this is a harness tool", so the prefix is redundant in the chrome. */
export function prettyToolName(name: string | undefined): string {
  if (!name) return 'Tool'
  if (name.startsWith(HARNESS_CONTROL_PREFIX)) {
    return name.slice(HARNESS_CONTROL_PREFIX.length)
  }
  return name
}

export function ToolCardChrome({
  name,
  subtitle,
  variant,
  isError,
  brand,
  autoApproved,
  sessionAllowed,
  children
}: {
  name: string
  subtitle: string
  variant: 'info' | 'warn'
  isError?: boolean
  brand?: boolean
  autoApproved?: { model: string; reason: string; timestamp: number }
  sessionAllowed?: { toolName: string; timestamp: number }
  children: ReactNode
}): JSX.Element {
  // Collapsed by default. Errors get a visible "error" badge in the
  // header so they're discoverable, but we don't force-expand — the
  // user can choose to drill in.
  const [expanded, setExpanded] = useState<boolean>(false)

  const ring = isError
    ? 'border-danger/50'
    : brand
      ? 'border-warning/40'
      : variant === 'warn'
        ? 'border-warning/30'
        : 'border-border'
  const headerBg = isError ? 'bg-danger/10' : 'bg-app/40'
  const headerHover = isError ? 'hover:bg-danger/15' : 'hover:bg-app/60'
  // `group` enables the .group:hover .brand-gradient-flow-text-hover rule
  // (same trick the Add worktree button uses) — animated flow on hover,
  // static gradient otherwise.
  const groupClass = brand ? 'group' : ''
  const nameClass = brand
    ? 'brand-gradient-text brand-gradient-flow-text-hover'
    : 'text-accent'

  return (
    <div
      className={`my-2 border ${ring} bg-panel overflow-hidden`}
      style={{ borderRadius: 'var(--chat-bubble-radius)' }}
    >
      {brand && <div className="brand-gradient-bg h-0.5" />}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className={`${groupClass} w-full flex items-center gap-2 ${expanded ? 'border-b border-border' : ''} ${headerBg} ${headerHover} cursor-pointer transition-colors text-left`}
        style={{
          paddingInline: 'var(--chat-chrome-px)',
          paddingBlock: 'var(--chat-chrome-py)',
          fontSize: 'var(--chat-chrome-text)'
        }}
      >
        <span className="text-muted text-[9px] w-2 shrink-0 select-none">
          {expanded ? '▾' : '▸'}
        </span>
        <span
          className={`font-semibold shrink-0 ${nameClass}`}
          style={{ fontFamily: 'var(--chat-tool-name-family)' }}
        >
          {name}
        </span>
        <span className="opacity-70 truncate flex-1 min-w-0">{subtitle}</span>
        {autoApproved && (
          <span
            title={`auto-approved by ${autoApproved.model} · ${autoApproved.reason}`}
            className="uppercase tracking-wide text-muted bg-app/60 border border-border/50 rounded px-1 py-0.5 shrink-0"
            style={{ fontSize: 'var(--chat-meta-text)' }}
          >
            auto · haiku
          </span>
        )}
        {sessionAllowed && (
          <span
            title={`allowed by session policy · ${sessionAllowed.toolName}`}
            className="uppercase tracking-wide text-muted bg-app/60 border border-border/50 rounded px-1 py-0.5 shrink-0"
            style={{ fontSize: 'var(--chat-meta-text)' }}
          >
            session
          </span>
        )}
        {isError && (
          <span
            className="uppercase tracking-wide text-danger shrink-0"
            style={{ fontSize: 'var(--chat-meta-text)' }}
          >
            error
          </span>
        )}
      </button>
      {expanded && children}
    </div>
  )
}

import { ReadCard } from './ReadCard'
import { EditCard } from './EditCard'
import { MultiEditCard } from './MultiEditCard'
import { WriteCard } from './WriteCard'
import { BashCard } from './BashCard'
import { GrepCard } from './GrepCard'
import { GlobCard } from './GlobCard'
import { TodoWriteCard } from './TodoWriteCard'
import { TaskCard } from './TaskCard'
import { GenericToolCard } from './GenericToolCard'

export function dispatchToolCard(props: ToolCardProps): JSX.Element {
  switch (props.block.name) {
    case 'Read':
      return <ReadCard {...props} />
    case 'Edit':
      return <EditCard {...props} />
    case 'MultiEdit':
      return <MultiEditCard {...props} />
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
    // 'Task' (older Claude Code) and 'Agent' (2.1.126+) both route to
    // the subagent runner — render either as TaskCard.
    case 'Task':
    case 'Agent':
      return (
        <TaskCard
          {...props}
          subAgentBody={props.subAgentBody ?? null}
          subAgentChildCount={props.subAgentChildCount ?? 0}
          subAgentDescendantHasPendingApproval={
            props.subAgentDescendantHasPendingApproval ?? false
          }
        />
      )
    default:
      return <GenericToolCard {...props} />
  }
}

// Per-tool cards for json-claude assistant tool_use blocks. Each tool
// gets a small focused renderer; unknown tools fall through to the
// generic JSON-dump card. Cards lazy-grow new sections per tool — most
// of them are intentionally minimal (input summary in the chrome,
// result body in a <pre>) so adding e.g. WebFetch is a small addition.
//
// Lives in a sibling directory so the main JsonModeChat component
// stays focused on layout + scroll + input + statusbar.

import type { ReactNode } from 'react'
import type { JsonClaudeMessageBlock } from '../../../shared/state/json-claude'

export interface ToolCardProps {
  block: JsonClaudeMessageBlock
  result?: { content: string; isError: boolean }
}

export function basename(p: string): string {
  return p.split('/').pop() || p
}

export function trunc(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s
}

export function ToolCardChrome({
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

import { ReadCard } from './ReadCard'
import { EditCard } from './EditCard'
import { WriteCard } from './WriteCard'
import { BashCard } from './BashCard'
import { GrepCard } from './GrepCard'
import { GlobCard } from './GlobCard'
import { TodoWriteCard } from './TodoWriteCard'
import { GenericToolCard } from './GenericToolCard'

export function dispatchToolCard(props: ToolCardProps): JSX.Element {
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

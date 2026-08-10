import { useEffect, useState } from 'react'
import { ExternalLink, RotateCw } from 'lucide-react'
import { RightPanel } from './RightPanel'
import { Tooltip } from './Tooltip'
import { TicketProviderIcon } from './TicketProvidersSettings'
import {
  useCachedTicket,
  useTicketProviders,
  useWorktreeLinkedTicket
} from '../store'
import { useBackend } from '../backend'
import type { Ticket } from '../../shared/tickets'

interface TicketPanelProps {
  worktreePath: string | null
}

/** Right-column panel showing the full details of the ticket a worktree
 *  was spawned from. Renders nothing when the worktree has no linked
 *  ticket, so the panel only appears where it's relevant. Details beyond
 *  the generalizable fields (labels, comments, assignees) stay in the
 *  provider's native UI — the "Open" action jumps there.
 *
 *  The store's ticket cache is only populated by `tickets:list` (the
 *  full-surface Tickets view), so it may be cold here. We therefore read
 *  the cache as a fast-path but fetch through `ticketsGet` and hold the
 *  returned Ticket in local state — otherwise a worktree whose provider
 *  was never listed would spin forever. */
export function TicketPanel({ worktreePath }: TicketPanelProps): JSX.Element | null {
  const link = useWorktreeLinkedTicket(worktreePath)
  const cached = useCachedTicket(link)
  const providers = useTicketProviders()
  const backend = useBackend()
  const [fetched, setFetched] = useState<Ticket | null>(null)
  const [loading, setLoading] = useState(false)

  const linkKey = link ? `${link.providerId}:${link.externalId}` : null

  useEffect(() => {
    if (!link) {
      setFetched(null)
      return
    }
    let cancelled = false
    setLoading(true)
    void backend
      .ticketsGet(link.providerId, link.externalId)
      .then((t) => {
        if (!cancelled) setFetched(t)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkKey])

  if (!link) return null

  const provider = providers.find((p) => p.id === link.providerId) ?? null
  const ticket = cached ?? fetched

  const handleRefresh = async (): Promise<void> => {
    setLoading(true)
    try {
      const t = await backend.ticketsGet(link.providerId, link.externalId)
      setFetched(t)
    } finally {
      setLoading(false)
    }
  }

  const actions = (
    <>
      <Tooltip label="Refresh ticket">
        <button
          onClick={handleRefresh}
          className="text-dim hover:text-fg hover:bg-surface rounded p-0.5 transition-colors cursor-pointer"
          aria-label="Refresh ticket"
        >
          <RotateCw className={`icon-xs ${loading ? 'animate-spin' : ''}`} />
        </button>
      </Tooltip>
      {ticket?.url && (
        <Tooltip label="Open ticket in browser">
          <button
            onClick={() => ticket.url && backend.openExternal(ticket.url)}
            className="text-dim hover:text-fg hover:bg-surface rounded p-0.5 transition-colors cursor-pointer"
            aria-label="Open ticket in browser"
          >
            <ExternalLink className="icon-xs" />
          </button>
        </Tooltip>
      )}
    </>
  )

  return (
    <RightPanel id="ticket" title="Ticket" actions={actions}>
      <div className="px-3 py-2 flex flex-col gap-2">
        <div className="flex items-center gap-1.5 text-xs text-faint">
          {provider && (
            <TicketProviderIcon type={provider.type} className="icon-2xs shrink-0" />
          )}
          {provider && <span className="truncate">{provider.label}</span>}
          <span className="text-dim">·</span>
          <span className="tabular-nums shrink-0">{link.externalId}</span>
          {ticket?.status && (
            <span className="ml-auto shrink-0 rounded-full bg-panel-raised border border-border-strong px-1.5 py-0.5 text-xs text-dim">
              {ticket.status}
            </span>
          )}
        </div>

        <div className="text-sm font-medium text-text break-words">
          {ticket?.title ?? `#${link.externalId}`}
        </div>

        {ticket ? (
          ticket.description ? (
            <div className="text-xs text-muted whitespace-pre-wrap break-words max-h-96 overflow-y-auto leading-relaxed">
              {ticket.description}
            </div>
          ) : (
            <div className="text-xs text-faint italic">No description.</div>
          )
        ) : loading ? (
          <div className="text-xs text-faint italic">Loading ticket…</div>
        ) : (
          <div className="text-xs text-faint italic">
            Ticket details unavailable.
          </div>
        )}
      </div>
    </RightPanel>
  )
}

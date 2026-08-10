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

interface TicketPanelProps {
  worktreePath: string | null
}

/** Right-column panel showing the full details of the ticket a worktree
 *  was spawned from. Renders nothing when the worktree has no linked
 *  ticket, so the panel only appears where it's relevant. Details beyond
 *  the generalizable fields (labels, comments, assignees) stay in the
 *  provider's native UI — the "Open" action jumps there. */
export function TicketPanel({ worktreePath }: TicketPanelProps): JSX.Element | null {
  const link = useWorktreeLinkedTicket(worktreePath)
  const cached = useCachedTicket(link)
  const providers = useTicketProviders()
  const backend = useBackend()
  const [refreshing, setRefreshing] = useState(false)

  // Populate / refresh the cache whenever the linked ticket changes.
  useEffect(() => {
    if (link) void backend.ticketsGet(link.providerId, link.externalId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [link])

  if (!link) return null

  const provider = providers.find((p) => p.id === link.providerId) ?? null

  const handleRefresh = async (): Promise<void> => {
    setRefreshing(true)
    try {
      await backend.ticketsGet(link.providerId, link.externalId)
    } finally {
      setRefreshing(false)
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
          <RotateCw className={`icon-xs ${refreshing ? 'animate-spin' : ''}`} />
        </button>
      </Tooltip>
      {cached?.url && (
        <Tooltip label="Open ticket in browser">
          <button
            onClick={() => cached.url && backend.openExternal(cached.url)}
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
          {cached?.status && (
            <span className="ml-auto shrink-0 rounded-full bg-panel-raised border border-border-strong px-1.5 py-0.5 text-xs text-dim">
              {cached.status}
            </span>
          )}
        </div>

        <div className="text-sm font-medium text-text break-words">
          {cached?.title ?? `#${link.externalId}`}
        </div>

        {cached?.description ? (
          <div className="text-xs text-muted whitespace-pre-wrap break-words max-h-96 overflow-y-auto leading-relaxed">
            {cached.description}
          </div>
        ) : cached ? (
          <div className="text-xs text-faint italic">No description.</div>
        ) : (
          <div className="text-xs text-faint italic">Loading ticket…</div>
        )}
      </div>
    </RightPanel>
  )
}

// Full-surface "Tickets" view — takes over the right-hand pane (main + tools)
// while leaving the worktree sidebar visible, same shell pattern as Activity.
//
// Single-provider-at-a-time: a dropdown in the header selects which
// configured provider's tickets to show. Selection persists in
// localStorage. Two view modes (persisted separately): list (stacked
// buckets) and board (kanban columns). Buckets come from each
// provider's raw status values with ordering / collapse defaults from
// its saved bucketOrder / collapsedBuckets on the provider config.
//
// Row (or card) click behavior: jump to the worktree if the ticket
// already has one (any repo, not just the provider's default), else
// open the New Worktree screen preseeded from the ticket.

import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, RefreshCw, Loader2, ExternalLink, GitBranch, AlertCircle, ChevronDown, ChevronRight, Rows3, LayoutGrid } from 'lucide-react'
import type { Worktree } from '../types'
import type {
  Ticket,
  TicketProviderConfig,
  WorktreeTicketLink
} from '../../shared/tickets'
import { NO_STATUS_BUCKET, mergeBucketOrder, unionCollapsedBuckets } from '../../shared/tickets'
import { useBackend } from '../backend'
import { useTicketProviders } from '../store'
import { TicketProviderIcon } from './TicketProvidersSettings'

type TicketsViewMode = 'list' | 'board'

interface TicketsProps {
  onClose: () => void
  worktrees: Worktree[]
  /** Called when the user clicks a ticket that already has a worktree.
   *  Selects the worktree in the sidebar and closes the Tickets view. */
  onJumpToWorktree: (worktreePath: string) => void
  /** Called when the user clicks a ticket that has no worktree yet.
   *  Opens the New Worktree screen preseeded from the ticket. `repoRoot`
   *  is a best-guess default (the provider's first applies-to repo);
   *  the user can still swap in the modal. */
  onSpawnFromTicket: (ticket: Ticket, provider: TicketProviderConfig, repoRoot: string) => void
  onOpenSettings?: () => void
}

interface FetchedRow {
  ticket: Ticket
  provider: TicketProviderConfig
  /** Best-guess repo root to spawn a worktree into if the user clicks a
   *  card that isn't linked to one yet. First from `provider.appliesToRepoRoots`. */
  repoRoot: string
  /** Existing worktree (any repo) that was spawned from this ticket. Null
   *  when the user hasn't started work yet. */
  linkedWorktree: Worktree | null
}

interface FetchState {
  loading: boolean
  rows: FetchedRow[]
  /** Provider-level failure message when the fetch throws. Empty when
   *  the call succeeded (even if it returned zero tickets). */
  error: string | null
}

const INITIAL_FETCH: FetchState = { loading: false, rows: [], error: null }

/** Locate a worktree whose linked ticket matches the given provider +
 *  external id, regardless of which repo the worktree lives in. Since a
 *  single provider can span multiple `appliesToRepoRoots`, and the ticket
 *  itself has no intrinsic repo, we search all worktrees. */
function findLinkedWorktree(
  worktrees: Worktree[],
  providerId: string,
  externalId: string
): Worktree | null {
  for (const wt of worktrees) {
    const link: WorktreeTicketLink | undefined = wt.linkedTicket
    if (link && link.providerId === providerId && link.externalId === externalId) return wt
  }
  return null
}

export function Tickets({
  onClose,
  worktrees,
  onJumpToWorktree,
  onSpawnFromTicket,
  onOpenSettings
}: TicketsProps): JSX.Element {
  const backend = useBackend()
  const providers = useTicketProviders()
  const [state, setState] = useState<FetchState>(INITIAL_FETCH)
  // View mode toggle — persisted in localStorage so it survives reloads.
  // Board = columns per bucket, list = stacked buckets.
  const [viewMode, setViewMode] = useState<TicketsViewMode>(() => {
    if (typeof localStorage === 'undefined') return 'list'
    return localStorage.getItem('harness:tickets:viewMode') === 'board' ? 'board' : 'list'
  })
  useEffect(() => {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('harness:tickets:viewMode', viewMode)
    }
  }, [viewMode])
  // Selected provider — single-provider-at-a-time is the whole shape of
  // this view. Persisted in localStorage so returning users land where
  // they left off. When the saved id doesn't exist (provider removed),
  // fall back to the first provider alphabetically.
  const [selectedProviderId, setSelectedProviderIdRaw] = useState<string | null>(() => {
    if (typeof localStorage === 'undefined') return null
    return localStorage.getItem('harness:tickets:selectedProviderId')
  })
  const setSelectedProviderId = (id: string | null): void => {
    setSelectedProviderIdRaw(id)
    if (typeof localStorage !== 'undefined') {
      if (id) localStorage.setItem('harness:tickets:selectedProviderId', id)
      else localStorage.removeItem('harness:tickets:selectedProviderId')
    }
  }
  const selectedProvider = useMemo(
    () => providers.find((p) => p.id === selectedProviderId) ?? providers[0] ?? null,
    [providers, selectedProviderId]
  )
  // Snap the persisted selection to the effective one so a saved id
  // that no longer exists gets rewritten to whatever we're actually
  // rendering.
  useEffect(() => {
    if (selectedProvider && selectedProvider.id !== selectedProviderId) {
      setSelectedProviderId(selectedProvider.id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProvider?.id])

  // Fetch just the selected provider's tickets. Each row's repoRoot is
  // the provider's first applies-to entry (used as the default spawn
  // target); the actual worktree lookup below scans all worktrees so a
  // ticket that's already been spawned in ANY of the provider's repos
  // shows the correct linked chip.
  const load = async (): Promise<void> => {
    if (!selectedProvider) {
      setState(INITIAL_FETCH)
      return
    }
    const provider = selectedProvider
    const defaultRepoRoot =
      provider.appliesToRepoRoots && provider.appliesToRepoRoots.length > 0
        ? provider.appliesToRepoRoots[0]
        : ''
    setState((s) => ({ ...s, loading: true }))
    try {
      const tickets = await backend.ticketsList(provider.id)
      const rows: FetchedRow[] = tickets.map((ticket) => ({
        ticket,
        provider,
        repoRoot: defaultRepoRoot,
        linkedWorktree: findLinkedWorktree(worktrees, provider.id, ticket.externalId)
      }))
      setState({ loading: false, rows, error: null })
    } catch (err) {
      setState({
        loading: false,
        rows: [],
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProvider?.id, worktrees])

  const totalCount = state.rows.length
  const withWorktree = state.rows.filter((r) => r.linkedWorktree).length

  return (
    <div className="flex flex-col h-full w-full bg-panel">
      <div className="drag-region h-10 shrink-0 border-b border-border relative">
        <button
          onClick={onClose}
          className="no-drag absolute left-4 top-1/2 -translate-y-1/2 flex items-center gap-1.5 text-xs text-muted hover:text-fg-bright transition-colors cursor-pointer"
        >
          <ArrowLeft className="icon-sm" />
          Back
        </button>
        <div className="no-drag absolute left-1/2 -translate-x-1/2 top-1/2 -translate-y-1/2 flex items-center gap-2">
          <span className="text-sm font-medium text-fg">Tickets</span>
          {providers.length > 0 && (
            <>
              <span className="text-faint">·</span>
              <select
                value={selectedProvider?.id ?? ''}
                onChange={(e) => setSelectedProviderId(e.target.value || null)}
                className="bg-app border border-border-strong rounded px-2 py-0.5 text-xs text-fg-bright outline-none focus:border-accent cursor-pointer max-w-[16rem] truncate"
                aria-label="Select provider"
              >
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </>
          )}
        </div>
        <div className="no-drag absolute right-4 top-1/2 -translate-y-1/2 flex items-center gap-2">
          <div className="flex items-center rounded overflow-hidden border border-border-strong">
            <button
              onClick={() => setViewMode('list')}
              className={`p-1 transition-colors cursor-pointer ${
                viewMode === 'list'
                  ? 'bg-surface text-fg-bright'
                  : 'text-muted hover:text-fg-bright hover:bg-surface/50'
              }`}
              title="List view"
              aria-label="List view"
              aria-pressed={viewMode === 'list'}
            >
              <Rows3 className="icon-sm" />
            </button>
            <button
              onClick={() => setViewMode('board')}
              className={`p-1 transition-colors cursor-pointer ${
                viewMode === 'board'
                  ? 'bg-surface text-fg-bright'
                  : 'text-muted hover:text-fg-bright hover:bg-surface/50'
              }`}
              title="Board view"
              aria-label="Board view"
              aria-pressed={viewMode === 'board'}
            >
              <LayoutGrid className="icon-sm" />
            </button>
          </div>
          <button
            onClick={() => void load()}
            disabled={state.loading}
            className="text-muted hover:text-fg-bright transition-colors cursor-pointer p-1 disabled:opacity-40 disabled:cursor-not-allowed"
            title="Refresh"
          >
            {state.loading ? (
              <Loader2 className="icon-sm animate-spin" />
            ) : (
              <RefreshCw className="icon-sm" />
            )}
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        {providers.length === 0 ? (
          <div className="px-6 py-6">
            <TicketsEmpty kind="no-providers" onOpenSettings={onOpenSettings} />
          </div>
        ) : !selectedProvider ? null : totalCount === 0 && !state.loading && !state.error ? (
          <div className="px-6 py-6">
            <TicketsEmpty kind="no-tickets" onOpenSettings={onOpenSettings} />
          </div>
        ) : (
          <>
            <div className="px-6 pt-4 shrink-0 flex items-center gap-3 text-xs text-dim">
              <span>
                <span className="text-fg-bright font-medium">{totalCount}</span> ticket
                {totalCount === 1 ? '' : 's'}
              </span>
              <span className="text-faint">·</span>
              <span>
                <span className="text-fg-bright font-medium">{withWorktree}</span> with worktree
              </span>
            </div>

            {state.error && (
              <div className="mx-6 mt-3 shrink-0 flex items-center gap-2 px-3 py-2 text-xs text-warning bg-warning/10 border border-warning/30 rounded">
                <AlertCircle className="icon-xs shrink-0" />
                <span className="font-medium">{selectedProvider.label}:</span>
                <span className="font-mono truncate">{state.error}</span>
              </div>
            )}

            <div className="flex-1 min-h-0 flex flex-col">
              <TicketsSection
                rows={state.rows}
                viewMode={viewMode}
                onJumpToWorktree={onJumpToWorktree}
                onSpawnFromTicket={onSpawnFromTicket}
              />
            </div>
          </>
        )}
      </div>
    </div>
  )
}

interface TicketsSectionProps {
  rows: FetchedRow[]
  viewMode: TicketsViewMode
  onJumpToWorktree: (worktreePath: string) => void
  onSpawnFromTicket: (ticket: Ticket, provider: TicketProviderConfig, repoRoot: string) => void
}

/** Group the rows by their raw `status` string (or NO_STATUS_BUCKET when
 *  unset) into a bucket → rows map, along with the seen-in-order list of
 *  bucket names for use in `mergeBucketOrder`. Preserves the order in
 *  which statuses first appear across the fetched rows. */
function bucketRowsByStatus(rows: FetchedRow[]): {
  byBucket: Map<string, FetchedRow[]>
  seenOrder: string[]
} {
  const byBucket = new Map<string, FetchedRow[]>()
  const seenOrder: string[] = []
  for (const row of rows) {
    const bucket = row.ticket.status ?? NO_STATUS_BUCKET
    let arr = byBucket.get(bucket)
    if (!arr) {
      arr = []
      byBucket.set(bucket, arr)
      seenOrder.push(bucket)
    }
    arr.push(row)
  }
  return { byBucket, seenOrder }
}

function TicketsSection({
  rows,
  viewMode,
  onJumpToWorktree,
  onSpawnFromTicket
}: TicketsSectionProps): JSX.Element {
  // The whole section is one provider's tickets. Its saved bucketOrder +
  // collapsedBuckets drive the rendering.
  const providersInSection = useMemo(() => {
    const byId = new Map<string, TicketProviderConfig>()
    for (const row of rows) byId.set(row.provider.id, row.provider)
    return Array.from(byId.values())
  }, [rows])

  const { byBucket, seenOrder } = useMemo(() => bucketRowsByStatus(rows), [rows])
  const bucketOrder = useMemo(
    () => mergeBucketOrder(providersInSection, seenOrder),
    [providersInSection, seenOrder]
  )
  const collapsedByDefault = useMemo(
    () => unionCollapsedBuckets(providersInSection),
    [providersInSection]
  )

  if (rows.length === 0) {
    return (
      <div className="px-6 py-6">
        <p className="text-xs text-faint px-3 py-2 border border-dashed border-border rounded">
          No tickets returned by this provider.
        </p>
      </div>
    )
  }
  if (viewMode === 'board') {
    return (
      <TicketsBoard
        bucketOrder={bucketOrder}
        byBucket={byBucket}
        collapsedByDefault={collapsedByDefault}
        onJumpToWorktree={onJumpToWorktree}
        onSpawnFromTicket={onSpawnFromTicket}
      />
    )
  }
  return (
    <div className="flex-1 min-h-0 overflow-y-auto px-6 pt-4 pb-6">
      {bucketOrder.map((bucket) => (
        <TicketBucket
          key={bucket}
          label={bucket}
          rows={byBucket.get(bucket) ?? []}
          defaultCollapsed={collapsedByDefault.has(bucket)}
          onJumpToWorktree={onJumpToWorktree}
          onSpawnFromTicket={onSpawnFromTicket}
        />
      ))}
    </div>
  )
}

interface TicketBucketProps {
  label: string
  rows: FetchedRow[]
  defaultCollapsed: boolean
  onJumpToWorktree: (worktreePath: string) => void
  onSpawnFromTicket: (ticket: Ticket, provider: TicketProviderConfig, repoRoot: string) => void
}

function TicketBucket({
  label,
  rows,
  defaultCollapsed,
  onJumpToWorktree,
  onSpawnFromTicket
}: TicketBucketProps): JSX.Element {
  const [collapsed, setCollapsed] = useState(defaultCollapsed)
  return (
    <div className="mb-4">
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        className="w-full flex items-center gap-1 text-xs font-semibold uppercase tracking-wider text-dim hover:text-fg mb-1.5 cursor-pointer"
      >
        {collapsed ? (
          <ChevronRight className="icon-xs" />
        ) : (
          <ChevronDown className="icon-xs" />
        )}
        <span>{label}</span>
        <span className="text-faint normal-case font-normal">({rows.length})</span>
      </button>
      {!collapsed && (
        <div className="border border-border rounded overflow-hidden">
          {rows.map((row, i) => (
            <TicketRow
              key={`${row.provider.id}:${row.ticket.externalId}:${i}`}
              row={row}
              onJumpToWorktree={onJumpToWorktree}
              onSpawnFromTicket={onSpawnFromTicket}
            />
          ))}
        </div>
      )}
    </div>
  )
}

interface TicketRowProps {
  row: FetchedRow
  onJumpToWorktree: (worktreePath: string) => void
  onSpawnFromTicket: (ticket: Ticket, provider: TicketProviderConfig, repoRoot: string) => void
}

function TicketRow({ row, onJumpToWorktree, onSpawnFromTicket }: TicketRowProps): JSX.Element {
  const backend = useBackend()
  const { ticket, provider, linkedWorktree } = row
  const showExternalId = provider.type === 'github-issues'
  const descriptionLine = ticket.description ? ticket.description.split('\n')[0] : ''

  const handleClick = (): void => {
    if (linkedWorktree) {
      onJumpToWorktree(linkedWorktree.path)
    } else {
      onSpawnFromTicket(ticket, provider, row.repoRoot)
    }
  }

  const handleOpenExternal = (e: React.MouseEvent): void => {
    e.stopPropagation()
    if (ticket.url) backend.openExternal(ticket.url)
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      className="w-full text-left px-3 py-2.5 border-b border-border last:border-b-0 hover:bg-panel-raised transition-colors cursor-pointer flex items-start gap-3"
      title={ticket.title}
    >
      <TicketProviderIcon
        type={provider.type}
        className="icon-xs text-dim shrink-0 mt-0.5"
      />
      {showExternalId && (
        <span
          className="text-xs font-mono text-faint shrink-0 mt-0.5"
          title={`External id: ${ticket.externalId}`}
        >
          #{ticket.externalId}
        </span>
      )}
      <div className="flex-1 min-w-0">
        <div className="text-sm text-fg-bright font-medium line-clamp-2 break-words">
          {ticket.title}
        </div>
        {(descriptionLine || linkedWorktree) && (
          <div className="mt-0.5 flex items-center gap-1.5 text-xs text-dim">
            {linkedWorktree && (
              <span className="inline-flex items-center gap-1 text-success shrink-0">
                <GitBranch className="icon-2xs" />
                <span className="truncate max-w-[12rem]">{linkedWorktree.branch}</span>
              </span>
            )}
            {linkedWorktree && descriptionLine && (
              <span className="text-faint shrink-0">·</span>
            )}
            {descriptionLine && <span className="truncate">{descriptionLine}</span>}
          </div>
        )}
      </div>
      {ticket.url && (
        <button
          type="button"
          onClick={handleOpenExternal}
          className="text-faint hover:text-fg p-1 rounded shrink-0 cursor-pointer"
          title="Open in browser"
          aria-label="Open ticket in browser"
        >
          <ExternalLink className="icon-xs" />
        </button>
      )}
    </button>
  )
}

interface TicketsEmptyProps {
  kind: 'no-providers' | 'no-tickets'
  onOpenSettings?: () => void
}

function TicketsEmpty({ kind, onOpenSettings }: TicketsEmptyProps): JSX.Element {
  if (kind === 'no-providers') {
    return (
      <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
        <p className="text-sm text-dim">No ticket providers configured.</p>
        <p className="text-xs text-faint max-w-md">
          Add a GitHub Issues or Notion provider in Settings → Ticket Providers, then tick the
          projects it applies to.
        </p>
        {onOpenSettings && (
          <button
            type="button"
            onClick={onOpenSettings}
            className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 bg-surface hover:bg-surface-hover rounded text-sm text-fg-bright transition-colors cursor-pointer"
          >
            Open settings
          </button>
        )}
      </div>
    )
  }
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
      <p className="text-sm text-dim">No tickets found.</p>
      <p className="text-xs text-faint max-w-md">
        Every configured provider returned an empty list. Check the provider's filter — if you're
        looking at GitHub, make sure the repo has open issues. If Notion, make sure the
        integration has been shared with the database.
      </p>
    </div>
  )
}

interface TicketsBoardProps {
  bucketOrder: string[]
  byBucket: Map<string, FetchedRow[]>
  collapsedByDefault: Set<string>
  onJumpToWorktree: (worktreePath: string) => void
  onSpawnFromTicket: (ticket: Ticket, provider: TicketProviderConfig, repoRoot: string) => void
}

/** Kanban-style board for a single section. Each bucket becomes a
 *  vertically-scrolling column of cards; the board itself
 *  horizontally-scrolls when the column set is wider than the pane.
 *  Collapsed columns render as a narrow rail so the user can see
 *  everything at a glance without full-collapsing them out of sight. */
function TicketsBoard({
  bucketOrder,
  byBucket,
  collapsedByDefault,
  onJumpToWorktree,
  onSpawnFromTicket
}: TicketsBoardProps): JSX.Element {
  return (
    <div className="flex-1 min-h-0 overflow-x-auto px-6 pt-4 pb-4">
      <div className="flex gap-3 min-w-max h-full">
        {bucketOrder.map((bucket) => (
          <TicketColumn
            key={bucket}
            label={bucket}
            rows={byBucket.get(bucket) ?? []}
            defaultCollapsed={collapsedByDefault.has(bucket)}
            onJumpToWorktree={onJumpToWorktree}
            onSpawnFromTicket={onSpawnFromTicket}
          />
        ))}
      </div>
    </div>
  )
}

interface TicketColumnProps {
  label: string
  rows: FetchedRow[]
  defaultCollapsed: boolean
  onJumpToWorktree: (worktreePath: string) => void
  onSpawnFromTicket: (ticket: Ticket, provider: TicketProviderConfig, repoRoot: string) => void
}

function TicketColumn({
  label,
  rows,
  defaultCollapsed,
  onJumpToWorktree,
  onSpawnFromTicket
}: TicketColumnProps): JSX.Element {
  const [collapsed, setCollapsed] = useState(defaultCollapsed)
  if (collapsed) {
    return (
      <button
        type="button"
        onClick={() => setCollapsed(false)}
        className="shrink-0 w-8 h-full bg-app/50 border border-border rounded flex flex-col items-center gap-2 py-3 hover:bg-app hover:border-border-strong transition-colors cursor-pointer"
        title={`Expand ${label} (${rows.length})`}
        aria-label={`Expand ${label} bucket, ${rows.length} tickets`}
      >
        <ChevronRight className="icon-xs text-faint" />
        <span
          className="text-xs font-semibold uppercase tracking-wider text-dim whitespace-nowrap"
          style={{ writingMode: 'vertical-rl' }}
        >
          {label}
        </span>
        <span className="text-xs text-faint">{rows.length}</span>
      </button>
    )
  }
  return (
    <div className="shrink-0 w-64 h-full flex flex-col bg-app/40 border border-border rounded">
      <button
        type="button"
        onClick={() => setCollapsed(true)}
        className="shrink-0 flex items-center gap-1 px-2.5 py-2 border-b border-border text-xs font-semibold uppercase tracking-wider text-dim hover:text-fg cursor-pointer"
      >
        <ChevronDown className="icon-xs" />
        <span className="flex-1 text-left truncate">{label}</span>
        <span className="text-faint normal-case font-normal">{rows.length}</span>
      </button>
      <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-2">
        {rows.length === 0 ? (
          <p className="text-xs text-faint text-center py-4">Empty</p>
        ) : (
          rows.map((row, i) => (
            <TicketCard
              key={`${row.provider.id}:${row.ticket.externalId}:${i}`}
              row={row}
              onJumpToWorktree={onJumpToWorktree}
              onSpawnFromTicket={onSpawnFromTicket}
            />
          ))
        )}
      </div>
    </div>
  )
}

interface TicketCardProps {
  row: FetchedRow
  onJumpToWorktree: (worktreePath: string) => void
  onSpawnFromTicket: (ticket: Ticket, provider: TicketProviderConfig, repoRoot: string) => void
}

function TicketCard({ row, onJumpToWorktree, onSpawnFromTicket }: TicketCardProps): JSX.Element {
  const backend = useBackend()
  const { ticket, provider, linkedWorktree } = row
  const showExternalId = provider.type === 'github-issues'

  const handleClick = (): void => {
    if (linkedWorktree) {
      onJumpToWorktree(linkedWorktree.path)
    } else {
      onSpawnFromTicket(ticket, provider, row.repoRoot)
    }
  }

  const handleOpenExternal = (e: React.MouseEvent): void => {
    e.stopPropagation()
    if (ticket.url) backend.openExternal(ticket.url)
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      className="w-full text-left bg-panel border border-border-strong rounded p-2 hover:border-accent transition-colors cursor-pointer group"
      title={ticket.title}
    >
      <div className="flex items-center gap-1.5 text-xs text-faint mb-1">
        <TicketProviderIcon type={provider.type} className="icon-2xs shrink-0" />
        {showExternalId && (
          <span className="font-mono">#{ticket.externalId}</span>
        )}
        {ticket.url && (
          <button
            type="button"
            onClick={handleOpenExternal}
            className="ml-auto text-faint hover:text-fg opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
            title="Open in browser"
            aria-label="Open ticket in browser"
          >
            <ExternalLink className="icon-2xs" />
          </button>
        )}
      </div>
      <div className="text-sm text-fg-bright font-medium line-clamp-2 break-words">
        {ticket.title}
      </div>
      {linkedWorktree && (
        <div className="mt-1.5 inline-flex items-center gap-1 text-xs text-success">
          <GitBranch className="icon-2xs" />
          <span className="truncate max-w-[13rem]">{linkedWorktree.branch}</span>
        </div>
      )}
    </button>
  )
}

// Full-surface "Tickets" view — takes over the right-hand pane (main + tools)
// while leaving the worktree sidebar visible, same shell pattern as Activity.
// v1 lists tickets grouped either by repo (split mode) or in one flat list
// (unified mode), matching the sidebar's own toggle. Each ticket row shows
// its linked worktree (if any) so the user can either jump to the worktree
// or spawn a new one via the "Open" affordance.

import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, RefreshCw, Loader2, ExternalLink, GitBranch, AlertCircle } from 'lucide-react'
import type { Worktree } from '../types'
import type {
  Ticket,
  TicketProviderConfig,
  WorktreeTicketLink
} from '../../shared/tickets'
import { useBackend } from '../backend'
import { useTicketProviders } from '../store'
import { TicketProviderIcon } from './TicketProvidersSettings'
import { RepoIcon, repoNameColor } from './RepoIcon'

interface TicketsProps {
  onClose: () => void
  /** Repo roots to render sections for. Iterate this instead of pulling
   *  from the store so the caller keeps ordering + selection control. */
  repoRoots: string[]
  worktrees: Worktree[]
  /** When true, one flat list; when false, group by repo with headers.
   *  Mirrors the sidebar toggle. */
  unifiedRepos: boolean
  /** Called when the user clicks a ticket that already has a worktree.
   *  Selects the worktree in the sidebar and closes the Tickets view. */
  onJumpToWorktree: (worktreePath: string) => void
  /** Called when the user clicks "Open" on a ticket that has no worktree
   *  yet. Opens the New Worktree screen preseeded from the ticket. */
  onSpawnFromTicket: (ticket: Ticket, provider: TicketProviderConfig, repoRoot: string) => void
  onOpenSettings?: () => void
}

interface FetchedRow {
  ticket: Ticket
  provider: TicketProviderConfig
  /** Repo root this row belongs to (for split-mode grouping). */
  repoRoot: string
  /** Worktree at this repo that was spawned from this ticket, if any. */
  linkedWorktree: Worktree | null
}

interface FetchState {
  loading: boolean
  /** Aggregate rows across every repo × its linked providers, deduped. */
  rows: FetchedRow[]
  /** Per-provider failure messages, keyed by providerId. */
  errors: Record<string, string>
}

const INITIAL_FETCH: FetchState = { loading: false, rows: [], errors: {} }

function repoBasename(repoRoot: string): string {
  return repoRoot.split('/').pop() || repoRoot
}

/** For a given repo, the providers whose `appliesToRepoRoots` contains it. */
function providersForRepo(
  all: TicketProviderConfig[],
  repoRoot: string
): TicketProviderConfig[] {
  return all.filter((p) => p.appliesToRepoRoots?.includes(repoRoot))
}

/** Locate a worktree in `worktrees` whose linked ticket matches the given
 *  provider + external id. Returns null when the ticket isn't yet in a
 *  worktree. */
function findLinkedWorktree(
  worktrees: Worktree[],
  repoRoot: string,
  providerId: string,
  externalId: string
): Worktree | null {
  for (const wt of worktrees) {
    if (wt.repoRoot !== repoRoot) continue
    const link: WorktreeTicketLink | undefined = wt.linkedTicket
    if (link && link.providerId === providerId && link.externalId === externalId) return wt
  }
  return null
}

export function Tickets({
  onClose,
  repoRoots,
  worktrees,
  unifiedRepos,
  onJumpToWorktree,
  onSpawnFromTicket,
  onOpenSettings
}: TicketsProps): JSX.Element {
  const backend = useBackend()
  const providers = useTicketProviders()
  const [state, setState] = useState<FetchState>(INITIAL_FETCH)

  // For every (repo, provider-linked-to-that-repo) pair, kick off a
  // list() call and merge the results into `state.rows` decorated with
  // repoRoot + linkedWorktree. Any provider that appears in multiple
  // repos is queried once per repo since the row-level repo context is
  // what determines the "jump to worktree" mapping.
  const load = async (): Promise<void> => {
    if (providers.length === 0 || repoRoots.length === 0) {
      setState(INITIAL_FETCH)
      return
    }
    setState((s) => ({ ...s, loading: true }))
    const errors: Record<string, string> = {}
    const rows: FetchedRow[] = []
    const jobs: Promise<void>[] = []
    for (const repoRoot of repoRoots) {
      for (const provider of providersForRepo(providers, repoRoot)) {
        jobs.push(
          (async () => {
            try {
              const tickets = await backend.ticketsList(provider.id)
              for (const ticket of tickets) {
                rows.push({
                  ticket,
                  provider,
                  repoRoot,
                  linkedWorktree: findLinkedWorktree(
                    worktrees,
                    repoRoot,
                    provider.id,
                    ticket.externalId
                  )
                })
              }
            } catch (err) {
              errors[provider.id] = err instanceof Error ? err.message : String(err)
            }
          })()
        )
      }
    }
    await Promise.all(jobs)
    setState({ loading: false, rows, errors })
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers, repoRoots, worktrees])

  // Group by repo when not unified; otherwise one flat list.
  const sections = useMemo(() => {
    if (unifiedRepos || repoRoots.length <= 1) {
      return [{ repoRoot: null as string | null, rows: state.rows }]
    }
    const byRepo = new Map<string, FetchedRow[]>()
    for (const root of repoRoots) byRepo.set(root, [])
    for (const row of state.rows) {
      byRepo.get(row.repoRoot)?.push(row)
    }
    return Array.from(byRepo.entries()).map(([repoRoot, rows]) => ({
      repoRoot,
      rows
    }))
  }, [state.rows, repoRoots, unifiedRepos])

  const totalCount = state.rows.length
  const withWorktree = state.rows.filter((r) => r.linkedWorktree).length
  const withoutWorktree = totalCount - withWorktree

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
        <span className="absolute left-1/2 -translate-x-1/2 top-1/2 -translate-y-1/2 text-sm font-medium text-fg pointer-events-none">
          Tickets
        </span>
        <div className="no-drag absolute right-4 top-1/2 -translate-y-1/2 flex items-center gap-2">
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

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-4xl mx-auto px-6 py-6">
          {providers.length === 0 ? (
            <TicketsEmpty
              kind="no-providers"
              onOpenSettings={onOpenSettings}
            />
          ) : totalCount === 0 && !state.loading && Object.keys(state.errors).length === 0 ? (
            <TicketsEmpty
              kind="no-tickets"
              onOpenSettings={onOpenSettings}
            />
          ) : (
            <>
              <div className="mb-4 flex items-center gap-3 text-xs text-dim">
                <span>
                  <span className="text-fg-bright font-medium">{totalCount}</span> ticket
                  {totalCount === 1 ? '' : 's'}
                </span>
                <span className="text-faint">·</span>
                <span>
                  <span className="text-fg-bright font-medium">{withWorktree}</span> in progress
                </span>
                <span className="text-faint">·</span>
                <span>
                  <span className="text-fg-bright font-medium">{withoutWorktree}</span> ready to
                  start
                </span>
              </div>

              {Object.entries(state.errors).map(([providerId, message]) => {
                const provider = providers.find((p) => p.id === providerId)
                if (!provider) return null
                return (
                  <div
                    key={providerId}
                    className="mb-3 flex items-center gap-2 px-3 py-2 text-xs text-warning bg-warning/10 border border-warning/30 rounded"
                  >
                    <AlertCircle className="icon-xs shrink-0" />
                    <span className="font-medium">{provider.label}:</span>
                    <span className="font-mono truncate">{message}</span>
                  </div>
                )
              })}

              {sections.map((section) => (
                <TicketsSection
                  key={section.repoRoot ?? '__unified__'}
                  repoRoot={section.repoRoot}
                  rows={section.rows}
                  onJumpToWorktree={onJumpToWorktree}
                  onSpawnFromTicket={onSpawnFromTicket}
                />
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

interface TicketsSectionProps {
  repoRoot: string | null
  rows: FetchedRow[]
  onJumpToWorktree: (worktreePath: string) => void
  onSpawnFromTicket: (ticket: Ticket, provider: TicketProviderConfig, repoRoot: string) => void
}

function TicketsSection({
  repoRoot,
  rows,
  onJumpToWorktree,
  onSpawnFromTicket
}: TicketsSectionProps): JSX.Element {
  // Two buckets: rows with a linked worktree ("In progress") and rows without
  // ("Ready"). Simple v1 grouping until we thread real ticket status through.
  const inProgress = rows.filter((r) => r.linkedWorktree)
  const ready = rows.filter((r) => !r.linkedWorktree)

  const repoLabel = repoRoot ? repoBasename(repoRoot) : null

  return (
    <div className="mb-6">
      {repoLabel && (
        <div className="mb-2 flex items-center gap-2">
          <RepoIcon repoName={repoLabel} className="text-sm" />
          <span className={`text-sm font-medium ${repoNameColor(repoLabel)}`}>{repoLabel}</span>
          <span className="text-xs text-faint font-mono truncate">{repoRoot}</span>
        </div>
      )}
      {rows.length === 0 ? (
        <p className="text-xs text-faint px-3 py-2 border border-dashed border-border rounded">
          No tickets from this repo's linked providers.
        </p>
      ) : (
        <>
          {inProgress.length > 0 && (
            <TicketBucket
              label="In progress"
              rows={inProgress}
              onJumpToWorktree={onJumpToWorktree}
              onSpawnFromTicket={onSpawnFromTicket}
            />
          )}
          {ready.length > 0 && (
            <TicketBucket
              label="Ready"
              rows={ready}
              onJumpToWorktree={onJumpToWorktree}
              onSpawnFromTicket={onSpawnFromTicket}
            />
          )}
        </>
      )}
    </div>
  )
}

interface TicketBucketProps {
  label: string
  rows: FetchedRow[]
  onJumpToWorktree: (worktreePath: string) => void
  onSpawnFromTicket: (ticket: Ticket, provider: TicketProviderConfig, repoRoot: string) => void
}

function TicketBucket({
  label,
  rows,
  onJumpToWorktree,
  onSpawnFromTicket
}: TicketBucketProps): JSX.Element {
  return (
    <div className="mb-4">
      <div className="text-xs font-semibold uppercase tracking-wider text-dim mb-1.5">
        {label} <span className="text-faint">({rows.length})</span>
      </div>
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

// Picker UI for selecting a ticket to spawn a worktree from.
//
// Drives the "From ticket" affordance on the New Worktree screen — the
// caller opens this modal, the user types to search across every
// provider linked to the current repo, and on click we hand back the
// chosen Ticket + which provider it came from. The caller is responsible
// for stitching the result into the New Worktree form (branch name
// suggestion, prompt template render). Nothing here knows about
// branches.

import { useEffect, useMemo, useRef, useState } from 'react'
import { Search, X, Loader2, Settings as SettingsIcon, AlertCircle } from 'lucide-react'
import type { Ticket, TicketProviderConfig } from '../../shared/tickets'
import { useBackend } from '../backend'
import { useRepoLinkedProviderIds, useTicketProviders } from '../store'
import { TicketProviderIcon } from './TicketProvidersSettings'
import { searchAndMergeTickets, type ListTicketsFn, type MergedTicketRow } from '../ticket-search'

interface TicketPickerModalProps {
  repoRoot: string | null
  onClose: () => void
  onSelect: (ticket: Ticket, provider: TicketProviderConfig) => void
  /** Per-provider fetch fn. Injected so component tests can swap in a
   *  deterministic mock; production callers always omit and get the
   *  default that routes through `backend.ticketsList`. */
  listTickets?: ListTicketsFn
  /** Click handler for the "Configure providers" empty-state link.
   *  Optional — when absent we just render a link-shaped span. */
  onOpenSettings?: () => void
}

interface FetchState {
  loading: boolean
  /** Aggregate ticket list, grouped by provider id then concatenated
   *  in repo-link order so the picker output is stable across renders. */
  rows: MergedTicketRow[]
  errors: Record<string, string>
}

const INITIAL_FETCH: FetchState = { loading: false, rows: [], errors: {} }

const DEBOUNCE_MS = 250

export function TicketPickerModal({
  repoRoot,
  onClose,
  onSelect,
  listTickets,
  onOpenSettings
}: TicketPickerModalProps): JSX.Element {
  const backend = useBackend()
  const allProviders = useTicketProviders()
  const linkedIds = useRepoLinkedProviderIds(repoRoot)
  const linkedProviders = useMemo(
    () => allProviders.filter((p) => linkedIds.includes(p.id)),
    [allProviders, linkedIds]
  )

  // The picker is a select-then-confirm-by-click UX — there's no Cancel
  // outside the X / Escape, and clicking a row immediately selects.
  // Debounced query keeps the per-provider list() calls from running on
  // every keystroke.
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [state, setState] = useState<FetchState>(INITIAL_FETCH)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [query])

  // Fan out to every linked provider. Each provider's failure is captured
  // independently so a flaky one doesn't blank the picker — it just shows
  // an error row alongside the successful ones.
  useEffect(() => {
    if (linkedProviders.length === 0) {
      setState(INITIAL_FETCH)
      return
    }
    let cancelled = false
    setState((s) => ({ ...s, loading: true }))
    const fetcher: ListTicketsFn =
      listTickets ?? ((providerId: string, q: string) => backend.ticketsList(providerId, q))
    void (async () => {
      const { rows, errors } = await searchAndMergeTickets(linkedProviders, debouncedQuery, fetcher)
      if (cancelled) return
      setState({ loading: false, rows, errors })
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkedProviders, debouncedQuery, listTickets])

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-24"
      onKeyDown={handleKeyDown}
      role="dialog"
      aria-modal="true"
      aria-label="Pick a ticket"
    >
      <div
        className="absolute inset-0 bg-app/70 backdrop-blur-sm"
        onClick={onClose}
      />
      <div className="relative w-full max-w-2xl mx-4 bg-panel border border-border-strong rounded-2xl shadow-2xl overflow-hidden">
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <Search className="icon-base text-dim shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search tickets…"
            className="flex-1 bg-transparent outline-none text-base text-fg-bright placeholder-faint"
          />
          {state.loading && (
            <Loader2 className="icon-sm animate-spin text-dim shrink-0" aria-label="Loading" />
          )}
          <button
            type="button"
            onClick={onClose}
            className="text-faint hover:text-fg p-1 rounded cursor-pointer shrink-0"
            title="Close (Esc)"
            aria-label="Close picker"
          >
            <X className="icon-sm" />
          </button>
        </div>

        <div className="max-h-[420px] overflow-y-auto" data-testid="ticket-picker-list">
          {linkedProviders.length === 0 ? (
            <TicketPickerEmpty kind="no-linked" onOpenSettings={onOpenSettings} />
          ) : state.loading && state.rows.length === 0 ? (
            <div className="flex items-center justify-center gap-2 py-12 text-sm text-dim">
              <Loader2 className="icon-sm animate-spin" />
              Loading tickets…
            </div>
          ) : state.rows.length === 0 && Object.keys(state.errors).length === 0 ? (
            <TicketPickerEmpty kind="no-results" onOpenSettings={onOpenSettings} />
          ) : (
            <div className="flex flex-col">
              {Object.entries(state.errors).map(([providerId, message]) => {
                const provider = linkedProviders.find((p) => p.id === providerId)
                if (!provider) return null
                return (
                  <div
                    key={providerId}
                    className="flex items-center gap-2 px-4 py-2 text-xs text-warning bg-warning/10 border-b border-warning/30"
                  >
                    <AlertCircle className="icon-xs" />
                    <span className="font-medium">{provider.label}:</span>
                    <span className="font-mono">{message}</span>
                  </div>
                )
              })}
              {state.rows.map(({ ticket, provider }) => (
                <TicketPickerRow
                  key={ticket.id}
                  ticket={ticket}
                  provider={provider}
                  onSelect={() => onSelect(ticket, provider)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

interface TicketPickerRowProps {
  ticket: Ticket
  provider: TicketProviderConfig
  onSelect: () => void
}

function TicketPickerRow({ ticket, provider, onSelect }: TicketPickerRowProps): JSX.Element {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="text-left px-4 py-3 border-b border-border last:border-b-0 hover:bg-panel-raised transition-colors cursor-pointer"
    >
      <div className="flex items-baseline gap-2">
        <TicketProviderIcon
          type={provider.type}
          className="icon-xs text-dim self-center shrink-0"
        />
        <span className="text-sm text-fg-bright font-medium truncate flex-1 min-w-0">
          {ticket.title}
        </span>
        <span
          className="text-xs font-mono text-faint shrink-0"
          title={`External id: ${ticket.externalId}`}
        >
          {ticket.externalId}
        </span>
      </div>
      <div className="mt-0.5 flex items-center gap-1.5 text-xs text-dim">
        <span className="text-faint">{provider.label}</span>
        {ticket.description && (
          <>
            <span className="text-faint">·</span>
            <span className="truncate">{ticket.description.split('\n')[0]}</span>
          </>
        )}
      </div>
    </button>
  )
}

interface TicketPickerEmptyProps {
  kind: 'no-linked' | 'no-results'
  onOpenSettings?: () => void
}

function TicketPickerEmpty({ kind, onOpenSettings }: TicketPickerEmptyProps): JSX.Element {
  if (kind === 'no-linked') {
    return (
      <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
        <p className="text-sm text-dim">No providers apply to this project yet.</p>
        <p className="text-xs text-faint">
          Open a provider in <strong>Settings → Ticket Providers</strong> and tick this project
          in its "Apply to projects" list.
        </p>
        {onOpenSettings && (
          <button
            type="button"
            onClick={onOpenSettings}
            className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 bg-surface hover:bg-surface-hover rounded text-sm text-fg-bright transition-colors cursor-pointer"
          >
            <SettingsIcon className="icon-xs" />
            Open settings
          </button>
        )}
      </div>
    )
  }
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      <p className="text-sm text-dim">No tickets matched.</p>
      <p className="text-xs text-faint">
        Make sure the provider's filter is right —{' '}
        {onOpenSettings ? (
          <button
            type="button"
            onClick={onOpenSettings}
            className="underline hover:text-fg cursor-pointer"
          >
            edit provider
          </button>
        ) : (
          <span>edit it in Settings → Ticket Providers</span>
        )}
        .
      </p>
    </div>
  )
}

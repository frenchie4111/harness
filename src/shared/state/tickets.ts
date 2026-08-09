import type { Ticket } from '../tickets'

export type { Ticket }

/** Per-provider cache of the last list() result. The renderer fetches via
 *  the `tickets:list` IPC; main writes the cache here so other clients of
 *  the workspace see the same list without re-fetching.
 *
 *  Cache invalidation is intentionally dumb: `lastFetched` is a timestamp
 *  the renderer uses to decide whether to refresh on focus / picker open.
 *  No fancy diff or change-detection — providers are external, lossy, and
 *  cheap enough to re-list. */
export interface TicketProviderCache {
  tickets: Ticket[]
  loading: boolean
  lastFetched: number | null
  error: string | null
}

export interface TicketsState {
  byProvider: Record<string, TicketProviderCache>
}

export type TicketsEvent =
  | { type: 'tickets/fetchStarted'; payload: { providerId: string } }
  | {
      type: 'tickets/fetchSucceeded'
      payload: { providerId: string; tickets: Ticket[]; at: number }
    }
  | {
      type: 'tickets/fetchFailed'
      payload: { providerId: string; error: string; at: number }
    }

export const initialTickets: TicketsState = {
  byProvider: {}
}

const EMPTY_CACHE: TicketProviderCache = {
  tickets: [],
  loading: false,
  lastFetched: null,
  error: null
}

export function ticketsReducer(state: TicketsState, event: TicketsEvent): TicketsState {
  switch (event.type) {
    case 'tickets/fetchStarted': {
      const prev = state.byProvider[event.payload.providerId] ?? EMPTY_CACHE
      return {
        ...state,
        byProvider: {
          ...state.byProvider,
          [event.payload.providerId]: { ...prev, loading: true, error: null }
        }
      }
    }
    case 'tickets/fetchSucceeded': {
      const prev = state.byProvider[event.payload.providerId] ?? EMPTY_CACHE
      return {
        ...state,
        byProvider: {
          ...state.byProvider,
          [event.payload.providerId]: {
            ...prev,
            tickets: event.payload.tickets,
            loading: false,
            lastFetched: event.payload.at,
            error: null
          }
        }
      }
    }
    case 'tickets/fetchFailed': {
      const prev = state.byProvider[event.payload.providerId] ?? EMPTY_CACHE
      return {
        ...state,
        byProvider: {
          ...state.byProvider,
          [event.payload.providerId]: {
            ...prev,
            loading: false,
            lastFetched: event.payload.at,
            error: event.payload.error
          }
        }
      }
    }
    default: {
      const _exhaustive: never = event
      void _exhaustive
      return state
    }
  }
}

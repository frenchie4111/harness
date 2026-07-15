import type { TicketProviderConfig } from '../tickets'

export type { TicketProviderConfig }

/** Configured ticket-provider instances, keyed by stable Harness-internal
 *  uuid. Hydrated at boot from `config.ticketProviders`. The auth token
 *  for each provider lives in `secrets.enc` keyed
 *  `ticket-provider-token:<id>`, NEVER here. */
export interface TicketProvidersState {
  byId: Record<string, TicketProviderConfig>
}

export type TicketProvidersEvent =
  | { type: 'ticketProviders/loaded'; payload: Record<string, TicketProviderConfig> }
  | { type: 'ticketProviders/added'; payload: TicketProviderConfig }
  | {
      type: 'ticketProviders/updated'
      payload: { id: string; patch: Partial<Omit<TicketProviderConfig, 'id'>> }
    }
  | { type: 'ticketProviders/removed'; payload: string }

export const initialTicketProviders: TicketProvidersState = {
  byId: {}
}

export function ticketProvidersReducer(
  state: TicketProvidersState,
  event: TicketProvidersEvent
): TicketProvidersState {
  switch (event.type) {
    case 'ticketProviders/loaded':
      return { ...state, byId: event.payload }
    case 'ticketProviders/added':
      return {
        ...state,
        byId: { ...state.byId, [event.payload.id]: event.payload }
      }
    case 'ticketProviders/updated': {
      const existing = state.byId[event.payload.id]
      if (!existing) return state
      const patched: TicketProviderConfig = { ...existing, ...event.payload.patch, id: existing.id }
      return {
        ...state,
        byId: { ...state.byId, [existing.id]: patched }
      }
    }
    case 'ticketProviders/removed': {
      if (!(event.payload in state.byId)) return state
      const { [event.payload]: _dropped, ...rest } = state.byId
      void _dropped
      return { ...state, byId: rest }
    }
    default: {
      const _exhaustive: never = event
      void _exhaustive
      return state
    }
  }
}

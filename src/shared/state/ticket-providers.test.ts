import { describe, it, expect } from 'vitest'
import {
  initialTicketProviders,
  ticketProvidersReducer,
  type TicketProvidersState
} from './ticket-providers'
import type { TicketProviderConfig } from '../tickets'

const A: TicketProviderConfig = {
  id: 'a',
  label: 'Harness issues',
  type: 'github-issues',
  config: { repo: 'frenchie4111/harness' }
}
const B: TicketProviderConfig = {
  id: 'b',
  label: 'Roadmap',
  type: 'notion',
  config: { databaseId: 'db-1' }
}

describe('ticketProvidersReducer', () => {
  it('loaded replaces the whole map', () => {
    const start: TicketProvidersState = { byId: { old: { ...A, id: 'old' } } }
    const next = ticketProvidersReducer(start, {
      type: 'ticketProviders/loaded',
      payload: { [A.id]: A, [B.id]: B }
    })
    expect(Object.keys(next.byId).sort()).toEqual(['a', 'b'])
    expect(next.byId.a).toEqual(A)
  })

  it('added inserts a new entry', () => {
    const next = ticketProvidersReducer(initialTicketProviders, {
      type: 'ticketProviders/added',
      payload: A
    })
    expect(next.byId[A.id]).toEqual(A)
  })

  it('updated merges a patch into an existing entry', () => {
    const start: TicketProvidersState = { byId: { [A.id]: A } }
    const next = ticketProvidersReducer(start, {
      type: 'ticketProviders/updated',
      payload: { id: A.id, patch: { label: 'New label' } }
    })
    expect(next.byId[A.id].label).toBe('New label')
    expect(next.byId[A.id].id).toBe(A.id)
    expect(next.byId[A.id].type).toBe(A.type)
  })

  it('updated on a missing id is a no-op (returns same reference)', () => {
    const start: TicketProvidersState = { byId: { [A.id]: A } }
    const next = ticketProvidersReducer(start, {
      type: 'ticketProviders/updated',
      payload: { id: 'missing', patch: { label: 'noop' } }
    })
    expect(next).toBe(start)
  })

  it('removed drops the matching entry', () => {
    const start: TicketProvidersState = { byId: { [A.id]: A, [B.id]: B } }
    const next = ticketProvidersReducer(start, {
      type: 'ticketProviders/removed',
      payload: A.id
    })
    expect(Object.keys(next.byId)).toEqual([B.id])
  })

  it('removed on a missing id is a no-op (returns same reference)', () => {
    const start: TicketProvidersState = { byId: { [A.id]: A } }
    const next = ticketProvidersReducer(start, {
      type: 'ticketProviders/removed',
      payload: 'missing'
    })
    expect(next).toBe(start)
  })
})

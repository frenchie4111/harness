import { describe, it, expect } from 'vitest'
import {
  initialTickets,
  ticketsReducer,
  type TicketsState
} from './tickets'
import type { Ticket } from '../tickets'

const T1: Ticket = {
  id: 'p:1',
  providerId: 'p',
  externalId: '1',
  title: 'One',
  description: '',
  url: 'https://example.com/1'
}
const T2: Ticket = {
  id: 'p:2',
  providerId: 'p',
  externalId: '2',
  title: 'Two',
  description: 'Body',
  url: 'https://example.com/2'
}

describe('ticketsReducer', () => {
  it('fetchStarted sets loading=true and clears any prior error', () => {
    const start: TicketsState = {
      byProvider: {
        p: { tickets: [], loading: false, lastFetched: 100, error: 'boom' }
      }
    }
    const next = ticketsReducer(start, {
      type: 'tickets/fetchStarted',
      payload: { providerId: 'p' }
    })
    expect(next.byProvider.p.loading).toBe(true)
    expect(next.byProvider.p.error).toBeNull()
    expect(next.byProvider.p.lastFetched).toBe(100)
  })

  it('fetchStarted seeds an empty cache for an unknown provider', () => {
    const next = ticketsReducer(initialTickets, {
      type: 'tickets/fetchStarted',
      payload: { providerId: 'new' }
    })
    expect(next.byProvider.new).toEqual({
      tickets: [],
      loading: true,
      lastFetched: null,
      error: null
    })
  })

  it('fetchSucceeded stores tickets + timestamp and clears loading/error', () => {
    const start: TicketsState = {
      byProvider: {
        p: { tickets: [], loading: true, lastFetched: null, error: null }
      }
    }
    const next = ticketsReducer(start, {
      type: 'tickets/fetchSucceeded',
      payload: { providerId: 'p', tickets: [T1, T2], at: 500 }
    })
    expect(next.byProvider.p.tickets).toEqual([T1, T2])
    expect(next.byProvider.p.loading).toBe(false)
    expect(next.byProvider.p.lastFetched).toBe(500)
    expect(next.byProvider.p.error).toBeNull()
  })

  it('fetchFailed records the error + timestamp without clobbering cached tickets', () => {
    const start: TicketsState = {
      byProvider: {
        p: { tickets: [T1], loading: true, lastFetched: 100, error: null }
      }
    }
    const next = ticketsReducer(start, {
      type: 'tickets/fetchFailed',
      payload: { providerId: 'p', error: 'network', at: 200 }
    })
    expect(next.byProvider.p.tickets).toEqual([T1])
    expect(next.byProvider.p.loading).toBe(false)
    expect(next.byProvider.p.error).toBe('network')
    expect(next.byProvider.p.lastFetched).toBe(200)
  })

  it('does not disturb sibling providers on update', () => {
    const sibling = {
      tickets: [T1],
      loading: false,
      lastFetched: 1,
      error: null
    }
    const start: TicketsState = { byProvider: { p: sibling, q: sibling } }
    const next = ticketsReducer(start, {
      type: 'tickets/fetchStarted',
      payload: { providerId: 'p' }
    })
    expect(next.byProvider.q).toBe(start.byProvider.q)
  })
})

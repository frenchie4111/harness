import { describe, it, expect } from 'vitest'
import { searchAndMergeTickets, type ListTicketsFn } from './ticket-search'
import { createMockTicketProvider, type TicketProviderConfig } from '../shared/tickets'

const ghProvider: TicketProviderConfig = {
  id: 'gh',
  label: 'GitHub tickets',
  type: 'github-issues',
  config: { repo: 'octocat/example' }
}

const notionProvider: TicketProviderConfig = {
  id: 'notion',
  label: 'Notion tickets',
  type: 'notion',
  config: { databaseId: 'aaaa' }
}

/** Build a `ListTicketsFn` that dispatches each provider to its own
 *  `createMockTicketProvider` — mirrors how the real picker fans out
 *  to per-provider `list(query)` calls. */
function listFromMocks(): ListTicketsFn {
  const providers = new Map<string, ReturnType<typeof createMockTicketProvider>>([
    ['gh', createMockTicketProvider('gh')],
    ['notion', createMockTicketProvider('notion')]
  ])
  return async (providerId: string, query: string) => {
    const p = providers.get(providerId)
    if (!p) throw new Error(`no mock for ${providerId}`)
    return p.list(query)
  }
}

describe('searchAndMergeTickets', () => {
  it('returns an empty result for no providers', async () => {
    const result = await searchAndMergeTickets([], '', listFromMocks())
    expect(result.rows).toEqual([])
    expect(result.errors).toEqual({})
  })

  it('merges results from every provider preserving the input order', async () => {
    const result = await searchAndMergeTickets(
      [ghProvider, notionProvider],
      '',
      listFromMocks()
    )
    // 3 default seed tickets per provider, gh first.
    expect(result.rows.length).toBe(6)
    expect(result.rows[0].provider.id).toBe('gh')
    expect(result.rows[3].provider.id).toBe('notion')
    // Each row preserves the (ticket, provider) pairing.
    for (const r of result.rows) expect(r.ticket.providerId).toBe(r.provider.id)
  })

  it('filters by query at the per-provider boundary', async () => {
    const result = await searchAndMergeTickets(
      [ghProvider, notionProvider],
      'dark mode',
      listFromMocks()
    )
    // The seed dataset has exactly one match per provider.
    expect(result.rows.length).toBe(2)
    expect(result.rows[0].ticket.title.toLowerCase()).toContain('dark mode')
    expect(result.rows[1].ticket.title.toLowerCase()).toContain('dark mode')
  })

  it('captures per-provider failures without dropping other providers', async () => {
    const fallible: ListTicketsFn = async (providerId, query) => {
      if (providerId === 'gh') throw new Error('rate limited')
      return listFromMocks()(providerId, query)
    }
    const result = await searchAndMergeTickets([ghProvider, notionProvider], '', fallible)
    expect(result.errors).toEqual({ gh: 'rate limited' })
    // Notion still returns its 3 seed tickets.
    expect(result.rows.length).toBe(3)
    expect(result.rows.every((r) => r.provider.id === 'notion')).toBe(true)
  })

  it('records "fetch failed" for non-Error rejections', async () => {
    const list: ListTicketsFn = () => Promise.reject('oh no')
    const result = await searchAndMergeTickets([ghProvider], '', list)
    expect(result.errors.gh).toBe('fetch failed')
    expect(result.rows).toEqual([])
  })
})

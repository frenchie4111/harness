import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fetchAnnouncementsFeed } from './announcements-poller'

const originalFetch = globalThis.fetch

function mockFetch(body: unknown, init: { ok?: boolean; status?: number } = {}): void {
  globalThis.fetch = vi.fn(async () => {
    return {
      ok: init.ok ?? true,
      status: init.status ?? 200,
      json: async () => body
    } as unknown as Response
  })
}

describe('fetchAnnouncementsFeed', () => {
  beforeEach(() => {
    globalThis.fetch = originalFetch
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('returns valid entries and counts the raw total', async () => {
    mockFetch({
      announcements: [
        {
          id: 'one',
          title: 'One',
          href: 'https://example.com/one',
          publishedAt: '2026-05-20T00:00:00Z'
        },
        {
          id: 'two',
          title: 'Two',
          href: 'http://example.com/two',
          publishedAt: '2026-05-21T00:00:00Z',
          expiresAt: '2026-06-21T00:00:00Z'
        }
      ]
    })
    const { items, rawCount } = await fetchAnnouncementsFeed('http://mock')
    expect(rawCount).toBe(2)
    expect(items).toHaveLength(2)
    expect(items[1].expiresAt).toBe('2026-06-21T00:00:00Z')
  })

  it('drops entries missing required fields', async () => {
    mockFetch({
      announcements: [
        { id: 'ok', title: 'OK', href: 'https://x.example/y', publishedAt: '2026-05-20T00:00:00Z' },
        { id: 'bad-href', title: 't', href: 'not-a-url', publishedAt: '2026-05-20T00:00:00Z' },
        { id: 'bad-date', title: 't', href: 'https://x.example/y', publishedAt: 'whenever' },
        { title: 'no-id', href: 'https://x.example/y', publishedAt: '2026-05-20T00:00:00Z' },
        {
          id: 'js-href',
          title: 't',
          href: 'javascript:alert(1)',
          publishedAt: '2026-05-20T00:00:00Z'
        }
      ]
    })
    const { items, rawCount } = await fetchAnnouncementsFeed('http://mock')
    expect(rawCount).toBe(5)
    expect(items).toHaveLength(1)
    expect(items[0].id).toBe('ok')
  })

  it('ignores unknown fields on otherwise-valid entries', async () => {
    mockFetch({
      announcements: [
        {
          id: 'ok',
          title: 'Hello',
          href: 'https://x.example/y',
          publishedAt: '2026-05-20T00:00:00Z',
          futureField: { whatever: 1 },
          tags: ['release']
        }
      ]
    })
    const { items } = await fetchAnnouncementsFeed('http://mock')
    expect(items).toEqual([
      {
        id: 'ok',
        title: 'Hello',
        href: 'https://x.example/y',
        publishedAt: '2026-05-20T00:00:00Z'
      }
    ])
  })

  it('returns an empty list when announcements is missing or not an array', async () => {
    mockFetch({ note: 'no announcements key here' })
    const { items, rawCount } = await fetchAnnouncementsFeed('http://mock')
    expect(items).toEqual([])
    expect(rawCount).toBe(0)
  })

  it('throws on non-2xx responses', async () => {
    mockFetch({}, { ok: false, status: 503 })
    await expect(fetchAnnouncementsFeed('http://mock')).rejects.toThrow(/HTTP 503/)
  })
})

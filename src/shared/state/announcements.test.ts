import { describe, it, expect } from 'vitest'
import { initialAnnouncements, announcementsReducer } from './announcements'

describe('announcementsReducer', () => {
  it('starts empty with no fetch and no error', () => {
    expect(initialAnnouncements.items).toEqual([])
    expect(initialAnnouncements.lastFetched).toBeNull()
    expect(initialAnnouncements.lastError).toBeNull()
  })

  it('loaded replaces items, records fetchedAt, and clears error', () => {
    const seeded = announcementsReducer(initialAnnouncements, {
      type: 'announcements/fetchFailed',
      payload: 'boom'
    })
    expect(seeded.lastError).toBe('boom')

    const next = announcementsReducer(seeded, {
      type: 'announcements/loaded',
      payload: {
        items: [
          {
            id: 'a',
            title: 'A',
            href: 'https://example.com/a',
            publishedAt: '2026-05-20T00:00:00Z'
          }
        ],
        fetchedAt: 1717000000000
      }
    })
    expect(next.items).toHaveLength(1)
    expect(next.items[0].id).toBe('a')
    expect(next.lastFetched).toBe(1717000000000)
    expect(next.lastError).toBeNull()
  })

  it('fetchFailed records the error message without dropping previous items', () => {
    const loaded = announcementsReducer(initialAnnouncements, {
      type: 'announcements/loaded',
      payload: {
        items: [
          {
            id: 'a',
            title: 'A',
            href: 'https://example.com/a',
            publishedAt: '2026-05-20T00:00:00Z'
          }
        ],
        fetchedAt: 1
      }
    })
    const next = announcementsReducer(loaded, {
      type: 'announcements/fetchFailed',
      payload: 'network down'
    })
    expect(next.items).toEqual(loaded.items)
    expect(next.lastFetched).toBe(1)
    expect(next.lastError).toBe('network down')
  })

  it('returns a new object reference on mutation', () => {
    const next = announcementsReducer(initialAnnouncements, {
      type: 'announcements/fetchFailed',
      payload: 'x'
    })
    expect(next).not.toBe(initialAnnouncements)
  })

  it('preserves the summary field on loaded items', () => {
    const next = announcementsReducer(initialAnnouncements, {
      type: 'announcements/loaded',
      payload: {
        items: [
          {
            id: 'a',
            title: 'A',
            href: 'https://example.com/a',
            publishedAt: '2026-05-20T00:00:00Z',
            summary: 'A short blurb.'
          }
        ],
        fetchedAt: 1
      }
    })
    expect(next.items[0].summary).toBe('A short blurb.')
  })

  it('items without a summary flow through unchanged', () => {
    const next = announcementsReducer(initialAnnouncements, {
      type: 'announcements/loaded',
      payload: {
        items: [
          {
            id: 'a',
            title: 'A',
            href: 'https://example.com/a',
            publishedAt: '2026-05-20T00:00:00Z'
          }
        ],
        fetchedAt: 1
      }
    })
    expect(next.items[0].summary).toBeUndefined()
  })
})

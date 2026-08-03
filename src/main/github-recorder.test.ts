import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('./debug', () => ({ log: vi.fn() }))

import {
  MAX_ENTRIES,
  __resetGitHubApiRecorderForTests,
  clearGitHubApiLog,
  getGitHubApiLogSnapshot,
  subscribeGitHubApiLog,
  trackedFetch
} from './github-recorder'

function mockResponse(status: number, headers: Record<string, string> = {}): Response {
  return new Response('body', { status, statusText: `status-${status}`, headers })
}

describe('trackedFetch', () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch')

  beforeEach(() => {
    __resetGitHubApiRecorderForTests()
    fetchSpy.mockReset()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('records a successful call', async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse(200))
    await trackedFetch('https://api.github.com/user')
    const snap = getGitHubApiLogSnapshot()
    expect(snap.entries).toHaveLength(1)
    expect(snap.entries[0].method).toBe('GET')
    expect(snap.entries[0].shortPath).toBe('/user')
    expect(snap.entries[0].status).toBe(200)
    expect(snap.entries[0].error).toBeUndefined()
    expect(snap.totalRecorded).toBe(1)
  })

  it('records a failed call with error message', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('boom'))
    await expect(trackedFetch('https://api.github.com/user')).rejects.toThrow('boom')
    const snap = getGitHubApiLogSnapshot()
    expect(snap.entries).toHaveLength(1)
    expect(snap.entries[0].status).toBeUndefined()
    expect(snap.entries[0].error).toBe('boom')
  })

  it('caps the ring buffer at MAX_ENTRIES', async () => {
    fetchSpy.mockResolvedValue(mockResponse(200))
    const overflow = MAX_ENTRIES + 1
    for (let i = 0; i < overflow; i++) {
      await trackedFetch(`https://api.github.com/repos/x/y/issues/${i}`)
    }
    const snap = getGitHubApiLogSnapshot()
    expect(snap.entries).toHaveLength(MAX_ENTRIES)
    // Oldest entry (id=1) should have been dropped; first surviving entry
    // is id=2.
    expect(snap.entries[0].id).toBe(2)
    expect(snap.totalRecorded).toBe(overflow)
  })

  it('clearGitHubApiLog empties the buffer', async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse(200))
    await trackedFetch('https://api.github.com/user')
    clearGitHubApiLog()
    const snap = getGitHubApiLogSnapshot()
    expect(snap.entries).toHaveLength(0)
    expect(snap.totalRecorded).toBe(0)
    expect(snap.rateLimit).toBeUndefined()
  })

  it('subscribe fires on new entries; unsubscribe stops firing', async () => {
    const received: number[] = []
    const unsub = subscribeGitHubApiLog((entry) => received.push(entry.id))
    fetchSpy.mockResolvedValue(mockResponse(200))
    await trackedFetch('https://api.github.com/a')
    await trackedFetch('https://api.github.com/b')
    unsub()
    await trackedFetch('https://api.github.com/c')
    expect(received).toEqual([1, 2])
  })

  it('parses operationName from a GraphQL POST body', async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse(200))
    await trackedFetch('https://api.github.com/graphql', {
      method: 'POST',
      body: JSON.stringify({ operationName: 'GetPRStatus', query: '...' })
    })
    const snap = getGitHubApiLogSnapshot()
    expect(snap.entries[0].operationName).toBe('GetPRStatus')
  })

  it('tolerates malformed GraphQL POST bodies', async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse(200))
    await trackedFetch('https://api.github.com/graphql', {
      method: 'POST',
      body: 'not-json'
    })
    const snap = getGitHubApiLogSnapshot()
    expect(snap.entries[0].operationName).toBeUndefined()
  })

  it('captures rate-limit headers from the response', async () => {
    fetchSpy.mockResolvedValueOnce(
      mockResponse(200, {
        'x-ratelimit-limit': '5000',
        'x-ratelimit-remaining': '4321',
        'x-ratelimit-reset': '1700000000'
      })
    )
    await trackedFetch('https://api.github.com/user')
    const snap = getGitHubApiLogSnapshot()
    expect(snap.entries[0].rateLimitLimit).toBe(5000)
    expect(snap.entries[0].rateLimitRemaining).toBe(4321)
    expect(snap.rateLimit?.remaining).toBe(4321)
    expect(snap.rateLimit?.limit).toBe(5000)
    expect(snap.rateLimit?.reset).toBe(1700000000)
  })

  it('never captures the Authorization header value', async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse(200))
    const secret = 'Bearer super-secret-token-do-not-leak'
    await trackedFetch('https://api.github.com/user', {
      headers: { Authorization: secret }
    })
    const serialized = JSON.stringify(getGitHubApiLogSnapshot())
    expect(serialized).not.toContain('Bearer')
    expect(serialized).not.toContain('super-secret-token')
  })

  it('bumps per-minute bucket count and tracks 5xx as error', async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse(200))
    fetchSpy.mockResolvedValueOnce(mockResponse(504))
    await trackedFetch('https://api.github.com/a')
    await trackedFetch('https://api.github.com/b')
    const snap = getGitHubApiLogSnapshot()
    // Both calls landed inside the same wall-clock minute; if the test
    // straddles a minute boundary we may see two buckets — either way,
    // total count is 2 and total errorCount is 1.
    const totalCount = snap.minuteBuckets.reduce((n, b) => n + b.count, 0)
    const totalErrors = snap.minuteBuckets.reduce((n, b) => n + b.errorCount, 0)
    expect(totalCount).toBe(2)
    expect(totalErrors).toBe(1)
  })
})

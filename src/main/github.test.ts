import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('./debug', () => ({
  log: vi.fn()
}))

vi.mock('./github-auth', () => ({
  getCachedToken: vi.fn(() => 'fake-token'),
  invalidateTokenCache: vi.fn(),
  resolveGitHubToken: vi.fn(async () => ({ token: 'fake-token' }))
}))

import { mergePR } from './github'

function mockResponse(status: number, body: unknown): Response {
  return {
    status,
    statusText: `status-${status}`,
    ok: status >= 200 && status < 300,
    json: async () => body
  } as unknown as Response
}

describe('mergePR', () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch')

  beforeEach(() => {
    fetchSpy.mockReset()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('returns ok with sha on 200', async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse(200, { sha: 'abcd', merged: true }))
    const res = await mergePR('tok', 'owner', 'repo', 42, 'squash')
    expect(res).toEqual({ ok: true, sha: 'abcd' })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.github.com/repos/owner/repo/pulls/42/merge')
    expect(init.method).toBe('PUT')
    expect(JSON.parse(init.body as string)).toEqual({ merge_method: 'squash' })
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok')
  })

  it('passes commit title/message when provided', async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse(200, { sha: 'abcd' }))
    await mergePR('tok', 'o', 'r', 1, 'merge', {
      commitTitle: 'Title',
      commitMessage: 'Message'
    })
    const init = fetchSpy.mock.calls[0][1] as RequestInit
    expect(JSON.parse(init.body as string)).toEqual({
      merge_method: 'merge',
      commit_title: 'Title',
      commit_message: 'Message'
    })
  })

  it('maps 401 to unauthorized', async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse(401, { message: 'Bad creds' }))
    const res = await mergePR('tok', 'o', 'r', 1, 'squash')
    expect(res.ok).toBe(false)
    expect(res.errorCode).toBe('unauthorized')
    expect(res.error).toMatch(/repo scope/i)
  })

  it('maps 403 to unauthorized', async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse(403, { message: 'Forbidden' }))
    const res = await mergePR('tok', 'o', 'r', 1, 'squash')
    expect(res.errorCode).toBe('unauthorized')
  })

  it('maps 405 to method_not_allowed', async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse(405, { message: 'Not allowed' }))
    const res = await mergePR('tok', 'o', 'r', 1, 'rebase')
    expect(res.ok).toBe(false)
    expect(res.errorCode).toBe('method_not_allowed')
    expect(res.error).toMatch(/branch protection/i)
  })

  it('maps 409 to conflict', async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse(409, { message: 'conflict' }))
    const res = await mergePR('tok', 'o', 'r', 1, 'squash')
    expect(res.ok).toBe(false)
    expect(res.errorCode).toBe('conflict')
    expect(res.error).toMatch(/conflict/i)
  })

  it('maps 422 to unprocessable', async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse(422, { message: 'not mergeable' }))
    const res = await mergePR('tok', 'o', 'r', 1, 'squash')
    expect(res.ok).toBe(false)
    expect(res.errorCode).toBe('unprocessable')
  })

  it('maps unknown statuses to unknown errorCode and surfaces api message', async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse(500, { message: 'oops' }))
    const res = await mergePR('tok', 'o', 'r', 1, 'squash')
    expect(res.ok).toBe(false)
    expect(res.errorCode).toBe('unknown')
    expect(res.error).toBe('oops')
  })

  it('returns unknown errorCode when fetch throws', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('network down'))
    const res = await mergePR('tok', 'o', 'r', 1, 'squash')
    expect(res.ok).toBe(false)
    expect(res.errorCode).toBe('unknown')
    expect(res.error).toBe('network down')
  })
})

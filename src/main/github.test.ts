import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('./debug', () => ({
  log: vi.fn(),
  formatErr: (err: unknown) => (err instanceof Error ? err.message : String(err))
}))

vi.mock('./github-auth', () => ({
  getCachedToken: vi.fn(() => 'fake-token'),
  invalidateTokenCache: vi.fn(),
  resolveGitHubToken: vi.fn(async () => ({ token: 'fake-token' }))
}))

const mocks = vi.hoisted(() => ({ originUrl: '' }))

vi.mock('child_process', async () => {
  const { promisify } = await import('util')
  const execFile = vi.fn() as unknown as { [key: symbol]: unknown }
  // util.promisify reads this symbol off the function and uses it as the
  // promisified implementation, mirroring Node's built-in handling for
  // execFile which returns {stdout, stderr}.
  execFile[promisify.custom] = async () => ({ stdout: mocks.originUrl, stderr: '' })
  return { execFile }
})

import { getRepoContext, fetchPRStatusesForRepo, mergePR } from './github'

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

describe('fork upstream detection', () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch')

  beforeEach(() => {
    fetchSpy.mockReset()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  // forkParentCache is module-level and persists across tests in this file,
  // so each test uses a unique owner/repo pair to avoid cache collisions.

  it('getRepoContext resolves upstream to parent when origin is a fork', async () => {
    mocks.originUrl = 'git@github.com:forker1/myrepo.git\n'
    fetchSpy.mockResolvedValueOnce(
      mockResponse(200, {
        fork: true,
        parent: { owner: { login: 'upstream1' }, name: 'myrepo' }
      })
    )
    const ctx = await getRepoContext('/some/worktree')
    expect(ctx).toEqual({
      origin: { owner: 'forker1', repo: 'myrepo' },
      upstream: { owner: 'upstream1', repo: 'myrepo' }
    })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(fetchSpy.mock.calls[0][0]).toBe('https://api.github.com/repos/forker1/myrepo')
  })

  it('getRepoContext leaves upstream === origin for a non-fork repo', async () => {
    mocks.originUrl = 'git@github.com:owner2/plainrepo.git\n'
    fetchSpy.mockResolvedValueOnce(mockResponse(200, { fork: false }))
    const ctx = await getRepoContext('/some/worktree')
    expect(ctx).toEqual({
      origin: { owner: 'owner2', repo: 'plainrepo' },
      upstream: { owner: 'owner2', repo: 'plainrepo' }
    })
  })

  it('getRepoContext caches the lookup across calls', async () => {
    mocks.originUrl = 'git@github.com:forker3/cached.git\n'
    fetchSpy.mockResolvedValueOnce(
      mockResponse(200, {
        fork: true,
        parent: { owner: { login: 'upstream3' }, name: 'cached' }
      })
    )
    const first = await getRepoContext('/some/worktree')
    const second = await getRepoContext('/some/worktree')
    expect(first?.upstream).toEqual({ owner: 'upstream3', repo: 'cached' })
    expect(second?.upstream).toEqual({ owner: 'upstream3', repo: 'cached' })
    // Only the first call should hit the API; the second is served from cache.
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('getRepoContext falls back to origin when fork detection fails (no caching)', async () => {
    mocks.originUrl = 'git@github.com:forker4/fail.git\n'
    fetchSpy.mockResolvedValueOnce(mockResponse(500, { message: 'oops' }))
    const first = await getRepoContext('/some/worktree')
    expect(first).toEqual({
      origin: { owner: 'forker4', repo: 'fail' },
      upstream: { owner: 'forker4', repo: 'fail' }
    })
    // Next call should retry — error path must not cache.
    fetchSpy.mockResolvedValueOnce(
      mockResponse(200, {
        fork: true,
        parent: { owner: { login: 'upstream4' }, name: 'fail' }
      })
    )
    const second = await getRepoContext('/some/worktree')
    expect(second?.upstream).toEqual({ owner: 'upstream4', repo: 'fail' })
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('fetchPRStatusesForRepo targets upstream owner/name when origin is a fork', async () => {
    fetchSpy.mockResolvedValueOnce(
      mockResponse(200, { data: { repository: { defaultBranchRef: { name: 'main' }, pr0: { nodes: [] } } } })
    )
    const result = await fetchPRStatusesForRepo(
      {
        origin: { owner: 'forker5', repo: 'proj' },
        upstream: { owner: 'upstream5', repo: 'proj' }
      },
      [{ worktreePath: '/wt', branch: 'feature', headSha: 'sha' }]
    )
    expect(result.get('/wt')).toBeNull()
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.github.com/graphql')
    const body = JSON.parse(init.body as string)
    expect(body.variables).toMatchObject({ owner: 'upstream5', name: 'proj', branch0: 'feature' })
  })

  it('fetchPRStatusesForRepo targets origin when not a fork', async () => {
    fetchSpy.mockResolvedValueOnce(
      mockResponse(200, { data: { repository: { defaultBranchRef: { name: 'main' }, pr0: { nodes: [] } } } })
    )
    await fetchPRStatusesForRepo(
      {
        origin: { owner: 'owner6', repo: 'plain' },
        upstream: { owner: 'owner6', repo: 'plain' }
      },
      [{ worktreePath: '/wt', branch: 'feature', headSha: 'sha' }]
    )
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string)
    expect(body.variables).toMatchObject({ owner: 'owner6', name: 'plain' })
  })
})

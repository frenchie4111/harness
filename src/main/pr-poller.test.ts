import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./debug', () => ({
  log: () => {}
}))
vi.mock('./worktree', () => ({
  listWorktrees: vi.fn(),
  getBranchSha: vi.fn()
}))
vi.mock('./github', () => ({
  getRepoContext: vi.fn(),
  listPullRequests: vi.fn(),
  loadPRStatusForItem: vi.fn()
}))

import { pickPRForWorktree, PRPoller } from './pr-poller'
import { Store } from './store'
import { initialState, type AppState } from '../shared/state'
import type { PRStatus } from '../shared/state/prs'
import { getRepoContext, listPullRequests, loadPRStatusForItem, type PRListItem } from './github'
import { listWorktrees, getBranchSha } from './worktree'

function pr(overrides: Partial<PRListItem> = {}): PRListItem {
  return {
    number: 1,
    title: '',
    state: 'open',
    draft: false,
    mergedAt: null,
    url: '',
    headRef: 'feature/foo',
    headSha: 'aaa',
    headRepoFullName: 'owner/repo',
    baseRef: 'main',
    baseRepoFullName: 'owner/repo',
    author: { login: 'alice', avatarUrl: '' },
    updatedAt: '2025-01-01T00:00:00Z',
    ...overrides
  }
}

describe('pickPRForWorktree', () => {
  it('matches a same-repo PR by head ref', () => {
    const wt = { path: '/wt', branch: 'feature/foo', head: 'somelocalsha' }
    const prs = [pr({ number: 7, headRef: 'feature/foo', headSha: 'remotesha' })]
    expect(pickPRForWorktree(wt, prs, 'owner/repo')?.number).toBe(7)
  })

  it('prefers a SHA match over a ref-only match', () => {
    const wt = { path: '/wt', branch: 'feature/foo', head: 'sha-of-fork-pr' }
    const prs = [
      pr({ number: 1, headRef: 'feature/foo', headSha: 'other-sha', headRepoFullName: 'owner/repo' }),
      pr({ number: 2, headRef: 'feature/foo', headSha: 'sha-of-fork-pr', headRepoFullName: 'forker/repo' })
    ]
    expect(pickPRForWorktree(wt, prs, 'owner/repo')?.number).toBe(2)
  })

  it('matches a fork PR via SHA when the ref alone would be ambiguous', () => {
    const wt = { path: '/wt', branch: 'feature/foo', head: 'fork-sha' }
    const prs = [
      pr({ number: 9, headRef: 'feature/foo', headSha: 'fork-sha', headRepoFullName: 'fork1/repo' })
    ]
    expect(pickPRForWorktree(wt, prs, 'owner/repo')?.number).toBe(9)
  })

  it('refuses to ref-match across repos (fork same-named branch, no SHA match)', () => {
    // Worktree's branch matches a fork PR's headRef, but SHA has diverged
    // (user committed locally) and the fork repo differs. We refuse to
    // claim it via ref-only since that would be wrong for the fork case.
    const wt = { path: '/wt', branch: 'feature/foo', head: 'diverged-sha' }
    const prs = [
      pr({ number: 5, headRef: 'feature/foo', headSha: 'orig-sha', headRepoFullName: 'fork1/repo' })
    ]
    expect(pickPRForWorktree(wt, prs, 'owner/repo')).toBeNull()
  })

  it('returns null when nothing matches', () => {
    const wt = { path: '/wt', branch: 'other', head: 'x' }
    expect(pickPRForWorktree(wt, [pr()], 'owner/repo')).toBeNull()
  })

  it('returns null on empty list', () => {
    const wt = { path: '/wt', branch: 'feature/foo', head: 'aaa' }
    expect(pickPRForWorktree(wt, [], 'owner/repo')).toBeNull()
  })
})

function fakePRStatus(number: number): PRStatus {
  return {
    number,
    title: `PR ${number}`,
    state: 'open',
    url: '',
    branch: '',
    author: null,
    checks: [],
    checksOverall: 'none',
    hasConflict: null,
    reviews: [],
    reviewDecision: 'none',
    baseBranch: 'main',
    isDefaultBase: true,
    assignees: []
  }
}

function wt(path: string, branch: string, head: string) {
  return {
    path,
    branch,
    head,
    isBare: false,
    isMain: false,
    createdAt: 0,
    repoRoot: '/repo'
  }
}

function prListItem(overrides: Partial<PRListItem>): PRListItem {
  return {
    number: 0,
    title: '',
    state: 'open',
    draft: false,
    mergedAt: null,
    url: '',
    headRef: '',
    headSha: '',
    headRepoFullName: 'o/r',
    baseRef: 'main',
    baseRepoFullName: 'o/r',
    author: null,
    updatedAt: '',
    ...overrides
  }
}

function makePoller(initialByPath: Record<string, PRStatus | null>): {
  store: Store
  poller: PRPoller
} {
  const state: AppState = {
    ...initialState,
    prs: { ...initialState.prs, byPath: initialByPath }
  }
  const store = new Store(state)
  const poller = new PRPoller(store, {
    getRepoRoots: () => ['/repo'],
    getLocallyMerged: () => ({}),
    setLocallyMerged: () => {}
  })
  return { store, poller }
}

describe('PRPoller.refreshAll — offline / failure preservation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getRepoContext).mockResolvedValue({
      origin: { owner: 'o', repo: 'r' },
      upstream: { owner: 'o', repo: 'r' }
    })
    vi.mocked(getBranchSha).mockResolvedValue(null)
  })

  it('preserves cached byPath when the repo PR list fetch throws (wifi blip)', async () => {
    const { store, poller } = makePoller({
      '/wt/a': fakePRStatus(1),
      '/wt/b': fakePRStatus(2)
    })
    vi.mocked(listWorktrees).mockResolvedValue([
      wt('/wt/a', 'a', 'sha-a'),
      wt('/wt/b', 'b', 'sha-b')
    ])
    vi.mocked(listPullRequests).mockRejectedValue(new Error('ENOTFOUND api.github.com'))

    await poller.refreshAll()

    const byPath = store.getSnapshot().state.prs.byPath
    expect(byPath['/wt/a']).toEqual(fakePRStatus(1))
    expect(byPath['/wt/b']).toEqual(fakePRStatus(2))
  })

  it('overlays successful per-worktree fetches and preserves the failed ones', async () => {
    const { store, poller } = makePoller({
      '/wt/a': fakePRStatus(1),
      '/wt/b': fakePRStatus(2)
    })
    vi.mocked(listWorktrees).mockResolvedValue([
      wt('/wt/a', 'a', 'sha-a'),
      wt('/wt/b', 'b', 'sha-b')
    ])
    vi.mocked(listPullRequests).mockResolvedValue([
      prListItem({ number: 10, headRef: 'a', headSha: 'sha-a' }),
      prListItem({ number: 11, headRef: 'b', headSha: 'sha-b' })
    ])
    vi.mocked(loadPRStatusForItem).mockImplementation(async (_path, item) => {
      if (item.number === 10) return fakePRStatus(10)
      throw new Error('detail fetch failed')
    })

    await poller.refreshAll()

    const byPath = store.getSnapshot().state.prs.byPath
    expect(byPath['/wt/a']).toEqual(fakePRStatus(10))
    expect(byPath['/wt/b']).toEqual(fakePRStatus(2))
  })

  it('writes authoritative null when fetch succeeds but no PR matches', async () => {
    const { store, poller } = makePoller({
      '/wt/a': fakePRStatus(1)
    })
    vi.mocked(listWorktrees).mockResolvedValue([wt('/wt/a', 'a', 'sha-a')])
    vi.mocked(listPullRequests).mockResolvedValue([])

    await poller.refreshAll()

    const byPath = store.getSnapshot().state.prs.byPath
    expect('/wt/a' in byPath).toBe(true)
    expect(byPath['/wt/a']).toBeNull()
  })

  it('drops stale paths whose worktrees no longer exist, even when fetch fails', async () => {
    const { store, poller } = makePoller({
      '/wt/a': fakePRStatus(1),
      '/wt/gone': fakePRStatus(99)
    })
    vi.mocked(listWorktrees).mockResolvedValue([wt('/wt/a', 'a', 'sha-a')])
    vi.mocked(listPullRequests).mockRejectedValue(new Error('offline'))

    await poller.refreshAll()

    const byPath = store.getSnapshot().state.prs.byPath
    expect(byPath['/wt/a']).toEqual(fakePRStatus(1))
    expect('/wt/gone' in byPath).toBe(false)
  })
})

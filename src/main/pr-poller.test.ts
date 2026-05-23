import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./debug', () => ({
  log: () => {},
  formatErr: (err: unknown) => (err instanceof Error ? err.message : String(err))
}))
vi.mock('./worktree', () => ({
  listWorktrees: vi.fn(),
  getBranchSha: vi.fn()
}))
vi.mock('./github', () => ({
  getRepoContext: vi.fn(),
  fetchPRStatusesForRepo: vi.fn()
}))

import { PRPoller } from './pr-poller'
import { Store } from './store'
import { initialState, type AppState } from '../shared/state'
import type { PRStatus } from '../shared/state/prs'
import { getRepoContext, fetchPRStatusesForRepo } from './github'
import { listWorktrees, getBranchSha } from './worktree'

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
    assignees: [],
    linkedIssues: [],
    labels: []
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

  it('preserves cached byPath when the batched fetch throws (wifi blip)', async () => {
    const { store, poller } = makePoller({
      '/wt/a': fakePRStatus(1),
      '/wt/b': fakePRStatus(2)
    })
    vi.mocked(listWorktrees).mockResolvedValue([
      wt('/wt/a', 'a', 'sha-a'),
      wt('/wt/b', 'b', 'sha-b')
    ])
    vi.mocked(fetchPRStatusesForRepo).mockRejectedValue(new Error('ENOTFOUND api.github.com'))

    await poller.refreshAll()

    const byPath = store.getSnapshot().state.prs.byPath
    expect(byPath['/wt/a']).toEqual(fakePRStatus(1))
    expect(byPath['/wt/b']).toEqual(fakePRStatus(2))
  })

  it('overlays each worktree from the batched result', async () => {
    const { store, poller } = makePoller({
      '/wt/a': fakePRStatus(1),
      '/wt/b': fakePRStatus(2)
    })
    vi.mocked(listWorktrees).mockResolvedValue([
      wt('/wt/a', 'a', 'sha-a'),
      wt('/wt/b', 'b', 'sha-b')
    ])
    vi.mocked(fetchPRStatusesForRepo).mockResolvedValue(
      new Map<string, PRStatus | null>([
        ['/wt/a', fakePRStatus(10)],
        ['/wt/b', fakePRStatus(11)]
      ])
    )

    await poller.refreshAll()

    const byPath = store.getSnapshot().state.prs.byPath
    expect(byPath['/wt/a']).toEqual(fakePRStatus(10))
    expect(byPath['/wt/b']).toEqual(fakePRStatus(11))
  })

  it('writes null when batched fetch finds no PR for a branch', async () => {
    const { store, poller } = makePoller({
      '/wt/a': fakePRStatus(1)
    })
    vi.mocked(listWorktrees).mockResolvedValue([wt('/wt/a', 'a', 'sha-a')])
    vi.mocked(fetchPRStatusesForRepo).mockResolvedValue(
      new Map<string, PRStatus | null>([['/wt/a', null]])
    )

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
    vi.mocked(fetchPRStatusesForRepo).mockRejectedValue(new Error('offline'))

    await poller.refreshAll()

    const byPath = store.getSnapshot().state.prs.byPath
    expect(byPath['/wt/a']).toEqual(fakePRStatus(1))
    expect('/wt/gone' in byPath).toBe(false)
  })
})

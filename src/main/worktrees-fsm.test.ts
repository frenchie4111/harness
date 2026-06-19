import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./worktree', () => ({
  addWorktree: vi.fn(),
  defaultWorktreeDir: vi.fn(),
  fetchPullRequestRef: vi.fn(),
  listWorktrees: vi.fn(),
  localBranchExists: vi.fn(),
  runWorktreeScript: vi.fn(),
  symlinkClaudeSettings: vi.fn()
}))
vi.mock('./github', () => ({ getPRMetadata: vi.fn() }))
vi.mock('./repo-config', () => ({ loadRepoConfig: vi.fn(() => ({})) }))
vi.mock('./debug', () => ({ log: vi.fn() }))

import { sanitizeHeadBranchForLocal, WorktreesFSM } from './worktrees-fsm'
import { listWorktrees as listWorktreesMock } from './worktree'
import { Store } from './store'
import type { Worktree } from '../shared/state/worktrees'
import type { WorktreeTicketLink } from '../shared/tickets'

const fakeWt = (path: string, branch: string, repoRoot: string): Worktree => ({
  path,
  branch,
  head: 'deadbeef',
  isBare: false,
  isMain: false,
  createdAt: 0,
  repoRoot
})

describe('sanitizeHeadBranchForLocal', () => {
  it('returns the head ref unchanged for typical names', () => {
    expect(sanitizeHeadBranchForLocal('fix-the-thing')).toBe('fix-the-thing')
    expect(sanitizeHeadBranchForLocal('release_2024.10-rc1')).toBe('release_2024.10-rc1')
  })

  it('preserves slashes — git accepts them and worktree nesting matches fresh-start', () => {
    expect(sanitizeHeadBranchForLocal('feature/foo')).toBe('feature/foo')
    expect(sanitizeHeadBranchForLocal('users/alice/wip')).toBe('users/alice/wip')
  })

  it('strips control chars and other ref-name-illegal punctuation', () => {
    expect(sanitizeHeadBranchForLocal('wip:@{v1.0}')).toBe('wipv1.0}')
    expect(sanitizeHeadBranchForLocal('a~b^c?d')).toBe('abcd')
  })

  it('collapses `..` sequences and trims leading/trailing dashes and dots', () => {
    expect(sanitizeHeadBranchForLocal('feature..foo')).toBe('feature.foo')
    expect(sanitizeHeadBranchForLocal('---weird---')).toBe('---weird---'.replace(/^[-.]+|[-.]+$/g, ''))
    expect(sanitizeHeadBranchForLocal('.leading')).toBe('leading')
  })
})

describe('WorktreesFSM.refreshList', () => {
  beforeEach(() => {
    vi.mocked(listWorktreesMock).mockReset()
  })

  it('merges linkedTicket from the side-table onto matching worktrees', async () => {
    const wt1 = fakeWt('/repo/wt-1', 'a', '/repo')
    const wt2 = fakeWt('/repo/wt-2', 'b', '/repo')
    vi.mocked(listWorktreesMock).mockResolvedValue([wt1, wt2])

    const link: WorktreeTicketLink = { providerId: 'p', externalId: '42' }
    const store = new Store()
    const fsm = new WorktreesFSM(store, {
      getRepoRoots: () => ['/repo'],
      getWorktreeSetupCmd: () => '',
      getWorktreeBaseMode: () => 'local',
      getWorktreeTicketLinks: () => ({ '/repo/wt-1': link }),
      onWorktreeCreated: () => {}
    })

    const result = await fsm.refreshList()
    expect(result).toHaveLength(2)
    expect(result[0].linkedTicket).toEqual(link)
    expect(result[1].linkedTicket).toBeUndefined()

    const dispatched = store.getSnapshot().state.worktrees.list
    expect(dispatched[0].linkedTicket).toEqual(link)
    expect(dispatched[1].linkedTicket).toBeUndefined()
  })

  it('passes the live worktree path set to pruneWorktreeTicketLinks', async () => {
    const wt = fakeWt('/repo/alive', 'a', '/repo')
    vi.mocked(listWorktreesMock).mockResolvedValue([wt])

    const pruneSpy = vi.fn()
    const fsm = new WorktreesFSM(new Store(), {
      getRepoRoots: () => ['/repo'],
      getWorktreeSetupCmd: () => '',
      getWorktreeBaseMode: () => 'local',
      pruneWorktreeTicketLinks: pruneSpy,
      onWorktreeCreated: () => {}
    })

    await fsm.refreshList()
    expect(pruneSpy).toHaveBeenCalledOnce()
    const livePaths = pruneSpy.mock.calls[0][0] as Set<string>
    expect(livePaths.has('/repo/alive')).toBe(true)
    expect(livePaths.size).toBe(1)
  })

  it('returns the git-derived list unchanged when no side-table getter is wired', async () => {
    const wt = fakeWt('/repo/x', 'x', '/repo')
    vi.mocked(listWorktreesMock).mockResolvedValue([wt])

    const fsm = new WorktreesFSM(new Store(), {
      getRepoRoots: () => ['/repo'],
      getWorktreeSetupCmd: () => '',
      getWorktreeBaseMode: () => 'local',
      onWorktreeCreated: () => {}
    })

    const result = await fsm.refreshList()
    expect(result).toEqual([wt])
    expect(result[0]).toBe(wt)
  })
})

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('./debug', () => ({ log: () => {} }))

vi.mock('./worktree', () => ({
  listWorktrees: vi.fn(async () => []),
  addWorktree: vi.fn(),
  defaultWorktreeDir: vi.fn(),
  fetchPullRequestRef: vi.fn(),
  localBranchExists: vi.fn(async () => false),
  runWorktreeScript: vi.fn(),
  symlinkClaudeSettings: vi.fn()
}))
vi.mock('./github', () => ({
  getPRMetadata: vi.fn()
}))
vi.mock('./repo-config', () => ({
  loadRepoConfig: vi.fn(() => ({}))
}))

import { Store } from './store'
import { sanitizeHeadBranchForLocal, WorktreesFSM } from './worktrees-fsm'
import { listWorktrees, addWorktree, runWorktreeScript } from './worktree'

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

describe('WorktreesFSM.refreshListDebounced', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    ;(listWorktrees as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([])
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('coalesces 30 back-to-back calls into one refresh', () => {
    const fsm = new WorktreesFSM(new Store(), {
      getRepoRoots: () => ['/repo'],
      getWorktreeSetupCmd: () => '',
      getWorktreeBaseMode: () => 'remote',
      onWorktreeCreated: () => {}
    })

    for (let i = 0; i < 30; i++) fsm.refreshListDebounced()
    // Nothing should have fired yet — debounce is trailing.
    expect(listWorktrees).not.toHaveBeenCalled()

    vi.advanceTimersByTime(250)

    expect(listWorktrees).toHaveBeenCalledTimes(1)
  })

  it('a later call resets the timer instead of firing separately', () => {
    const fsm = new WorktreesFSM(new Store(), {
      getRepoRoots: () => ['/repo'],
      getWorktreeSetupCmd: () => '',
      getWorktreeBaseMode: () => 'remote',
      onWorktreeCreated: () => {}
    })

    fsm.refreshListDebounced()
    vi.advanceTimersByTime(200) // still under the 250ms threshold
    fsm.refreshListDebounced()
    vi.advanceTimersByTime(200) // 400ms after the first call, only 200 after the last
    expect(listWorktrees).not.toHaveBeenCalled()

    vi.advanceTimersByTime(60)
    expect(listWorktrees).toHaveBeenCalledTimes(1)
  })
})

describe('WorktreesFSM.runPending', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(listWorktrees as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([])
  })

  it('publishes createdPath before running the setup script', async () => {
    // The generic pane sweep skips mid-creation worktrees by matching this
    // field. `git worktree add` has already made the path visible to
    // `git worktree list`, so publishing it late loses the race and the
    // first agent tab gets initialized without its kickoff prompt or
    // forked session id.
    ;(addWorktree as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      path: '/repo/wt/new',
      branch: 'new'
    })
    const seenAtSetup: (string | undefined)[] = []
    ;(runWorktreeScript as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      seenAtSetup.push(store.getSnapshot().state.worktrees.pending[0]?.createdPath)
      return { ok: true, exitCode: 0 }
    })

    const store = new Store()
    const fsm = new WorktreesFSM(store, {
      getRepoRoots: () => ['/repo'],
      getWorktreeSetupCmd: () => 'echo hi',
      getWorktreeBaseMode: () => 'remote',
      onWorktreeCreated: () => {}
    })

    await fsm.runPending({ id: 'pending:1', repoRoot: '/repo', branchName: 'new' })

    expect(seenAtSetup).toEqual(['/repo/wt/new'])
  })
})

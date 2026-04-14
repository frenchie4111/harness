import { describe, it, expect } from 'vitest'
import {
  initialWorktrees,
  worktreesReducer,
  type PendingWorktree,
  type Worktree,
  type WorktreesEvent,
  type WorktreesState
} from './worktrees'

function apply(state: WorktreesState, event: WorktreesEvent): WorktreesState {
  return worktreesReducer(state, event)
}

function stubWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    path: '/tmp/wt/a',
    branch: 'feature/a',
    head: 'deadbeef',
    isBare: false,
    isMain: false,
    createdAt: 0,
    repoRoot: '/tmp/repo',
    ...overrides
  }
}

function stubPending(overrides: Partial<PendingWorktree> = {}): PendingWorktree {
  return {
    id: 'pending:abc',
    repoRoot: '/tmp/repo',
    branchName: 'feature/a',
    status: 'creating',
    ...overrides
  }
}

describe('worktreesReducer', () => {
  it('listChanged replaces the flat list', () => {
    const start: WorktreesState = {
      ...initialWorktrees,
      list: [stubWorktree({ path: '/a' }), stubWorktree({ path: '/b' })]
    }
    const next = apply(start, {
      type: 'worktrees/listChanged',
      payload: [stubWorktree({ path: '/c' })]
    })
    expect(next.list.map((w) => w.path)).toEqual(['/c'])
  })

  it('reposChanged replaces the repoRoots array', () => {
    const next = apply(initialWorktrees, {
      type: 'worktrees/reposChanged',
      payload: ['/tmp/repo1', '/tmp/repo2']
    })
    expect(next.repoRoots).toEqual(['/tmp/repo1', '/tmp/repo2'])
  })

  it('pendingAdded appends to the pending list', () => {
    const a = stubPending({ id: 'pending:a' })
    const b = stubPending({ id: 'pending:b' })
    const s1 = apply(initialWorktrees, { type: 'worktrees/pendingAdded', payload: a })
    const s2 = apply(s1, { type: 'worktrees/pendingAdded', payload: b })
    expect(s2.pending.map((p) => p.id)).toEqual(['pending:a', 'pending:b'])
  })

  it('pendingUpdated merges a partial patch into the matching entry', () => {
    const start: WorktreesState = {
      ...initialWorktrees,
      pending: [
        stubPending({ id: 'pending:a', status: 'creating' }),
        stubPending({ id: 'pending:b', status: 'creating' })
      ]
    }
    const next = apply(start, {
      type: 'worktrees/pendingUpdated',
      payload: { id: 'pending:a', patch: { status: 'setup', setupLog: 'hello' } }
    })
    const a = next.pending.find((p) => p.id === 'pending:a')
    const b = next.pending.find((p) => p.id === 'pending:b')
    expect(a?.status).toBe('setup')
    expect(a?.setupLog).toBe('hello')
    expect(a?.branchName).toBe('feature/a')
    expect(b?.status).toBe('creating')
  })

  it('pendingUpdated on an unknown id is a no-op', () => {
    const start: WorktreesState = {
      ...initialWorktrees,
      pending: [stubPending({ id: 'pending:a' })]
    }
    const next = apply(start, {
      type: 'worktrees/pendingUpdated',
      payload: { id: 'pending:missing', patch: { status: 'error', error: 'nope' } }
    })
    expect(next.pending).toHaveLength(1)
    expect(next.pending[0].status).toBe('creating')
  })

  it('pendingRemoved drops the matching entry', () => {
    const start: WorktreesState = {
      ...initialWorktrees,
      pending: [
        stubPending({ id: 'pending:a' }),
        stubPending({ id: 'pending:b' })
      ]
    }
    const next = apply(start, { type: 'worktrees/pendingRemoved', payload: 'pending:a' })
    expect(next.pending.map((p) => p.id)).toEqual(['pending:b'])
  })

  it('leaves unrelated slices untouched on each event', () => {
    const start: WorktreesState = {
      list: [stubWorktree()],
      repoRoots: ['/tmp/repo'],
      pending: [stubPending()]
    }
    const next = apply(start, { type: 'worktrees/reposChanged', payload: ['/tmp/other'] })
    expect(next.list).toBe(start.list)
    expect(next.pending).toBe(start.pending)
  })
})

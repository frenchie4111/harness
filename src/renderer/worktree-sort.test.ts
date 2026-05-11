import { describe, it, expect } from 'vitest'
import { getGroupKey, GROUP_ORDER } from './worktree-sort'
import type { Worktree, PRStatus } from './types'

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

function stubPRStatus(overrides: Partial<PRStatus> = {}): PRStatus {
  return {
    number: 1,
    title: 'PR',
    state: 'open',
    url: 'https://github.com/o/r/pull/1',
    branch: 'pr-1',
    author: null,
    checks: [],
    checksOverall: 'success',
    hasConflict: false,
    reviews: [],
    reviewDecision: 'none',
    ...overrides
  }
}

describe('getGroupKey', () => {
  it('routes by PR state', () => {
    const wt = stubWorktree()
    expect(getGroupKey(wt, stubPRStatus({ checksOverall: 'failure' }))).toBe('needs-attention')
    expect(getGroupKey(wt, stubPRStatus({ hasConflict: true }))).toBe('needs-attention')
    expect(getGroupKey(wt, stubPRStatus({ reviewDecision: 'changes_requested' }))).toBe('needs-attention')
    expect(getGroupKey(wt, stubPRStatus())).toBe('active')
    expect(getGroupKey(wt, stubPRStatus({ state: 'merged' }))).toBe('merged')
    expect(getGroupKey(wt, stubPRStatus({ state: 'closed' }))).toBe('merged')
  })

  it('falls back to no-pr when there is no PR status', () => {
    expect(getGroupKey(stubWorktree(), null)).toBe('no-pr')
    expect(getGroupKey(stubWorktree(), undefined)).toBe('no-pr')
  })

  it('locallyMerged trumps everything', () => {
    expect(getGroupKey(stubWorktree(), stubPRStatus(), true)).toBe('merged')
    expect(getGroupKey(stubWorktree(), null, true)).toBe('merged')
  })
})

describe('GROUP_ORDER', () => {
  it('places reviewing between needs-attention and active', () => {
    expect(GROUP_ORDER).toEqual(['needs-attention', 'reviewing', 'active', 'no-pr', 'merged'])
  })
})

describe('Reviewing grouping by PR author', () => {
  it('routes a PR you did not author into reviewing', () => {
    const pr = stubPRStatus({ author: { login: 'someone-else', avatarUrl: '' } })
    expect(getGroupKey(stubWorktree(), pr, false, 'me')).toBe('reviewing')
  })

  it('keeps your own PR in active', () => {
    const pr = stubPRStatus({ author: { login: 'me', avatarUrl: '' } })
    expect(getGroupKey(stubWorktree(), pr, false, 'me')).toBe('active')
  })

  it('falls back when viewerLogin is unknown — treats it as your own PR', () => {
    const pr = stubPRStatus({ author: { login: 'someone-else', avatarUrl: '' } })
    expect(getGroupKey(stubWorktree(), pr, false, null)).toBe('active')
    expect(getGroupKey(stubWorktree(), pr, false)).toBe('active')
  })

  it('falls back when the PR has no author', () => {
    const pr = stubPRStatus({ author: null })
    expect(getGroupKey(stubWorktree(), pr, false, 'me')).toBe('active')
  })

  it('does NOT mark merged review PRs as reviewing — they move to merged', () => {
    const pr = stubPRStatus({
      state: 'merged',
      author: { login: 'someone-else', avatarUrl: '' }
    })
    expect(getGroupKey(stubWorktree(), pr, false, 'me')).toBe('merged')
  })

  it('takes precedence over needs-attention signals (those are your problem to fix, not theirs)', () => {
    const pr = stubPRStatus({
      checksOverall: 'failure',
      author: { login: 'someone-else', avatarUrl: '' }
    })
    expect(getGroupKey(stubWorktree(), pr, false, 'me')).toBe('reviewing')
  })
})

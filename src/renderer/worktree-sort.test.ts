import { describe, it, expect } from 'vitest'
import { getGroupKey, groupWorktrees, GROUP_ORDER } from './worktree-sort'
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
    checks: [],
    checksOverall: 'success',
    hasConflict: false,
    reviews: [],
    reviewDecision: 'none',
    ...overrides
  }
}

describe('getGroupKey', () => {
  it('classifies a PR-review worktree as reviewing while its PR is open', () => {
    const wt = stubWorktree({
      path: '/tmp/wt/pr-29',
      prReview: { number: 29, owner: 'o', repo: 'r', headSha: 'abc' }
    })
    const pr = stubPRStatus({ number: 29, checksOverall: 'failure' })
    // Even with failing checks, a PR-review worktree stays in `reviewing`
    // — we're not the one responsible for fixing it.
    expect(getGroupKey(wt, pr)).toBe('reviewing')
  })

  it('moves a PR-review worktree to merged once the PR is merged', () => {
    const wt = stubWorktree({
      path: '/tmp/wt/pr-29',
      prReview: { number: 29, owner: 'o', repo: 'r', headSha: 'abc' }
    })
    const pr = stubPRStatus({ state: 'merged' })
    expect(getGroupKey(wt, pr)).toBe('merged')
  })

  it('keeps a PR-review worktree in reviewing if status hasn’t loaded yet', () => {
    const wt = stubWorktree({
      prReview: { number: 7, owner: 'o', repo: 'r', headSha: 'abc' }
    })
    expect(getGroupKey(wt, null)).toBe('reviewing')
  })

  it('still classifies your-own worktrees by PR state', () => {
    const wt = stubWorktree()
    expect(getGroupKey(wt, stubPRStatus({ checksOverall: 'failure' }))).toBe('needs-attention')
    expect(getGroupKey(wt, stubPRStatus())).toBe('active')
    expect(getGroupKey(wt, null)).toBe('no-pr')
  })

  it('locallyMerged trumps prReview', () => {
    const wt = stubWorktree({
      prReview: { number: 1, owner: 'o', repo: 'r', headSha: 'x' }
    })
    expect(getGroupKey(wt, stubPRStatus(), true)).toBe('merged')
  })
})

describe('GROUP_ORDER', () => {
  it('places reviewing between needs-attention and active', () => {
    expect(GROUP_ORDER).toEqual(['needs-attention', 'reviewing', 'active', 'no-pr', 'merged'])
  })
})

describe('groupWorktrees', () => {
  it('buckets reviewing worktrees into their own group', () => {
    const own = stubWorktree({ path: '/own' })
    const review = stubWorktree({
      path: '/review',
      prReview: { number: 42, owner: 'o', repo: 'r', headSha: 'x' }
    })
    const groups = groupWorktrees(
      [own, review],
      {
        '/own': stubPRStatus(),
        '/review': stubPRStatus({ number: 42 })
      }
    )
    const reviewing = groups.find((g) => g.key === 'reviewing')
    expect(reviewing?.worktrees.map((w) => w.path)).toEqual(['/review'])
    const active = groups.find((g) => g.key === 'active')
    expect(active?.worktrees.map((w) => w.path)).toEqual(['/own'])
  })
})

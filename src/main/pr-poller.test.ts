import { describe, it, expect } from 'vitest'
import { pickPRForWorktree } from './pr-poller'
import type { PRListItem } from './github'

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

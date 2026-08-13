import { describe, it, expect } from 'vitest'

import { deriveWorktreeStatus } from './worktree-status'
import { initialState, type AppState } from '../shared/state'
import type { PRStatus } from '../shared/state/prs'
import type { Worktree } from '../shared/state/worktrees'

const PATH = '/wt/a'

function worktree(): Worktree {
  return {
    path: PATH,
    branch: 'feat/auth',
    head: 'abc',
    isBare: false,
    isMain: false,
    createdAt: 0,
    repoRoot: '/repo'
  }
}

function pr(overrides: Partial<PRStatus> = {}): PRStatus {
  return {
    number: 42,
    title: 'Add auth',
    state: 'open',
    url: 'https://example.test/42',
    branch: 'feat/auth',
    author: { login: 'me', avatarUrl: '' },
    checks: [],
    checksOverall: 'success',
    hasConflict: false,
    reviews: [],
    reviewDecision: 'none',
    baseBranch: 'main',
    isDefaultBase: true,
    assignees: [],
    linkedIssues: [],
    labels: [],
    ...overrides
  }
}

function makeState(opts: {
  pr?: PRStatus
  merged?: boolean
  snoozed?: boolean
  alias?: string
  viewerLogin?: string | null
} = {}): AppState {
  return {
    ...initialState,
    settings: { ...initialState.settings, viewerLogin: opts.viewerLogin ?? 'me' },
    prs: {
      ...initialState.prs,
      byPath: opts.pr ? { [PATH]: opts.pr } : {},
      mergedByPath: opts.merged ? { [PATH]: true } : {}
    },
    snooze: {
      byPath: opts.snoozed ? { [PATH]: { path: PATH, snoozedAt: 0, wakeAt: 1 } } : {}
    },
    aliases: { byPath: opts.alias ? { [PATH]: opts.alias } : {} }
  }
}

describe('deriveWorktreeStatus', () => {
  it('reports a branch with no PR as the sidebar does', () => {
    expect(deriveWorktreeStatus(makeState(), worktree())).toEqual({
      status: 'no-pr',
      statusLabel: 'Active'
    })
  })

  it('summarises the PR without leaking the whole status object', () => {
    const result = deriveWorktreeStatus(makeState({ pr: pr() }), worktree())
    expect(result.status).toBe('active')
    expect(result.statusLabel).toBe('Open PRs')
    expect(result.pr).toEqual({
      number: 42,
      state: 'open',
      title: 'Add auth',
      checks: 'success',
      reviewDecision: 'none',
      hasConflict: false
    })
  })

  it('flags a failing PR as needing attention', () => {
    const state = makeState({ pr: pr({ checksOverall: 'failure' }) })
    expect(deriveWorktreeStatus(state, worktree())).toMatchObject({
      status: 'needs-attention',
      statusLabel: 'Needs Attention'
    })
  })

  // The distinction the raw git listing can't make: merged work is done, and
  // an agent asking "is this worktree still going?" needs to see that.
  it('reports merged work as merged', () => {
    const state = makeState({ pr: pr({ state: 'merged' }) })
    expect(deriveWorktreeStatus(state, worktree())).toMatchObject({
      status: 'merged',
      statusLabel: 'Merged / Closed'
    })
  })

  it('reports a locally-merged worktree with no PR as merged', () => {
    expect(deriveWorktreeStatus(makeState({ merged: true }), worktree())).toMatchObject({
      status: 'merged'
    })
  })

  it('reports a snoozed worktree as snoozed', () => {
    expect(deriveWorktreeStatus(makeState({ snoozed: true }), worktree())).toMatchObject({
      status: 'snoozed',
      statusLabel: 'Snoozed'
    })
  })

  it("treats someone else's PR as a review", () => {
    const state = makeState({
      pr: pr({ author: { login: 'someone-else', avatarUrl: '' } })
    })
    expect(deriveWorktreeStatus(state, worktree())).toMatchObject({
      status: 'reviewing'
    })
  })

  it('includes the alias only when one is set', () => {
    expect(deriveWorktreeStatus(makeState(), worktree()).alias).toBeUndefined()
    expect(
      deriveWorktreeStatus(makeState({ alias: 'Auth Refactor' }), worktree()).alias
    ).toBe('Auth Refactor')
  })
})

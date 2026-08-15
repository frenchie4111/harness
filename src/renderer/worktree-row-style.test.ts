import { describe, it, expect } from 'vitest'
import type { PRStatus } from './types'
import {
  prIconStyle,
  prIconTitle,
  detachedLikeTooltip,
  STATUS_COLORS,
  STATUS_LABELS
} from './worktree-row-style'

function pr(overrides: Partial<PRStatus> = {}): PRStatus {
  return {
    number: 42,
    title: 'Some PR',
    state: 'open',
    url: 'https://example.com/pr/42',
    branch: 'feature',
    author: { login: 'someone', avatarUrl: '' },
    checks: [],
    checksOverall: 'none',
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

describe('prIconStyle', () => {
  it('returns an empty style when there is no PR', () => {
    expect(prIconStyle(null)).toEqual({ iconColor: '', titleSuffix: '' })
    expect(prIconStyle(undefined)).toEqual({ iconColor: '', titleSuffix: '' })
  })

  // Priority rung 1: merged/closed state beats every other signal.
  it('renders merged state as accent even when checks failed', () => {
    expect(prIconStyle(pr({ state: 'merged', checksOverall: 'failure' })).iconColor).toBe('text-accent')
  })

  it('renders closed state as danger even when checks passed', () => {
    expect(prIconStyle(pr({ state: 'closed', checksOverall: 'success' })).iconColor).toBe('text-danger')
  })

  it('renders merged state as accent even when there is a conflict', () => {
    expect(prIconStyle(pr({ state: 'merged', hasConflict: true })).iconColor).toBe('text-accent')
  })

  // Priority rung 2: merge conflict beats check status.
  it('renders a conflicting open PR as danger with a title suffix, over green checks', () => {
    expect(prIconStyle(pr({ hasConflict: true, checksOverall: 'success' }))).toEqual({
      iconColor: 'text-danger',
      titleSuffix: ' — merge conflict'
    })
  })

  it('does not treat a null (still-computing) conflict flag as a conflict', () => {
    expect(prIconStyle(pr({ hasConflict: null, checksOverall: 'success' })).iconColor).toBe('text-success')
  })

  // Priority rung 3: check status.
  it.each([
    ['failure', 'text-danger'],
    ['pending', 'text-warning'],
    ['success', 'text-success']
  ] as const)('maps checksOverall=%s to %s', (checksOverall, expected) => {
    expect(prIconStyle(pr({ checksOverall })).iconColor).toBe(expected)
  })

  // Priority rung 4: fall back to PR state when there are no checks.
  it('falls back to the open state color when there are no checks', () => {
    expect(prIconStyle(pr({ checksOverall: 'none' })).iconColor).toBe('text-success')
  })

  it('falls back to the draft state color when there are no checks', () => {
    expect(prIconStyle(pr({ state: 'draft', checksOverall: 'none' })).iconColor).toBe('text-dim')
  })
})

describe('prIconTitle', () => {
  it('includes just the number when there is nothing else to report', () => {
    expect(prIconTitle(pr())).toBe('PR #42')
  })

  it('appends the check status when checks ran', () => {
    expect(prIconTitle(pr({ checksOverall: 'pending' }))).toBe('PR #42 — checks pending')
  })

  it('appends the merge-conflict suffix', () => {
    expect(prIconTitle(pr({ hasConflict: true }))).toBe('PR #42 — merge conflict')
  })

  it('appends the review decision', () => {
    expect(prIconTitle(pr({ reviewDecision: 'approved' }))).toBe('PR #42 — approved')
    expect(prIconTitle(pr({ reviewDecision: 'changes_requested' }))).toBe('PR #42 — changes requested')
  })

  it('composes checks, conflict, and review decision in order', () => {
    expect(
      prIconTitle(pr({ checksOverall: 'failure', hasConflict: true, reviewDecision: 'changes_requested' }))
    ).toBe('PR #42 — checks failure — merge conflict — changes requested')
  })

  it('omits the review clause for review_required', () => {
    expect(prIconTitle(pr({ reviewDecision: 'review_required' }))).toBe('PR #42')
  })
})

describe('detachedLikeTooltip', () => {
  it('returns null for a normal branch', () => {
    expect(detachedLikeTooltip('main')).toBeNull()
    expect(detachedLikeTooltip('feature/rebasing-helper')).toBeNull()
  })

  it('labels a detached HEAD', () => {
    expect(detachedLikeTooltip('(detached)')).toBe('Detached HEAD')
  })

  it.each(['rebasing', 'bisecting', 'cherry-picking'])('labels a bare %s branch', (branch) => {
    expect(detachedLikeTooltip(branch)).toBe(`In progress: ${branch}`)
  })

  it('labels prefixed in-progress branches', () => {
    expect(detachedLikeTooltip('rebasing main')).toBe('In progress: rebasing main')
    expect(detachedLikeTooltip('cherry-picking(abc123)')).toBe('In progress: cherry-picking(abc123)')
  })
})

describe('status vocabulary', () => {
  it('covers every pty status plus the merged pseudo-status', () => {
    const keys = ['idle', 'processing', 'waiting', 'needs-approval', 'merged']
    expect(Object.keys(STATUS_COLORS).sort()).toEqual([...keys].sort())
    expect(Object.keys(STATUS_LABELS).sort()).toEqual([...keys].sort())
  })
})

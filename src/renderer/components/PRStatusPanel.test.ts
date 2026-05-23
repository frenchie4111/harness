import { describe, it, expect } from 'vitest'
import { milestoneDisplay } from './PRStatusPanel'
import type { PRStatus } from '../types'

function pr(overrides: Partial<PRStatus> = {}): PRStatus {
  return {
    number: 1,
    title: '',
    state: 'open',
    url: '',
    branch: 'feature',
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
    labels: [],
    ...overrides
  }
}

describe('milestoneDisplay', () => {
  it('hides the slot entirely when the repo has no milestones', () => {
    expect(milestoneDisplay(pr({ hasMilestones: false }))).toBe('hidden')
    expect(
      milestoneDisplay(
        pr({
          hasMilestones: false,
          milestone: { title: 'v1.0', url: '', state: 'open' }
        })
      )
    ).toBe('hidden')
  })

  it('renders the pill when the PR has a milestone and the repo uses milestones', () => {
    expect(
      milestoneDisplay(
        pr({
          hasMilestones: true,
          milestone: { title: 'v1.0', url: '', state: 'open' }
        })
      )
    ).toBe('pill')
  })

  it('renders the placeholder when the repo uses milestones but this PR has none', () => {
    expect(milestoneDisplay(pr({ hasMilestones: true }))).toBe('placeholder')
  })

  it('keeps showing the slot when hasMilestones is unknown (older cached state)', () => {
    // Pre-feature cached state has no hasMilestones field — fall through
    // to the placeholder rather than hiding it.
    expect(milestoneDisplay(pr({ hasMilestones: undefined }))).toBe('placeholder')
    expect(
      milestoneDisplay(
        pr({
          hasMilestones: undefined,
          milestone: { title: 'v1.0', url: '', state: 'open' }
        })
      )
    ).toBe('pill')
  })
})

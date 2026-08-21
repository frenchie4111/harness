import { describe, it, expect } from 'vitest'

import { buildMergeConflictMessage } from './merge-conflict-request'
import type { PRStatus } from '../shared/state/prs'
import { parseAutomatedMessage } from '../shared/state/json-claude'

function pr(overrides: Partial<PRStatus> = {}): PRStatus {
  return {
    number: 7,
    title: 'Add a thing',
    state: 'open',
    url: 'https://github.com/o/r/pull/7',
    branch: 'feat/thing',
    headSha: 'abc123',
    author: null,
    checks: [],
    checksOverall: 'none',
    hasConflict: true,
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

describe('buildMergeConflictMessage', () => {
  it('round-trips through the automation sentinel so the chat renders a card', () => {
    const parsed = parseAutomatedMessage(buildMergeConflictMessage(pr()))
    expect(parsed?.source).toBe('merge-conflict')
  })

  it('names the PR, its branch, and the base it conflicts with', () => {
    const body = parseAutomatedMessage(
      buildMergeConflictMessage(pr({ number: 42, branch: 'fix/login', baseBranch: 'develop' }))
    )?.body
    expect(body).toContain('#42')
    expect(body).toContain('fix/login')
    expect(body).toContain('develop')
    expect(body).toContain('https://github.com/o/r/pull/7')
  })
})

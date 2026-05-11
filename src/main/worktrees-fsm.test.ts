import { describe, it, expect } from 'vitest'
import { sanitizeHeadBranchForLocal } from './worktrees-fsm'

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

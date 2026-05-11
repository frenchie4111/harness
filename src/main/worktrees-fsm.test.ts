import { describe, it, expect } from 'vitest'
import { safePRBranchName } from './worktrees-fsm'

describe('safePRBranchName', () => {
  it('appends a sanitized head branch to pr-<N>', () => {
    expect(safePRBranchName(29, 'fix-the-thing')).toBe('pr-29-fix-the-thing')
  })

  it('collapses slashes to dashes so the path stays single-level', () => {
    expect(safePRBranchName(7, 'feature/foo/bar')).toBe('pr-7-feature-foo-bar')
  })

  it('replaces unsafe punctuation', () => {
    expect(safePRBranchName(42, 'wip:@v1.0')).toBe('pr-42-wip-v1.0')
  })

  it('collapses runs of dashes', () => {
    expect(safePRBranchName(3, '---weird---name---')).toBe('pr-3-weird-name')
  })

  it('falls back to bare pr-<N> if the sanitized branch is empty', () => {
    expect(safePRBranchName(11, '///')).toBe('pr-11')
    expect(safePRBranchName(11, '')).toBe('pr-11')
  })

  it('keeps allowed chars (dot, underscore, dash, alphanumerics)', () => {
    expect(safePRBranchName(5, 'release_2024.10-rc1')).toBe('pr-5-release_2024.10-rc1')
  })
})

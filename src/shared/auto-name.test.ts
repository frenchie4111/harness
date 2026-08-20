import { describe, expect, it } from 'vitest'
import {
  AUTO_BRANCH_FALLBACK,
  slugifyPromptToBranch,
  withAutoNameInstruction
} from './auto-name'
import { isValidBranchName } from './branch-name'
import { parseAutomatedMessage } from './state/json-claude'

describe('slugifyPromptToBranch', () => {
  it('kebab-cases the ask and drops filler words', () => {
    expect(slugifyPromptToBranch('Can you add a dark mode toggle to Settings')).toBe(
      'add-dark-mode-toggle-settings'
    )
  })

  it('only reads the first line', () => {
    expect(
      slugifyPromptToBranch('Fix the login redirect\n\nContext: it 404s on Safari only')
    ).toBe('fix-login-redirect')
  })

  it('caps at five words', () => {
    expect(
      slugifyPromptToBranch('rewrite parser handle nested quotes escapes newlines properly')
    ).toBe('rewrite-parser-handle-nested-quotes')
  })

  it('caps length at a word boundary', () => {
    const slug = slugifyPromptToBranch(
      'investigate authentication middleware performance regression'
    )
    expect(slug.length).toBeLessThanOrEqual(40)
    expect(slug).toBe('investigate-authentication-middleware')
  })

  it('strips urls and punctuation', () => {
    expect(slugifyPromptToBranch('Review https://github.com/foo/bar/pull/1 — checks!')).toBe(
      'review-checks'
    )
  })

  it('falls back to the raw words when the prompt is all filler', () => {
    expect(slugifyPromptToBranch('can you do it')).toBe('can-you-do-it')
  })

  it('falls back to a constant when nothing survives slugging', () => {
    expect(slugifyPromptToBranch('🎉🎉🎉')).toBe(AUTO_BRANCH_FALLBACK)
    expect(slugifyPromptToBranch('')).toBe(AUTO_BRANCH_FALLBACK)
  })

  it('always produces a valid branch name', () => {
    for (const prompt of [
      '...leading dots',
      '-dashes-',
      'a',
      'HEAD~3 please',
      'refs/heads/foo',
      '     ',
      '🎉'
    ]) {
      expect(isValidBranchName(slugifyPromptToBranch(prompt))).toBe(true)
    }
  })
})

describe('withAutoNameInstruction', () => {
  it('carries the rename instruction to the model but keeps it out of the body', () => {
    const wire = withAutoNameInstruction('Add a dark mode toggle')
    expect(wire).toContain('rename_worktree')
    // The chat card renders the parsed body, so what the user typed is all
    // they see of their own turn.
    expect(parseAutomatedMessage(wire)).toEqual({
      source: 'worktree-autoname',
      body: 'Add a dark mode toggle'
    })
  })
})

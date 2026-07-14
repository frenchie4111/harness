import { describe, expect, it } from 'vitest'
import {
  assembleCreateWorktreeInput,
  hasPrNumber,
  readCreateWorktreeForm
} from './create-worktree-approval'

describe('readCreateWorktreeForm', () => {
  it('reads string fields and coerces missing ones to empty', () => {
    const form = readCreateWorktreeForm({
      initialPrompt: 'hello',
      branchName: 'feat/x',
      agentKind: 'claude',
      model: 'sonnet-4-6',
      baseBranch: 'main'
    })
    expect(form).toEqual({
      initialPrompt: 'hello',
      branchName: 'feat/x',
      agentKind: 'claude',
      model: 'sonnet-4-6',
      baseBranch: 'main'
    })
  })

  it('discards an unknown agentKind value', () => {
    const form = readCreateWorktreeForm({ agentKind: 'gemini' })
    expect(form.agentKind).toBe('')
  })

  it('defaults missing string fields to empty strings', () => {
    const form = readCreateWorktreeForm({})
    expect(form).toEqual({
      initialPrompt: '',
      branchName: '',
      agentKind: '',
      model: '',
      baseBranch: ''
    })
  })
})

describe('hasPrNumber', () => {
  it('treats a positive integer as PR mode', () => {
    expect(hasPrNumber({ prNumber: 42 })).toBe(true)
  })
  it('rejects zero, negative, or non-number values', () => {
    expect(hasPrNumber({ prNumber: 0 })).toBe(false)
    expect(hasPrNumber({ prNumber: -1 })).toBe(false)
    expect(hasPrNumber({ prNumber: '42' })).toBe(false)
    expect(hasPrNumber({})).toBe(false)
  })
})

describe('assembleCreateWorktreeInput', () => {
  it('writes back trimmed fields and drops empty optional ones', () => {
    const out = assembleCreateWorktreeInput(
      { branchName: 'old', repoRoot: '/repo' },
      {
        initialPrompt: 'do the thing',
        branchName: '  feat/y  ',
        agentKind: 'codex',
        model: '  opus  ',
        baseBranch: ''
      }
    )
    expect(out).toEqual({
      initialPrompt: 'do the thing',
      branchName: 'feat/y',
      agentKind: 'codex',
      model: 'opus',
      repoRoot: '/repo'
    })
    expect(out).not.toHaveProperty('baseBranch')
  })

  it('drops branch fields when the original carries a prNumber', () => {
    const out = assembleCreateWorktreeInput(
      { prNumber: 17, branchName: 'whatever', baseBranch: 'main' },
      {
        initialPrompt: 'review the PR',
        branchName: 'ignored',
        agentKind: '',
        model: '',
        baseBranch: 'also-ignored'
      }
    )
    expect(out).toEqual({ prNumber: 17, initialPrompt: 'review the PR' })
  })

  it('preserves unknown fields from the original input', () => {
    const out = assembleCreateWorktreeInput(
      { branchName: 'b', someFutureField: 'keep-me', nested: { a: 1 } },
      {
        initialPrompt: '',
        branchName: 'b',
        agentKind: '',
        model: '',
        baseBranch: ''
      }
    )
    expect(out.someFutureField).toBe('keep-me')
    expect(out.nested).toEqual({ a: 1 })
  })

  it('writes an empty initialPrompt explicitly (suppress kickoff on PR path)', () => {
    const out = assembleCreateWorktreeInput(
      { prNumber: 5 },
      {
        initialPrompt: '',
        branchName: '',
        agentKind: '',
        model: '',
        baseBranch: ''
      }
    )
    expect(out).toHaveProperty('initialPrompt', '')
  })

  it('drops branchName when the edited field is whitespace-only', () => {
    const out = assembleCreateWorktreeInput(
      { branchName: 'old' },
      {
        initialPrompt: 'x',
        branchName: '   ',
        agentKind: '',
        model: '',
        baseBranch: ''
      }
    )
    expect(out).not.toHaveProperty('branchName')
  })
})

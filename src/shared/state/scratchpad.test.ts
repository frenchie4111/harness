import { describe, it, expect } from 'vitest'
import { initialScratchpad, scratchpadReducer, type ScratchpadState } from './scratchpad'

describe('scratchpadReducer', () => {
  it('loaded replaces the whole map', () => {
    const start: ScratchpadState = { byWorktreePath: { '/old': 'old text' } }
    const next = scratchpadReducer(start, {
      type: 'scratchpad/loaded',
      payload: { '/a': 'note a', '/b': 'note b' }
    })
    expect(Object.keys(next.byWorktreePath).sort()).toEqual(['/a', '/b'])
    expect(next.byWorktreePath['/a']).toBe('note a')
  })

  it('textChanged sets a value', () => {
    const next = scratchpadReducer(initialScratchpad, {
      type: 'scratchpad/textChanged',
      payload: { worktreePath: '/a', text: 'hello' }
    })
    expect(next.byWorktreePath).toEqual({ '/a': 'hello' })
  })

  it('textChanged with empty string deletes the entry', () => {
    const start: ScratchpadState = { byWorktreePath: { '/a': 'hello', '/b': 'world' } }
    const next = scratchpadReducer(start, {
      type: 'scratchpad/textChanged',
      payload: { worktreePath: '/a', text: '' }
    })
    expect(next.byWorktreePath).toEqual({ '/b': 'world' })
  })

  it('textChanged with empty string on missing key is a no-op (same reference)', () => {
    const start: ScratchpadState = { byWorktreePath: { '/a': 'hello' } }
    const next = scratchpadReducer(start, {
      type: 'scratchpad/textChanged',
      payload: { worktreePath: '/missing', text: '' }
    })
    expect(next).toBe(start)
  })

  it('textChanged with identical text is a no-op (same reference)', () => {
    const start: ScratchpadState = { byWorktreePath: { '/a': 'hello' } }
    const next = scratchpadReducer(start, {
      type: 'scratchpad/textChanged',
      payload: { worktreePath: '/a', text: 'hello' }
    })
    expect(next).toBe(start)
  })

  it('worktreeRemoved drops the matching entry', () => {
    const start: ScratchpadState = { byWorktreePath: { '/a': 'hello', '/b': 'world' } }
    const next = scratchpadReducer(start, {
      type: 'scratchpad/worktreeRemoved',
      payload: '/a'
    })
    expect(next.byWorktreePath).toEqual({ '/b': 'world' })
  })

  it('worktreeRemoved on a missing key is a no-op (same reference)', () => {
    const start: ScratchpadState = { byWorktreePath: { '/a': 'hello' } }
    const next = scratchpadReducer(start, {
      type: 'scratchpad/worktreeRemoved',
      payload: '/missing'
    })
    expect(next).toBe(start)
  })
})

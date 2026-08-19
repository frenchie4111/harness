import { describe, it, expect } from 'vitest'
import {
  contextWindowReducer,
  initialContextWindow,
  emptyCategories,
  cloneCategories,
  totalCategories,
  type ContextSnapshot
} from './context-window'

function snapshot(overrides: Partial<ContextSnapshot> = {}): ContextSnapshot {
  return {
    sessionId: 'sess-1',
    transcriptPath: '/tmp/sess-1.jsonl',
    model: 'claude-opus-5',
    limit: 200_000,
    usedTokens: 50_000,
    categories: cloneCategories(emptyCategories),
    autocompactAt: 168_000,
    compactions: 0,
    discoverableTools: [],
    measured: true,
    updatedAt: 1,
    ...overrides
  }
}

describe('contextWindowReducer', () => {
  it('contextWindow/snapshotUpdated inserts a snapshot for a terminal', () => {
    const snap = snapshot()
    const next = contextWindowReducer(initialContextWindow, {
      type: 'contextWindow/snapshotUpdated',
      payload: { terminalId: 'term-a', snapshot: snap }
    })
    expect(next.byTerminal['term-a']).toBe(snap)
  })

  it('contextWindow/snapshotUpdated replaces an existing snapshot', () => {
    const first = contextWindowReducer(initialContextWindow, {
      type: 'contextWindow/snapshotUpdated',
      payload: { terminalId: 'term-a', snapshot: snapshot({ usedTokens: 10 }) }
    })
    const second = contextWindowReducer(first, {
      type: 'contextWindow/snapshotUpdated',
      payload: { terminalId: 'term-a', snapshot: snapshot({ usedTokens: 20 }) }
    })
    expect(second.byTerminal['term-a'].usedTokens).toBe(20)
    expect(Object.keys(second.byTerminal)).toEqual(['term-a'])
  })

  it('contextWindow/snapshotUpdated keeps other terminals untouched', () => {
    const withA = contextWindowReducer(initialContextWindow, {
      type: 'contextWindow/snapshotUpdated',
      payload: { terminalId: 'term-a', snapshot: snapshot() }
    })
    const a = withA.byTerminal['term-a']
    const withB = contextWindowReducer(withA, {
      type: 'contextWindow/snapshotUpdated',
      payload: { terminalId: 'term-b', snapshot: snapshot({ sessionId: 'sess-2' }) }
    })
    expect(withB.byTerminal['term-a']).toBe(a)
  })

  it('contextWindow/terminalCleared removes the entry', () => {
    const withA = contextWindowReducer(initialContextWindow, {
      type: 'contextWindow/snapshotUpdated',
      payload: { terminalId: 'term-a', snapshot: snapshot() }
    })
    const cleared = contextWindowReducer(withA, {
      type: 'contextWindow/terminalCleared',
      payload: { terminalId: 'term-a' }
    })
    expect(cleared.byTerminal['term-a']).toBeUndefined()
  })

  it('contextWindow/terminalCleared returns the same state when absent', () => {
    const cleared = contextWindowReducer(initialContextWindow, {
      type: 'contextWindow/terminalCleared',
      payload: { terminalId: 'nope' }
    })
    expect(cleared).toBe(initialContextWindow)
  })
})

describe('totalCategories', () => {
  it('sums every bucket including per-tool results', () => {
    const total = totalCategories({
      systemAndTools: 14_000,
      memoryFiles: 3_000,
      carriedSummary: 1_000,
      attachments: 500,
      userPrompts: 2_000,
      assistantText: 4_000,
      thinking: 1_500,
      toolCalls: 800,
      toolResults: { Read: 20_000, Bash: 5_000 }
    })
    expect(total).toBe(51_800)
  })

  it('is zero for empty categories', () => {
    expect(totalCategories(emptyCategories)).toBe(0)
  })
})

describe('cloneCategories', () => {
  it('deep-copies toolResults so mutation does not leak', () => {
    const src = { ...emptyCategories, toolResults: { Read: 1 } }
    const copy = cloneCategories(src)
    copy.toolResults.Read = 999
    expect(src.toolResults.Read).toBe(1)
  })
})

import { describe, it, expect } from 'vitest'
import {
  initialCosts,
  costsReducer,
  totalForSession,
  type CostsState,
  type SessionUsage
} from './costs'

function stubUsage(overrides: Partial<SessionUsage> = {}): SessionUsage {
  return {
    sessionId: 'sess-1',
    transcriptPath: '/tmp/sess-1.jsonl',
    currentModel: 'claude-opus-4-6',
    updatedAt: 1000,
    byModel: {
      'claude-opus-4-6': {
        messages: 3,
        input: 10,
        output: 20,
        cacheRead: 100,
        cacheWrite: 50,
        cost: 1.23
      }
    },
    breakdown: {
      text: 0.1,
      thinking: 0.05,
      toolUse: 0.2,
      userPrompt: 0.1,
      assistantEcho: 0.3,
      toolResults: { Bash: 0.4, Read: 0.08 }
    },
    ...overrides
  }
}

describe('costsReducer', () => {
  it('usageUpdated sets a single terminal', () => {
    const u = stubUsage()
    const next = costsReducer(initialCosts, {
      type: 'costs/usageUpdated',
      payload: { terminalId: 't1', usage: u }
    })
    expect(next.byTerminal).toEqual({ t1: u })
  })

  it('usageUpdated merges into existing map without disturbing other terminals', () => {
    const start: CostsState = {
      byTerminal: {
        t1: stubUsage({ sessionId: 's1' }),
        t2: stubUsage({ sessionId: 's2' })
      }
    }
    const updated = stubUsage({ sessionId: 's1-updated' })
    const next = costsReducer(start, {
      type: 'costs/usageUpdated',
      payload: { terminalId: 't1', usage: updated }
    })
    expect(next.byTerminal.t1.sessionId).toBe('s1-updated')
    expect(next.byTerminal.t2.sessionId).toBe('s2')
  })

  it('terminalCleared removes a terminal', () => {
    const start: CostsState = {
      byTerminal: { t1: stubUsage(), t2: stubUsage() }
    }
    const next = costsReducer(start, {
      type: 'costs/terminalCleared',
      payload: { terminalId: 't1' }
    })
    expect(Object.keys(next.byTerminal)).toEqual(['t2'])
  })

  it('terminalCleared on unknown terminal is a no-op', () => {
    const start: CostsState = { byTerminal: { t1: stubUsage() } }
    const next = costsReducer(start, {
      type: 'costs/terminalCleared',
      payload: { terminalId: 'nope' }
    })
    expect(next).toBe(start)
  })

  it('hydrated replaces the whole slice', () => {
    const start: CostsState = { byTerminal: { t1: stubUsage() } }
    const replacement: CostsState = {
      byTerminal: { t9: stubUsage({ sessionId: 's9' }) }
    }
    const next = costsReducer(start, {
      type: 'costs/hydrated',
      payload: replacement
    })
    expect(next).toEqual(replacement)
  })

  it('returns a new reference on mutation', () => {
    const next = costsReducer(initialCosts, {
      type: 'costs/usageUpdated',
      payload: { terminalId: 't1', usage: stubUsage() }
    })
    expect(next).not.toBe(initialCosts)
  })
})

describe('totalForSession', () => {
  it('sums a single-model session to its only tally', () => {
    const u = stubUsage()
    const total = totalForSession(u)
    expect(total.cost).toBe(1.23)
    expect(total.messages).toBe(3)
  })

  it('sums multiple models', () => {
    const u = stubUsage({
      byModel: {
        'claude-opus-4-6': {
          messages: 2, input: 5, output: 10, cacheRead: 0, cacheWrite: 0, cost: 1.0
        },
        'claude-sonnet-4-6': {
          messages: 4, input: 20, output: 30, cacheRead: 0, cacheWrite: 0, cost: 0.5
        }
      }
    })
    const total = totalForSession(u)
    expect(total.messages).toBe(6)
    expect(total.input).toBe(25)
    expect(total.output).toBe(40)
    expect(total.cost).toBeCloseTo(1.5)
  })
})

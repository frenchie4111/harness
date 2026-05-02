import { describe, it, expect } from 'vitest'
import {
  initialSnooze,
  snoozeReducer,
  MAX_WAKE,
  type SnoozeEntry
} from './snooze'

const entry = (path: string, wakeAt = 1000): SnoozeEntry => ({
  path,
  snoozedAt: 100,
  wakeAt
})

describe('snoozeReducer', () => {
  it('snooze/set adds an entry', () => {
    const next = snoozeReducer(initialSnooze, {
      type: 'snooze/set',
      payload: entry('/a')
    })
    expect(next.byPath['/a']).toEqual(entry('/a'))
  })

  it('snooze/set replaces an existing entry for the same path', () => {
    const s1 = snoozeReducer(initialSnooze, {
      type: 'snooze/set',
      payload: entry('/a', 1000)
    })
    const s2 = snoozeReducer(s1, {
      type: 'snooze/set',
      payload: entry('/a', 2000)
    })
    expect(s2.byPath['/a'].wakeAt).toBe(2000)
    expect(Object.keys(s2.byPath)).toEqual(['/a'])
  })

  it('snooze/set accepts MAX_WAKE for "Never"', () => {
    const next = snoozeReducer(initialSnooze, {
      type: 'snooze/set',
      payload: entry('/a', MAX_WAKE)
    })
    expect(next.byPath['/a'].wakeAt).toBe(MAX_WAKE)
  })

  it('snooze/clear removes an entry', () => {
    const s1 = snoozeReducer(initialSnooze, {
      type: 'snooze/set',
      payload: entry('/a')
    })
    const s2 = snoozeReducer(s1, { type: 'snooze/clear', payload: '/a' })
    expect(s2.byPath['/a']).toBeUndefined()
  })

  it('snooze/clear is a no-op for an unknown path (same reference)', () => {
    const cleared = snoozeReducer(initialSnooze, {
      type: 'snooze/clear',
      payload: '/missing'
    })
    expect(cleared).toBe(initialSnooze)
  })

  it('snooze/clear preserves other entries', () => {
    let state = snoozeReducer(initialSnooze, {
      type: 'snooze/set',
      payload: entry('/a')
    })
    state = snoozeReducer(state, {
      type: 'snooze/set',
      payload: entry('/b')
    })
    state = snoozeReducer(state, { type: 'snooze/clear', payload: '/a' })
    expect(state.byPath['/a']).toBeUndefined()
    expect(state.byPath['/b']).toEqual(entry('/b'))
  })

  it('does not mutate the input state', () => {
    const next = snoozeReducer(initialSnooze, {
      type: 'snooze/set',
      payload: entry('/a')
    })
    expect(next).not.toBe(initialSnooze)
    expect(initialSnooze.byPath).toEqual({})
  })
})

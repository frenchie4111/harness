import { describe, it, expect } from 'vitest'
import { initialCiNotify, ciNotifyReducer, isCiNotifyEnabled } from './ci-notify'

describe('ciNotifyReducer', () => {
  it('ciNotify/set adds an override', () => {
    const next = ciNotifyReducer(initialCiNotify, {
      type: 'ciNotify/set',
      payload: { path: '/a', enabled: true }
    })
    expect(next.byPath['/a']).toBe(true)
  })

  it('ciNotify/set can store an explicit false', () => {
    const next = ciNotifyReducer(initialCiNotify, {
      type: 'ciNotify/set',
      payload: { path: '/a', enabled: false }
    })
    expect(next.byPath['/a']).toBe(false)
    expect('/a' in next.byPath).toBe(true)
  })

  it('ciNotify/set replaces an existing override for the same path', () => {
    const s1 = ciNotifyReducer(initialCiNotify, {
      type: 'ciNotify/set',
      payload: { path: '/a', enabled: true }
    })
    const s2 = ciNotifyReducer(s1, {
      type: 'ciNotify/set',
      payload: { path: '/a', enabled: false }
    })
    expect(s2.byPath['/a']).toBe(false)
    expect(Object.keys(s2.byPath)).toEqual(['/a'])
  })

  it('ciNotify/set is a no-op when the value is unchanged (same reference)', () => {
    const s1 = ciNotifyReducer(initialCiNotify, {
      type: 'ciNotify/set',
      payload: { path: '/a', enabled: true }
    })
    const s2 = ciNotifyReducer(s1, {
      type: 'ciNotify/set',
      payload: { path: '/a', enabled: true }
    })
    expect(s2).toBe(s1)
  })

  it('ciNotify/clear removes an override', () => {
    const s1 = ciNotifyReducer(initialCiNotify, {
      type: 'ciNotify/set',
      payload: { path: '/a', enabled: false }
    })
    const s2 = ciNotifyReducer(s1, { type: 'ciNotify/clear', payload: '/a' })
    expect('/a' in s2.byPath).toBe(false)
  })

  it('ciNotify/clear is a no-op for an unknown path (same reference)', () => {
    const cleared = ciNotifyReducer(initialCiNotify, {
      type: 'ciNotify/clear',
      payload: '/missing'
    })
    expect(cleared).toBe(initialCiNotify)
  })

  it('ciNotify/clear preserves other entries', () => {
    let state = ciNotifyReducer(initialCiNotify, {
      type: 'ciNotify/set',
      payload: { path: '/a', enabled: true }
    })
    state = ciNotifyReducer(state, {
      type: 'ciNotify/set',
      payload: { path: '/b', enabled: false }
    })
    state = ciNotifyReducer(state, { type: 'ciNotify/clear', payload: '/a' })
    expect('/a' in state.byPath).toBe(false)
    expect(state.byPath['/b']).toBe(false)
  })

  it('does not mutate the input state', () => {
    const next = ciNotifyReducer(initialCiNotify, {
      type: 'ciNotify/set',
      payload: { path: '/a', enabled: true }
    })
    expect(next).not.toBe(initialCiNotify)
    expect(initialCiNotify.byPath).toEqual({})
  })
})

describe('isCiNotifyEnabled', () => {
  it('falls back to the global default with no override', () => {
    expect(isCiNotifyEnabled(initialCiNotify, '/a', true)).toBe(true)
    expect(isCiNotifyEnabled(initialCiNotify, '/a', false)).toBe(false)
  })

  it('an explicit true override beats a false global default', () => {
    const state = ciNotifyReducer(initialCiNotify, {
      type: 'ciNotify/set',
      payload: { path: '/a', enabled: true }
    })
    expect(isCiNotifyEnabled(state, '/a', false)).toBe(true)
  })

  it('an explicit false override beats a true global default', () => {
    const state = ciNotifyReducer(initialCiNotify, {
      type: 'ciNotify/set',
      payload: { path: '/a', enabled: false }
    })
    expect(isCiNotifyEnabled(state, '/a', true)).toBe(false)
  })

  it('an override on one path does not affect another', () => {
    const state = ciNotifyReducer(initialCiNotify, {
      type: 'ciNotify/set',
      payload: { path: '/a', enabled: false }
    })
    expect(isCiNotifyEnabled(state, '/b', true)).toBe(true)
  })
})

import { describe, it, expect } from 'vitest'
import { initialAliases, aliasesReducer, normalizeAlias, ALIAS_MAX_LEN } from './aliases'

describe('normalizeAlias', () => {
  it('trims surrounding whitespace', () => {
    expect(normalizeAlias('  hi  ')).toBe('hi')
  })

  it('clamps to ALIAS_MAX_LEN', () => {
    const long = 'a'.repeat(ALIAS_MAX_LEN + 20)
    expect(normalizeAlias(long)).toBe('a'.repeat(ALIAS_MAX_LEN))
  })

  it('returns null for empty input', () => {
    expect(normalizeAlias('')).toBeNull()
  })

  it('returns null for whitespace-only input', () => {
    expect(normalizeAlias('   \t  ')).toBeNull()
  })

  it('preserves interior whitespace', () => {
    expect(normalizeAlias('  hello world  ')).toBe('hello world')
  })
})

describe('aliasesReducer', () => {
  it('aliases/set adds an entry', () => {
    const next = aliasesReducer(initialAliases, {
      type: 'aliases/set',
      payload: { path: '/a', alias: 'foo' }
    })
    expect(next.byPath['/a']).toBe('foo')
  })

  it('aliases/set replaces an existing entry for the same path', () => {
    const s1 = aliasesReducer(initialAliases, {
      type: 'aliases/set',
      payload: { path: '/a', alias: 'foo' }
    })
    const s2 = aliasesReducer(s1, {
      type: 'aliases/set',
      payload: { path: '/a', alias: 'bar' }
    })
    expect(s2.byPath['/a']).toBe('bar')
    expect(Object.keys(s2.byPath)).toEqual(['/a'])
  })

  it('aliases/set is a no-op when value is unchanged (same reference)', () => {
    const s1 = aliasesReducer(initialAliases, {
      type: 'aliases/set',
      payload: { path: '/a', alias: 'foo' }
    })
    const s2 = aliasesReducer(s1, {
      type: 'aliases/set',
      payload: { path: '/a', alias: 'foo' }
    })
    expect(s2).toBe(s1)
  })

  it('aliases/cleared removes an entry', () => {
    const s1 = aliasesReducer(initialAliases, {
      type: 'aliases/set',
      payload: { path: '/a', alias: 'foo' }
    })
    const s2 = aliasesReducer(s1, {
      type: 'aliases/cleared',
      payload: { path: '/a' }
    })
    expect(s2.byPath['/a']).toBeUndefined()
  })

  it('aliases/cleared is a no-op for an unknown path (same reference)', () => {
    const cleared = aliasesReducer(initialAliases, {
      type: 'aliases/cleared',
      payload: { path: '/missing' }
    })
    expect(cleared).toBe(initialAliases)
  })

  it('aliases/cleared preserves other entries', () => {
    let state = aliasesReducer(initialAliases, {
      type: 'aliases/set',
      payload: { path: '/a', alias: 'foo' }
    })
    state = aliasesReducer(state, {
      type: 'aliases/set',
      payload: { path: '/b', alias: 'bar' }
    })
    state = aliasesReducer(state, {
      type: 'aliases/cleared',
      payload: { path: '/a' }
    })
    expect(state.byPath['/a']).toBeUndefined()
    expect(state.byPath['/b']).toBe('bar')
  })

  it('does not mutate the input state', () => {
    const next = aliasesReducer(initialAliases, {
      type: 'aliases/set',
      payload: { path: '/a', alias: 'foo' }
    })
    expect(next).not.toBe(initialAliases)
    expect(initialAliases.byPath).toEqual({})
  })
})

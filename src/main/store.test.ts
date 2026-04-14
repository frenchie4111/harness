import { describe, it, expect, vi } from 'vitest'
import { Store } from './store'
import { initialState, type StateEvent } from '../shared/state'

describe('Store', () => {
  it('returns the initial snapshot with seq=0', () => {
    const store = new Store()
    const snap = store.getSnapshot()
    expect(snap.seq).toBe(0)
    expect(snap.state).toEqual(initialState)
  })

  it('applies dispatched events through the reducer', () => {
    const store = new Store()
    store.dispatch({ type: 'settings/themeChanged', payload: 'solarized' })
    expect(store.getSnapshot().state.settings.theme).toBe('solarized')
  })

  it('increments seq monotonically per dispatch', () => {
    const store = new Store()
    store.dispatch({ type: 'settings/themeChanged', payload: 'a' })
    expect(store.getSnapshot().seq).toBe(1)
    store.dispatch({ type: 'settings/themeChanged', payload: 'b' })
    expect(store.getSnapshot().seq).toBe(2)
    store.dispatch({ type: 'settings/nameClaudeSessionsChanged', payload: true })
    expect(store.getSnapshot().seq).toBe(3)
  })

  it('notifies subscribers on dispatch with (event, seq)', () => {
    const store = new Store()
    const spy = vi.fn()
    store.subscribe(spy)
    const event: StateEvent = { type: 'settings/themeChanged', payload: 'c' }
    store.dispatch(event)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith(event, 1)
  })

  it('fans out to multiple subscribers', () => {
    const store = new Store()
    const a = vi.fn()
    const b = vi.fn()
    store.subscribe(a)
    store.subscribe(b)
    store.dispatch({ type: 'settings/themeChanged', payload: 'd' })
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
  })

  it('unsubscribe removes the listener', () => {
    const store = new Store()
    const spy = vi.fn()
    const unsubscribe = store.subscribe(spy)
    unsubscribe()
    store.dispatch({ type: 'settings/themeChanged', payload: 'e' })
    expect(spy).not.toHaveBeenCalled()
  })

  it('does not mutate the previous snapshot object after dispatch', () => {
    const store = new Store()
    const before = store.getSnapshot().state
    store.dispatch({ type: 'settings/themeChanged', payload: 'mutated?' })
    // The old reference should still hold the old theme — proves we're
    // producing new objects through the reducer, not mutating in place.
    expect(before.settings.theme).not.toBe('mutated?')
  })

  it('accepts a custom initial state', () => {
    const store = new Store({
      ...initialState,
      settings: { ...initialState.settings, theme: 'preseeded' }
    })
    expect(store.getSnapshot().state.settings.theme).toBe('preseeded')
    expect(store.getSnapshot().seq).toBe(0)
  })
})
